/**
 * skill-catalog.js
 *
 * Auto-generates docs/SKILLS.md and docs/PIPELINE.html from the
 * frontmatter of every skill .md file under skills/.
 *
 * Run via:  node scripts/pipeline/skill-catalog.js
 *
 * The .md files are the source of truth; this generator re-reads them
 * each run and produces a single catalog page (Markdown) plus an
 * interactive HTML dashboard.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { listAllSkills, loadSkill, SKILLS_ROOT } from './skill-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DOCS_DIR  = resolve(REPO_ROOT, 'docs');
const SKILLS_HTML_DIR = resolve(DOCS_DIR, 'skills');

// Configure marked: GFM tables, syntax-friendly defaults
marked.setOptions({
  gfm: true,
  breaks: false,
});

// Phase order matches actual pipeline execution.
// "Design" used to bundle two distinct sub-phases (extraction + direction);
// they're now split for clarity. Frontmatter `phase:` values must match
// these exact strings.
const PHASE_ORDER = [
  'Scrape',
  'Silver',
  'Merge',
  'Define Brand',
  'Plan Content',
  'Assemble',
  'Generate',
  'Build',
  'Audit',
];

// Rich definitions for each phase — shown on the dashboard cards.
// These describe WHAT the phase does (not just what skills it contains).
const PHASE_INFO = {
  Scrape: {
    summary:
      'Crawls the original dental practice website and dumps every page\'s HTML, headings, paragraphs, JSON-LD structured data, and image URLs into a raw "bronze" archive. No AI involved — pure HTTP + parsing.',
    input:  'URL (e.g. https://springstdentistry.com)',
    output: 'pages[] · structured data · image URLs · site assets · sitemap',
    tools:  ['Playwright (headless browser)', 'lib/scraper.js', 'lib/scrape-reviews.js'],
    qc:     ['Page count', 'Redirect count', '"Bronze empty?" check'],
    cache:  'Local cache by URL — re-runs reuse bronze if present',
    cost:   'Free (HTTP only)',
    skip:   '--skip-scrape',
  },
  Silver: {
    summary:
      'AI-extracts bronze into a structured PracticeData object. Three content tiers: structured fields (practice, doctors, services, hours) capture canonical data; differentiators[] captures short labels for "why us" facts; additionalContent[] rescues verbatim prose blocks (pull-quotes, philosophy paragraphs, blog bodies). Visual design is observed separately by the vision design pass (currentDesign: palette, fonts, mood, era) and feeds Define Brand.',
    input:  'Bronze pages — top 8 by relevance (home, about, contact, doctor, team, services). Selection is for prompt-size only; ALL distinctive content within those pages is preserved across the three tiers.',
    output: 'silver — structured PracticeData with structured + label + prose tiers',
    outputDetail: [
      ['practice', 'name · domain · phone · email · googleReviewLink · googleProfileLink · sameAs[]'],
      ['🔄 doctors[]', 'Unified array of all practice doctors (was doctor + additionalDoctors). doctors[0] is the most prominent / featured / founder; remaining entries are equal-billing secondary doctors. Each: { name, firstName, lastName, credentials, bio, education, specialties[], photoPath }.'],
      ['address', 'street · city · state · zip · country · full'],
      ['hours', 'display[{ day, time }] · raw'],
      ['services', 'offered[{ name, slug, category, source, confidence }] — answers "what can the practice DO for me?"'],
      ['brand', 'logoPath. currentDesign (observed palette/type/mood/era) is captured by the vision design pass for Define Brand to elevate.'],
      ['content', 'heroTagline · heroHeadline · heroSubheadline · aboutText · testimonials[] · faqs[] · insurance[] · stats{}'],
      ['🆕 additionalContent[] (top-level)', 'Catch-all rescue. Each item: { type, title, content, source }. Captures pull-quotes, philosophy paragraphs, "Welcome To" intros, office descriptions, technology copy, mission statements, blog bodies, taglines — anything distinctive that didn\'t fit a structured field. Verbatim. Capped 30 items, ~2200 chars each. Consumed by doctor / service-page / faq / blog skills.'],
      ['🔄 differentiators[]', '(was signals[]) — { type, label, detail, source, confidence }. Short LABELS for facts that set the practice apart: technology, awards, languages, financing, emergency. Answers "why us?" — distinct from services (what we do) and additionalContent (verbatim prose).'],
      ['images', 'items[] — canonical: { src, alt, role, sourcePages[], personName } per image; derived role views (logo/hero/team/office/gallery/beforeAfter/treatment/badge). Bound to pages deterministically in Assemble.'],
      ['migration', 'oldUrls[] for redirect mapping'],
    ],
    tools:  ['Anthropic Sonnet 4.6', 'lib/ai-silver.js'],
    qc:     ['Schema validation', 'Multi-doctor presence check', 'No-duplicate boundary (services / differentiators / additionalContent)', 'additional-content-not-surfaced (post-build, in coverage audit)'],
    cost:   'Sonnet — moderate per build',
    skip:   '--skip-scrape (whole phase)',
  },
  Merge: {
    summary:
      'Combines silver (from the scrape) with the optional intake.json (if a client filled out a form) into a single normalized practice data shape. Deterministic — no AI calls. Intake values override silver where present.',
    input:  'silver + optional intake.json',
    output: 'merged (same shape, with intake overrides applied)',
    tools:  ['lib/merger.js (pure JS)'],
    qc:     ['Missing-field flags (e.g. doctor.name absent)'],
    cost:   'Free',
  },
  'Define Brand': {
    summary:
      'Defines practice COLOR identity (brand-dna): small scrape anchor (usually primary hue) + strong elevation — not mood→palette recipes, not scrape-cloning, not category dental defaults. Thin skills/design.md + design-principles-core §A only (taste-frontend is NOT injected). FONTS from curated seeded pairings; catalog --reference overwrites type bucket + shape/elevation. applyBrandToMerged writes merged.brand.{colors,roles,fonts}.',
    input:  'merged.currentDesign + skills/design.md (identity) + design-principles-core §A (floor)',
    output: 'brandDna { color{8 roles}, typography{families + scale}, shape, elevation, rationale } → merged.brand',
    tools:  ['Anthropic Sonnet 4.6', 'lib/brand/brand-dna.js', 'lib/brand/font-pairings.js', 'lib/assemble/brand-tokens.js', 'optional reference-entry.js'],
    qc:     ['WCAG AA in prompt', 'No category / mood→palette templating', 'Fonts convergence-proof (curated + seeded)'],
    cost:   'Sonnet — single call',
    skip:   '--skip-design',
  },
  'Plan Content': {
    summary:
      'Deterministically PLACES every merged content item onto a page + section. Faithful mimicry: reorganize/optimize, never omit and never editorialize — whoever/whatever the practice features on their own site, we feature (no "this doctor seems to be leaving" judgments). Coverage is guaranteed by construction.',
    input:  'merged practice data (+ optional Haiku content classifications)',
    output: 'contentPlan { pages[{ slug, role, sourcePath, sections[] }], announcements[], generated[], unplaced[] }',
    tools:  ['lib/content/plan-content.js (pure JS)', '(optional) Haiku classify-content (evergreen vs ephemeral)'],
    qc:     ['100% coverage (every distinct item placed)', 'Verbatim fidelity tier preserved', 'No omission — full roster + all content featured'],
    cost:   'Free (deterministic; optional Haiku classify)',
  },
  Assemble: {
    summary:
      'Decides the layout and binds images to it. The director generates 3 candidates, each forced to a DIFFERENT archetype (per-practice hash rotation = diversity by construction); an LLM evaluator scores them against the design-principles core and picks the best on merit. The archetype is authoritative — it maps (deterministically, via ARCHETYPE_LAYOUT) to a coherent, library-valid per-section variant SET. Ownership boundary: brand-dna owns color/type/radius/elevation; content-plan owns WHICH sections appear; the director owns only order + variant + archetype. Images are bound deterministically by a sourcePages join (a service page only gets an image that appeared on its source page; portraits match by name then bio-page).',
    input:  'contentPlan + brandDna + images.items[] + merged',
    output: 'design-dna.ts (archetype, sectionOrder, per-section variants, brand-owned tokens) + image binding',
    outputDetail: [
      ['Layout DNA',
        'archetype · sectionOrder[] · hero/services/reviews/cta/doctor/faq variants (archetype-derived) · radius/cardTreatment/border (from brand-dna) · density (observed)'],
      ['Image binding',
        'globals (role pools) · portraits{name→src} (name + bio-page join) · byPage{slug→service image} (sourcePages join) · unused'],
    ],
    tools:  ['Anthropic Sonnet 4.6 (3-candidate, archetype-nudged)', 'lib/assemble/assemble-layout.js', 'lib/derive-design-tokens.js (ARCHETYPE_LAYOUT)', 'lib/assemble/bind-images.js'],
    qc:     ['Ownership enforced (brand tokens override the director)', 'Section coverage vs content-plan', '0 image mismatches (sourcePages join)'],
    cost:   'Sonnet — 3 candidates evaluated, best picked',
  },
  Generate: {
    summary:
      'Generates content for every homepage section AND every internal service page. Section content goes into JSON files consumed by pre-built variant components (5 layouts × 8 dimensions). Service pages get full multi-section restructuring from the original page\'s bodyText.',
    input:  'DNA + designTokens + per-section content slice + scraped service bodyText',
    output: 'Content JSON files + per-section shim components + service detail pages',
    outputDetail: [
      ['Homepage section content (one per section)',
        'src/components/generated/{HeroSection,ServicesSection,DoctorIntro,ReviewsSection,CTABlock,FaqSection}.content.json'],
      ['Section shim components (auto-generated)',
        'src/components/generated/*.astro — thin wrappers that import the chosen variant + pass content'],
      ['Service detail pages (one per scraped service)',
        'src/pages/services/<slug>.astro — multi-section structured pages with highlight, subsection, callout-list, process, benefits, faq blocks'],
      ['Updated services index',
        'src/pages/services.astro — listing of all offered services'],
    ],
    tools:  ['Anthropic Sonnet 4.6', 'skill-loader.js (renders prompts from skill .md files)', 'variant component library'],
    qc:     ['JSON schema parse', 'Locked-field enforcement (doctor name, credentials)', 'No-fabrication rules in prompts'],
    cost:   'Sonnet — one call per section + one per service page',
    skip:   '--skip-generate',
  },
  Build: {
    summary:
      'Compiles the Astro project into static HTML in dist/. Pre-build link scrubber fixes known bad hrefs. Optional --agent flag runs visual QC iterations on the built output.',
    input:  'src/ files (pages, components, config, content)',
    output: 'dist/ — production HTML, CSS, JS, sitemap, assets',
    tools:  ['Astro 5', 'Tailwind CSS', '(optional) designer agent for visual QC'],
    qc:     ['Astro build errors fail the run', 'Link scrubber (pre-build)', 'SEO audit (post-build)'],
    cost:   'Free (compute only)',
    skip:   '--skip-build',
  },
  Audit: {
    summary:
      'Two halves. CONTENT coverage (built-in): compares scraped data against the rebuilt site to catch what got dropped — missing doctors, thinned service pages, mismatched contact info — and warns loudly inline. DESIGN quality & refine (Step 7): render-fidelity (verbatim content present), a deterministic anti-slop scan (impeccable rules), and a median-of-3 vision judge scored against the shared design-principles core, feeding a keep-best craft loop. The content half ships in build-site; the design-quality/refine tools currently run in the eval harness and are being wired into the production audit path.',
    input:  'bronze + silver + merged + image-roles.json + dist/ HTML + rendered screenshots',
    output: '_pipeline/coverage-audit.{json,md} + render-fidelity / pixel-quality / anti-slop reports',
    tools:  ['Deterministic comparators (lib/coverage-audit.js)', 'anti-slop scanner', 'Opus vision judge (median-of-3) vs design-principles-core'],
    qc:     ['Content: doctors/services/photo-pairing/phone cross-checks', 'Design: render-fidelity ≥99%, anti-slop clean, pixel-quality (gate 9, "good" ~7)', 'a11y WCAG AA'],
    cost:   'Free (content) + Opus (vision judge)',
  },
};

const TIER_DESCRIPTIONS = {
  L1: 'Prompt — edit `## PROMPT` in the skill\'s `.md` file',
  L2: 'Mapping — deterministic enum table (no AI call)',
  L3: 'Component — Astro variant file',
  L4: 'Pipeline step — orchestrating logic',
};

const MATURITY_BADGES = {
  stub:     '🔵 stub',
  working:  '🟡 working',
  polished: '🟢 polished',
  mature:   '⭐ mature',
};

// ---------------------------------------------------------------------------
// Section extraction from a skill .md (for catalog summaries)
// ---------------------------------------------------------------------------

function extractSection(body, headingText) {
  // Match "## <heading>" up to the next "## " line or end
  const re = new RegExp(`\\n##\\s+${headingText}\\b\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

// First sentence of a section, max ~200 chars
function firstSentence(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^.+?[.!?](?=\s|$)/);
  const out = m ? m[0] : t.slice(0, 200);
  return out.length > 200 ? out.slice(0, 197) + '…' : out;
}

// ---------------------------------------------------------------------------
// Build the catalog
// ---------------------------------------------------------------------------

async function buildCatalog() {
  const list = await listAllSkills();

  // Enrich each entry with body sections (responsibility, gaps, levers)
  const enriched = await Promise.all(list.map(async (s) => {
    const skill = await loadSkill(s.skillPath);
    return {
      ...s,
      responsibility: extractSection(skill.body, 'Responsibility'),
      knownGaps:      extractSection(skill.body, 'Known gaps'),
      improvementLevers: extractSection(skill.body, 'Improvement levers'),
      evalCriteria:   extractSection(skill.body, 'Evaluation criteria'),
    };
  }));

  return enriched;
}

// ---------------------------------------------------------------------------
// Render SKILLS.md
// ---------------------------------------------------------------------------

function renderSkillsMarkdown(skills) {
  const lines = [];
  lines.push('# Skills Catalog');
  lines.push('');
  lines.push('> **Auto-generated** from the frontmatter and bodies of every `skills/**/*.md` file.');
  lines.push('> Re-run with: `node scripts/pipeline/skill-catalog.js`');
  lines.push('>');
  lines.push('> See [`PIPELINE.md`](./PIPELINE.md) for how skills compose into the build flow.');
  lines.push('');
  lines.push(`Last generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('');

  // ---- At-a-glance summary table ----
  lines.push('## At a glance');
  lines.push('');
  lines.push('| Skill | Tier | Maturity | Phase | Has Prompt |');
  lines.push('|---|---|---|---|---|');
  for (const s of skills) {
    const fm = s.frontmatter || {};
    const link = `[${s.skillPath}](../skills/${s.skillPath}.md)`;
    const tier = fm.tier || '—';
    const mat  = MATURITY_BADGES[fm.maturity] || fm.maturity || '—';
    const phase = fm.phase || '—';
    const hasPrompt = s.hasPrompt ? '✓' : '—';
    lines.push(`| ${link} | ${tier} | ${mat} | ${phase} | ${hasPrompt} |`);
  }
  lines.push('');

  // ---- Group by phase ----
  lines.push('## Skills by phase');
  lines.push('');
  for (const phase of PHASE_ORDER) {
    const inPhase = skills.filter(s => s.frontmatter?.phase === phase);
    if (inPhase.length === 0) continue;
    lines.push(`### ${phase}`);
    lines.push('');
    for (const s of inPhase) {
      renderSkillEntry(lines, s);
    }
  }

  // Skills with no/unknown phase
  const orphans = skills.filter(s => !PHASE_ORDER.includes(s.frontmatter?.phase));
  if (orphans.length > 0) {
    lines.push('### (Other)');
    lines.push('');
    for (const s of orphans) renderSkillEntry(lines, s);
  }

  // ---- Tier reference ----
  lines.push('## Tier reference');
  lines.push('');
  for (const [tier, desc] of Object.entries(TIER_DESCRIPTIONS)) {
    lines.push(`- **${tier}** — ${desc}`);
  }
  lines.push('');

  // ---- Maturity reference ----
  lines.push('## Maturity reference');
  lines.push('');
  for (const [m, badge] of Object.entries(MATURITY_BADGES)) {
    const desc = {
      stub:     'Placeholder, barely works. Not safe to ship from.',
      working:  'Reliable but unpolished. Acceptable output, room to improve.',
      polished: 'Well-tuned. Edge cases handled. Iterated multiple times.',
      mature:   'Battle-tested across many builds. Has eval fixtures.',
    }[m];
    lines.push(`- ${badge} — ${desc}`);
  }
  lines.push('');

  // ---- Evolution checklist ----
  lines.push('## Evolution checklist');
  lines.push('');
  lines.push('Skills with `stub` or `working` maturity that have known gaps — these are your highest-leverage improvements:');
  lines.push('');
  const todo = skills.filter(s => ['stub', 'working'].includes(s.frontmatter?.maturity));
  for (const s of todo) {
    lines.push(`### [${s.skillPath}](../skills/${s.skillPath}.md) · ${MATURITY_BADGES[s.frontmatter?.maturity] || ''}`);
    if (s.knownGaps) {
      lines.push('');
      lines.push(s.knownGaps.slice(0, 600));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderSkillEntry(lines, s) {
  const fm = s.frontmatter || {};
  lines.push(`#### [${s.skillPath}](../skills/${s.skillPath}.md)`);
  const meta = [
    `Tier ${fm.tier || '—'}`,
    MATURITY_BADGES[fm.maturity] || fm.maturity || '—',
    fm.model ? `Model: \`${fm.model}\`` : null,
    fm.source ? `Source: \`${fm.source}\`` : null,
    fm.function ? `Function: \`${fm.function}()\`` : null,
  ].filter(Boolean).join(' · ');
  lines.push(`*${meta}*`);
  lines.push('');
  if (s.responsibility) {
    lines.push(firstSentence(s.responsibility));
    lines.push('');
  }
}

// ---------------------------------------------------------------------------
// Render PIPELINE.html — interactive at-a-glance dashboard
// ---------------------------------------------------------------------------

function renderHtml(skills) {
  // Group by phase for the dashboard
  const byPhase = {};
  for (const phase of PHASE_ORDER) byPhase[phase] = [];
  for (const s of skills) {
    const phase = s.frontmatter?.phase;
    if (byPhase[phase]) byPhase[phase].push(s);
  }

  const phaseCards = PHASE_ORDER.map((phase, i) => {
    const inPhase = byPhase[phase];
    const info = PHASE_INFO[phase] || {};

    const skillItems = inPhase.map(s => {
      const fm = s.frontmatter || {};
      const matBadge = MATURITY_BADGES[fm.maturity] || '—';
      const tier = fm.tier || '—';
      const htmlSlug = s.skillPath.replace(/\//g, '-');
      return `
        <li class="skill" data-maturity="${fm.maturity || ''}">
          <a href="./skills/${htmlSlug}.html" class="skill-name">${s.skillPath}</a>
          <span class="skill-meta">
            <span class="tier tier-${tier}">${tier}</span>
            <span class="maturity">${matBadge}</span>
          </span>
          ${s.responsibility ? `<p class="skill-resp">${escapeHtml(firstSentence(s.responsibility))}</p>` : ''}
        </li>`;
    }).join('');

    const skillBlock = inPhase.length > 0
      ? `<div class="phase-section">
           <h3 class="phase-section-h">Skills <span class="count">(${inPhase.length})</span></h3>
           <ul class="skills">${skillItems}</ul>
         </div>`
      : `<div class="phase-section">
           <h3 class="phase-section-h">Skills</h3>
           <p class="empty">None — fully deterministic phase</p>
         </div>`;

    // I/O block (with optional expandable output detail)
    const outputDetailBlock = info.outputDetail ? `
      <details class="output-detail">
        <summary>Full output schema (${info.outputDetail.length} groups)</summary>
        <dl>
          ${info.outputDetail.map(([label, fields]) =>
            `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(fields)}</dd>`
          ).join('')}
        </dl>
      </details>` : '';

    const ioBlock = (info.input || info.output) ? `
      <div class="phase-io">
        ${info.input  ? `<div><span class="io-label">In</span><span class="io-val">${escapeHtml(info.input)}</span></div>` : ''}
        <div class="io-arrow">↓</div>
        ${info.output ? `<div><span class="io-label">Out</span><span class="io-val">${escapeHtml(info.output)}</span></div>` : ''}
        ${outputDetailBlock}
      </div>` : '';

    // Tools / QC / Misc detail rows (collapsible)
    const detailRows = [];
    if (info.tools)  detailRows.push(`<dt>Tools</dt><dd>${info.tools.map(t => `<code>${escapeHtml(t)}</code>`).join(', ')}</dd>`);
    if (info.qc)     detailRows.push(`<dt>QC</dt><dd>${info.qc.map(q => `<span class="qc-item">${escapeHtml(q)}</span>`).join('')}</dd>`);
    if (info.cache)  detailRows.push(`<dt>Cache</dt><dd>${escapeHtml(info.cache)}</dd>`);
    if (info.cost)   detailRows.push(`<dt>Cost</dt><dd>${escapeHtml(info.cost)}</dd>`);
    if (info.skip)   detailRows.push(`<dt>Skip flag</dt><dd><code>${escapeHtml(info.skip)}</code></dd>`);

    const detailBlock = detailRows.length > 0
      ? `<details class="phase-detail">
           <summary>Tools · QC · cost</summary>
           <dl>${detailRows.join('')}</dl>
         </details>`
      : '';

    return `
      <article class="phase">
        <header>
          <span class="phase-num">${i + 1}</span>
          <h2>${phase}</h2>
        </header>
        ${info.summary ? `<p class="phase-summary">${escapeHtml(info.summary)}</p>` : ''}
        ${ioBlock}
        ${detailBlock}
        ${skillBlock}
      </article>`;
  }).join('');

  const totalSkills = skills.length;
  const byMaturity = {
    stub: skills.filter(s => s.frontmatter?.maturity === 'stub').length,
    working: skills.filter(s => s.frontmatter?.maturity === 'working').length,
    polished: skills.filter(s => s.frontmatter?.maturity === 'polished').length,
    mature: skills.filter(s => s.frontmatter?.maturity === 'mature').length,
  };

  const lastBuilt = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pipeline · Skills Dashboard</title>
<style>
  :root {
    --bg: #0f1115; --fg: #e7e8ea; --muted: #9098a3; --accent: #6ee7b7;
    --card: #181b22; --border: #262a33;
    --stub: #6b7280; --working: #f59e0b; --polished: #10b981; --mature: #fbbf24;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  header.top { padding: 32px 40px 16px; border-bottom: 1px solid var(--border); }
  header.top h1 { margin: 0; font-size: 24px; font-weight: 600; }
  header.top p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
  .stats { display: flex; gap: 24px; padding: 16px 40px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; }
  .stat-num { font-size: 28px; font-weight: 600; }
  .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-top: 2px; }
  .stat .stub { color: var(--stub); }
  .stat .working { color: var(--working); }
  .stat .polished { color: var(--polished); }
  .stat .mature { color: var(--mature); }
  .filters { padding: 12px 40px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .filters label { font-size: 12px; color: var(--muted); margin-right: 8px; }
  .filter-btn { background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
  .filter-btn.active { background: var(--fg); color: var(--bg); }
  main { padding: 24px 40px 80px; display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: 20px; }
  .phase { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
  .phase header { display: flex; align-items: center; gap: 10px; margin: 0; }
  .phase-num { width: 28px; height: 28px; border-radius: 50%; background: var(--border); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: var(--muted); flex-shrink: 0; }
  .phase h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .phase-summary { margin: 0; font-size: 13px; line-height: 1.55; color: #c9ccd1; }
  .phase-io { background: rgba(255,255,255,.025); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
  .phase-io > div { display: flex; align-items: flex-start; gap: 10px; }
  .phase-io .io-label { color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; font-size: 10px; padding-top: 1px; min-width: 28px; }
  .phase-io .io-val { color: var(--fg); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; line-height: 1.5; }
  .phase-io .io-arrow { color: var(--muted); justify-content: center; padding: 1px 0; }
  .output-detail { margin-top: 6px; font-size: 11px; }
  .output-detail summary { cursor: pointer; color: var(--accent); padding: 2px 0; user-select: none; font-size: 11px; }
  .output-detail summary:hover { text-decoration: underline; }
  .output-detail dl { margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .output-detail dt { color: var(--fg); font-weight: 600; font-size: 11px; }
  .output-detail dd { margin: 2px 0 0; padding-left: 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; line-height: 1.6; }
  .phase-detail { font-size: 12px; }
  .phase-detail summary { cursor: pointer; color: var(--muted); padding: 4px 0; user-select: none; }
  .phase-detail summary:hover { color: var(--fg); }
  .phase-detail dl { margin: 6px 0 0; padding: 8px 12px; background: rgba(255,255,255,.025); border: 1px solid var(--border); border-radius: 6px; display: grid; grid-template-columns: max-content 1fr; column-gap: 16px; row-gap: 6px; }
  .phase-detail dt { color: var(--muted); font-weight: 500; padding-top: 1px; }
  .phase-detail dd { margin: 0; color: var(--fg); }
  .phase-detail code { background: var(--code-bg, #0a0c10); padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--accent); }
  .phase-detail .qc-item { display: inline-block; background: var(--border); padding: 1px 6px; border-radius: 3px; margin-right: 4px; margin-bottom: 3px; font-size: 11px; }
  .phase-section { display: flex; flex-direction: column; gap: 8px; }
  .phase-section-h { margin: 0; font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
  .phase-section-h .count { color: var(--accent); font-family: ui-monospace, monospace; }
  .skills { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .skill { padding: 12px; background: rgba(255,255,255,.02); border: 1px solid var(--border); border-radius: 8px; transition: opacity .2s; }
  .skill.hidden { display: none; }
  .skill-name { color: var(--fg); text-decoration: none; font-weight: 500; font-size: 14px; }
  .skill-name:hover { color: var(--accent); }
  .skill-meta { display: flex; gap: 10px; align-items: center; margin-top: 4px; font-size: 11px; color: var(--muted); }
  .tier { background: var(--border); padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 10px; }
  .tier-L1 { background: rgba(110, 231, 183, .15); color: var(--accent); }
  .tier-L2 { background: rgba(245, 158, 11, .15); color: var(--working); }
  .tier-L3 { background: rgba(59, 130, 246, .15); color: #60a5fa; }
  .tier-L4 { background: rgba(168, 85, 247, .15); color: #c084fc; }
  .skill-resp { margin: 8px 0 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
  .empty { color: var(--muted); font-style: italic; font-size: 13px; }
  footer { padding: 20px 40px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<header class="top">
  <h1>Pipeline · Skills Dashboard</h1>
  <p>${totalSkills} skills across ${PHASE_ORDER.length} phases · auto-generated ${lastBuilt} UTC</p>
</header>

<div class="stats">
  <div class="stat"><span class="stat-num">${totalSkills}</span><span class="stat-label">Total skills</span></div>
  <div class="stat"><span class="stat-num stub">${byMaturity.stub}</span><span class="stat-label">Stub</span></div>
  <div class="stat"><span class="stat-num working">${byMaturity.working}</span><span class="stat-label">Working</span></div>
  <div class="stat"><span class="stat-num polished">${byMaturity.polished}</span><span class="stat-label">Polished</span></div>
  <div class="stat"><span class="stat-num mature">${byMaturity.mature}</span><span class="stat-label">Mature</span></div>
</div>

<div class="filters">
  <label>Filter by maturity:</label>
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="stub">Stub</button>
  <button class="filter-btn" data-filter="working">Working</button>
  <button class="filter-btn" data-filter="polished">Polished</button>
  <button class="filter-btn" data-filter="mature">Mature</button>
</div>

<main>
${phaseCards}
</main>

<footer>
  Source: <a href="./SKILLS.md">SKILLS.md</a> · <a href="./PIPELINE.md">PIPELINE.md</a> · Skills live at <code>skills/</code>
</footer>

<script>
  const buttons = document.querySelectorAll('.filter-btn');
  buttons.forEach(b => b.addEventListener('click', () => {
    buttons.forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const f = b.dataset.filter;
    document.querySelectorAll('.skill').forEach(el => {
      const m = el.dataset.maturity;
      el.classList.toggle('hidden', f !== 'all' && m !== f);
    });
  }));
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---------------------------------------------------------------------------
// Per-skill HTML page renderer
// ---------------------------------------------------------------------------

function renderSkillPage(skill, skillRaw) {
  const fm = skill.frontmatter || {};
  const tier = fm.tier || '—';
  const matBadge = MATURITY_BADGES[fm.maturity] || fm.maturity || '—';

  // Render the markdown body. Strip the frontmatter block (already used)
  // and render everything else (including the `## PROMPT` section as a
  // distinguishable code-styled block).
  let body = skillRaw.raw;
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---\n', 4);
    if (end !== -1) body = body.slice(end + 5);
  }

  // Convert the prompt section into a fenced code block so marked renders
  // it with a monospace style — clearer visual separation from prose.
  body = body.replace(
    /(\n##\s+PROMPT\s*\n)([\s\S]*)$/i,
    (_, heading, prompt) => `${heading}\n\`\`\`text\n${prompt.trim()}\n\`\`\`\n`,
  );

  const rendered = marked.parse(body);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(skill.skillPath)} · Skill</title>
<style>
  :root {
    --bg: #0f1115; --fg: #e7e8ea; --muted: #9098a3; --accent: #6ee7b7;
    --card: #181b22; --border: #262a33; --code-bg: #0a0c10;
    --stub: #6b7280; --working: #f59e0b; --polished: #10b981; --mature: #fbbf24;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  .topbar { padding: 16px 40px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .topbar a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .topbar a:hover { text-decoration: underline; }
  .topbar-meta { color: var(--muted); font-size: 12px; }
  .container { max-width: 880px; margin: 0 auto; padding: 32px 40px 80px; }
  header.skill-head { margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
  header.skill-head h1 { margin: 0 0 4px; font-size: 28px; font-weight: 600; }
  .skill-path { color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
  .badges { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
  .badge.tier { background: var(--border); font-family: ui-monospace, monospace; }
  .badge.tier-L1 { background: rgba(110, 231, 183, .15); color: var(--accent); }
  .badge.tier-L2 { background: rgba(245, 158, 11, .15); color: var(--working); }
  .badge.tier-L3 { background: rgba(59, 130, 246, .15); color: #60a5fa; }
  .badge.tier-L4 { background: rgba(168, 85, 247, .15); color: #c084fc; }
  .badge.maturity { background: var(--border); }
  .badge.phase { background: var(--card); border: 1px solid var(--border); color: var(--muted); }
  .meta-table { font-size: 13px; color: var(--muted); margin-top: 12px; }
  .meta-table strong { color: var(--fg); font-weight: 500; }
  .meta-table code { background: var(--card); padding: 1px 5px; border-radius: 3px; font-size: 12px; color: var(--accent); }
  .doc h2 { margin: 32px 0 12px; font-size: 20px; font-weight: 600; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .doc h3 { margin: 24px 0 8px; font-size: 16px; font-weight: 600; color: var(--accent); }
  .doc p { margin: 0 0 14px; }
  .doc ul, .doc ol { margin: 0 0 14px; padding-left: 24px; }
  .doc li { margin-bottom: 4px; }
  .doc a { color: var(--accent); }
  .doc strong { color: var(--fg); font-weight: 600; }
  .doc code { background: var(--card); padding: 2px 6px; border-radius: 3px; font-size: 13px; color: var(--accent); font-family: ui-monospace, SFMono-Regular, monospace; }
  .doc pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow-x: auto; margin: 0 0 16px; }
  .doc pre code { background: transparent; padding: 0; color: var(--fg); font-size: 13px; line-height: 1.5; white-space: pre; }
  .doc table { border-collapse: collapse; margin: 0 0 16px; font-size: 14px; width: 100%; }
  .doc th, .doc td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  .doc th { background: var(--card); font-weight: 600; }
  .doc blockquote { border-left: 3px solid var(--accent); padding: 4px 16px; margin: 0 0 16px; color: var(--muted); }
  .doc hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
</style>
</head>
<body>
<div class="topbar">
  <a href="../PIPELINE.html">← Back to Pipeline Dashboard</a>
  <span class="topbar-meta">Source: <code style="background:transparent">skills/${escapeHtml(skill.skillPath)}.md</code></span>
</div>

<div class="container">
  <header class="skill-head">
    <div class="skill-path">skills/${escapeHtml(skill.skillPath)}.md</div>
    <h1>${escapeHtml((fm.section || skill.skillPath.split('/').pop()).replace(/-/g, ' '))}</h1>
    <div class="badges">
      <span class="badge tier tier-${tier}">${tier}</span>
      <span class="badge maturity">${matBadge}</span>
      ${fm.phase ? `<span class="badge phase">Phase: ${escapeHtml(fm.phase)}</span>` : ''}
      ${fm.model ? `<span class="badge phase">Model: ${escapeHtml(fm.model)}</span>` : ''}
    </div>
    ${(fm.source || fm.function) ? `
    <div class="meta-table">
      ${fm.source ? `<div><strong>Source:</strong> <code>${escapeHtml(fm.source)}</code></div>` : ''}
      ${fm.function ? `<div><strong>Function:</strong> <code>${escapeHtml(fm.function)}()</code></div>` : ''}
    </div>` : ''}
  </header>

  <div class="doc">
${rendered}
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Generate everything
// ---------------------------------------------------------------------------

async function generate() {
  const skills = await buildCatalog();

  // Markdown catalog
  const md = renderSkillsMarkdown(skills);
  await writeFile(resolve(DOCS_DIR, 'SKILLS.md'), md);

  // Dashboard HTML
  const html = renderHtml(skills);
  await writeFile(resolve(DOCS_DIR, 'PIPELINE.html'), html);

  // Per-skill HTML pages (mini-site)
  await mkdir(SKILLS_HTML_DIR, { recursive: true });
  for (const s of skills) {
    const skillRaw = await loadSkill(s.skillPath);
    // Flatten the path for the filename: "content/hero" → "content-hero.html"
    const htmlSlug = s.skillPath.replace(/\//g, '-');
    const page = renderSkillPage(s, skillRaw);
    await writeFile(resolve(SKILLS_HTML_DIR, `${htmlSlug}.html`), page);
  }

  return skills.length;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const watchMode = process.argv.includes('--watch');

  console.log('Building docs from', SKILLS_ROOT);
  const count = await generate();
  console.log(`✓ Generated docs/SKILLS.md, docs/PIPELINE.html, and ${count} per-skill HTML pages.`);
  console.log(`  Open: docs/PIPELINE.html`);

  if (!watchMode) return;

  console.log('');
  console.log('👀 Watch mode active — edits to skills/**/*.md will rebuild automatically.');
  console.log('   Press Ctrl+C to stop.');

  // Debounce-ish: skip rebuilds within 200ms of the last one
  let lastRebuild = 0;
  let pending = false;

  const trigger = async (filename) => {
    const now = Date.now();
    if (now - lastRebuild < 200) {
      pending = true;
      return;
    }
    lastRebuild = now;
    try {
      // Bust the loader cache so we re-read the changed file
      const { default: cacheClear } = await import('./skill-loader.js').then(m => ({ default: () => m.listAllSkills })).catch(() => ({}));
      // Easiest cache bust: reload the loader module via cache-buster query
      // Actually: the loader's in-memory cache is per-module-instance; we can't easily clear it.
      // Workaround: import a fresh copy via a cache-busting query string each time.
      const freshLoader = await import(`./skill-loader.js?v=${Date.now()}`);
      // Mirror the generate() steps using the fresh loader
      const list = await freshLoader.listAllSkills();
      // (We use the original buildCatalog/render functions; they internally
      // call loadSkill which uses the original cache. To force re-parse,
      // we just re-import everything and re-run.)
      const fresh = await import(`./skill-catalog.js?v=${Date.now()}`);
      await fresh.generate();
      console.log(`  ↳ rebuilt (${filename || 'change detected'}) at ${new Date().toLocaleTimeString()}`);
      if (pending) {
        pending = false;
        // Re-trigger to capture changes that arrived during this rebuild
        setTimeout(() => trigger('debounced batch'), 250);
      }
    } catch (err) {
      console.error('  ↳ rebuild error:', err.message);
    }
  };

  // Recursive fs.watch on the skills directory
  watch(SKILLS_ROOT, { recursive: true }, (event, filename) => {
    if (!filename || !filename.endsWith('.md')) return;
    trigger(filename);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('skill-catalog failed:', err);
    process.exit(1);
  });
}

export { buildCatalog, renderSkillsMarkdown, renderHtml, renderSkillPage, generate };
