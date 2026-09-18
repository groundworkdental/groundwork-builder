/**
 * Define Brand — brand-dna (visual identity for colors).
 *
 * Input:  merged.currentDesign (observed) + thin identity skill + design floor.
 * Output: { color{roles}, typography{…}, shape, elevation, rationale }
 *
 * Colors: LLM elevates a small identity anchor from the scrape.
 * Typography: always curated pairings (or catalog `--reference`) — never CMS fonts.
 * Shape/elevation: may be overwritten by catalog `--reference`.
 *
 * Does NOT load taste-frontend.md (section craft / generate) or prescribe
 * mood→palette tables — see skills/design.md (identity-only).
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAnthropic, parseJsonStrict, MODELS } from '../ai-silver/shared.js';
import { pickFontPairing } from './font-pairings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT = resolve(__dirname, 'prompts', 'brand-dna.md');
const SKILL_IDENTITY = resolve(__dirname, '..', '..', 'skills', 'design.md');
const SKILL_FLOOR = resolve(__dirname, '..', '..', 'skills', 'design-principles-core.md');

/** Pull §A tenets only — keep brand-dna prompt small; full §B is for judges. */
function extractFloorTenets(principlesMd) {
  if (!principlesMd) return '';
  const start = principlesMd.indexOf('## §A');
  if (start < 0) return principlesMd.slice(0, 2500);
  const end = principlesMd.indexOf('## §B', start);
  const chunk = end > start ? principlesMd.slice(start, end) : principlesMd.slice(start, start + 3500);
  return chunk.trim().slice(0, 3500);
}

function renderCurrentDesign(cd) {
  if (!cd) return '(no current design observed)';
  const L = [];
  if (Array.isArray(cd.palette)) {
    L.push('Current palette:');
    for (const p of cd.palette) {
      L.push(`  ${p.hex}${p.colorName ? ` (${p.colorName})` : ''} — ${p.role}${p.usage ? `: ${p.usage}` : ''}`);
    }
  }
  if (cd.typography) {
    L.push(`Type character cues (do NOT copy CMS faces — pairings chosen separately): style=${cd.typography.headingStyle || 'n/a'}, scale=${cd.typography.scale}, weight=${cd.typography.weight}`);
  }
  if (cd.layoutStyle) L.push(`Layout feel: ${cd.layoutStyle}`);
  if (cd.spacingDensity) L.push(`Density: ${cd.spacingDensity}`);
  if (Array.isArray(cd.mood)) L.push(`Mood: ${cd.mood.join(', ')}`);
  if (cd.era) L.push(`Era: ${cd.era}${cd.datednessNote ? ` — ${cd.datednessNote}` : ''}`);
  if (cd.brandStrength != null) L.push(`Brand strength: ${cd.brandStrength}/5 (low = elevate more freely)`);
  if (Array.isArray(cd.notableElements)) L.push(`Notable: ${cd.notableElements.join('; ')}`);
  return L.join('\n');
}

export async function defineBrandDna(merged) {
  const cd = merged.currentDesign;
  const [tmpl, identitySkill, principles] = await Promise.all([
    readFile(PROMPT, 'utf-8'),
    readFile(SKILL_IDENTITY, 'utf-8').catch(() => ''),
    readFile(SKILL_FLOOR, 'utf-8').catch(() => ''),
  ]);

  const prompt = tmpl
    .replace('{{currentDesign}}', renderCurrentDesign(cd))
    .replace('{{designSkill}}', identitySkill.trim())
    .replace('{{designFloor}}', extractFloorTenets(principles));

  const { text } = await callAnthropic({ model: MODELS.default, prompt, maxTokens: 2000 });
  let parsed;
  try { parsed = parseJsonStrict(text); } catch { return null; }
  const dna = parsed?.brandDna ?? parsed;
  if (!dna || typeof dna !== 'object') return null;

  // CONVERGENCE FIX: LLM font picks collapse to priors. Curated seeded pairing wins.
  dna.typography = dna.typography || {};
  const seedKey = merged.practice?.name || merged.practice?.domain || '';
  const pick = pickFontPairing(cd || {}, seedKey);
  dna.typography.headingFont = pick.headingFont;
  dna.typography.bodyFont = pick.bodyFont;
  dna.typography.fontProvider = pick.provider;
  dna.typography._fontBucket = pick.bucket;
  return dna;
}

/** When brand-dna AI fails, derive a minimal palette from scraped brand colors. */
export function fallbackBrandDnaFromMerged(merged) {
  const c = merged.brand?.colors || {};
  const seedKey = merged.practice?.name || merged.practice?.domain || '';
  const pick = pickFontPairing(merged.currentDesign || {}, seedKey);
  return {
    color: {
      primary: c.primary || '#1B3A5C',
      secondary: c.secondary || c.primary || '#2E6DA4',
      accent: c.accent || '#C9A84C',
      neutralDark: c.dark || '#1c1a1a',
      neutralLight: c.light || '#EBF2FA',
      background: '#ffffff',
      text: '#2e2c2c',
      border: '#d6e8ed',
    },
    typography: {
      headingFont: pick.headingFont,
      bodyFont: pick.bodyFont,
      fontProvider: pick.provider,
      _fontBucket: pick.bucket,
    },
    shape: { cornerRadius: 'md', borderTreatment: 'standard' },
    elevation: { system: 'soft-shadow' },
    rationale: 'Fallback palette from scraped brand colors (brand-dna step unavailable); fonts from curated pairing.',
  };
}
