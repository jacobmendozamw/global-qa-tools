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
const DEV_PROJECTS = cfg.devProjects || {};
const DEFECT_TYPES = cfg.defectIssueTypes || (cfg.defectIssueType ? [cfg.defectIssueType] : ['Defect']);
const CRITICAL = cfg.criticalPriorities || ['Blocker', 'Critical'];
const EXCLUDE_KEYWORDS = cfg.excludeKeywords || [];
const LINK_ATTRIBUTION = cfg.linkAttribution || {};
const TRITON_CURVE = cfg.tritonCurve || { mu: 5, sigma: 4, scaleMax: 10 };
const SEVERITY_WEIGHTS = Object.fromEntries(Object.entries(cfg.severityWeights || {}).filter(([, v]) => typeof v === 'number'));
const EXPOSURE = cfg.exposure || { enabled: false };
const PRE_PRODUCTION_REPORTERS = cfg.qaPreProductionReporters || [];
const RISK_BASELINE_DEFAULTS = cfg.riskBaselineDefaults || {};
const MODEL_VERSION = cfg.modelVersion || 'unversioned';
const stripComment = o => { if (!o) return o; const { comment, ...rest } = o; return rest; };
const MODEL_PARAMS = stripComment(cfg.modelParams) || { curveType: 'gaussian', baseFloor: 0, multiplierMin: 0.70, multiplierMax: 1.10 };
const CALIBRATION = stripComment(cfg.calibration);
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

// Logistic CDF — interchangeable with the Gaussian via modelParams.curveType (Rec #5).
const logisticCDF = z => 1 / (1 + Math.exp(-z * 1.7));

