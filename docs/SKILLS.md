# Skills Catalog

> **Auto-generated** from the frontmatter and bodies of every `skills/**/*.md` file.
> Re-run with: `node scripts/pipeline/skill-catalog.js`
>
> See [`PIPELINE.md`](./PIPELINE.md) for how skills compose into the build flow.

Last generated: 2026-08-10 05:54 UTC

## At a glance

| Skill | Tier | Maturity | Phase | Has Prompt |
|---|---|---|---|---|
| [_fixtures/README](../skills/_fixtures/README.md) | — | — | — | — |
| [audit/coverage-audit](../skills/audit/coverage-audit.md) | L4 | 🟡 working | Audit | — |
| [audit/site-audit](../skills/audit/site-audit.md) | L1 | 🟡 working | Audit | ✓ |
| [content/architect](../skills/content/architect.md) | L1 | experimental | Architect | ✓ |
| [content/content-map](../skills/content/content-map.md) | L1 | 🟡 working | ContentMap | ✓ |
| [content/content-write](../skills/content/content-write.md) | L1 | 🟡 working | ContentWrite | ✓ |
| [content/cta](../skills/content/cta.md) | L1 | 🟡 working | Generate | ✓ |
| [content/doctor-intro](../skills/content/doctor-intro.md) | L1 | 🟡 working | Generate | ✓ |
| [content/faq](../skills/content/faq.md) | L1 | 🟡 working | Generate | ✓ |
| [content/hero](../skills/content/hero.md) | L1 | 🟡 working | Generate | ✓ |
| [content/reviews](../skills/content/reviews.md) | L1 | 🟡 working | Generate | ✓ |
| [content/services](../skills/content/services.md) | L1 | 🟡 working | Generate | ✓ |
| [creative/derive-design-tokens](../skills/creative/derive-design-tokens.md) | L2 | 🟢 polished | Director | — |
| [creative/director](../skills/creative/director.md) | L1 | 🟢 polished | Director | ✓ |
| [extraction/image-roles](../skills/extraction/image-roles.md) | L1 | 🟢 polished | Assemble | — |
| [extraction/silver](../skills/extraction/silver.md) | L1 | 🟢 polished | Silver | ✓ |
| [pages/service-page](../skills/pages/service-page.md) | L1 | 🟡 working | Generate | ✓ |

## Skills by phase

### Silver

#### [extraction/silver](../skills/extraction/silver.md)
*Tier L1 · 🟢 polished · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/lib/ai-silver.js` · Function: `buildPrompt()`*

The bronze→silver transform.

### Assemble

#### [extraction/image-roles](../skills/extraction/image-roles.md)
*Tier L1 · 🟢 polished · Source: `scripts/pipeline/lib/assemble/binding-to-image-roles.js` · Function: `bindingToImageRoles()`*

Bridges the deterministic image binding (silver `images.items[]` roles + sourcePages joins) into the `image-roles.json` shape Astro components consume.

### Generate

#### [content/cta](../skills/content/cta.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/skills/skill-generate.js` · Function: `ctaContentBrief()`*

Produce content JSON for the closing call-to-action block: a compelling headline, soft subheadline, primary CTA, and phone.

#### [content/doctor-intro](../skills/content/doctor-intro.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/skills/skill-generate.js` · Function: `doctorContentBrief()`*

Produce the content JSON for the homepage Doctor Introduction block.

#### [content/faq](../skills/content/faq.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/skills/skill-generate.js` · Function: `faqContentBrief()`*

Produce 6–8 frequently-asked questions (with answers) for the homepage FAQ section.

#### [content/hero](../skills/content/hero.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/skills/skill-generate.js` · Function: `heroContentBrief()`*

Produce the content JSON for the homepage hero section: headline, subheadline, eyebrow, CTAs, and phone.

#### [content/reviews](../skills/content/reviews.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/skills/skill-generate.js` · Function: `reviewsContentBrief()`*

