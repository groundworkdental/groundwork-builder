/**
 * Bronze Layer — Pure Site Crawler
 *
 * Crawls a website and returns raw page data for rebuild reference:
 *   content (narrative) · images · colors/logo cues · contact signals
 * Typography/layout come from templates / catalog / curated pairings — not the
 * original CMS typefaces. Playwright design-token capture is opt-in only.
 *
 * Output shape: BronzeData (see bottom of file for type comments)
 * Consumer:     lib/ai-silver.js (transforms bronze → silver PracticeData)
 */

import { JSDOM } from 'jsdom';
import { classifyHomepage, isScrapeFailure } from './scrape-probe.js';
import {
  NON_HTML_EXT,
  CATEGORY_BUDGETS,
  categorizePath,
  linkPriority,
  contentFingerprint,
  fetchSitemapUrls,
  buildCoverageReport,
  printCoverageReport,
  serviceSectionPaths,
  isJunkPath,
} from './crawl-select.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CONCURRENCY = 5;
const DEFAULT_LIMIT = 500;

/** Classes/IDs that suggest hero/banner text blocks worth surfacing. */
const HERO_SELECTORS = [
  '[class*="slide-heading"]', '[class*="hero-heading"]', '[class*="hero-title"]',
  '[class*="banner-heading"]', '[class*="banner-title"]', '[class*="slider-heading"]',
  '[class*="hero-text"]', '[class*="slide-title"]', '[class*="slideshow-heading"]',
  '[class*="hero-content"] h1', '[class*="hero-content"] h2', '[class*="hero-content"] p',
  '[class*="banner-content"] h1', '[class*="banner-content"] h2',
];

/** Social domain patterns — used to tag external links. */
const SOCIAL_DOMAINS = /\b(facebook|instagram|twitter|yelp|google|youtube|linkedin|tiktok|pinterest|nextdoor)\b/i;

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetch HTML with a small cookie jar + manual redirects.
 * Some dental CMS hosts (LiteSpeed cookie challenges) 302 in a loop when
 * Node's undici auto-follow ignores Set-Cookie — curl succeeds because it jars cookies.
 */
async function fetchPage(url, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 8;
  const jar = opts.cookieJar || new Map(); // name -> value
  let current = url;
  let status = 0;
  let html = '';

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(current, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      status = res.status;

      // Merge Set-Cookie into jar (name=value only; ignore attrs)
      const rawCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      for (const raw of rawCookies) {
        if (!raw) continue;
        const pair = String(raw).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }

      if ([301, 302, 303, 307, 308].includes(status)) {
        const loc = res.headers.get('location');
        if (!loc) break;
        current = new URL(loc, current).href;
        // Drain body so the socket can close cleanly
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        continue;
      }

      html = await res.text();
      return { html, status, finalUrl: current };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Exhausted redirects — return whatever we last saw (often empty challenge page)
  return { html, status, finalUrl: current };
}

// ---------------------------------------------------------------------------
// Per-page data extraction (raw only — no interpretation)
// ---------------------------------------------------------------------------

const SKIP_CHROME_CLOSEST = 'nav, footer, [role="navigation"], [role="contentinfo"]';

/**
 * Document-order content blocks so narrative stays intact
 * (heading → following paragraphs/lists/tables), not disconnected arrays.
 *
 * @param {Document} doc
 * @returns {object[]}
 */
function extractContentBlocks(doc) {
  const root =
    doc.querySelector('main, [role="main"], #content, #main-content, .main-content, article') ||
    doc.body;
  if (!root) return [];

  const candidates = root.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, p, ul, ol, table, blockquote',
  );
  const blocks = [];

  for (const el of candidates) {
    // Skip site chrome (keep header content — many dental heroes live there)
    if (el.closest(SKIP_CHROME_CLOSEST)) continue;
    // Avoid double-counting text inside lists/tables we already capture as wholes
    if (el.closest('ul, ol, table') && !/^(UL|OL|TABLE)$/.test(el.tagName)) continue;

    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ type: 'heading', level: parseInt(tag[1], 10), text });
      continue;
    }
    if (tag === 'P' || tag === 'BLOCKQUOTE') {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > 10) blocks.push({ type: 'paragraph', text });
      continue;
    }
    if (tag === 'UL' || tag === 'OL') {
      const items = Array.from(el.querySelectorAll(':scope > li'))
        .map((li) => li.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'OL', items });
      continue;
    }
    if (tag === 'TABLE') {
      const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th, td')).map((c) =>
          c.textContent.replace(/\s+/g, ' ').trim(),
        ),
      ).filter((r) => r.some(Boolean));
      if (rows.length) blocks.push({ type: 'table', rows });
    }
  }

  return blocks;
}

