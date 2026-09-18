/**
 * skill-generate.js — AI section component generation skill.
 *
 * Takes design DNA + practice data + section type + content brief,
 * and returns a complete, valid Astro component file.
 *
 * Input:  { dna, practice, sectionType, content }
 * Output: { file, content, approach, changes }
 */

import { buildTokenContext } from '../lib/token-map.js';
import { getReferences }    from '../lib/impeccable.js';
import { getSeoReferences } from '../lib/seo-refs.js';
import { renderSkillPrompt } from '../lib/skill-loader.js';

const MODEL = 'claude-sonnet-4-6';

// Map sectionType → output file path
const SECTION_FILES = {
  hero:          'src/components/generated/HeroSection.astro',
  nav:           'src/components/Header.astro',
  footer:        'src/components/Footer.astro',
  cta:           'src/components/CTABlock.astro',
  services:      'src/components/generated/ServicesSection.astro',
  'doctor-intro': 'src/components/generated/DoctorIntro.astro',
  'stat-bar':    'src/components/generated/StatBar.astro',
  reviews:       'src/components/generated/ReviewsSection.astro',
  faq:           'src/components/generated/FaqSection.astro',
};

// Sections that use the new variant system (content JSON + pre-built layout).
// These still use the same output filenames so index.astro is unchanged;
// the file will be a shim that imports from src/components/variants/.
const VARIANT_SECTIONS = new Set(['hero', 'services', 'doctor-intro', 'reviews', 'cta', 'faq']);

// Content JSON file paths (alongside the shim .astro file)
const VARIANT_CONTENT_FILES = {
  hero:           'src/components/generated/HeroSection.content.json',
  services:       'src/components/generated/ServicesSection.content.json',
  'doctor-intro': 'src/components/generated/DoctorIntro.content.json',
  reviews:        'src/components/generated/ReviewsSection.content.json',
  cta:            'src/components/generated/CTABlock.content.json',
  faq:            'src/components/generated/FaqSection.content.json',
};

// ---------------------------------------------------------------------------
// Section-specific prompt briefs
// ---------------------------------------------------------------------------

function heroBrief(dna, practice, content) {
  return `## Section: Hero

**Requirements:**
- Include the practice name or tagline prominently
- Subheadline that speaks to patients in ${practice.city || 'the local area'}
- At least 2 CTAs: "Book Appointment" (links to /schedule) and "View Services" (links to /services)
- Phone number as a tel: link: <a href="tel:${practice.phone || ''}">${practice.phone || 'site.phone'}</a>
${dna.heroTextPosition ? `- heroTextPosition from DNA: \`${dna.heroTextPosition}\` — determines text alignment/placement
  - bottom-left: text anchored to bottom-left with overlay on full-bleed image
  - center: centered layout
  - right: text on right side of layout` : '- heroTextPosition was not specified by the director — choose the alignment that best fits the chosen heroVariant and the brand voice; do not default mechanically'}

**Content:**
- Tagline: ${content?.tagline || '[MISSING: content.tagline — do not invent generic copy; either omit the eyebrow line or write one grounded in this specific practice/doctor/city using the brief above]'}
- Headline: ${content?.headline || '[MISSING: content.headline — do not use generic phrases; write a headline grounded in this specific practice/doctor/city using the brief above]'}
- Subheadline: ${content?.subheadline || '[MISSING: content.subheadline — write one grounded in this specific practice; never generic copy]'}

**Hero variant:** \`${dna.designTokens?.heroLayout || dna.heroVariant}\`
- If full-bleed: use \`min-h-[70vh]\` and a dark overlay gradient
- If density=airy: use generous padding
- For images: use \`{imagePath(imageRoles.hero)}\` — wrap in a null check: \`{heroImg && <img ... />}\`

**Import pattern for images:**
\`\`\`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let imageRoles = { hero: null };
try {
  const rolesPath = fileURLToPath(new URL('../../public/images/image-roles.json', import.meta.url));
  imageRoles = JSON.parse(readFileSync(rolesPath, 'utf8'));
} catch { /* manifest not present */ }
import { imagePath } from '../config/design-dna';
const heroImg = imagePath(imageRoles.hero);
\`\`\``;
}

function navBrief(dna, practice, content) {
  const serviceLinks = (content?.services?.list || [])
    .slice(0, 6)
    .map(s => `  - ${s.name} → /services/${s.slug}`)
    .join('\n');

  // Top-level nav links from scraped site (excluding Home, services sub-pages, CTAs)
  // Cap at 5 visible items: Services dropdown + 4 others
  const scrapedNavLinks = (content?.navigation || [])
    .slice(0, 5)
    .map(n => {
      const path = n.href.startsWith('/') ? n.href : (() => { try { return new URL(n.href).pathname; } catch { return n.href; } })();
      return `  - ${n.text} → ${path}`;
    })
    .join('\n');

  return `## Section: Navigation Bar

**Requirements:**
- Practice name/logo on the left (or per navVariant)
- Use ONLY the nav links listed below — these have been pre-validated to exist in the template. Do NOT add any link not in this list.
- Phone number as tel: link (minimum 44px touch target) — use \`tabindex-nums\` font class so digits align: add \`tabular-nums\` to phone number element
- "Book Appointment" CTA button MUST link to \`/schedule\` — NEVER /new-patients, /contact, /appointment, or any other path
- CTA button MUST have \`ml-6\` minimum separation from the phone number
- Must be sticky: \`sticky top-0 z-50 bg-white/95 backdrop-blur-sm\`
- ALL nav link text must use \`whitespace-nowrap\` — never allow nav items to wrap to a second line

**VALID TEMPLATE ROUTES (the only pages that exist — do not link to anything else):**
  /about, /services, /services/{slug}, /blog, /gallery, /faq, /financing, /schedule

**navVariant:** \`${dna.navVariant}\`
- left-logo: logo left, links right
- centered-logo: logo center, links on both sides
- split-logo: logo center, links split equally each side

**TOP-LEVEL NAV LINKS — max 5 visible at desktop (Services dropdown counts as 1):**
${scrapedNavLinks || '  - About → /about\n  - Services → /services\n  - Blog → /blog'}

**Services dropdown — use ONLY these links (scraped from original site), max 6:**
${serviceLinks || '  (no services — link to /services only)'}
  - All Services → /services

**DROPDOWN GAP FIX (mandatory):** The dropdown wrapper must use \`pt-2\` (padding, not margin)
to bridge hover from trigger to menu. Structure:
\`\`\`
<div class="relative group">
  <button>Services ▾</button>
  <div class="absolute top-full left-0 pt-2 invisible opacity-0 group-hover:visible group-hover:opacity-100 ...">
    <div class="bg-white shadow-lg rounded p-4">
      <!-- links here -->
    </div>
  </div>
</div>
\`\`\`
The outer div has pt-2 creating an invisible hover bridge. Never use mt-2 on the inner div.

**Practice name:** ${practice.name || 'site.name'}
**Phone:** ${practice.phone || 'site.phone'}

**No TypeScript — plain JS in frontmatter only. No props needed — reads from config directly.**`;
}

