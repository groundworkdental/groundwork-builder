# Generator rules, from shipped defects

Source: `GENERATOR-NOTES.md` in the mansfielddds client repo — twelve rules
written from a manual audit of a site this pipeline had already produced and
shipped. Three were live on a production dental practice.

This file is the **adoption triage**: what each rule means for the generator,
and where the real fix lives. Per
[the client-change workflow](../../../groundwork-dental/References/client-change-workflow.md),
a gate beats a document whenever the defect is machine-detectable.

Status is honest: `done` means it is enforced or shipped here, not that it was
fixed on one client site.

---

## Enforced by a gate

| Rule | Gate | Status |
|---|---|---|
| **2.** Emit no reference to an asset that does not exist | `verify-launch.js` → `asset references` | **done** |
| **12.** Meta descriptions must not be truncated mid-word | `verify-launch.js` → `meta descriptions` | **done** |
| **11.** No empty auto-stubs in the section map | `verify-launch.js` → `placeholders` | **done** (shape matching) |
| **9.** Preview hostnames `noindex` from the first build | — | **queued** — needs a gate that fetches a preview URL and asserts the directive |

Rule 2 is the one worth knowing about. `og:image` defaulted to a conventional
filename the pipeline never generated, so **every social share of the site was
broken** — silently, because no page looks wrong and nothing validates an `og:`
URL. The gate resolves `src`, `href`, `og:image` and schema `image` against the
build output and fails on anything missing.

---

## Template and generator changes

| Rule | Where | Status |
|---|---|---|
| **1.** Never ship a claim the build cannot verify | `BeforeAfter.astro` needs `provenance` as a required prop with no default, union-typed, rendering its own on-page disclosure | **queued** |
| **3.** Generate derived text files, do not template them | `llms.txt` / `llms-full.txt` from config, like `robots.txt` already is | **queued** |
| **6.** `tel:` from digits, schema in E.164 | config carries `phone` and `phoneDigits`; templates never interpolate the display string into an href | **queued** |
| **7.** Attribution hook on every conversion link | `data-*-location` on conversion links, read by the GA4 handler | **partly** — handlers exist, hooks are inconsistent |
| **8.** Required media needs a component | service pages otherwise ship text-only | **queued** |
| **10.** Deploy scripts name an account, not just a project | see below | **done in practice** |

Rule 10 is not theoretical. Two Pages projects shared the name
`mansfielddds` across two accounts, and working out which one served the domain
took an afternoon. `audit-client-zone.js` now reports which project serves a
domain; deploy scripts should assert the account id too.

---

## Principles, already how we work

**Rule 4 — one config, no bypass.** Config holds facts about the practice;
`.env` and `wrangler.toml` hold build-and-deploy values only. A practice fact
in the environment channel is a bug: `PUBLIC_DISPLAY_PHONE` was documented,
set by the operator, and read by no code at all.

Corollary worth keeping: provide config for every *form* a fact is needed in.
Hours need a table form and a prose form, or pages will rewrite one into the
other and drift.

**Rule 5 — degrade gracefully, light up in one place.** An unset value renders
as nothing, and setting it lights up every dependent surface at once. We
already hold this line.

The sharp edge the audit found: **conditional copy must be as conditional as
conditional markup.** Two pages said "email is the fastest way to reach us",
which became false the moment a phone number existed. Guarding the markup is
not enough if the prose around it still asserts the old state.

---

## Asset provenance

The thread running through most of the above. Almost nothing in the asset
library is a photograph of the practice, and that is fine — as long as the
build never implies otherwise.

- A regulated claim (patient consent, credentials, outcomes) is a **required
  field with no default**. Omission must be impossible, not merely discouraged.
- Disclosure renders **on the page**. `alt` text is for assistive technology,
  not legal cover — a vendor render under a heading reading *Results* with
  "illustrative example" only in `alt` is a claim no sighted visitor can check.
- Section-level copy states only what is true of **every** item in the section.

The homepage tech section already had the right instinct — *"Product demos of
the systems we use in clinic — not footage from this office."* The rule is to
make that disclosure a required, always-rendered field.
