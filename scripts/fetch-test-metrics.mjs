// Fetches test-suite stats from GitHub for each Risk Baseline project and writes
// risk-baseline/test-metrics.json. Run by .github/workflows/refresh-test-metrics.yml.
//
// Uses the same GH_TOKEN (METRICS_READ_TOKEN) as fetch-github-metrics.mjs — a
// fine-grained, read-only PAT with access to:
//   meltwater/global-qa-test-suite      (Playwright .spec.ts files)
//   meltwater/global-qa-mobile-test-suite (Maestro .yaml flow files)
//
// For each project it counts:
//   specFiles    — .spec.ts (or .yaml) files in the project directory
//   activeTests  — test() / it() calls that are NOT skipped
//   skipped      — test.skip() / it.skip() / test.fixme() calls
//
// NOTE: this script reports QUANTITATIVE evidence only. The mapping from
// "spec count" to "X of Y critical flows covered" requires human judgment and
// stays hardcoded in the app's PROJECT_EVIDENCE constant.
import { writeFile } from 'node:fs/promises';

const token = process.env.GH_TOKEN;
if (!token) { console.error('GH_TOKEN not set'); process.exit(1); }

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// Project → GitHub source config
const TEST_PROJECTS = {
  'GenAI Lens':     { owner:'meltwater', repo:'global-qa-test-suite',        branch:'develop', dir:'src/tests/monitor/genai-lens', type:'playwright' },
  'Mira Studio':    { owner:'meltwater', repo:'global-qa-test-suite',        branch:'develop', dir:'src/tests/mira-studio',        type:'playwright' },
  'Mira':           { owner:'meltwater', repo:'global-qa-test-suite',        branch:'develop', dir:'src/tests/mira',               type:'playwright' },
  'Engage (Legacy)':{ owner:'meltwater', repo:'global-qa-test-suite',        branch:'develop', dir:'src/tests/engage',             type:'playwright' },
  'Mobile':         { owner:'meltwater', repo:'global-qa-mobile-test-suite', branch:'main',    dir:'',                            type:'maestro'    },
};

async function ghGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `https://api.github.com${path}${query ? '?' + query : ''}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`GitHub ${resp.status} for ${path}: ${await resp.text()}`);
  return resp.json();
}

// Returns all blobs under `dir` in the repo, using the recursive tree API.
async function listFiles(owner, repo, branch, dir) {
  const { commit } = await ghGet(`/repos/${owner}/${repo}/branches/${branch}`);
  const { tree } = await ghGet(`/repos/${owner}/${repo}/git/trees/${commit.commit.tree.sha}`, { recursive: '1' });
  const prefix = dir ? dir + '/' : '';
  return tree.filter(f => f.type === 'blob' && f.path.startsWith(prefix));
}

// Downloads a single file via the contents API (base64 → utf8). Max ~1 MB.
async function readFile(owner, repo, path, branch) {
  const data = await ghGet(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, { ref: branch });
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

// Counts active and skipped Playwright tests in a TypeScript source file.
function countPlaywrightTests(src) {
  const skipRe  = /\b(?:test|it)\.(?:skip|fixme)\s*\(/g;
  const totalRe = /\b(?:test|it)\s*\(/g;
  const skipped = (src.match(skipRe)  || []).length;
  const total   = (src.match(totalRe) || []).length;
  return { active: Math.max(0, total - skipped), skipped };
}

async function computePlaywright(name, cfg) {
  const files = await listFiles(cfg.owner, cfg.repo, cfg.branch, cfg.dir);
  const specs  = files.filter(f => f.path.endsWith('.spec.ts'));

  let activeTests = 0, skipped = 0;
  for (const spec of specs) {
    try {
      const src = await readFile(cfg.owner, cfg.repo, spec.path, cfg.branch);
      const counts = countPlaywrightTests(src);
      activeTests += counts.active;
      skipped     += counts.skipped;
    } catch (e) {
      console.warn(`  [warn] could not read ${spec.path}: ${e.message}`);
    }
  }

  return {
    repo: cfg.repo, branch: cfg.branch, directory: cfg.dir,
    specFiles: specs.length, activeTests, skipped,
  };
}

async function computeMaestro(name, cfg) {
  const files    = await listFiles(cfg.owner, cfg.repo, cfg.branch, cfg.dir);
  const allYaml  = files.filter(f => /\.(yaml|yml)$/.test(f.path));
  const subflows = allYaml.filter(f => f.path.includes('/subflows/'));
  const main     = allYaml.filter(f => !f.path.includes('/subflows/'));

  return {
    repo: cfg.repo, branch: cfg.branch, directory: cfg.dir || '(root)',
    specFiles: main.length, activeTests: main.length, skipped: 0,
    subflows: subflows.length,
  };
}

async function main() {
  const projects = {};
  for (const [name, cfg] of Object.entries(TEST_PROJECTS)) {
    try {
      console.log(`Fetching ${name} (${cfg.repo})...`);
      projects[name] = cfg.type === 'maestro'
        ? await computeMaestro(name, cfg)
        : await computePlaywright(name, cfg);
      const p = projects[name];
      console.log(`  → ${p.specFiles} files · ${p.activeTests} active · ${p.skipped} skipped`);
    } catch (e) {
      console.error(`  [error] ${name}: ${e.message}`);
      projects[name] = { error: e.message };
    }
  }

  const out = { generatedAt: new Date().toISOString(), projects };
  await writeFile(
    new URL('../risk-baseline/test-metrics.json', import.meta.url),
    JSON.stringify(out, null, 2) + '\n'
  );
  console.log(`Wrote risk-baseline/test-metrics.json — ${Object.keys(projects).length} projects`);
}

main().catch(e => { console.error(e); process.exit(1); });
