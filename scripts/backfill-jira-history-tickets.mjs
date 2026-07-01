// Backfill script: fetches ticket data for past quarters from Jira and patches
// jira-history.json with tickets, total, weighted counts, and tritonScore.
//
// Usage:
//   JIRA_EMAIL=you@meltwater.com JIRA_API_TOKEN=<token> node scripts/backfill-jira-history-tickets.mjs
//
// Updates per fetched quarter+project: tickets, total, weighted, tritonScore.
// The density field is left untouched (requires delivery data from a separate source).
//
// Quarters to patch are taken from the --quarters flag (comma-separated, default Q1-2026):
//   node scripts/backfill-jira-history-tickets.mjs --quarters=Q1-2026,Q2-2026
import { readFile, writeFile } from 'node:fs/promises';

// ── tritonScore helpers (same formula as fetch-jira-metrics.mjs) ────────────
// Polynomial approximation of normalCDF (Abramowitz & Stegun 26.2.17).
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z / Math.SQRT2) * (z / Math.SQRT2));
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;
if (!email || !token) {
  console.error('Set JIRA_EMAIL and JIRA_API_TOKEN before running.');
  process.exit(1);
}

const cliArgs  = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k,v] = a.slice(2).split('='); return [k, v]; }));
const QUARTERS = (cliArgs.quarters || 'Q1-2026').split(',').map(s => s.trim());

const cfg = JSON.parse(await readFile(new URL('./jira-projects.json', import.meta.url), 'utf8'));

// TRITON curve params (same source as fetch-jira-metrics.mjs)
const { mu, sigma, scaleMax = 10 } = cfg.tritonCurve || { mu: 5, sigma: 4, scaleMax: 10 };
const MODEL_PARAMS = cfg.modelParams || { curveType: 'gaussian' };
const logisticCDF  = z => 1 / (1 + Math.exp(-z * 1.7));
const activeCDF    = MODEL_PARAMS.curveType === 'logistic' ? logisticCDF : normalCDF;
function tritonScore10(w) {
  return Math.round(scaleMax * activeCDF((w - mu) / sigma) * 10) / 10;
}

const SITE           = cfg.site;
const PROJECT        = cfg.jiraProject;
const DEFECT_TYPES   = cfg.defectIssueTypes || (cfg.defectIssueType ? [cfg.defectIssueType] : ['Defect']);
const CRITICAL       = cfg.criticalPriorities || ['Blocker', 'Critical'];
const EXCLUDE_KW     = cfg.excludeKeywords || [];
const LINK_ATTR      = cfg.linkAttribution || {};
const SEV_WEIGHTS    = Object.fromEntries(Object.entries(cfg.severityWeights || {}).filter(([, v]) => typeof v === 'number'));
const RISK_DEFAULTS  = cfg.riskBaselineDefaults || {};

const auth    = Buffer.from(`${email}:${token}`).toString('base64');
const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

const q    = s => `"${String(s).replace(/"/g, '\\"')}"`;
const sevW = p  => SEV_WEIGHTS[p] != null ? SEV_WEIGHTS[p] : 1;

