# Bronze → silver extraction fidelity

Baseline evaluation and the four fixes that came out of it, 2026-08-11/12.
Six sites crawled and extracted; no full builds.

The layer between bronze and silver had no instrumentation. Crawl coverage was
reported, plan quality was reported, and the built site has 18 assertions in
`verify-build.js`. Silver had only the model's own confidence flags, so
extraction loss was invisible by construction — the one bug that ever surfaced
there (`staff-loss`) was found by hand.

`scripts/pipeline/verify-silver.js` closes that. 14 deterministic checks, no AI,
no network, ~0.07s for six clients.
`scripts/pipeline/_test/test-silver-fidelity.js` proves each check fires by
reintroducing the loss it exists for. Both run in `npm test` (9 suites).

```bash
npm run verify:silver clients/<slug>
```

## Three outcomes, not two

`⊘ unmeasurable` is a distinct state that does **not** count as a pass. Silver
having no testimonials is only a defect if bronze had review prose to lose.
Three first-cut assertions were false positives that this state fixed:

| looked like loss | actually |
|---|---|
| springst `testimonials: []` with a `/reviews` page | 127 words of nav chrome around a JS review widget, 0 paragraphs. Nothing to extract. |
| lbpds `insurance: []` with `/financial-information.php` | 1326 words of payment policy naming **no carrier**: "if you have dental and/or medical insurance, as a courtesy, we will file the claim." Silver correctly captured 7 payment methods + Care Credit instead. |
| bearcreek `doctors: []` on 275 pages | a DSO that names no individual dentist anywhere — 327 discovered URLs, no team page, no Person JSON-LD. The only `Dr.` matches are street abbreviations ("Ledbetter Dr."). |

Counting is what makes these traps. On the reference site bronze carries 95
`?`-terminated H2/H3 headings against 34 extracted FAQs, which reads as 64% loss
— but most of the gap is prose section headers ("What Is Gum Recontouring?",
"Why Choose Us for Orthodontics?") that are correctly not FAQs. Every assertion
is keyed to evidence, never to a ratio.

## Where the six sites landed after the fixes

| site | vertical | ref/crawled | doctors | staff | services | FAQs | testimonials | insurance | addl. prose |
|---|---|---|---|---|---|---|---|---|---|
| arts-family-dentistry | general | 42/102 | 3 | 0 | 32 | 44 | 5 | 14 | 12 |
| springstdentistry | general | 23/59 | 2 | 0 | 25 | 0 | 0 | 1 | 3 |
| lbpds | pediatric + ortho | 42/42 | 4 | 13 | 31 | 5 | 3 | 0 | 18 |
| cute-smiles-4-kids | pediatric | 14/42 | 4 | 3 | 25 | 14 | 6 | 17 | 14 |
| arizona-orthodontic-centers | orthodontics | 35/43 | 1 | 0 | 31 | 10 | 5 | 8 | 12 |
| bearcreekfamilydentistry | general / DSO | 25/275 | 0 | 0 | 30 | 61 | 0 | 18 | 12 |

`verify-silver` now reports **zero failures** on every re-run site; lbpds is
14/14. Structural fidelity was already sound everywhere — full schema,
`pageInventory` matching the reference count with no blog leakage, every doctor
traceable to a crawled page, no fabricated service paths, hours on all six, no
pass errors. `staff` was exercised for the first time on a site that has any:
lbpds yields 13. The reference site has no non-doctor team members, so its `[]`
was correct and the bucket had never been tested.

---

## Fix 1 — services citing pages the crawl never fetched

**Was:** lbpds 15/34 services, azortho 2/28, bearcreek 1/30 cited real site URLs
whose body text was never fetched, so `source` — the field that grounds Content
Write — pointed at nothing.

Two independent defects, both in the crawl:

*Misclassification.* `categorizePath` recognises a treatment page only by its own
URL. lbpds files `/dental-exams-and-cleanings.php`, `/emergencies.php`,
`/retention.php`, `/oral-hygiene-with-braces.php` and 11 more under `other`,
whose budget is **6**, while `services` used 7 of its 28. Widening the regex is
whack-a-mole across every vertical, so the fix reads the site's own nav instead:
`serviceSectionPaths()` claims the children of any nav section labelled for a
service or discipline. On lbpds that recovers **15/15** of the missed paths.

The same misclassification also removed those pages from the *denominator* of the
service-nav metric (`categorizePath(p) === 'services'` was both the budget gate
and the measurement), so coverage reported a perfect **7/7** while 15 service
pages went missing. `buildCoverageReport` now takes the same hints. The metric
went from 7/7 to **25/25** — still 1.00, but against the honest denominator, and
that honesty is the success criterion, not the score.

*No spillover.* `visited.add(url)` ran *before* the budget check, so a
budget-rejected URL was discarded permanently. lbpds finished at 24 core pages
against `--limit 50` while throwing 22 away. Rejected URLs are now deferred
unvisited and drained in priority order while `limit` has room.

