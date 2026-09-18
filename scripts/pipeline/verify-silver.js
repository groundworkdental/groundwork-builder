#!/usr/bin/env node
/**
 * verify-silver.js — deterministic bronze→silver extraction fidelity.
 *
 * The pipeline had instrumentation on every layer except this one. Crawl
 * coverage is reported (nav hit-rate, budget skips), plan quality is reported
 * (disposition ledger, scoring), and the built site has 18 assertions in
 * verify-build.js. Between bronze and silver there was nothing but the model's
 * own confidence flags — so extraction loss was invisible by construction, and
 * the one bug that did surface there (`staff-loss`: people inferred from image
 * filenames) was found by hand.
 *
 * Every check below is anchored to a loss actually observed in the artifacts:
 *
 *   stale silver schema     9 of 10 client 01-scrape.json files on disk were
 *                           still the pre-fix curated subset (pagesVisited /
 *                           servicesDetected / signals, singular `doctor`, no
 *                           pageInventory). `--skip-scrape` reloads that file,
 *                           so those resumes silently rebuilt a worse site.
 *   additionalContent path  the verbatim-prose rescue lands at
 *                           content.additionalContent; readers looking at the
 *                           top level saw an empty array.
 *   dropped FAQ section     arts-family /dental-implants.html — 4140 words, an
 *                           explicit "Dental Implant FAQs" block, 10 `?`
 *                           headings — contributed zero FAQs, on the reference
 *                           site that scores 18/18 on verify-build.
 *   provider coverage       the `staff-loss` class: a bronze /dr-* bio page
 *                           with no corresponding silver doctor. provider-
 *                           filter.js drops "weak" doctors and some are real.
 *   service provenance      services.offered[].source grounds Content Write;
 *                           the schema defaults it to the literal 'scrape',
 *                           which reads like a path and isn't one.
 *   silent pass failure     passes are isolated — a thrown pass merges an empty
 *                           slice and the run still reports success.
 *
 * Three outcomes, not two. A check whose evidence is absent from bronze reports
 * `⊘ unmeasurable` and does not count as a pass: silver having no testimonials
 * is only a defect if bronze actually had review prose to lose, and scoring the
 * unknowable as clean is how a gap stays invisible.
 *
 * No AI, no network, runs in about a second.
 *
 *   node scripts/pipeline/verify-silver.js clients/<slug> [clients/<slug> ...]
 */

import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { isBlogPath } from './lib/crawl-select.js';

// A dedicated bio page: the provider passes treat these as ground truth, so
// every one of them should surface a person.
const BIO_PATH = /\/(meet[-_]?dr[-_]|dr[-_][a-z])/i;
// Non-doctor team roles. Used only as *evidence that staff exist* in bronze.
const STAFF_ROLE = /\b(hygienist|dental assistant|treatment coordinator|office manager|receptionist|financial coordinator|scheduling coordinator|practice manager|sterilization|front desk)\b/i;
const FAQ_MARKER = /frequently\s+asked|\bFAQs?\b/i;
// Named carriers — evidence that an insurance page actually lists plans rather
// than only describing payment policy.
const CARRIER = /\b(delta dental|aetna|cigna|metlife|guardian|blue cross|blue shield|bcbs|unitedhealth(care)?|humana|ameritas|principal|anthem|careington|dentemax|assurant|tricare|medicaid|chip|dentaquest|united concordia|lincoln financial|sun life|geha|mutual of omaha)\b/i;
// Fallback ceiling for artifacts written before the cap was recorded in meta.
// The cap now scales with the pages the content pass reads, so anything current
// reports its own — a constant here would measure headroom against the wrong
// number the moment the prompt changed.
const AC_CAP_LEGACY = 12;
const DAY = /\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/i;
const TIME = /\d{1,2}(:\d{2})?\s*(am|pm)/i;

const results = [];
const pass = (name, detail = '') => results.push({ state: 'pass', name, detail });
const fail = (name, detail) => results.push({ state: 'fail', name, detail });
/** Evidence for this check is absent from bronze — explicitly not a pass. */
const na = (name, detail) => results.push({ state: 'na', name, detail });

