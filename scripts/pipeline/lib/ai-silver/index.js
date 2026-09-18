/**
 * Multi-Pass Silver Extraction
 *
 * Orchestrates 9 focused extraction passes in parallel, each producing a
 * slice of the silver schema. Failures in any single pass are isolated —
 * other passes still merge their results.
 *
 * Public API (back-compat with the previous monolithic ai-silver.js):
 *   extractSilver(bronze) -> Promise<silver>   // canonical merged schema
 *
 * Each pass module exports:
 *   - name             (string)
 *   - selectPages(bronze) -> BronzePage[]      (subset to send the model)
 *   - run({ bronze, pages }) -> Promise<slice> (returns its schema slice)
 *
 * The orchestrator runs every pass that has selectable input, then deep-merges
 * the slices into the canonical practice-data shape and applies back-compat
 * mirrors (doctors[0] → doctor, etc).
 */

import * as contact      from './passes/contact.js';
import * as providers    from './passes/providers.js';
import * as services     from './passes/services.js';
import * as testimonials from './passes/testimonials.js';
import * as faqs         from './passes/faqs.js';
import * as insurance    from './passes/insurance.js';
import * as brand        from './passes/brand.js';
import * as images       from './passes/images.js';
import * as content      from './passes/content.js';
import * as design        from './passes/design.js';
import { resolveAffiliations, cleanBadgeBucket } from './affiliations.js';
import { formatNarrative } from './shared.js';
import { sanitizeHours } from './hours-sanity.js';
import { filterDoctors } from './provider-filter.js';
import { repairFaqs } from './faq-repair.js';
import { isBlogPath } from '../crawl-select.js';

const PASSES = [
  contact,
  providers,
  services,
  testimonials,
  faqs,
  insurance,
  brand,
  images,
  content,
  design,
];

// ---------------------------------------------------------------------------
// Slug helper (mirrors utils.js)
// ---------------------------------------------------------------------------

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Canonical silver builder — merges per-pass slices into the merger-expected
// shape, applies back-compat mirrors, fills sensible defaults where needed.
// ---------------------------------------------------------------------------

function emptySilver(bronze) {
  const bronzeBaseUrl = bronze?.baseUrl || '';
  let domain = null;
  try { domain = new URL(bronzeBaseUrl).hostname; } catch {}
  return {
    practice: {
      name: null, alternateName: null, legalName: null, description: null, schemaType: null,
      domain, phone: null, fax: null, email: null,
      googleReviewLink: null, googleProfileLink: null, patientPortalUrl: null, bookingUrl: null, priceRange: '$$',
      medicalSpecialty: null, schemaType: null, alternateName: null, description: null,
      mission: null, tagline: null, sameAs: [],
    },
    doctors: [],
    doctor: { name: null, firstName: null, lastName: null, credentials: null,
      bio: null, education: null, specialties: [], photoPath: null,
      statusNote: null, boardCertified: null, sourcePath: null, photoAlt: null,
      educationList: [], certifications: [], organizations: [], languages: [],
    },
    additionalDoctors: [],
    staff: [],
    navigation: [],
    address: { street: null, city: null, state: null, zip: null, country: 'US', full: null, mapUrl: null, lat: null, lng: null },
    hours: null,
    services: { offered: [] },
    brand: { colors: null, fonts: null, logoPath: null, tagline: null, affiliations: [] },
    currentDesign: null,
    content: {
      heroTagline: null, heroHeadline: null, heroSubheadline: null,
      ctaText: null, ctaSecondaryText: null, valueProp: null,
      aboutText: null, aboutHeadline: null, philosophy: null, closingCTA: null,
      testimonials: [], faqs: [], generatedFAQs: [],
      stats: { yearsExperience: null, happyPatients: null, googleRating: null, fiveStarReviews: null },
      aggregateRating: null,
      insurance: [], financingOptions: [], paymentMethods: [],
      patientForms: [], areasServed: [],
      sectionTitles: [], taglines: [],
      additionalContent: [],
      generated: null,
    },
    images: { items: [], logo: null, logoFooter: null, hero: [], team: [], headshots: [], office: [], gallery: [], beforeAfter: [], treatments: [], badges: [] },
    pages: [],
    migration: { oldUrls: [], redirectMap: [] },
    meta: { oldSiteUrl: bronzeBaseUrl, scrapedAt: new Date().toISOString(), intakeSource: 'ai-silver', clientId: null, confidenceFlags: [], passMetrics: {} },
    pageInventory: null,
  };
}

