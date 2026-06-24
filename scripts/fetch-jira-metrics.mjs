// Fetches TRITON metrics from Jira and writes risk-baseline/jira-metrics.json.
// Run by .github/workflows/refresh-jira-metrics.yml on a schedule.
//
// Computes, per Risk Baseline project (mapped to a TRITON component in
// scripts/jira-projects.json), the two "Jira" criteria scored in risk-baseline:
//   • escapedDefects     — TRITON Defects created this calendar quarter.
//   • avgAgeOpenIssues   — avg age (days) of unresolved TRITON Defects.
//
// Auth: Jira Cloud REST API with Basic auth (email + API token). The browser
// can't call Jira directly (CORS + secrets), so — like git-metrics — CI fetches
// and commits the JSON, and the static page only reads it.
//
// Required env:
//   JIRA_EMAIL      — Atlassian account email used to mint the API token.
//   JIRA_API_TOKEN  — API token from id.atlassian.com/manage-profile/security/api-tokens
import { readFile, writeFile } from 'node:fs/promises';

const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;
if (!email || !token) {
  console.error('JIRA_EMAIL and JIRA_API_TOKEN must be set');
  process.exit(1);
}

const cfg = JSON.parse(await readFile(new URL('./jira-projects.json', import.meta.url), 'utf8'));
const SITE = cfg.site;
const PROJECT = cfg.jiraProject;
const DEFECT_TYPE = cfg.defectIssueType || 'Defect';
const CRITICAL = cfg.criticalPriorities || ['Blocker', 'Critical'];
const EXCLUDE_KEYWORDS = cfg.excludeKeywords || [];
const LINK_ATTRIBUTION = cfg.linkAttribution || {};
const TRITON_CURVE = cfg.tritonCurve || { mu: 5, sigma: 4, scaleMax: 10 };
const SEVERITY_WEIGHTS = Object.fromEntries(Object.entries(cfg.severityWeights || {}).filter(([, v]) => typeof v === 'number'));
const EXPOSURE = cfg.exposure || { enabled: false };
const MODEL_VERSION = cfg.modelVersion || 'unversioned';
const sevWeight = priority => SEVERITY_WEIGHTS[priority] != null ? SEVERITY_WEIGHTS[priority] : 1;

const auth = Buffer.from(`${email}:${token}`).toString('base64');
const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

// JQL helper: escape embedded double quotes in component names.
const q = s => `"${String(s).replace(/"/g, '\\"')}"`;

