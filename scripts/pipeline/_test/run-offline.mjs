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
  // test-generators.js is NOT registered yet. blog-generator is fixed as of
  // this commit, but four checks still fail against main because they cover
  // work that is still uncommitted in the working tree:
  //   generatePages · suppressIntroFor        -> page-generator.js
  //   injectTailwindConfig · WCAG guard       -> injector.js / contrast.js
  //   generated component colour repairs      -> generate-sections.js
  //   callAnthropic · module wiring           -> ai-call.js
  // Register it in the commit that lands those.
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
