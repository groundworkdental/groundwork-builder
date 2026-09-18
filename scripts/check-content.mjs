#!/usr/bin/env node
/**
 * check-content.mjs — spelling and placeholder gate for a practice site.
 *
 * Two passes, wired around the build:
 *
 *   node scripts/check-content.mjs            # source: American English
 *   astro build
 *   node scripts/check-content.mjs --built    # dist: no placeholders survived
 *
 * The passes deliberately read different trees.
 *
 *   Spelling is a property of what we WROTE, so it reads source — including
 *   comments and CSS, because model-written copy drifts into British
 *   spellings unprompted, and four survived a shipped build unnoticed: one a
 *   component comment, two in global.css.
 *
 *   Placeholders are a property of what we SHIPPED. The rule is that they
 *   must not survive into output, not that source may never mention them. A
 *   README documents [DOMAIN] as a thing to replace, and [city].astro is a
 *   route parameter — scanning source flags both and teaches everyone to
 *   ignore the check.
 *
 * Every exclusion below is a false positive that was actually hit. A check
 * that cries wolf gets deleted, and then it catches nothing.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// British → American
// ---------------------------------------------------------------------------

/**
 * Each entry is [pattern, replacement], applied to the whole word so the fix
 * is obvious in the report.
 *
 * The plain roots are matched INSIDE words on purpose: `\bcolour\b` misses
 * `watercolour` and `discoloured`, which is exactly what it missed on the
 * build that prompted this file. No American word contains any of them.
 *
 * The -ise family is different and needs a suffix guard, because the bare
 * root appears inside correct American words — `optimistic`, `specialist`,
 * `organism`. Only the verb endings are British.
 */
const ROOTS = [
  [/colour/gi, 'color'],
  [/flavour/gi, 'flavor'],
  [/behaviour/gi, 'behavior'],
  [/honour/gi, 'honor'],
  [/favour/gi, 'favor'],
  [/neighbour/gi, 'neighbor'],
  [/labour/gi, 'labor'],
  [/catalogue/gi, 'catalog'],
  [/programme/gi, 'program'],
  [/defence/gi, 'defense'],
  [/offence/gi, 'offense'],
  [/fibre/gi, 'fiber'],
  [/litre/gi, 'liter'],
  [/metre/gi, 'meter'],
  [/theatre/gi, 'theater'],
  [/travelling/gi, 'traveling'],
  [/modelling/gi, 'modeling'],
  [/labelled/gi, 'labeled'],
  [/skilful/gi, 'skillful'],
  [/instalment/gi, 'installment'],
  [/jewellery/gi, 'jewelry'],
  [/moulding/gi, 'molding'],
  [/storey/gi, 'story'],
  [/whilst/gi, 'while'],
  [/aluminium/gi, 'aluminum'],
  [/\benrol\b/gi, 'enroll'],
  [/\bfulfil\b/gi, 'fulfill'],

  // Clinical spellings — where a dental site actually gets caught.
  [/anaesthe/gi, 'anesthe'],
  [/paediatric/gi, 'pediatric'],
  [/orthopaedic/gi, 'orthopedic'],
  [/oesophag/gi, 'esophag'],
  [/haemo/gi, 'hemo'],
  [/foetal/gi, 'fetal'],

  // -ise family, suffix-guarded.
  [/organis(e|ed|es|ing|ation|ations|ational|er|ers)\b/gi, 'organiz$1'],
  [/recognis(e|ed|es|ing|able|ably)\b/gi, 'recogniz$1'],
  [/optimis(e|ed|es|ing|ation|ations)\b/gi, 'optimiz$1'],
  [/specialis(e|ed|es|ing|ation)\b/gi, 'specializ$1'],
  [/personalis(e|ed|es|ing|ation)\b/gi, 'personaliz$1'],
  [/minimis(e|ed|es|ing|ation)\b/gi, 'minimiz$1'],
  [/maximis(e|ed|es|ing|ation)\b/gi, 'maximiz$1'],
  [/analys(e|ed|es|ing)\b/gi, 'analyz$1'],
];

/**
 * Deliberately NOT checked, and listed so nobody adds them back.
 *
 * `practise`, `licence` and `centre` have legitimate American uses or turn up
 * in proper nouns — a practice named "Smile Centre", a licence board page.
 * `grey`, `cancelled`, `dialogue` and `toward` are accepted in American
 * usage. Flagging any of them produces false positives, and a check that
 * reports false positives gets deleted.
 */