/** Both artifacts are wrapped as { step, timestamp, output }. Read through it. */
const unwrap = (raw) => raw?.output ?? raw;
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const norm = (p) => String(p || '').replace(/\/+$/, '') || '/';
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Question-shaped H2/H3 headings — the FAQ signal bronze actually carries. */
const questionHeadings = (page) =>
  (page.headings || []).filter(h => (h.level === 2 || h.level === 3) && /\?\s*$/.test(h.text || ''));

// ---------------------------------------------------------------------------
// 1. Schema generation — is this the full silver object or the old subset?
// ---------------------------------------------------------------------------

function checkSchema(silver) {
  // Keys that only exist in the post-fix full silver object.
  const required = ['doctors', 'staff', 'pageInventory', 'navigation', 'migration'];
  const absent = required.filter(k => silver[k] === undefined);
  // Keys that only ever existed in the old curated subset.
  const legacy = ['pagesVisited', 'servicesDetected', 'signals'].filter(k => silver[k] !== undefined);

  if (absent.length) {
    return fail('silver schema',
      `missing ${absent.join(', ')}${legacy.length ? ` · legacy keys present (${legacy.join(', ')})` : ''}` +
      ' — pre-fix curated subset; --skip-scrape would rebuild from this');
  }
  if (legacy.length) {
    return fail('silver schema', `legacy subset keys alongside full schema: ${legacy.join(', ')}`);
  }
  pass('silver schema', `full object (${required.length}/${required.length} structural keys)`);
}

// ---------------------------------------------------------------------------
// 2. additionalContent landing path
// ---------------------------------------------------------------------------

function checkAdditionalContent(silver) {
  const nested = silver.content?.additionalContent;
  if (!Array.isArray(nested)) {
    return fail('additionalContent path',
      `content.additionalContent is ${nested === undefined ? 'absent' : typeof nested}` +
      `${Array.isArray(silver.additionalContent) ? ' while a top-level array exists — readers of content.* get nothing' : ''}`);
  }
  // A top-level copy is not itself wrong, but it is where the value used to get
  // stranded; say so rather than letting the nested array alone imply health.
  const stray = Array.isArray(silver.additionalContent) && silver.additionalContent.length !== nested.length;
  stray
    ? fail('additionalContent path', `content.* has ${nested.length} but top-level has ${silver.additionalContent.length} — two disagreeing copies`)
    : pass('additionalContent path', `${nested.length} block(s) at content.additionalContent`);

  // Five of the six sites first measured landed on exactly 12 — the flat cap in
  // prompts/content.md — which means the cap, not the site, decided how much
  // verbatim prose survived. What sat past the ceiling is unknowable from the
  // artifacts, so saturation is reported, never scored clean.
  const cap = silver.meta?.additionalContentCap;
  if (!cap) {
    return nested.length >= AC_CAP_LEGACY
      ? na('additionalContent headroom', `${nested.length} blocks and no cap recorded — pre-dates meta.additionalContentCap, so whether the ceiling was binding cannot be determined`)
      : pass('additionalContent headroom', `${nested.length} blocks, under the legacy ceiling of ${AC_CAP_LEGACY}`);
  }
  nested.length >= cap
    ? na('additionalContent headroom', `${nested.length} blocks — at this run's cap of ${cap}; an unknown amount of distinctive prose was left behind`)
    : pass('additionalContent headroom', `${nested.length}/${cap} blocks, cap not binding`);
}

// ---------------------------------------------------------------------------
// 3. pageInventory completeness + blog exclusion
// ---------------------------------------------------------------------------

