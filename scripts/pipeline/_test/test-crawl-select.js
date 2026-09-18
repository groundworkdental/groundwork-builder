#!/usr/bin/env node
/**
 * test-crawl-select.js — crawl selection logic.
 *
 * Anchored to one observed loss: lbpds discovered 46 URLs, crawled 24 against
 * `--limit 50`, and threw away 22 — 15 of them service pages — because
 * `categorizePath` recognises a treatment page only by its own URL.
 * /dental-exams-and-cleanings.php, /emergencies.php, /retention.php and
 * /oral-hygiene-with-braces.php all fell to `other`, whose budget is 6, while
 * `services` used 7 of its 28.
 *
 * The same misclassification also removed those pages from the denominator of
 * the service-nav metric — `categorizePath(p) === 'services'` was both the
 * budget gate and the measurement — so coverage reported a perfect 7/7 while
 * the pages went missing. Both directions are pinned here.
 *
 * Deterministic, no network.
 */

import {
  serviceSectionPaths, categorizePath, buildCoverageReport, isBlogPath, isJunkPath,
} from '../lib/crawl-select.js';
import { isPostPath } from '../lib/blog-migrate.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) return console.log(`  ✓ ${label}`);
  failures++;
  console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
};

// lbpds' real nav shape: treatment pages hang off sections named for the
// discipline, never for the treatment.
const LBPDS_NAV = [
  { text: 'About Us', href: '/about.php', children: [
    { text: 'Meet Dr. Cortez', href: '/meet-dr-cortez.php' },
    { text: 'Meet Our Team', href: '/meet-our-team.php' },
  ] },
  { text: 'New Patients', href: '/new-patients.php', children: [
    { text: 'Patient Forms', href: '/patient-forms.php' },
    { text: 'Financial Information', href: '/financial-information.php' },
  ] },
  { text: 'Pediatric Dentistry', href: null, children: [
    { text: 'Dental Services', href: '/dental-services.php' },
    { text: 'Silver Diamine Fluoride', href: '/silver-diamine-fluoride.php' },
    { text: 'Emergencies', href: '/emergencies.php' },
    { text: 'Digit Sucking/Pacifier Use', href: '/digit-sucking.php' },
  ] },
  { text: 'Orthodontics', href: null, children: [
    { text: 'Right Age', href: '/right-age.php' },
    { text: 'Oral Hygiene With Braces', href: '/oral-hygiene-with-braces.php' },
    { text: 'Retention', href: '/retention.php' },
  ] },
  { text: 'Hygiene', href: null, children: [
    { text: 'Dental Exams and Cleanings', href: '/dental-exams-and-cleanings.php' },
    { text: 'Oral Cancer Screening', href: '/oral-cancer-screening.php' },
  ] },
  { text: 'Contact', href: '/contact.php', children: [
    { text: 'Map & Directions', href: '/map-directions.php' },
  ] },
];

console.log('\nserviceSectionPaths — the nav says what the path does not');
{
  const hints = serviceSectionPaths(LBPDS_NAV);

  // The four that actually starved the lbpds crawl.
  for (const p of ['/dental-exams-and-cleanings.php', '/emergencies.php', '/retention.php', '/oral-hygiene-with-braces.php']) {
    check(`${p} is hinted as a service`, hints.has(p), `categorizePath says '${categorizePath(p)}'`);
    check(`${p} is what categorizePath misses`, categorizePath(p) === 'other',
      `categorizePath now says '${categorizePath(p)}' — if this changed, the hint may be redundant`);
  }

  // Sections that are not services must not drag their children in, or the
  // hint set becomes "every nav link" and the budget stops meaning anything.
  check('team children are not hinted', !hints.has('/meet-dr-cortez.php') && !hints.has('/meet-our-team.php'));
  check('patient children are not hinted', !hints.has('/patient-forms.php') && !hints.has('/financial-information.php'));
  check('contact children are not hinted', !hints.has('/map-directions.php'));

  // A section's own link is left to categorizePath; only children are claimed.
  check('does not hint the root path', !hints.has('/'));

  check('hint count is the service sections only', hints.size === 9, `got ${hints.size}: ${[...hints].join(', ')}`);
}

console.log('\nserviceSectionPaths — shapes that must not throw');
{
  check('empty tree', serviceSectionPaths([]).size === 0);
  check('undefined tree', serviceSectionPaths().size === 0);
  check('nodes without children', serviceSectionPaths([{ text: 'Services', href: '/s' }]).size === 0);
  check('null hrefs are skipped',
    serviceSectionPaths([{ text: 'Services', children: [{ text: 'X', href: null }] }]).size === 0);
  check('absolute hrefs reduce to a path',
    serviceSectionPaths([{ text: 'Treatments', children: [{ text: 'X', href: 'https://s.com/braces/' }] }]).has('/braces'));
  check('nested service section is inherited',
    serviceSectionPaths([{ text: 'Our Treatments', children: [
      { text: 'Sub', children: [{ text: 'Deep', href: '/deep.php' }] },
    ] }]).has('/deep.php'));
}