function footerBrief(dna, practice) {
  const googleProfile = practice.googleProfileLink || null;
  const yelp          = practice.yelpUrl           || null;
  const facebook      = practice.facebookUrl       || null;
  const googleReview  = practice.googleReviewLink  || googleProfile || null;

  const socialBlock = [
    googleReview  ? `- Google Reviews: link to "${googleReview}"` : null,
    yelp          ? `- Yelp: link to "${yelp}"` : null,
    facebook      ? `- Facebook: link to "${facebook}"` : null,
  ].filter(Boolean).join('\n');

  return `## Section: Footer

**Requirements:**
- Practice name
- Full address (use addr.street, addr.city, addr.state, addr.zip)
- Phone as tel: link
- Office hours from site config if available, otherwise omit
- Navigation links: Home, About, Services, Blog, Schedule
- Copyright line: © {new Date().getFullYear()} {site.name}. All rights reserved.

**Social / Review links — include ALL of these if present, hardcoded as literal href strings:**
${socialBlock || '- No social links found — omit social section'}

**footerVariant:** \`${dna.footerVariant}\`
- minimal-dark: dark bg, single row, compact
- editorial-split: 2-col split with large practice name left
- classic-4col: 4-column grid with address, hours, links, contact
- compact-centered: centered single column

**Do not use any arbitrary hardcoded addresses — pull from the addr import.**
**Do NOT use site.googleReviewUrl for social links — use the literal URLs provided above.**`;
}

function ctaBrief(dna, practice, content) {
  return `## Section: CTA Block

**Requirements:**
- Compelling headline mentioning ${practice.city || 'the city'} or the practice name
- Brief subtext (1-2 sentences)
- "Book Appointment" button (links to /schedule)
- Phone number as tel: link
- The component accepts optional props: phone (string) — but also reads from site config

**ctaVariant:** \`${dna.ctaVariant}\`
- full-width-dark: dark background, full width, text centered
- split-card: white card on a brand-colored background
- inline-minimal: simple centered layout on white/neutral bg

**Content:**
- Headline: ${content?.headline || '[MISSING: cta.headline — write a CTA headline grounded in this specific practice/doctor/city; never use generic copy]'}
- Subheadline: ${content?.subheadline || '[MISSING: cta.subheadline — write one grounded in this specific practice]'}

**Props interface (add this to frontmatter):**
\`\`\`
interface Props { phone?: string; }
const { phone: propPhone } = Astro.props;
const displayPhone = propPhone || site.phone;
\`\`\``;
}

function servicesBrief(dna, content) {
  const serviceList = content?.list?.length > 0
    ? content.list.map(s => `- ${s.name}: ${s.desc || ''}`).join('\n')
    : `- General Dentistry: Cleanings, exams, and preventive care
- Cosmetic Dentistry: Veneers, whitening, and smile makeovers
- Dental Implants: Permanent tooth replacement
- Restorative Dentistry: Crowns, bridges, and dentures`;

  return `## Section: Services

**Requirements:**
- Display all services listed below
- Each service links to /services/{slug} (use a slugify helper or hardcode slugs)
- Section heading: "Our Services"
- "View all services" link at the end

**servicesVariant:** \`${dna.servicesVariant}\`
- cards-3up: 3-column card grid (grid-cols-1 md:grid-cols-2 lg:grid-cols-3)
- editorial-list: numbered list with dividers (divide-y)
- accordion: expandable items (use <details>/<summary> HTML — no JS framework)

**Services:**
${serviceList}`;
}

function doctorIntroBrief(dna, practice, content) {
  return `## Section: Doctor Introduction

**Requirements:**
- "Meet Your Dentist" label
- Doctor name + credentials heading
- Bio paragraph
- Link to /about for more
- Doctor portrait image (use imageRoles.doctorPortrait)

**doctorVariant:** \`${dna.doctorVariant}\`
- portrait-left: image on left (md:col-span-1), text on right (md:col-span-2)
- portrait-right: same but reversed
- editorial-full: wide banner image above, 2-col text below

**CRITICAL — image cropping:** doctor portraits arrive at varied resolutions and aspect ratios from scraped sites (often only 300-500px wide thumbnails). Faces are typically in the upper half of the source. ALWAYS use \`object-cover object-top\` on the portrait <img> — never \`object-cover\` alone (centers the crop and produces forehead-only results when the source is slightly wider than the container). For \`editorial-full\` banners, \`object-cover object-center\` is acceptable since the container is wide. For tall portrait containers (aspect-[4/5], aspect-[3/4]), MUST be \`object-top\`.

**Content:**
- Doctor name: ${content?.name || 'doctor.name'}
- Credentials: ${content?.credentials || 'doctor.credentials'}
- Bio: ${content?.bio || '[DOCTOR_BIO]'}`;
}