function checkPageInventory(bronze, silver, refPages) {
  const inv = silver.pageInventory;
  if (!Array.isArray(inv)) return fail('pageInventory', 'absent — Content Map and Content Write run unprompted');

  const leaked = inv.filter(p => isBlogPath(p.path));
  if (leaked.length) {
    return fail('pageInventory', `${leaked.length} blog page(s) leaked in (blog is held for verbatim migration): ${leaked.slice(0, 3).map(p => p.path).join(', ')}`);
  }
  const invPaths = new Set(inv.map(p => norm(p.path)));
  const dropped = refPages.filter(p => !invPaths.has(norm(p.path)));
  dropped.length
    ? fail('pageInventory', `${dropped.length}/${refPages.length} reference page(s) absent: ${dropped.slice(0, 4).map(p => p.path).join(', ')}`)
    : pass('pageInventory', `${inv.length}/${refPages.length} reference pages, no blog leak`);
}

// ---------------------------------------------------------------------------
// 4. Provider coverage — every dedicated bio page yields a person
// ---------------------------------------------------------------------------

/**
 * Named-provider evidence in bronze. Headings, not body text: the providers
 * pass keys off /\bDr\.\s+[A-Z]/ over bodyText, which matches street
 * abbreviations — "Ledbetter Dr. Lombardy Ln." on bearcreek selected a page
 * that names no physician at all. Headings carry the real bylines.
 */
function namedProviderEvidence(refPages, practiceName) {
  const names = new Set();
  const pages = new Set();
  for (const p of refPages) {
    for (const h of (p.headings || [])) {
      for (const m of (h.text || '').matchAll(/\bDr\.?\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?/g)) {
        names.add(m[0].trim()); pages.add(p.path);
      }
    }
    for (const item of (p.structuredData || [])) {
      const t = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      // Practice-level Dentist/LocalBusiness LD carries the practice name, not
      // a person's; only count a Person whose name differs from the practice.
      if (t.some(x => /^Person$/i.test(String(x))) && item.name && key(item.name) !== key(practiceName)) {
        names.add(item.name); pages.add(p.path);
      }
    }
  }
  return { names: [...names], pages: [...pages] };
}

function checkDoctors(silver, refPages) {
  const bioPages = refPages.filter(p => BIO_PATH.test(p.path));
  const doctors = Array.isArray(silver.doctors) ? silver.doctors : [];
  const evidence = namedProviderEvidence(refPages, silver.practice?.name);

  // Zero providers is the loudest possible extraction loss and must never pass
  // quietly. Note the count of heading names is not comparable to the count of
  // doctors — azortho's "Dr. Jae Hyun" and "Dr. Jae Park" are one person, and
  // lbpds names one doctor in headings while the team page yields four. Only
  // presence versus absence of evidence is sound.
  if (!doctors.length) {
    if (bioPages.length) {
      return fail('doctor coverage', `none extracted, but bronze has ${bioPages.length} bio page(s): ${bioPages.map(p => p.path).join(', ')}`);
    }
    if (evidence.names.length) {
      return fail('doctor coverage', `none extracted, but bronze headings name ${evidence.names.slice(0, 4).join(', ')} on ${evidence.pages.slice(0, 3).join(', ')}`);
    }
    // A DSO that never names an individual dentist. bearcreek is exactly this:
    // 327 discovered URLs, no team page, no Person LD, no byline anywhere.
    return na('doctor coverage', 'no bio page, heading byline, or Person JSON-LD anywhere in bronze — [] is correct, and no loss is measurable here');
  }

  if (!bioPages.length) {
    return na('doctor coverage', `${doctors.length} doctor(s) extracted, but bronze has no /dr-* bio page to reconcile per-page coverage against`);
  }

  const covered = new Set(doctors.map(d => norm(d.sourcePath)));
  const orphans = bioPages.filter(p => !covered.has(norm(p.path)));
  orphans.length
    ? fail('doctor coverage', `${orphans.length}/${bioPages.length} bio page(s) produced no doctor: ${orphans.map(p => p.path).join(', ')} — check provider-filter drops`)
    : pass('doctor coverage', `${bioPages.length}/${bioPages.length} bio page(s) → a doctor`);
}

