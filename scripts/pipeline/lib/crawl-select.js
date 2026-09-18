/**
 * Crawl selection helpers — smart WHICH pages to fetch, without synthesizing content.
 *
 * Bronze stays faithful to what's live on each kept URL.
 * Selection / dedupe / budgets are observational filters on the crawl budget.
 */

import { createHash } from 'node:crypto';

/** Non-HTML assets — never enqueue as pages. */
export const NON_HTML_EXT =
  /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|pdf|zip|docx?|xlsx?|pptx?|mp4|webm|mp3|woff2?|ttf|eot|xml|json|rss|atom|txt|csv)(\?|$)/i;

/**
 * Blog is migration material, not reference material: posts are ported verbatim
 * and never sent to an AI pass, so they cost a fetch and nothing else. They get
 * a generous budget of their own and do not consume the core crawl limit —
 * a low blog cap was silently stranding most of a practice's indexed URLs.
 */
export const BLOG_BUDGET = 250;

/**
 * Category budgets for a typical dental rebuild reference crawl.
 *
 * These bound the pages used as *rebuild reference* — the material silver
 * AI-extracts from and Content Write writes against.
 */
export const CATEGORY_BUDGETS = {
  home: 1,
  services: 28,
  team: 10,
  patients: 8,
  contact: 4,
  reviews: 3,
  other: 6,
  blog: BLOG_BUDGET,
};

/**
 * Endpoints that are never rebuild reference at any budget: CMS admin, auth,
 * commerce, and machine-readable feeds. `/feed` on a WordPress site is the whole
 * blog concatenated — 5988 words on cutesmiles4kids — and it used to be held out
 * only by the `other` budget running out, which is not a filter, just luck.
 */
export const JUNK_PATH =
  /(wp-login\.php|wp-admin|wp-json|xmlrpc\.php|\/(feed|rss|atom)(\/|$)|\/(cart|checkout|my-account)(\/|$)|\/(log|sign)(in|out)(\/|$))/i;

/**
 * Blog archive furniture: author/category/tag/date listings, dated permalinks,
 * and pagination. None of it is reference material, and a dated permalink is a
 * post — it belongs to verbatim migration, not to the AI passes.
 *
 * `/blog/...` alone missed every one of these. cutesmiles4kids publishes at
 * /2021/01/18/<slug> with /author/*, /category/* and /2021/01 archives, so its
 * posts and listing pages were being classed `other` and fed to the extraction
 * prompts as if they were practice content.
 */
const BLOG_FURNITURE =
  /(^\/(19|20)\d{2}(\/|$)|^\/(author|category|tag|tags|archives?)(\/|$)|\/page\/\d+(\/|$))/i;

/** True for paths the crawler treats as blog/news/article content. */
export function isBlogPath(path = '') {
  return categorizePath(path) === 'blog';
}

/** True for paths that should never be fetched as reference pages. */
export function isJunkPath(path = '') {
  return JUNK_PATH.test(String(path || ''));
}

