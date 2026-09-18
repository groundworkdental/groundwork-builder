/**
 * Blog migration — deterministic, verbatim port of scraped posts.
 *
 * Blog posts are the practice's own published work. They are ported, not
 * rewritten: an AI pass over them costs tokens, risks drift, and — when it
 * failed — shipped a truncated draft that was strictly worse than the original.
 *
 * Bronze already stores each page as an ordered `contentBlocks[]` of
 * `heading` / `paragraph` / `list` nodes with the site chrome stripped, so
 * rendering markdown from it is a pure function. No network, no model, no cost.
 *
 * Consumer: lib/blog-generator.js
 */

/** Characters that carry meaning in markdown at the start of a line. */
const LEADING_MD = /^(\s*)([-*+>#]|\d+\.)\s/;

/** Escape only what would change the rendered structure. Prose stays untouched. */
function escapeBlockText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(LEADING_MD, (_m, ws, tok) => `${ws}\\${tok} `)
    .trim();
}

/**
 * Dates appear as a bare paragraph directly under the title on most dental CMS
 * templates. Pulling it into frontmatter keeps the post's real publish date
 * instead of stamping every migrated post with the build date.
 */
const DATE_PATTERNS = [
  /^([A-Z][a-z]+ \d{1,2},? \d{4})$/,
  /^(\d{1,2}\/\d{1,2}\/\d{4})$/,
  /^(\d{4}-\d{2}-\d{2})$/,
];

export function parsePostDate(text) {
  const t = String(text || '').trim();
  for (const re of DATE_PATTERNS) {
    if (re.test(t)) {
      const d = new Date(t);
      if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }
  return null;
}

/**
 * Render bronze contentBlocks to markdown.
 *
 * The leading H1 is dropped — the Astro layout renders the title from
 * frontmatter, so keeping it would double the heading. Remaining headings are
 * shifted so the post's own hierarchy sits under that title.
 *
 * @param {Array}  blocks
 * @param {object} [opts]
 * @param {boolean} [opts.dropLeadingH1=true]
 * @returns {{ markdown: string, publishDate: string|null, title: string|null }}
 */
export function renderBlocksToMarkdown(blocks, opts = {}) {
  const { dropLeadingH1 = true } = opts;
  const list = Array.isArray(blocks) ? blocks : [];

  let title = null;
  let publishDate = null;
  const out = [];
  let seenBody = false;

  for (const block of list) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'heading') {
      const text = escapeBlockText(block.text);
      if (!text) continue;
      const level = Number(block.level) || 2;
      if (dropLeadingH1 && level === 1 && title === null) {
        title = String(block.text || '').trim();
        continue;
      }
      // H2 stays H2 under the layout's H1; deeper levels keep their relative depth.
      out.push(`${'#'.repeat(Math.min(Math.max(level, 2), 6))} ${text}`);
      seenBody = true;
      continue;
    }

    if (block.type === 'paragraph') {
      const raw = String(block.text || '').trim();
      if (!raw) continue;
      // Only a date that leads the post is metadata; one mid-article is prose.
      if (!seenBody && publishDate === null) {
        const parsed = parsePostDate(raw);
        if (parsed) { publishDate = parsed; continue; }
      }
      out.push(escapeBlockText(raw));
      seenBody = true;
      continue;
    }

    if (block.type === 'list') {
      const items = Array.isArray(block.items) ? block.items.filter(Boolean) : [];
      if (!items.length) continue;
      const ordered = Boolean(block.ordered);
      out.push(items.map((item, i) => {
        const text = String(item || '').replace(/\s+/g, ' ').trim();
        return `${ordered ? `${i + 1}.` : '-'} ${text}`;
      }).join('\n'));
      seenBody = true;
    }
  }

  return { markdown: out.join('\n\n').trim(), publishDate, title };
}

/**
 * Trim text to a meta-description length, cutting on a sentence boundary when
 * one falls in range so it doesn't end mid-clause.
 *
 * Every description must go through this, including a source page's own
 * `metaDescription` — legacy CMS meta tags routinely run past 160 characters,
 * and the blog content collection schema rejects anything longer.
 */
