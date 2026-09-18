#!/usr/bin/env node
/**
 * test-silver-fidelity.js — proves verify-silver.js actually catches things.
 *
 * A passing check proves nothing on its own. Each case below starts from a
 * known-good bronze/silver pair, reintroduces exactly one loss, and asserts the
 * matching check flips to `fail` — and, for the cases that burned us before,
 * that a *correct* absence stays out of the failure column.
 *
 * The three-state contract matters as much as the assertions: `na` must never
 * be counted as a pass. springst's /reviews page is 127 words of nav chrome
 * wrapping a JS review widget, so `testimonials: []` is right there; lbpds'
 * /financial-information.php runs 1326 words and names no carrier, so
 * `insurance: []` is right there too. Both were false positives in the first
 * cut of this check, and both are pinned below.
 *
 * Deterministic, no AI, no network, no dependence on any clients/ directory.
 */

import { runChecks } from '../verify-silver.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) return console.log(`  ✓ ${label}`);
  failures++;
  console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
};

const row = (rows, name) => rows.find(r => r.name === name);
const stateOf = (rows, name) => row(rows, name)?.state ?? '(no such check)';

/** Deep clone so each case can mutate freely. */
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------
// A known-good pair: every check should pass or be explicitly unmeasurable.
// Modelled on arts-family-dentistry, the reference build.
// ---------------------------------------------------------------------------

const page = (over = {}) => ({
  path: '/', title: 'Home', bodyText: '', wordCount: 500,
  headings: [], paragraphs: [], images: [], structuredData: [],
  internalLinks: [], externalLinks: [], sections: [], ...over,
});

const goodBronze = () => ({
  baseUrl: 'https://example-dental.com',
  pages: [
    page({ path: '/', wordCount: 1700, bodyText: 'Open Monday 9:00 am - 5:00 pm. Welcome.' }),
    page({
      path: '/dr-smith.html', wordCount: 700, bodyText: 'Dr. Jane Smith has practiced for 20 years and is board certified in general dentistry.',
      headings: [{ level: 1, text: 'Dr. Jane Smith' }],
    }),
    page({
      path: '/our-services.html', wordCount: 600, bodyText: 'We offer cleanings and implants.',
      headings: [{ level: 1, text: 'Our Services' }],
    }),
    page({
      path: '/dental-implants.html', wordCount: 4140,
      bodyText: 'Dental Implant FAQs. Read the answers to our most frequently asked questions below. '
        + 'How Long Do Dental Implants Last? Decades, with good care. Does Getting Dental Implants Hurt? No.',
      headings: [
        { level: 2, text: 'How Long Do Dental Implants Last?' },
        { level: 2, text: 'Does Getting Dental Implants Hurt?' },
        { level: 2, text: 'Am I Too Old for Dental Implants?' },
      ],
    }),
    page({
      path: '/reviews.html', wordCount: 655,
      paragraphs: ['The team was wonderful and gentle with my kids.', 'Best dental visit I have ever had.'],
      bodyText: 'The team was wonderful. Best dental visit I have ever had.',
    }),
    page({
      path: '/dental-insurance.html', wordCount: 1571,
      paragraphs: ['We accept Delta Dental, Aetna, and Cigna.', 'Financing is available.'],
      bodyText: 'We are in network with Delta Dental, Aetna, and Cigna.',
    }),
    page({
      path: '/meet-our-team.html', wordCount: 800,
      bodyText: 'Meet Ashley, our dental hygienist, and Maria, our office manager.',
    }),
    // Blog is held back from every pass; it must never count as a fidelity target.
    page({ path: '/blog/why-flossing-matters', wordCount: 850, bodyText: 'Flossing is good.' }),
  ],
  siteAssets: { allUrls: ['https://example-dental.com/adult-dentistry.html'] },
});

