#!/usr/bin/env node
/**
 * check-readiness.js — can we build this practice yet?
 *
 * The missing-report tells you what a build lacked AFTER the build ran.
 * This asks the same question BEFORE, against the intake alone, so a
 * practice that is missing its logo and half its address costs a question
 * rather than a pipeline run.
 *
 * Reads the contract in standards/practice-contract.js. It does not hold
 * its own list of requirements — if a field is not in the contract, this
 * does not ask for it.
 *
 * A cold build is deliberately permissive: the crawl is expected to supply
 * most fields, so only what the crawl CANNOT invent is enforced. A launch
 * is strict.
 *
 *   node scripts/pipeline/check-readiness.js clients/<slug>/intake.json
 *   node scripts/pipeline/check-readiness.js --slug <slug>          # from D1
 *   node scripts/pipeline/check-readiness.js <path> --phase full    # launch
 *   node scripts/pipeline/check-readiness.js <path> --json
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadIntake } from './lib/intake.js';
import {
  DATA_FIELDS,
  evaluateDataFields,
  accessItemsForPhase,
  manualAccessItems,
  getPath,
} from './standards/practice-contract.js';

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { source: null, slug: null, phase: 'cold', json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') opts.slug = argv[++i];
    else if (a === '--phase') opts.phase = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (!a.startsWith('-')) opts.source = a;
  }
  return opts;
}

/**
 * Which severities block, per phase.
 *
 * Cold builds run on scraped data, so "important" fields the crawl normally
 * finds (bio, hours, office photos) are not worth blocking on — the missing
 * report catches them later. Critical fields still block, because a build
 * without a practice name produces broken output rather than partial output.
 *
 * At launch everything critical AND important blocks: that is the line
 * between "a preview we generated" and "a site a patient will call".
 */
const BLOCKING = {
  cold:    ['critical'],
  deposit: ['critical'],
  full:    ['critical', 'important'],
};

/**
 * Fields a crawl can realistically supply. Missing from the intake is fine
 * for a cold build as long as the site being crawled has them; these are
 * reported as "expected from crawl" rather than as gaps.
 */
const CRAWLABLE = new Set([
  'practice.name', 'practice.phone', 'practice.email', 'practice.domain',
  'address.street', 'address.city', 'address.state', 'address.zip',
  'hours', 'doctor.name', 'doctor.bio', 'doctor.credentials', 'doctor.education',
  'services.offered', 'images.team', 'images.office', 'images.gallery',
  'images.logo', 'practice.googleReviewLink', 'practice.sameAs',
  'content.faqs', 'content.testimonials', 'content.insurance',
]);

function label(sev) {
  return { critical: 'CRITICAL', important: 'IMPORTANT', optional: 'optional' }[sev];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.source && !opts.slug) {
    console.error('usage: node scripts/pipeline/check-readiness.js <intake.json|clients/slug> [--slug s] [--phase cold|deposit|full] [--json] [--strict]');
    process.exit(2);
  }
  if (!BLOCKING[opts.phase]) {
    console.error(`unknown phase "${opts.phase}" — expected cold, deposit or full`);
    process.exit(2);
  }

  // Accept a bare client dir as a convenience.
  let filePath = opts.source;
  if (filePath && !filePath.endsWith('.json')) {
    const candidate = resolve(filePath, 'intake.json');
    if (existsSync(candidate)) filePath = candidate;
  }

  let intake;
  try {
    intake = await loadIntake(
      filePath ? { filePath: resolve(filePath) } : { airtableSlug: opts.slug },
    );
  } catch (err) {
    console.error(`could not load intake: ${err.message}`);
    process.exit(2);
  }

  // The contract evaluates MERGED data. An intake alone is the same shape,
  // minus anything the crawl would add — which is exactly the question here.
  const { missing, satisfied } = evaluateDataFields(intake);
  const blocking = BLOCKING[opts.phase];

  const gaps = missing.filter(f => blocking.includes(f.severity));
  const hardGaps = gaps.filter(f => !(opts.phase === 'cold' && CRAWLABLE.has(f.path)));
  const crawlGaps = gaps.filter(f => opts.phase === 'cold' && CRAWLABLE.has(f.path));
  const softGaps = missing.filter(f => !blocking.includes(f.severity));

  const manual = manualAccessItems().filter(i =>
    accessItemsForPhase(opts.phase).some(p => p.id === i.id));

  if (opts.json) {
    console.log(JSON.stringify({
      phase: opts.phase,
      ready: hardGaps.length === 0,
      satisfied: satisfied.map(f => f.path),
      blocking: hardGaps.map(f => ({ path: f.path, label: f.label, severity: f.severity, intake: f.intake, hint: f.hint })),
      expectedFromCrawl: crawlGaps.map(f => f.path),
      advisory: softGaps.map(f => ({ path: f.path, label: f.label, severity: f.severity })),
      manualAccess: manual.map(i => ({ id: i.id, label: `${i.service} — ${i.label}`, owner: i.owner, leadTime: i.leadTime || null })),
    }, null, 2));
    process.exit(hardGaps.length ? 1 : 0);
  }

  const name = getPath(intake, 'practice.name') || opts.slug || '(unnamed practice)';
  console.log(`\nReadiness — ${name}  ·  phase: ${opts.phase}`);
  console.log(`${satisfied.length}/${DATA_FIELDS.length} contract fields present in intake\n`);

  if (hardGaps.length) {
    console.log(`BLOCKING (${hardGaps.length}) — the client must supply these:`);
    for (const f of hardGaps) {
      console.log(`  ✗ ${label(f.severity)}  ${f.label}`);
      console.log(`      ${f.hint}`);
      if (f.intake) console.log(`      intake: ${f.intake}`);
    }
    console.log('');
  }

  if (crawlGaps.length) {
    console.log(`Expected from the crawl (${crawlGaps.length}) — not in intake, the scrape should supply:`);
    console.log(`  ${crawlGaps.map(f => f.label).join(', ')}\n`);
  }

  if (softGaps.length) {
    console.log(`Advisory (${softGaps.length}) — will appear in the missing report:`);
    console.log(`  ${softGaps.map(f => f.label).join(', ')}\n`);
  }

  if (manual.length) {
    console.log('Access that cannot be automated — start these by hand:');
    for (const i of manual) {
      const lead = i.leadTime ? `  ⏱ ${i.leadTime}` : '';
      console.log(`  · ${i.service} — ${i.label}  [${i.owner}]${lead}`);
    }
    console.log('');
  }

  if (hardGaps.length) {
    console.log(`NOT READY for a ${opts.phase} build — ${hardGaps.length} blocking gap(s).\n`);
    process.exit(1);
  }
  console.log(`READY for a ${opts.phase} build.\n`);
  process.exit(opts.strict && softGaps.length ? 1 : 0);
}

main();
