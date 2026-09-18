/**
 * skill-colorize.js — Headless colorize skill.
 *
 * Audits the current color palette against design DNA, checks contrast ratios,
 * 60/30/10 distribution, and accent overuse. Emits concrete changes to
 * tailwind.config.mjs colors section.
 *
 * Input:  dna, practice, files (tailwind.config.mjs, src/pages/index.astro)
 * Output: { skill, summary, changes, assessment, meta }
 */

import { renderDesignContext } from '../lib/render-design-context.js';
import { renderFixerDirectives } from '../lib/reference-audit.js';

const MODEL = 'claude-sonnet-4-6';

/**
 * Extract the set of color token keys referenced via @apply in global.css.
 * These are "protected" — colorize must not remove or rename them in
 * tailwind.config.mjs or the build will break with "unknown utility class".
 *
 * e.g. "@apply bg-surface-2 border-border-light" → ['surface-2', 'border-light']
 * We return them as both raw token slugs AND the full Tailwind class names.
 */
function extractProtectedTokens(globalCss = '') {
  const applyTokens = new Set();
  const applyRe = /@apply\s+([^;]+)/g;
  let m;
  while ((m = applyRe.exec(globalCss)) !== null) {
    for (const cls of m[1].trim().split(/\s+/)) {
      // Strip variant prefixes (hover:, md:, etc.) and keep the utility name
      const bare = cls.replace(/^[\w-]+:/, '');
      applyTokens.add(bare);
    }
  }
  return [...applyTokens].sort();
}

