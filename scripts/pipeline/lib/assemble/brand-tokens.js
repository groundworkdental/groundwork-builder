/**
 * Step 6 — deterministic brand-dna → build tokens mapper.
 *
 * brand-dna (Step 4) is the single source of truth for the VISUAL system:
 * color roles, type families/scale, corner radius, border + elevation. This
 * module maps that decided identity into the exact vocabulary the injector and
 * Astro components consume — with NO AI and NO fabricated colors (only
 * deterministic tints derived by blending existing brand colors, the same way
 * the injector already derives surfaces).
 *
 * Ownership boundary: brand-dna owns color + type + shape + elevation. The
 * layout director owns ONLY section order + per-section variant + archetype.
 * So radius / cardTreatment / borderTreatment come from HERE, not the director.
 *
 * Output:
 *   {
 *     colors: { primary, secondary, light, accent, dark, muted },  // injector-required 6
 *     roles:  { background, text, border, neutralDark, neutralLight }, // full brand-dna roles
 *     fonts:  { heading, body },
 *     typography: { scale, weights, tracking },
 *     tokens: { radius, cardTreatment, borderTreatment, headingScale, density },
 *     rationale
 *   }
 */
import { hexToRgb, rgbToHex, ensureContrast, validatePalette } from '../contrast.js';

/** Blend hex A toward hex B by t∈[0,1]. Deterministic design math, not fabrication. */
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  if (!A || !B) return a;
  return rgbToHex({
    r: Math.round(A.r + (B.r - A.r) * t),
    g: Math.round(A.g + (B.g - A.g) * t),
    b: Math.round(A.b + (B.b - A.b) * t),
  });
}

const RADIUS = { sharp: 'sharp', none: 'sharp', sm: 'sm', md: 'md', lg: 'lg', xl: 'lg', pill: 'pill', full: 'pill' };
const ELEVATION_TO_CARD = { flat: 'bordered-flat', 'soft-shadow': 'soft-shadow', layered: 'elevated' };

export function brandDnaToTokens(brandDna) {
  if (!brandDna || !brandDna.color) {
    throw new Error('[brand-tokens] brandDna.color missing — Step 4 (defineBrandDna) must run first.');
  }
  const c = brandDna.color;
  const t = brandDna.typography || {};
  const shape = brandDna.shape || {};
  const elev = brandDna.elevation || {};

  // Required color roles must be real.
  for (const k of ['primary', 'secondary', 'accent', 'neutralDark', 'neutralLight', 'background', 'text', 'border']) {
    if (!c[k]) throw new Error(`[brand-tokens] brandDna.color.${k} missing`);
  }

  // `muted` (mid/caption text) — soften body text, then enforce WCAG AA 4.5:1 on
  // brand.light surfaces where text-neutral-mid is used sitewide.
  const mutedRaw = mix(c.text, c.background, 0.38);
  const muted = ensureContrast(mutedRaw, c.neutralLight, 4.5).hex;

  const radius = RADIUS[shape.cornerRadius] || 'md';
  const cardTreatment = ELEVATION_TO_CARD[elev.system] || 'bordered-flat';
  const borderTreatment = ['hairline', 'standard', 'none'].includes(shape.borderTreatment)
    ? shape.borderTreatment : 'standard';

  // WCAG guard on the palette itself. `muted` was already corrected above, but
  // `primary` was trusted to the brand prompt — and a primary that fails AA is
  // not a local defect: it is every link, every eyebrow label, and the text on
  // every CTA button. One run shipped #1fa8b0 at 2.88:1 against white, which
  // axe reported as 177 serious violations across 16 pages while the design
  // critique scored contrast 7/10 and passed the gate. Contrast is measurable,
  // so measure it here rather than hope a later reviewer notices.
  const paletteCheck = validatePalette({
    primary: c.primary,
    accent:  c.accent,
    highlight: c.highlight || c.accent,
    light:   c.neutralLight,
    dark:    c.neutralDark,
    muted,
  });
  for (const adj of paletteCheck.adjustments || []) {
    console.log(`[brand-tokens] WCAG auto-correct: ${adj.key} ${adj.from} → ${adj.to} (${adj.reason})`);
  }
  for (const issue of paletteCheck.issuesAfter || []) {
    console.warn(`[brand-tokens] palette still fails AA after correction: ${issue.label} at ${issue.contrast}:1`);
  }

  // A single primary cannot satisfy AA on both white and near-black: correcting
  // it downward for light surfaces necessarily pushes it toward failing on dark
  // ones (measured at 2.45:1 against #1e1e2e). Derive a lightened counterpart so
  // `text-brand-primary` can resolve correctly inside dark sections instead of
  // every template having to remember a second token.
  const correctedPrimary = paletteCheck.palette?.primary || c.primary;
  const primaryOnDark = ensureContrast(correctedPrimary, c.neutralDark, 4.5, { direction: 'lighter' }).hex;

  return {
    // Injector-required 6 (drop-in for data.brand.colors)
    colors: {
      primary: paletteCheck.palette?.primary || c.primary,
      secondary: c.secondary,
      light: c.neutralLight,
      accent: paletteCheck.palette?.accent || c.accent,
      dark: c.neutralDark,
      muted: paletteCheck.palette?.muted || muted,
      primaryOnDark,
    },
    contrastAudit: {
      adjustments:     paletteCheck.adjustments || [],
      remainingIssues: paletteCheck.issuesAfter || [],
    },
    // Full brand-dna roles preserved (the injector uses these for correct
    // surfaces/borders/text instead of reusing `muted` or hardcoding white).
    roles: {
      background: c.background,
      text: c.text,
      border: c.border,
      neutralDark: c.neutralDark,
      neutralLight: c.neutralLight,
    },
    fonts: { heading: t.headingFont, body: t.bodyFont, provider: t.fontProvider || 'google' },
    typography: { scale: t.scale || {}, weights: t.weights || {}, tracking: t.tracking || '' },
    tokens: { radius, cardTreatment, borderTreatment },
    rationale: brandDna.rationale || '',
  };
}

/**
 * Apply mapped brand tokens onto a merged object so the existing injector
 * (injectTailwindConfig/injectGlobalCss) consumes brand-dna with no further
 * change. Returns the same merged for chaining. Non-destructive to currentDesign.
 */
export function applyBrandToMerged(merged, brandDna) {
  const m = brandDnaToTokens(brandDna);
  merged.brand = {
    ...(merged.brand || {}),
    colors: m.colors,
    roles: m.roles,
    fonts: m.fonts,
    typography: m.typography,
  };
  merged._brandTokens = m;
  return merged;
}

export default brandDnaToTokens;