function mergeSlice(silver, slice) {
  if (!slice || typeof slice !== 'object') return;
  // Practice (scalar overrides)
  if (slice.practice) {
    for (const [k, v] of Object.entries(slice.practice)) {
      if (v !== undefined && v !== null && v !== '' && silver.practice[k] == null) silver.practice[k] = v;
      else if (k === 'sameAs' && Array.isArray(v)) {
        silver.practice.sameAs = [...new Set([...silver.practice.sameAs, ...v])];
      }
    }
  }
  // Address
  if (slice.address) {
    for (const [k, v] of Object.entries(slice.address)) {
      if (v !== undefined && v !== null && v !== '' && silver.address[k] == null) silver.address[k] = v;
    }
  }
  // Hours (whole-object replace if pass provided a structured hours)
  if (slice.hours && (slice.hours.byDay || slice.hours.display || slice.hours.raw)) {
    silver.hours = { ...silver.hours, ...slice.hours };
  }
  // Doctors / Staff (arrays — replace if non-empty)
  if (Array.isArray(slice.doctors) && slice.doctors.length) silver.doctors = slice.doctors;
  if (Array.isArray(slice.staff)   && slice.staff.length)   silver.staff   = slice.staff;
  // Services
  if (slice.services?.offered?.length) silver.services.offered = slice.services.offered;
  // Navigation
  if (Array.isArray(slice.navigation) && slice.navigation.length) silver.navigation = slice.navigation;
  // Brand
  if (slice.brand) {
    if (slice.brand.colors) silver.brand.colors = { ...(silver.brand.colors || {}), ...slice.brand.colors };
    if (slice.brand.fonts)  silver.brand.fonts  = { ...(silver.brand.fonts  || {}), ...slice.brand.fonts  };
    if (slice.brand.logoPath) silver.brand.logoPath = slice.brand.logoPath;
    if (slice.brand.tagline)  silver.brand.tagline  = slice.brand.tagline;
    if (Array.isArray(slice.brand.affiliations) && slice.brand.affiliations.length) silver.brand.affiliations = slice.brand.affiliations;
  }
  // Content
  if (slice.content) {
    for (const k of ['heroTagline','heroHeadline','heroSubheadline','ctaText','ctaSecondaryText','valueProp','aboutText','aboutHeadline','philosophy','closingCTA']) {
      if (slice.content[k] && !silver.content[k]) silver.content[k] = slice.content[k];
    }
    for (const k of ['testimonials','faqs','insurance','financingOptions','paymentMethods','patientForms','areasServed','sectionTitles','taglines','additionalContent']) {
      if (Array.isArray(slice.content[k]) && slice.content[k].length) silver.content[k] = slice.content[k];
    }
    if (slice.content.stats) silver.content.stats = { ...silver.content.stats, ...slice.content.stats };
    if (slice.content.aggregateRating && !silver.content.aggregateRating) {
      silver.content.aggregateRating = slice.content.aggregateRating;
    }
  }
  // Images (per-bucket array replace if non-empty)
  if (slice.images) {
    for (const k of ['logo','logoFooter']) {
      if (slice.images[k] && !silver.images[k]) silver.images[k] = slice.images[k];
    }
    if (Array.isArray(slice.images.items) && slice.images.items.length) silver.images.items = slice.images.items;
    for (const k of ['hero','team','headshots','office','gallery','beforeAfter','treatments','badges']) {
      if (Array.isArray(slice.images[k]) && slice.images[k].length) silver.images[k] = slice.images[k];
    }
  }
  // Pages
  if (Array.isArray(slice.pages) && slice.pages.length) silver.pages = slice.pages;
  // Current design profile (observation)
  if (slice.currentDesign) silver.currentDesign = slice.currentDesign;
}