/** A doctor must be traceable to a page bronze actually crawled. */
function checkDoctorProvenance(silver, bronzePaths) {
  const doctors = Array.isArray(silver.doctors) ? silver.doctors : [];
  // Never silent: an absent line reads as "checked and fine" in a report that
  // otherwise prints one row per check.
  if (!doctors.length) return na('doctor provenance', 'no doctors extracted — nothing to trace');
  const bad = doctors.filter(d => d.sourcePath && !bronzePaths.has(norm(d.sourcePath)));
  const blog = doctors.filter(d => d.sourcePath && isBlogPath(d.sourcePath));
  if (bad.length) return fail('doctor provenance', `${bad.length} sourcePath(s) not in bronze: ${bad.slice(0, 3).map(d => `${d.name}→${d.sourcePath}`).join(', ')}`);
  if (blog.length) return fail('doctor provenance', `${blog.length} doctor(s) sourced from blog pages, which no pass reads`);
  const missing = doctors.filter(d => !d.sourcePath);
  missing.length
    ? fail('doctor provenance', `${missing.length}/${doctors.length} doctor(s) have no sourcePath — ungrounded`)
    : pass('doctor provenance', `${doctors.length}/${doctors.length} traceable to a crawled page`);
}

// ---------------------------------------------------------------------------
// 5. Staff — the bucket that has never been exercised on a site that has any
// ---------------------------------------------------------------------------

function checkStaff(silver, refPages) {
  const staff = Array.isArray(silver.staff) ? silver.staff : null;
  if (staff === null) return fail('staff', 'silver.staff absent from schema');

  // Evidence: role titles on a team/about page, or the scraper's own
  // "Staff member:" alt-text convention.
  const evidence = [];
  for (const p of refPages) {
    const hits = (p.bodyText || '').match(new RegExp(STAFF_ROLE.source, 'gi'));
    if (hits && /team|staff|about|meet/i.test(p.path)) evidence.push(`${p.path} (${[...new Set(hits.map(h => h.toLowerCase()))].slice(0, 3).join(', ')})`);
    else if ((p.images || []).some(img => /staff member:/i.test(img.alt || ''))) evidence.push(`${p.path} (alt convention)`);
  }

  if (!evidence.length) {
    return staff.length
      ? pass('staff', `${staff.length} extracted`)
      : na('staff', 'bronze names no non-doctor roles on a team page — [] is correct here, and this check is unexercised');
  }
  staff.length
    ? pass('staff', `${staff.length} extracted, bronze evidence on ${evidence.length} page(s)`)
    : fail('staff', `empty, but bronze names roles on: ${evidence.slice(0, 3).join('; ')}`);
}

// ---------------------------------------------------------------------------
// 6. Service provenance — the field that grounds Content Write
// ---------------------------------------------------------------------------

function checkServices(silver, bronzePaths, knownPaths) {
  const offered = silver.services?.offered;
  if (!Array.isArray(offered)) return fail('services', 'services.offered is not an array');
  if (!offered.length) return fail('services', 'empty — no site in this vertical offers nothing');

  // applyBackCompat defaults `source` to the literal string 'scrape', which
  // looks like provenance and carries none.
  const ungrounded = offered.filter(s => !s.source || s.source === 'scrape');
  const blog = offered.filter(s => s.source && isBlogPath(s.source));
  // Three outcomes, not two. A source can be a page bronze fetched (grounded),
  // a real site URL bronze discovered but never fetched (grounded in name only
  // — Content Write has no body text to work from), or a path that exists
  // nowhere on the site (fabricated).
  const uncrawled = offered.filter(s => s.source && s.source !== 'scrape'
    && !bronzePaths.has(norm(s.source)) && knownPaths.has(norm(s.source)));
  const fabricated = offered.filter(s => s.source && s.source !== 'scrape'
    && !bronzePaths.has(norm(s.source)) && !knownPaths.has(norm(s.source)));

  if (fabricated.length) {
    fail('service provenance', `${fabricated.length}/${offered.length} cite a path that exists nowhere on the site: ${fabricated.slice(0, 3).map(s => `${s.name}→${s.source}`).join(', ')}`);
  } else if (ungrounded.length) {
    fail('service provenance', `${ungrounded.length}/${offered.length} without a source path: ${ungrounded.slice(0, 4).map(s => s.name).join(', ')}`);
  } else if (blog.length) {
    fail('service provenance', `${blog.length} cite blog pages, which are excluded from every pass`);
  } else {
    pass('service provenance', `${offered.length}/${offered.length} cite a real site path`);
  }

  // Separate check, separate cause: these paths are real, so silver is not
  // hallucinating — the crawl discovered them and never fetched them. Reported
  // apart so the failure is not misattributed to extraction when the fix
  // belongs to crawl budgeting. lbpds lost 15 service pages to the `other`
  // category budget of 6 while `services` used 7 of its 28; azortho lost 2 to
  // skippedByPriority. Both are in 01-coverage.json.
  uncrawled.length
    ? fail('service grounding', `${uncrawled.length}/${offered.length} cite real URLs the crawl never fetched, so no body text grounds them: ${uncrawled.slice(0, 3).map(s => s.source).join(', ')} — see 01-coverage.json (skippedBudget / skippedByPriority)`)
    : pass('service grounding', `${offered.length}/${offered.length} cite a fetched page`);
}