// Start of the current calendar quarter as YYYY-MM-DD. Computed in JS because
// Jira's startOfQuarter() function is not evaluated over the REST search API.
function quarterStart(d) {
  const m = Math.floor(d.getUTCMonth() / 3) * 3;
  const y = d.getUTCFullYear();
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
const QUARTER_START = quarterStart(new Date());

// Paginate the Jira Cloud JQL search endpoint, returning all matching issues.
async function searchAll(jql, fields) {
  const out = [];
  let nextPageToken;
  while (true) {
    const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: '100' });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    const url = `https://${SITE}/rest/api/3/search/jql?${params}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`Jira ${resp.status} for ${jql}: ${await resp.text()}`);
    const data = await resp.json();
    out.push(...(data.issues || []));
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return out;
}

// Standard normal CDF via the Abramowitz-Stegun erf approximation (7.1.26).
function normalCDF(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z / Math.SQRT2) * (z / Math.SQRT2));
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

// TRITON escaped-defect score on a 0–10 scale via an SLA-anchored Gaussian curve
// over a severity-weighted count. mu = weighted escapes/quarter treated as "medium".
function tritonScore10(weightedCount) {
  const { mu, sigma, scaleMax = 10 } = TRITON_CURVE;
  return Math.round(scaleMax * normalCDF((weightedCount - mu) / sigma) * 10) / 10;
}

// Service-request exclusion clause (Confluence §4.6): drop tickets whose summary
// matches any configured keyword. JQL "!~" is a fuzzy text match on summary.
const EXCLUDE_CLAUSE = EXCLUDE_KEYWORDS.map(k => ` AND summary !~ ${q(k)}`).join('');

// All issue keys linked to a ticket (both inward and outward link directions).
function linkedKeys(issue) {
  return (issue.fields?.issuelinks || [])
    .flatMap(l => [l.inwardIssue?.key, l.outwardIssue?.key])
    .filter(Boolean);
}

// Normalize a linkAttribution entry to an array of project-key prefixes.
const prefixesFor = name => [].concat(LINK_ATTRIBUTION[name] || []);
// Every prefix claimed by any shared project (used to detect "linked to the other project").
const ALL_PREFIXES = Object.keys(LINK_ATTRIBUTION).flatMap(prefixesFor);
const matchesPrefix = (key, prefixes) => prefixes.some(p => key.startsWith(`${p}-`));

// Mira and Mira Studio share the TRITON component "Mira" (§4.6). When a project
// declares linkAttribution prefixes, keep only tickets linked to that project
// (e.g. HZN-* -> Mira Studio, MIRA-*/MIRALEGACY-* -> Mira). Tickets linked to no
// recognized project are set aside as "needsManualReview" rather than silently
// attributed; tickets linked to the *other* shared project are excluded here.
function partitionByLink(issues, prefixes) {
  if (!prefixes.length) return { matched: issues, manualReview: 0 };
  const matched = [];
  let manualReview = 0;
  for (const i of issues) {
    const keys = linkedKeys(i);
    if (keys.some(k => matchesPrefix(k, prefixes))) matched.push(i);
    else if (!keys.some(k => matchesPrefix(k, ALL_PREFIXES))) manualReview++;
  }
  return { matched, manualReview };
}

// Exposure for defect-density normalization (Rec #1). Returns a count or null.
// 'releases' = released fixVersions in the quarter; 'delivered' = Done dev issues
// resolved in the quarter. Disabled unless cfg.exposure.enabled.
async function getExposure(name) {
  if (!EXPOSURE.enabled) return null;
  const conf = EXPOSURE.byProject?.[name];
  if (!conf?.devProject) return null;
  try {
    if (conf.method === 'delivered') {
      const done = await searchAll(`project = ${conf.devProject} AND statusCategory = Done AND resolved >= ${q(QUARTER_START)}`, ['key']);
      return done.length;
    }
    // default: 'releases'
    const resp = await fetch(`https://${SITE}/rest/api/3/project/${conf.devProject}/versions`, { headers, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`versions ${resp.status}`);
    const versions = await resp.json();
    return versions.filter(v => v.released && v.releaseDate && v.releaseDate >= QUARTER_START).length;
  } catch (e) {
    console.error(`Exposure for ${name} (${conf.devProject}): ${e.message}`);
    return null;
  }
}

