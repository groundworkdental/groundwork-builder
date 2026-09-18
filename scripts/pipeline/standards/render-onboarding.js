#!/usr/bin/env node
/**
 * Render the collection checklist in ONBOARDING.md from the practice contract.
 *
 * Phase 2 of the onboarding doc used to be a hand-maintained list that said
 * roughly, but not exactly, what the pipeline enforced — which is how the
 * form came to ask for a booking URL and five social links that the code
 * silently discarded. The doc is now a VIEW of the contract, so the two
 * cannot disagree.
 *
 * The generated block sits between the markers below. Everything outside
 * them (the call scripts, the phase narrative) stays hand-written.
 *
 *   node scripts/pipeline/standards/render-onboarding.js         # write
 *   node scripts/pipeline/standards/render-onboarding.js --check # CI: is it stale?
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_FIELDS, ACCESS_ITEMS } from './practice-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(__dirname, '..', '..', '..', 'docs', 'onboarding', 'ONBOARDING.md');

const BEGIN = '<!-- BEGIN GENERATED: practice-contract -->';
const END = '<!-- END GENERATED: practice-contract -->';

const SEVERITY_NOTE = {
  critical: 'Must have — the site cannot launch without it.',
  important: 'Needed before a client launch; a cold preview can ship without it.',
  optional: 'Better with it; correct without it.',
};

const PHASE_TITLE = {
  cold: 'Cold build — Groundwork credentials only, no client contact',
  deposit: 'After the $500 deposit — moving to their infrastructure',
  full: 'After full payment — ownership transfer',
};

function renderDataFields() {
  const out = [];
  out.push('#### What to collect from the practice', '');
  out.push('Generated from `scripts/pipeline/standards/practice-contract.js` — do not edit by hand.');
  out.push('Everything here feeds `intake.json`. Run `check-readiness.js` against it before building.', '');

  // Group by category, preserving contract order.
  const byCategory = new Map();
  for (const f of DATA_FIELDS) {
    if (!byCategory.has(f.category)) byCategory.set(f.category, []);
    byCategory.get(f.category).push(f);
  }

  for (const [category, fields] of byCategory) {
    out.push(`**${category}**`, '');
    out.push('| | Field | Intake key | What to ask for |');
    out.push('|---|---|---|---|');
    for (const f of fields) {
      const mark = f.severity === 'critical' ? '**must**'
        : f.severity === 'important' ? 'should' : 'nice';
      const key = f.intake ? `\`${f.intake}\`` : '_from crawl_';
      out.push(`| ${mark} | ${f.label} | ${key} | ${f.hint} |`);
    }
    out.push('');
  }

  out.push('Severity: ');
  for (const [sev, note] of Object.entries(SEVERITY_NOTE)) {
    out.push(`- **${sev}** — ${note}`);
  }
  out.push('');
  return out;
}

function renderAccess() {
  const out = [];
  out.push('#### Accounts and access', '');
  out.push('Permissions, not passwords — you never need their Google password.', '');

  for (const phase of ['cold', 'deposit', 'full']) {
    const items = ACCESS_ITEMS.filter(i => i.phase === phase);
    if (!items.length) continue;
    out.push(`**${PHASE_TITLE[phase]}**`, '');
    out.push('| Service | What | Whose account | Automatable | Notes |');
    out.push('|---|---|---|---|---|');
    for (const i of items) {
      const auto = i.automatable ? 'yes' : '**no — by hand**';
      const lead = i.leadTime ? ` ⏱ _${i.leadTime}._` : '';
      const doc = i.doc ? ` See \`${i.doc}\`.` : '';
      out.push(`| ${i.service} | ${i.label} | ${i.owner} | ${auto} | ${i.note}${lead}${doc} |`);
    }
    out.push('');
  }

  const longPole = ACCESS_ITEMS.filter(i => i.leadTime);
  if (longPole.length) {
    out.push('> **Start these at kickoff, not at launch.** They are blocked on someone else\'s calendar:');
    for (const i of longPole) {
      out.push(`> - **${i.service}** — ${i.leadTime}`);
    }
    out.push('');
  }
  return out;
}

function renderBlock() {
  return [BEGIN, '', ...renderDataFields(), ...renderAccess(), END].join('\n');
}

async function main() {
  const check = process.argv.includes('--check');
  const doc = await readFile(DOC, 'utf-8');

  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    console.error(
      `ONBOARDING.md has no generated block.\nAdd these markers around the Phase 2 checklist:\n  ${BEGIN}\n  ${END}`,
    );
    process.exit(2);
  }

  const next = doc.slice(0, start) + renderBlock() + doc.slice(end + END.length);

  if (check) {
    if (next !== doc) {
      console.error(
        'ONBOARDING.md is stale — the practice contract has changed.\n' +
          'Run: node scripts/pipeline/standards/render-onboarding.js',
      );
      process.exit(1);
    }
    console.log('ONBOARDING.md is in sync with the practice contract.');
    return;
  }

  await writeFile(DOC, next, 'utf-8');
  console.log(`Rendered ${DATA_FIELDS.length} data fields and ${ACCESS_ITEMS.length} access items into ONBOARDING.md`);
}

main();