// ---------------------------------------------------------------------------
// 7. FAQ extraction from pages that declare an FAQ section
// ---------------------------------------------------------------------------

function checkFaqs(silver, refPages) {
  const faqs = silver.content?.faqs;
  if (!Array.isArray(faqs)) return fail('faqs', 'content.faqs is not an array');

  // Only pages that BOTH declare an FAQ section in prose and carry several
  // question headings. Question headings alone are far too noisy — service
  // pages use "What Is Gum Recontouring?" as an ordinary section header, and
  // the model is right to skip those.
  const bearing = refPages.filter(p =>
    FAQ_MARKER.test(p.bodyText || '') && questionHeadings(p).length >= 3);

  if (!bearing.length) {
    return faqs.length
      ? pass('faq coverage', `${faqs.length} FAQ(s); no page declares a dedicated FAQ block`)
      : na('faq coverage', 'no page declares an FAQ section with question headings — nothing to reconcile');
  }

  // Match by source path when the model provided one, else by question text.
  const sources = new Set(faqs.map(f => norm(f.source || f.sourcePath)).filter(s => s !== '/'));
  const questionKeys = new Set(faqs.map(f => key(f.question)));
  const barren = bearing.filter((p) => {
    if (sources.has(norm(p.path))) return false;
    return !questionHeadings(p).some(h => questionKeys.has(key(h.text)));
  });

  barren.length
    ? fail('faq coverage', `${barren.length}/${bearing.length} page(s) declare an FAQ section but contributed none: ` +
        barren.map(p => `${p.path} (${questionHeadings(p).length}q, ${p.wordCount}w)`).join(', '))
    : pass('faq coverage', `${bearing.length}/${bearing.length} FAQ-bearing page(s) contributed, ${faqs.length} total`);
}

// ---------------------------------------------------------------------------
// 8. Testimonials / insurance / hours — assert only where bronze has the goods
// ---------------------------------------------------------------------------

/** Real prose, not a nav dump or a JS review widget. */
const hasProse = (p) => (p.paragraphs || []).length >= 2 ||
  (p.sections || []).some(s => (s.blocks || []).some(b => b.type === 'paragraph' && (b.text || '').length > 120));

function checkTestimonials(silver, refPages) {
  const got = silver.content?.testimonials;
  if (!Array.isArray(got)) return fail('testimonials', 'content.testimonials is not an array');

  const dedicated = refPages.filter(p => /testimonial|\/review/i.test(p.path));
  const withProse = dedicated.filter(hasProse);

  if (!dedicated.length) {
    return got.length ? pass('testimonials', `${got.length} extracted`) : na('testimonials', 'bronze has no dedicated reviews page');
  }
  if (!withProse.length) {
    // springst /reviews is 127 words of nav chrome + "Review Us" buttons: the
    // reviews live in a third-party widget the crawler cannot see. [] is right.
    return na('testimonials', `${dedicated.map(p => p.path).join(', ')} carries no extractable prose (widget-rendered) — [] is correct, loss unmeasurable`);
  }
  got.length
    ? pass('testimonials', `${got.length} from ${withProse.length} page(s) with prose`)
    : fail('testimonials', `empty, but ${withProse.map(p => `${p.path} (${p.wordCount}w)`).join(', ')} carries review prose`);
}

