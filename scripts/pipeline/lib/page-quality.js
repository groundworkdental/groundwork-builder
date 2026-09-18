/**
 * Page-level quality scoring — deterministic, no AI.
 *
 * Content Map scores *sections*; nothing scored *pages*, so "preserve the good
 * content" had no operational definition and whole pages could vanish without
 * any signal firing.
 *
 * Raw word count is not that definition. Legacy dental sites repeat their nav,
 * footer, hours block, and CTA copy on every page — six pages on this pipeline's
 * reference site were pure homepage boilerplate yet counted 1,718 words each.
 * What matters is how much text a page carries that no other page carries, so
 * blocks are fingerprinted across the crawl and shared ones subtracted before
 * scoring.
 *
 * Consumers: the Architect phase (page dispositions), coverage reporting.
 */

/** Word counts of *unique* body text, not raw text. */
const THRESHOLDS = {
  strong:   300,
  adequate: 120,
  weak:      40,
};

/**
 * A block repeated across this fraction of pages is site chrome, not content.
 * Deliberately low: nav/footer/CTA blocks show up nearly everywhere, and a
 * genuine paragraph almost never repeats across a third of a site.
 */
const BOILERPLATE_PAGE_RATIO = 0.3;
const BOILERPLATE_MIN_PAGES  = 3;

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const wordsIn   = (s) => (String(s || '').match(/\S+/g) || []).length;

/** Flatten a bronze page into comparable text blocks. */
function blocksOf(page) {
  const out = [];
  for (const b of page?.contentBlocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'list') {
      const items = Array.isArray(b.items) ? b.items.join(' ') : '';
      if (items) out.push(items);
    } else if (b.text) {
      out.push(b.text);
    }
  }
  // Older bronze without contentBlocks still has paragraphs/headings.
  if (out.length === 0) {
    for (const p of page?.paragraphs || []) if (p) out.push(p);
    for (const h of page?.headings || []) if (h?.text) out.push(h.text);
  }
  return out;
}

/**
 * Score every page in a crawl.
 *
 * @param {Array}  pages - bronze pages[]
 * @param {object} [opts]
 * @param {Array}  [opts.softDups] - crawl soft-dup records ({ path, softDupOf })
 * @returns {{ pages: Array, byQuality: object, boilerplateBlocks: number }}
 */
export function scorePages(pages, { softDups = [] } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  if (list.length === 0) return { pages: [], byQuality: {}, boilerplateBlocks: 0 };

  // How many distinct pages each block appears on.
  const blockPageCount = new Map();
  const perPageBlocks = new Map();
  for (const page of list) {
    const seen = new Set(blocksOf(page).map(normalize).filter(Boolean));
    perPageBlocks.set(page, seen);
    for (const key of seen) blockPageCount.set(key, (blockPageCount.get(key) || 0) + 1);
  }

  const boilerplateAt = Math.max(BOILERPLATE_MIN_PAGES, Math.ceil(list.length * BOILERPLATE_PAGE_RATIO));
  const isBoilerplate = (key) => (blockPageCount.get(key) || 0) >= boilerplateAt;
  const boilerplateBlocks = [...blockPageCount.keys()].filter(isBoilerplate).length;

  const softDupPaths = new Map(
    (softDups || []).map(d => [String(d.path || '').toLowerCase(), d.softDupOf || null])
  );

  const scored = list.map((page) => {
    const path = page.path || page.url || '';
    const blocks = perPageBlocks.get(page) || new Set();

    let uniqueWords = 0;
    let sharedWords = 0;
    for (const key of blocks) {
      const w = wordsIn(key);
      if (isBoilerplate(key)) sharedWords += w; else uniqueWords += w;
    }
    const totalWords = uniqueWords + sharedWords;

    const softDupOf = softDupPaths.has(path.toLowerCase())
      ? (softDupPaths.get(path.toLowerCase()) || true)
      : null;

    let quality;
    if (softDupOf) quality = 'boilerplate';
    else if (uniqueWords >= THRESHOLDS.strong)   quality = 'strong';
    else if (uniqueWords >= THRESHOLDS.adequate) quality = 'adequate';
    else if (uniqueWords >= THRESHOLDS.weak)     quality = 'weak';
    else quality = 'boilerplate';

    return {
      path,
      title: page.title || null,
      h1: (page.headings || []).find(h => h.level === 1)?.text || null,
      wordCount: page.wordCount ?? totalWords,
      uniqueWords,
      sharedWords,
      sharedRatio: totalWords ? Number((sharedWords / totalWords).toFixed(2)) : 0,
      quality,
      softDupOf,
      // `strong`/`adequate` pages must land somewhere in the rebuild; `weak` may
      // be merged or absorbed; `boilerplate` is safe to drop.
      mustPreserve: quality === 'strong' || quality === 'adequate',
    };
  });

  const byQuality = scored.reduce((acc, p) => {
    acc[p.quality] = (acc[p.quality] || 0) + 1;
    return acc;
  }, {});

  return { pages: scored, byQuality, boilerplateBlocks };
}