function applyBackCompat(silver) {
  // doctor / additionalDoctors mirror doctors[]
  const doctors = silver.doctors || [];
  if (doctors.length > 0) {
    const d = doctors[0];
    silver.doctor = {
      name: d.name || null,
      firstName: d.firstName || null,
      lastName: d.lastName || null,
      credentials: d.credentials || null,
      bio: d.bio || null,
      education: Array.isArray(d.educationList) && d.educationList.length
        ? d.educationList.join('; ')
        : (d.education || null),
      specialties: d.specialties || [],
      photoPath: d.photoPath || d.photoUrl || null,
      photoAlt: d.photoAlt || null,
      sourcePath: d.sourcePath || null,
      statusNote: d.statusNote || null,
      boardCertified: d.boardCertified ?? null,
      educationList: d.educationList || [],
      certifications: d.certifications || [],
      organizations: d.organizations || [],
      languages: d.languages || [],
    };
    silver.additionalDoctors = doctors.slice(1).map(d => ({
      name: d.name || null, firstName: d.firstName || null, lastName: d.lastName || null,
      credentials: d.credentials || null, bio: d.bio || null,
      education: Array.isArray(d.educationList) && d.educationList.length ? d.educationList.join('; ') : (d.education || null),
      specialties: d.specialties || [], photoPath: d.photoPath || d.photoUrl || null,
      statusNote: d.statusNote || null,
    }));
  }

  // services.offered normalization
  silver.services.offered = (silver.services.offered || []).map(s => ({
    name: typeof s === 'string' ? s : (s.name || ''),
    slug: s.slug || slugify(typeof s === 'string' ? s : s.name || ''),
    category: s.category || 'general',
    source: s.source || 'scrape',
    confidence: s.confidence ?? 0.85,
    description: s.description || null,
    details: Array.isArray(s.details) ? s.details : [],
  })).filter(s => s.name);

  // phoneDigits
  if (silver.practice.phone) {
    silver.practice.phoneDigits = silver.practice.phone.replace(/\D/g, '');
  }

  // address.full
  const a = silver.address;
  silver.address.full = [a.street, a.city, [a.state, a.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ') || null;

  // Clean UI-chrome icons out of the badges bucket, then resolve affiliations[]
  // via the deterministic org dictionary (merges with any LLM-named affiliations).
  silver.images.badges = cleanBadgeBucket(silver.images.badges);
  const affs = resolveAffiliations(silver.images.badges, silver.brand.affiliations);
  if (affs.length) silver.brand.affiliations = affs;

  // googleReviewLink integrity: must be a Google domain. Drop mis-assigned
  // facebook/yelp/etc URLs (a recurring extraction error).
  const grl = silver.practice.googleReviewLink;
  if (grl && !/google\.|g\.page|goo\.gl|maps\.app/i.test(grl)) {
    silver.practice.googleReviewLink = null;
  }
  const gpl = silver.practice.googleProfileLink;
  if (gpl && !/google\.|g\.page|goo\.gl|maps\.app/i.test(gpl)) {
    silver.practice.googleProfileLink = null;
  }

  // Hours sanity (defense in depth if contact pass missed it)
  if (silver.hours) {
    sanitizeHours(silver.hours);
  }

  // Provider gate (defense in depth)
  if (silver.doctors?.length) {
    const { doctors, dropped } = filterDoctors(silver.doctors, { softDups: [] });
    // softDups already applied in providers pass; here only re-apply name/bio gates
    if (dropped.length) silver.doctors = doctors;
  }
}

function buildPageInventory(bronze) {
  return (bronze.pages || []).map(p => {
    const narrative = formatNarrative(p, 3500);
    // Prefer narrative-derived excerpts so inventory isn't disconnected lists
    const fromBlocks = [];
    for (const sec of p.sections || []) {
      for (const block of sec.blocks || []) {
        if (block.type === 'paragraph') fromBlocks.push(block.text);
        else if (block.type === 'list') fromBlocks.push(...(block.items || []));
      }
    }
    return {
      url: p.url,
      path: p.path,
      title: p.title,
      metaDesc: p.metaDescription,
      h1: p.headings?.find(h => h.level === 1)?.text
        || p.contentBlocks?.find(b => b.type === 'heading' && b.level === 1)?.text
        || null,
      h2s: (p.headings?.filter(h => h.level === 2).map(h => h.text)
        || p.contentBlocks?.filter(b => b.type === 'heading' && b.level === 2).map(b => b.text)
        || []),
      h3s: (p.headings?.filter(h => h.level === 3).map(h => h.text)
        || p.contentBlocks?.filter(b => b.type === 'heading' && b.level === 3).map(b => b.text)
        || []),
      paragraphs: (fromBlocks.length ? fromBlocks : (p.paragraphs || [])).slice(0, 12),
      narrative,
      wordCount: p.wordCount,
      bodyText: narrative || (p.bodyText || '').slice(0, 4000),
    };
  });
}

function buildPagesList(bronze) {
  return (bronze.pages || []).map(p => ({
    path: p.path,
    title: p.title,
    wordCount: p.wordCount,
    role: null, // filled by downstream if needed
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function extractSilver(bronze) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[ai-silver] ANTHROPIC_API_KEY not set — returning empty silver.');
    return emptySilver(bronze);
  }
  if (!bronze || !Array.isArray(bronze.pages) || bronze.pages.length === 0) {
    console.log('[ai-silver] empty bronze — returning empty silver.');
    return emptySilver(bronze);
  }

  // Blog posts are migration material — ported verbatim by blog-generator, never
  // rewritten. Extracting from them would send an entire archive through the AI
  // passes (content.js takes any page over 400 words, which every post clears)
  // and would bloat pageInventory for every downstream prompt. Hold them back
  // here so `bronze.pages` stays the rebuild reference set.
  const blogPages = bronze.pages.filter(p => isBlogPath(p.path));
  const referenceBronze = blogPages.length
    ? { ...bronze, pages: bronze.pages.filter(p => !isBlogPath(p.path)) }
    : bronze;

  console.log(`[ai-silver] starting multi-pass extraction (${referenceBronze.pages.length} reference pages, ${blogPages.length} blog pages held for verbatim migration, ${PASSES.length} passes)`);
  const startedAt = Date.now();

  // Fire all passes in parallel. Each pass is responsible for selecting its
  // own input pages and returning a slice or {}.
  const passResults = await Promise.all(PASSES.map(async (pass) => {
    const passStarted = Date.now();
    try {
      const pages = pass.selectPages(referenceBronze);
      const slice = await pass.run({ bronze: referenceBronze, pages });
      const ms = Date.now() - passStarted;
      console.log(`[ai-silver:${pass.name}] ok (${pages.length} pages → slice in ${ms}ms)`);
      return { name: pass.name, slice, ms };
    } catch (err) {
      const ms = Date.now() - passStarted;
      console.warn(`[ai-silver:${pass.name}] FAILED (${ms}ms): ${err.message}`);
      return { name: pass.name, slice: {}, error: err.message, ms };
    }
  }));

  // Merge slices into canonical silver
  const silver = emptySilver(bronze);
  for (const r of passResults) mergeSlice(silver, r.slice);
  applyBackCompat(silver);

  // Deterministic backstop for the faqs pass. Runs after the merge so it sees
  // the FAQs that actually landed, not the slice a single pass produced.
  const faqRepair = repairFaqs(silver, referenceBronze.pages);
  if (faqRepair.added) {
    console.log(`[ai-silver:faq-repair] recovered ${faqRepair.added} Q+A the faqs pass dropped: `
      + faqRepair.repaired.map((r) => `${r.path} (+${r.added})`).join(', '));
  }

  // Pass metrics + page inventory + migration urls
  silver.meta.passMetrics = Object.fromEntries(passResults.map(r => [r.name, { ms: r.ms, error: r.error || null }]));
  // The additionalContent ceiling that applied to this run, so headroom can be
  // measured against the real number rather than a constant copied by hand.
  const acCap = passResults.find(r => r.name === 'content')?.slice?.acCap;
  if (acCap) silver.meta.additionalContentCap = acCap;
  silver.meta.totalMs = Date.now() - startedAt;
  // pageInventory feeds Content Map / Content Write prompts, so it stays the
  // reference set too — a full blog archive here would dominate those prompts.
  silver.pageInventory = buildPageInventory(referenceBronze);
  if (!silver.pages.length) silver.pages = buildPagesList(bronze);
  silver.migration.oldUrls = (bronze.siteAssets?.allUrls || []).slice();

  // Logging
  console.log(`[ai-silver] complete in ${silver.meta.totalMs}ms.`);
  console.log(`  Practice:  ${silver.practice.name}  fax=${silver.practice.fax}  email=${silver.practice.email}`);
  console.log(`  Doctors:   ${silver.doctors.length}`);
  console.log(`  Staff:     ${silver.staff.length}`);
  console.log(`  Hours:     ${silver.hours?.raw || silver.hours?.display?.length || 'null'}`);
  console.log(`  Services:  ${silver.services.offered.length}`);
  console.log(`  Test:      ${silver.content.testimonials.length}  FAQs: ${silver.content.faqs.length}`);
  console.log(`  Insurance: ${silver.content.insurance.length}  Financing: ${silver.content.financingOptions.length}`);
  console.log(`  Images:    hero=${silver.images.hero.length} team=${silver.images.team.length} headshots=${silver.images.headshots.length} office=${silver.images.office.length} gallery=${silver.images.gallery.length} beforeAfter=${silver.images.beforeAfter.length}`);
  console.log(`  Brand:     primary=${silver.brand.colors?.primary} font.heading=${silver.brand.fonts?.heading}`);

  return silver;
}
