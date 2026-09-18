/**
 * skill-typeset.js — Headless typeset skill.
 *
 * Analyzes current typography against design DNA and rubric, then emits
 * concrete file changes to tailwind.config.mjs and/or index.astro.
 *
 * Input:  dna, practice, files (tailwind.config.mjs, src/pages/index.astro)
 * Output: { skill, summary, changes, meta }
 */

import { renderDesignContext } from '../lib/render-design-context.js';
import { renderFixerDirectives } from '../lib/reference-audit.js';

const MODEL = 'claude-sonnet-4-6';

export async function run({ dna, practice, files = {}, screenshots = [], referenceAudit = null }) {
  const start   = Date.now();
  const context = renderDesignContext(dna, practice) + renderFixerDirectives(referenceAudit);

  const tailwindContent = files['tailwind.config.mjs'] || files['tailwind.config.js'] || '(not provided)';
  const indexContent    = files['src/pages/index.astro'] || '(not provided)';

  const imageBlocks = screenshots.slice(0, 2).flatMap(s => [
    { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
    { type: 'text', text: `Screenshot: ${s.route} @ ${s.viewport?.w}×${s.viewport?.h}` },
  ]);

  const { callAnthropic } = await import('../lib/ai-call.js');
  const res = await callAnthropic({
    phase:     'skill:typeset',
    model:     MODEL,
    maxTokens: 3000,
    messages:  [{
      role: 'user',
      content: [
        { type: 'text', text: context },
        ...imageBlocks,
        {
          type: 'text',
          text: `## Current tailwind.config.mjs
\`\`\`js
${tailwindContent.slice(0, 4000)}
\`\`\`

## Current index.astro (typography-relevant excerpt)
\`\`\`astro
${indexContent.slice(0, 3000)}
\`\`\`

## Task: Headless Typeset

The archetype is "${dna?.archetype}" with density "${dna?.density}". The typography scale should match this archetype.

Assess and fix:
1. Font pairing — display/body pairing appropriate to archetype? (e.g., bold-serif-driven → DM Serif Display + Inter)
2. Scale — are heading sizes large enough? Hero text should be 56-80px on desktop for editorial/bold archetypes
3. Weight contrast — sufficient difference between display and body weights?
4. Measure — body text container max-width set to ~65ch?
5. Line height — headings 1.1-1.2, body 1.5-1.7?

RULES (from typeset skill):
- Body text minimum 16px (1rem)
- Use rem not px for font sizes
- No more than 2-3 font families
- Pair fonts with genuine contrast (serif+sans, or geometric+humanist)
- Use tabular-nums on numeric data
- Avoid Inter/Roboto/Open Sans when personality matters

Return ONLY valid JSON:
{
  "assessment": "<2-3 sentence diagnosis of typography weaknesses>",
  "changes": [
    {
      "file": "tailwind.config.mjs",
      "type": "replace",
      "old": "<exact string to find>",
      "new": "<replacement>",
      "explanation": "<why>"
    }
  ],
  "google_fonts_to_add": ["<font name>"],
  "summary": "<1-2 sentences on what changed and why>"
}

If typography is already strong (score ≥ 8), return changes: [] with an explanation.`,
        },
      ],
    }],
  });

  const text   = res.text;
  const parsed = parseJson(text);

  return {
    skill:   'typeset',
    summary: parsed?.summary || 'Typography changes proposed.',
    changes: parsed?.changes || [],
    assessment: parsed?.assessment,
    googleFontsToAdd: parsed?.google_fonts_to_add || [],
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
