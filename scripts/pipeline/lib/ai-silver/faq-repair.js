/**
 * Deterministic FAQ recovery for pages that declare an FAQ block and returned
 * nothing.
 *
 * The faqs prompt already says "EVERY Q+A — do not skip any", and on
 * arts-family it obeyed on 8 of 9 FAQ-bearing pages. The ninth,
 * /dental-implants.html, has 4140 words, an explicit "Dental Implant FAQs"
 * heading, prose reading "read the answers to a few of our most frequently
 * asked dental implant questions below", and 10 question headings — and
 * contributed zero FAQs. A prompt rule is advisory; where the outcome is
 * measurable, it needs a repair that does not depend on the model complying.
 *
 * Scope is deliberately narrow. Only pages that BOTH declare an FAQ section in
 * prose and carry several question headings, and that contributed nothing, are
 * harvested. Broadening it to every `?` heading would sweep in the section
 * headers the model is right to skip — "What Is Gum Recontouring?", "Why Choose
 * Us for Orthodontics?" — and pad content.faqs with marketing copy.
 */

const FAQ_MARKER = /frequently\s+asked|\bFAQs?\b/i;
const IS_QUESTION = /\?\s*$/;
/** Shorter than this and the heading has no real answer under it. */
const MIN_ANSWER_CHARS = 40;

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isQuestionHeading = (level, text) =>
  (level === 2 || level === 3) && IS_QUESTION.test(String(text || ''));

function blockText(block) {
  if (!block) return '';
  if (block.type === 'paragraph') return String(block.text || '');
  if (block.type === 'list' && Array.isArray(block.items)) return block.items.join('\n');
  return '';
}

/**
 * Every question heading on the page paired with the prose beneath it.
 *
 * Prefers `sections`, where the crawler has already grouped each heading with
 * its own blocks. Falls back to walking `contentBlocks` until the next heading.
 *
 * @param {object} page bronze page
 * @returns {{question:string, answer:string, source:string, origin:string}[]}
 */
export function harvestFaqs(page) {
  if (!page) return [];
  const out = [];

  /**
   * An FAQ answer is prose. A question-shaped heading over nothing but a bullet
   * list is a sales panel: on /dental-implants.html, "Why Choose Arts Family
   * Dentistry of Dallas for Dental Implants?" sits on a single `list` of selling
   * points, while all 10 real answers carry a 400-700 character paragraph. That
   * one distinction is the whole difference between recovering the FAQ block and
   * padding it with marketing copy.
   */
  const push = (question, blocks) => {
    const paragraphs = blocks.filter((b) => b?.type === 'paragraph' && String(b.text || '').trim());
    if (!paragraphs.length) return;
    const answer = blocks.map(blockText).filter(Boolean).join('\n\n').trim();
    if (answer.length < MIN_ANSWER_CHARS) return;
    out.push({
      question: String(question).trim(),
      answer,
      source: page.path,
      origin: 'bronze-repair',
    });
  };

  const sections = Array.isArray(page.sections) ? page.sections : [];
  for (const section of sections) {
    const h = section.heading;
    if (!h || !isQuestionHeading(h.level, h.text)) continue;
    push(h.text, section.blocks || []);
  }
  if (out.length) return dedupe(out);

  const blocks = Array.isArray(page.contentBlocks) ? page.contentBlocks : [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'heading' || !isQuestionHeading(b.level, b.text)) continue;
    const answer = [];
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[j].type === 'heading') break;
      answer.push(blocks[j]);
    }
    push(b.text, answer);
  }
  return dedupe(out);
}

function dedupe(faqs) {
  const seen = new Set();
  return faqs.filter((f) => {
    const k = key(f.question);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A page that says it has an FAQ section and has the headings to match. */
export function declaresFaqSection(page) {
  if (!FAQ_MARKER.test(page.bodyText || '')) return false;
  const qs = (page.headings || []).filter((h) => isQuestionHeading(h.level, h.text));
  return qs.length >= 3;
}

/**
 * Fill in FAQs for declared-FAQ pages the model returned nothing for.
 *
 * Mutates `silver.content.faqs`. Returns what it did so the caller can log and
 * flag it — a repair that fires silently is a model regression nobody notices.
 *
 * @param {object} silver merged silver (post-mergeSlice)
 * @param {object[]} refPages reference bronze pages (blog already excluded)
 * @returns {{repaired: {path:string, added:number}[], added: number}}
 */
export function repairFaqs(silver, refPages = []) {
  const faqs = Array.isArray(silver?.content?.faqs) ? silver.content.faqs : [];
  const covered = new Set(faqs.map((f) => String(f.source || f.sourcePath || '').replace(/\/+$/, '')));
  const questionKeys = new Set(faqs.map((f) => key(f.question)));
  const repaired = [];

  for (const page of refPages) {
    if (!declaresFaqSection(page)) continue;
    const path = String(page.path || '').replace(/\/+$/, '');
    if (covered.has(path)) continue;
    // The pass may have extracted these without labelling a source; matching on
    // the questions themselves keeps the repair from duplicating them.
    const harvested = harvestFaqs(page).filter((f) => !questionKeys.has(key(f.question)));
    if (!harvested.length) continue;

    for (const f of harvested) questionKeys.add(key(f.question));
    faqs.push(...harvested);
    repaired.push({ path: page.path, added: harvested.length });
  }

  if (repaired.length) {
    silver.content.faqs = faqs;
    silver.meta = silver.meta || {};
    silver.meta.confidenceFlags = silver.meta.confidenceFlags || [];
    silver.meta.confidenceFlags.push(
      `faq-repair: recovered ${repaired.reduce((n, r) => n + r.added, 0)} Q+A from `
      + `${repaired.length} page(s) the faqs pass returned nothing for (${repaired.map((r) => r.path).join(', ')})`,
    );
  }
  return { repaired, added: repaired.reduce((n, r) => n + r.added, 0) };
}
