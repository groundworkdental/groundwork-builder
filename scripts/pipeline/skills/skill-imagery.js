/**
 * skill-imagery.js — Headless imagery improvement skill.
 *
 * When imagery scores low (stock photos, incoherent gallery), this skill:
 * 1. Reads the image analysis data from bronze.imageAnalysis (passed via files)
 * 2. Re-selects gallery images preferring: before-after > doctor > team > operatory > authentic > stock
 * 3. Updates the gallery section component to use better images
 *
 * Input:  { dna, practice, files, screenshots }
 * Output: { skill, summary, changes, meta }
 */

const MODEL = 'claude-sonnet-4-6';

export async function run({ dna, practice, files = {}, screenshots = [] }) {
  const start = Date.now();

  const imageAnalysisRaw = files['_data/image-analysis'] || '{}';
  const galleryContent   = files['src/components/generated/GallerySection.astro']
    || files['src/pages/index.astro']
    || '(not provided)';

  let imageAnalysis = {};
  try { imageAnalysis = JSON.parse(imageAnalysisRaw); } catch {}

  // Rank images by preference
  const ranked = Object.values(imageAnalysis)
    .filter(img => img.subject !== 'graphic' && img.subject !== 'stock')
    .sort((a, b) => {
      const subjectScore = { 'before-after': 5, doctor: 4, team: 3, operatory: 3, patient: 2, exterior: 1 };
      const aScore = (subjectScore[a.subject] || 0) + (a.authentic ? 2 : 0) + (a.quality || 0);
      const bScore = (subjectScore[b.subject] || 0) + (b.authentic ? 2 : 0) + (b.quality || 0);
      return bScore - aScore;
    });

  const imageBlocks = screenshots.slice(0, 4).flatMap(s => [
    { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
    { type: 'text', text: `Screenshot: ${s.route} @ ${s.viewport?.w}×${s.viewport?.h}` },
  ]);

  const { callAnthropic } = await import('../lib/ai-call.js');
  const res = await callAnthropic({
    phase:     'skill:imagery',
    model:     MODEL,
    maxTokens: 2000,
    messages:  [{
      role: 'user',
      content: [
        ...imageBlocks,
        {
          type: 'text',
          text: `## Task: Improve Gallery Image Selection

The current gallery uses stock family photography which reduces trust and authenticity scores.

## Available analyzed images (ranked by quality and authenticity):
${ranked.slice(0, 15).map((img, i) => `${i+1}. [${img.subject}] q=${img.quality} authentic=${img.authentic} tags=[${(img.tags||[]).join(',')}]
   URL: ${img.url}
   "${img.description}"`).join('\n')}

## Current gallery component (truncated):
\`\`\`astro
${galleryContent.slice(0, 3000)}
\`\`\`

## Instructions
1. Prefer before-after images for the gallery — they are conversion assets
2. Avoid stock family photos (mixed-race family groups in outdoor settings)
3. Use authentic images (authentic=true) over stock
4. If before-after images are available, feature them prominently
5. Maintain the same grid layout — only change the image src values and alt text

Return ONLY valid JSON:
{
  "changes": [
    {
      "file": "src/components/generated/GallerySection.astro",
      "type": "replace",
      "old": "<exact string to find>",
      "new": "<replacement with better image URLs>",
      "explanation": "<what changed and why>"
    }
  ],
  "summary": "<what images were swapped and why they are better>"
}

If the gallery component file is not available or no better images exist, return { "changes": [], "summary": "No actionable image improvements found." }`,
        },
      ],
    }],
  });

  const text   = res.text;
  const parsed = parseJson(text);

  return {
    skill:   'imagery',
    summary: parsed?.summary || 'Imagery pass complete.',
    changes: parsed?.changes || [],
    meta:    { model: MODEL, duration_ms: Date.now() - start, tokens: res.usage },
  };
}

function parseJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const first = t.indexOf('{');
  if (first !== -1) {
    let depth = 0, last = -1;
    for (let i = first; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}') { depth--; if (depth === 0) { last = i; break; } }
    }
    if (last > first) { try { return JSON.parse(t.slice(first, last + 1)); } catch {} }
  }
  return null;
}
