// One-shot script: fetches individual ticket data for past quarters and patches
// the `tickets` array into each project entry in jira-history.json.
//
// Usage:
//   JIRA_EMAIL=you@meltwater.com JIRA_API_TOKEN=<token> node scripts/backfill-jira-history-tickets.mjs
//
// Only adds/overwrites the `tickets` field — all other fields (total, weighted,
// tritonScore, density, …) are left untouched so the historical scores stay stable.
//
// Quarters to patch are taken from the --quarters flag (comma-separated, default Q1-2026):
//   node scripts/backfill-jira-history-tickets.mjs --quarters=Q1-2026,Q4-2025
import { readFile, writeFile } from 'node:fs/promises';

const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;
if (!email || !token) {
  console.error('Set JIRA_EMAIL and JIRA_API_TOKEN before running.');
  process.exit(1);
}

const cliArgs  = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k,v] = a.slice(2).split('='); return [k, v]; }));
const QUARTERS = (cliArgs.quarters || 'Q1-2026').split(',').map(s => s.trim());

const cfg = JSON.parse(await readFile(new URL('./jira-projects.json', import.meta.url), 'utf8'));
const SITE           = cfg.site;
const PROJECT        = cfg.jiraProject;
const DEFECT_TYPE    = cfg.defectIssueType || 'Defect';
const CRITICAL       = cfg.criticalPriorities || ['Blocker', 'Critical'];
const EXCLUDE_KW     = cfg.excludeKeywords || [];
const LINK_ATTR      = cfg.linkAttribution || {};
const SEV_WEIGHTS    = Object.fromEntries(Object.entries(cfg.severityWeights || {}).filter(([, v]) => typeof v === 'number'));

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
  const jql = `project = ${q(PROJECT)} AND issuetype = ${q(DEFECT_TYPE)} AND component = ${q(component)} AND created >= ${q(from)} AND created <= ${q(to)}${excludeClause}`;
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

  for (const ql of QUARTERS) {
    const { from, to } = quarterWindow(ql);
    console.log(`\n── ${ql}  (${from} → ${to}) ──`);

    for (const [projectName, component] of Object.entries(cfg.projects)) {
      const entry = jiraHist.projects?.[projectName]?.[ql];
      if (!entry) {
        console.log(`  ${projectName}: no ${ql} entry in jira-history.json — skip`);
        continue;
      }
      if (entry.total === 0) {
        entry.tickets = [];
        console.log(`  ${projectName}: 0 escapes recorded — setting tickets: []`);
        continue;
      }
      try {
        const tickets = await fetchTicketsForQuarter(projectName, component, from, to);
        entry.tickets = tickets;
        const weighted = Math.round(tickets.reduce((s, t) => s + t.weight, 0) * 100) / 100;
        console.log(`  ${projectName}: ${tickets.length} tickets fetched (weighted ${weighted})`);
      } catch (e) {
        console.error(`  ${projectName}: ERROR — ${e.message}`);
      }
    }
  }

  await writeFile(histPath, JSON.stringify(jiraHist, null, 2) + '\n');
  console.log('\nWrote risk-baseline/jira-history.json');
}

main().catch(e => { console.error(e); process.exit(1); });
