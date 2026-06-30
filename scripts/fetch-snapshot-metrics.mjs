// Fetches test-suite stats from a specific git tree SHA (end-of-quarter snapshot).
// Writes results into risk-baseline/historical-test-metrics.json.
//
// Usage:
//   GH_TOKEN=<METRICS_READ_TOKEN> node scripts/fetch-snapshot-metrics.mjs \
//     --tree=<SHA>  --label=q1-2026
//
// --tree   : full commit or tree SHA from the target repo snapshot
// --label  : quarter label written into the output (e.g. Q1-2026, Q2-2026)
//
// The script appends/updates that quarter entry in historical-test-metrics.json
// so you can run it multiple times for different quarters without overwriting.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync }          from 'node:fs';

// ── Args ─────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v]; })
);
const TREE_SHA = args.tree;
const LABEL    = (args.label || '').toUpperCase();   // e.g. Q1-2026
if (!TREE_SHA || !LABEL) {
  console.error('Usage: GH_TOKEN=<tok> node fetch-snapshot-metrics.mjs --tree=<SHA> --label=Q1-2026');
  process.exit(1);
}

const token = process.env.GH_TOKEN;
if (!token) { console.error('GH_TOKEN not set'); process.exit(1); }

const OWNER = 'meltwater';
const REPO  = 'global-qa-test-suite';

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// Project → directory within global-qa-test-suite
const PLAYWRIGHT_DIRS = {
  'GenAI Lens':      'src/tests/monitor/genai-lens',
  'Mira Studio':     'src/tests/mira-studio',
  'Klear':           'src_klear/tests',
  'Explore':         'src/tests/explore',
  'Explore+':        'src/tests/explore-plus',
  'Monitor':         'src/tests/monitor',
  'Media Relations': 'src/tests/media-relations',
  'Newsletters':     'src/tests/newsletters',
  'Smart Alerts':    'src/tests/alerts',
  'Engage (Legacy)': 'src/tests/engage',
  // Mira, Analytics, UDS, App Framework: no Playwright tests yet
};

// Sub-directories to exclude from a project's spec scan
// (used when a sub-product has its own dedicated PLAYWRIGHT_DIRS entry)
const EXCLUDE_DIRS = {
  'Monitor': ['src/tests/monitor/genai-lens'],
};

async function ghGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url   = `https://api.github.com${path}${query ? '?' + query : ''}`;
  const resp  = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`GitHub ${resp.status} for ${path}: ${await resp.text()}`);
  return resp.json();
}

// Resolve SHA: if it looks like a commit SHA, get the tree SHA from it.
async function resolveTreeSha(sha) {
  try {
    const commit = await ghGet(`/repos/${OWNER}/${REPO}/git/commits/${sha}`);
    return commit.tree.sha;
  } catch {
    // Might already be a tree SHA — use as-is
    return sha;
  }
}

function countPlaywrightTests(src) {
  const skipRe  = /\b(?:test|it)\.(?:skip|fixme)\s*\(/g;
  const totalRe = /\b(?:test|it)\s*\(/g;
  const skipped = (src.match(skipRe)  || []).length;
  const total   = (src.match(totalRe) || []).length;
  return { active: Math.max(0, total - skipped), skipped };
}

async function main() {
  console.log(`Resolving tree SHA for ${TREE_SHA}...`);
  const treeSha = await resolveTreeSha(TREE_SHA);
  console.log(`Tree SHA: ${treeSha}`);

  // Fetch the full recursive tree once
  const { tree } = await ghGet(`/repos/${OWNER}/${REPO}/git/trees/${treeSha}`, { recursive: '1' });
  const blobs = tree.filter(f => f.type === 'blob');
  console.log(`Tree has ${blobs.length} blobs total`);

  const results = {};

  for (const [project, dir] of Object.entries(PLAYWRIGHT_DIRS)) {
    const prefix   = dir + '/';
    const excludes = (EXCLUDE_DIRS[project] || []).map(e => e + '/');
    const specs    = blobs.filter(f =>
      f.path.startsWith(prefix) &&
      f.path.endsWith('.spec.ts') &&
      !excludes.some(ex => f.path.startsWith(ex))
    );
    console.log(`${project}: ${specs.length} spec files`);

    let activeTests = 0, skipped = 0;
    for (const spec of specs) {
      try {
        const blob = await ghGet(`/repos/${OWNER}/${REPO}/git/blobs/${spec.sha}`);
        const src  = Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8');
        const c    = countPlaywrightTests(src);
        activeTests += c.active;
        skipped     += c.skipped;
      } catch (e) {
        console.warn(`  [warn] could not read ${spec.path}: ${e.message}`);
      }
    }

    results[project] = {
      repo: REPO, treeSha,
      directory: dir,
      specFiles: specs.length, activeTests, skipped,
    };
    console.log(`  → ${activeTests} active · ${skipped} skipped`);
  }

  // Mobile had no tests before Q2-2026
  results['Mobile'] = {
    repo: 'global-qa-mobile-test-suite', treeSha: 'n/a (suite not yet created)',
    directory: '(root)',
    specFiles: 0, activeTests: 0, skipped: 0, subflows: 0,
    note: 'Mobile test suite did not exist in this quarter',
  };

  // Read or initialise the output file
  const outPath = new URL('../risk-baseline/historical-test-metrics.json', import.meta.url);
  let existing  = {};
  if (existsSync(outPath)) {
    try { existing = JSON.parse(await readFile(outPath, 'utf8')); } catch {}
  }

  existing[LABEL] = { generatedAt: new Date().toISOString(), commitSha: TREE_SHA, projects: results };

  await writeFile(outPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\nWrote ${LABEL} into risk-baseline/historical-test-metrics.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