**Now:** lbpds 42 reference pages (was 24), nav hit-rate 1.00 (was 0.55),
budgetSkips 0 (was 22), and 31/31 services grounded. Its services also gained
real body text to extract from — FAQs 0 → 5, and `verify-silver` 14/14.

### The regression that came with it, and the junk it exposed

Spillover initially made things worse for two sites: cute-smiles went 17 → 42
reference pages and azortho 35 → 50, and the additions were `/feed` (5988 words
of concatenated blog), `/wp-login.php`, `/author/*`, `/category/*`, date archives
`/2021/01`, dated permalinks `/2021/01/18/<slug>`, and 15 untagged blog posts —
all of which flow into `pageInventory` and therefore every downstream prompt.

The `other` budget of 6 had been *accidentally* acting as a junk filter, and
`isBlogPath` never matched any of those patterns, so blog content was already
leaking into the reference set before the change. Two corrections:

- `JUNK_PATH` — CMS admin, auth, commerce and feed endpoints are never reference
  material at any budget, and are dropped at enqueue.
- `BLOG_FURNITURE` — author/category/tag/date archives, dated permalinks and
  pagination now classify as `blog`. Tested against adversarial keeps
  (`/2-week-smile`, `/20-years-experience`, `/1-day-crowns`, `/feedback`,
  `/feeding-your-baby`) so a loose year pattern can't eat real pages.
- Spillover skips `other` entirely. Recovering a page has to mean recovering a
  page we can name; `other` is the "no idea what this is" bucket and stays as
  bounded as it was. lbpds is unaffected because the nav hints reclassify its 15
  pages as `services` before the budget ever sees them.

cute-smiles settled at **14 reference / 28 blog** — every reference page a
genuine practice page — and its extraction improved sharply on the way
(insurance 1 → 17 plans, services 20 → 25). azortho returned to exactly its
original 35 with no flood.

**Known gap.** azortho publishes ~20 posts at bare root slugs
(`/why-you-need-to-wear-a-retainer-after-orthodontic-treatment`) with no date and
no `/blog` prefix; they are indistinguishable from service pages by path and
still sit in the reference set, as they did before any of this. The site's own
structure does identify them — they are linked from `/patient-resources/blog`,
and a rule of "linked from a blog index, categorised `other`, not in the nav"
claims 20/20 with a single false positive (`/privacy-policy`). It was **not**
implemented because `isBlogPath` also drives `blog-migrate`, which ports blog
paths verbatim as posts, so that one false positive would publish a privacy
policy as a blog post. Doing this safely needs a third category that excludes a
page from extraction without making it a post.

## Fix 2 — incomplete TLS chains reported as dead sites

Sites that omit their intermediate certificate return 200 to `curl` and fail
Node's stricter verification with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. The crawl
reported that as `http_error` — the real code is buried in `error.cause`, while
`error.message` is only "fetch failed" — and marked the practice
`unable_to_scrape`. For a lead-sourcing pipeline that means discarding healthy
prospects.

Measured over 8 attempts each: changorthodontics.com fails **8/8** (a
persistently broken chain), butterflybraces.com now succeeds **8/8** having
failed repeatedly an hour earlier. The intermittent case is the stronger argument
— a flaky chain was making the write-off non-deterministic.

`classifyHomepage` now walks the cause chain and returns `tls_chain_incomplete`,
and `isTlsTrustFailure()` lets callers separate "our trust config refused it"
from "the site is broken". It is deliberately *not* folded into
`isScrapeFailure`: the crawl really did fail and there is no bronze: the point is
only that the prospect is alive. On that kind, build-site leaves the sourcing
status untouched and prints the remedy:

```
⚠ This is a TLS trust failure, not a dead site. The server omits its
  intermediate certificate; browsers and curl tolerate that, Node does not.
  Confirm with:  curl -sSI https://... | head -1
  To crawl it, supply the missing chain via NODE_EXTRA_CA_CERTS.
  Sourcing status left unchanged — the prospect stays in the pipeline.
```

Certificate verification is not disabled anywhere. Actually crawling these sites
is a separate, deliberate decision about TLS strictness.

## Fix 3 — a declared FAQ block contributing nothing

**Was:** arts-family `/dental-implants.html` — 4140 words, an explicit "Dental
Implant FAQs" heading, prose reading "read the answers to a few of our most
frequently asked dental implant questions below", 10 question headings — returned
**zero** FAQs, on the build that scores 18/18 in `verify-build`. The other 8 of 9
FAQ-bearing pages on that site extracted correctly.

Both layers, because the prompt already said "EVERY Q+A — do not skip any":

- **Prompt** gained a per-page completeness rule: every page containing an FAQ
  block must appear in the output, and returning nothing for one is a failure
  rather than a judgement call.
- **`ai-silver/faq-repair.js`** is the deterministic guarantee. For pages that
  both declare an FAQ section in prose and carry ≥3 question headings *and*
  contributed nothing, it harvests each question heading with the prose beneath
  it from `sections` (falling back to `contentBlocks`).

