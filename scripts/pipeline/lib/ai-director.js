/**
 * ai-director.js — Creative Director phase.
 *
 * Takes silver data + design library fingerprints (own recents + curated inspo)
 * and emits a "design DNA" object that decides:
 *   - section order & presence (statBar, doctorIntro, gallery, reviews, etc.)
 *   - hero variant
 *   - services variant
 *   - card treatment, density, motion level
 *   - divergence rationale vs. own recent builds
 *
 * The injector later consumes this DNA to render different homepage layouts
 * from the same component library.
 *
 * Temperature is INTENTIONALLY HIGH (0.9) — we want creative surprise,
 * bounded by the archetype enum.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleLibrary } from './distill-design.js';
import { renderDesignContext } from './render-design-context.js';
import { deriveDesignTokens, ARCHETYPE_LAYOUT } from './derive-design-tokens.js';
import { renderSkillPrompt } from './skill-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shared design-principles core — the SAME standard the generator builds toward
// and the pixel-quality judge scores against. The candidate evaluator scores
// against it too, so it stops re-selecting the safe/generic archetype.
const DESIGN_PRINCIPLES = (() => {
  try { return readFileSync(resolve(__dirname, '../skills/design-principles-core.md'), 'utf-8'); }
  catch { return ''; }
})();

async function loadDentalIA() {
  try {
    const content = await readFile(resolve(__dirname, '..', 'reference', 'dental-ia.md'), 'utf8');
    return content.trim();
  } catch {
    return null; // non-fatal
  }
}

const MODEL = 'claude-sonnet-4-6'; // Creative direction is structured JSON — Sonnet is sufficient, 5× cheaper than Opus

// Enum constraints. Keep these IN SYNC with the variant components wired into
// the variant system (src/components/variants/) and chrome (Header/Footer/Gallery).
// Note: most of these are FYI for the director — derive-design-tokens.js
// deterministically overrides chrome variants based on archetype.
const HERO_VARIANTS      = ['centered', 'asymmetric-left', 'asymmetric-right', 'split-image', 'full-bleed', 'poster'];

/**
 * Pick N distinct hero variants for the candidates to EXPLORE, rotated by a
 * stable hash of the practice name so different practices start from different
 * points in the menu. Guarantees the set isn't all-split-image (at most one
 * candidate gets the overused default), forcing genuine exploration. The
 * evaluator still selects the best on merit.
 */
