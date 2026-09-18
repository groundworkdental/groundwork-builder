# Handoff: evaluate scrape + silver across multiple practices

Paste this into a fresh Claude Code session in `~/Projects/groundwork-builder`.

---

## Goal

Run **crawl (bronze) + AI extraction (silver)** against several practice sites and
evaluate extraction fidelity. Do **not** do full builds — that's a later step.

The question to answer: **does silver faithfully capture what bronze crawled?**

## Why this layer

A long prior session hardened the back half of the pipeline. Four layers now
have very different amounts of instrumentation:

| layer | evaluated by | state |
|---|---|---|
| site → **bronze** (crawl) | coverage report: nav hit-rate, service-nav hit-rate, budget skips | good |
| bronze → **silver** (AI extraction) | confidence flags only | **this is the gap** |
| silver → **plan** (Architect + Content Map) | closed disposition ledger, quality scoring | good |
| plan → **built site** | `verify-build.js` (18 assertions), coverage audits | strongest |

Nearly every bug found previously was in the last row — which is also where all
the instrumentation is. Silver has never been directly checked against bronze, so
a whole class of extraction loss could be sitting there unnoticed. The one bug
that *did* surface in this area (`staff-loss`) was a check inferring people from
image filenames because no bronze→silver comparison existed.

## Commands

Per URL — writes `_pipeline/01-bronze.json` and `_pipeline/01-scrape.json`,
skipping the expensive downstream phases:

```bash
node --env-file=.env scripts/pipeline/build-site.js \
  --url https://<site> \
  --output clients/<slug> \
  --limit 50 \
  --skip-audit --skip-pagespeed --skip-content \
  --skip-design --skip-images --skip-build --skip-seo-optimize
```

⚠️ **This exact flag combination is unverified.** Try it on one URL first and
confirm both artifacts land. If a skip flag breaks something, `--dry-run` runs
scrape + silver + merge and prints merged JSON to stdout (redirect it) — but it
exits before artifacts are written, so prefer the flags above.

Cost is silver's ~10 parallel extraction passes, a few dollars per site at most.
Crawling is free. Blog pages are fetched but excluded from every AI pass, so a
site with 50 posts costs no more to extract than one with 2.

## Candidate URLs

Already-crawled clients, useful because the vertical varies (general dentistry,
pediatric, orthodontics) and so do the CMS platforms:

```
www.springstdentistry.com          springstdentistry
www.lbpds.net                      lbpds                      (pediatric)
www.changorthodontics.com          changorthodontics          (ortho)
www.butterflybraces.com            butterfly-orthodontics     (ortho)
cutesmiles4kids.com                cute-smiles-4-kids         (pediatric)
www.bearcreekfamilydentistry.com   bearcreekfamilydentistry
www.azorthodonticcenter.com        arizona-orthodontic-centers
illinoisdentistrydallas.com        illinois-family-dentistry
```

`clients/arts-family-dentistry` is the reference build — 18/18 on `verify-build`,
already fully processed. **Don't overwrite it**; use it as the known-good
comparison.

Start with 2–3 spanning different verticals before doing all of them.

## What to actually evaluate

There is no bronze→silver check yet. **Writing one is the deliverable**, not just
running the crawls. Reconcile counts and spot the losses:

- **FAQs** — count `?`-terminated H2/H3 headings in bronze vs `silver.content.faqs`
- **Doctors** — bronze `/meet-dr-*`, `/dr-*` pages and Person JSON-LD vs `silver.doctors[]`.
  Check `provider-filter.js` logs — it drops "weak" doctors, and those may be real.
- **Staff** — non-doctor team members named in bronze vs `silver.staff[]`.
  Reference site had none, so `[]` was correct there; a site that lists hygienists
  is the real test.
- **Services** — bronze service pages vs `silver.services.offered[]`, and confirm
  each has a `source` path. That field is what grounds Content Write; empty
  `source` means a service with no provenance.
- **Testimonials / insurance / hours** — present in bronze, present in silver?
- **additionalContent** — the verbatim prose rescue. Landed at
  `merged.content.additionalContent`, not top level; anything reading only the
  top level sees an empty array. That bug cost a lot of output quality once.

Then build the check as `scripts/pipeline/_test/test-silver-fidelity.js` or a
`verify-silver.js` alongside `verify-build.js`. Follow the existing pattern:
**deterministic, no AI, runs in about a second, every assertion traceable to a
real observed loss.** Wire it into `npm test`.

## Conventions established in the prior session

Follow these — they were each learned from a bug:

1. **Validate where the value lands, not where it's produced.** Three separate
   bugs came from a correct guard sitting upstream of something that overwrote its
   work (`brand.colors` replaced after correction; a template file regenerated
   over an edit; `tailwind.config.mjs` rewritten by a later skill). In a pipeline
   this long, assume anything gets rewritten downstream.
2. **Prompt for intent, deterministic repair for guarantee.** A prompt constraint
   is advisory. Where the outcome is measurable, add a repair that doesn't depend
   on model compliance. Both layers, not one.
3. **A check that can't run must never read as a pass.** When a measurement is
   unavailable, say so — don't score it clean.
4. **Exercise the function, not just its inputs.** Four crashes shipped from
   verifying an input and never executing the line consuming it. `node --check`
   sees syntax; `test-fixtures.js` sees artifact shapes; neither calls anything.
   `_test/test-generators.js` exists for this — extend it.
5. **Prove a new check catches its bug.** Re-introduce the failure and watch the
   check fail before trusting it. Passing tests prove nothing on their own.

## Things to know that will otherwise waste your time

- **`01-scrape.json` now holds the full silver object.** It used to be a curated
  subset that silently dropped `pageInventory`, `doctors`, `navigation`, and
  `migration` — which made `--skip-scrape` resumes produce a materially worse site.
  A guard on the resume path warns if a stale artifact is loaded.
- **`01-bronze.json` is wrapped** as `{ step, timestamp, output }`. Read
  `raw.output ?? raw`. Every check in `content-coverage.js` silently no-op'd for a
  while because it read `bronze.pages` on the wrapper.
- **Blog is excluded from all silver passes** (`ai-silver/index.js` filters
  `isBlogPath`). `content.js` selects any page over 400 words, so 50 posts would
  otherwise flood every prompt. Posts are ported verbatim by `blog-migrate.js`.
- **Streaming calls have a 60s stall watchdog** (`ai-call.js`). A run that looks
  slow reports `Network: Xm Ys lost to stalls/retries` in the summary — check that
  before suspecting a code regression. One earlier run took 3h8m purely from a
  wedged socket that a total timeout couldn't detect.
- **Shell cwd resets between tool calls** in this environment. Use absolute paths
  or `cd` inside each command.

## Definition of done

1. 2–3 sites crawled + extracted, artifacts on disk
2. A deterministic bronze→silver fidelity check written, wired into `npm test`,
   and proven to catch at least one real discrepancy
3. A short written summary of what silver loses, per site, with counts

## After this

Run Architect across the same clients (`03-architecture.json`, ~$0.09 each) and
read the disposition ledgers. That finds where the IA rules break on sites that
aren't the reference one. Full builds come after both.
