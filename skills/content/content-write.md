---
tier: L1
maturity: working
phase: ContentWrite
source: scripts/pipeline/lib/ai-content.js
function: runContentWrite
model: claude-sonnet-4-6
---

# Skill: Content Write

## Responsibility

The writing pass. Takes the blueprint produced by `skills/content/content-map.md`
(the audit phase) plus silver's three-tier extraction (services / differentiators
/ additionalContent), and composes the actual copy for each page/section. The
blueprint's `contentAudit` tells Write what to **keep verbatim**, what to
**optimize**, and what to **create from scratch** — Write executes those
decisions.

Output is the same shape downstream consumers (`page-generator.js`,
`injector.js`) already expect — only the path that produces the
copy has been split into Map (audit) + Write (compose).

**Legacy single-pass mode:** when no blueprint is provided (Map didn't run, or
running in a back-compat path), Write infers source/quality/action inline using
the same rules the blueprint would have used. This keeps the function
back-compat with the old `runContentMapping` shape. The blueprint path is
preferred and produces more consistent results.

## Inputs

| Field | Type | Source | Notes |
|---|---|---|---|
| `scraped` | object | silver | Includes pageInventory[] for per-page context |
| `merged` | object | merge | Practice/doctor/services/differentiators/additionalContent for grounding |
| `audit` | object | site-audit | positioning, tone, differentiators recommendations |
| `preset` | object | preset-loader | Vertical-specific schema (currently dental only) |
| `blueprint` | object | content-map | Audit output — `{ contentAudit, coverage, differentiatorMatches, rationale }`. Optional; when absent, Write infers inline (legacy single-pass mode). |

**Silver three-tier inputs (each fed into the prompt as a tagged block):**

| Template var | Source | Purpose |
|---|---|---|
| `servicePageContent` | derived from `pageInventory` × `services.offered` | Verbatim text from each scraped service page — primary source for service intros |
| `additionalContentBlock` | `merged.additionalContent[]` | Verbatim prose rescue tagged by source path — practice's actual voice for hero/about/philosophy |
| `differentiatorsBlock` | `merged.differentiators[]` | Short labels (technology, awards, languages) — woven into service intros where relevant |
| `blueprintBlock` | `blueprint.contentAudit` | Per-section guidance from Map: action + quality + source + existing text per key. Drives Write's keep/optimize/create decisions. |
| `pageInventory` | `scraped.pageInventory` | All scraped pages condensed for the model to know what exists site-wide |

## Output schema

```json
{
  "homepage": {
    "heroHeadline": "string|null",
    "heroSubheadline": "string|null",
    "heroTagline": "string|null",
    "ctaText": "string",
    "ctaSecondaryText": "string",
    "valueProp": "string"
  },
  "about": {
    "headline": "string",
    "introParagraph": "string|null",
    "philosophy": "string|null",
    "closingCTA": "string"
  },
  "services": {
    "<slug>": {
      "headline": "string",
      "subheadline": "string|null",
      "intro": "string|null",
      "benefits": ["string"],
      "cta": "string",
      "differentiatorsWoven": ["string"]
    }
  },
  "faqs": [{ "question": "string", "answer": "string" }],
  "blogTopics": [{ "title": "string", "excerpt": "string" }],
  "locations": { "headline": "string", "intro": "string" },
  "rationale": "string — 2-3 sentences on the editorial direction"
}
```

`contentAudit` is no longer Write's output — it's produced by the upstream Map
phase and saved to `_pipeline/03-content-blueprint.json`. Write's output
focuses purely on copy.

## Evaluation criteria

- **Practice-grounded** — every headline references practice name, doctor, city, or specialty (never generic dental copy)
- **Voice match** — tone aligns with audit's `tone.recommended` recommendation
- **No fabrication** — claims only what was in the source pages or audit
- **Service entries match scraped slugs** — keys in `services` object map to silver `services.offered[].slug`
- **CTA labels are verb + noun** — "Book Your Consultation", not "Learn More"
- **Honors blueprint actions** — for each section with a `keep` action in the blueprint, output the blueprint's `existing` text verbatim. For `optimize`, lightly edit only. For `create`, write new copy grounded in the practice profile (no fabrication of awards/years/etc.)
- **Differentiators woven where blueprint says** — `blueprint.differentiatorMatches[<slug>]` lists which differentiator labels to weave into each service intro; honor this and report what was woven in `differentiatorsWoven[]`
- **Returns only JSON**

## Known gaps

- No per-archetype tone calibration — same prompt regardless of warm/specialist
- Output is consumed by section briefs but not always — some briefs go straight to scraped data
- Legacy single-pass mode (no blueprint) still works but produces less consistent results than blueprint-driven mode
- Doesn't yet check whether scraped service page content is itself weak/generic before using it verbatim — Map's quality scoring should catch this but Write doesn't double-check

## Improvement levers

