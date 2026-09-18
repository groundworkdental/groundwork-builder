---
tier: L1
maturity: experimental
phase: Architect
source: scripts/pipeline/lib/ai-architect.js
function: runArchitect
model: claude-sonnet-4-6
---

# Skill: Architect (Information Architecture + Disposition Ledger)

## Responsibility

Decides the **page set** of the rebuilt site, and assigns every ingested source
page a **disposition** — what happened to it and where its content went.

This is the step that was missing. Content Map scores sections and Content Write
fills a fixed schema, so no phase ever reasoned about pages. The rebuild used a
hardcoded page list and silently dropped whatever didn't fit: on the reference
site, 38 informational pages became 0, and 26 pages carrying ~27k words were
301'd to the bare homepage with nothing flagging it.

**Authoritative.** The ledger drives real output: `page-port.js` writes the
`port` / `standalone-port` routes and appends `absorb-as-section` / `merge-into`
content into their targets, redirects are re-pointed from the ledger, and
navigation is mapped through it. `_pipeline/03-architecture.json` remains the
record of what was decided.

## Design principle: strict accounting, loose shape

The page set is the model's call — it should fit the practice, not a template.
What is *not* negotiable is the accounting:

- every ingested reference page gets **exactly one** disposition
- every `strong` / `adequate` page must land somewhere (never `drop`)
- every proposed page must cite at least one source page, or be justified as new

Flexibility in shape is safe only because the accounting is closed. Unassigned
pages are a hard validation failure, backfilled as `unassigned` and reported.

## Dispositions

| Disposition | Meaning |
|---|---|
| `port` | Becomes its own page in the rebuild, content carried over |
| `standalone-port` | Ported verbatim as a one-off page outside the normal IA (language variants, oddities that shouldn't be dropped or normalized) |
| `merge-into` | Content folded into another page; `target` names it |
| `absorb-as-section` | Becomes a section of a broader page rather than its own route |
| `drop` | Deliberately not carried. Requires a reason. Only valid for `weak` / `boilerplate` |

## Inputs

| Field | Type | Source | Notes |
|---|---|---|---|
| `pageQuality` | array | page-quality.js | Per-page unique-word score + `mustPreserve` flag. Deterministic. |
| `services` | array | silver | Service taxonomy the rebuild will generate pages for |
| `practice` | object | silver | Name, city — for naming location/language routes |
| `floor` | array | preset | Page types every site must have regardless of source |

## Output schema

```json
{
  "pages": [
    { "route": "/about", "type": "about", "title": "string",
      "sources": ["/about-us.html"], "rationale": "string" }
  ],
  "ledger": [
    { "source": "/se-habla-espanol.html", "disposition": "standalone-port",
      "target": "/es", "rationale": "string" }
  ],
  "rationale": "2-3 sentences on the overall architecture"
}
```

## Evaluation criteria

- **Closed ledger** — every input page appears exactly once in `ledger`
- **No silent loss** — no `mustPreserve` page has `disposition: drop`
- **Targets resolve** — every `target` names a route present in `pages`
- **Sources are real** — every `sources[]` entry is an input page path
- **Floor satisfied** — required page types all present
- **No invented pages** — every proposed page cites a source, or is a floor page
- **Service routes exist** — every `/services/<slug>` target uses a slug from silver's taxonomy

## Known gaps

- Blog is out of scope: posts are ported verbatim by `blog-migrate.js` and need no IA decision
- IA is re-derived per run; not yet pinned per client, so routes can drift between runs
- Targets under a prefix another generator owns (`/services/*`, `/team/*`) are
  validated, not authored — Architect names the destination, the taxonomy and
  doctor list decide the actual slug

---

## PROMPT

You are the information architect for a **{{verticalName}}** practice website rebuild.

The practice's existing site has been crawled. Your job is to decide **what pages
the new site should have**, and to account for **every page of the old site** —
where its content goes, or why it is being dropped.

## Practice

**Name:** {{practiceName}}
**Location:** {{city}}, {{state}}
**Services the rebuild will generate pages for:** {{serviceSlugs}}

Service pages are generated from that taxonomy, not by you. When a target is a
service page it MUST be `/services/<slug>` using a slug from that exact list —
any other service route is a 404. If a source page has no matching slug, send it
to `/services` (the index) instead of inventing a route for it.

## Required pages (the floor)

Every site must have these regardless of what the old site had:

{{floorBlock}}

Beyond the floor, the page set is yours to decide. Do not pad it to look complete,
and do not force the old site's structure onto the new one — its organization is
usually the thing being fixed.

## Source pages

Each page below was crawled, with a **unique word count**: body text that appears
on no other page. `KEEP` marks pages whose content must land somewhere in the new
site. Raw word counts are not shown because repeated nav/footer copy inflates them.

{{pagesBlock}}

## Your task

### 1. Decide the page set

Propose the routes the new site should have. For each, list which source pages
feed it. A page with no source must be one of the required floor pages — never
invent a page the practice has no content for.

### 2. Assign every source page a disposition

Use exactly one per source page:

- `port` — becomes its own page
- `standalone-port` — carried over verbatim as a one-off outside the normal IA.
  Use for content that would be lost by normalizing it: a Spanish-language page,
  a neighborhood page with real local copy, anything genuinely valuable that
  doesn't fit a standard route. Prefer this over `drop` whenever content is real.
- `merge-into` — content folded into another page; name it in `target`
- `absorb-as-section` — becomes a section of a broader page; name it in `target`
- `drop` — deliberately not carried. Give a real reason.

### Rules

1. **A `KEEP` page may never be dropped.** Merge it, absorb it, or port it.
2. **Every source page appears exactly once** in the ledger. No omissions.
3. **`target` must name a route you listed in `pages`.**
4. **Never redirect real content at the homepage.** If the only place a page could
   go is `/`, that means you have not given its content a home — fix the page set.
5. **Do not invent pages.** No page exists that has neither a source nor a floor slot.
6. Group related thin pages rather than creating a route each. Several weak pages
   about one topic usually belong as sections of one strong page.

Return ONLY a JSON object:

```json
{
  "pages": [
    {
      "route": "/about",
      "type": "about",
      "title": "Page title",
      "sources": ["/about-us.html", "/meet-your-dentists.html"],
      "rationale": "Why this page exists and what it consolidates"
    }
  ],
  "ledger": [
    {
      "source": "/about-us.html",
      "disposition": "merge-into",
      "target": "/about",
      "rationale": "Practice overview becomes the About intro"
    }
  ],
  "rationale": "2-3 sentences on the architecture you chose and why"
}
```

No markdown formatting, no explanation before or after.
