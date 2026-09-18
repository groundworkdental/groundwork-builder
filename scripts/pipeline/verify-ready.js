#!/usr/bin/env node
/**
 * verify-ready — the one command that answers "is this ready to go live?"
 *
 *   node scripts/pipeline/verify-ready.js clients/<slug>
 *   node scripts/pipeline/verify-ready.js clients/<slug> --tier structural
 *   node scripts/pipeline/verify-ready.js clients/<slug> --json
 *
 * Exits non-zero when something blocking fails. Advisory findings are printed
 * and never affect the exit code — a design opinion that blocks a deploy gets
 * silenced within a week, and a silenced check catches nothing.
 */

import { resolve } from 'node:path';
import { runManifest, TIERS, THRESHOLDS } from './lib/launch-manifest.js';

const MARK = { pass: '✓', fail: '✗', warn: '!', skip: '–', error: '✗' };

function parseArgs(argv) {
  const opts = { target: null, tiers: TIERS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--tier') opts.tiers = [argv[++i]];
    else if (!a.startsWith('-')) opts.target = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.target) {
    console.error('usage: node scripts/pipeline/verify-ready.js clients/<slug> [--tier structural|measured|judged] [--json]');
    process.exit(2);
  }
  for (const t of opts.tiers) {
    if (!TIERS.includes(t)) {
      console.error(`unknown tier "${t}" — one of ${TIERS.join(', ')}`);
      process.exit(2);
    }
  }

  const clientDir = resolve(opts.target);
  const { checks, ready, blocking, advisory } = await runManifest(clientDir, { tiers: opts.tiers });

  if (opts.json) {
    console.log(JSON.stringify({ ready, thresholds: THRESHOLDS, checks }, null, 2));
    process.exit(ready ? 0 : 1);
  }

  console.log(`\nLaunch readiness — ${opts.target}\n`);
  for (const tier of opts.tiers) {
    const rows = checks.filter((c) => c.tier === tier);
    if (!rows.length) continue;
    const note = tier === 'judged' ? '  (advisory — never blocks)' : '';
    console.log(`  ${tier}${note}`);
    for (const c of rows) {
      console.log(`    ${MARK[c.status] || '?'} ${c.name}${c.detail ? ` — ${c.detail}`.slice(0, 150) : ''}`);
    }
    console.log('');
  }

  const counts = checks.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
  console.log(
    `  ${counts.pass || 0} passed · ${counts.fail || 0} failed · ` +
    `${counts.warn || 0} advisory · ${counts.skip || 0} not measured\n`,
  );

  if (!ready) {
    console.log(`  NOT READY — ${blocking.length} blocking failure(s):`);
    for (const c of blocking) console.log(`    ✗ ${c.name}`);
    console.log('');
    process.exit(1);
  }

  console.log('  READY to go live.');
  if (advisory.length) {
    console.log(`  ${advisory.length} advisory finding(s) above — worth reading, not blocking.`);
  }
  console.log('');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
