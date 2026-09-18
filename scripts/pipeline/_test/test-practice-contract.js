#!/usr/bin/env node
/**
 * The practice contract must stay internally honest and in sync with the
 * things that read it.
 *
 * The whole point of the contract is that requirements stopped living in
 * four places that drifted. These assertions are what stops them drifting
 * again: the doc is a render of it, the intake template can express every
 * field it asks for, and nothing asks a client for something no code reads.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_FIELDS, ACCESS_ITEMS, SEVERITY, PHASE,
  evaluateDataFields, accessItemsForPhase, manualAccessItems, getPath,
} from '../standards/practice-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');

let failures = 0;
const ok = (n) => console.log(`  ✓ ${n}`);
const bad = (n, d) => { failures++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); };
const assert = (n, c, d) => (c ? ok(n) : bad(n, d));

console.log('practice contract');

// ── Shape ────────────────────────────────────────────────────────────────
assert('every data field has the required keys', DATA_FIELDS.every(f =>
  f.path && f.label && f.category && f.hint && SEVERITY.includes(f.severity)),
DATA_FIELDS.filter(f => !(f.path && f.label && f.category && f.hint && SEVERITY.includes(f.severity)))
  .map(f => f.path || f.label).join(', '));

assert('data field paths are unique', new Set(DATA_FIELDS.map(f => f.path)).size === DATA_FIELDS.length);

assert('every access item has the required keys', ACCESS_ITEMS.every(i =>
  i.id && i.service && i.label && PHASE.includes(i.phase) &&
  ['groundwork', 'client', 'shared'].includes(i.owner) &&
  typeof i.automatable === 'boolean' && i.note),
ACCESS_ITEMS.filter(i => !(i.id && i.service && i.label && PHASE.includes(i.phase))).map(i => i.id).join(', '));

assert('access item ids are unique', new Set(ACCESS_ITEMS.map(i => i.id)).size === ACCESS_ITEMS.length);

// A cold build runs unattended. If an item it needs cannot be automated,
// the harness cannot run cold — that is a contradiction worth catching.
assert('every cold-phase access item is automatable',
  ACCESS_ITEMS.filter(i => i.phase === 'cold').every(i => i.automatable),
  ACCESS_ITEMS.filter(i => i.phase === 'cold' && !i.automatable).map(i => i.id).join(', '));

// ── Evaluation ───────────────────────────────────────────────────────────
const empty = evaluateDataFields({});
assert('empty practice data fails every field',
  empty.missing.length === DATA_FIELDS.length && empty.satisfied.length === 0);

assert('empty data reports critical gaps', empty.bySeverity.critical.length > 0);

// Default hours are inserted silently by the merger, so a site can show a
// confident, wrong "9am – 5pm". Presence must not count as satisfaction.
const defaultHours = evaluateDataFields({
  hours: { display: [{ day: 'Monday', time: '9am – 5pm' }, { day: 'Tuesday', time: '9am – 5pm' }] },
});
assert('placeholder office hours do not satisfy the hours field',
  defaultHours.missing.some(f => f.path === 'hours'),
  'default 9-5 hours were accepted as real');

const realHours = evaluateDataFields({
  hours: { display: [{ day: 'Monday', time: '8am – 4pm' }] },
});
assert('real office hours satisfy the hours field',
  realHours.satisfied.some(f => f.path === 'hours'));

// Doctor identity arrives by several routes.
assert('doctor name is satisfied by doctors[]',
  evaluateDataFields({ doctors: [{ name: 'Dr. Ruiz' }] }).satisfied.some(f => f.path === 'doctor.name'));
assert('doctor name is satisfied by doctor.lastName',
  evaluateDataFields({ doctor: { lastName: 'Ruiz' } }).satisfied.some(f => f.path === 'doctor.name'));

assert('empty arrays do not satisfy a field',
  evaluateDataFields({ images: { team: [] } }).missing.some(f => f.path === 'images.team'));

// ── Phases ───────────────────────────────────────────────────────────────
assert('phase filtering is cumulative',
  accessItemsForPhase('full').length >= accessItemsForPhase('deposit').length &&
  accessItemsForPhase('deposit').length >= accessItemsForPhase('cold').length);
assert('cold phase excludes client-owned launch access',
  !accessItemsForPhase('cold').some(i => i.id === 'gbp-oauth'));
assert('manual items are exactly the non-automatable ones',
  manualAccessItems().every(i => !i.automatable) &&
  manualAccessItems().length === ACCESS_ITEMS.filter(i => !i.automatable).length);

// The long-lead items are the ones that actually sink launch dates, so the
// contract must keep saying so.
assert('long-lead access items declare a lead time',
  ACCESS_ITEMS.find(i => i.id === 'gbp-oauth')?.leadTime &&
  ACCESS_ITEMS.find(i => i.id === 'gsc')?.leadTime);

// ── Sync with consumers ──────────────────────────────────────────────────
const intakeTemplate = JSON.parse(
  await readFile(resolve(ROOT, 'docs/onboarding/intake-template.json'), 'utf-8'));

const missingFromTemplate = DATA_FIELDS
  .filter(f => f.intake)
  .filter(f => getPath(intakeTemplate, f.intake) === undefined);
assert('every intake path in the contract exists in the intake template',
  missingFromTemplate.length === 0,
  missingFromTemplate.map(f => f.intake).join(', '));

try {
  execFileSync('node', [resolve(ROOT, 'scripts/pipeline/standards/render-onboarding.js'), '--check'],
    { stdio: 'pipe' });
  ok('ONBOARDING.md is a current render of the contract');
} catch (err) {
  bad('ONBOARDING.md is a current render of the contract',
    'run scripts/pipeline/standards/render-onboarding.js');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exit(failures ? 1 : 0);
