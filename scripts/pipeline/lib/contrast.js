/**
 * WCAG color contrast math + palette auto-correction.
 *
 * Pure JS, no dependencies. The AI brand step (brand-dna) self-reports contrast
 * but its math is unreliable (we've observed misses by ~0.05). This module is
 * the deterministic check + fix.
 *
 *   contrast('#c05840', '#ffffff')   // → 4.45 (below 4.5 AA)
 *   ensureContrast('#c05840', '#ffffff', 4.5)
 *     // → '#a44d37' (auto-darkened until contrast ≥ 4.5)
 *
 * WCAG AA thresholds:
 *   - Normal text:        4.5:1
 *   - Large text (18pt+): 3.0:1
 *   - UI components:      3.0:1
 *
 * AAA (stricter, optional):
 *   - Normal text:        7.0:1
 *   - Large text:         4.5:1
 */

// ---------------------------------------------------------------------------
// Color space conversions
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      case bn: h = (rn - gn) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

export function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rp = 0, gp = 0, bp = 0;
  if (0 <= hp && hp < 1)      { rp = c; gp = x; bp = 0; }
  else if (1 <= hp && hp < 2) { rp = x; gp = c; bp = 0; }
  else if (2 <= hp && hp < 3) { rp = 0; gp = c; bp = x; }
  else if (3 <= hp && hp < 4) { rp = 0; gp = x; bp = c; }
  else if (4 <= hp && hp < 5) { rp = x; gp = 0; bp = c; }
  else                        { rp = c; gp = 0; bp = x; }
  const m = l - c / 2;
  return {
    r: (rp + m) * 255,
    g: (gp + m) * 255,
    b: (bp + m) * 255,
  };
}

// ---------------------------------------------------------------------------
// WCAG contrast math
// ---------------------------------------------------------------------------

/** WCAG relative luminance for an sRGB color in 0–255. */
export function relativeLuminance({ r, g, b }) {
  const norm = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * norm(r) + 0.7152 * norm(g) + 0.0722 * norm(b);
}