// Quarter label "Q1-2026" → { from: "2026-01-01", to: "2026-03-31" }
function quarterWindow(label) {
  const m = label.match(/^Q(\d)-(\d{4})$/);
  if (!m) throw new Error(`Invalid quarter label: ${label}`);
  const qn = parseInt(m[1]);
  const yr = parseInt(m[2]);
  const fromMonth = (qn - 1) * 3 + 1;
  const toMonth   = qn * 3;
  const lastDay   = new Date(Date.UTC(yr, toMonth, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');
  return {
    from: `${yr}-${pad(fromMonth)}-01`,
    to:   `${yr}-${pad(toMonth)}-${lastDay}`,
  };
}

async function searchAll(jql, fields) {
  const out = [];
  let nextPageToken;
  while (true) {
    const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: '100' });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    const url  = `https://${SITE}/rest/api/3/search/jql?${params}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`Jira ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    out.push(...(data.issues || []));
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return out;
}

const ALL_PREFIXES = Object.keys(LINK_ATTR).flatMap(n => [].concat(LINK_ATTR[n] || []));
const matchPrefix  = (key, prefixes) => prefixes.some(p => key.startsWith(`${p}-`));

function linkedKeys(issue) {
  return (issue.fields?.issuelinks || []).flatMap(l => [l.inwardIssue?.key, l.outwardIssue?.key]).filter(Boolean);
}

function filterByLink(issues, prefixes) {
  if (!prefixes.length) return issues;
  return issues.filter(i => {
    const keys = linkedKeys(i);
    return keys.some(k => matchPrefix(k, prefixes)) ||
      !keys.some(k => matchPrefix(k, ALL_PREFIXES));
  });
}

async function fetchTicketsForQuarter(projectName, component, from, to) {
  const prefixes  = [].concat(LINK_ATTR[projectName] || []);
  const needLinks = prefixes.length > 0;
  const excludeClause = EXCLUDE_KW.map(k => ` AND summary !~ ${q(k)}`).join('');
  const issueTypeClause = DEFECT_TYPES.length === 1
    ? `issuetype = ${q(DEFECT_TYPES[0])}`
    : `issuetype in (${DEFECT_TYPES.map(q).join(', ')})`;
  const jql = `project = ${q(PROJECT)} AND ${issueTypeClause} AND component = ${q(component)} AND created >= ${q(from)} AND created <= ${q(to)}${excludeClause}`;
  const fields = needLinks ? ['priority', 'summary', 'issuelinks'] : ['priority', 'summary'];

  const raw      = await searchAll(jql, fields);
  const filtered = filterByLink(raw, prefixes);

  return filtered.map(i => ({
    key:      i.key,
    summary:  i.fields?.summary || '',
    priority: i.fields?.priority?.name || '—',
    weight:   sevW(i.fields?.priority?.name),
    critical: CRITICAL.includes(i.fields?.priority?.name),
    url:      `https://${SITE}/browse/${i.key}`,
  }));
}

async function main() {
  const histPath  = new URL('../risk-baseline/jira-history.json', import.meta.url);
  const jiraHist  = JSON.parse(await readFile(histPath, 'utf8'));

  // Ensure all configured projects and quarters exist in jira-history structure.
  if (!jiraHist.projects) jiraHist.projects = {};
  const allQuartersSet = new Set(jiraHist.quarters || []);
  QUARTERS.forEach(q => allQuartersSet.add(q));
  jiraHist.quarters = [...allQuartersSet].sort();

  for (const projectName of Object.keys(cfg.projects)) {
    if (!jiraHist.projects[projectName]) {
      jiraHist.projects[projectName] = {};
      console.log(`  [new] Created history entry for ${projectName}`);
    }
    for (const ql of QUARTERS) {
      if (!jiraHist.projects[projectName][ql]) {
        jiraHist.projects[projectName][ql] = { total: null, weighted: null, tritonScore: null, tickets: [] };
      }
    }
  }

  for (const ql of QUARTERS) {
    const { from, to } = quarterWindow(ql);
    console.log(`\n── ${ql}  (${from} → ${to}) ──`);

    for (const [projectName, component] of Object.entries(cfg.projects)) {
      if (!component || component.startsWith('TODO_')) {
        console.log(`  ${projectName}: TRITON component not set — skip`);
        continue;
      }
      const entry = jiraHist.projects?.[projectName]?.[ql];
      if (!entry) {
        console.log(`  ${projectName}: no ${ql} entry — skip (should not happen after init)`);
        continue;
      }
      try {
        const tickets = await fetchTicketsForQuarter(projectName, component, from, to);
        entry.tickets = tickets;
        entry.total   = tickets.length;
        const weighted = Math.round(tickets.reduce((s, t) => s + t.weight, 0) * 100) / 100;
        entry.weighted    = weighted;
        entry.tritonScore = tritonScore10(weighted);
        console.log(`  ${projectName}: ${tickets.length} tickets fetched (weighted ${weighted} → tritonScore ${entry.tritonScore})`);
      } catch (e) {
        console.error(`  ${projectName}: ERROR — ${e.message}`);
      }
    }
  }

  // Recompute calibrationStats across all non-null tritonScores.
  const allScores = Object.values(jiraHist.projects)
    .flatMap(qmap => Object.values(qmap))
    .map(e => e.tritonScore)
    .filter(s => s != null)
    .sort((a, b) => a - b);
  if (allScores.length) {
    const n = allScores.length;
    const mean   = Math.round((allScores.reduce((s, v) => s + v, 0) / n) * 10) / 10;
    const median = n % 2 === 0
      ? Math.round(((allScores[n / 2 - 1] + allScores[n / 2]) / 2) * 10) / 10
      : allScores[(n - 1) / 2];
    jiraHist.calibrationStats = { n, mean, median };
    console.log(`\nCalibration stats updated: n=${n} mean=${mean} median=${median}`);
  }

  await writeFile(histPath, JSON.stringify(jiraHist, null, 2) + '\n');
  console.log('Wrote risk-baseline/jira-history.json');
}

main().catch(e => { console.error(e); process.exit(1); });