export function categorizePath(path = '/') {
  const p = String(path).toLowerCase() || '/';
  if (p === '/' || p === '') return 'home';
  if (/\/blog(\/|$)|\/news(\/|$)|\/articles?(\/|$)|\/post\//i.test(p)) return 'blog';
  if (BLOG_FURNITURE.test(p)) return 'blog';
  if (/\/(our-services|services?|dental-implants?|implants?|invisalign|ortho|braces|crowns?|cleaning|preventive|emergency|whiten|denture|root-canal|wisdom|periodont|gum|cosmetic|sedation|restorative|childrens?|pediatric|checkup|filling|bridge|bond|sealant|fluoride|mouthguard|nightguard|frenectom|gummy|missing-teeth|veneers|replace-missing)/i.test(p)) {
    return 'services';
  }
  // Local SEO pages before generic "dentist" team match
  if (/dentist-near|\/locations?(\/|\.html|$)/i.test(p)) return 'contact';
  // Team / doctor bios — prefix match (dr-azimi, meet-dr-*, meet-your-dentists, about-us)
  if (/\/(about|meet|dr[-_]|doctor|team|staff|providers?)/i.test(p)) return 'team';
  if (/\/(contact|location|direction|hours|map|find-us)/i.test(p)) return 'contact';
  if (/\/(review|testimonial)/i.test(p)) return 'reviews';
  if (/insurance|patients?|membership|offer|financ|\/plan|medicaid|chip|blue-cross|special/i.test(p)) {
    return 'patients';
  }
  return 'other';
}

/**
 * Nav-section labels whose child links are service/treatment pages.
 *
 * `categorizePath` recognises a service page only by its own URL, which fails on
 * any site that does not spell the treatment into the path. lbpds files
 * /dental-exams-and-cleanings.php, /emergencies.php, /retention.php and
 * /oral-hygiene-with-braces.php under `other` — budget 6 — while `services`
 * used 7 of its 28. Widening the regex is whack-a-mole across every vertical;
 * the site's own nav already says what these pages are.
 *
 * (ai-silver/passes/services.js keeps a near-identical regex for a different
 * job — choosing pages to send the model. Kept separate deliberately: this one
 * governs what gets fetched at all.)
 */
export const SERVICE_SECTION_LABEL =
  /(service|treatment|braces|smile|orthodont|procedure|what[-_ ]we[-_ ]do|dentistr|hygiene|specialt)/i;

/**
 * Paths that a services-labelled nav section points at.
 *
 * @param {Array<{text?:string, href?:string, children?:Array}>} navTree
 * @returns {Set<string>} normalised paths (no trailing slash)
 */
export function serviceSectionPaths(navTree = []) {
  const out = new Set();
  const norm = (h) => {
    if (!h) return null;
    let p = String(h);
    try { p = new URL(h, 'https://x.invalid').pathname; } catch { /* already a path */ }
    return p.replace(/\/+$/, '') || '/';
  };
  const walk = (items, inService) => {
    for (const item of (items || [])) {
      const here = inService || SERVICE_SECTION_LABEL.test(item.text || '');
      // Only children count: a section's own link ("Services") is an index page
      // that categorizePath already handles, and a top-level "Smile Gallery"
      // should not drag its siblings in.
      if (here) {
        for (const child of (item.children || [])) {
          const p = norm(child.href);
          if (p && p !== '/') out.add(p);
        }
      }
      if (Array.isArray(item.children)) walk(item.children, here);
    }
  };
  walk(navTree, false);
  return out;
}

/** Lower = crawl sooner. */
export function linkPriority(href) {
  let path = '/';
  try { path = new URL(href).pathname; } catch { /* keep */ }
  const cat = categorizePath(path);
  const rank = { home: 0, services: 1, team: 2, contact: 3, patients: 4, reviews: 5, other: 6, blog: 9 };
  return rank[cat] ?? 6;
}

/** Fingerprint page body for soft-404 / clone detection (observational, not interpretive). */
export function contentFingerprint(page) {
  const raw = String(page?.bodyText || page?.title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  if (raw.length < 80) return null;
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/**
 * Fetch same-origin URLs from sitemap.xml / sitemap_index.xml (best-effort).
 */
export async function fetchSitemapUrls(baseUrl, { fetchFn = fetch, limit = 500 } = {}) {
  const origin = baseUrl.replace(/\/+$/, '');
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const urls = [];
  const seen = new Set();

  async function loadXml(url) {
    try {
      const res = await fetchFn(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 GroundworkScraper', Accept: 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  function collectLocs(xml) {
    if (!xml) return [];
    const locs = [];
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      locs.push(m[1].trim());
    }
    return locs;
  }

  for (const sm of candidates) {
    const xml = await loadXml(sm);
    if (!xml) continue;
    const locs = collectLocs(xml);
    const childSitemaps = locs.filter((u) => /sitemap/i.test(u) && /\.xml(\?|$)/i.test(u));
    const pageLocs = locs.filter((u) => !childSitemaps.includes(u));
    for (const u of pageLocs) {
      try {
        const abs = new URL(u);
        if (abs.origin !== new URL(origin).origin) continue;
        if (NON_HTML_EXT.test(abs.pathname)) continue;
        let href = abs.origin + abs.pathname;
        if (href !== `${origin}/` && href.endsWith('/')) href = href.slice(0, -1);
        if (!seen.has(href)) {
          seen.add(href);
          urls.push(href);
        }
      } catch { /* skip */ }
      if (urls.length >= limit) break;
    }
    for (const child of childSitemaps.slice(0, 5)) {
      const childXml = await loadXml(child);
      for (const u of collectLocs(childXml)) {
        try {
          const abs = new URL(u);
          if (abs.origin !== new URL(origin).origin) continue;
          if (NON_HTML_EXT.test(abs.pathname)) continue;
          let href = abs.origin + abs.pathname;
          if (href !== `${origin}/` && href.endsWith('/')) href = href.slice(0, -1);
          if (!seen.has(href)) {
            seen.add(href);
            urls.push(href);
          }
        } catch { /* skip */ }
        if (urls.length >= limit) break;
      }
    }
    if (urls.length) break;
  }
  return urls;
}

/**
 * Build a post-scrape coverage report (nav / services / soft-dups / skipped).
 */
export function buildCoverageReport({
  baseUrl,
  pages = [],
  navHrefs = [],
  discoveredUrls = [],
  softDups = [],
  skippedBudget = [],
  skippedNonHtml = [],
  sitemapUrlCount = 0,
  limit = 0,
  serviceHints = new Set(),
}) {
  const crawledPaths = new Set(pages.map((p) => p.path));
  const normalize = (href) => {
    try {
      const u = new URL(href, baseUrl);
      return u.pathname.replace(/\/$/, '') || '/';
    } catch {
      return null;
    }
  };

  const navPaths = [...new Set(navHrefs.map(normalize).filter(Boolean))];
  const navHit = navPaths.filter((p) => crawledPaths.has(p) || crawledPaths.has(p.endsWith('.html') ? p : `${p}.html`) || (p !== '/' && crawledPaths.has(`${p}/`)));
  // Simpler hit: path exact or with .html
  const navHitExact = navPaths.filter((p) => {
    if (crawledPaths.has(p)) return true;
    if (crawledPaths.has(`${p}.html`)) return true;
    if (p.endsWith('.html') && crawledPaths.has(p.replace(/\.html$/, ''))) return true;
    return false;
  });

  // The nav hints have to reach the denominator, not just the crawl. This metric
  // read a perfect 7/7 on lbpds while 15 service pages were dropped: the very
  // misclassification that starved their budget also excluded them from
  // `serviceNav`, so the measurement lost exactly the pages it existed to count.
  const isService = (p) => serviceHints.has(p) || categorizePath(p) === 'services';
  const serviceNav = navPaths.filter(isService);
  const serviceHit = serviceNav.filter((p) => navHitExact.includes(p));

  const byCategory = {};
  for (const p of pages) {
    const c = isService(p.path.replace(/\/+$/, '') || '/') ? 'services' : categorizePath(p.path);
    byCategory[c] = (byCategory[c] || 0) + 1;
  }

  const skippedByPriority = discoveredUrls
    .filter((u) => {
      try {
        const path = new URL(u).pathname;
        return !crawledPaths.has(path) && !softDups.some((s) => s.url === u);
      } catch {
        return false;
      }
    })
    .map((u) => {
      let path = u;
      try { path = new URL(u).pathname; } catch { /* */ }
      return { path, category: categorizePath(path), priority: linkPriority(u) };
    })
    .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));

  // `limit` bounds reference pages only — blog is budgeted separately, so a
  // combined count reads as an overshoot when nothing overshot.
  const blogCount = pages.filter((p) => categorizePath(p.path) === 'blog').length;

  return {
    limit,
    pageCount: pages.length,
    corePageCount: pages.length - blogCount,
    blogPageCount: blogCount,
    blogBudget: BLOG_BUDGET,
    discoveredCount: discoveredUrls.length,
    sitemapUrlCount,
    byCategory,
    budgets: { ...CATEGORY_BUDGETS },
    softDupCount: softDups.length,
    softDups: softDups.slice(0, 40),
    skippedBudget: skippedBudget.slice(0, 40),
    skippedNonHtml: skippedNonHtml.slice(0, 20),
    nav: {
      total: navPaths.length,
      hit: navHitExact.length,
      hitRate: navPaths.length ? Number((navHitExact.length / navPaths.length).toFixed(3)) : null,
      missed: navPaths.filter((p) => !navHitExact.includes(p)).slice(0, 40),
    },
    services: {
      navTotal: serviceNav.length,
      hit: serviceHit.length,
      hitRate: serviceNav.length ? Number((serviceHit.length / serviceNav.length).toFixed(3)) : null,
      missed: serviceNav.filter((p) => !serviceHit.includes(p)),
    },
    skippedByPriority: skippedByPriority.slice(0, 60),
  };
}

export function printCoverageReport(report) {
  if (!report) return;
  console.log('[scraper] ── coverage report ──');
  console.log(`  reference pages=${report.corePageCount ?? report.pageCount}/${report.limit}  blog=${report.blogPageCount ?? 0}/${report.blogBudget ?? BLOG_BUDGET}  discovered=${report.discoveredCount}  sitemapSeed=${report.sitemapUrlCount}`);
  console.log(`  byCategory: ${JSON.stringify(report.byCategory)}`);
  console.log(`  softDups=${report.softDupCount}  budgetSkips=${report.skippedBudget?.length || 0}  nonHtmlSkips=${report.skippedNonHtml?.length || 0}`);
  if (report.nav) {
    console.log(`  nav hit-rate: ${report.nav.hit}/${report.nav.total} (${report.nav.hitRate ?? 'n/a'})`);
    if (report.nav.missed?.length) console.log(`  nav missed: ${report.nav.missed.join(', ')}`);
  }
  if (report.services) {
    console.log(`  service-nav hit-rate: ${report.services.hit}/${report.services.navTotal} (${report.services.hitRate ?? 'n/a'})`);
    if (report.services.missed?.length) console.log(`  service-nav missed: ${report.services.missed.join(', ')}`);
  }
  const topSkip = (report.skippedByPriority || []).slice(0, 12);
  if (topSkip.length) {
    console.log('  not crawled (highest priority first):');
    for (const s of topSkip) console.log(`    [${s.priority}] ${s.category} ${s.path}`);
  }
  console.log('[scraper] ── end coverage ──');
}
