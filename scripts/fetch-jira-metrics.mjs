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

// Bands from the risk-baseline model:
//   1 → 0–1 escapes and none critical
//   2 → 2–4 escapes, or 1 critical
//   3 → 5+ escapes, or 2+ critical   (severity overrides volume)
function escapedDefectScore(total, critical) {
  if (total >= 5 || critical >= 2) return 3;
  if (total >= 2 || critical >= 1) return 2;
  return 1;
}

// Bands (mitigation — higher score = faster = better):
//   3 → 0–7 days avg | 2 → 8–30 | 1 → 31+
// No open issues → nothing aging → best (3).
function ageScore(avgDays, openCount) {
  if (openCount === 0) return 3;
  if (avgDays <= 7) return 3;
  if (avgDays <= 30) return 2;
  return 1;
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

// Mira and Mira Studio share the TRITON component "Mira" (§4.6). When a project
// declares a linkAttribution prefix, keep only tickets linked to that project
// (e.g. HZN-* -> Mira Studio, MIRA-* -> Mira). Tickets with no matching link are
// set aside as "needsManualReview" rather than silently attributed.
function partitionByLink(issues, prefix) {
  if (!prefix) return { matched: issues, manualReview: 0 };
  const matched = [];
  let manualReview = 0;
  for (const i of issues) {
    const keys = linkedKeys(i);
    if (keys.some(k => k.startsWith(`${prefix}-`))) matched.push(i);
    else if (!keys.some(k => Object.values(LINK_ATTRIBUTION).some(p => k.startsWith(`${p}-`)))) manualReview++;
    // else: linked to the *other* shared project — correctly excluded here.
  }
  return { matched, manualReview };
}

async function computeProject(name, component) {
  const linkPrefix = LINK_ATTRIBUTION[name];
  const needLinks = !!linkPrefix;
  const base = `project = ${PROJECT} AND issuetype = ${q(DEFECT_TYPE)} AND component = ${q(component)}`;
  const fields = base => needLinks ? base.concat('issuelinks') : base;

  // Escaped defects this calendar quarter (service requests excluded).
  const escapedRaw = await searchAll(`${base} AND created >= ${q(QUARTER_START)}${EXCLUDE_CLAUSE}`, fields(['priority']));
  const { matched: escaped, manualReview: escMR } = partitionByLink(escapedRaw, linkPrefix);
  const total = escaped.length;
  const critical = escaped.filter(i => CRITICAL.includes(i.fields?.priority?.name)).length;

  // Open (unresolved) defects — average age in days since creation.
  const openRaw = await searchAll(`${base} AND resolution = Unresolved${EXCLUDE_CLAUSE}`, fields(['created']));
  const { matched: open, manualReview: openMR } = partitionByLink(openRaw, linkPrefix);
  const now = Date.now();
  const ages = open
    .map(i => i.fields?.created)
    .filter(Boolean)
    .map(c => (now - new Date(c).getTime()) / 86400000);
  const openCount = ages.length;
  const avgDays = openCount ? Math.round(ages.reduce((a, b) => a + b, 0) / openCount) : 0;

  const result = {
    escapedDefects: { score: escapedDefectScore(total, critical), total, critical },
    avgAgeOpenIssues: { score: ageScore(avgDays, openCount), avgDays, openCount },
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
      const e = projects[name].escapedDefects, a = projects[name].avgAgeOpenIssues;
      const mr = projects[name].needsManualReview ? ` [manual review: ${projects[name].needsManualReview.escaped} esc / ${projects[name].needsManualReview.open} open]` : '';
      console.log(`${name} (${component}): escaped=${e.total} (crit ${e.critical}) → ${e.score}; open=${a.openCount} avg ${a.avgDays}d → ${a.score}${mr}`);
    } catch (err) {
      console.error(`Failed for ${name} (${component}): ${err.message}`);
      projects[name] = { error: err.message };
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    quarter: quarterLabel(new Date()),
    project: PROJECT,
    criticalPriorities: CRITICAL,
    projects,
  };
  await writeFile(new URL('../risk-baseline/jira-metrics.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote risk-baseline/jira-metrics.json — ${Object.keys(projects).length} projects, quarter ${out.quarter}`);
}

main().catch(e => { console.error(e); process.exit(1); });