const goodSilver = () => ({
  practice: { name: 'Example Dental' },
  doctors: [{ name: 'Dr. Jane Smith', sourcePath: '/dr-smith.html', bio: 'x'.repeat(200) }],
  staff: [{ name: 'Ashley', role: 'Dental Hygienist' }, { name: 'Maria', role: 'Office Manager' }],
  navigation: [{ label: 'Home', href: '/' }],
  migration: { oldUrls: ['https://example-dental.com/'] },
  pageInventory: [
    { path: '/' }, { path: '/dr-smith.html' }, { path: '/our-services.html' },
    { path: '/dental-implants.html' }, { path: '/reviews.html' },
    { path: '/dental-insurance.html' }, { path: '/meet-our-team.html' },
  ],
  services: { offered: [{ name: 'Dental Implants', source: '/dental-implants.html' }] },
  hours: { raw: 'Mon 9:00 am - 5:00 pm' },
  content: {
    faqs: [{ question: 'How Long Do Dental Implants Last?', answer: 'Decades.', source: '/dental-implants.html' }],
    testimonials: [{ quote: 'The team was wonderful.', author: 'A patient' }],
    insurance: ['Delta Dental', 'Aetna', 'Cigna'],
    financingOptions: [], paymentMethods: [],
    additionalContent: [{ source: '/', text: 'Welcome.' }],
  },
  meta: { passMetrics: { contact: { ms: 10, error: null }, providers: { ms: 10, error: null } } },
});

// ---------------------------------------------------------------------------

console.log('\nbaseline — a faithful extraction');
{
  const rows = runChecks(goodBronze(), goodSilver());
  const failed = rows.filter(r => r.state === 'fail');
  check('no check fails on a faithful pair', failed.length === 0,
    failed.map(f => `${f.name}: ${f.detail}`).join(' | '));
  check('every check reported a row', rows.length === 14, `got ${rows.length}`);
  check('blog page excluded from the reference set',
    row(rows, 'pageInventory')?.detail.includes('7/7'), row(rows, 'pageInventory')?.detail);
}

console.log('\nreintroduced losses — each must flip its own check to fail');

// 1. The stale curated subset that 9 of 10 clients on disk still carried.
{
  const s = goodSilver();
  delete s.pageInventory; delete s.staff;
  s.pagesVisited = 7; s.servicesDetected = ['implants']; s.signals = {};
  const rows = runChecks(goodBronze(), s);
  check('stale pre-fix silver subset → schema fails', stateOf(rows, 'silver schema') === 'fail',
    row(rows, 'silver schema')?.detail);
}

// 2. additionalContent stranded at the top level.
{
  const s = goodSilver();
  s.additionalContent = s.content.additionalContent;
  delete s.content.additionalContent;
  const rows = runChecks(goodBronze(), s);
  check('additionalContent stranded at top level → fails', stateOf(rows, 'additionalContent path') === 'fail',
    row(rows, 'additionalContent path')?.detail);
}

// 2b. additionalContent sitting exactly on the run's cap: the ceiling is
//     binding, so the shortfall is real but unmeasurable — never a pass. The cap
//     scales per run and is recorded in meta, so headroom is measured against
//     what actually applied rather than a constant copied from the prompt.
{
  const blocks = (n) => Array.from({ length: n }, (_, i) => ({ source: '/', text: `block ${i}` }));

  const atCap = goodSilver();
  atCap.meta.additionalContentCap = 20;
  atCap.content.additionalContent = blocks(20);
  let rows = runChecks(goodBronze(), atCap);
  check('at the recorded cap → unmeasurable, not pass',
    stateOf(rows, 'additionalContent headroom') === 'na', row(rows, 'additionalContent headroom')?.detail);
  check('the report names the run\'s cap, not a hardcoded 12',
    row(rows, 'additionalContent headroom')?.detail.includes('20'), row(rows, 'additionalContent headroom')?.detail);
  check('a saturated additionalContent still passes the landing-path check',
    stateOf(rows, 'additionalContent path') === 'pass', row(rows, 'additionalContent path')?.detail);

  const underCap = goodSilver();
  underCap.meta.additionalContentCap = 30;
  underCap.content.additionalContent = blocks(12);
  rows = runChecks(goodBronze(), underCap);
  check('12 blocks under a cap of 30 is a pass, not saturation',
    stateOf(rows, 'additionalContent headroom') === 'pass', row(rows, 'additionalContent headroom')?.detail);

  // Artifacts written before the cap was recorded cannot be judged either way.
  const legacy = goodSilver();
  delete legacy.meta.additionalContentCap;
  legacy.content.additionalContent = blocks(12);
  rows = runChecks(goodBronze(), legacy);
  check('no recorded cap → unmeasurable rather than assumed',
    stateOf(rows, 'additionalContent headroom') === 'na', row(rows, 'additionalContent headroom')?.detail);
}

// 3. A reference page dropped from pageInventory.
{
  const s = goodSilver();
  s.pageInventory = s.pageInventory.filter(p => p.path !== '/dental-implants.html');
  const rows = runChecks(goodBronze(), s);
  check('page missing from pageInventory → fails', stateOf(rows, 'pageInventory') === 'fail',
    row(rows, 'pageInventory')?.detail);
}