const NOT_CHECKED = ['practise', 'licence', 'centre', 'dialogue', 'grey', 'cancelled', 'toward'];

// ---------------------------------------------------------------------------
// Placeholders (built output only)
// ---------------------------------------------------------------------------

const PLACEHOLDERS = [
  ['bracketed token', /\[(DOMAIN|PRACTICE_NAME|PHONE|EMAIL|ADDRESS|CITY|STATE|ZIP|SLUG)\]/],
  ['sample locality', /\bSample City\b|\bAnytown\b/],
  ['scaffold domain', /\bexample\.com\b/],
  ['unreplaced mustache', /\{\{[^}]{1,60}\}\}/],
  ['placeholder analytics id', /G-X{4,}/],
];

// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.astro', '.wrangler', '_pipeline',
  '_memory', '_audits', '_sourcing', 'clients', 'coverage', '_references',
]);

const SOURCE_EXT = new Set(['.astro', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.md']);
const BUILT_EXT = new Set(['.html', '.txt', '.xml', '.json']);

async function walk(dir, keep, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(full, keep, out);
    } else if (keep(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Backticks mark a word as a specimen rather than a usage.
 *
 * Documentation has to be able to name a wrong spelling in order to forbid
 * it — this file does exactly that. Spans are blanked rather than removed so
 * reported line numbers still match the file on disk.
 */
function maskCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

function scanSpelling(text, isMarkdown) {
  const lines = (isMarkdown ? maskCode(text) : text).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const [pattern, replacement] of ROOTS) {
      // A separate non-global regex for the substitution. Calling .replace()
      // with `pattern` itself mutates its lastIndex mid-iteration, which turns
      // the loop below into an infinite one.
      const single = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(lines[i])) !== null) {
        // Widen to the whole word so the suggested fix is directly usable.
        const before = lines[i].slice(0, m.index).match(/[A-Za-z]*$/)?.[0] ?? '';
        const after = lines[i].slice(m.index + m[0].length).match(/^[A-Za-z]*/)?.[0] ?? '';
        hits.push({
          line: i + 1,
          found: before + m[0] + after,
          fixed: before + m[0].replace(single, replacement) + after,
        });
        if (m[0].length === 0) pattern.lastIndex++;   // guard against zero-width
      }
    }
  }
  return hits;
}

function scanPlaceholders(text) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const [label, re] of PLACEHOLDERS) {
      const m = lines[i].match(re);
      if (m) hits.push({ line: i + 1, found: m[0], label });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------

async function main() {
  const built = process.argv.includes('--built');
  const failures = [];
  let scanned = 0;

  if (built) {
    const files = await walk(join(ROOT, 'dist'), (f) => BUILT_EXT.has(extname(f)));
    if (!files.length) {
      console.error('check-content --built: no dist/ output found — build first');
      process.exit(2);
    }
    for (const f of files) {
      scanned++;
      for (const h of scanPlaceholders(await readFile(f, 'utf8'))) {
        failures.push(`${relative(ROOT, f)}:${h.line}  ${h.label}: ${h.found}`);
      }
    }
    report('placeholders in built output', scanned, failures,
      'A placeholder that reaches dist/ reaches a patient and a crawler.');
    return;
  }

  // Source pass: src/, plus root markdown. Root markdown matters — two
  // Briticisms were hiding in GENERATOR-NOTES.md itself.
  const rootMd = (await readdir(ROOT, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(ROOT, e.name));

  const files = [
    ...await walk(join(ROOT, 'src'), (f) => SOURCE_EXT.has(extname(f))),
    ...rootMd,
  ];

  for (const f of files) {
    scanned++;
    const text = await readFile(f, 'utf8');
    for (const h of scanSpelling(text, extname(f) === '.md')) {
      failures.push(`${relative(ROOT, f)}:${h.line}  "${h.found}" → "${h.fixed}"`);
    }
  }
  report('American English', scanned, failures,
    `Not checked, on purpose: ${NOT_CHECKED.join(', ')}.`);
}

function report(label, scanned, failures, note) {
  if (failures.length) {
    console.error(`\n✗ ${label} — ${failures.length} issue(s) across ${scanned} file(s)\n`);
    for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
    if (failures.length > 40) console.error(`  … +${failures.length - 40} more`);
    console.error(`\n${note}\n`);
    process.exit(1);
  }
  console.log(`✓ ${label} — ${scanned} file(s) clean`);
}

main();
