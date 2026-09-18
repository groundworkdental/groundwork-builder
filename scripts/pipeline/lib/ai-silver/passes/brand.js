/**
 * Pass: brand — colors, logo, tagline from the original site.
 *
 * Fonts are NOT taken from the practice CMS. Downstream brand-dna / catalog
 * `--reference` / curated pairings choose validated type. This pass only
 * extracts aesthetic cues we keep: palette, logo, tagline.
 */

import { loadPrompt, fillTemplate, runPassCall, renderPagesAsContext, MODELS } from '../shared.js';

export const name = 'brand';

export function selectPages(bronze) {
  const home = bronze.pages.find(p => p.path === '/' || p.path === '');
  return home ? [home] : [];
}

export async function run({ bronze, pages }) {
  if (pages.length === 0) return {};
  const tmpl = await loadPrompt('brand');
  const prompt = fillTemplate(tmpl, {
    baseUrl: bronze.baseUrl,
    pageContext: renderPagesAsContext(pages, { bodyChars: 4000, paragraphs: 10, images: 20, includeJsonLd: false }),
    cssColors: JSON.stringify((bronze.siteAssets?.cssColors || []).slice(0, 40), null, 2),
    cssUrl: bronze.siteAssets?.externalCssUrl || null,
  });
  const { slice } = await runPassCall({ name, model: MODELS.cheap, prompt, maxTokens: 2000 });

  // Never carry CMS typefaces into silver — typography is chosen later
  slice.brand = slice.brand || {};
  slice.brand.fonts = { heading: null, body: null };

  return slice;
}
