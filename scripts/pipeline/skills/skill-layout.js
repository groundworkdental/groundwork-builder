/**
 * skill-layout.js — Headless layout skill.
 *
 * Fixes spatial rhythm — section padding monotony, container widths,
 * grid choices, and mobile breakage. Edits src/pages/index.astro.
 *
 * Input:  dna, practice, files (src/pages/index.astro, tailwind.config.mjs)
 * Output: { skill, summary, changes, assessment, meta }
 */

import { renderDesignContext } from '../lib/render-design-context.js';
import { renderFixerDirectives } from '../lib/reference-audit.js';

const MODEL = 'claude-sonnet-4-6';

export async function run({ dna, practice, files = {}, screenshots = [], referenceAudit = null }) {
  const start   = Date.now();
  const context = renderDesignContext(dna, practice) + renderFixerDirectives(referenceAudit);

  const indexContent    = files['src/pages/index.astro'] || '(not provided)';
  const tailwindContent = files['tailwind.config.mjs'] || files['tailwind.config.js'] || '(not provided)';

  const imageBlocks = screenshots.slice(0, 2).flatMap(s => [
    { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
    { type: 'text', text: `Screenshot: ${s.route} @ ${s.viewport?.w}×${s.viewport?.h}` },
  ]);

  const density  = dna?.density  || 'balanced';
  const archetype = dna?.archetype || '(not specified)';

  const { callAnthropic } = await import('../lib/ai-call.js');

  const res = await callAnthropic({
    phase:     'skill:layout',
    model:     MODEL,
    maxTokens: 3500,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: context },
        ...imageBlocks,
        {
          type: 'text',
          text: `## Current index.astro
\`\`\`astro
${indexContent.slice(0, 3000)}
\`\`\`

## Current tailwind.config.mjs
\`\`\`js
${tailwindContent.slice(0, 1500)}
\`\`\`

## Task: Headless Layout

The archetype is "${archetype}" with density "${density}".

Density guide:
- airy: hero py-32+, sections py-24, generous whitespace between elements
- balanced: hero py-24, sections py-16 to py-20, moderate whitespace
- dense: hero py-16, sections py-10 to py-12, tighter spacing for information-dense layouts

Audit and fix:

1. **Section padding monotony** — Is every section using identical py-16? Vary by section importance:
   - Hero: largest padding (py-24 to py-40 based on density)
   - Primary CTA sections: py-20 to py-28
   - Content sections: py-16 to py-20
   - Footer/utility sections: py-10 to py-14

2. **Container width variety** — Is every section max-w-7xl centered? Vary:
   - Hero: can be full-width or max-w-screen-2xl
   - Content: max-w-5xl to max-w-7xl depending on content type
   - Testimonials/quotes: max-w-4xl (narrower for readability)
   - Feature grids: max-w-7xl to max-w-screen-xl

3. **Grid monotony** — Is every grid identical (e.g., grid-cols-3 everywhere)?
   Fix: vary grid density by content type. Services might be 2-col, features 3-col, testimonials 1-col or asymmetric.

4. **Section rhythm** — Is there visual breathing? Alternating section backgrounds (white, light gray, white) creates rhythm. Avoid solid same-color stacking.

5. **Mobile at 375px** — Check for:
   - Fixed widths that overflow (w-[500px] etc.)
   - Grid columns that don't collapse (grid-cols-3 without responsive prefix)
   - Text that's too large on mobile (text-7xl without sm: or md: prefix)
   - Padding that's too tight (px-2 or px-0 on small screens)

NEVER do:
- Arbitrary pixel values that break the spacing scale
- Identical card grids on every section
- Centering everything — some sections should be left-aligned
- Adding padding just to fill space without purpose

Return ONLY valid JSON:
{
  "assessment": "<2-3 sentence diagnosis naming specific class patterns that create problems>",
  "layout_issues": [
    { "section": "<hero|services|testimonials|etc>", "problem": "<description>", "fix": "<proposed classes>" }
  ],
  "changes": [
    {
      "file": "src/pages/index.astro",
      "type": "replace",
      "old": "<exact string to find in file>",
      "new": "<replacement string>",
      "explanation": "<why this improves spatial rhythm>"
    }
  ],
  "summary": "<1-2 sentences on what changed and why>"
}

Prioritize the most impactful changes. If the layout already has good rhythm and variety, return changes: [] with an explanation.`,
        },
      ],
    }],
  });

  const text   = res.text;
  const parsed = parseJson(text);

  return {
    skill:   'layout',
    summary: parsed?.summary || 'Layout changes proposed.',
    changes: parsed?.changes || [],
    assessment: parsed?.assessment,
    layoutIssues: parsed?.layout_issues || [],
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
