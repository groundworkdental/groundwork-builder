/**
 * The launch manifest — one answer to "is this ready to go live?"
 *
 * The checks already existed. They were scattered across four places that did
 * not know about each other: sixteen structural gates in verify-launch.js,
 * PageSpeed and axe thresholds inside ship-gates.js, design critique buried in
 * the designer loop, and a GBP comparison done by hand. So the question had
 * four answers and no single command, which in practice meant it had none.
 *
 * Three tiers, because the checks differ in cost by orders of magnitude and
 * pretending otherwise is exactly why they drifted apart:
 *
 *   structural   ~1s, no network, no tokens.  Always run. Always blocking.
 *   measured     seconds to minutes, network. Pre-launch. Blocking.
 *   judged       expensive, AI, non-deterministic. Pre-launch. ADVISORY.
 *
 * The last one is a rule, not a convenience. A design opinion that blocks a
 * deploy gets silenced within a week, and a silenced check catches nothing —
 * the same reasoning that keeps the GBP attribute reminder advisory and the
 * working-tree warning out of the failure path.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const PIPELINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const TIERS = ['structural', 'measured', 'judged'];

/** Thresholds live here so the manifest is the one place they are stated. */
export const THRESHOLDS = {
  mobilePerformance: 90,
  lighthouseAccessibility: 90,
  axeCriticalOrSerious: 0,
  designScore: 7,          // advisory
};

// ---------------------------------------------------------------------------
// Structural — the gates that need nothing but the built directory
// ---------------------------------------------------------------------------