// 4. Blog leaking into pageInventory.
{
  const s = goodSilver();
  s.pageInventory.push({ path: '/blog/why-flossing-matters' });
  const rows = runChecks(goodBronze(), s);
  check('blog leak into pageInventory → fails', stateOf(rows, 'pageInventory') === 'fail',
    row(rows, 'pageInventory')?.detail);
}

// 5. The `staff-loss` class: a bio page that yields nobody.
{
  const s = goodSilver();
  s.doctors = [];
  const rows = runChecks(goodBronze(), s);
  check('bio page with no extracted doctor → fails', stateOf(rows, 'doctor coverage') === 'fail',
    row(rows, 'doctor coverage')?.detail);
  check('zero doctors never goes silent on provenance',
    stateOf(rows, 'doctor provenance') === 'na', stateOf(rows, 'doctor provenance'));
}

// 6. Doctors extracted but not traceable to a crawled page.
{
  const s = goodSilver();
  s.doctors = [{ name: 'Dr. Jane Smith', sourcePath: '/team/jane-smith', bio: 'x'.repeat(200) }];
  const rows = runChecks(goodBronze(), s);
  check('doctor sourcePath absent from bronze → fails', stateOf(rows, 'doctor provenance') === 'fail',
    row(rows, 'doctor provenance')?.detail);
}

// 7. Staff dropped while bronze names hygienists — the bucket the reference
//    site could never exercise, because it has no non-doctor team members.
{
  const s = goodSilver();
  s.staff = [];
  const rows = runChecks(goodBronze(), s);
  check('staff empty while bronze names roles → fails', stateOf(rows, 'staff') === 'fail',
    row(rows, 'staff')?.detail);
}

// 8. Service provenance: the literal 'scrape' default, and a fabricated path.
{
  const s = goodSilver();
  s.services.offered = [{ name: 'Dental Implants', source: 'scrape' }];
  const rows = runChecks(goodBronze(), s);
  check("source defaulted to 'scrape' → provenance fails", stateOf(rows, 'service provenance') === 'fail',
    row(rows, 'service provenance')?.detail);
}
{
  const s = goodSilver();
  s.services.offered = [{ name: 'Veneers', source: '/veneers-we-never-had.html' }];
  const rows = runChecks(goodBronze(), s);
  check('fabricated source path → provenance fails', stateOf(rows, 'service provenance') === 'fail',
    row(rows, 'service provenance')?.detail);
}

// 9. A real URL the crawl never fetched — lbpds lost 15 service pages this way.
//    Must fail *grounding*, not *provenance*: the path is real, so blaming
//    extraction would send someone hunting in the wrong layer.
{
  const s = goodSilver();
  s.services.offered = [{ name: 'Adult Dentistry', source: '/adult-dentistry.html' }];
  const rows = runChecks(goodBronze(), s);
  check('real-but-unfetched source → grounding fails', stateOf(rows, 'service grounding') === 'fail',
    row(rows, 'service grounding')?.detail);
  check('real-but-unfetched source → provenance still passes',
    stateOf(rows, 'service provenance') === 'pass', row(rows, 'service provenance')?.detail);
}

// 10. The flagship loss: a page that declares an FAQ block and contributes none.
//     arts-family /dental-implants.html, 4140 words, 10 question headings, zero
//     FAQs — on the build that scores 18/18 in verify-build.
{
  const s = goodSilver();
  s.content.faqs = [];
  const rows = runChecks(goodBronze(), s);
  check('declared FAQ section contributing nothing → fails', stateOf(rows, 'faq coverage') === 'fail',
    row(rows, 'faq coverage')?.detail);
}

// 11. Testimonials and hours dropped where bronze plainly had them.
{
  const s = goodSilver();
  s.content.testimonials = [];
  const rows = runChecks(goodBronze(), s);
  check('testimonials dropped from a page with review prose → fails',
    stateOf(rows, 'testimonials') === 'fail', row(rows, 'testimonials')?.detail);
}
{
  const s = goodSilver();
  s.hours = null;
  const rows = runChecks(goodBronze(), s);
  check('hours null while bronze states them → fails', stateOf(rows, 'hours') === 'fail',
    row(rows, 'hours')?.detail);
}