/**
 * Group flat blocks into sections under the nearest preceding heading.
 * @param {object[]} blocks
 */
function groupBlocksIntoSections(blocks) {
  const sections = [];
  let current = { heading: null, blocks: [] };
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (current.heading || current.blocks.length) sections.push(current);
      current = { heading: block, blocks: [] };
    } else {
      current.blocks.push(block);
    }
  }
  if (current.heading || current.blocks.length) sections.push(current);
  return sections;
}

function extractRawPage(doc, url, rawHtml) {
  const base = new URL(url);

  // Title + meta
  const title     = doc.querySelector('title')?.textContent?.trim() || '';
  const metaDesc  = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
  const metaKw    = doc.querySelector('meta[name="keywords"]')?.getAttribute('content')?.trim() || '';
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim() || null;

  // Narrative-preserving extract (primary for downstream / audit)
  const contentBlocks = extractContentBlocks(doc);
  const sections = groupBlocksIntoSections(contentBlocks);

  // Flat arrays derived FROM narrative blocks (same order / content — not a second scrape)
  const headings = contentBlocks
    .filter((b) => b.type === 'heading')
    .map((b) => ({ level: b.level, text: b.text }));
  const paragraphs = [];
  for (const b of contentBlocks) {
    if (b.type === 'paragraph') paragraphs.push(b.text);
    else if (b.type === 'list') paragraphs.push(...(b.items || []));
  }

  // Hero / slider texts (common patterns TheDocSites and similar CMSes use)
  const heroTexts = [];
  const heroSeen  = new Set();
  for (const sel of HERO_SELECTORS) {
    for (const el of doc.querySelectorAll(sel)) {
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (t && t.length > 3 && t.length < 300 && !heroSeen.has(t)) {
        heroTexts.push(t);
        heroSeen.add(t);
      }
    }
  }

  // Images — skip trackers/pixels; keep real media with src+alt
  const TRACKER_SRC = /facebook\.com\/tr|google-analytics|googletagmanager|doubleclick|hotjar|segment\.|mixpanel|bat\.bing|adservice|pixel|\/collect\?/i;
  const images = Array.from(doc.querySelectorAll('img'))
    .map(img => ({
      src: img.getAttribute('src') || '',
      alt: (img.getAttribute('alt') || '').trim(),
    }))
    .filter(i => i.src && !i.src.startsWith('data:') && !TRACKER_SRC.test(i.src));

  // Links (split internal vs external, plus mailto/tel)
  const internalLinks = [];
  const externalLinks = [];
  const mailtos = new Set();
  const tels = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const text = a.textContent.replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript')) continue;
    if (href.startsWith('mailto:')) {
      // Strip mailto: prefix and any query (?subject=...)
      const addr = href.slice(7).split('?')[0].trim();
      if (addr) mailtos.add(addr);
      continue;
    }
    if (href.startsWith('tel:')) {
      tels.add(href.slice(4).trim());
      continue;
    }
    try {
      const abs = new URL(href, base);
      if (abs.hostname === base.hostname) {
        internalLinks.push({ href: abs.pathname, text });
      } else {
        externalLinks.push({ href: abs.href, text, social: SOCIAL_DOMAINS.test(abs.hostname) });
      }
    } catch { /* malformed href */ }
  }

  // Also scan visible body text for emails and phone numbers — many sites
  // print them as plain text rather than mailto:/tel: links.
  const visibleText = (doc.body?.textContent || '').replace(/\s+/g, ' ');
  const emails = new Set(mailtos);
  for (const m of visibleText.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    emails.add(m[0]);
  }
  const phones = new Set(tels);
  // North-American style: (NNN) NNN-NNNN, NNN-NNN-NNNN, NNN.NNN.NNNN, +1 NNN NNN NNNN
  for (const m of visibleText.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)) {
    phones.add(m[0].trim());
  }

  const contactLinks = {
    mailtos: Array.from(mailtos),
    tels: Array.from(tels),
    emails: Array.from(emails),
    phones: Array.from(phones),
  };

  // JSON-LD structured data (raw parsed objects)
  const structuredData = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent);
      const items  = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      structuredData.push(...items);
    } catch { /* skip malformed */ }
  }

  // Full page body text (cleaned)
  doc.querySelectorAll('style, script, noscript').forEach(el => el.remove());
  const bodyText  = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(' ').filter(Boolean).length;

  return {
    url,
    path: base.pathname,
    title,
    metaDescription: metaDesc,
    metaKeywords:    metaKw,
    canonicalUrl:    canonical,
    contentBlocks,
    sections,
    headings,
    heroTexts,
    paragraphs,
    images,
    internalLinks,
    externalLinks,
    contactLinks,
    structuredData,
    bodyText: bodyText.slice(0, 20000),
    wordCount,
  };
}