console.log('\nblog furniture + junk — what the `other` budget was hiding by accident');
{
  // Before spillover, these were held out only because `other` ran out of budget
  // at 6. Once `limit` was allowed to fill, /feed (5988 words of concatenated
  // blog) and /wp-login.php landed in the reference set and went into every
  // downstream prompt. cutesmiles4kids supplied every path here.
  for (const p of ['/wp-login.php', '/feed', '/wp-admin/', '/wp-json/wp/v2/posts', '/cart', '/my-account', '/signin', '/logout']) {
    check(`junk: ${p}`, isJunkPath(p));
  }

  // Dated permalinks are posts — they belong to verbatim migration, not to the
  // AI passes. Archive listings are not reference material at all.
  for (const p of [
    '/2021/01/18/i-need-braces-but-dont-want-old-fashioned-ones',
    '/2021/01', '/2022/01', '/author/elizabeth', '/category/uncategorized',
    '/tag/braces', '/page/2', '/archives/2020',
  ]) {
    check(`blog furniture: ${p}`, isBlogPath(p), `categorized '${categorizePath(p)}'`);
  }

  // The regexes must not swallow real practice pages. A year pattern that is
  // too loose eats marketing slugs that merely start with digits.
  for (const p of [
    '/', '/our-services.html', '/dental-implants.html', '/meet-dr-smith',
    '/retention.php', '/emergencies.php', '/insurance-financing', '/before-after.php',
    '/2-week-smile', '/20-years-experience', '/1-day-crowns', '/pediatric-dentistry',
    '/feedback', '/feeding-your-baby', '/signage',
  ]) {
    check(`kept: ${p}`, !isBlogPath(p) && !isJunkPath(p),
      `blog=${isBlogPath(p)} junk=${isJunkPath(p)} cat=${categorizePath(p)}`);
  }
}

console.log('\nisBlogPath + isPostPath — one definition of blog, across both halves');
{
  // blog-generator used its own /^\/blog\// prefix test while the crawl and every
  // silver pass used isBlogPath. They disagreed on dated permalinks, so
  // cutesmiles4kids' 28 posts were held back from extraction as blog and then
  // not ported either — dropped by both halves. These two predicates now compose:
  // isBlogPath decides "is this blog", isPostPath decides "post or archive".
  const isPost = (p) => isBlogPath(p) && isPostPath(p);

  // Real posts, in each of the shapes the measured sites actually use.
  for (const p of [
    '/blog/how-to-keep-your-dentures-looking-great',   // arts-family
    '/2021/08/31/back-to-school-dental-tips',          // cutesmiles4kids
    '/news/office-reopening',
    '/articles/why-flossing-matters',
  ]) check(`post: ${p}`, isPost(p), `blog=${isBlogPath(p)} post=${isPostPath(p)}`);

  // Indexes and archives. Migrating one stitches every excerpt on the site into
  // a duplicate-content page.
  for (const p of [
    '/blog', '/blog/page/2',
    '/patient-resources/blog', '/patient-resources/blog/page/4',   // azortho: nested index
    '/category/uncategorized', '/category/braces', '/author/elizabeth', '/tag/braces',
    '/2021', '/2021/01', '/page/2',
  ]) check(`not a post: ${p}`, !isPost(p), `blog=${isBlogPath(p)} post=${isPostPath(p)}`);

  // Practice pages must never be ported as posts, whatever they are named.
  for (const p of [
    '/', '/our-services.html', '/dental-implants.html', '/meet-our-team.php',
    '/dental-blog-tips', '/blogger-outreach', '/2-week-smile',
  ]) check(`practice page, not a post: ${p}`, !isPost(p), `blog=${isBlogPath(p)} post=${isPostPath(p)}`);
}

console.log('\nbuildCoverageReport — the metric must see what the budget sees');
{
  const navHrefs = ['/dental-exams-and-cleanings.php', '/emergencies.php', '/retention.php', '/preventive-care.php'];
  const pages = [{ path: '/preventive-care.php' }];   // only the regex-matched one got crawled
  const hints = new Set(['/dental-exams-and-cleanings.php', '/emergencies.php', '/retention.php']);

  const blind = buildCoverageReport({ baseUrl: 'https://x.com', pages, navHrefs, limit: 50 });
  check('without hints the metric reports a perfect score while 3 pages are missing',
    blind.services.hitRate === 1 && blind.services.navTotal === 1,
    `navTotal=${blind.services.navTotal} hitRate=${blind.services.hitRate}`);

  const seeing = buildCoverageReport({ baseUrl: 'https://x.com', pages, navHrefs, limit: 50, serviceHints: hints });
  check('with hints the denominator includes them', seeing.services.navTotal === 4, `got ${seeing.services.navTotal}`);
  check('with hints the score drops to the truth', seeing.services.hitRate === 0.25, `got ${seeing.services.hitRate}`);
  check('the missing pages are named', seeing.services.missed.length === 3, JSON.stringify(seeing.services.missed));

  // byCategory should also stop under-reporting services.
  const counted = buildCoverageReport({
    baseUrl: 'https://x.com', navHrefs, limit: 50, serviceHints: hints,
    pages: [{ path: '/preventive-care.php' }, { path: '/retention.php' }],
  });
  check('byCategory counts a hinted page as a service', counted.byCategory.services === 2,
    JSON.stringify(counted.byCategory));
}

console.log(failures ? `\n${failures} assertion(s) failed\n` : '\nall assertions passed\n');
process.exit(failures ? 1 : 0);