async function structural(clientDir) {
  try {
    const { stdout } = await run('node', [resolve(PIPELINE, 'verify-launch.js'), clientDir], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseVerifyLaunch(stdout, true);
  } catch (err) {
    // verify-launch exits non-zero when a gate fails; that is a result, not a
    // crash. Anything without output really is a crash.
    if (err.stdout) return parseVerifyLaunch(err.stdout, false);
    return [{ tier: 'structural', name: 'verify-launch', status: 'error', detail: err.message }];
  }
}

function parseVerifyLaunch(stdout, passed) {
  const checks = [];
  for (const line of stdout.split('\n')) {
    const m = /^(PASS|FAIL|WARN)\s+(.+?)\s+—\s+(.+)$/.exec(line.trim())
      || /^(PASS|FAIL|WARN)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    checks.push({
      tier: 'structural',
      name: m[2].trim(),
      status: m[1] === 'PASS' ? 'pass' : m[1] === 'WARN' ? 'warn' : 'fail',
      detail: (m[3] || '').trim(),
    });
  }
  if (!checks.length) {
    checks.push({ tier: 'structural', name: 'verify-launch', status: passed ? 'pass' : 'fail', detail: 'no gate output parsed' });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Measured — numbers from a real build or a live URL
// ---------------------------------------------------------------------------

/**
 * Read what the build already measured rather than re-measuring.
 *
 * PageSpeed costs a network round trip and a quota; the publish step has
 * usually just run it. Re-running here would make the manifest slow enough to
 * skip, which is the failure mode that matters most.
 */
async function measured(clientDir) {
  const checks = [];
  const read = async (name) => {
    try {
      const raw = JSON.parse(await readFile(resolve(clientDir, '_pipeline', name), 'utf8'));
      return raw.output ?? raw;
    } catch { return null; }
  };

  const after = await read('03-pagespeed-after.json');
  if (!after) {
    checks.push({
      tier: 'measured', name: 'pagespeed', status: 'skip',
      detail: 'no _pipeline/03-pagespeed-after.json — run publish, or pass --measure to fetch live',
    });
  } else {
    const mobile = after.mobile ?? null;
    checks.push({
      tier: 'measured', name: 'mobile performance',
      status: mobile == null ? 'skip' : mobile >= THRESHOLDS.mobilePerformance ? 'pass' : 'fail',
      detail: mobile == null ? 'not measured' : `${mobile} (min ${THRESHOLDS.mobilePerformance})`,
    });
    const a11y = after.accessibility ?? null;
    checks.push({
      tier: 'measured', name: 'lighthouse a11y',
      status: a11y == null ? 'skip' : a11y >= THRESHOLDS.lighthouseAccessibility ? 'pass' : 'fail',
      detail: a11y == null ? 'not measured' : `${a11y} (min ${THRESHOLDS.lighthouseAccessibility})`,
    });
  }

  const axe = await read('11b-a11y-audit.json');
  if (!axe) {
    checks.push({ tier: 'measured', name: 'axe-core', status: 'skip', detail: 'no a11y artifact' });
  } else {
    const c = axe.byImpact || {};
    const bad = (c.critical || 0) + (c.serious || 0);
    checks.push({
      tier: 'measured', name: 'axe-core',
      status: bad === THRESHOLDS.axeCriticalOrSerious ? 'pass' : 'fail',
      detail: `${c.critical || 0} critical, ${c.serious || 0} serious across ${axe.pageCount || 0} page(s)`,
    });
  }

  const agentic = await read('03-agentic-after.json');
  checks.push({
    tier: 'measured', name: 'llms.txt',
    status: !agentic ? 'skip' : agentic.llmsTxtStatus === 'good' ? 'pass' : 'fail',
    detail: !agentic ? 'not checked' : `status: ${agentic.llmsTxtStatus}`,
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Judged — design critique, always advisory
// ---------------------------------------------------------------------------

async function judged(clientDir) {
  const checks = [];
  try {
    const raw = JSON.parse(
      await readFile(resolve(clientDir, '_pipeline', '12-designer-critique.json'), 'utf8'),
    );
    const out = raw.output ?? raw;
    const dims = out.dimensions || out.scores || {};
    const entries = Object.entries(dims).filter(([, v]) => typeof v === 'number');
    if (!entries.length) {
      checks.push({ tier: 'judged', name: 'design critique', status: 'skip', detail: 'no dimension scores in artifact' });
    } else {
      const low = entries.filter(([, v]) => v < THRESHOLDS.designScore);
      checks.push({
        tier: 'judged', name: 'design critique',
        status: low.length ? 'warn' : 'pass',
        detail: low.length
          ? `${low.length} dimension(s) below ${THRESHOLDS.designScore}: ${low.map(([k, v]) => `${k} ${v}`).join(', ')}`
          : `${entries.length} dimensions all ≥ ${THRESHOLDS.designScore}`,
      });
    }
  } catch {
    checks.push({
      tier: 'judged', name: 'design critique', status: 'skip',
      detail: 'no _pipeline/12-designer-critique.json — the designer loop has not run',
    });
  }

  // Impeccable is the reference the critique is judged against, so a stale pin
  // means the bar itself is old. Advisory, and deliberately loud about it.
  try {
    const { stdout } = await run('git', ['submodule', 'status', 'src/skills/impeccable'], {
      cwd: resolve(PIPELINE, '..', '..'),
    });
    const sha = stdout.trim().split(/\s+/)[0]?.replace(/^[+-]/, '') || '';
    checks.push({
      tier: 'judged', name: 'design reference',
      status: 'warn',
      detail: `impeccable pinned at ${sha.slice(0, 8)} — pinning is correct, but check it is the pin you meant`,
    });
  } catch {
    checks.push({ tier: 'judged', name: 'design reference', status: 'skip', detail: 'submodule not initialised' });
  }

  return checks;
}

// ---------------------------------------------------------------------------

/**
 * Run the manifest.
 *
 * @param {string} clientDir
 * @param {object} [opts]
 * @param {('structural'|'measured'|'judged')[]} [opts.tiers]
 * @returns {Promise<{checks: object[], ready: boolean, blocking: object[], advisory: object[]}>}
 */
export async function runManifest(clientDir, { tiers = TIERS } = {}) {
  const checks = [];
  if (tiers.includes('structural')) checks.push(...await structural(clientDir));
  if (tiers.includes('measured')) checks.push(...await measured(clientDir));
  if (tiers.includes('judged')) checks.push(...await judged(clientDir));

  // Only structural and measured can block. Judged never does, by design.
  const blocking = checks.filter(
    (c) => c.status === 'fail' && c.tier !== 'judged',
  );
  const advisory = checks.filter(
    (c) => c.status === 'warn' || (c.status === 'fail' && c.tier === 'judged'),
  );

  return { checks, ready: blocking.length === 0, blocking, advisory };
}