Produce content JSON for the homepage Reviews/Testimonials section.

#### [content/services](../skills/content/services.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/skills/skill-generate.js` · Function: `servicesContentBrief()`*

Produce content JSON for the homepage Services section: heading, optional eyebrow + subheading, and a per-service descriptions list.

#### [pages/service-page](../skills/pages/service-page.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/lib/ai-service-page.js` · Function: `buildPrompt()`*

Restructures a single scraped service page (raw bodyText + headings) into a clean, multi-section service detail page: headline, subheadline, intro, 3–6 typed sections (highlight / subsection / call…

### Audit

#### [audit/coverage-audit](../skills/audit/coverage-audit.md)
*Tier L4 · 🟡 working · Model: `deterministic` · Source: `scripts/pipeline/lib/coverage-audit.js` · Function: `runCoverageAudit()`*

Whole-pipeline before/after audit.

#### [audit/site-audit](../skills/audit/site-audit.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/lib/ai-audit.js` · Function: `runSiteAudit()`*

Strategic recommendations for the redesign.

### (Other)

#### [_fixtures/README](../skills/_fixtures/README.md)
*Tier — · —*

#### [content/architect](../skills/content/architect.md)
*Tier L1 · experimental · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/lib/ai-architect.js` · Function: `runArchitect()`*

Decides the **page set** of the rebuilt site, and assigns every ingested source page a **disposition** — what happened to it and where its content went.

#### [content/content-map](../skills/content/content-map.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/lib/ai-content-map.js` · Function: `runContentMap()`*

The audit pass that decides — **before any copy is written** — what each page needs and what existing source material best fits.

#### [content/content-write](../skills/content/content-write.md)
*Tier L1 · 🟡 working · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/lib/ai-content.js` · Function: `runContentWrite()`*

The writing pass.

#### [creative/derive-design-tokens](../skills/creative/derive-design-tokens.md)
*Tier L2 · 🟢 polished · Model: `deterministic` · Source: `scripts/pipeline/lib/derive-design-tokens.js` · Function: `deriveDesignTokens()`*

Deterministic mapping from Creative Director DNA + brand mood → concrete design tokens.

#### [creative/director](../skills/creative/director.md)
*Tier L1 · 🟢 polished · Model: `claude-sonnet-4-6` · Source: `scripts/pipeline/lib/ai-director.js` · Function: `buildPrompt()`*

Picks a DISTINCT visual direction for the practice — archetype, hero variant, chrome variants, motion level, radius level, section order — actively diverging from recent own-builds and the practice…

## Tier reference

- **L1** — Prompt — edit `## PROMPT` in the skill's `.md` file
- **L2** — Mapping — deterministic enum table (no AI call)
- **L3** — Component — Astro variant file
- **L4** — Pipeline step — orchestrating logic

## Maturity reference

- 🔵 stub — Placeholder, barely works. Not safe to ship from.
- 🟡 working — Reliable but unpolished. Acceptable output, room to improve.
- 🟢 polished — Well-tuned. Edge cases handled. Iterated multiple times.
- ⭐ mature — Battle-tested across many builds. Has eval fixtures.

## Evolution checklist

Skills with `stub` or `working` maturity that have known gaps — these are your highest-leverage improvements:

### [audit/coverage-audit](../skills/audit/coverage-audit.md) · 🟡 working

- `checkServicePageDepth` ratio is a single magic number (0.35) — doesn't account for legitimately short rewrites of long source pages
- `checkDifferentiators` token-matching is heuristic — labels with stop-words ("offers free consultation") can false-flag if the rebuild used different phrasing
- `no-blog-index` always fires when /blog/ doesn't exist, even if the source site had no blog — should compare against bronze
- Doctor name comparison is case-insensitive trim only — punctuation/middle-name variants (`Dr. J. Smith` vs `Dr. John Smith`) miss
- No check that rebuild homepage actually ment

### [audit/site-audit](../skills/audit/site-audit.md) · 🟡 working

- No verification that recommended services in `serviceEmphasis` actually have content depth in scraped data — can recommend emphasizing a service the practice barely offers
- "Tone" is a free-form phrase rather than a fixed taxonomy — downstream brand-direction has to regex-match it for warm/specialist signals
- Differentiators can drift toward generic ("experienced staff", "modern equipment") when scraped data is sparse
- `warnings` is often empty even when bronze data has obvious issues (404 socials, malformed JSON-LD)
- No memory of past audits for this practice — rebuilds with new scrape 

### [content/content-map](../skills/content/content-map.md) · 🟡 working

- Section keys are AI-chosen rather than schema-enforced (same gap as combined version)
- No automated check that `source` actually contains the `existing` text — model can hallucinate the source attribution
- Quality scoring is subjective per-run — same content might score `adequate` one run, `strong` another
- Doesn't yet score whether scraped service page content is itself weak/generic before recommending `keep`

### [content/content-write](../skills/content/content-write.md) · 🟡 working

- No per-archetype tone calibration — same prompt regardless of warm/specialist
- Output is consumed by section briefs but not always — some briefs go straight to scraped data
- Legacy single-pass mode (no blueprint) still works but produces less consistent results than blueprint-driven mode
- Doesn't yet check whether scraped service page content is itself weak/generic before using it verbatim — Map's quality scoring should catch this but Write doesn't double-check

### [content/cta](../skills/content/cta.md) · 🟡 working

- Tone calibration is uniform — same prompt for warm-family vs. clinical-specialist
- Doesn't pull differentiators from the audit (e.g. "same-day", "free consultation") to specialize the CTA copy
- Subheadline can drift toward generic "We can't wait to meet you"

### [content/doctor-intro](../skills/content/doctor-intro.md) · 🟡 working

- AI was previously ignoring locked values (overwriting `name` with a shorter form) — the LOCKED FIELDS section was added to fix this; needs ongoing validation
- No automatic enforcement that the output's locked fields match input — caller should validate post-hoc
- Eyebrow can still default to generic "Meet Our Doctor" when source bio is sparse
- No explicit handling of multi-doctor practices (this is the homepage primary slot only)

### [content/faq](../skills/content/faq.md) · 🟡 working

- No deduplication when scraped FAQs and service-derived FAQs ask the same question
- Doesn't cross-check answers against scraped content for accuracy (could fabricate plausible-but-wrong answers about insurance specifics)
- Category taxonomy is fixed — can't yet add custom categories per practice (e.g. "Pediatric" for kid-focused practices)
- No tone calibration — same prompt for warm-family practice and clinical-specialist practice

### [content/hero](../skills/content/hero.md) · 🟡 working

- No tone calibration — same prompt for warm-family vs. clinical-specialist practices
- Doesn't use the existing scraped hero copy as a stylistic reference (only the tagline field)
- No length validator — caller doesn't enforce ≤10 words
- Subheadline can drift into restating the headline

### [content/reviews](../skills/content/reviews.md) · 🟡 working

- No verification that quote text actually appears in scraped data (trust-based)
- Placeholder review when no real reviews exist is generic — could be smarter ("show fewer items" vs. "show one fake")
- No star-rating sanity check (real reviews often have varying ratings; placeholder defaults to 5)
- Doesn't surface aggregate rating sources separately from individual quotes

### [content/services](../skills/content/services.md) · 🟡 working

- No deduplication if the items array has near-synonyms ("Whitening" + "Teeth Whitening")
- No category-aware ordering (cosmetic/general/orthodontic clusters not grouped)
- desc rewrites can drift from the source description

### [pages/service-page](../skills/pages/service-page.md) · 🟡 working

- No semantic dedup between the homepage FAQ and the per-service FAQ section
- No automatic check that `headline` includes the city when natural (sometimes drops it)
- `process` and `callout-list` can be over-used — model defaults to imposing structure even when source is plain prose
- 9000-char source cap may truncate long evergreen service pages
