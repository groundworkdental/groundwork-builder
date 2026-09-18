#!/usr/bin/env node
/**
 * Offline regression suite — no network / no Anthropic.
 * Invoked by: npm test
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const tests = [
  'test-ensure-image-alts.js',
  'test-design-library.js',
  'test-reference-entry.js',
  'test-grade-homepage.js',
  'test-fixtures.js',
  'test-generators.js',
  'test-crawl-select.js',
  'test-faq-repair.js',
  'test-silver-fidelity.js',
  'test-intake-passthrough.js',
  'test-practice-contract.js',
];

let failed = 0;
for (const name of tests) {
  console.log(`\n▶ ${name}`);
  const r = spawnSync(process.execPath, [join(dir, name)], {
    stdio: 'inherit',
    cwd: join(dir, '..', '..', '..'),
  });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${name} exited ${r.status}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

if (failed) {
  console.error(`\n${failed}/${tests.length} test file(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} offline suites passed`);
