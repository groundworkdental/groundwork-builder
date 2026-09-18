# Design Taste — Frontend

> **Source:** Adapted from [`design-taste-frontend`](https://github.com/Leonxlnx/taste-skill) by Leon Tao.
> Original is React/Next.js + Framer Motion oriented; this version keeps the framework-agnostic principles
> and adapts the stack-specific guidance to Groundwork Builder's reality:
> **Astro 6 (static) + Tailwind 4 + Georgia/Figtree, no Framer Motion, no React, no shadcn/ui.**
>
> **Wiring:** Human + section-craft reference. **Not** injected into brand-dna (identity uses thin
> `skills/design.md` + `design-principles-core` §A). Section generate/critique use Impeccable refs;
> fold durable anti-slop into principles-core / `anti-slop.js` when promoting a rule.

## 1. Baseline configuration dials

These are the three knobs every design generation should orient against. Default values reflect the Groundwork visual baseline (clean editorial, intentional but not theatrical motion, breathing space).

| Dial | Default | Range |
|---|---|---|
| `DESIGN_VARIANCE`  | **6** | 1 = perfect symmetry · 10 = artsy chaos |
| `MOTION_INTENSITY` | **3** | 1 = static · 10 = cinematic physics |
| `VISUAL_DENSITY`   | **3** | 1 = art gallery · 10 = pilot cockpit |

The Creative Director may pull these up or down per build to match the practice's brand vibe — bolder family / cosmetic clinics lean variance ↑; pediatric / community practices stay variance ↓. Use the dials to drive concrete decisions in the sections below.

## 2. Stack — what we actually build with

Unless explicitly overridden by the Creative Director:

- **Framework:** Astro 6, static output. No SSR, no client islands by default. Interactive pieces (mobile nav toggle, FAQ accordion) are vanilla JS inline in `.astro` components.
- **Styling:** Tailwind v4 via `@tailwindcss/vite`. No `tailwind.config.js` — config lives in `tailwind.config.mjs` for the per-client site.
- **No** Framer Motion. **No** React/Next. **No** shadcn/ui. **No** Phosphor/Radix icon libraries.
- **Icons:** Inline SVG only. 1.5–2px stroke, `currentColor`, sized via Tailwind `w-5 h-5`.
- **Fonts:** One brand display font + one body sans. Georgia is the Groundwork-internal artifact serif; client sites pick fresh per build via Creative Director.
- **ANTI-EMOJI POLICY:** Never use emojis in body content, alt text, or component output. Replace with clean SVG primitives.

### Layout guardrails

- Standardize breakpoints: `sm` (640), `md` (768), `lg` (1024), `xl` (1280).
- Contain page layouts at `max-w-6xl mx-auto` (1152px) or `max-w-7xl` for full-width feature sections.
- **Viewport stability [CRITICAL]:** Never use `h-screen` for hero sections — use `min-h-[100dvh]` to prevent layout jumping on iOS Safari.
- **Grid over flex-math:** Never write `w-[calc(33%-1rem)]`. Use CSS Grid (`grid grid-cols-1 md:grid-cols-3 gap-6`) for reliable structures.

## 3. Design engineering directives (bias correction)

LLMs default to specific UI clichés. Proactively counter them.

### Rule 1 — Deterministic typography

- **Display / headlines:** `text-4xl md:text-6xl tracking-tighter leading-none` as a strong baseline. Pull weight down to `font-normal` or `font-medium` if using a serif (Georgia, Cormorant, Fraunces) — serifs read heavier at the same weight.
- **Body:** `text-base text-charcoal/80 leading-relaxed max-w-[65ch]`. Measure between 45–75 characters.
- **ANTI-SLOP:** Don't reach for **Inter** when the brief says "premium" or "creative." Prefer Georgia (system, zero bytes — Groundwork's choice), or webfonts like Geist, Outfit, Cabinet Grotesk, Satoshi, Fraunces, Instrument Sans, Bricolage Grotesque.
- **Serif rule:** Serifs work for warmth, editorial, family-practice, cosmetic-warmth contexts. Avoid serifs on highly technical or transactional sections.
- **No oversized H1s for the sake of it.** Hierarchy is signaled by weight + color + space, not just scale.
- **Gradient text strictly discouraged for large headings.** Reserve for tiny accents.

### Rule 2 — Color calibration

- **Max 1 accent color.** Saturation < 80%. The rest is neutrals (charcoal, warm-gray, off-white) and the brand's existing palette.
- **THE LILA BAN:** AI-purple / electric-blue / neon-gradient aesthetic is **banned**. No purple button glows. No `bg-gradient-to-r from-purple-500 to-pink-500`. Default to a single high-contrast accent against a neutral base.
- **Palette consistency:** Don't mix warm and cool grays within one project. Pick a hue temperature on first decision and hold it.
- **60/30/10 rule:** ~60% dominant neutral, ~30% support, ~10% accent. Accent reserved for action/emphasis, never broad coverage.
- **NO pure black** (`#000000`). Use charcoal `#334155`, zinc-950 `#09090b`, or a desaturated off-black.