function statBarBrief(dna, practice, content) {
  const stats = content?.stats || {};
  return `## Section: Stat Bar

**Requirements:**
- Highlight 3–4 key practice statistics in a visually striking horizontal bar or grid
- Stats MUST come from the data below — do NOT invent or estimate numbers
- Include a brief label under each stat
- Section should be visually compact (dense) — acts as a trust signal between hero and services

**Available stats (only render ones with real values — null = do not show):**
- Years experience: ${stats.yearsExperience ?? 'null — do not show'}
- Happy patients: ${stats.happyPatients ?? 'null — do not show'}
- Google rating: ${stats.googleRating ?? 'null — do not show'}
- 5-star reviews: ${stats.fiveStarReviews ?? 'null — do not show'}

${dna.statBarVariant ? `**statBarVariant:** \`${dna.statBarVariant}\`` : '**statBarVariant:** not specified by director — choose the layout that best matches the brand voice and the available stats'}

**CRITICAL:** If all stats are null, output a minimal empty fragment: just \`<div></div>\`. Never render a stat with a dash, placeholder, or fabricated number.`;
}

function reviewsBrief(dna, practice, content) {
  const reviews = content?.testimonials || content?.reviews || [];
  const rating      = content?.rating      || null;
  const reviewCount = content?.reviewCount || null;
  const gmapsUrl    = content?.gmapsUrl    || practice.googleProfileLink || practice.googleReviewLink || null;

  const reviewList = reviews.slice(0, 6).map((r, i) =>
    `${i + 1}. "${r.text}" — ${r.author || 'Anonymous'}${r.rating || r.stars ? ` (${ r.rating || r.stars}★)` : ''}`
  ).join('\n');

  const aggregateBlock = (rating || reviewCount)
    ? `**Aggregate rating:** ${rating ? `${rating}/5` : ''}${reviewCount ? ` from ${reviewCount} reviews` : ''} (display this prominently — it's a strong trust signal)`
    : '';

  return `## Section: Reviews / Testimonials

**Requirements:**
- Section heading: "What Our Patients Say" (or similar)
- Display patient testimonials as cards or quotes
- Each review shows: quote text, patient name (or "Anonymous"), star rating if available
${aggregateBlock}
- "See all reviews on Google" CTA linking to: ${gmapsUrl || '#'}
  ${!gmapsUrl ? '(no Google URL available — link to /schedule instead)' : ''}

${dna.reviewsVariant ? `**reviewsVariant:** \`${dna.reviewsVariant}\`` : '**reviewsVariant:** not specified by director — choose the layout that best matches the brand voice and the number of testimonials available'}
- cards-3up: 3-column card grid with quote icons
- featured-quote: One large featured quote above a 2-column grid
- testimonial-slider: Horizontal scroll with CSS scroll-snap (no JS framework)

**Reviews to display (verbatim — do NOT fabricate or modify):**
${reviewList || '(No reviews available — this section should not have been generated)'}`;
}

function faqBrief(dna, practice, content) {
  const faqs = content?.faqs || [];
  const faqList = faqs.map((f, i) =>
    `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`
  ).join('\n\n');

  return `## Section: FAQ

**Requirements:**
- Section heading: "Frequently Asked Questions"
- Use <details>/<summary> HTML — no JavaScript framework
- Each FAQ is individually expandable
- "Have more questions? Contact us" CTA at the end

${dna.faqVariant ? `**faqVariant:** \`${dna.faqVariant}\`` : '**faqVariant:** not specified by director — choose the layout that best matches the brand voice and the number of FAQs'}

**FAQs to display (use verbatim — do not rephrase):**
${faqList || '(No FAQs available — this section should not have been generated)'}`;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Returns the relative import prefix from a section's destination file to
 * `src/config/`. Sections written to `src/components/generated/<X>.astro`
 * need `../../config/...`; sections written directly to `src/components/`
 * need `../config/...`. The depth differs because of where SECTION_FILES
 * places each component.
 */
function configImportPrefix(sectionType) {
  const filePath = SECTION_FILES[sectionType] || '';
  return filePath.startsWith('src/components/generated/') ? '../../config' : '../config';
}

// ---------------------------------------------------------------------------
// Content JSON briefs — for variant sections
// ---------------------------------------------------------------------------

async function heroContentBrief(dna, practice, content) {
  const tokens = dna.designTokens || {};
  const recommended = tokens.heroLayout || 'centered';
  return renderSkillPrompt('content/hero', {
    recommended,
    practice: {
      ...practice,
      cityOrFallback: practice.city || 'the local area',
      cityForCta:     practice.city || 'Minutes',
    },
    tagline: content?.tagline ?? null,
  });
}

async function servicesContentBrief(dna, practice, content) {
  const tokens = dna.designTokens || {};
  const recommended = tokens.servicesLayout || 'card-grid';
  const serviceList = (content?.list || content?.services?.list || []).slice(0, 8);
  const servicesJsonRaw = JSON.stringify(serviceList.map(s => ({
    name: s.name, slug: s.slug, desc: s.description || s.desc || '',
  })));
  const servicesJson = servicesJsonRaw.length > 2
    ? servicesJsonRaw
    : '[{"name":"Service Name","slug":"service-slug","desc":"Brief description of this dental service and patient benefit."}]';

  return renderSkillPrompt('content/services', {
    recommended,
    practice,
    servicesJson,
  });
}

async function doctorContentBrief(dna, practice, content) {
  const tokens = dna.designTokens || {};
  const recommended = tokens.aboutLayout || 'split-photo';
  const doctorName  = content?.nameNoTitle || content?.name || practice?.doctor || null;
  const credentials = content?.credentials || 'DDS';
  const bio         = content?.bio || '';
  const lastName    = (doctorName || 'Our Doctor').split(' ').pop();
  const displayName = doctorName || 'our doctor';
  const bioBlock = bio
    ? `Bio source material — use this, expand it, do NOT invent different facts:\n${bio.slice(0, 800)}`
    : `No bio on file — write 2–3 warm sentences specific to ${practice.city || 'this community'} and the practice's specialty. Do NOT fabricate credentials, school names, or year of graduation.`;

  // Rescued voice content from bronze — pull-quotes, philosophy paragraphs, etc.
  // The doctor brief weaves these in to ground the bio in real practice voice.
  const additional = content?.additionalContent || [];
  const additionalContentBlock = additional.length > 0
    ? `\n\n## Source voice content (rescued from original site — use phrasing/tone, do NOT fabricate facts not in here)\n\n${additional.map((it, i) => {
        const heading = it.title ? `[${it.type}] ${it.title}` : `[${it.type}]`;
        return `${i + 1}. ${heading} (from ${it.source || 'unknown'}):\n   "${it.content.slice(0, 600)}"`;
      }).join('\n\n')}`
    : '';

  return renderSkillPrompt('content/doctor-intro', {
    recommended,
    practice,
    displayName,
    credentials,
    lastName,
    bioBlock,
    additionalContentBlock,
  });
}

