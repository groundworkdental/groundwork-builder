# Skill Fixtures

End-to-end pipeline outputs captured from real practices, used as regression
fixtures for the skill prompts.

## Structure

Each subdirectory under `_fixtures/` represents one practice's complete
pipeline run. Files are named after the phase that produced them:

```
_fixtures/<practice-slug>/
  bronze.json              — raw scraper output
  silver.json              — silver extraction (practice profile)
  audit.json               — site-audit output
  design.json              — design extraction
  brand.json               — brand direction brief
  content-blueprint.json   — content map / audit
  content-map.json         — content write (final copy)
  director-run1.json       — creative director DNA
```

## How they're produced

Run the full pipeline on a known practice:

```bash
node scripts/pipeline/_test/test-silver.js       --url https://example.com
node scripts/pipeline/test-content-map.js  --silver /tmp/silver-test/silver.json
node scripts/pipeline/test-director.js     --silver /tmp/silver-test/silver.json
```

The test harnesses save outputs to `/tmp/silver-test/`. To capture as a
fixture:

```bash
mkdir -p skills/_fixtures/<slug>
cp /tmp/silver-test/{bronze,silver,audit,design,brand,content-blueprint,content-map,director-run1}.json \
   skills/_fixtures/<slug>/
```

## How to use

Run the shape validator against every fixture (no API calls — purely structural):

```bash
node scripts/pipeline/test-fixtures.js
```

This catches regressions like:
- Silver schema fields disappearing
- Director's `dna.density` not tracking the brand brief
- Content blueprint missing required audit keys
- Brand palette losing `primary` field

Full output diffs (e.g. "did Dr. Cortez's bio shrink?") require running the
pipeline live and comparing — not yet automated.

## Existing fixtures

| Practice | Archetype family | Doctors | Services | Differentiators | Brand palette | Director archetype | Notes |
|---|---|---|---|---|---|---|---|
| `lbpds-pediatric/` | Specialist (pediatric) | 3 | 34 | 33 | `#2a5298` cool blue | editorial-asymmetric | Stress-tests parallel-per-page silver extraction. The reference fixture for multi-doctor specialist content. |
| `chang-orthodontics/` | Specialist (orthodontics) | 2 | 27 | **79** | `#1B3A5C` navy | magazine-split | Technology-heavy specialist (Invisalign Diamond, InBrace, LightForce, iTero, SureSmile). 37 differentiators woven into service intros — tests the rich-tech content path. |
| `orange-county-dental-care/` | General, multi-doctor | 2 | 40 | 24 | `#2e6b3e` forest green | magazine-split | Audit tone returned the new enum value `warm`. 80 differentiators woven across 40 service intros (~3.3× reuse). |
| `oc-healthy-smiles/` | General, large practice | **5** | 21 | 33 | `#1a4d6e` coastal navy | magazine-split | Largest doctor count tested. All 5 doctor names + bios + photos extracted correctly via parallel-per-page silver. |
| `elements-dentistry/` | **Warm-family general** | 3 | 28 | 47 | `#c4704a` **terracotta** | **card-heavy** | The warm-family archetype path. First non-specialist fixture — terracotta palette + card-heavy archetype validate the warm-family code path end-to-end. |

## Adding a new fixture

Pick practices that exercise different code paths:

- **Single-doctor general practice** — minimal site, sparse services (still missing)
- **Multi-doctor pediatric specialist** — covered by `lbpds-pediatric`
- **Multi-doctor orthodontics specialist** — covered by `chang-orthodontics`
- **General multi-doctor (mid-size)** — covered by `orange-county-dental-care` (2 docs) and `oc-healthy-smiles` (5 docs)
- **Warm-family general** — covered by `elements-dentistry`
- **Sparse / thin site** — to test catch-all behaviour when content is missing (still missing)
- **JS-rendered site** — to test scraper edge cases (still missing)
- **CMS-scale site (300+ pages)** — partial coverage; see Known limits below

## Known limits

- **CMS-scale sites (300+ pages)** can blow past the Map prompt's input-size limit. The `buildPageInventorySummary` cap of 30 priority-ranked pages keeps Map within a workable window for downstream sites, but very large CMS-driven practices (sunshinesmilesoc.com had 348 pages) may still hit transient connection errors during Map. The retry policy in `ai-call.js` (4 attempts with exponential backoff up to 10s) handles most flake; exceptionally large prompts on flaky connections may still need manual re-runs.