### Rule 3 — Layout diversification

- **ANTI-CENTER BIAS:** When `DESIGN_VARIANCE > 4`, centered hero/H1 sections are discouraged. Default to split-screen (50/50), left-aligned content with right-aligned asset, or asymmetric whitespace structures.
- **NO 3-equal-card row.** The generic "3 services as identical cards" is a tell. Use asymmetric grids, 2-column zig-zag, editorial lists with alternating image positions, or accordion-style.
- **Section rhythm:** Vary spacing and density between sections — `py-12` for one, `py-20` for the next, an inset hairline divider, a tinted band. Avoid "same padding everywhere" monotony.

### Rule 4 — Materiality, shadows, anti-card overuse

- **Cards only when elevation communicates hierarchy.** A featured pricing tier is a card. A list of 6 services is not — use border-top dividers, divide-y, or pure whitespace grouping.
- **When you DO use cards:** Tint the shadow toward the background hue, never gray. `shadow-[0_8px_24px_-8px_rgba(95,127,107,0.15)]` reads more refined than `shadow-lg`.
- **NO neon outer glows.** Inner borders (`border border-white/10`) or subtle tinted shadows only.

### Rule 5 — Interactive UI states

Static success states are an AI tell. Implement full cycles even for static Astro sites:

- **Empty states:** Beautifully composed, indicating what would populate the data. Applies to gallery sections with no images, blog with no posts, FAQs with no entries.
- **Hover/focus:** Buttons get a tactile press indicator on `:active` — `active:translate-y-[1px]` or `active:scale-[0.98]`.
- **Focus-visible:** Always render a visible 2px focus ring. Never `outline: none` without a replacement.
- **Loading states:** When async work happens, skeletal loaders sized to the eventual content (avoid generic spinners).

### Rule 6 — Forms

- Label sits **above** the input. Never floating, never to the side.
- Helper text in markup even if empty (`text-xs text-mid-gray mt-1`).
- Error text **below** the input, terracotta-tinted, with the field border tinting too.
- `gap-2` between input blocks. `gap-4` between form sections.
- Inputs are 44px min-height for touch targets.

## 4. Performance guardrails

- **Hardware acceleration:** Never animate `top`, `left`, `width`, `height`. Animate `transform` and `opacity` only. The browser composites these without layout/paint.
- **Grain / noise filters:** Apply only to fixed, `pointer-events-none` pseudo-elements (`fixed inset-0 z-50 pointer-events-none`). Never on scrolling containers — kills mobile GPU.
- **`will-change: transform`** sparingly. Adding it to "everything that might animate" is a memory leak; only set when an animation is imminent.
- **Z-index restraint:** Don't spam `z-50` arbitrarily. Use it strictly for systemic layers — sticky nav, modal overlays, toasts.

## 5. The dials, in detail

### `DESIGN_VARIANCE`

| Level | Layout primitives |
|---|---|
| 1–3 — Predictable | Flexbox `justify-center`, strict 12-col symmetrical grids, equal padding |
| 4–7 — Offset      | `margin-top: -2rem` overlap, varied aspect ratios (4:3 next to 16:9), left-aligned headings over centered data |
| 8–10 — Asymmetric | Masonry, fractional grids (`grid-cols-[2fr_1fr_1fr]`), massive empty zones (`pl-[20vw]`), editorial chaos |

**Mobile override:** Any asymmetric layout at `md:` MUST fall back to single-column `w-full px-4 py-8` below 768px. No horizontal scroll.

### `MOTION_INTENSITY`

| Level | What's allowed |
|---|---|
| 1–3 — Static | CSS `:hover` and `:active` only. No `transition` blocks past 200ms. |
| 4–7 — Fluid CSS | `transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1)`, `animation-delay` cascades for load-ins, scroll-driven CSS animations |
| 8–10 — Choreographed | Complex scroll reveals, parallax — but **never** `window.addEventListener('scroll')`. Use `IntersectionObserver`. Pipeline default: stay below 7. |

### `VISUAL_DENSITY`

| Level | Characterstics |
|---|---|
| 1–3 — Gallery | Huge section gaps, lots of breathing room, generous whitespace. Default for cosmetic dentistry, premium positioning. |
| 4–7 — Daily app | Normal spacing. Default for general dental practice. |
| 8–10 — Cockpit | Tiny paddings, 1px line separators, mandatory `font-mono` for numbers. Rarely needed for marketing dental sites. |

## 6. AI tells — forbidden patterns

Strictly avoid these unless explicitly requested.

### Visual & CSS

- Pure black (`#000000`) — use charcoal or zinc-950
- Default `box-shadow` outer glows — use inner borders or tinted shadows
- Oversaturated accents — desaturate to blend elegantly
- Excessive text-fill gradients on large headers
- Custom mouse cursors — outdated, hurt accessibility

### Typography

- **Inter** font for "premium" briefs — go to Georgia, Geist, Outfit, Cabinet Grotesk, Satoshi, Fraunces
- Oversized H1s for no reason — control hierarchy with weight + space first, scale second
- Serif fonts on highly technical/dashboard contexts