async function reviewsContentBrief(dna, practice, content) {
  const tokens = dna.designTokens || {};
  const recommended = tokens.testimonialsLayout || 'pull-quotes';
  const reviews = (content?.testimonials || content?.reviews || []).slice(0, 3);
  const reviewsJsonRaw = JSON.stringify(reviews.map(r => ({
    quote: r.text || r.quote || '',
    author: r.author || r.name || 'Patient',
    rating: r.rating || 5,
  })));
  const reviewsJson = reviews.length > 0
    ? reviewsJsonRaw
    : '[{"quote":"The care and attention I received was exceptional. I could not be happier with my results.","author":"Verified Patient","rating":5}]';
  const googleUrl = content?.gmapsUrl || content?.googleReviewsUrl || practice?.googleReviewsUrl || null;
  const reviewsGuidance = reviews.length > 0
    ? 'Use the provided review quotes verbatim — do NOT rephrase or fabricate.'
    : 'No real reviews available — note: use the placeholder above only.';

  return renderSkillPrompt('content/reviews', {
    recommended,
    practice,
    reviewsJson,
    aggregateRating: content?.aggregateRating || 5,
    reviewCount: content?.reviewCount ?? null,
    googleUrl: googleUrl ? `"${googleUrl}"` : 'null',
    reviewsGuidance,
  });
}

async function ctaContentBrief(dna, practice, content) {
  const tokens = dna.designTokens || {};
  const recommended = tokens.ctaLayout || 'centered-banner';
  return renderSkillPrompt('content/cta', {
    recommended,
    practice: {
      ...practice,
      cityOrFallback: practice.city || 'this area',
      cityForCta:     practice.city || 'Minutes',
    },
  });
}

async function buildContentJsonPrompt(dna, practice, sectionType, content) {
  switch (sectionType) {
    case 'hero':         return heroContentBrief(dna, practice, content);
    case 'services':     return servicesContentBrief(dna, practice, content);
    case 'doctor-intro': return doctorContentBrief(dna, practice, content);
    case 'reviews':      return reviewsContentBrief(dna, practice, content);
    case 'cta':          return ctaContentBrief(dna, practice, content);
    case 'faq':          return faqContentBrief(dna, practice, content);
    default: throw new Error(`No content brief for variant section "${sectionType}"`);
  }
}

// ---------------------------------------------------------------------------
// FAQ content brief — loads its prompt from skills/content/faq.md
// (skill .md is the source of truth; this function only assembles context)
// ---------------------------------------------------------------------------
async function faqContentBrief(dna, practice, content) {
  const tokens = dna.designTokens || {};
  const recommended = tokens.faqLayout || 'accordion-expandable';
  // content shape: { faqs, services, specialty, additionalContent } from getSectionContent
  const scrapedFaqs = (content?.faqs || []).slice(0, 8);
  const services    = (content?.services?.list || content?.services || []).slice(0, 8);
  const specialty   = content?.specialty || 'general dentistry';
  const additional  = content?.additionalContent || [];

  const scrapedFaqsBlock = scrapedFaqs.length > 0
    ? JSON.stringify(scrapedFaqs.map(f => ({ q: f.question || f.q, a: f.answer || f.a })))
    : '(none scraped — generate from Sources 2 + 3 below)';

  const servicesText = services.length > 0
    ? services.map(s => `  - ${s.name}${s.description || s.desc ? `: ${(s.description||s.desc).slice(0,100)}` : ''}`).join('\n')
    : '  (no specific services listed — assume general dentistry)';

  // Source 4: rescued voice content that often makes for grounded FAQ answers
  // (financing/insurance details, emergency policy, accessibility notes, etc.)
  const additionalContentBlock = additional.length > 0
    ? `\n\n## Source 4 — Rescued voice content (use phrasing/facts from here when answering relevant questions)\n${additional.map((it, i) => {
        const heading = it.title ? `[${it.type}] ${it.title}` : `[${it.type}]`;
        return `${i + 1}. ${heading} (from ${it.source || 'unknown'}):\n   "${(it.content || '').slice(0, 400)}"`;
      }).join('\n\n')}`
    : '';

  const lastName = (practice.doctor || '').split(' ').pop() || 'our doctor';
  const cityReferenceLine = practice.city
    ? `Reference ${practice.city} when geographically relevant`
    : '';

  return renderSkillPrompt('content/faq', {
    recommended,
    practice: {
      ...practice,
      cityOrFallback:  practice.city   || 'this area',
      doctorOrFallback: practice.doctor || '(not specified)',
    },
    scrapedFaqsBlock,
    servicesText,
    specialty,
    lastName,
    cityReferenceLine,
    additionalContentBlock,
  });
}

