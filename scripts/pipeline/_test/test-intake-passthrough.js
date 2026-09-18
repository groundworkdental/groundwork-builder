#!/usr/bin/env node
/**
 * Intake pass-through: fields the client gave us must reach the merged data.
 *
 * The intake template has always asked for a booking URL, five social
 * profile URLs and a financing list. normalizeIntake() read none of them,
 * so a practice could answer every question on the form and still ship a
 * site with no booking link and an empty schema sameAs[] — silently,
 * because the missing-report then blamed the practice for not providing
 * social profiles they had in fact provided.
 *
 * These assertions are about the CONTRACT, not the transport: whatever the
 * intake collects must be reachable downstream, or it should not be on the
 * form. No API calls.
 */

import { mergeData, INTAKE_OVERRIDE_PATHS } from '../lib/merger.js';
import { loadIntake } from '../lib/intake.js';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); };
const assert = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));

// A practice that answered the intake form completely.
const INTAKE = {
  practice: {
    name: 'Cedar Park Family Dental',
    phone: '(512) 555-0142',
    email: 'hello@cedarparkfamily.com',
    domain: 'cedarparkfamily.com',
    bookingUrl: 'https://booking.nexhealth.com/cedar-park',
    sameAs: [
      'https://facebook.com/cedarparkfamily',
      'https://instagram.com/cedarparkfamily',
    ],
  },
  content: {
    insurance: ['Delta Dental', 'Cigna'],
    financing: ['CareCredit', 'In-house membership plan'],
    faqs: [], testimonials: [], additionalContent: [],
  },
  differentiators: [],
};

// Silver as the scraper would return it when the practice's site is thin:
// it found the Google profile but nothing else.
const silverWithGoogle = () => ({
  practice: {
    name: null, phone: null, email: null, domain: 'cedarparkfamily.com',
    bookingUrl: null,
    sameAs: ['https://g.page/cedarparkfamily'],
  },
  address: {}, hours: {}, doctors: [], doctor: {},
  services: { offered: [] }, content: {}, images: {}, brand: {},
  differentiators: [],
});

console.log('intake pass-through');

// ── The normalizer: raw intake-template shape → PracticeData ──────────────
// This is where the fields were being dropped, so it is tested against the
// form's own key names (scheduling_url, social{}, insurance_financing) and
// not against the normalized shape the rest of this file uses.
const dir = await mkdtemp(join(tmpdir(), 'gw-intake-'));
const file = join(dir, 'intake.json');
await writeFile(file, JSON.stringify({
  practice_info: { practice_name: 'Cedar Park Family Dental', phone: '(512) 555-0142' },
  insurance_financing: { plans: ['Delta Dental'], financing: ['CareCredit'] },
  content: {
    scheduling_url: 'https://booking.nexhealth.com/cedar-park',
    social: {
      facebook: 'https://facebook.com/cedarparkfamily',
      instagram: 'https://instagram.com/cedarparkfamily',
      yelp: '',                    // left blank on the form
      healthgrades: 'not-a-url',   // typed junk
    },
  },
}), 'utf-8');

const normalized = await loadIntake(file);
await rm(dir, { recursive: true, force: true });

assert(
  'normalizer reads content.scheduling_url',
  normalized.practice?.bookingUrl === 'https://booking.nexhealth.com/cedar-park',
  `got ${JSON.stringify(normalized.practice?.bookingUrl)}`,
);
assert(
  'normalizer flattens content.social into sameAs',
  ['https://facebook.com/cedarparkfamily', 'https://instagram.com/cedarparkfamily']
    .every(u => (normalized.practice?.sameAs || []).includes(u)),
  `got ${JSON.stringify(normalized.practice?.sameAs)}`,
);
assert(
  'normalizer drops blank and malformed social values',
  (normalized.practice?.sameAs || []).length === 2,
  `got ${JSON.stringify(normalized.practice?.sameAs)}`,
);
assert(
  'normalizer reads insurance_financing.financing',
  (normalized.content?.financing || []).includes('CareCredit'),
  `got ${JSON.stringify(normalized.content?.financing)}`,
);

// ── The merger: PracticeData + silver → merged ────────────────────────────
const merged = mergeData(silverWithGoogle(), INTAKE);

assert(
  'booking URL reaches merged data',
  merged.practice?.bookingUrl === INTAKE.practice.bookingUrl,
  `got ${JSON.stringify(merged.practice?.bookingUrl)}`,
);

assert(
  'booking URL is an intake override path',
  INTAKE_OVERRIDE_PATHS.includes('practice.bookingUrl'),
  'a value the practice states must beat a scraped guess',
);

const sameAs = merged.practice?.sameAs || [];
assert(
  'intake social URLs reach merged data',
  INTAKE.practice.sameAs.every(u => sameAs.includes(u)),
  `got ${JSON.stringify(sameAs)}`,
);
assert(
  'scraped social URLs are not clobbered by intake',
  sameAs.includes('https://g.page/cedarparkfamily'),
  'sameAs is a union, not a replacement',
);
assert(
  'sameAs has no duplicates',
  new Set(sameAs).size === sameAs.length,
  JSON.stringify(sameAs),
);

assert(
  'financing reaches merged data',
  Array.isArray(merged.content?.financing) &&
    merged.content.financing.includes('CareCredit'),
  `got ${JSON.stringify(merged.content?.financing)}`,
);

// Absent intake values must not invent empty state downstream.
const emptyMerged = mergeData(silverWithGoogle(), {
  practice: {}, content: {}, differentiators: [],
});
assert(
  'no booking URL stays null rather than empty string',
  emptyMerged.practice?.bookingUrl == null,
  `got ${JSON.stringify(emptyMerged.practice?.bookingUrl)}`,
);
assert(
  'scraped sameAs survives an empty intake',
  (emptyMerged.practice?.sameAs || []).includes('https://g.page/cedarparkfamily'),
  `got ${JSON.stringify(emptyMerged.practice?.sameAs)}`,
);

console.log(
  failures
    ? `\n${failures} assertion(s) failed`
    : '\nall assertions passed',
);
process.exit(failures ? 1 : 0);
