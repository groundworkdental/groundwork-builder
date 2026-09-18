/**
 * Pass: content — hero copy, about/mission/philosophy text, additionalContent
 * rescue from pages whose distinctive copy doesn't fit other buckets.
 */

import { loadPrompt, fillTemplate, runPassCall, renderPagesAsContext, pagesMatching, MODELS } from '../shared.js';

export const name = 'content';

const PATTERNS = [
  /^\/$/, /\/index/, /\/home/,
  /\/about/, /\/our[-_]?(office|practice|mission|philosophy|approach|story)/,
  /\/why[-_]?us/, /\/welcome/,
  /\/technology/, /\/care[-_]?philosophy/,
];

export function selectPages(bronze) {
  const matched = pagesMatching(bronze.pages, PATTERNS);
  const home = bronze.pages.find(p => p.path === '/' || p.path === '');
  const set = new Set(matched);
  if (home) set.add(home);
  // Also include any page with high word count that isn't a contact/team/services page
  const exclude = /faq|insurance|financial|payment|contact|team|staff|doctor|service|treatment|appointment|review|testimonial/i;
  for (const p of bronze.pages) {
    if (set.has(p)) continue;
    if (exclude.test(p.path)) continue;
    if ((p.wordCount || 0) > 400) set.add(p);
  }
  return Array.from(set);
}

export async function run({ bronze, pages }) {
  if (pages.length === 0) return {};

  // Collect links that look like patient forms (PDFs, /forms, online form hosts)
  const formLinks = [];
  const seenForm = new Set();
  const FORM_RE = /(form|\.pdf|patient[-_]?(registration|paperwork)|new[-_]?patient|anywheredo|registration)/i;
  for (const p of bronze.pages) {
    for (const l of [...(p.internalLinks || []), ...(p.externalLinks || [])]) {
      const href = l.href || '';
      const text = l.text || '';
      if (FORM_RE.test(href) || FORM_RE.test(text)) {
        const key = href || text;
        if (!seenForm.has(key)) { seenForm.add(key); formLinks.push({ label: text.slice(0, 80), url: href }); }
      }
    }
  }

  // Area-served candidates: city names from page titles/headings on areas-we-serve
  // type pages (the model will refine these)
  const areaHints = [];
  for (const p of bronze.pages) {
    if (/area|serve|location|neighborhood|community|near/i.test(p.path)) {
      for (const h of (p.headings || [])) if (h.text) areaHints.push(h.text);
    }
  }

  // additionalContent ceiling. The flat 12 was binding on 5 of 6 sites measured
  // — every one landed on exactly 12 — so the cap, not the site, was deciding how
  // much verbatim prose survived. 12 was also never the intended figure: the
  // schema catalog documents this bucket as "capped 30 items, ~2200 chars each".
  //
  // Scale with the pages this pass actually reads, since that is the pool the
  // blocks come from, and hold the documented 30 as the ceiling. Consumers draw
  // from this pool by type (doctor / service-page / faq / blog briefs), so a
  // larger pool is filtered down per section rather than pasted into one prompt,
  // and coverage-audit's `additional-content-not-surfaced` check already reports
  // anything rescued here that never reaches the build.
  const acCap = Math.max(12, Math.min(30, pages.length * 2));

  const tmpl = await loadPrompt('content');
  const prompt = fillTemplate(tmpl, {
    baseUrl: bronze.baseUrl,
    pageContext: renderPagesAsContext(pages, { bodyChars: 10000, paragraphs: 60, images: 10, includeJsonLd: false }),
    formLinks: JSON.stringify(formLinks.slice(0, 30), null, 2),
    areaHints: JSON.stringify([...new Set(areaHints)].slice(0, 40), null, 2),
    acCap: String(acCap),
  });
  const { slice } = await runPassCall({ name, model: MODELS.default, prompt, maxTokens: 12000 });
  // Report the ceiling that actually applied. Without it, anything measuring
  // headroom later has to guess the cap, and a guess that drifts from the prompt
  // reports saturation on the wrong number.
  slice.acCap = acCap;
  return slice;
}
