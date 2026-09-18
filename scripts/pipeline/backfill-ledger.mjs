#!/usr/bin/env node
/**
 * Seed client_events with the history that already happened.
 *
 * A ledger that starts empty teaches nobody anything, and the first real
 * question anyone asks it — "what has happened to this practice?" — has a
 * genuine answer already: twelve rules came out of the Mansfield build, and
 * two dozen merged PRs are where they went.
 *
 * Backfilled rows carry actor 'backfill' so they are distinguishable from
 * anything logged live, and occurred_at is the date the work actually landed
 * rather than the date this ran.
 *
 * Idempotent: every row has a deterministic source_ref, and an existing
 * source_ref is skipped. Safe to re-run.
 *
 *   node --env-file=.env scripts/pipeline/backfill-ledger.mjs [--dry-run]
 */

import { logEvent, d1Enabled } from './lib/events.js';
import { d1Query } from './lib/d1.js';

const PLATFORM = '_platform';   // reserved slug: work that belongs to no one client

/**
 * The twelve rules from the Mansfield audit, and where each one landed.
 *
 * These are `change` events on mansfielddds because that is where the defect
 * was found — and systemic, because every one of them was generalised into
 * the builder rather than fixed once. routed_to is the gate or PR that
 * adopted it, which is what makes the loop auditable: a rule cannot be
 * "done" without somewhere to point.
 */
const RULES = [
  [1, 'Never ship a claim the build cannot verify', 'BeforeAfter provenance — required union prop, no default', 54],
  [2, 'Emit no reference to an asset that does not exist', 'verify-launch → asset references', 53],
  [3, 'Generate derived text files, do not template them', 'verify-launch → agent files', 56],
  [4, 'One config, and pages must not bypass it', 'verify-launch → config bypass', 69],
  [5, 'Degrade gracefully, then light up in one place', 'verify-launch → conditional copy', 69],
  [6, 'tel: from digits, schema in E.164', 'verify-launch → tel links; site.phoneE164', 52],
  [7, 'Attribution hook on every conversion link', 'data-*-location in Header, Footer, CTABlock', 56],
  [8, 'Required media needs a component', 'ServiceMedia.astro — required provenance and alt', 56],
  [9, 'Preview hostnames noindex from the first build', 'BaseLayout reads CF_PAGES_BRANCH', 56],
  [10, 'Deploy scripts name an account, not just a project', 'audit-client-zone.js reports the serving project', 50],
  [11, 'No empty auto-stubs in the section map', 'verify-launch → placeholders (shape matching)', 49],
  [12, 'Meta descriptions must not be truncated mid-word', 'verify-launch → meta descriptions', 53],
];

/** Findings from the GBP verification pass, same shape. */
const GBP_FINDINGS = [
  ['Listing had no reviewable intended state — every fact lived only in Google',
   'src/config/gbp.ts + verify-launch → gbp consistency', 71],
  ['personSchemas asserted worksFor at the practice address for a doctor whose bio places him in another state',
   'verify-launch → provider affiliation', 71],
  ['intake.json shipped in the client repo, stale, naming the wrong primary doctor',
   'verify-launch → generator leakage', 70],
  ['README described a docs tree that exists only in the generator — every relative link dead',
   'verify-launch → generator leakage', 70],
  ['British spellings survived into a shipped build, including global.css',
   'scripts/check-content.mjs', 70],
];

/** Infrastructure PRs — real work, but not attributable to a practice. */
const PLATFORM_PRS = [
  [51, 'Decouple report hosting from the marketing repo'],
  [55, 'Stop dropping intake fields the client filled in'],
  [58, 'Point the GitHub owner at groundworkdental'],
  [59, 'Land the pipeline modules main already imports'],
  [60, 'Add the practice contract: one declaration of what a build needs'],
  [61, 'Port real blog posts verbatim instead of rewriting them'],
  [62, 'Return a bodiless 204 for the lead-capture preflight'],
  [63, 'Export formatNarrative so the pipeline entry points load'],
  [64, 'Report contract readiness during the build'],
  [65, 'Land the generator quality fixes and re-register their suite'],
  [66, 'Land the remaining pipeline work from the working tree'],
  [67, 'Land the architect skill, eval-batch and the docs that describe them'],
  [68, 'Stop tracking per-run caches, land the new design library entries'],
  [72, 'Add the client ledger: one timeline per practice'],
];

const REPO = 'https://github.com/groundworkdental/groundwork-builder/pull';
const AUDIT_DAY = '2026-09-18T09:00:00.000Z';
const GBP_DAY = '2026-09-18T15:00:00.000Z';
const PLATFORM_DAY = '2026-09-18T12:00:00.000Z';

async function existingRefs() {
  const rows = await d1Query(`SELECT source_ref FROM client_events WHERE source_ref IS NOT NULL`);
  return new Set(rows.map((r) => r.source_ref));
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  if (!d1Enabled()) {
    console.error('D1 not configured — run with --env-file=.env');
    process.exit(2);
  }

  const seen = dry ? new Set() : await existingRefs();
  let written = 0;
  let skipped = 0;

  const emit = async (row) => {
    if (seen.has(row.sourceRef)) { skipped++; return; }
    if (dry) { console.log(`  + ${row.slug.padEnd(14)} ${row.kind.padEnd(13)} ${row.summary.slice(0, 72)}`); written++; return; }
    await logEvent({ ...row, actor: 'backfill' });
    written++;
  };

  console.log('\nMansfield audit — twelve rules, each generalised into the builder\n');
  for (const [n, rule, landed, pr] of RULES) {
    await emit({
      slug: 'mansfielddds',
      kind: 'change',
      summary: `Rule ${n}: ${rule}`,
      detail: `Found in the manual audit of the shipped site. Adopted as: ${landed}.`,
      sourceRef: `generator-rule-${n}`,
      systemic: 'yes',
      routedTo: `${REPO}/${pr}`,
      occurredAt: AUDIT_DAY,
    });
  }

  console.log('\nGBP verification pass\n');
  for (const [i, [finding, landed, pr]] of GBP_FINDINGS.entries()) {
    await emit({
      slug: 'mansfielddds',
      kind: 'change',
      summary: finding,
      detail: `Adopted as: ${landed}.`,
      sourceRef: `gbp-finding-${i + 1}`,
      systemic: 'yes',
      routedTo: `${REPO}/${pr}`,
      occurredAt: GBP_DAY,
    });
  }

  console.log('\nPlatform work\n');
  for (const [pr, title] of PLATFORM_PRS) {
    await emit({
      slug: PLATFORM,
      kind: 'change',
      summary: title,
      sourceRef: `${REPO}/${pr}`,
      systemic: 'no',           // this IS the systemic fix, not a client defect
      occurredAt: PLATFORM_DAY,
    });
  }

  console.log(
    `\n${dry ? 'would write' : 'wrote'} ${written} event(s)` +
    (skipped ? `, skipped ${skipped} already present` : '') + '\n',
  );
}

main().catch((err) => { console.error(err.message); process.exit(1); });