export function clampDescription(text, maxLen = 157) {
  const clean = String(text || '').replace(/\s+/g, ' ').replace(/\\([-*+>#])/g, '$1').trim();
  if (!clean) return null;
  if (clean.length <= maxLen) return clean;

  const cut = clean.slice(0, maxLen);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastStop > maxLen * 0.5) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Derive a meta description from the first substantive paragraph. */
export function deriveDescription(markdown, maxLen = 157) {
  const firstPara = String(markdown || '')
    .split('\n\n')
    .find(b => b && !b.startsWith('#') && !b.startsWith('-') && !/^\d+\./.test(b));
  if (!firstPara) return null;
  return clampDescription(firstPara, maxLen);
}

/**
 * Listing pages, pagination, and taxonomy archives hold only teasers for other
 * posts. Migrating them produces a duplicate-content page stitched from every
 * excerpt on the site.
 *
 * These patterns used to require a `/blog|news|articles` prefix, which assumed
 * every CMS nests its archive under one. Two of the sites measured do not:
 * cutesmiles4kids publishes at /2021/08/31/<slug> with /category/*, /author/* and
 * /2021/01 archives sitting at the root, and azorthodonticcenter puts its index
 * at /patient-resources/blog. So the archive shapes are matched wherever they
 * sit, and the index is matched as a trailing path segment rather than only at
 * the root. A slug merely ending in "-blog" is unaffected: the index pattern
 * requires a slash immediately before it.
 */
const NON_POST_PATH = new RegExp(
  [
    '(?:^|/)(?:blog|news|articles?)/?$',                                   // the index, at any depth
    '/page/\\d+',                                                          // pagination, anywhere
    '(?:^|/)(?:category|categories|tag|tags|author|authors|archive)s?(?:/|$)', // taxonomy archives
    '^/(?:19|20)\\d{2}(?:/(?:0?[1-9]|1[0-2]))?/?$',                        // date archives: /2021, /2021/01
  ].join('|'),
  'i'
);

/** True when a path is an individual post rather than an index/archive. */
export function isPostPath(path = '') {
  const p = String(path || '').split(/[?#]/)[0];
  if (!p) return false;
  return !NON_POST_PATH.test(p.replace(/\/+$/, '') || '/');
}

/** Slug from the original URL path — preserved exactly so redirects stay identity. */
export function slugFromPath(path) {
  return String(path || '')
    .replace(/^\/(?:blog|articles?|news)\//i, '')
    .replace(/\/$/, '')
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase() || 'post';
}

/** Best-guess topical category from slug + title. */
export function guessCategory(slug = '', title = '') {
  const s = `${slug} ${title}`;
  if (/implant/i.test(s)) return 'implants';
  if (/cosmetic|whiten|veneer|invisalign|smile/i.test(s)) return 'cosmetic';
  if (/crown|bridge|filling|restor|denture/i.test(s)) return 'restorative';
  if (/gum|perio|hygiene|clean|checkup/i.test(s)) return 'oral-health';
  return 'general-dentistry';
}

/**
 * Port one scraped page into a blog post record.
 *
 * @param {object} page - Bronze page (needs contentBlocks; falls back to paragraphs)
 * @returns {{ slug, title, description, publishDate, category, markdown, wordCount }|null}
 *          null when the page has too little body to be a real post.
 */
export function migratePost(page, { minWords = 50 } = {}) {
  if (!page) return null;
  if (!isPostPath(page.path || page.url || '')) return null;

  let blocks = Array.isArray(page.contentBlocks) ? page.contentBlocks : [];
  // Older bronze captured paragraphs without contentBlocks — still portable.
  if (!blocks.length && Array.isArray(page.paragraphs) && page.paragraphs.length) {
    blocks = page.paragraphs.map(text => ({ type: 'paragraph', text }));
  }
  if (!blocks.length) return null;

  const { markdown, publishDate, title: h1 } = renderBlocksToMarkdown(blocks);
  const wordCount = markdown ? markdown.split(/\s+/).filter(Boolean).length : 0;
  if (wordCount < minWords) return null;

  const path = page.path || page.url || '';
  const slug = slugFromPath(path);
  const title = h1 || page.h1 || page.title || slug.replace(/-/g, ' ');

  return {
    slug,
    title,
    description: clampDescription(page.metaDescription) || deriveDescription(markdown),
    publishDate,
    category: guessCategory(slug, title),
    markdown,
    wordCount,
    sourcePath: path,
  };
}