/** WCAG contrast ratio between two hex colors. Returns a number ≥ 1. */
export function contrast(hexA, hexB) {
  const a = relativeLuminance(hexToRgb(hexA));
  const b = relativeLuminance(hexToRgb(hexB));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Auto-correct: walk lightness until contrast passes
// ---------------------------------------------------------------------------

/**
 * Adjusts the foreground color's lightness toward the bound (darker by default)
 * until contrast against the background reaches `target`. Stops at lightness=0
 * if no value passes. Returns null if the color can't reach the target before
 * black (rare — would only happen for a very pale background that's already
 * close to white, against which no color can hit 4.5:1).
 *
 * Hue and saturation are preserved; only lightness moves. This keeps the
 * brand identity recognizable while fixing the contrast.
 */
export function ensureContrast(fgHex, bgHex, target = 4.5, opts = {}) {
  const direction = opts.direction || 'darker'; // 'darker' or 'lighter'
  const stepPercent = opts.stepPercent ?? 0.02; // 2% lightness per step
  const maxSteps = opts.maxSteps ?? 50;
  const initial = contrast(fgHex, bgHex);
  if (initial >= target) {
    return { hex: fgHex, contrast: initial, adjusted: false, steps: 0 };
  }

  const rgb = hexToRgb(fgHex);
  const hsl = rgbToHsl(rgb);

  for (let step = 1; step <= maxSteps; step++) {
    if (direction === 'darker') {
      hsl.l = Math.max(0, hsl.l - stepPercent);
    } else {
      hsl.l = Math.min(1, hsl.l + stepPercent);
    }
    const newRgb = hslToRgb(hsl);
    const newHex = rgbToHex(newRgb);
    const newContrast = contrast(newHex, bgHex);
    if (newContrast >= target) {
      return { hex: newHex, contrast: +newContrast.toFixed(2), adjusted: true, steps: step, originalHex: fgHex, originalContrast: +initial.toFixed(2) };
    }
    if (direction === 'darker' && hsl.l <= 0) break;
    if (direction === 'lighter' && hsl.l >= 1) break;
  }

  // Couldn't reach target — return the best we got
  const finalRgb = hslToRgb(hsl);
  const finalHex = rgbToHex(finalRgb);
  return {
    hex: finalHex,
    contrast: +contrast(finalHex, bgHex).toFixed(2),
    adjusted: true,
    converged: false,
    steps: maxSteps,
    originalHex: fgHex,
    originalContrast: +initial.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// High-level palette validator + corrector
// ---------------------------------------------------------------------------

/**
 * Validate a brand palette against WCAG AA and auto-correct primary if it
 * fails. Returns the corrected palette plus a list of adjustments.
 *
 * Constraints we check:
 *   - primary on light  ≥ 4.5  (used as text color in eyebrows, headings)
 *   - primary on white  ≥ 4.5  (used as text on white cards)
 *   - white on primary  ≥ 4.5  (text-white on bg-brand-primary buttons)
 *   - dark on light     ≥ 7.0  (body text — should easily pass; AAA target)
 *   - muted on light    ≥ 4.5  (secondary text)
 *
 * If primary fails on either light/white, darken until both pass.
 * If white-on-primary fails, that's the same primary — fixing it for one
 * direction usually fixes the other (darker primary → higher contrast both ways).
 */
export function validatePalette(palette) {
  const issues = [];
  const adjustments = [];
  const corrected = { ...palette };

  const checks = [
    { fg: 'primary', bg: 'light',   target: 4.5, label: 'primary text on brand-light bg' },
    { fg: 'primary', bg: '#ffffff', target: 4.5, label: 'primary text on white bg' },
    // Accent is used for eyebrow labels, prices, and highlight text on the same
    // light surfaces as primary. It was omitted here, so a gold/amber accent
    // (#b8860b at ~3.1:1) failed on nearly every page while the palette
    // reported clean.
    { fg: 'accent',  bg: 'light',   target: 4.5, label: 'accent text on brand-light bg' },
    { fg: 'accent',  bg: '#ffffff', target: 4.5, label: 'accent text on white bg' },
    // `highlight` is emitted as a Tailwind token alongside primary/accent and is
    // used the same way (eyebrow labels, emphasis text), but was never checked.
    { fg: 'highlight', bg: 'light',   target: 4.5, label: 'highlight text on brand-light bg' },
    { fg: 'highlight', bg: '#ffffff', target: 4.5, label: 'highlight text on white bg' },
    { fg: 'dark',    bg: 'light',   target: 7.0, label: 'dark text (body) on brand-light bg' },
    { fg: 'muted',   bg: 'light',   target: 4.5, label: 'muted text on brand-light bg' },
  ];

  // Resolve each lookup against the palette
  const resolve = (key) => key.startsWith('#') ? key : palette[key];

  for (const check of checks) {
    const fgHex = resolve(check.fg);
    const bgHex = resolve(check.bg);
    if (!fgHex || !bgHex) continue;
    const ratio = contrast(fgHex, bgHex);
    if (ratio < check.target) {
      issues.push({
        ...check,
        fgHex, bgHex,
        contrast: +ratio.toFixed(2),
      });
    }
  }

  // Auto-correct: darken primary until it passes against the WORST-CASE
  // background it'll be used on. The brand-light (off-white tint) often has
  // lower contrast than pure white because it's slightly darker — so target
  // whichever produces the lower starting contrast.
  for (const role of ['primary', 'accent', 'highlight']) {
    if (!corrected[role]) continue;
    if (!issues.some(i => i.fg === role)) continue;

    const candidates = ['#ffffff'];
    if (corrected.light) candidates.push(corrected.light);
    // Pick the bg that yields the lowest contrast — fixing for that one
    // automatically fixes the easier ones.
    const worstBg = candidates
      .map(bg => ({ bg, ratio: contrast(corrected[role], bg) }))
      .sort((a, b) => a.ratio - b.ratio)[0].bg;

    const result = ensureContrast(corrected[role], worstBg, 4.5);
    if (result.adjusted) {
      adjustments.push({
        key: role,
        from: corrected[role],
        to: result.hex,
        reason: `original ${result.originalContrast}:1 against ${worstBg} < AA threshold; darkened ${result.steps} step(s) to ${result.contrast}:1`,
      });
      corrected[role] = result.hex;
    }
  }

  // Re-check after correction
  const remainingIssues = [];
  for (const check of checks) {
    const updatedFg = check.fg.startsWith('#') ? check.fg : (corrected[check.fg] || palette[check.fg]);
    const updatedBg = check.bg.startsWith('#') ? check.bg : (corrected[check.bg] || palette[check.bg]);
    if (!updatedFg || !updatedBg) continue;
    const ratio = contrast(updatedFg, updatedBg);
    if (ratio < check.target) {
      remainingIssues.push({ ...check, fgHex: updatedFg, bgHex: updatedBg, contrast: +ratio.toFixed(2) });
    }
  }

  return {
    palette: corrected,
    issuesBefore: issues,
    issuesAfter: remainingIssues,
    adjustments,
  };
}
