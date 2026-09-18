/**
 * skill-critique.js — Headless critique skill.
 *
 * Takes rendered screenshots + HTML source, scores against the 9-dimension
 * rubric, returns rubric scores + gripes + next recommended action.
 *
 * Input:
 *   dna, practice, screenshots (required: [{route, viewport, base64}]),
 *   files (optional: { 'src/pages/index.astro': '...' })
 *
 * Output:
 *   { skill, summary, score: { dimensions, overall, gate_pass, next_action }, meta }
 */

import { readFile }            from 'node:fs/promises';
import { join, dirname }       from 'node:path';
import { fileURLToPath }       from 'node:url';
import { renderDesignContext } from '../lib/render-design-context.js';
import { getAllReferences }     from '../lib/impeccable.js';
import { renderJudgeDirectives, normalizeReferenceAudit } from '../lib/reference-audit.js';

const MODEL   = 'claude-sonnet-4-6';
const __dir   = dirname(fileURLToPath(import.meta.url));
const RUBRIC  = JSON.parse(await readFile(join(__dir, '../config/rubric.json'), 'utf8'));

export async function run({ dna, practice, screenshots = [], files = {}, referenceAudit = null }) {
  const start   = Date.now();
  const context = renderDesignContext(dna, practice);
  const allRefs = await getAllReferences();
  const refAudit = normalizeReferenceAudit(referenceAudit);
  const judgeDirectives = renderJudgeDirectives(referenceAudit);

  // Build image content blocks — cap at 6 screenshots to stay within token budget
  const shots = screenshots.slice(0, 6);
  const imageBlocks = shots.flatMap(s => [
    { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
    { type: 'text',  text: `Screenshot: ${s.route} @ ${s.viewport?.w}×${s.viewport?.h}` },
  ]);

  // Optional HTML snippet — first 8000 chars of index.astro if present
  const htmlSnippet = files['src/pages/index.astro']
    ? `\n\n## HTML Source (truncated)\n\`\`\`astro\n${files['src/pages/index.astro'].slice(0, 8000)}\n\`\`\``
    : '';

  const rubricDims = RUBRIC.dimensions.map(d =>
    `${d.id} (weight ${d.weight}): ${d.why_it_matters}\n  Evidence to cite: ${d.evidence_to_cite.join('; ')}`
  ).join('\n\n');

  const { callAnthropic } = await import('../lib/ai-call.js');
  const res = await callAnthropic({
    phase:     'critique',
    model:     MODEL,
    maxTokens: 6000,
    messages:  [{
      role: 'user',
      content: [
        { type: 'text', text: context },
        ...imageBlocks,
        {
          type: 'text',
          text: `${htmlSnippet}

## Task
Score this design against the rubric. Return ONLY valid JSON matching the schema below.

## Impeccable Design Standards
You must score each dimension against these standards — not generic taste. Cite specific violations.
For each dimension score below 7, you MUST cite at least one specific, measurable violation from the Impeccable standards above (e.g. 'nav items wrap at 1280px viewport — spatial-design rule: never allow overflow text in navigation').

${allRefs}
${judgeDirectives}

## Rubric Dimensions
${rubricDims}

## Gate Criteria
Agent gate (what code can fix): ${RUBRIC.gate_criteria.agent_gate}
Human gate (action items, not blockers): ${RUBRIC.gate_criteria.human_gate}
gate_pass = true when ALL agent dimensions ≥ 7. Human dimensions below 7 must be listed as named action items in gripes, not counted against gate_pass.

## Calibration
${Object.entries(RUBRIC.calibration.anchors).map(([k,v]) => `${k}: ${v}`).join('\n')}

## Required JSON Output
{
  "dimensions": {
    "<id>": {
      "score": <1-10 integer>,
      "evidence": ["<concrete observation>"],
      "gripes": ["<specific problem>"],
      "candidate_fix_skill": "<typeset|colorize|layout|polish|clarify|bolder|harden or null>"
    }
  },
  "overall": <weighted average, 1 decimal>,
  "gate_pass": <boolean — true if ALL of (typography, color_contrast, spatial_layout, information_hierarchy, craft, ux_writing) score ≥ 7. imagery, distinctiveness, and trust_signals do NOT affect gate_pass.>,${refAudit?.fidelityChecks?.length ? `
  "fidelity": [
    { "check": "<the fidelity check, verbatim>", "pass": <boolean>, "evidence": "<concrete observation>" }
  ],` : ''}
  "next_action": {
    "skill": "<skill id or 'none'>",
    "target": "<file or section>",
    "reason": "<1 sentence>"
  }
}${refAudit?.fidelityChecks?.length ? `

next_action rules for this curated build: target a failed fidelity check or a correctness ban first.
Never propose an action whose effect would remove a sanctioned pattern.` : ''}

IMPORTANT: Every score must have at least one concrete observation. Never give a score without evidence. Penalize template-fill output heavily on distinctiveness.`,
        },
      ],
    }],
  });

  const text  = res.text;
  const score = parseJson(text);

  if (!score) {
    console.warn(`[skill-critique] JSON parse failed. tokens=${JSON.stringify(res.usage)}`);
    console.warn(`[skill-critique] raw response (first 800): ${text.slice(0, 800)}`);
  }

  // Compute overall if model forgot
  if (score && !score.overall && score.dimensions) {
    const dims  = RUBRIC.dimensions;
    let sum = 0, wsum = 0;
    for (const d of dims) {
      const s = score.dimensions[d.id]?.score;
      if (s) { sum += s * d.weight; wsum += d.weight; }
    }
    score.overall = wsum ? Math.round((sum / wsum) * 10) / 10 : 0;
  }

  // Fidelity gate (curated builds only): all reference fidelityChecks must pass.
  // Missing/unparsable fidelity rows count as failed — never silently pass.
  if (score && refAudit?.fidelityChecks?.length) {
    const rows = Array.isArray(score.fidelity) ? score.fidelity : [];
    score.fidelity_pass = refAudit.fidelityChecks.length <= rows.length
      && rows.every(r => r?.pass === true);
  }

  const lowestDim = score?.dimensions
    ? Object.entries(score.dimensions).sort((a,b) => a[1].score - b[1].score)[0]
    : null;

  const fidelityNote = score?.fidelity_pass !== undefined ? ` fidelity_pass=${score.fidelity_pass}.` : '';
  return {
    skill:   'critique',
    summary: `Overall ${score?.overall ?? '?'}/10, gate_pass=${score?.gate_pass}.${fidelityNote} Lowest: ${lowestDim?.[0]} (${lowestDim?.[1]?.score}).`,
    score,
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
