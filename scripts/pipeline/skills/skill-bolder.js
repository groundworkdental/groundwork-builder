/**
 * skill-bolder.js — Headless distinctiveness / boldness skill.
 *
 * Pushes generic-looking designs toward more memorable, differentiated
 * layouts. Fixes: vanilla card grids, timid CTAs, overused Tailwind defaults,
 * weak typographic hierarchy, and section sameness.
 *
 * Input:  dna, practice, files (src/pages/index.astro, components), screenshots
 * Output: { skill, summary, changes, assessment, meta }
 */

import { renderDesignContext } from '../lib/render-design-context.js';
import { renderFixerDirectives } from '../lib/reference-audit.js';

const MODEL = 'claude-sonnet-4-6';

export async function run({ dna, practice, files = {}, screenshots = [], referenceAudit = null }) {
  const start   = Date.now();
  // Curated builds: enforce the reference's deliberate choices, don't redesign them.
  const context = renderDesignContext(dna, practice) + renderFixerDirectives(referenceAudit);

  const indexContent = files['src/pages/index.astro'] || '(not provided)';

  // Show up to 4 screenshots so the model sees the full visual picture
  const imageBlocks = screenshots.slice(0, 4).flatMap(s => [
    { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
    { type: 'text', text: `Screenshot: ${s.route} @ ${s.viewport?.w}×${s.viewport?.h}` },
  ]);

  const archetype          = dna?.archetype          || '(not specified)';
  const creativeDirection  = dna?.creativeDirection  || '(not specified)';
  const heroStyle          = dna?.heroStyle          || '(not specified)';
  const colorPalette       = dna?.colorPalette       || '(not specified)';
  const moodWords          = dna?.moodWords?.join(', ') || '(not specified)';

  const { callAnthropic } = await import('../lib/ai-call.js');

  const res = await callAnthropic({
    phase:     'skill:bolder',
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
${indexContent.slice(0, 5000)}
\`\`\`

## Task: Headless Bolder — Distinctiveness Pass

The design archetype is "${archetype}", mood: ${moodWords}.
Creative direction: ${creativeDirection}
Hero style: ${heroStyle}
Palette: ${colorPalette}

This site looks too generic. It could belong to any dental practice. Your job is to make it feel **unmistakably specific** — a design that a visitor would remember.

Work through these levers systematically:

### 1. Section Visual Variety
- No two adjacent sections should have the same background treatment (white → tinted → white → tinted, not white → white → white)
- Hero sections should use the full-bleed image or a bold color block — not centered text on a plain white bg
- Add one unexpected layout element per page: an asymmetric grid, a full-width quote pull, an overlapping element, etc.

### 2. Typographic Boldness
- Headlines should be BIG. h1: at minimum text-4xl md:text-6xl. h2: text-3xl md:text-4xl.
- Use font-black or font-bold for impact headings, not just font-semibold
- Consider a large decorative number, oversized initial letter, or giant icon to anchor a section
- Subheadings should contrast the headline weight (lighter, smaller, wider tracking)

### 3. CTA Boldness
- Primary CTA buttons should be visually dominant: large padding (px-8 py-4 minimum), bold font, strong brand color
- Add a secondary action below the CTA (e.g., "Or call us: phone number") to reduce friction
- CTAs should feel like the most important element on the page, not an afterthought

### 4. Color Application
- Use the brand primary color as a **real design element**, not just for links
  - Full-width colored section, colored card backgrounds, large colored shape/blob
  - Not just button color and link color
- Dark sections (bg-neutral-dark or bg-brand-primary) provide strong contrast and visual rhythm
- Tinted backgrounds (bg-brand-primary/5 or bg-brand-primary/10) for alternating sections

### 5. Anti-Generic Patterns (fix these if present)
- Generic "3 column icon + title + text" services grid — break it with varied card sizes or a list style
- "Staff photo + bio paragraph" doctor section — give it a more editorial treatment
- Horizontal rule separators between every section — use spacing + background instead
- Icon sets using basic circle + emoji — use more intentional illustration or remove icons entirely
- "Trusted by X patients" generic trust signals — replace with specific differentiators

### 6. Memorable Detail
- Add one specific, memorable visual detail that reflects the practice's personality
- Could be: a large stats callout ("500+ smiles transformed"), a bold mission statement in large type,
  a full-bleed before/after teaser, or an unexpected accent color application

## CRITICAL: Tailwind-only rule
ALL styling must use Tailwind utility classes ONLY in the class attribute.
NEVER write raw CSS in style attributes. These are ILLEGAL:
  - style="transition: all 0.2s ease"  — NEVER
  - style="background: linear-gradient(...)"  — NEVER
Use: bg-gradient-to-r from-brand-primary to-brand-secondary, transition-all duration-200 (in class)

Return ONLY valid JSON:
{
  "assessment": "<2-3 sentences diagnosing why the design feels generic and what the highest-impact changes would be>",
  "issues_found": [
    {
      "category": "<section_sameness|typographic_timidity|weak_cta|color_underuse|generic_pattern|missing_detail>",
      "element": "<section.hero|h1|.cta-button|etc>",
      "description": "<what is generic about this element>",
      "severity": "<critical|moderate|minor>"
    }
  ],
  "changes": [
    {
      "file": "src/pages/index.astro",
      "type": "replace",
      "old": "<exact string to find — must be unique in the file>",
      "new": "<replacement with bolder design applied>",
      "explanation": "<what this makes more distinctive>"
    }
  ],
  "summary": "<1-2 sentences on what was made bolder and why it improves distinctiveness>"
}`,
        },
      ],
    }],
  });

  const text   = res.text;
  const parsed = parseJson(text);

  return {
    skill:       'bolder',
    summary:     parsed?.summary || 'Distinctiveness pass complete.',
    changes:     parsed?.changes || [],
    assessment:  parsed?.assessment,
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