1. **Easy (L1):** Per-archetype tone calibration via a `toneGuidance` block parallel to brand-direction's `colorTempGuidance`
2. **Medium:** Strict mode — refuse to fall back to legacy single-pass when a Map blueprint is expected but missing
3. **Medium:** Score scraped service page content for distinctiveness independently of the blueprint
4. **Hard:** Inject brand brief voice notes directly so Write's tone matches Brand Direction's voice rules

## Test fixtures

**References (5 fixtures, with differentiator-weaving counts showing reuse across services):**

| Fixture | Diffs in silver | Total weavings | Reuse factor |
|---|---|---|---|
| `lbpds-pediatric/content-map.json` | 33 | 66 | 2.0× |
| `chang-orthodontics/content-map.json` | 79 | 53 | 0.7× (large diff pool, conservative weaving) |
| `orange-county-dental-care/content-map.json` | 24 | 80 | **3.3× (heaviest reuse)** |
| `oc-healthy-smiles/content-map.json` | 33 | 67 | 2.0× |
| `elements-dentistry/content-map.json` | 47 | 88 | 1.9× |

The reuse factor reflects how many service intros each differentiator naturally fits — Spanish/Vietnamese spoken applies to all services; CEREC technology only to crowns/restoration. Run `node scripts/pipeline/test-fixtures.js` for shape validation.

**Future:** strict-thin-source + non-warm-tone fixtures.

---

## PROMPT

You are a content editor helping redesign a **{{verticalName}}** practice website.

Your job is to **preserve the existing content** as faithfully as possible and only fill genuine gaps where the original site was silent. You are NOT rewriting their copy — you are migrating it to a better-organized, better-designed site.

## Core principle
The practice's own words are more trustworthy than anything you could write. Prefer their exact phrasing. Only write new copy where a section is genuinely empty on the original site, and even then, keep it conservative and factual — never speculate about awards, patient counts, years of experience, or philosophy the practice didn't express themselves.

## Voice (always)

Write the way a helpful person at the front desk would talk. State what happens. Stop there.

Do not perform honesty or distinctiveness. If a fact is true, say it once in plain words. Do not add a clause that proves you are being real ("so you can see what we see", "not a slogan", "the visit is clear", "before anyone starts").

Avoid: actually, the truth is, unlike other offices, not just, we don't guess, a plan you can already see. Those are tells that the copy is trying.

If you cannot add a fact, write less. Never write a thesis about the practice's character.

## Practice Profile

**Practice Name:** {{practiceName}}
**Website:** {{domain}}
**Doctor:** {{doctorName}} ({{credentials}})
**Location:** {{city}}, {{state}}
**Phone:** {{phone}}
**Services Offered:** {{servicesList}}

{{toneGuidance}}

## Scraped Service Page Content

The following is verbatim content from each service page on the original site. Use this as the source for service descriptions — copy it directly, do not rewrite.

{{servicePageContent}}

## Blueprint from Content Map (per-section guidance)

The Content Map phase already audited the source content and decided, per section, what to keep verbatim, what to optimize, and what to create. **Honor these decisions:**

- `action: keep` → output the blueprint's `existing` text verbatim. Do not rewrite.
- `action: optimize` → lightly edit only (fix typos, split run-ons, tighten phrasing). Preserve voice and substance.
- `action: create` → write new copy grounded in the practice profile and audit positioning. Do NOT fabricate awards, patient counts, years of experience, or claims the practice didn't make.

If `blueprintBlock` says `(No blueprint provided — Map phase did not run.)`, fall back to inferring source/quality/action inline using the rules below (legacy single-pass mode).

{{blueprintBlock}}

## Practice's Own Voice — Verbatim Prose Rescue (additionalContent)

The following are distinctive prose blocks rescued verbatim from the original site, tagged by source page. These are the practice's actual words — philosophy paragraphs, welcome intros, doctor pull-quotes, office-tour copy, mission statements, etc. **Prefer this content over anything you would write yourself.** When a section asks for philosophy, intro, or hero copy, look here FIRST.

{{additionalContentBlock}}

## Differentiators (Why-Us Facts)

Short labels of facts that distinguish this practice — technology, awards, languages, financing options. Each is tagged with the page it was found on. **Weave these into service intros where relevant** (e.g. CEREC technology mentioned in the dental crowns intro). Do not invent new differentiators; only use what's listed.

{{differentiatorsBlock}}

## Existing Content — Page Inventory

{{pageInventory}}

## Existing Testimonials

{{testimonials}}

## Existing FAQs

{{existingFAQs}}

### FAQ instruction for this practice

{{faqInstruction}}

## Existing Stats

{{stats}}

## Instructions

### Source priority

Priority depends on the kind of section. Use the matching list — do not apply the
narrative order to service intros.

**For `services.<slug>` (headline / subheadline / intro):**

1. **The service's own source page** under "Scraped Service Page Content" — the
   authoritative source. Copy its sentences verbatim. This outranks
   additionalContent for service copy.
2. **additionalContent[]** — only when the source page is thin or absent, and only
   for a block that actually discusses this service.
3. **null** — no source page and nothing relevant in additionalContent. Return null.
   Do NOT write generic dental copy to fill the gap.

**For narrative sections (hero, about, philosophy, locations):**