### Layout & spacing

- 3-equal-card horizontal "features" row — banned. Zig-zag, asymmetric, accordion, editorial instead.
- Floating elements with awkward gaps — alignment must be mathematically intentional
- Centered hero text + dark background image (the most clichéd hero in existence) — go asymmetric

### Content & data

- **NO generic names:** John Doe, Sarah Chan, Jack Su. Use realistic, specific names.
- **NO generic avatars** (lucide "user" SVG, default initials circle). Use real photos or considered styling.
- **NO fake-precise numbers:** 99.99%, 50%, 100%. Use organic data: 47.2%, 312-847-1928.
- **NO startup-slop brand names:** Acme, Nexus, SmartFlow. (Less relevant here — practice names are given to us.)
- **NO filler verbs:** "Elevate," "Seamless," "Unleash," "Next-Gen." Use concrete actions: "Book in 60 seconds," "Get the cavity filled today."

### External resources

- **No broken Unsplash links** — use `https://picsum.photos/seed/{string}/800/600` or real practice photos
- Production-ready cleanliness — every detail meticulously refined

## 7. Creative arsenal — high-end inspiration

When the Creative Director wants to escape generic territory, pull from this library:

### Hero paradigm
Stop with centered text over a dark image. Try asymmetric: text left-aligned, photo right-aligned with a stylistic fade into the background. Or full-bleed photo with text overlay in a corner pillbox. Or split-screen — text on one half, photo on the other, neither dominates.

### Navigation
- **Centered logo with split nav:** logo center, primary links left, CTA right
- **Magnetic CTA button:** the "Schedule Now" pill subtly pulls toward the cursor
- **Mega-menu reveal:** services dropdown reveals full-width with service photos

### Layout & grids
- **Bento grid:** asymmetric tiles for service categories (1 large + 4 small, vs uniform grid)
- **Masonry:** for gallery sections — staggered without fixed row heights
- **Sticky scroll stack:** "Why we're different" cards that stick + stack as you scroll
- **Split-screen scroll:** left half stays static while right scrolls (or vice versa) for testimonials

### Cards & containers
- **Spotlight border:** card borders subtly illuminate under the cursor
- **Glassmorphism panel:** true frosted glass with inner refraction borders, used sparingly for floating CTAs
- **Tilt card:** 3D-tilting card tracking the mouse position — works well for individual service callouts

### Scroll animations (CSS-only, no Framer)
- **Sticky reveal:** sections that animate-in as they enter viewport via `@starting-style` or IntersectionObserver
- **Horizontal scroll hijack:** vertical scroll becomes horizontal pan (use sparingly — works for "before/after" sections)
- **Scroll progress path:** SVG line that draws itself as the page scrolls

### Typography
- **Kinetic marquee:** infinite scrolling text bands for "Patients say…" testimonial reels
- **Text mask reveal:** massive section heading as a window to a photo background
- **Circular text:** stamp-style text wrapping a logo or doctor portrait

### Micro-interactions
- **Tactile press feedback:** every interactive element gets a subtle `:active` transform
- **Skeleton shimmer:** for any async section, the loading state shimmers
- **Ripple click:** subtle wave from the click coordinates on CTAs

## 8. Pre-flight check

Before considering a section complete, every Astro component must pass:

- [ ] Mobile fallback to single-column `w-full px-4` below `md:` is guaranteed for any variance ≥ 4 design
- [ ] Full-height heroes use `min-h-[100dvh]`, not `h-screen`
- [ ] Hover, focus-visible, and active states are all implemented (not just hover)
- [ ] Empty / loading / error states exist for any async or conditional content
- [ ] Cards are used only when elevation communicates hierarchy — otherwise prefer hairlines and whitespace
- [ ] No emojis in body content or alt text
- [ ] No `#000000`, no Inter font, no purple/neon gradients, no 3-equal-card rows
- [ ] All animations use `transform` and `opacity` only (no `top`/`left`/`width`/`height` animation)
- [ ] Touch targets meet 44px minimum for primary actions
- [ ] Color contrast meets WCAG AA: 4.5:1 body text, 3:1 large text and UI

## 9. How this skill fits into the pipeline

| Concern | Where it actually lands |
|---------|-------------------------|
| Practice color identity | `skills/design.md` → brand-dna (not this file) |
| Universal bans / floor | `design-principles-core.md` + `lib/audit/anti-slop.js` |
| Template look (variants, type bucket, atoms) | catalog `docs/design-catalog/runs/<id>/entry.json` |
| Section Astro craft | Impeccable refs via `lib/impeccable.js` in `skill-generate` / `skill-critique` |
| Fonts | `lib/brand/font-pairings.js` (+ catalog type bucket) |

This file is a **craft cookbook** for humans and for promoting rules upward. It is **not** concatenated into brand-dna or section-generate today.

When you learn a durable best practice: put universal bans in principles-core (+ anti-slop id); put template-specific look in the catalog entry; put section execution detail in the matching Impeccable reference.