export async function run({ dna, practice, files = {}, screenshots = [], referenceAudit = null }) {
  const start   = Date.now();
  // Curated builds: sanctioned palette moves (e.g. gradient-accent, pure-black)
  // are deliberate — improve their execution, never "fix" them away.
  const context = renderDesignContext(dna, practice) + renderFixerDirectives(referenceAudit);

  const tailwindContent = files['tailwind.config.mjs'] || files['tailwind.config.js'] || '(not provided)';
  const indexContent    = files['src/pages/index.astro'] || '(not provided)';

  // global.css is injector-generated — colorize must NOT modify it directly.
  // Extract every @apply token it references so the model knows which color
  // keys are load-bearing and must remain defined in tailwind.config.mjs.
  const globalCssContent   = files['src/styles/global.css'] || '';
  const protectedTokens    = extractProtectedTokens(globalCssContent);
  const protectedTokenNote = protectedTokens.length
    ? `\n\nPROTECTED TOKENS (used by @apply in global.css — do NOT remove or rename these color keys in tailwind.config.mjs):\n${protectedTokens.map(t => `  • ${t}`).join('\n')}`
    : '';

  const imageBlocks = screenshots.slice(0, 2).flatMap(s => [
    { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
    { type: 'text', text: `Screenshot: ${s.route} @ ${s.viewport?.w}×${s.viewport?.h}` },
  ]);

  const colorPalette    = dna?.colorPalette    || '(not specified)';
  const archetype       = dna?.archetype       || '(not specified)';
  const creativeDirection = dna?.creativeDirection || '(not specified)';

  const { callAnthropic } = await import('../lib/ai-call.js');

  const res = await callAnthropic({
    phase:     'skill:colorize',
    model:     MODEL,
    maxTokens: 3000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: context },
        ...imageBlocks,
        {
          type: 'text',
          text: `## Current tailwind.config.mjs (colors section)
\`\`\`js
${tailwindContent.slice(0, 4000)}
\`\`\`

## Current index.astro (color class usage excerpt)
\`\`\`astro
${indexContent.slice(0, 2000)}
\`\`\`
${protectedTokenNote}

## Task: Headless Colorize

The archetype is "${archetype}". The DNA's color palette is: ${colorPalette}.
Creative direction: ${creativeDirection}

Audit and fix the color system:

1. **60/30/10 ratio** — 60% dominant (background/surface), 30% secondary (text/structure), 10% accent (CTA/highlights). Is this respected?
2. **WCAG AA contrast** — Body text needs ≥4.5:1 contrast ratio. Large text (18pt+) needs ≥3:1. Check the current palette for failures.
3. **Accent overuse** — Is the accent color used on more than 10-15% of elements? Dilutes hierarchy.
4. **AI-slop patterns** — Flag and replace: purple-blue gradients, generic Tailwind blue/slate/violet defaults, rainbow accents, "startup blue" (#3B82F6 / blue-500).
5. **Palette coherence** — Does the palette match the archetype's mood? (e.g., luxury → deep navy/champagne, clinical → cool white/teal, bold → high-contrast with strong accent)

PROHIBIT in the output:
- Gradient text (text on gradient backgrounds)
- Pure grays (#808080, gray-500) as primary colors — use warm or cool-tinted neutrals
- Purple-blue gradients (from-purple-500 to-blue-500 etc.)
- Generic blue/slate Tailwind defaults with no customization
- More than 4 named brand colors
- Changes to any file other than tailwind.config.mjs — src/styles/global.css is injector-owned and must not be modified

PALETTE RULES:
- Define brand colors explicitly in tailwind theme.extend.colors
- Use semantic names (brand.primary, brand.accent, brand.surface) not generic names
- Ensure dark backgrounds have light text and vice versa
- Accent should be a single vivid color — not a gradient, not two colors
- You may CHANGE hex values of existing color keys; you must NOT rename or remove any key listed as protected above

Return ONLY valid JSON:
{
  "assessment": "<2-3 sentence diagnosis of color weaknesses, naming specific hex values or class names>",
  "contrast_failures": [
    { "pair": "<foreground>/<background>", "current_ratio": "<e.g. 2.8:1>", "fix": "<proposed colors>" }
  ],
  "changes": [
    {
      "file": "tailwind.config.mjs",
      "type": "replace",
      "old": "<exact string to find>",
      "new": "<replacement>",
      "explanation": "<why this fixes the palette>"
    }
  ],
  "summary": "<1-2 sentences on what changed and why>"
}

If the palette is already strong and passes all checks, return changes: [] with a clear explanation.`,
        },
      ],
    }],
  });

  const text   = res.text;
  const parsed = parseJson(text);

  // ── Post-processing: safety filters ──────────────────────────────────────
  // 1. colorize is only authorised to modify tailwind.config.mjs.
  //    global.css is injector-owned; any change to it would bypass the token
  //    system and risk "unknown utility class" build failures.
  // 2. If the model tries to introduce a new @apply class or token key that
  //    isn't in the protected set we extracted from global.css, we don't block
  //    it — that's a legitimate extension — but we DO drop any change that
  //    targets a file other than the config.
  const ALLOWED_FILES = new Set(['tailwind.config.mjs', 'tailwind.config.js']);
  const rawChanges = parsed?.changes || [];
  const filtered   = rawChanges.filter(c => {
    if (!c?.file) return false;
    const allowed = ALLOWED_FILES.has(c.file);
    if (!allowed) {
      console.warn(`[colorize] dropping change to "${c.file}" — only tailwind.config.mjs is authorised`);
    }
    return allowed;
  });

  return {
    skill:   'colorize',
    summary: parsed?.summary || 'Color palette changes proposed.',
    changes: filtered,
    assessment: parsed?.assessment,
    contrastFailures: parsed?.contrast_failures || [],
    _droppedChanges: rawChanges.length - filtered.length || undefined,
    meta: { model: MODEL, duration_ms: Date.now() - start, tokens: res.usage },
  };
}

function parseJson(text) {
  try { return JSON.parse(text.trim()); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const f = text.indexOf('{'), l = text.lastIndexOf('}');
  if (f !== -1 && l > f) { try { return JSON.parse(text.slice(f, l + 1)); } catch {} }
  return null;
}
