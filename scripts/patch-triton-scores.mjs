// One-shot script: computes tritonScore for any history entry that has
// a weighted count but null tritonScore. Uses the same formula as
// fetch-jira-metrics.mjs (gaussian CDF with params from jira-projects.json).
//
// Usage: node scripts/patch-triton-scores.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath }       from 'node:url';
import { join, dirname }       from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const cfg = JSON.parse(await readFile(join(__dir, 'jira-projects.json'), 'utf8'));
const { mu, sigma, scaleMax = 10 } = cfg.tritonCurve;

// Polynomial approximation of normalCDF (Abramowitz & Stegun 26.2.17)
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z / Math.SQRT2) * (z / Math.SQRT2));
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

function tritonScore10(w) {
  return Math.round(scaleMax * normalCDF((w - mu) / sigma) * 10) / 10;
}

const histPath = join(__dir, '../risk-baseline/jira-history.json');
const h = JSON.parse(await readFile(histPath, 'utf8'));

let patched = 0;

for (const [proj, quarters] of Object.entries(h.projects)) {
  for (const [ql, entry] of Object.entries(quarters)) {
    if (entry.tritonScore === null && entry.weighted !== null) {
      const newScore = tritonScore10(entry.weighted);
      console.log(`PATCH  ${proj.padEnd(20)} ${ql}  weighted=${entry.weighted}  → tritonScore=${newScore}`);
      entry.tritonScore = newScore;
      patched++;
    }
  }
}

console.log(`\nPatched ${patched} entries.`);
await writeFile(histPath, JSON.stringify(h, null, 2) + '\n');
console.log('Wrote risk-baseline/jira-history.json');