function checkHours(silver, refPages) {
  const hours = silver.hours;
  const populated = hours && (hours.raw || hours.display?.length || (hours.byDay && Object.keys(hours.byDay).length));

  // Evidence: a day name and a clock time close together on the same page.
  const evidence = refPages.find(p => {
    const t = p.bodyText || '';
    for (const m of t.matchAll(new RegExp(DAY.source, 'gi'))) {
      if (TIME.test(t.slice(m.index, m.index + 60))) return true;
    }
    return false;
  });

  if (!evidence) {
    return populated ? pass('hours', 'populated') : na('hours', 'bronze shows no day+time pattern — nothing to reconcile');
  }
  populated
    ? pass('hours', String(hours.raw || JSON.stringify(hours.display || hours.byDay)).slice(0, 60))
    : fail('hours', `null, but ${evidence.path} states hours in body text`);
}

function checkInsurance(silver, refPages) {
  const got = silver.content?.insurance;
  if (!Array.isArray(got)) return fail('insurance', 'content.insurance is not an array');

  const pages = refPages.filter(p => /insurance|financial|payment/i.test(p.path) && hasProse(p));
  if (!pages.length) {
    return got.length ? pass('insurance', `${got.length} extracted`) : na('insurance', 'bronze has no insurance/financial page with prose');
  }

  // An insurance page is not proof that insurers are named. lbpds
  // /financial-information.php runs 1326 words about payment policy and names
  // no carrier at all — "if you have dental and/or medical insurance, as a
  // courtesy, we will file the claim" — so insurance: [] is the correct
  // reading, and asserting on the page alone reports a loss that isn't there.
  const named = [];
  for (const p of pages) {
    for (const m of (p.bodyText || '').matchAll(new RegExp(CARRIER.source, 'gi'))) named.push(m[0]);
  }
  const carriers = [...new Set(named.map(n => n.toLowerCase()))];

  // The financial family as a whole: an insurance page should yield *something*
  // structured, even when the something is payment methods rather than plans.
  const family = got.length
    + (silver.content?.financingOptions?.length || 0)
    + (silver.content?.paymentMethods?.length || 0);

  if (carriers.length && !got.length) {
    return fail('insurance', `empty, but ${pages.map(p => p.path).join(', ')} names ${carriers.length} carrier(s): ${carriers.slice(0, 4).join(', ')}`);
  }
  if (got.length) return pass('insurance', `${got.length} plan(s) from ${pages.length} page(s)`);
  if (family) return pass('insurance', `no carriers named on ${pages.map(p => p.path).join(', ')}; ${family} financial item(s) captured instead`);
  fail('insurance', `nothing captured from ${pages.map(p => p.path).join(', ')} — no plans, financing, or payment methods`);
}

// ---------------------------------------------------------------------------
// 9. Silent pass failures
// ---------------------------------------------------------------------------

function checkPassMetrics(silver) {
  const metrics = silver.meta?.passMetrics;
  if (!metrics || !Object.keys(metrics).length) {
    return na('pass health', 'no passMetrics recorded — cannot tell whether a pass failed');
  }
  const errored = Object.entries(metrics).filter(([, v]) => v?.error);
  errored.length
    ? fail('pass health', `${errored.length} pass(es) threw and merged an empty slice: ${errored.map(([k, v]) => `${k} (${v.error})`).join('; ')}`)
    : pass('pass health', `${Object.keys(metrics).length} passes, none errored`);
}

