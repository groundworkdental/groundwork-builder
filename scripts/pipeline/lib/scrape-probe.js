/**
 * scrape-probe.js — homepage fail-fast + challenge classification.
 *
 * Used before a full BFS crawl so bot walls / empty hosts fail in <30s
 * instead of burning a long crawl then dying at empty silver.
 */

/** Closest renderable enums for novel catalog "variants" that aren't on disk. */
export const VARIANT_ENUMS = {
  heroLayout: new Set(['centered', 'poster', 'split-offset', 'split', 'text-only']),
  servicesLayout: new Set(['accordion', 'alternating-rows', 'card-grid', 'numbered-list', 'two-col-feature']),
  aboutLayout: new Set(['editorial-full', 'full-width-card', 'minimal-text', 'split-photo', 'two-col-brief']),
  testimonialsLayout: new Set(['card-row', 'grid-mosaic', 'list-testimonials', 'pull-quotes', 'single-featured']),
  ctaLayout: new Set(['centered-banner', 'floating-card', 'inline-minimal', 'split-image', 'two-button']),
  faqLayout: new Set(['accordion-expandable', 'cards-grid', 'simple-stack', 'split-by-category', 'two-column']),
  navVariant: new Set(['centered-logo', 'split-logo', 'transparent-overlay', 'left-logo', 'top-bar']),
  footerVariant: new Set(['minimal-dark', 'editorial-split', 'classic-4col', 'bold-cta-footer']),
  galleryVariant: new Set(['editorial-2col', 'full-bleed-row', 'filmstrip', 'masonry-3col', 'featured-grid']),
};

const VARIANT_DEFAULTS = {
  heroLayout: 'split',
  servicesLayout: 'card-grid',
  aboutLayout: 'split-photo',
  testimonialsLayout: 'card-row',
  ctaLayout: 'centered-banner',
  faqLayout: 'accordion-expandable',
  navVariant: 'left-logo',
  footerVariant: 'classic-4col',
  galleryVariant: 'featured-grid',
};

/** Heuristic nearest-neighbor for novel catalog names → on-disk variants. */
const VARIANT_ALIASES = {
  heroLayout: {
    'asymmetric-split-with-image-card': 'split-offset',
    'centered-scattered-collage': 'centered',
    'left-aligned-with-abstract-art': 'split',
    'full-bleed-photo-card': 'poster',
    'split-image-right': 'split',
    'magazine-split': 'split-offset',
  },
  servicesLayout: {
    'category-cards': 'card-grid',
    'program-cards-3col': 'card-grid',
    'bento-grid': 'card-grid',
    'bento-photo-grid': 'card-grid',
    'card-rows': 'alternating-rows',
    'image-overlay-cards': 'card-grid',
    'tabbed-package-panel': 'two-col-feature',
  },
  aboutLayout: {
    'centered-text-full-bleed-image': 'full-width-card',
    'author-feature': 'editorial-full',
    'magazine-split': 'split-photo',
    'portrait-grid': 'two-col-brief',
    'centered-team-grid': 'two-col-brief',
    'not-present': 'minimal-text',
  },
  testimonialsLayout: {
    'scattered-collage': 'grid-mosaic',
    'compact-4col-cards': 'card-row',
    'photo-cards-with-stat-overlay': 'grid-mosaic',
    'founder-quote': 'single-featured',
    'asymmetric-masonry': 'grid-mosaic',
    'grid-plus-featured-split': 'grid-mosaic',
    'none-visible': 'pull-quotes',
  },
  ctaLayout: {
    'statement-headline-with-inline-form': 'inline-minimal',
    'single-outline-button': 'two-button',
    'single-button': 'centered-banner',
    'single-button-centered': 'centered-banner',
    'dark-band-email-capture': 'centered-banner',
    'single-cta-strip': 'inline-minimal',
  },
  faqLayout: {
    'none-visible': 'simple-stack',
    none: 'simple-stack',
    'not-present': 'simple-stack',
    'split-image-accordion': 'accordion-expandable',
  },
  navVariant: {
    'three-zone-hamburger': 'left-logo',
    'minimal-logo-left': 'left-logo',
    'contained-rounded-card': 'split-logo',
    'logo-left-cta-right': 'left-logo',
    'stacked-logo-center-links': 'centered-logo',
    'logo-left-links-center-cta-right': 'split-logo',
  },
  footerVariant: {
    'minimal-light': 'minimal-dark',
    'multi-column-light': 'classic-4col',
  },
  galleryVariant: {
    'scattered-float': 'masonry-3col',
    '2col-image-article-cards': 'editorial-2col',
    'portrait-cards-row': 'filmstrip',
    'asymmetric-mosaic': 'masonry-3col',
    'wide-single-image': 'full-bleed-row',
    'not-present': 'featured-grid',
    none: 'featured-grid',
  },
};