1. **additionalContent[]** — verbatim prose from the practice. If a block matches the
   section (a "philosophy" type for about/philosophy, a "welcome" type for hero, an
   "office-tour" block for an office section), use it directly. This is their actual voice.
2. **pageInventory excerpts** — fallback when no additionalContent block matches.
3. **null** — if nothing on the site addresses this section, return null.

**When one source page backs several services** (its header lists more than one slug),
each intro still comes from that page — lead each with the sentences specific to that
service. Say less rather than paraphrasing into generic copy; do not invent
differences between them to make them look distinct.

### Per-section instructions

1. **Hero copy**: Use the existing hero headline/tagline from the site if one exists. Check additionalContent for `welcome` / `tagline` / `hero` types first. Only write a new one if no hero text exists anywhere on the site, and keep it grounded in language the practice already uses.

2. **About / philosophy**: Look for `philosophy`, `mission`, `welcome`, `community` types in additionalContent — use that prose verbatim. Doctor bios come from the silver doctors[] array (already verbatim). If nothing exists, return null. Do NOT add claims the practice didn't make.

3. **Service descriptions**: Copy the H1, meta description, and first paragraphs from the matching scraped service page verbatim. If a differentiator from the differentiators block matches the service (e.g. an "iTero scanner" technology entry on a /services/orthodontics page), mention it inline in the intro AND list its label in `differentiatorsWoven`.

   **Fallback for thin service pages:** if the scraped service page is sparse (under 50 words of body text, mostly nav/headings, or an empty stub), do NOT immediately return `intro: null`. First check the `additionalContent` block for any prose tagged with a matching `source` (e.g. an "office-tour" block from `/about` mentioning the service, a "philosophy" block touching on this care, a `technology` block describing the equipment used). If you find relevant prose, use it — and record `quality: adequate, action: optimize` in the audit. Only return `intro: null` (and `action: create`) when neither the service page NOR additionalContent has anything relevant.

4. **FAQs**: Follow the FAQ instruction above. When the practice already has FAQs, return `"faqs": []` — they are carried over verbatim by a later step and anything you write competes with the real answers. Only when the site has none may you write 3-5, and only from facts already on the site. Never invent answers about insurance, pricing, or procedures.

5. **Blog topics**: Suggest topics only based on services actually listed on the site + the practice's city. Reference differentiators when relevant (a "Spanish & Vietnamese spoken" differentiator could seed a "Multilingual Care for Long Beach Families" topic).

6. **Never fabricate**: No invented patient counts, no made-up awards, no guessed years of experience, no assumed philosophy statements. If data is missing, return null.

### Audit handoff (no contentAudit in your output)

The Content Map phase already produced the audit (saved to
`_pipeline/03-content-blueprint.json`). Write does NOT need to reproduce
`contentAudit` in its output. Focus purely on the copy.

Return a single JSON object with this exact structure:

```json
{
  "homepage": {
    "heroHeadline": "Exact text from site hero if present, or a minimal factual alternative (null if unclear)",
    "heroSubheadline": "Exact subtext from site if present, or null",
    "heroTagline": "Short brand phrase from site if present, or null",
    "ctaText": "Book Appointment",
    "ctaSecondaryText": "View Services",
    "valueProp": "One sentence describing what the practice does and where — use their own language where possible"
  },
  "about": {
    "headline": "Meet the Team (or their actual heading if present)",
    "introParagraph": "Verbatim about text from site, or null if absent",
    "philosophy": "Verbatim philosophy/mission statement from site, or null if absent",
    "closingCTA": "Ready to schedule? | Book an Appointment"
  },
  "services": {
    "EXACT-SERVICE-SLUG": {
      "headline": "H1 from their service page (or service name if no page)",
      "subheadline": "Meta description from their service page, or null",
      "intro": "First paragraph(s) verbatim from their service page, or null if no page existed",
      "benefits": [],
      "cta": "Schedule a Consultation",
      "differentiatorsWoven": ["Labels from differentiators[] that you mentioned in the intro, or [] if none applied"]
    }
  },
  "faqs": [
    {
      "question": "FAQ question (from site or answerable from site data only)",
      "answer": "Answer drawn from site content only"
    }
  ],
  "blogTopics": [
    {
      "title": "Blog post title based on actual services + location",
      "excerpt": "1-2 sentence description"
    }
  ],
  "locations": {
    "headline": "Serving {{city}} and surrounding communities",
    "intro": "Short factual sentence about the practice location"
  },
  "rationale": "2-3 sentences explaining the editorial direction — what voice you preserved, what you elevated, what gaps you flagged"
}
```

For the `services` object: include one entry for **each of these exact slugs**: {{serviceSlugs}}

Use the slug exactly as listed (e.g. `dental-crowns`, `exam-cleaning`) as the JSON key — this is how the site wires up descriptions to pages.

For `faqs`: `[]` when the practice already has FAQs. Otherwise 3-5 max, answerable from existing site content only.

For `blogTopics`: 4-5 topics max, relevant to their actual services and city.

Return ONLY the JSON object. No markdown formatting, no explanation before or after.