async function computeProject(name, component) {
  const linkPrefixes = prefixesFor(name);
  const needLinks = linkPrefixes.length > 0;
  const base = `project = ${PROJECT} AND issuetype = ${q(DEFECT_TYPE)} AND component = ${q(component)}`;
  const fields = base => needLinks ? base.concat('issuelinks') : base;

  // Escaped defects this calendar quarter (service requests excluded).
  const escapedRaw = await searchAll(`${base} AND created >= ${q(QUARTER_START)}${EXCLUDE_CLAUSE}`, fields(['priority', 'summary']));
  const { matched: escaped, manualReview: escMR } = partitionByLink(escapedRaw, linkPrefixes);
  const total = escaped.length;
  const critical = escaped.filter(i => CRITICAL.includes(i.fields?.priority?.name)).length;
  // Severity-weighted count (Rec #3): each defect contributes its priority weight.
  const weighted = Math.round(escaped.reduce((s, i) => s + sevWeight(i.fields?.priority?.name), 0) * 100) / 100;
  // Per-ticket detail so the UI can show exactly which defects are counted and
  // let an engineer manually exclude one (e.g. a service request missed by the
  // keyword list).
  const tickets = escaped.map(i => ({
    key: i.key,
    summary: i.fields?.summary || '',
    priority: i.fields?.priority?.name || '—',
    weight: sevWeight(i.fields?.priority?.name),
    critical: CRITICAL.includes(i.fields?.priority?.name),
    url: `https://${SITE}/browse/${i.key}`,
  }));

  // Optional exposure normalization → defect density.
  const exposure = await getExposure(name);
  const refExp = EXPOSURE.referenceExposure || 1;
  const tritonInput = (exposure && exposure > 0) ? (weighted / exposure) * refExp : weighted;

  // Open (unresolved) defects — average age in days (informational only; removed
  // from the mitigation score in v2 to avoid double-counting with escapes, Rec #4).
  const openRaw = await searchAll(`${base} AND resolution = Unresolved${EXCLUDE_CLAUSE}`, fields(['created']));
  const { matched: open, manualReview: openMR } = partitionByLink(openRaw, linkPrefixes);
  const now = Date.now();
  const ages = open
    .map(i => i.fields?.created)
    .filter(Boolean)
    .map(c => (now - new Date(c).getTime()) / 86400000);
  const openCount = ages.length;
  const avgDays = openCount ? Math.round(ages.reduce((a, b) => a + b, 0) / openCount) : 0;

  const result = {
    escapedDefects: { score: tritonScore10(tritonInput), total, critical, weighted, tickets,
      ...(exposure != null ? { exposure } : {}) },
    avgAgeOpenIssues: { avgDays, openCount, informational: true },
    dataQuality: { manualReview: needLinks ? { escaped: escMR, open: openMR } : { escaped: 0, open: 0 } },
  };
  if (needLinks) result.needsManualReview = { escaped: escMR, open: openMR };
  return result;
}

function quarterLabel(d) {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

async function main() {
  const projects = {};
  for (const [name, component] of Object.entries(cfg.projects)) {
    try {
      projects[name] = await computeProject(name, component);
      const e = projects[name].escapedDefects;
      const mr = projects[name].needsManualReview ? ` [manual review: ${projects[name].needsManualReview.escaped} esc / ${projects[name].needsManualReview.open} open]` : '';
      const exp = e.exposure != null ? ` /exp ${e.exposure}` : '';
      console.log(`${name} (${component}): escaped=${e.total} (crit ${e.critical}) weighted=${e.weighted}${exp} → ${e.score}${mr}`);
    } catch (err) {
      console.error(`Failed for ${name} (${component}): ${err.message}`);
      projects[name] = { error: err.message };
    }
  }

  // Period covered + how far into the quarter we are (a confidence signal: early
  // in the quarter, low counts are partly just "not enough time yet").
  const nowD = new Date();
  const qm = Math.floor(nowD.getUTCMonth() / 3) * 3;
  const qEndD = new Date(Date.UTC(nowD.getUTCFullYear(), qm + 3, 0));
  const qStartD = new Date(`${QUARTER_START}T00:00:00Z`);
  const elapsedPct = Math.max(0, Math.min(100, Math.round((nowD - qStartD) / (qEndD - qStartD) * 100)));

  const out = {
    generatedAt: nowD.toISOString(),
    modelVersion: MODEL_VERSION,
    quarter: quarterLabel(nowD),
    project: PROJECT,
    criticalPriorities: CRITICAL,
    window: { from: QUARTER_START, to: nowD.toISOString().slice(0, 10), quarterEnd: qEndD.toISOString().slice(0, 10), elapsedPct },
    // Params so the UI recomputes the TRITON score identically on manual exclusion.
    tritonCurve: TRITON_CURVE,
    severityWeights: SEVERITY_WEIGHTS,
    exposureEnabled: !!EXPOSURE.enabled,
    ...(cfg.methodology ? { methodology: cfg.methodology } : {}),
    projects,
  };
  await writeFile(new URL('../risk-baseline/jira-metrics.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote risk-baseline/jira-metrics.json — ${Object.keys(projects).length} projects, quarter ${out.quarter}`);
}

main().catch(e => { console.error(e); process.exit(1); });