/**
 * Clamp a layout.variants map to renderable on-disk enums.
 * @returns {{ variants: object, remapped: Array<{key,from,to}> }}
 */
export function clampVariantMap(variants = {}) {
  const out = { ...variants };
  const remapped = [];
  for (const [key, allowed] of Object.entries(VARIANT_ENUMS)) {
    const raw = out[key];
    if (!raw) {
      out[key] = VARIANT_DEFAULTS[key];
      remapped.push({ key, from: null, to: out[key] });
      continue;
    }
    if (allowed.has(raw)) continue;
    const alias = VARIANT_ALIASES[key]?.[raw];
    const to = alias && allowed.has(alias) ? alias : VARIANT_DEFAULTS[key];
    remapped.push({ key, from: raw, to });
    out[key] = to;
  }
  return { variants: out, remapped };
}

/**
 * OpenSSL codes that mean "this chain cannot be built from our trust store",
 * not "this site is broken". A server that omits its intermediate certificate
 * is served fine by every browser and by curl — both fall back to the system
 * store or fetch the missing link via AIA — while Node's stricter verification
 * refuses outright. butterflybraces.com and changorthodontics.com both return
 * 200 to curl and fail here, and both were being written off as dead sites.
 */
const TLS_CHAIN_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** Node buries the real code in error.cause, sometimes more than one deep. */
function causeCodes(error, depth = 4) {
  const codes = [];
  let cur = error;
  while (cur && depth-- > 0) {
    if (cur.code) codes.push(String(cur.code));
    cur = cur.cause;
  }
  return codes;
}

/**
 * Classify homepage HTML / status into a scrape outcome.
 * @returns {'ok'|'empty'|'bot_wall'|'redirect_loop'|'http_error'|'timeout'|'tls_chain_incomplete'}
 */
export function classifyHomepage({ status, html, finalUrl, error } = {}) {
  if (error) {
    const msg = String(error.message || error);
    // Check codes before the message: a TLS failure surfaces as the useless
    // message "fetch failed", so matching on text alone lands in http_error.
    if (causeCodes(error).some((c) => TLS_CHAIN_CODES.has(c))) return 'tls_chain_incomplete';
    if (/abort|timeout/i.test(msg)) return 'timeout';
    if (/redirect count exceeded/i.test(msg)) return 'redirect_loop';
    return 'http_error';
  }
  if (status && status >= 400) return 'http_error';
  const body = String(html || '');
  if (!body || body.trim().length < 200) return 'empty';

  const lower = body.toLowerCase();
  const title = (body.match(/<title[^>]*>([^<]*)/i) || [])[1]?.toLowerCase() || '';
  const hardChallenge = [
    'just a moment',
    'attention required',
    'checking your browser',
    'cf-browser-verification',
    'cf-challenge',
    'are you a robot',
    'access denied',
    'verify you are human',
    'enable javascript and cookies',
    'sucuri_cloudproxy',
  ];
  if (hardChallenge.some((h) => lower.includes(h) || title.includes(h))) return 'bot_wall';

  // Soft empty: challenge cookie pages that are basically a spinner
  const textLen = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (textLen < 80) return 'empty';

  // captcha alone is common on real dental forms — only treat as wall when
  // the page has almost no content (interstitial), not when recaptcha is embedded.
  if ((lower.includes('captcha') || title.includes('captcha')) && textLen < 400) return 'bot_wall';

  return 'ok';
}

export function isScrapeFailure(kind) {
  return kind && kind !== 'ok';
}

/**
 * True when the crawl failed on OUR trust configuration, not on the site.
 *
 * Callers use this to decide whether the practice's sourcing status should be
 * written off. It must not be folded into `isScrapeFailure` — the crawl really
 * did fail and there is no bronze to build from; the point is only that the
 * prospect is alive and should stay in the pipeline.
 */
export function isTlsTrustFailure(kind) {
  return kind === 'tls_chain_incomplete';
}
