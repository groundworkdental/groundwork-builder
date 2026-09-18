# Design Skill — Practice Identity (Brand DNA only)

Thin judgment for **Define Brand**. Does not prescribe template look, fonts, shape, or mood→palette recipes.

**Not this file:** layout variants, type buckets, corners/elevation → catalog `--reference` `entry.json`. Section craft → Impeccable. Universal bans → `design-principles-core.md` + `anti-slop.js`.

---

## Principle: Small anchor, strong elevation

Keep only a **small identity signal** from the original site — usually the primary hue family (or logo color). Build a polished, modern system around it.

- Prefer a confident elevated palette over timid “barely changed” copies.
- Weak / chaotic / cliché originals get **more freedom** (distill, replace muddy accents, drop dental-default looks).
- Strong, distinctive originals may keep more of their character — still elevate neutrals, contrast, and cohesion.
- Never invent a generic “what dental should look like” category brand. Never copy the scrape 1:1.

---

## Color (identity only)

- **Anchor:** evolve the observed primary into a confident, accessible brand primary (CTAs, key UI).
- **System:** secondary, one intentional accent, and neutrals that pass WCAG AA (`text` on `background` ≥ 4.5:1; primary on background for large UI ≥ 3:1).
- **Surfaces:** `neutralLight` / section washes stay very light (luminance ≳ 92%).
- **Cohesion:** temperatures should read as one system; bridge warm/cool only deliberately.
- **Avoid:** hospital-blue / toothpaste-green clichés, pure `#000`, neon, purple→indigo AI defaults, high-sat primary + high-sat accent fighting each other.

Do **not** map practice type → fixed color families (no “family = taupe”, “cosmetic = navy” tables). Diversity comes from the scrape anchor + template reference, not from this skill.

---

## Out of scope here

| Concern | Owner |
|---------|--------|
| Fonts | `font-pairings.js` + catalog type bucket |
| Shape / elevation / border | Catalog `entry.json` (or brand-dna defaults if no reference) |
| Section composition | Catalog variants + director / assemble |
| Anti-slop craft detail | `design-principles-core.md`, Impeccable, `anti-slop.js` |
