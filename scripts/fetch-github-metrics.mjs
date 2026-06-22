// Fetches GitHub activity for the tracked repo and writes git-metrics/data.json.
// Run by .github/workflows/refresh-github-metrics.yml on a schedule.
// Requires env GH_TOKEN: a fine-grained, read-only PAT with access to the repo below.
// Team membership is read from git-metrics/teams.json.
import { readFile, writeFile } from 'node:fs/promises';

const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN not set');
  process.exit(1);
}

const OWNER = 'meltwater';
const REPO = 'global-qa-test-suite';

const BOT_LOGINS = [
  'globalqa-repo-automation-bot',
  'web-flow',
  'github-actions[bot]',
  'dependabot[bot]',
  'copilot',
];

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// ---- teams config ----
const cfg = JSON.parse(await readFile(new URL('../git-metrics/teams.json', import.meta.url), 'utf8'));
const UNASSIGNED = cfg.unassignedLabel || 'Other / Unassigned';
const handleMap = {}; // lowercased handle -> { team, name }
for (const t of cfg.teams || []) {
  for (const [handle, name] of Object.entries(t.members || {})) {
    handleMap[handle.toLowerCase()] = { team: t.name, name };
  }
}
const resolve = login => handleMap[login.toLowerCase()] || { team: UNASSIGNED, name: login };

async function ghGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `https://api.github.com${path}${query ? '?' + query : ''}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`GitHub ${resp.status} for ${path}`);
  return resp.json();
}

function isBot(login, type) {
  if (!login) return true;
  if (type === 'Bot') return true;
  if (login.includes('[bot]')) return true;
  if (BOT_LOGINS.includes(login.toLowerCase())) return true;
  return false;
}

// All commits across the repo, grouped by login and month
async function getAllCommitsByMonth() {
  const result = {};
  let page = 1;
  while (true) {
    let items;
    try {
      items = await ghGet(`/repos/${OWNER}/${REPO}/commits`, { per_page: 100, page });
    } catch { break; }
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      const login = item?.author?.login;
      const type = item?.author?.type;
      if (!login || isBot(login, type)) continue;
      const date = item?.commit?.author?.date;
      if (!date) continue;
      const month = date.slice(0, 7);
      if (!result[login]) result[login] = {};
      result[login][month] = (result[login][month] || 0) + 1;
    }
    if (items.length < 100) break;
    page++;
  }
  return result;
}

// All PRs across the repo, grouped by login and month
async function getAllPRsByMonth() {
  const result = {};
  let page = 1;
  while (true) {
    let items;
    try {
      items = await ghGet(`/repos/${OWNER}/${REPO}/pulls`, { state: 'all', per_page: 100, page });
    } catch { break; }
    if (!Array.isArray(items) || items.length === 0) break;
    for (const pr of items) {
      const login = pr?.user?.login;
      const type = pr?.user?.type;
      if (!login || isBot(login, type)) continue;
      const month = pr.created_at.slice(0, 7);
      if (!result[login]) result[login] = {};
      result[login][month] = (result[login][month] || 0) + 1;
    }
    if (items.length < 100) break;
    page++;
  }
  return result;
}

function lc(obj) {
  const o = {};
  for (const k in obj) o[k.toLowerCase()] = obj[k];
  return o;
}

async function main() {
  const [allCommits, allPRs] = await Promise.all([
    getAllCommitsByMonth(),
    getAllPRsByMonth(),
  ]);

  const allMonthsSet = new Set();
  Object.values(allCommits).forEach(r => Object.keys(r).forEach(m => allMonthsSet.add(m)));
  Object.values(allPRs).forEach(r => Object.keys(r).forEach(m => allMonthsSet.add(m)));
  const allMonths = [...allMonthsSet].sort();

  const allCommitsLC = lc(allCommits);
  const allPRsLC = lc(allPRs);
  const monthly = (byLoginLC, handle) => allMonths.map(m => (byLoginLC[handle.toLowerCase()]?.[m] || 0));

  // ---- per-team breakdown + totals ----
  const teamData = {};
  const teamTotals = {};
  const teamsPresent = [];

  function buildTeam(name, memberEntries) {
    const commits = {};
    const prs = {};
    const tCommits = allMonths.map(() => 0);
    const tPrs = allMonths.map(() => 0);
    for (const { handle, name: dn } of memberEntries) {
      const c = monthly(allCommitsLC, handle);
      const p = monthly(allPRsLC, handle);
      commits[dn] = c;
      prs[dn] = p;
      c.forEach((v, i) => { tCommits[i] += v; });
      p.forEach((v, i) => { tPrs[i] += v; });
    }
    teamData[name] = { members: memberEntries.map(m => m.name), commits, prs };
    teamTotals[name] = {
      commits: tCommits,
      prs: tPrs,
      totalCommits: tCommits.reduce((a, b) => a + b, 0),
      totalPrs: tPrs.reduce((a, b) => a + b, 0),
    };
  }

  // configured teams (kept in config order; members shown even with zero activity)
  for (const t of cfg.teams || []) {
    const entries = Object.entries(t.members || {}).map(([handle, name]) => ({ handle, name }));
    buildTeam(t.name, entries);
    teamsPresent.push(t.name);
  }

  // unassigned contributors (dynamic), sorted by total commits desc
  const allLogins = new Set([...Object.keys(allCommits), ...Object.keys(allPRs)]);
  const totalC = l => allMonths.reduce((s, m) => s + (allCommitsLC[l.toLowerCase()]?.[m] || 0), 0);
  const unassigned = [...allLogins]
    .filter(l => !handleMap[l.toLowerCase()])
    .sort((a, b) => totalC(b) - totalC(a));
  if (unassigned.length) {
    buildTeam(UNASSIGNED, unassigned.map(l => ({ handle: l, name: l })));
    teamsPresent.push(UNASSIGNED);
  }

  // ---- individual ranking (with team) ----
  const ranking = [...allLogins].map(login => {
    const r = resolve(login);
    return {
      login,
      displayName: r.name,
      team: r.team,
      isTeam: r.team !== UNASSIGNED,
      commitsByMonth: allCommits[login] || {},
      prsByMonth: allPRs[login] || {},
    };
  });

  const out = {
    allMonths,
    teams: teamsPresent,
    teamData,
    teamTotals,
    ranking,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(new URL('../git-metrics/data.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote git-metrics/data.json — ${allMonths.length} months, ${teamsPresent.length} teams, ${ranking.length} contributors`);
}

main().catch(e => { console.error(e); process.exit(1); });