Scope is deliberately narrow — harvesting every `?` heading would sweep in the
section headers the model is right to skip. It also requires **prose**: on that
same page, "Why Choose Arts Family Dentistry of Dallas for Dental Implants?" is a
question-shaped heading over a bullet list of selling points, the one sales panel
among 10 real answers, and the paragraph requirement is the whole difference
between recovering the FAQ block and padding it with marketing copy.

**Now:** a fresh end-to-end run dropped that page *again*, with the new prompt
rule in place, and the repair recovered 9 verbatim Q+A:

```
[ai-silver:faq-repair] recovered 9 Q+A the faqs pass dropped: /dental-implants.html (+9)
```

`faq coverage` went from 1/9 pages barren to **9/9 contributing, 44 FAQs total**.
Every recovered entry carries `origin: 'bronze-repair'` and the run records a
confidence flag naming the page, so the repair firing is visible rather than
papering over a model regression silently. That the prompt rule alone was
insufficient is the clearest illustration in this codebase of why a measurable
outcome needs a deterministic layer underneath the prompt.

Still lost sitewide, from pages the faqs pass never selects: the doctor-interview
Q&A on all three bio pages (*Why Did You Decide to Become a Dentist?*, *Where Did
You Study Dentistry?*) — real Q&A in the doctor's voice, on pages with 1–2
question headings. Left alone: it reads better as bio colour than as FAQ entries.

## Fix 4 — additionalContent capped below what sites actually have

**Was:** `prompts/content.md` ended with "Cap at 12 entries" and five of six
sites landed on exactly 12. The cap, not the site, was deciding how much verbatim
prose survived. 12 was never the intended figure either — `skill-catalog.js`
documents this bucket as "capped 30 items, ~2200 chars each", so the design and
the implementation disagreed by 2.5×.

The cap now scales with the pages the content pass actually reads,
`max(12, min(30, pages × 2))`, holding the documented 30 as the ceiling. This is
a pool consumers draw from *by type* (doctor / service-page / faq / blog briefs)
rather than one prompt payload, and `coverage-audit`'s
`additional-content-not-surfaced` check already reports anything rescued here
that never reaches the build — so the downside was already instrumented.

Measured by re-extraction:

| site | content pages | cap | blocks | was |
|---|---|---|---|---|
| lbpds | 15 | 30 | **18** | 12 (at cap) |
| cute-smiles-4-kids | 8 | 16 | **14** | 12 (at cap) |
| springstdentistry | 6 | 12 | 3 | 3 (never capped) |

The flat 12 was suppressing real content — lbpds gained 6 blocks, cute-smiles 2 —
and no site now sits on its ceiling, so volume follows the site. springst is
unchanged, which is the control: it never had 12 blocks to give.

The effective cap is recorded as `meta.additionalContentCap` so headroom is
measured against what actually applied. Artifacts predating that field report
`⊘ unmeasurable` rather than being judged against an assumed number.

## Two things found off to the side

**`scraper.js` was invisible to `grep`.** Line 400 used a raw NUL byte as a
never-matches delimiter (`text.split(children[0]?.text || '\0')`). A single NUL
makes a file binary to `grep` and `ripgrep`, and they report *no matches* rather
than an error — which is why searching an 867-line core module for `budget`
returned nothing and sent this investigation to the wrong file twice. Replaced
with the `\u0000` escape: identical string, searchable source. If that byte
arrived via a paste or codegen step, other files may carry one.

**`injector.js` crashed instead of reporting a missing palette.**
`missingColors` was computed at the top of `injectTailwindConfig` but its `throw`
sat 30 lines below `validatePalette` and two `ensureContrast` calls that
dereference the same colors, so a missing key died in `contrast.js` as
`Invalid hex color: "undefined"` — burying a message that names the brand step
and the exact missing keys. Guard moved to where the value is checked.

## Running the crawl+extract pass

The flag set below produces both artifacts, then **exits 1 in Phase 3**: there is
no `--skip-inject`, so injection always runs, and `--skip-design` leaves it
without a brand palette. `01-bronze.json` is written well before that and
`01-scrape.json` immediately before it, so both land. Expect the nonzero exit.

```bash
node --env-file=.env scripts/pipeline/build-site.js \
  --url https://<site> --output clients/_eval/<slug> --limit 50 \
  --skip-audit --skip-pagespeed --skip-content \
  --skip-design --skip-images --skip-build --skip-seo-optimize
```

Crawls here went to `clients/_eval/<slug>` rather than `clients/<slug>`: the
existing client directories hold complete built sites, and overwriting
`01-bronze`/`01-scrape` in place would leave `02-audit` onward describing inputs
that no longer exist. Note that 9 of the 10 client `01-scrape.json` files on disk
are still the **pre-fix curated subset** (`pagesVisited`, `servicesDetected`,
`signals`, singular `doctor`, no `pageInventory`); a `--skip-scrape` resume
against any of them rebuilds a materially worse site. `verify-silver`'s first
check catches exactly that.
