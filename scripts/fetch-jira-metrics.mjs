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

async function computeProject(component) {
  const base = `project = ${PROJECT} AND issuetype = ${q(DEFECT_TYPE)} AND component = ${q(component)}`;

  // Escaped defects this calendar quarter.
  const escaped = await searchAll(`${base} AND created >= ${q(QUARTER_START)}`, ['priority']);
  const total = escaped.length;
  const critical = escaped.filter(i => CRITICAL.includes(i.fields?.priority?.name)).length;

  // Open (unresolved) defects — average age in days since creation.
  const open = await searchAll(`${base} AND resolution = Unresolved`, ['created']);
  const now = Date.now();
  const ages = open
    .map(i => i.fields?.created)
    .filter(Boolean)
    .map(c => (now - new Date(c).getTime()) / 86400000);
  const openCount = ages.length;
  const avgDays = openCount ? Math.round(ages.reduce((a, b) => a + b, 0) / openCount) : 0;

  return {
    escapedDefects: { score: escapedDefectScore(total, critical), total, critical },
    avgAgeOpenIssues: { score: ageScore(avgDays, openCount), avgDays, openCount },
  };
}

function quarterLabel(d) {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

async function main() {
  const projects = {};
  for (const [name, component] of Object.entries(cfg.projects)) {
    try {
      projects[name] = await computeProject(component);
      const e = projects[name].escapedDefects, a = projects[name].avgAgeOpenIssues;
      console.log(`${name} (${component}): escaped=${e.total} (crit ${e.critical}) → ${e.score}; open=${a.openCount} avg ${a.avgDays}d → ${a.score}`);
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