// TRITON escaped-defect score on a 0–10 scale via an SLA-anchored curve over a
// severity-weighted count. mu = weighted escapes/quarter treated as "medium".
function tritonScore10(weightedCount) {
  const { mu, sigma, scaleMax = 10 } = TRITON_CURVE;
  const cdf = MODEL_PARAMS.curveType === 'logistic' ? logisticCDF : normalCDF;
  return Math.round(scaleMax * cdf((weightedCount - mu) / sigma) * 10) / 10;
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
    if (EXPOSURE.method === 'delivered' || conf.method === 'delivered') {
      // Clean denominator (Rec #1): restrict to delivery-bearing issue types.
      const types = (EXPOSURE.deliveredIssueTypes || ['Story', 'User Story', 'Bug']).map(q).join(', ');
      const done = await searchAll(`project = ${conf.devProject} AND issuetype in (${types}) AND statusCategory = Done AND resolved >= ${q(QUARTER_START)}`, ['key']);
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

// Builds a single combined JQL query from the devProjects config — mirrors the
// team's existing Jira filter. Projects without a component restriction are batched
// into a single "project in (...)" clause; projects with a component (e.g. SMM +
// Conversations) get their own clause. One API call covers all projects.
function buildInternalEscapedJQL(devProjects, quarterStart) {
  const regularProjects = [];
  const componentClauses = [];
  for (const conf of Object.values(devProjects)) {
    if (!conf?.project) continue;
    if (conf.component) {
      componentClauses.push(
        `(project = ${conf.project} AND component = ${q(conf.component)} AND labels = escaped AND created >= ${q(quarterStart)})`
      );
    } else {
      regularProjects.push(conf.project);
    }
  }
  const clauses = [];
  if (regularProjects.length)
    clauses.push(`(project in (${regularProjects.join(', ')}) AND labels = escaped AND created >= ${q(quarterStart)})`);
  clauses.push(...componentClauses);
  return clauses.join(' OR ');
}

// Builds a single combined JQL for bugs caught by QA in staging (labels = known,
// reported by QA team members). Mirrors buildInternalEscapedJQL structure but adds
// reporter filtering and uses preProductionProjects for MIRALEGACY → Mira mapping.
function buildPreProductionJQL(devProjects, reporters, quarterStart) {
  if (!reporters?.length) return '';
  const reporterClause = `reporter in (${reporters.map(q).join(', ')})`;
  const regularProjects = [];
  const componentClauses = [];
  for (const conf of Object.values(devProjects)) {
    if (!conf?.project) continue;
    const projects = conf.preProductionProjects ?? [conf.project];
    if (conf.component) {
      componentClauses.push(
        `(project in (${projects.join(', ')}) AND component = ${q(conf.component)} AND labels = known AND created >= ${q(quarterStart)} AND ${reporterClause})`
      );
    } else {
      regularProjects.push(...projects);
    }
  }
  const dedupedRegular = [...new Set(regularProjects)];
  const clauses = [];
  if (dedupedRegular.length)
    clauses.push(`(project in (${dedupedRegular.join(', ')}) AND labels = known AND created >= ${q(quarterStart)} AND ${reporterClause})`);
  clauses.push(...componentClauses);
  return clauses.join(' OR ');
}

// Fetch all pre-production tickets (labels = known, QA-reported) in one JQL query.
// Returns Map<riskBaselineProjectName → ticket[]> — keyed by project name (not board
// key) so that MIRALEGACY tickets are merged into "Mira" automatically.
async function fetchAllPreProductionCaught(devProjects, reporters, quarterStart) {
  const jql = buildPreProductionJQL(devProjects, reporters, quarterStart);
  if (!jql) return new Map();
  const reverseMap = new Map();
  for (const [name, conf] of Object.entries(devProjects)) {
    if (!conf?.project) continue;
    const projects = conf.preProductionProjects ?? [conf.project];
    for (const proj of projects) reverseMap.set(proj, name);
  }
  try {
    const issues = await searchAll(jql, ['summary', 'priority', 'project']);
    const byName = new Map();
    for (const i of issues) {
      const pk = i.fields?.project?.key;
      if (!pk) continue;
      const name = reverseMap.get(pk);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({
        key: i.key,
        summary: i.fields?.summary || '',
        priority: i.fields?.priority?.name || '—',
        url: `https://${SITE}/browse/${i.key}`,
      });
    }
    return byName;
  } catch (e) {
    console.error(`Pre-production catch fetch failed: ${e.message}`);
    return new Map();
  }
}

// Fetch all internally-detected escaped tickets across every configured dev project
// in a single JQL query, then return a Map<projectKey → ticket[]> for O(1) lookup.
async function fetchAllInternalEscaped(devProjects, quarterStart) {
  const jql = buildInternalEscapedJQL(devProjects, quarterStart);
  if (!jql) return new Map();
  try {
    const issues = await searchAll(jql, ['summary', 'priority', 'project']);
    const byProject = new Map();
    for (const i of issues) {
      const pk = i.fields?.project?.key;
      if (!pk) continue;
      if (!byProject.has(pk)) byProject.set(pk, []);
      byProject.get(pk).push({
        key: i.key,
        summary: i.fields?.summary || '',
        priority: i.fields?.priority?.name || '—',
        url: `https://${SITE}/browse/${i.key}`,
      });
    }
    return byProject;
  } catch (e) {
    console.error(`Internal escaped fetch failed: ${e.message}`);
    return new Map();
  }
}

// Comprehensive DCE score using all QA-caught signals:
//   preProductionCount  — bugs caught in staging (labels = known, never shipped)
//   internalEscapedCount — bugs caught in production before customers (labels = escaped)
//   customerCount       — bugs found by customers first (TRITON)
// Scoring: 1 = no internal signal, 2 = partial, 3 = ≥50% of all bugs caught internally.
function detectionEfficiencyScore(preProductionCount, internalEscapedCount, customerCount) {
  const internalTotal = preProductionCount + internalEscapedCount;
  const grandTotal = internalTotal + customerCount;
  if (grandTotal === 0 || internalTotal === 0) return 1;
  const rate = internalTotal / grandTotal;
  if (rate >= 0.50) return 3;
  return 2;
}

async function computeProject(name, component, internalEscapedMap, preProductionMap) {
  const linkPrefixes = prefixesFor(name);
  const needLinks = linkPrefixes.length > 0;
  const issueTypeClause = DEFECT_TYPES.length === 1
    ? `issuetype = ${q(DEFECT_TYPES[0])}`
    : `issuetype in (${DEFECT_TYPES.map(q).join(', ')})`;
  const base = `project = ${PROJECT} AND ${issueTypeClause} AND component = ${q(component)}`;
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

  const devConf = DEV_PROJECTS[name];
  const internalTickets = devConf ? (internalEscapedMap.get(devConf.project) || []) : [];
  const internalTotal = internalTickets.length;
  // preProductionMap is keyed by Risk Baseline project name (not board key), so MIRALEGACY
  // tickets are already merged into "Mira" by fetchAllPreProductionCaught.
  const preProductionTickets = preProductionMap.get(name) || [];
  const preProductionTotal = preProductionTickets.length;
  const comprehensiveInternal = preProductionTotal + internalTotal;
  const deScore = detectionEfficiencyScore(preProductionTotal, internalTotal, total);
  const deRate = (comprehensiveInternal + total) > 0
    ? Math.round((comprehensiveInternal / (comprehensiveInternal + total)) * 100)
    : 0;

  const result = {
    escapedDefects: { score: tritonScore10(tritonInput), total, critical, weighted, tickets,
      ...(exposure != null ? { exposure } : {}) },
    avgAgeOpenIssues: { avgDays, openCount, informational: true },
    dataQuality: { manualReview: needLinks ? { escaped: escMR, open: openMR } : { escaped: 0, open: 0 } },
    internalEscaped: { total: internalTotal, tickets: internalTickets },
    preProductionCaught: { total: preProductionTotal, tickets: preProductionTickets },
    detectionEfficiency: {
      score: deScore,
      preProductionCaught: preProductionTotal,
      internallyFound: internalTotal,
      customerFound: total,
      rate: deRate,
    },
  };
  if (needLinks) result.needsManualReview = { escaped: escMR, open: openMR };
  return result;
}

function quarterLabel(d) {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

async function main() {
  // Fetch all QA-detected bugs in a single pass per source, then distribute
  // to each project's computeProject call via Maps.
  const internalEscapedMap = await fetchAllInternalEscaped(DEV_PROJECTS, QUARTER_START);
  const internalTotal = [...internalEscapedMap.values()].reduce((s, t) => s + t.length, 0);
  console.log(`Internal escaped (all projects): ${internalTotal} tickets across ${internalEscapedMap.size} dev project(s)`);

  const preProductionMap = await fetchAllPreProductionCaught(DEV_PROJECTS, PRE_PRODUCTION_REPORTERS, QUARTER_START);
  const preProductionTotal = [...preProductionMap.values()].reduce((s, t) => s + t.length, 0);
  console.log(`Pre-production caught (all projects): ${preProductionTotal} tickets across ${preProductionMap.size} dev project(s)`);

  const projects = {};
  for (const [name, component] of Object.entries(cfg.projects)) {
    try {
      projects[name] = await computeProject(name, component, internalEscapedMap, preProductionMap);
      const e = projects[name].escapedDefects;
      const de = projects[name].detectionEfficiency;
      const mr = projects[name].needsManualReview ? ` [manual review: ${projects[name].needsManualReview.escaped} esc / ${projects[name].needsManualReview.open} open]` : '';
      const exp = e.exposure != null ? ` /exp ${e.exposure}` : '';
      const deStr = de ? ` | pre-prod=${de.preProductionCaught} escaped=${de.internallyFound} DCE=${de.rate}% score=${de.score}` : '';
      console.log(`${name} (${component}): customer=${e.total} (crit ${e.critical}) weighted=${e.weighted}${exp} → ${e.score}${deStr}${mr}`);
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
    // Params so the UI recomputes scores identically (and shows them in the Model tab).
    tritonCurve: TRITON_CURVE,
    severityWeights: SEVERITY_WEIGHTS,
    modelParams: MODEL_PARAMS,
    ...(CALIBRATION ? { calibration: CALIBRATION } : {}),
    exposureEnabled: !!EXPOSURE.enabled,
    ...(cfg.methodology ? { methodology: cfg.methodology } : {}),
    ...(cfg.docs ? { docs: cfg.docs } : {}),
    projects,
  };
  await writeFile(new URL('../risk-baseline/jira-metrics.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote risk-baseline/jira-metrics.json — ${Object.keys(projects).length} projects, quarter ${out.quarter}`);

  // ── Quarterly snapshot → data.json ──────────────────────────────────────────
  // Write one auto-generated record per project so the History tab always has
  // a current-quarter entry that matches the Risk Index score.
  const BASE_WEIGHTS = { userImpact: 0.40, rateOfChange: 0.35, complexity: 0.25 };
  function wavgBase(scores) {
    const entries = Object.entries(BASE_WEIGHTS).filter(([k]) => scores[k] != null);
    const totalW = entries.reduce((s, [, w]) => s + w, 0);
    return totalW === 0 ? null : entries.reduce((s, [k, w]) => s + w * scores[k], 0) / totalW;
  }
  function to10snap(v) {
    const baseFloor = MODEL_PARAMS.baseFloor ?? 0;
    return v == null ? null : Math.round((((v - 1) / 2) * (10 - baseFloor) + baseFloor) * 10) / 10;
  }

  const dataPath = new URL('../risk-baseline/data.json', import.meta.url);
  let existing = [];
  try { existing = JSON.parse(await readFile(dataPath, 'utf8')); } catch { existing = []; }
  if (!Array.isArray(existing)) existing = [];

  const quarterKey = out.quarter; // e.g. "Q3-2026"
  const snapDate = nowD.toISOString();

  for (const [proj, jp] of Object.entries(projects)) {
    const rbd = RISK_BASELINE_DEFAULTS[proj];
    const triton = jp.escapedDefects?.score ?? null;
    const baseScores = rbd ? { ...rbd } : {};
    const baseWavg = rbd ? wavgBase(baseScores) : null;
    const baseRisk = to10snap(baseWavg);
    const finalRisk = baseRisk != null && triton != null
      ? Math.min(10, Math.round((baseRisk * 0.40 + triton * 0.60) * 10) / 10)
      : triton != null ? Math.min(10, Math.round(triton * 0.60 * 10) / 10)
      : null;
    const lvl = finalRisk == null ? '' : finalRisk >= 7.4 ? 'High' : finalRisk >= 5.1 ? 'Medium' : 'Low';
    const id = `auto-${quarterKey}-${proj.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const record = {
      id,
      date: snapDate,
      modelVersion: MODEL_VERSION,
      project: proj,
      evaluator: 'auto',
      scores: { ...(rbd || {}), escapedDefects: triton },
      baseRisk,
      tritonScore: triton,
      finalRisk,
      level: lvl,
      scaleMax: 10,
      notes: `Auto-generated snapshot — ${quarterKey}`,
      jira: {
        source: 'TRITON', quarter: out.quarter, window: out.window, generatedAt: snapDate,
        ...jp,
      },
    };
    const idx = existing.findIndex(r => r.id === id);
    if (idx >= 0) existing[idx] = record; else existing.push(record);
  }

  existing.sort((a, b) => new Date(a.date) - new Date(b.date));
  await writeFile(dataPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`Wrote risk-baseline/data.json — ${Object.keys(projects).length} auto snapshots for ${quarterKey}`);
}

main().catch(e => { console.error(e); process.exit(1); });