async function buildPrompt(dna, practice, sectionType, content, tokenContext, moleculePrompt) {
  const cfg = configImportPrefix(sectionType);
  let sectionBrief;
  switch (sectionType) {
    case 'hero':         sectionBrief = heroBrief(dna, practice, content); break;
    case 'nav':          sectionBrief = navBrief(dna, practice, content); break;
    case 'footer':       sectionBrief = footerBrief(dna, practice); break;
    case 'cta':          sectionBrief = ctaBrief(dna, practice, content); break;
    case 'services':     sectionBrief = servicesBrief(dna, content); break;
    case 'doctor-intro': sectionBrief = doctorIntroBrief(dna, practice, content); break;
    case 'stat-bar':     sectionBrief = statBarBrief(dna, practice, content); break;
    case 'reviews':      sectionBrief = reviewsBrief(dna, practice, content); break;
    case 'faq':          sectionBrief = faqBrief(dna, practice, content); break;
    default: sectionBrief = `## Section: ${sectionType}\nCreate a well-designed section for this content.`;
  }

  const designRefs = await getReferences([sectionType]);
  const seoRefs    = await getSeoReferences([sectionType]);

  return `You are a senior frontend designer and Astro component author. You have internalized the following design principles — they are not suggestions, they are the floor.

## Design Standards
${designRefs}

## SEO & Discoverability Guidelines
These standards ensure the section serves both human readers and search/AI engines. Apply them while keeping copy specific and practice-grounded — they are NOT a license to keyword-stuff or write generic filler. Schema markup is mandatory where the section type calls for it (FAQ, reviews, doctor-intro, etc.).

${seoRefs}

## Copywriting Principles (positive guidance)
These are principles for what good copy looks like at each level. NO specific phrases are given — invent fresh, practice-specific copy that follows these principles. If you cannot meet a principle for a given element with the data you have, OMIT the element. Never fall back to generic filler.

- **Eyebrow** (small uppercase line above a heading): 2–4 words that add meaning the heading does not. NOT bare metadata like the city name, state, business type, or "Welcome." Think: differentiator, audience callout, philosophy, era, neighborhood specificity, or a thematic hook for what follows. If you can't think of an eyebrow that adds something, omit it entirely.
- **Headline (h1/h2)**: one promise or one claim, ideally ≤ 10 words. Specific to this practice and city. Never repeat the practice name (the user is already on the site).
- **Subheadline**: one or two sentences that extend the headline with a concrete specific. Do NOT repeat the headline's words. Do NOT just rephrase it.
- **Body**: short paragraphs, plain language. No filler ("Welcome to our practice…"). Get to a useful sentence by the second clause.
- **CTA labels**: a verb + a specific noun ("Book Appointment", "Meet Dr. Hoang"). Never "Learn More", "Click Here", "Get Started", or "Submit".
- **Don't repeat**: if the H1 already says "Family Dentist in Long Beach", the subheadline does not need to say "family dental care in Long Beach" again with different words. Move the conversation forward.
- **Don't fabricate**: if a number, claim, credential, or quote is not in the brief, do not invent one. Omit it.
- **Don't perform honesty.** Just tell the truth. Do not add a clause that proves you are being real ("so you can see what we see", "not a slogan", "before anyone starts", "the visit is clear"). No character-thesis headlines ("We look closely, then we treat"). If you have a fact, state it. If you don't, write less.
- **Don't gatekeep**: never write "this is not that office" or "if you want X, go elsewhere".

## Doctor name handling
The \`doctor\` config object has TWO name fields — pick the right one for context:
- \`doctor.name\` — INCLUDES the title prefix (e.g. "Dr. Anthony Hoang"). Use this when nothing else in the surrounding copy provides a title. Render it as just \`{doctor.name}\`.
- \`doctor.nameNoTitle\` — name WITHOUT the prefix (e.g. "Anthony Hoang"). Use this when your copy already includes "Dr." or another honorific. Render as \`Dr. {doctor.nameNoTitle}\`.
NEVER write \`Dr. {doctor.name}\` — that produces "Dr. Dr. Anthony Hoang" because the prefix is already included. This is a hard error.

## Image source rules
- Hero, doctor portrait, gallery, and team images MUST come from the \`imageRoles\` manifest (loaded from \`public/images/image-roles.json\`) routed through the \`imagePath()\` helper. The manifest contains the verified-correct file paths for this build.
- NEVER hardcode an image src like \`/images/doctor-portrait.jpg\` or \`/images/hero.jpg\`. Those filenames don't exist; you would 404 silently.
- The pattern is always:
  \`\`\`astro
  ---
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { imagePath } from '${cfg}/design-dna';

  let imageRoles = { hero: null, doctorPortrait: null, gallery: [], team: [] };
  try {
    const rolesPath = fileURLToPath(new URL('../../../public/images/image-roles.json', import.meta.url));
    imageRoles = JSON.parse(readFileSync(rolesPath, 'utf8'));
  } catch { /* manifest not present in dev */ }

  const heroImg          = imagePath(imageRoles.hero);
  const doctorPortrait   = imagePath(imageRoles.doctorPortrait);
  ---
  \`\`\`
- Always null-check before rendering: \`{heroImg && <img src={heroImg} alt="..." />}\`. If null, do not render any \`<img>\` placeholder, and consider whether the section still makes sense without the image.

## Empty-data handling
If a key field is missing from the content brief, do NOT render an empty/placeholder version of that element:
- Empty bio → do not render the bio paragraph (and consider whether the doctor section still has enough content to render at all; if not, output a section that returns null or omit body entirely)
- No portrait image → do not render an \`<img>\` and do not leave a giant blank column. Either collapse the layout to single-column, or skip the section.
- No reviews → reviews section should not be requested for generation, but if it is, render nothing.
- Empty stats → do not render dashes or "—" placeholders. Skip the stat.

If skipping a section entirely makes sense, render an empty fragment (\`<></>\`) — the homepage dispatcher will treat that as a no-op.

## Hero overlay legibility (full-bleed variants only)
When the hero has \`heroVariant: 'full-bleed'\` AND text overlays the image, the gradient overlay MUST darken the image enough that white/light text passes WCAG AA. Concretely:
- Use a vertical gradient with at least \`from-neutral-dark/85\` (85% opacity) to \`to-transparent\` over the bottom 60% of the image where text sits. NOT \`from-neutral-dark/40\` — that's not enough on photos with light skies or pale exteriors.
- Body text on the gradient should still pass 4.5:1 contrast at the lightest pixel beneath it. If the photo is mostly light, use a stronger overlay or shift to a non-overlay variant.

## Anti-Patterns — Never Do These
- No Inter/Roboto/Open Sans/Lato/Montserrat as the primary font — pick something distinctive
- No gradient text (background-clip text)
- No purple gradients as hero backgrounds
- No 3-up icon+stat+label grid as a standalone section
- No nested cards (card inside card)
- No gray text on colored backgrounds — use a darker shade of the background hue
- No pure #000 or #gray-500 text — use tinted neutrals
- No generic "Submit" / "Click here" / "Learn More" button labels
- No overflow text in navigation — if nav items wrap, reduce count or abbreviate
- No CTA button without visible margin from adjacent elements (min 16px clearance)
- No placeholder text that disappears without a visible label replacement
- NO FABRICATED QUOTES. Never render a \`<blockquote>\`, \`<q>\`, or any quoted-text + attribution element ("— Dr. Smith", "— Jane P.", "— a patient") unless the exact quote text was provided in this prompt's content brief (typically content.reviews.testimonials, which has \`text\` + \`author\`). If you don't have a real quote with a real author, do NOT render any quote element — that is fabrication and it ships as-if-true to users. Decorative pull-quotes presented in quotation marks are NEVER acceptable unless the text came from real testimonial data.
- Section authoring rule: aspirational/branded copy (taglines, eyebrows, section headlines, button labels, intro paragraphs, decorative micro-copy) is the SITE speaking in first person — you may write these to fit the brand voice. Attributed copy (anything that claims someone specific said something) MUST come from real data passed in the content brief.

# Design DNA
- Archetype: ${dna.archetype}
- Density: ${dna.density}
- Radius: ${dna.radius}
- Card treatment: ${dna.cardTreatment}
- Motion: ${dna.motion}
${dna.headingScale ? `- Heading scale: ${dna.headingScale}` : ''}
${dna.sectionDivider ? `- Section divider: ${dna.sectionDivider}` : ''}
${dna.creativeDirection ? `- Creative direction: ${dna.creativeDirection}` : ''}
${dna.doRules?.length ? `\n# Do Rules\n${dna.doRules.slice(0,4).map(r => `- ${r}`).join('\n')}` : ''}
${dna.dontRules?.length ? `\n# Don't Rules\n${dna.dontRules.slice(0,4).map(r => `- ${r}`).join('\n')}` : ''}

# Practice
- Name: ${practice.name}
- Doctor: ${practice.doctor || ''}
- City: ${practice.city || ''}
- Phone: ${practice.phone || ''}
- Address: ${practice.address || ''}

${moleculePrompt || tokenContext}

${sectionBrief}

# Strict Astro syntax rules
1. Output ONLY the Astro component file. No explanation. No markdown code fences. No backticks wrapping the output.
2. Start with \`---\` (frontmatter open). End frontmatter with \`---\`.
3. Import practice data: \`import { site, doctor, address as addr } from '${cfg}/site'\`
4. Import DNA: \`import { designDNA } from '${cfg}/design-dna'\`
   CRITICAL: Use the EXACT import path \`${cfg}/...\`. Do not use any other relative depth.
5. ALL \`import\` statements MUST appear at the top of the frontmatter, BEFORE any \`let\`/\`const\`/\`try\`/\`if\` statements. Imports cannot follow non-import code — this is an ES module requirement.
6. Use ONLY the Tailwind classes from the token map above. No arbitrary values like \`[#2D6E7E]\` or \`[42px]\`.
7. Use \`brand-primary\` and \`brand-secondary\` color tokens (defined in tailwind.config.mjs).
7b. TEXT OPACITY — no \`text-white/70\`, \`/60\`, \`/50\`, \`/40\` (or any value below /90) on
    body or label text. The brand palette is generated per practice, so a tint that
    reads fine against one primary fails WCAG AA against a darker one: \`text-white/70\`
    over a brand-primary surface measures 3.49:1 against a 4.5 requirement, and axe
    flags it on every page the component appears on. Use solid \`text-white\` for text.
    Opacity below /90 is only acceptable on non-text elements (borders, dividers, icons
    that are decorative).
7c. TEXT ON DARK SURFACES — inside a \`bg-neutral-dark\` or \`bg-brand-secondary\`
    band, use \`text-brand-on-dark\` rather than \`text-brand-primary\` for accent
    text. \`brand-primary\` is tuned for AA against light surfaces, so on a dark
    band it measures around 2.35:1; \`brand-on-dark\` is the lightened counterpart
    and is a real token in tailwind.config.mjs.
8. NO TypeScript type annotations in frontmatter (plain JavaScript only).
9. Do NOT import React. This is Astro — use Astro template syntax only.
10. Section must be self-contained: reads config via imports, no required props (unless it's CTABlock which accepts an optional phone prop).
11. All images must be null-checked before rendering.
12. No placeholder text, no Lorem ipsum, no "[PLACEHOLDER]" strings.
13. Every interactive element (a, button) must have a hover: class.
14. NAV DROPDOWN RULE — CRITICAL: Never use \`mt-2\` or any positive top margin on dropdowns.
    This creates a gap between the trigger and menu that breaks hover. Instead use:
    \`class="absolute top-full left-0 pt-2 w-56 ..."\` — the pt-2 padding is INSIDE the
    dropdown container so the hover area is continuous. The outer div stays flush to the trigger.
15. NAV SERVICES — only link to services that were explicitly scraped from the original site.
    Never hardcode hub slugs like /services/general-dentistry or /services/cosmetic-dentistry
    unless those exact pages appeared on the original site. Use the services list from the
    design brief. Show max 6 in the dropdown with an "All Services →" link at the end.
16. Do NOT fabricate service categories or hub pages. Only list what was scraped.
17. INTERACTIVITY — Alpine.js (v3) is available globally via CDN. Use it for any toggle/accordion/dropdown
    interactive behavior (mobile menus, FAQs, etc.) via x-data, x-show, x-transition, @click.
    For nav components, prefer Alpine.js over vanilla JS <script> blocks — it's already loaded.
    DO NOT add a <script> tag to load Alpine — it's already in the layout.

Generate the Astro component now:`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateAstroContent(text) {
  const errors = [];
  if (!text.trimStart().startsWith('---')) {
    errors.push('Must start with --- frontmatter');
  }
  const firstClose = text.indexOf('---', 3);
  if (firstClose === -1) {
    errors.push('Missing closing --- for frontmatter');
  }
  if (!/<[a-z]/i.test(text)) {
    errors.push('Must contain HTML markup');
  }
  // Strip common mistake: wrapped in markdown fences
  return errors;
}

function cleanAstroContent(text, sectionType) {
  // Remove markdown code fences if AI accidentally included them
  const fenceMatch = text.match(/```(?:astro)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Remove leading/trailing prose before the ---
  const dashStart = text.indexOf('---');
  if (dashStart > 0) text = text.slice(dashStart);
  // Normalize config import paths — depth depends on where the file is written.
  // Sections in src/components/generated/ need ../../config/..., sections directly
  // in src/components/ need ../config/...
  const cfg = configImportPrefix(sectionType);
  text = text.replace(
    /from ['"](?:\.\.\/)+config\/(site|design-dna)['"]/g,
    (_m, mod) => `from '${cfg}/${mod}'`
  );
  text = hoistFrontmatterImports(text);
  return text.trim();
}

/**
 * Move every `import ...;` line in the frontmatter to the top, preserving
 * relative order among imports and among non-imports. ES modules require
 * imports to come before any other statement; the AI sometimes interleaves
 * them with `let`/`const`/`try`, which breaks esbuild with confusing errors.
 */
function hoistFrontmatterImports(text) {
  const fmStart = text.indexOf('---');
  if (fmStart < 0) return text;
  const fmEnd = text.indexOf('---', fmStart + 3);
  if (fmEnd < 0) return text;

  const before = text.slice(0, fmStart + 3);
  const fm = text.slice(fmStart + 3, fmEnd);
  const after = text.slice(fmEnd);

  const lines = fm.split('\n');
  const imports = [];
  const rest = [];
  let inMultilineImport = false;
  let importBuffer = '';

  for (const line of lines) {
    if (inMultilineImport) {
      importBuffer += '\n' + line;
      if (/['"];?\s*$/.test(line.trim())) {
        imports.push(importBuffer);
        importBuffer = '';
        inMultilineImport = false;
      }
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      // Single-line import (ends with `;` or quote on this line)
      if (/from\s+['"][^'"]+['"];?\s*$/.test(line) || /^\s*import\s+['"][^'"]+['"];?\s*$/.test(line)) {
        imports.push(line);
      } else {
        importBuffer = line;
        inMultilineImport = true;
      }
      continue;
    }
    rest.push(line);
  }
  if (importBuffer) imports.push(importBuffer);

  // If imports were already at the top, don't shuffle (preserve original spacing)
  const reordered = imports.join('\n') + (imports.length && rest.length ? '\n\n' : '') + rest.join('\n');
  return before + '\n' + reordered.replace(/^\n+/, '') + after.slice(after.indexOf('---'));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function run({ dna, practice, sectionType, content = {}, molecules = null }) {
  const start = Date.now();

  // Route variant sections to the content-JSON path
  if (VARIANT_SECTIONS.has(sectionType)) {
    return runVariantContentGen({ dna, practice, sectionType, content, start });
  }

  const filePath = SECTION_FILES[sectionType];
  if (!filePath) {
    throw new Error(`skill-generate: unknown sectionType "${sectionType}". Valid: ${Object.keys(SECTION_FILES).join(', ')}`);
  }

  const tokenContext = buildTokenContext(dna);
  // Prefer the molecule prompt (Stage 2 output) — falls back to raw token context
  const moleculePrompt = molecules?.prompt || null;
  const prompt = await buildPrompt(dna, practice, sectionType, content, tokenContext, moleculePrompt);

  const { callAnthropic } = await import('../lib/ai-call.js');

  // Nav is the most complex component — give it extra token budget; reviews/faq are also verbose
  const maxTokens = sectionType === 'nav' ? 6000 : ['reviews', 'faq'].includes(sectionType) ? 5000 : 4000;

  const res = await callAnthropic({
    phase:       `section:${sectionType}`,
    model:       MODEL,
    maxTokens,
    temperature: 0.8,
    messages:    [{ role: 'user', content: prompt }],
  });

  const raw = res.text;
  const cleaned = cleanAstroContent(raw, sectionType);
  const errors = validateAstroContent(cleaned);

  if (errors.length > 0) {
    throw new Error(`skill-generate: invalid Astro output for "${sectionType}": ${errors.join('; ')}\nFirst 200 chars: ${cleaned.slice(0, 200)}`);
  }

  const approach = `Generated ${sectionType} using ${dna.archetype} archetype with ${dna.density} density and ${dna.radius} radius (${dna.cardTreatment} cards).`;

  return {
    skill: 'generate',
    sectionType,
    file: filePath,
    content: cleaned,
    approach,
    changes: [
      {
        type: 'write',
        file: filePath,
        new: cleaned,
      },
    ],
    meta: {
      model: MODEL,
      duration_ms: Date.now() - start,
      tokens: res.usage,
    },
  };
}

/**
 * Variant content generation path.
 * AI outputs a content JSON object; the pre-built variant component handles HTML.
 * Returns { isVariant: true, jsonFile, jsonContent, shimFile, shimContent, ... }
 */
async function runVariantContentGen({ dna, practice, sectionType, content, start }) {
  const jsonFile = VARIANT_CONTENT_FILES[sectionType];
  const shimFile = SECTION_FILES[sectionType]; // same filename as legacy — index.astro unchanged
  if (!jsonFile || !shimFile) {
    throw new Error(`skill-generate: no variant mapping for "${sectionType}"`);
  }

  const prompt = await buildContentJsonPrompt(dna, practice, sectionType, content);

  const { callAnthropic } = await import('../lib/ai-call.js');

  // Generate + parse with retry. The content JSON occasionally failed to parse —
  // root cause was TRUNCATION (content-heavy sections like faq overran the 1200
  // token cap mid-array), which silently dropped the whole section. Fix: a larger
  // budget + retry the call on parse failure (tightening temperature for
  // structure) instead of giving up after one shot.
  const parseContentJson = (text) => {
    const raw = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const f = raw.indexOf('{'), l = raw.lastIndexOf('}');
    return JSON.parse(f !== -1 ? raw.slice(f, l + 1) : raw);
  };
  let contentJson, lastErr, lastRaw = '', usage = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await callAnthropic({
      phase:       `section:${sectionType}:content`,
      model:       MODEL,
      maxTokens:   2400, // headroom for content-heavy sections (faq) — avoids mid-array truncation
      temperature: attempt === 0 ? 0.65 : 0.3, // tighten on retry: favor well-formed structure
      messages:    [{ role: 'user', content: prompt }],
    });
    lastRaw = res.text;
    usage = res.usage;
    try { contentJson = parseContentJson(res.text); break; }
    catch (e) { lastErr = e; }
  }
  if (!contentJson) {
    throw new Error(`skill-generate: could not parse content JSON for "${sectionType}" after 3 attempts: ${lastErr?.message}\nRaw: ${lastRaw.slice(0, 300)}`);
  }

  // Resolve which variant to use. The archetype-derived designTokens layout is
  // AUTHORITATIVE — it's the single source of truth and guarantees a COHERENT,
  // library-valid variant set per archetype. The content AI's `variant` is NOT
  // allowed to override it (that override was discarding the director's coherent
  // archetype choice and collapsing sites onto the generic 'centered' hero).
  // contentJson.variant is only a last-resort fallback if the token is somehow absent.
  const tokens = dna.designTokens || {};
  const tokenForSection = {
    hero:           tokens.heroLayout         || 'centered',
    services:       tokens.servicesLayout     || 'card-grid',
    'doctor-intro': tokens.aboutLayout        || 'split-photo',
    reviews:        tokens.testimonialsLayout || 'card-row',
    cta:            tokens.ctaLayout          || 'centered-banner',
    faq:            tokens.faqLayout          || 'accordion-expandable',
  }[sectionType];
  const variantKey = tokenForSection || contentJson.variant;

  // Build the Astro shim that imports from the variant component.
  // Compute relative paths from the shim file's directory — critical because
  // CTABlock.astro lives at src/components/ while others are in generated/.
  const variantDir = {
    hero:           'hero',
    services:       'services',
    'doctor-intro': 'doctor-intro',
    reviews:        'reviews',
    cta:            'cta',
    faq:            'faq',
  }[sectionType];

  const variantComponentPath = `src/components/variants/${variantDir}/${variantKey}.astro`;

  function relPath(fromFile, toPath) {
    const fromParts = fromFile.split('/').slice(0, -1); // parent dir
    const toParts   = toPath.split('/');
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
    const ups   = fromParts.slice(common).map(() => '..');
    const downs = toParts.slice(common);
    const rel   = [...ups, ...downs].join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  }

  const variantImport = relPath(shimFile, variantComponentPath);
  const contentImport = relPath(shimFile, jsonFile);

  const shimContent = `---
// AUTO-GENERATED by variant-writer — do not edit. Re-run pipeline to update.
import Variant from '${variantImport}';
import content from '${contentImport}';
---
<Variant content={content} />
`;

  const approach = `Variant content JSON for ${sectionType} (layout: ${variantKey}) via ${dna.archetype} archetype.`;

  return {
    skill: 'generate',
    sectionType,
    isVariant: true,
    jsonFile,
    jsonContent: JSON.stringify(contentJson, null, 2),
    shimFile,
    shimContent,
    approach,
    changes: [
      { type: 'write', file: jsonFile,  new: JSON.stringify(contentJson, null, 2) },
      { type: 'write', file: shimFile,  new: shimContent },
    ],
    meta: {
      model: MODEL,
      duration_ms: Date.now() - start,
      tokens: usage,
      variantKey,
    },
  };
}
