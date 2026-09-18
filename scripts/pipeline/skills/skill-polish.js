/**
 * skill-polish.js — Headless polish skill.
 *
 * Final pass fixing alignment, hover/focus states, touch targets, mobile
 * overflow, null rendering, and transition smoothness. Called once other
 * rubric dimensions score ≥ 7.
 *
 * Input:  dna, practice, files (src/pages/index.astro), screenshots (all)
 * Output: { skill, summary, changes, assessment, issuesFound, meta }
 */

import { renderDesignContext } from '../lib/render-design-context.js';
import { renderFixerDirectives } from '../lib/reference-audit.js';

const MODEL = 'claude-sonnet-4-6';

export async function run({ dna, practice, files = {}, screenshots = [], referenceAudit = null }) {
  const start   = Date.now();
  const context = renderDesignContext(dna, practice) + renderFixerDirectives(referenceAudit);

  const indexContent = files['src/pages/index.astro'] || '(not provided)';

  // Polish gets all screenshots — it needs to catch edge cases across viewports
  const imageBlocks = screenshots.slice(0, 6).flatMap(s => [
    { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
    { type: 'text', text: `Screenshot: ${s.route} @ ${s.viewport?.w}×${s.viewport?.h}` },
  ]);

  const { callAnthropic } = await import('../lib/ai-call.js');

  const res = await callAnthropic({
    phase:     'skill:polish',
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
${indexContent.slice(0, 4000)}
\`\`\`

## Task: Headless Polish

This is a final quality pass. The design is largely correct — we're fixing the last 20% of issues.

Work through this checklist systematically:

### Interactivity Polish
- Every \`<a>\`, \`<button>\`, and clickable element needs: \`hover:\` state, \`focus-visible:\` ring, \`transition-colors duration-200\` or similar
- CTA buttons: add \`active:scale-[0.98]\` for tactile feel
- Links should not just change color — they should have clear visual affordance on hover (underline, bg shift, etc.)

### Touch Targets (Mobile)
- Every tap target must be ≥44×44px — check icon-only buttons, navigation links, small close/expand toggles
- Add \`min-h-[44px] min-w-[44px]\` or \`p-3\` to anything that could be too small
- Links in nav: ensure they have adequate padding, not just text height

### Mobile Overflow (375px)
- Look for any element wider than the viewport: fixed widths, long strings, images without max-w
- Check for \`overflow-x\` scroll being caused by padding or margin that extends beyond viewport
- Ensure all grids have responsive prefixes: \`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3\`

### Visual Alignment
- Check for inconsistent left-alignment on cards in the same grid row
- Verify icon sizes are consistent within a section (all 24px, or all w-6 h-6)
- Ensure consistent gap values within component groups

### Data/Content Edge Cases
- Check for any hardcoded placeholder text still present ("Lorem ipsum", "Your text here", "TBD", "Doctor Photo", "Team Photo", "[PLACEHOLDER]")
- If you see a div containing only the text "Doctor Photo" or similar, replace it with a styled placeholder image using a neutral background + initials or a camera icon SVG — never leave raw text where an image should be
- Any field that could be null/undefined should have fallback display
- Phone numbers and addresses should be properly formatted

### Transition Smoothness
- Navigation/header: add \`backdrop-blur\` + \`transition-all\` for scroll state changes if not present
- Images: add \`transition-opacity\` for lazy-load fade-in
- Animated elements should use \`ease-out\` not \`linear\`

## CRITICAL: Tailwind-only rule
ALL styling in the "new" strings must use Tailwind utility classes ONLY.
NEVER write raw CSS properties in any attribute value. These are ILLEGAL:
  - style="transition: all 0.2s ease"  — NEVER
  - style="transition-duration: 200ms"  — NEVER
  - class="... transition-all duration-200 ..."  — CORRECT (Tailwind classes)
If you need transitions, use: transition-colors, transition-all, transition-opacity with duration-200.
These are Tailwind classes that go in the class attribute, never in style.

Return ONLY valid JSON:
{
  "assessment": "<2-3 sentence summary of the quality level and main remaining gaps>",
  "issues_found": [
    {
      "category": "<interactivity|touch_target|mobile_overflow|alignment|edge_case|transition>",
      "element": "<button.cta|nav a|.service-card|etc>",
      "description": "<what is wrong>",
      "severity": "<critical|moderate|minor>"
    }
  ],
  "changes": [
    {
      "file": "src/pages/index.astro",
      "type": "replace",
      "old": "<exact string to find>",
      "new": "<replacement with polish fixes applied>",
      "explanation": "<what this fixes>"
    }
  ],
  "summary": "<1-2 sentences on the overall polish state and what was fixed>"
}`,
        },
      ],
    }],
  });

  const text   = res.text;
  const parsed = parseJson(text);

  return {
    skill:      'polish',
    summary:    parsed?.summary || 'Polish pass complete.',
    changes:    parsed?.changes || [],
    assessment: parsed?.assessment,
    issuesFound: parsed?.issues_found || [],
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