// ---------------------------------------------------------------------------
// Site-level asset extraction (navigation, colors, social links)
// ---------------------------------------------------------------------------

/** Pull top-level nav links from the first <nav> or <header> on the page. */
function extractNavigation(doc, baseUrl) {
  const navEl = doc.querySelector('nav, header');
  if (!navEl) return [];
  return Array.from(navEl.querySelectorAll('a[href]'))
    .map(a => {
      const href = a.getAttribute('href') || '';
      const text = a.textContent.replace(/\s+/g, ' ').trim();
      try {
        const abs = new URL(href, baseUrl);
        if (abs.hostname === new URL(baseUrl).hostname) return { text, href: abs.pathname };
      } catch { /* skip */ }
      return null;
    })
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * Extract a NESTED navigation tree from the primary <nav>/<header>, preserving
 * dropdown hierarchy (parent section → children). Walks <li> structure: a list
 * item containing both a label and a nested <ul> becomes a parent with children.
 * Falls back gracefully on flat navs.
 */
function extractNavTree(doc, baseUrl) {
  const host = new URL(baseUrl).hostname;
  const abs = (href) => {
    try { const u = new URL(href, baseUrl); return u.hostname === host ? u.pathname : u.href; }
    catch { return href || null; }
  };

  // Prefer a <nav>; else the first <header>
  const navEl = doc.querySelector('nav') || doc.querySelector('header');
  if (!navEl) return [];

  // Find the outermost list(s) in the nav
  const topLists = Array.from(navEl.querySelectorAll('ul, ol'))
    .filter(ul => !ul.parentElement?.closest('ul, ol')); // only top-level lists within nav

  const items = [];
  const seen = new Set();

  const processLi = (li) => {
    // The item's own label/link: first anchor or text node not inside a nested list
    const directAnchor = Array.from(li.children).find(c => c.tagName === 'A')
      || li.querySelector(':scope > a')
      || li.querySelector('a');
    let text = '';
    let href = null;
    if (directAnchor) {
      // textContent of the anchor, but strip text that belongs to nested submenus
      text = (directAnchor.textContent || '').replace(/\s+/g, ' ').trim();
      href = abs(directAnchor.getAttribute('href') || '');
    } else {
      // label may be a span/button (dropdown toggle with no href)
      const lbl = li.querySelector(':scope > span, :scope > button, :scope > a');
      text = (lbl?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // Children = anchors inside a nested <ul>/<ol> within this <li>
    const subList = li.querySelector(':scope > ul, :scope > ol');
    const children = [];
    if (subList) {
      for (const a of subList.querySelectorAll('a[href]')) {
        const ct = (a.textContent || '').replace(/\s+/g, ' ').trim();
        const ch = abs(a.getAttribute('href') || '');
        if (ct && ch && !ct.startsWith('javascript')) children.push({ text: ct, href: ch });
      }
    }

    // Some menus put the parent label only in the first child text — clean it
    if (text && text.length > 80 && children.length) {
      // text likely absorbed children; take the leading segment
      text = text.split(children[0]?.text || '\u0000')[0].trim() || text.slice(0, 40);
    }

    if (!text) return null;
    const key = text + '|' + (href || '');
    if (seen.has(key)) return null;
    seen.add(key);
    return { text, href: href || null, children };
  };

  for (const ul of topLists) {
    for (const li of Array.from(ul.children).filter(c => c.tagName === 'LI')) {
      const item = processLi(li);
      if (item) items.push(item);
    }
  }

  // If the <li> walk found nothing useful (some navs are flat <a> soup),
  // fall back to a flat anchor list.
  if (items.length === 0) {
    for (const a of navEl.querySelectorAll('a[href]')) {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const href = abs(a.getAttribute('href') || '');
      if (!text || !href) continue;
      const key = text + '|' + href;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ text, href, children: [] });
      if (items.length >= 40) break;
    }
  }

  return items.slice(0, 40);
}

/**
 * Fetch an external CSS file and extract every hex color mentioned.
 * Returns a deduplicated array of lowercase hex strings.
 */
async function extractCssColors(cssUrl) {
  try {
    const css = await fetch(cssUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/css,*/*;q=0.1',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    }).then(r => r.text());

    const colors = new Set();
    for (const m of css.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      colors.add('#' + m[1].toLowerCase());
    }
    return [...colors];
  } catch {
    return [];
  }
}

/** Find the first same-origin stylesheet URL in <head>. */
function findExternalCssUrl(doc, baseUrl) {
  for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute('href') || '';
    try {
      const abs = new URL(href, baseUrl);
      if (abs.hostname === new URL(baseUrl).hostname) return abs.href;
    } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// BFS crawler — smart selection, faithful page extract
// ---------------------------------------------------------------------------

async function crawlSite(baseUrl, limit, cookieJar = new Map()) {
  const visited = new Set();
  const discovered = new Set();
  const queue = [baseUrl + '/'];
  const pages = [];
  const softDups = [];
  const skippedBudget = [];
  const skippedNonHtml = [];
  const fingerprints = new Map(); // hash → first path
  const categoryCounts = Object.fromEntries(Object.keys(CATEGORY_BUDGETS).map((k) => [k, 0]));
  // Paths the site's own nav files under a services/treatments section. Filled
  // from the homepage nav tree on the first page, so it is available for every
  // queue decision after that.
  let navServicePaths = new Set();
  // URLs a category budget turned away. They are NOT marked visited, so the
  // spillover pass below can reconsider them while `limit` still has room.
  const deferred = [];
  let spillover = false;

  const normPath = (p) => String(p || '/').replace(/\/+$/, '') || '/';
  /** categorizePath, plus what the nav says. */
  const categoryFor = (path) =>
    (navServicePaths.has(normPath(path)) ? 'services' : categorizePath(path));
  /** linkPriority, plus what the nav says — service pages should be fetched early. */
  const priorityFor = (href) => {
    let p = '/';
    try { p = new URL(href).pathname; } catch { /* keep */ }
    return navServicePaths.has(normPath(p)) ? 1 : linkPriority(href);
  };
  // Blog posts are ported verbatim and never AI-extracted, so they cost a fetch
  // and nothing else. Only reference pages are charged against `limit`; blog is
  // bounded by its own category budget instead.
  let corePageCount = 0;
  let sitemapUrlCount = 0;
  const navHrefs = [];

  function normalizeHref(abs, origin) {
    let href = abs.origin + abs.pathname;
    if (href !== `${origin}/` && href !== origin && href.endsWith('/')) {
      href = href.slice(0, -1);
    }
    return href;
  }

  function enqueue(href) {
    if (visited.has(href) || discovered.has(href)) return;
    try {
      const p = new URL(href).pathname;
      if (NON_HTML_EXT.test(p)) {
        skippedNonHtml.push(href);
        return;
      }
      // Admin/auth/feed endpoints are not reference material at any budget. The
      // spillover pass below would otherwise admit them the moment `limit` had
      // room, which is how /feed and /wp-login.php reached the reference set.
      if (isJunkPath(p)) {
        skippedNonHtml.push(href);
        return;
      }
    } catch { return; }
    discovered.add(href);
    queue.push(href);
    queue.sort((a, b) => priorityFor(a) - priorityFor(b));
  }

  // Seed from sitemap (selection aid — does not change page extract fidelity)
  try {
    const smUrls = await fetchSitemapUrls(baseUrl, {
      limit: Math.max(limit * 4, 200),
    });
    sitemapUrlCount = smUrls.length;
    if (smUrls.length) {
      console.log(`[scraper] Sitemap: ${smUrls.length} URL(s) seeded`);
      for (const u of smUrls) enqueue(u);
    }
  } catch (err) {
    console.warn(`[scraper] Sitemap seed skipped: ${err.message}`);
  }

  async function processUrl(url) {
    if (visited.has(url)) return [];

    let path = '/';
    try { path = new URL(url).pathname || '/'; } catch { /* */ }
    const category = categoryFor(path);
    const isBlog = category === 'blog';

    if (!isBlog && corePageCount >= limit) return [];

    const budget = CATEGORY_BUDGETS[category] ?? CATEGORY_BUDGETS.other;

    // A category budget bounds that category's *share* of `limit`; it is not a
    // reason to leave `limit` unspent. Defer instead of dropping, and leave the
    // URL unvisited so the spillover pass can pick it up. Dropping here left
    // lbpds at 24 core pages against limit=50 while discarding 22 real pages —
    // 15 of them service pages — with 26 slots never used.
    if ((categoryCounts[category] || 0) >= budget) {
      // Spillover lifts the cap for categories we can name, but never for
      // `other` — including pages discovered *during* the drain, which would
      // otherwise walk straight past the rule via the bypass.
      if (!spillover || category === 'other') {
        deferred.push({ url, path, category });
        return [];
      }
    }

    visited.add(url);
    // Reserve budget slot synchronously BEFORE await (avoids concurrency overshoot)
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    let fetchResult;
    try { fetchResult = await fetchPage(url, { cookieJar }); } catch {
      categoryCounts[category] -= 1;
      return [];
    }

    const { html, status } = fetchResult;
    if (status !== 200 || !html) {
      categoryCounts[category] -= 1;
      return [];
    }

    if (NON_HTML_EXT.test(path)) {
      skippedNonHtml.push(url);
      categoryCounts[category] -= 1;
      return [];
    }

    const cleanHtml = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    let dom;
    try { dom = new JSDOM(cleanHtml); } catch {
      categoryCounts[category] -= 1;
      return [];
    }

    const doc = dom.window.document;
    const page = extractRawPage(doc, url, html);
    const fp = contentFingerprint(page);

    if (fp && fingerprints.has(fp) && pages.length > 0) {
      softDups.push({
        url: page.url,
        path: page.path,
        softDupOf: fingerprints.get(fp),
        title: page.title,
        wordCount: page.wordCount,
      });
      categoryCounts[category] -= 1;
      return [];
    }
    if (fp) fingerprints.set(fp, page.path);

    pages.push(page);
    if (!isBlog) corePageCount += 1;

    if (pages.length === 1) {
      // Learn what the site calls a service before spending the crawl budget.
      // The dropdown hierarchy is the only place a page like /retention.php
      // declares itself a treatment page.
      try {
        const hints = serviceSectionPaths(extractNavTree(doc, baseUrl));
        if (hints.size) {
          navServicePaths = hints;
          queue.sort((a, b) => priorityFor(a) - priorityFor(b));
          console.log(`[scraper] Nav declares ${hints.size} service page(s) beyond path matching`);
        }
      } catch (err) {
        console.warn(`[scraper] Nav service hints skipped: ${err.message}`);
      }
      for (const a of doc.querySelectorAll('nav a[href], header a[href]')) {
        const rawHref = a.getAttribute('href') || '';
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) continue;
        try {
          const abs = new URL(rawHref, url);
          if (abs.hostname !== new URL(baseUrl).hostname) continue;
          const href = normalizeHref(abs, baseUrl);
          navHrefs.push(href);
          enqueue(href);
        } catch { /* skip */ }
      }
    }

    const baseHost = new URL(baseUrl).hostname;
    const newLinks = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const rawHref = a.getAttribute('href') || '';
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) continue;
      let abs;
      try { abs = new URL(rawHref, url); } catch { continue; }
      if (abs.hostname !== baseHost) continue;
      if (NON_HTML_EXT.test(abs.pathname)) {
        skippedNonHtml.push(abs.href);
        continue;
      }
      const href = normalizeHref(abs, baseUrl);
      if (!visited.has(href) && !discovered.has(href)) newLinks.push(href);
    }
    return newLinks;
  }

  // Keep going while either budget has room. Once the core limit is reached,
  // remaining non-blog URLs are spliced off and return immediately without a
  // fetch, so the drain is cheap.
  while (queue.length > 0 && (corePageCount < limit || categoryCounts.blog < CATEGORY_BUDGETS.blog)) {
    const batch = queue.splice(0, CONCURRENCY);
    const newLinks = await Promise.all(batch.map((u) => processUrl(u)));
    for (const links of newLinks) {
      for (const href of links) enqueue(href);
    }
  }

  // Spillover: the per-category caps have done their job of stopping any one
  // category from eating the crawl. Whatever `limit` is still unspent now goes
  // to the pages they turned away, best-priority first.
  // `other` is the "no idea what this is" bucket, and its budget of 6 is the only
  // thing bounding it. Spilling into it flooded the reference set with archive
  // listings and untagged blog posts — azortho went from 35 to 50 reference pages
  // where 15 of the additions were posts, all of which reach the Content Map and
  // Content Write prompts. Recovering a real page has to mean recovering a page
  // we can name, so spillover skips `other` and leaves it exactly as bounded as
  // it was before. lbpds' 15 service pages are unaffected: the nav hints
  // reclassify them as `services` before the budget ever sees them.
  const spillable = deferred.filter((d) => d.category !== 'other');
  if (spillable.length && corePageCount < limit) {
    const held = deferred.length - spillable.length;
    console.log(`[scraper] Budget spillover: ${spillable.length} deferred, ${limit - corePageCount} slot(s) free`
      + (held ? ` (${held} 'other' held back)` : ''));
    spillover = true;
    for (const d of spillable.sort((a, b) => priorityFor(a.url) - priorityFor(b.url))) {
      // Bypass `enqueue`: these are already in `discovered`, which it guards on.
      if (!visited.has(d.url)) queue.push(d.url);
    }
    while (queue.length > 0 && corePageCount < limit) {
      const batch = queue.splice(0, CONCURRENCY);
      const newLinks = await Promise.all(batch.map((u) => processUrl(u)));
      for (const links of newLinks) {
        for (const href of links) enqueue(href);
      }
    }
  }

  // Report what was actually lost, not what was momentarily deferred, and name
  // the reason that actually applied: `other` is bounded by policy whatever the
  // limit did, and anything else left over ran out of `limit`.
  const seenSkip = new Set();
  for (const d of deferred) {
    if (visited.has(d.url) || seenSkip.has(d.url)) continue;
    seenSkip.add(d.url);
    skippedBudget.push({
      url: d.url, path: d.path, category: d.category,
      reason: d.category === 'other' ? 'category_budget'
        : (corePageCount >= limit ? 'limit_reached' : 'category_budget'),
    });
  }

  if (pages[0] && navHrefs.length < 5) {
    for (const l of pages[0].internalLinks || []) {
      try {
        const abs = new URL(l.href, baseUrl);
        navHrefs.push(normalizeHref(abs, baseUrl));
      } catch { /* */ }
    }
  }

  // Prefer nav tree from later siteAssets build; coverage uses navHrefs collected here
  const coverage = buildCoverageReport({
    baseUrl,
    pages,
    navHrefs,
    discoveredUrls: Array.from(discovered),
    softDups,
    skippedBudget,
    skippedNonHtml: [...new Set(skippedNonHtml)].slice(0, 50),
    sitemapUrlCount,
    limit,
    serviceHints: navServicePaths,
  });

  return {
    pages,
    visitedUrls: Array.from(visited),
    discoveredUrls: Array.from(discovered),
    softDups,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Crawl a website and return raw bronze data — no interpretation, no mapping.
 *
 * @param {string} url          - Practice website URL
 * @param {object} [opts]
 * @param {number} [opts.limit] - Max pages to crawl (default 30)
 * @returns {Promise<BronzeData>}
 */
export async function scrape(url, opts = {}) {
  let baseUrl = url.replace(/\/+$/, '');
  const limit   = opts.limit || DEFAULT_LIMIT;
  const cookieJar = new Map();

  // Resolve any www/https redirect before crawling so link discovery uses
  // the correct origin (e.g. springstdentistry.com → www.springstdentistry.com).
  // Also fail-fast on bot walls / empty hosts before a long BFS.
  let probe;
  try {
    probe = await fetchPage(baseUrl + '/', { cookieJar });
    const finalOrigin = new URL(probe.finalUrl).origin;
    if (finalOrigin !== new URL(baseUrl).origin) {
      console.log(`[scraper] Redirect detected: ${baseUrl} → ${finalOrigin}`);
      baseUrl = finalOrigin;
    }
  } catch (err) {
    const kind = classifyHomepage({ error: err });
    const e = new Error(`Homepage probe failed (${kind}): ${err.message}`);
    e.code = 'UNABLE_TO_SCRAPE';
    e.scrapeKind = kind;
    throw e;
  }

  const kind = classifyHomepage(probe);
  if (isScrapeFailure(kind)) {
    const e = new Error(`Homepage classified as ${kind} (status=${probe.status}, bytes=${(probe.html || '').length}) — skipping crawl`);
    e.code = 'UNABLE_TO_SCRAPE';
    e.scrapeKind = kind;
    e.httpStatus = probe.status;
    throw e;
  }

  console.log(`[scraper] Crawling ${baseUrl} (limit: ${limit} pages)...`);

  const { pages, visitedUrls, discoveredUrls, softDups = [], coverage: crawlCoverage } = await crawlSite(baseUrl, limit, cookieJar);

  if (!pages.length) {
    const e = new Error('Crawl completed with 0 pages after successful homepage probe');
    e.code = 'UNABLE_TO_SCRAPE';
    e.scrapeKind = 'empty';
    throw e;
  }

  console.log(`[scraper] Crawled ${pages.length} unique pages, discovered ${discoveredUrls.length} links, softDups=${softDups.length}.`);

  // Site-level assets — parse from homepage
  const homepage = pages[0] ? new JSDOM(
    // Re-fetch not needed — use the already-parsed bodyText... actually we need
    // nav from the first page DOM. Re-use rawHtml isn't available here, so we
    // derive navigation from internalLinks on the homepage instead.
    ''
  ) : null;

  // Flat navigation fallback: deduplicate internal links from homepage in order
  const navigationFlat = pages[0]
    ? [...new Map(pages[0].internalLinks.map(l => [l.href, l])).values()].slice(0, 20)
    : [];

  // Social links: aggregate from all pages
  const socialLinks = [
    ...new Set(
      pages.flatMap(p => p.externalLinks.filter(l => l.social).map(l => l.href))
    ),
  ];

  // Homepage-derived assets: nav TREE + CSS colors. One refetch, reused.
  let cssColors = [];
  let externalCssUrl = null;
  let navTree = [];
  try {
    const { html: homeHtml } = await fetchPage(baseUrl + '/', { cookieJar });
    // Keep <style> for nav parse but strip for color extraction separately
    const navDom = new JSDOM(homeHtml.replace(/<script[\s\S]*?<\/script>/gi, ''));
    navTree = extractNavTree(navDom.window.document, baseUrl);
    if (navTree.length) {
      const childCount = navTree.reduce((n, x) => n + (x.children?.length || 0), 0);
      console.log(`[scraper] Nav tree: ${navTree.length} top-level, ${childCount} child links`);
    }
    const cleanHome = homeHtml.replace(/<style[\s\S]*?<\/style>/gi, '');
    const homeDom = new JSDOM(cleanHome);
    externalCssUrl = findExternalCssUrl(homeDom.window.document, baseUrl);
    if (externalCssUrl) {
      cssColors = await extractCssColors(externalCssUrl);
      if (cssColors.length) {
        console.log(`[scraper] Extracted ${cssColors.length} raw colors from ${externalCssUrl}`);
      }
    }
  } catch { /* non-fatal */ }

  // Prefer the structured nav tree; fall back to flat list if tree came up empty.
  const navigation = navTree.length ? navTree : navigationFlat;

  // Optional Playwright design capture (screenshots / computed tokens).
  // OFF by default: rebuild fonts come from catalog/curated pairings, not the
  // practice CMS. Colors already come from CSS. Opt in with captureScreenshots: true.
  let screenshots = [];
  let designTokens = null;
  if (opts.captureScreenshots === true) {
    try {
      const { captureDesign } = await import('./ai-silver/design-capture.js');
      const cap = await captureDesign(baseUrl, { outDir: opts.screenshotDir });
      screenshots = (cap.screenshots || []).map(s => ({ label: s.label, path: s.path || null, mediaType: s.mediaType }));
      designTokens = cap.tokens || null;
      if (screenshots.length) console.log(`[scraper] Captured ${screenshots.length} design screenshot(s) + tokens`);
    } catch (err) {
      console.warn(`[scraper] Design capture skipped: ${err.message}`);
    }
  }

  // Rebuild coverage with full nav tree (better hit-rate than header-only seed list)
  function walkNav(nodes, acc = []) {
    for (const n of nodes || []) {
      if (n.href) acc.push(n.href);
      if (n.children?.length) walkNav(n.children, acc);
    }
    return acc;
  }
  const navFromTree = walkNav(navTree);
  // This report REPLACES the crawl-time one, so the service hints have to be
  // supplied again here or the honest denominator is silently thrown away —
  // which is exactly what happened on the first pass at this fix. Recompute
  // from `navTree`: it is the fuller tree, so the hints are at least as good as
  // the crawl's.
  const coverage = buildCoverageReport({
    baseUrl,
    pages,
    navHrefs: navFromTree.length ? navFromTree : (crawlCoverage?.skippedByPriority ? [] : navigationFlat.map((l) => l.href)),
    discoveredUrls,
    softDups,
    skippedBudget: crawlCoverage?.skippedBudget || [],
    skippedNonHtml: crawlCoverage?.skippedNonHtml || [],
    sitemapUrlCount: crawlCoverage?.sitemapUrlCount || 0,
    limit,
    serviceHints: serviceSectionPaths(navTree),
  });
  // Merge skip lists / priority list from crawl-time report when nav rebuild lacks them
  if (crawlCoverage?.skippedByPriority?.length && !coverage.skippedByPriority?.length) {
    coverage.skippedByPriority = crawlCoverage.skippedByPriority;
  }
  printCoverageReport(coverage);

  return {
    baseUrl,
    crawledAt: new Date().toISOString(),
    pageCount: pages.length,
    pages,
    softDups,
    coverage,
    siteAssets: {
      navigation,
      navigationTree: navTree,
      navigationFlat,
      socialLinks,
      cssColors,
      externalCssUrl,
      allUrls: visitedUrls.sort(),
      screenshots,
      designTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// BronzeData type (JSDoc reference)
// ---------------------------------------------------------------------------
/**
 * @typedef {object} BronzePage
 * @property {string}   url
 * @property {string}   path
 * @property {string}   title
 * @property {string}   metaDescription
 * @property {string}   metaKeywords
 * @property {string|null} canonicalUrl
 * @property {{ level: number, text: string }[]} headings
 * @property {object[]} contentBlocks  document-order blocks: heading|paragraph|list|table
 * @property {{ heading: object|null, blocks: object[] }[]} sections  blocks grouped under headings
 * @property {string[]} heroTexts
 * @property {string[]} paragraphs
 * @property {{ src: string, alt: string }[]} images
 * @property {{ href: string, text: string }[]} internalLinks
 * @property {{ href: string, text: string, social: boolean }[]} externalLinks
 * @property {object[]} structuredData
 * @property {string}   bodyText
 * @property {number}   wordCount
 *
 * @typedef {object} BronzeData
 * @property {string}      baseUrl
 * @property {string}      crawledAt
 * @property {number}      pageCount
 * @property {BronzePage[]} pages
 * @property {object[]}    [softDups]
 * @property {object}      [coverage]
 * @property {{ navigation: object[], socialLinks: string[], cssColors: string[], externalCssUrl: string|null, allUrls: string[] }} siteAssets
 */