// 12. Named carriers on the page, nothing in silver.
{
  const s = goodSilver();
  s.content.insurance = [];
  const rows = runChecks(goodBronze(), s);
  check('insurance dropped while carriers are named → fails', stateOf(rows, 'insurance') === 'fail',
    row(rows, 'insurance')?.detail);
}

// 13. A pass that threw and merged an empty slice.
{
  const s = goodSilver();
  s.meta.passMetrics.providers = { ms: 12, error: 'overloaded_error' };
  const rows = runChecks(goodBronze(), s);
  check('errored pass → pass health fails', stateOf(rows, 'pass health') === 'fail',
    row(rows, 'pass health')?.detail);
}

console.log('\ncorrect absences — must NOT be reported as loss (each was a false positive once)');

// springst: /reviews is a JS widget. 127 words of nav chrome, no prose.
{
  const b = goodBronze();
  const reviews = b.pages.find(p => p.path === '/reviews.html');
  reviews.paragraphs = [];
  reviews.sections = [];
  reviews.wordCount = 127;
  reviews.bodyText = 'Patient Reviews Review Us Review Us Home About Services Contact';
  const s = goodSilver();
  s.content.testimonials = [];
  const rows = runChecks(b, s);
  check('widget-rendered reviews page → unmeasurable, not fail',
    stateOf(rows, 'testimonials') === 'na', row(rows, 'testimonials')?.detail);
}

// lbpds: a 1326-word financial page that names no carrier at all.
{
  const b = goodBronze();
  const ins = b.pages.find(p => p.path === '/dental-insurance.html');
  ins.paragraphs = ['Payment is due at the time of service. We accept cash, check, and Care Credit.',
    'If you have dental insurance, as a courtesy, we will file the claim for you.'];
  ins.bodyText = 'Payment is due at the time of service. If you have dental and/or medical insurance, '
    + 'as a courtesy, we will file the claim for you. We accept cash, check, Care Credit.';
  const s = goodSilver();
  s.content.insurance = [];
  s.content.paymentMethods = ['cash', 'check', 'Care Credit'];
  s.content.financingOptions = ['Care Credit payment plans'];
  const rows = runChecks(b, s);
  check('financial page naming no carrier → passes on the financial family',
    stateOf(rows, 'insurance') === 'pass', row(rows, 'insurance')?.detail);
}

// bearcreek: a DSO that names no individual dentist anywhere.
{
  const b = goodBronze();
  b.pages = b.pages.filter(p => p.path !== '/dr-smith.html');
  // "Ledbetter Dr. Lombardy Ln." is why body-text `Dr.` matching is unsafe:
  // street abbreviations look exactly like physician bylines.
  b.pages.find(p => p.path === '/').bodyText =
    'Open Monday 9:00 am - 5:00 pm. Take Ledbetter Dr. Lombardy Ln. to our office. Dr. Smith Rd. exit.';
  const s = goodSilver();
  s.doctors = [];
  s.pageInventory = s.pageInventory.filter(p => p.path !== '/dr-smith.html');
  const rows = runChecks(b, s);
  check('DSO naming no provider → unmeasurable, not fail',
    stateOf(rows, 'doctor coverage') === 'na', row(rows, 'doctor coverage')?.detail);
}

// A site with no FAQ block at all must not be scored as an FAQ loss.
{
  const b = goodBronze();
  b.pages = b.pages.filter(p => p.path !== '/dental-implants.html');
  const s = goodSilver();
  s.content.faqs = [];
  s.pageInventory = s.pageInventory.filter(p => p.path !== '/dental-implants.html');
  s.services.offered = [{ name: 'Cleanings', source: '/our-services.html' }];
  const rows = runChecks(b, s);
  check('no declared FAQ section → unmeasurable, not fail',
    stateOf(rows, 'faq coverage') === 'na', row(rows, 'faq coverage')?.detail);
}

// And the contract that makes the ⊘ state meaningful at all.
{
  const b = goodBronze();
  b.pages = b.pages.filter(p => p.path !== '/dr-smith.html');
  const s = goodSilver();
  s.doctors = [];
  const rows = runChecks(b, s);
  const na = rows.filter(r => r.state === 'na');
  const passed = rows.filter(r => r.state === 'pass');
  check('unmeasurable rows are not counted as passes',
    na.length > 0 && !na.some(r => passed.includes(r)), `na=${na.length} pass=${passed.length}`);
}

console.log(failures ? `\n${failures} assertion(s) failed\n` : '\nall assertions passed\n');
process.exit(failures ? 1 : 0);