function pickExplorationItems(pool, practiceName, n = 3) {
  let h = 0;
  for (const ch of String(practiceName || 'practice')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const start = h % pool.length;
  const rotated = [...pool.slice(start), ...pool.slice(0, start)];
  return rotated.slice(0, n);
}
// Diversity is nudged on ARCHETYPE, not heroVariant — the archetype is what
// actually drives the rendered variant set (via deriveDesignTokens →
// ARCHETYPE_LAYOUT), and each archetype is a COHERENT matched set of section
// variants. Nudging heroVariant (a field ignored at render) wasted the
// exploration; nudging archetype makes real visual diversity reach the pixels.
function pickExplorationArchetypes(practiceName, n = 3) {
  return pickExplorationItems(ARCHETYPES, practiceName, n);
}
const SERVICES_VARIANTS  = ['cards-3up', 'editorial-list', 'accordion'];
const NAV_VARIANTS       = ['centered-logo', 'left-logo', 'split-logo', 'transparent-overlay', 'top-bar'];
const FOOTER_VARIANTS    = ['minimal-dark', 'editorial-split', 'classic-4col', 'compact-centered', 'bold-cta-footer'];
const CTA_VARIANTS       = ['full-width-dark', 'split-card', 'inline-minimal'];
const DOCTOR_VARIANTS    = ['portrait-left', 'portrait-right', 'editorial-full'];
const GALLERY_VARIANTS   = ['masonry-3col', 'editorial-2col', 'filmstrip', 'featured-grid', 'full-bleed-row'];
const HEADING_SCALE      = ['dramatic', 'moderate', 'restrained'];
const SECTION_DIVIDER    = ['none', 'line', 'space', 'color-shift'];
const HERO_TEXT_POSITION = ['bottom-left', 'center', 'right'];
const ARCHETYPES        = [
  'editorial-asymmetric', 'centered-classic', 'magazine-split',
  'minimal-brutalist',    'warm-editorial',    'card-heavy',
  'poster-hero',          'bold-serif-driven',
];
const ALL_SECTIONS      = ['hero', 'doctor-intro', 'stat-bar', 'services', 'gallery', 'reviews', 'faq', 'cta'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object} merged       - merged practice data (silver + preset)
 * @param {object} design       - legacy design observation (assemble passes {mood,rationale}; brand from brand-dna)
 * @param {object} opts
 * @param {object} [brandBrief] - brand brief adapted from brand-dna (via assemble-layout)
 * @returns {Promise<{dna: object, _meta: object}>}
 */
export async function runCreativeDirector(merged, design, opts = {}, brandBrief = null, audit = null) {
  const start = Date.now();
  const moodHint = brandBrief?.mood
    || (Array.isArray(design?.mood) ? design.mood.join(', ') : design?.mood)
    || merged?.currentDesign?.mood?.join?.(', ')
    || '';
  const [library, dentalIA] = await Promise.all([
    sampleLibrary({ moodHint }),
    loadDentalIA(),
  ]);
  const dataSignals = summarizeSignals(merged);
  const prompt = await buildPrompt({ merged, design, library, dataSignals, brandBrief, audit, dentalIA });

  // Stage 1: Generate 3 candidates in parallel (different temperature seeds).
  // EXPLORATION NUDGE: a strong model prior makes free-choice candidates all
  // converge on heroVariant=split-image. To escape it, each candidate is asked
  // to design the strongest possible site around a DIFFERENT assigned hero
  // variant. The evaluator (Stage 2) then picks the best on merit — so the
  // OUTPUT is still merit-chosen (split-image can still win if it's genuinely
  // best), but the candidates explore the full hero space instead of all
  // sampling the prior's peak. Per-practice rotation → different practices
  // surface different best heroes → natural diversity, no cross-site awareness.
  console.log('  [director] Generating 3 DNA candidates (archetype-exploration nudge)...');
  const temperatures = [0.7, 0.9, 1.0];
  const assignedArchetypes = pickExplorationArchetypes(dataSignals.practice, 3);
  const { callAnthropic } = await import('./ai-call.js');
  const candidateResults = await Promise.allSettled(
    temperatures.map((temp, i) =>
      callAnthropic({
        phase:       `director:candidate-${i}`,
        model:       MODEL,
        maxTokens:   2000,
        temperature: temp,
        messages:    [{ role: 'user', content: `${prompt}\n\n## This candidate's archetype exploration\nDesign the STRONGEST possible site using archetype = "${assignedArchetypes[i]}". Commit to it fully and make every other decision cohere with it. The archetype is the most consequential choice — it drives the entire coherent layout system (hero, services, reviews, cta, etc.). (Another candidate is exploring a different archetype; the best overall wins — so make this one excellent, don't hedge toward a safer archetype.)` }],
      }).then(res => ({ dna: parseDna(res.text), temp, index: i, usage: res.usage }))
    )
  );

  const candidates = candidateResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  if (candidates.length === 0) {
    throw new Error('ai-director: all 3 candidate generations failed');
  }

  if (candidates.length === 1) {
    // Only one succeeded — use it
    const { dna: rawDna, usage } = candidates[0];
    const normalized = normalizeDna(rawDna, dataSignals, brandBrief);
    const designSystem = buildDesignSystem(normalized, merged, design);
    Object.assign(normalized, designSystem);
    normalized.designTokens = deriveDesignTokens(normalized, brandBrief);
    return {
      dna: normalized,
      _meta: {
        model: MODEL,
        duration_ms: Date.now() - start,
        input_tokens: usage?.input_tokens,
        output_tokens: usage?.output_tokens,
        libraryUsed: { ownCount: library.totals.own, inspoCount: library.totals.inspo, antiCount: library.totals.anti },
        candidates: [{ temperature: candidates[0].temperature, archetype: rawDna?.archetype, heroVariant: rawDna?.heroVariant }],
        selectedCandidate: 0,
        evaluationMethod: 'only-survivor',
        designContextPreview: renderDesignContext(normalized, { name: dataSignals.practice, city: dataSignals.city }).slice(0, 400),
      },
    };
  }

  // Stage 2: Evaluate candidates and select best
  console.log(`  [director] Evaluating ${candidates.length} candidates...`);
  const evalPrompt = buildEvalPrompt(candidates, library, dataSignals);
  const evalRes = await callAnthropic({
    phase:       'director:eval',
    model:       MODEL,
    maxTokens:   800,
    temperature: 0.1,
    messages:    [{ role: 'user', content: evalPrompt }],
  });

  const evalText = evalRes.text;
  let selectedIndex = 0;
  let evalRationale = '';
  try {
    const evalJson = JSON.parse(evalText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
    selectedIndex = Math.max(0, Math.min(candidates.length - 1, (evalJson.winner ?? 0)));
    evalRationale = evalJson.rationale || '';
    console.log(`  [director] Selected candidate ${selectedIndex} (${evalRationale.slice(0, 80)}...)`);
  } catch {
    // Fallback: pick the middle-temperature candidate (index 1)
    selectedIndex = Math.min(1, candidates.length - 1);
  }

  const winner = candidates[selectedIndex];
  const dna = normalizeDna(winner.dna, dataSignals, brandBrief);
  const designSystem = buildDesignSystem(dna, merged, design);
  Object.assign(dna, designSystem);
  dna.designTokens = deriveDesignTokens(dna, brandBrief);
  dna.evalRationale = evalRationale;

  return {
    dna,
    _meta: {
      model: MODEL,
      duration_ms: Date.now() - start,
      input_tokens:  candidates.reduce((s, c) => s + (c.usage?.input_tokens || 0), 0) + (evalRes.usage?.input_tokens || 0),
      output_tokens: candidates.reduce((s, c) => s + (c.usage?.output_tokens || 0), 0) + (evalRes.usage?.output_tokens || 0),
      libraryUsed: {
        ownCount:   library.totals.own,
        inspoCount: library.totals.inspo,
        antiCount:  library.totals.anti,
      },
      candidates: candidates.map((c, i) => ({
        temperature: c.temperature,
        archetype:   c.dna?.archetype,
        heroVariant: c.dna?.heroVariant,
        mood:        c.dna?.mood,
        adjectives:  c.dna?.adjectives,
        sectionOrder: c.dna?.sectionOrder,
        divergenceRationale: c.dna?.divergenceRationale?.slice(0, 200),
      })),
      selectedCandidate: selectedIndex,
      evaluationMethod: 'llm-scored',
      evalRationale,
      designContextPreview: renderDesignContext(dna, { name: dataSignals.practice, city: dataSignals.city }).slice(0, 400),
    },
  };
}

// ---------------------------------------------------------------------------
// Design system builder
// ---------------------------------------------------------------------------

function buildDesignSystem(dna, merged, design) {
  const practice = {
    name:   merged?.practice?.name || '',
    doctor: merged?.doctor?.name   || '',
    city:   merged?.address?.city  || '',
  };

  // Derive typographic scale string from design phase output
  const typographyScale = design?.fonts
    ? `${design.fonts.heading || design.fonts.display || 'serif'} (heading) / ${design.fonts.body || 'sans-serif'} (body) — scale 14/16/20/28/40/56px`
    : '16/20/28/40/56px';

  // Derive palette string
  const colorPalette = design?.colors
    ? Object.entries(design.colors).map(([k,v]) => `${k}: ${v}`).join(', ')
    : design?.palette || '(from design phase)';

  // Density → spacing scale mapping
  const spacingMap = { airy: '4/8/16/32/64/96px', balanced: '4/8/16/24/48/80px', dense: '4/8/12/20/40/64px' };
  const spacingScale = spacingMap[dna.density] || spacingMap.balanced;

  // Writing tone from mood
  const toneMap = {
    'calm':      'Calm, reassuring, professional. Short sentences. No jargon.',
    'refined':   'Refined and confident. Minimal punctuation drama. Let space do the work.',
    'editorial': 'Editorial voice — declarative, specific, no filler phrases.',
    'bold':      'Direct and confident. Active verbs. Subheads as statements, not questions.',
    'warm':      'Warm and welcoming. Use the patient\'s city. Doctor\'s first name in CTAs.',
  };
  const writingTone = toneMap[design?.mood] || `Warm, clear, specific to ${practice.city || 'the community'}.`;

  const brandSummary = [
    practice.name,
    practice.doctor ? `led by ${practice.doctor}` : null,
    practice.city   ? `serving ${practice.city}` : null,
    `— ${dna.creativeDirection}`,
  ].filter(Boolean).join(', ');

  // Generate do/don't rules from archetype + data signals
  const doRules = [
    `Use the archetype's established ${dna.archetype} layout — don't mix incompatible grid styles mid-page.`,
    `Hero variant must be ${dna.heroVariant} — lock this choice.`,
    `Card treatment is ${dna.cardTreatment} — apply consistently across all card instances.`,
    'Phone number must be a tel: link in the mobile header, minimum 44px touch target.',
    'Doctor name and credentials must appear without scrolling on the homepage.',
    'Primary CTA copy must reference a specific action and ideally the doctor or city.',
    'Body text ≥ 16px, line-height ≥ 1.5, measure 45–75 characters.',
  ];

  const dontRules = [
    'No gradient text (background-clip: text) — AI-slop tell #1.',
    'No faux-glass / backdrop-filter cards unless archetype explicitly calls for it.',
    'No centered-headline + two-CTA + microlinks hero — the most overused AI pattern.',
    'No stat-bar section if yearsExperience/happyPatients data is missing — render empty = fail.',
    'No stock photography of smiling model families.',
    'No template dental slogans ("your trusted partner", "comprehensive care"). Say what this practice actually does. Do not define the brand by attacking other offices or telling some patients they are in the wrong place.',
    `No archetype+hero combo already used in recent own-builds.`,
    'No section that renders with dashes, nulls, or placeholder text visible to users.',
  ];

  return { typographyScale, colorPalette, spacingScale, writingTone, brandSummary, doRules, dontRules };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-vertical section-order priors
// ---------------------------------------------------------------------------

/**
 * Detect a vertical hint from the audit's primary service + secondary services.
 * Used to surface section-order priors that match conversion patterns for that
 * type of practice. Conservative — falls back to 'general' when unsure.
 *
 * Verticals: orthodontics | cosmetic | pediatric | implant | sedation | general
 */
function detectVertical(audit, dataSignals) {
  if (!audit) return 'general';
  const primary    = String(audit.serviceEmphasis?.primary    || '').toLowerCase();
  const secondary  = (audit.serviceEmphasis?.secondary || []).map(s => String(s).toLowerCase()).join(' ');
  const positioning = String(audit.positioning?.recommended || '').toLowerCase();
  const blob = `${primary} ${secondary} ${positioning}`;

  if (/\b(ortho|invisalign|braces|aligners?|dentofacial)/i.test(blob))           return 'orthodontics';
  if (/\b(pediatric|children|kids|infant|baby|babies)/i.test(blob))              return 'pediatric';
  if (/\b(cosmetic|veneers?|whitening|smile makeover)/i.test(blob))              return 'cosmetic';
  if (/\b(implants?|dentures?|all[-\s]?on[-\s]?\d|prosthet)/i.test(blob))        return 'implant';
  if (/\b(sedation|anxiety|sedat)/i.test(blob))                                  return 'sedation';
  return 'general';
}

/**
 * Render a soft per-vertical section-order prior. Director uses this as a
 * STARTING ORDER hint, not a rule — they can deviate with rationale, but
 * absent a strong reason, follow the prior. Each prior reflects observed
 * conversion patterns for that vertical's audience.
 */
function buildVerticalPriorBlock(vertical) {
  const PRIORS = {
    orthodontics: {
      lead: ['hero', 'gallery', 'services', 'doctor-intro', 'reviews', 'cta', 'faq'],
      why:  'Before/after results are the dominant conversion driver — gallery should rank above services. Doctor intro after gallery (specialist credibility supports the outcome).',
    },
    cosmetic: {
      lead: ['hero', 'gallery', 'reviews', 'services', 'doctor-intro', 'cta', 'faq'],
      why:  'Cosmetic is high-emotion, high-trust — visual results AND social proof early. Reviews above services because patient stories matter more than service descriptions in this vertical.',
    },
    pediatric: {
      lead: ['hero', 'doctor-intro', 'services', 'reviews', 'gallery', 'faq', 'cta'],
      why:  'Parents pick a pediatric dentist on doctor warmth + reputation. Doctor intro early; reviews from other parents matter; gallery is supporting evidence not a primary driver.',
    },
    implant: {
      lead: ['hero', 'doctor-intro', 'services', 'gallery', 'reviews', 'cta', 'faq'],
      why:  'High-cost decision with long consideration cycle — patients vet the surgeon first. Doctor credentials early. Gallery shows results; reviews build comfort; FAQ answers cost/recovery questions late.',
    },
    sedation: {
      lead: ['hero', 'reviews', 'doctor-intro', 'services', 'faq', 'cta', 'gallery'],
      why:  'Anxiety-driven decision — social proof from other anxious patients is the conversion. Reviews early. FAQ surfaces "will it hurt?" / "is it safe?" before CTA.',
    },
    general: {
      lead: ['hero', 'services', 'doctor-intro', 'reviews', 'gallery', 'cta', 'faq'],
      why:  'Balanced ordering — services answer "what do you offer", doctor builds trust, reviews validate, CTA before FAQ.',
    },
  };
  const prior = PRIORS[vertical] || PRIORS.general;
  return `- Vertical section-order prior: [${prior.lead.join(' → ')}]
  Why: ${prior.why}
  This is a SOFT prior — start here and deviate only if data signals (missing gallery, no testimonials, etc.) or brand brief argues otherwise. Note your reasoning in divergenceRationale.`;
}

function summarizeSignals(merged) {
  const stats = merged?.content?.stats || {};
  return {
    practice:       merged?.practice?.name || '(unknown)',
    doctor:         merged?.doctor?.name   || null,
    city:           merged?.address?.city  || null,
    hasStats:       !!(stats.yearsExperience || stats.happyPatients || stats.fiveStarReviews),
    hasHeroImage:   !!(merged?.images?.hero?.length),
    hasTeamPhotos:  !!(merged?.images?.team?.length),
    hasGallery:     (merged?.images?.gallery?.length || 0) >= 4,
    galleryCount:   (merged?.images?.gallery?.length || 0),
    hasReviews:     !!(merged?.content?.testimonials?.length),
    hasSecondaryDoctor: !!(merged?.additionalDoctors?.length),
    serviceCount:   (merged?.servicesOffered?.length || merged?.services?.length || 0),
  };
}

function summarizeFingerprint(fp, maxAdjectives = 4) {
  return {
    slug:       fp.slug,
    archetype:  fp.layout?.archetype,
    mood:       fp.palette?.mood,
    hero:       fp.hero?.variant,
    density:    fp.layout?.density,
    adjectives: (fp.adjectives || []).slice(0, maxAdjectives),
  };
}

function buildEvalPrompt(candidates, library, dataSignals) {
  const owns = library.own.map(summarizeFingerprint);
  const formatted = candidates.map((c, i) => {
    const d = c.dna || {};
    // Surface the REAL rendered layout the archetype maps to (this is what ships,
    // not the vestigial heroVariant the model emits). Lets the evaluator judge
    // the actual hero — and penalize the centered-over-photo cliché.
    const layout = ARCHETYPE_LAYOUT[d.archetype] || {};
    return `Candidate ${i}:\n  archetype: ${d.archetype}\n  → RENDERS hero: ${layout.heroLayout || '(unknown)'}, services: ${layout.servicesLayout || '?'}, reviews: ${layout.testimonialsLayout || '?'}, cta: ${layout.ctaLayout || '?'}\n  radius: ${d.radius}\n  sectionOrder: ${JSON.stringify(d.sectionOrder)}\n  creativeDirection: ${d.creativeDirection || ''}\n  divergenceRationale: ${d.divergenceRationale || ''}`;
  }).join('\n\n');

  return `You are evaluating 3 design DNA candidates for a dental practice website. Pick the one that will produce the best-DESIGNED, most distinctive site — scored against the design principles below.

${DESIGN_PRINCIPLES}

# Practice context
- Name: ${dataSignals.practice}
- Data available: hasStats=${dataSignals.hasStats}, hasGallery=${dataSignals.hasGallery}, hasReviews=${dataSignals.hasReviews}

# Recent own-builds (diverge from these)
${owns.length ? JSON.stringify(owns.map(o => `${o.archetype}/${o.hero}`), null, 2) : '(none)'}

# Candidates
${formatted}

# Evaluation criteria (in priority order)
1. **Design quality per the §A/§B principles above** — judge the "RENDERS" layout line. HARD-PENALIZE a candidate whose hero is the centered-text-over-photo cliché unless nothing else fits; REWARD distinctive, coherent archetypes (split/poster/text-only/editorial). Do not default to the "safe/versatile" archetype — safe is a weakness here, not a strength.
2. Coherence — the rendered section set reads as one intentional system.
3. Appropriate for available data (no sections that require missing data).
4. Distinctiveness from recent own-builds.

Return ONLY this JSON:
{
  "winner": <0|1|2>,
  "scores": [<0-10>, <0-10>, <0-10>],
  "rationale": "<1-2 sentences; name the principle that decided it>"
}`;
}

async function buildPrompt({ merged, design, library, dataSignals, brandBrief = null, audit = null, dentalIA = null }) {
  const owns   = library.own.map(summarizeFingerprint);
  const inspos = library.inspo.map(summarizeFingerprint);
  const antis  = library.anti.map(summarizeFingerprint);

  // Brand brief block — only included when Brand Direction step ran.
  // Note: density is owned by Brand Direction. The director consumes it but does
  // NOT output it (it's stamped onto the DNA from the brief in normalizeDna).
  // Motion + radius character from the brief are passed as soft guidance — the
  // director still picks the operative abstract level (motion: none|subtle|expressive,
  // radius: sharp|sm|md|lg|pill) but should align with the brief's character.
  const brandBlock = brandBrief ? `
# Brand Direction Brief (Phase 2d output — your primary creative anchor)
- Mood:        ${brandBrief.mood || '(none)'}
- Palette:     primary ${brandBrief.palette?.primary}, secondary ${brandBrief.palette?.secondary}, accent ${brandBrief.palette?.accent}
- Typography:  heading "${brandBrief.typography?.heading}" / body "${brandBrief.typography?.body}"
- Density (FIXED — set by Brand Direction, not your call): ${brandBrief.spatial?.density || '(none)'}
- Card radius character (guidance): ${brandBrief.spatial?.cardRadius || '(none)'}
- Motion character (guidance):      ${brandBrief.motion?.pageEntrance || brandBrief.motion?.transitions || '(none)'}
- Voice:       ${brandBrief.voice?.tone_notes || '(none)'}
- Rationale:   ${brandBrief.rationale || '(none)'}

This brief was produced by a dedicated Brand Direction step grounded in Impeccable design principles.
Your layout decisions (archetype, hero variant, section order, etc.) must be COHERENT with it.
Density is a brand atom and is fixed above — do not pick a different one. Your job is to orchestrate LAYOUT
within that visual identity, not re-invent the brand.

When picking motion (none|subtle|expressive) and radius (sharp|sm|md|lg|pill), align with the character above:
- A "brief and functional" motion description points to subtle or none. "Expressive" or "playful" descriptions allow expressive.
- A "rounded-2xl"/"rounded-xl" cardRadius points to lg or md radius. "rounded-none"/"rounded-sm" points to sharp or sm.
` : '';

  // Audit signals block — positioning, emphasis, differentiators
  // Vertical detection: derive a soft "what kind of practice is this?" hint
  // from the audit's primary service + tone signal. Drives per-vertical
  // section-order priors below. Conservative — when unsure, fall back to
  // 'general' which has the most-balanced ordering.
  const verticalHint = detectVertical(audit, dataSignals);
  const verticalPriorBlock = buildVerticalPriorBlock(verticalHint);

  const auditBlock = audit ? `
# Practice Strategy (from Audit — use to inform section order and emphasis)
- Positioning: ${audit.positioning?.recommended || '(none)'}
- Primary service to emphasize: ${audit.serviceEmphasis?.primary || '(none)'}
- Secondary services: ${(audit.serviceEmphasis?.secondary || []).join(', ') || '(none)'}
- Key differentiators: ${(audit.differentiators || []).slice(0, 3).join(' · ') || '(none)'}
- Tone: ${audit.tone?.recommended || '(none)'}
- Detected vertical: ${verticalHint}
${verticalPriorBlock}

Use serviceEmphasis to decide which sections to prioritize and order first.
If differentiators include emergency availability, surface that in the hero or stat-bar.
` : '';

  // Dental IA reference — homepage section order, nav patterns, CTA strategy
  const iaBlock = dentalIA ? `
# Information Architecture Reference (Dental IA Best Practices)
Use this to make section-order and navigation decisions. Do not contradict proven dental IA patterns without a strong reason.

${dentalIA}
` : '';

  return renderSkillPrompt('creative/director', {
    dataSignals: {
      practice:           dataSignals.practice,
      doctor:             dataSignals.doctor          || '(none)',
      city:               dataSignals.city            || '(none)',
      hasHeroImage:       String(dataSignals.hasHeroImage),
      hasTeamPhotos:      String(dataSignals.hasTeamPhotos),
      hasGallery:         String(dataSignals.hasGallery),
      hasStats:           String(dataSignals.hasStats),
      hasReviews:         String(dataSignals.hasReviews),
      hasSecondaryDoctor: String(dataSignals.hasSecondaryDoctor),
      serviceCount:       String(dataSignals.serviceCount),
    },
    design: {
      mood:      design?.mood || '(none)',
      rationale: design?.rationale?.slice(0, 200) || '',
    },
    brandBlock,
    auditBlock,
    iaBlock,
    owns:   owns.length   ? JSON.stringify(owns, null, 2)   : '(none yet — you have full freedom)',
    antis:  antis.length  ? JSON.stringify(antis, null, 2)  : '(none)',
    inspos: inspos.length ? JSON.stringify(inspos, null, 2) : '(none yet)',
  });
}

// ---------------------------------------------------------------------------
// Parse + normalize
// ---------------------------------------------------------------------------

function parseDna(text) {
  try { return JSON.parse(text.trim()); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const f = text.indexOf('{'), l = text.lastIndexOf('}');
  if (f !== -1 && l > f) { try { return JSON.parse(text.slice(f, l + 1)); } catch {} }
  throw new Error(`ai-director: could not parse DNA JSON.\nFirst 400: ${text.slice(0, 400)}`);
}

function normalizeDna(raw, signals, brandBrief) {
  // Density is owned by Brand Direction. We stamp it onto the DNA from the
  // brand brief here, regardless of what the model returned. The director's
  // prompt no longer asks for density, but `raw.density` is kept as a
  // last-resort fallback if no brand brief exists (legacy / no-API runs).
  const ALLOWED_DENSITY = ['airy', 'balanced', 'dense'];
  const briefDensity = brandBrief?.spatial?.density;
  const density = ALLOWED_DENSITY.includes(briefDensity) ? briefDensity
                : ALLOWED_DENSITY.includes(raw.density)  ? raw.density
                : 'balanced';

  const dna = {
    archetype:       ARCHETYPES.includes(raw.archetype) ? raw.archetype : 'editorial-asymmetric',
    heroVariant:     HERO_VARIANTS.includes(raw.heroVariant) ? raw.heroVariant : 'asymmetric-left',
    servicesVariant: SERVICES_VARIANTS.includes(raw.servicesVariant) ? raw.servicesVariant : 'cards-3up',
    navVariant:      NAV_VARIANTS.includes(raw.navVariant) ? raw.navVariant : 'left-logo',
    footerVariant:   FOOTER_VARIANTS.includes(raw.footerVariant) ? raw.footerVariant : 'classic-4col',
    ctaVariant:      CTA_VARIANTS.includes(raw.ctaVariant) ? raw.ctaVariant : 'full-width-dark',
    doctorVariant:   DOCTOR_VARIANTS.includes(raw.doctorVariant) ? raw.doctorVariant : 'portrait-left',
    galleryVariant:  GALLERY_VARIANTS.includes(raw.galleryVariant) ? raw.galleryVariant : 'masonry-3col',
    sectionOrder:    Array.isArray(raw.sectionOrder) ? raw.sectionOrder.filter(s => ALL_SECTIONS.includes(s)) : [],
    cardTreatment:   raw.cardTreatment    || 'bordered-flat',
    density,
    motion:          raw.motion           || 'subtle',
    radius:          raw.radius           || 'md',
    borrowedFrom:    raw.borrowedFrom     || null,
    borrowedTrait:   raw.borrowedTrait    || null,
    headingScale:    HEADING_SCALE.includes(raw.headingScale)           ? raw.headingScale      : 'moderate',
    sectionDivider:  SECTION_DIVIDER.includes(raw.sectionDivider)       ? raw.sectionDivider    : 'space',
    heroTextPosition: HERO_TEXT_POSITION.includes(raw.heroTextPosition) ? raw.heroTextPosition  : 'center',
    divergenceRationale: raw.divergenceRationale || '',
    creativeDirection:   raw.creativeDirection   || '',
  };

  // Hard safety: strip sections whose data is missing, no matter what the model
  // returned. Record each filter decision in `coverage.filteredSections` so
  // downstream steps (missing-page) can surface "we almost had X" gaps to the
  // operator instead of silently dropping the section.
  const coverageFilters = [];
  dna.sectionOrder = dna.sectionOrder.filter(section => {
    if (section === 'stat-bar' && !signals.hasStats) {
      coverageFilters.push({ section, reason: 'no stat data scraped (years, patients, rating, reviews count)', signal: 'hasStats' });
      return false;
    }
    if (section === 'gallery' && !signals.hasGallery) {
      const count = signals.galleryCount ?? 0;
      coverageFilters.push({ section, reason: `only ${count} gallery photo(s) — need at least 4 for a gallery section`, signal: 'hasGallery', dataPresent: count, threshold: 4 });
      return false;
    }
    if (section === 'reviews' && !signals.hasReviews) {
      coverageFilters.push({ section, reason: 'no testimonials extracted from the source site (and no Google reviews scraped)', signal: 'hasReviews' });
      return false;
    }
    if (section === 'doctor-intro' && !signals.doctor) {
      coverageFilters.push({ section, reason: 'no doctor name extracted from silver step', signal: 'doctor' });
      return false;
    }
    return true;
  });
  dna.coverage = { filteredSections: coverageFilters };

  // Always guarantee hero + services + cta at minimum.
  if (!dna.sectionOrder.includes('hero'))     dna.sectionOrder.unshift('hero');
  if (!dna.sectionOrder.includes('services')) dna.sectionOrder.push('services');
  if (!dna.sectionOrder.includes('cta'))      dna.sectionOrder.push('cta');

  return dna;
}