// ---------------------------------------------------------------------------
// Public API — exported so test-silver-fidelity.js can drive the assertions
// against synthetic bronze/silver pairs. A check nobody has watched fail is a
// check nobody should trust, and the pairs on disk cannot reproduce every loss.
// ---------------------------------------------------------------------------

/**
 * @param {object} bronze  unwrapped bronze (the `.output` of 01-bronze.json)
 * @param {object} silver  unwrapped silver (the `.output` of 01-scrape.json)
 * @returns {{state:'pass'|'fail'|'na', name:string, detail:string}[]}
 */
export function runChecks(bronze, silver) {
  results.length = 0;

  const allPages = Array.isArray(bronze?.pages) ? bronze.pages : [];
  // Blog is held back from every silver pass, so it is not a fidelity target.
  const refPages = allPages.filter(p => !isBlogPath(p.path));
  const bronzePaths = new Set(allPages.map(p => norm(p.path)));
  // Every URL the crawl *discovered*, fetched or not. Separates a fabricated
  // path from a real page that lost a budget coin-flip.
  const knownPaths = new Set(bronzePaths);
  for (const u of (bronze?.siteAssets?.allUrls || [])) {
    try { knownPaths.add(norm(new URL(u).pathname)); } catch { knownPaths.add(norm(u)); }
  }

  checkSchema(silver);
  checkAdditionalContent(silver);
  checkPageInventory(bronze, silver, refPages);
  checkDoctors(silver, refPages);
  checkDoctorProvenance(silver, bronzePaths);
  checkStaff(silver, refPages);
  checkServices(silver, bronzePaths, knownPaths);
  checkFaqs(silver, refPages);
  checkTestimonials(silver, refPages);
  checkHours(silver, refPages);
  checkInsurance(silver, refPages);
  checkPassMetrics(silver);

  return results.map(r => ({ ...r }));
}

export const GLYPH = { pass: '✓', fail: '✗', na: '⊘' };

/** Render one client's report. Returns the process exit code for that client. */
export function report(label, rows, { refCount, pageCount } = {}) {
  const failed = rows.filter(r => r.state === 'fail');
  const unmeasured = rows.filter(r => r.state === 'na');
  const passed = rows.filter(r => r.state === 'pass');
  const scope = refCount != null ? `  (${refCount} reference / ${pageCount} crawled pages)` : '';
  console.log(`\nverify-silver — ${label}${scope}\n`);
  for (const r of rows) console.log(`  ${GLYPH[r.state]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed.length}/${rows.length} passed` +
    `${failed.length ? ` · ${failed.length} FAILED` : ''}` +
    `${unmeasured.length ? ` · ${unmeasured.length} unmeasurable` : ''}\n`);
  return failed.length ? 1 : 0;
}

async function verifyDir(clientDir) {
  let bronze, silver;
  try {
    bronze = unwrap(await readJson(resolve(clientDir, '_pipeline/01-bronze.json')));
  } catch {
    console.error(`verify-silver: no readable _pipeline/01-bronze.json in ${clientDir}`);
    return 2;
  }
  try {
    silver = unwrap(await readJson(resolve(clientDir, '_pipeline/01-scrape.json')));
  } catch {
    console.error(`verify-silver: no readable _pipeline/01-scrape.json in ${clientDir}`);
    return 2;
  }
  if (!Array.isArray(bronze.pages) || !bronze.pages.length) {
    console.error(`verify-silver: bronze has no pages in ${clientDir}`);
    return 2;
  }
  const rows = runChecks(bronze, silver);
  return report(basename(clientDir), rows, {
    refCount: bronze.pages.filter(p => !isBlogPath(p.path)).length,
    pageCount: bronze.pages.length,
  });
}

// CLI only when invoked directly, so importing this module runs nothing.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('usage: verify-silver.js clients/<slug> [clients/<slug> ...]');
    process.exit(2);
  }
  let worst = 0;
  for (const d of dirs) worst = Math.max(worst, await verifyDir(resolve(d)));
  process.exit(worst);
}
