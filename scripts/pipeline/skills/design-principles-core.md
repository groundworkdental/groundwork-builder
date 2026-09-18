# Design Principles — Shared Core

> **Universal floor** for the Build→Audit loop (generate and judge share the same standard):
>
> - **Generator** (layout director + section generate): builds toward §A tenets.
> - **Judge** (pixel-quality / critique): scores against §B screenshot-observable signals.
>
> **Ownership:** THIS file = universal floor. Practice identity elevation = thin
> `skills/design.md` (brand-dna only). Template look = catalog `entry.json`.
> Section craft = Impeccable refs (`lib/impeccable.js`). `taste-frontend.md` is a
> human/craft reference — not injected into brand-dna. Ship bans mirror §A9 in
> `lib/audit/anti-slop.js` (keep ban IDs in sync).

---

## §A — Tenets (what "good" means)

1. **Small identity anchor, strong elevation.** Keep a thin thread from the practice (usually primary
   hue). Prefer a polished modern system over scrape-cloning. Weak originals get more freedom; never
   a generic category rebrand.
2. **Intentional color.** One dominant neutral base, ≤1 saturated accent (<80% sat), 60/30/10 distribution.
   Warm-with-warm / cool-with-cool — never mix temperatures without a bridge. No pure black (`#000`).
   No global mood→palette recipes (diversity from scrape anchor + catalog template).
3. **Hierarchy by weight + space, not just size.** A clear single focal point; scannable order; restraint
   over oversized H1s.
4. **Distinctive, readable type.** Heading font with character; body font that disappears. Serif+sans is
   the safe pairing. Not Inter/Roboto/Open Sans as the "premium" default. (Final faces: curated
   pairings / catalog type bucket — not LLM free-pick.)
5. **Layout variety, anti-cliché.** Avoid the centered-text-over-dark-photo hero and the 3-equal-card row
   unless a catalog reference sanctions the pattern. Prefer asymmetric/split/editorial when allowed.
   Vary section rhythm (spacing/density).
6. **Card restraint + refined materiality.** Cards only when elevation signals hierarchy; otherwise
   hairlines/whitespace. Tinted soft shadows, never gray box-shadow glows or neon.
7. **Coherence.** Color + type + shape + spacing read as ONE system with a clear point of view.
8. **Accessible by construction.** WCAG AA: 4.5:1 body, 3:1 large/UI. Visible focus states.
9. **No AI-slop tells** (the homogeneity every model converges on — ref: impeccable). Avoid:
   - **Type:** Inter/Roboto/Arial/system-default as the display face; oversized H1 with no supporting hierarchy.
   - **Color:** purple→blue / neon gradients; pure black (`#000`); **gray text on a colored background**.
   - **Layout/materiality:** **cards nested in cards**; **a rounded-square icon tile stacked above every heading**;
     **left side-accent borders** on cards; gray drop-shadow "glows" or dark outer glows; the 3-equal-card row;
     centered-text-over-dark-photo hero.
   - **Motion:** bounce/elastic easing (reads dated); animating layout props instead of transform/opacity.
   - **Content:** filler verbs ("Elevate/Seamless/Unleash"), fake-precise numbers, emoji, generic stock-photo
     emptiness, broken/placeholder imagery.

---

## §B — Screenshot-observable signals (the JUDGE's rubric)

Each scored dimension maps to what is VISIBLE in a homepage screenshot. Score 0–10 (10 = top-tier custom
agency; 8 = clearly above template-default; 6 = acceptable-but-generic; 4 = visibly flawed; 2 = broken).

| Dimension | Looks GOOD (→high) | Looks BAD (→low) |
|---|---|---|
| **brandCoherence** | the brand-dna palette + type character are visibly used and unified | generic dental-default colors; palette doesn't match the brand-dna reference; mismatched temperatures |
| **visualHierarchy** | one clear focal point, scannable top-to-bottom order, intentional emphasis | competing focal points; flat/uniform emphasis; oversized H1 with no support |
| **typography** | distinctive heading, readable body, deliberate scale/rhythm, good measure | Inter/Roboto generic feel; cramped or ballooned scale; weak pairing |
| **layoutComposition** | intentional spacing, alignment, balance; varied section rhythm; asymmetry where apt | centered-over-dark-photo hero; 3-equal-card row; uniform padding monotony; awkward gaps |
| **polish** | refined materiality (tinted soft shadows, hairlines), custom feel, considered imagery | template-generic; gray box-shadows; neon/purple; off/irrelevant hero image; placeholder vibes |
| **overall** | reads as a real, custom, on-brand practice site | reads as an AI/template default |

**Hard penalties (cap the relevant dimension ≤4 if present)** — split into two tiers
(machine partition: `lib/reference-audit.js`; rationale: `docs/design-catalog/SCHEMA.md` §5):

**Correctness bans — always enforced, never suppressible:**
an off-topic/wrong hero image; any placeholder/Lorem/TODO text; **gray text on a colored background**
(AA failure); WCAG AA violations (§A8).

**Taste bans — enforced by default; suppressible per-build when a curated catalog reference
legitimately uses the pattern** (via the entry's `audit.sanctionedPatterns`, id in parentheses):
pure black text/bg (`pure-black`); Inter as the display face on a "premium/warm" brand
(`inter-display`); centered-text-over-dark-image hero (`centered-over-dark-hero`); 3 identical
service cards (`three-equal-cards`); visible purple/neon gradient (`gradient-accent`); emoji in
content (`emoji-in-content`); **cards nested inside cards** (`nested-cards`); **a rounded-square
icon tile above every heading** (`icon-tile-above-heading`); **an uppercase eyebrow/kicker label
above every heading** (`eyebrow-above-heading` — the device is legitimate; the reflex-on-every-
section is the AI tell); **left side-accent borders on cards** (`side-accent-border`);
**gray drop-shadow "glows" / dark outer glows** (`gray-glow-shadow`).

When a build follows a catalog reference, a sanctioned pattern is judged on EXECUTION quality only
— and the reference's `fidelityChecks` become additional pass/fail gates (the judge's question
shifts from "is this good taste?" to "is this faithful to the reference and technically sound?").

---

## §C — Notes for the refine loop

**Reference-led builds:** fix-skills fire only on a failed `fidelityCheck` or a correctness ban —
never on a sanctioned taste pattern. They enforce the reference's design; they do not redesign it.

When the judge flags a low dimension, route the fix to its OWNER (never patch the render layer):
- brandCoherence/contrast → **brand-dna** tokens
- layoutComposition/polish (cliché layout, card overuse) → **layout director / variant** choice
- off/irrelevant hero → **image binding** hero selection
- typography generic → **font-pairings / catalog type bucket** (not free LLM pick)
Candidate fix-actions already in the repo: `skill-bolder`, `skill-colorize`, `skill-critique`.
