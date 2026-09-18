/**
 * Pass: contact — practice identity, address, phone/fax/email, hours, navigation.
 *
 * Captures verbatim from contact/about/location pages, footer text on the
 * homepage, JSON-LD across all pages, and the new bronze contactLinks
 * (mailtos/tels/emails/phones extracted by the scraper).
 */

import { loadPrompt, fillTemplate, runPassCall, renderPagesAsContext, pagesMatching, MODELS } from '../shared.js';

export const name = 'contact';

const PHONE_RE = /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

/**
 * Deterministically scan all page bodies for clearly-labeled contact data that
 * the LLM tends to overlook: "Fax:", office-hours blocks, patient-portal links.
 * These become strong labeled hints in the prompt (and high-confidence fallbacks
 * the orchestrator can trust).
 */
function detectLabeledContact(bronze) {
  let fax = null, hoursRaw = null, portal = null;
  const faxRe = new RegExp(`(?:fax|facsimile)\\s*[:#]?\\s*(${PHONE_RE.source})`, 'i');
  // Hours: capture text after an "Office Hours"/"Hours" label up to the next section
  const hoursRe = /(?:office\s+hours|hours\s+of\s+operation|our\s+hours|business\s+hours|hours)\s*[:\-]?\s*((?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)[^]{0,160}?(?:am|pm|closed|appointment)[^]{0,120}?)(?:\s{2,}|share|patient|testimonial|contact|©|\bphone\b|\bfax\b|$)/i;
  // Patient PORTAL = login/account access (not bill-pay). OrthoBanc is a portal.
  const portalRe = /(https?:\/\/[^\s"'<>]*(?:patientconnect|rwlogin|patientportal|mychart|patient-login|orthobanc|\/portal)[^\s"'<>]*)/i;

  for (const p of bronze.pages || []) {
    const body = p.bodyText || '';
    if (!fax) {
      const m = body.match(faxRe);
      if (m) fax = m[1].trim();
    }
    if (!hoursRaw) {
      const m = body.match(hoursRe);
      if (m) hoursRaw = m[1].replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    if (!portal) {
      const m = body.match(portalRe);
      if (m) portal = m[1];
      // also scan links
      for (const l of [...(p.internalLinks || []), ...(p.externalLinks || [])]) {
        if (!portal && portalRe.test(l.href || '')) portal = (l.href || '').match(portalRe)[1];
      }
    }
  }
  // Distinguish fax from phone: if fax equals the practice phone digits, drop it
  return { fax, hoursRaw, portal };
}

/** Classify a Google URL as 'review' | 'map' | 'profile' | null. */
function classifyGoogleUrl(h) {
  if (!h) return null;
  const u = h.toLowerCase();
  // Review: explicit writereview, /review, g.page/r/ (the "leave a review" short form)
  if (/writereview|\/review(\b|\?|$)|g\.page\/r\//.test(u)) return 'review';
  // Map/place links
  if (/(goo\.gl\/maps|maps\.app\.goo\.gl|google\.[a-z.]+\/maps|\/maps\/place|maps\.google)/.test(u)) return 'map';
  // g.page without /r/ or /review → business profile
  if (/g\.page\//.test(u)) return 'profile';
  return null;
}

/** Pull geo coords + Google Maps + Google review/profile URLs from JSON-LD and links. */
function detectGeoAndMap(bronze) {
  let lat = null, lng = null, mapUrl = null, reviewUrl = null, profileUrl = null;
  for (const p of bronze.pages || []) {
    for (const item of (p.structuredData || [])) {
      const geo = item.geo || item.address?.geo;
      if (geo && (geo.latitude != null) && lat == null) {
        lat = geo.latitude; lng = geo.longitude;
      }
      if (!mapUrl && item.hasMap && typeof item.hasMap === 'string' && classifyGoogleUrl(item.hasMap) !== 'review') {
        mapUrl = item.hasMap;
      }
    }
    for (const l of [...(p.internalLinks || []), ...(p.externalLinks || [])]) {
      const h = l.href || '';
      const kind = classifyGoogleUrl(h);
      if (kind === 'review' && !reviewUrl) reviewUrl = h;
      else if (kind === 'map' && !mapUrl) mapUrl = h;
      else if (kind === 'profile' && !profileUrl) profileUrl = h;
    }
  }
  return { lat, lng, mapUrl, reviewUrl, profileUrl };
}

const PATTERNS = [
  /^\/$/, /\/index/, /\/home/,
  /\/about/, /\/our[-_]?(office|practice)/,
  /\/contact/, /\/location/, /\/direction/, /\/find[-_]us/,
  /\/hours/, /\/appointment/, /\/schedule/,
];

export function selectPages(bronze) {
  const matched = pagesMatching(bronze.pages, PATTERNS);
  // Always include the homepage even if pattern didn't match
  const home = bronze.pages.find(p => p.path === '/' || p.path === '');
  const set = new Set(matched);
  if (home) set.add(home);
  return Array.from(set);
}

export async function run({ bronze, pages }) {
  if (pages.length === 0) return {};

  // Aggregate sitewide contact links so the model sees ALL emails/phones across pages
  const siteContact = {
    mailtos: new Set(), tels: new Set(), emails: new Set(), phones: new Set(),
  };
  for (const p of bronze.pages) {
    const cl = p.contactLinks || {};
    (cl.mailtos || []).forEach(v => siteContact.mailtos.add(v));
    (cl.tels    || []).forEach(v => siteContact.tels.add(v));
    (cl.emails  || []).forEach(v => siteContact.emails.add(v));
    (cl.phones  || []).forEach(v => siteContact.phones.add(v));
  }

  // Aggregate JSON-LD across all pages (deduplicated by @type+name)
  const seenLd = new Set();
  const jsonLd = [];
  for (const p of bronze.pages) {
    for (const item of (p.structuredData || [])) {
      const key = `${item['@type']}|${item.name || item.legalName || ''}|${item.url || ''}`;
      if (seenLd.has(key)) continue;
      seenLd.add(key);
      jsonLd.push(item);
    }
  }

  // Footer text — last 1500 chars of homepage bodyText (heuristic but usually right)
  const home = bronze.pages.find(p => p.path === '/' || p.path === '');
  const footerText = home?.bodyText?.slice(-1500) || '';

  // Deterministic labeled-contact detection (fax/hours/portal) + geo/map
  const detected = detectLabeledContact(bronze);
  const geo = detectGeoAndMap(bronze);

  const tmpl = await loadPrompt('contact');
  const prompt = fillTemplate(tmpl, {
    baseUrl: bronze.baseUrl,
    pageContext: renderPagesAsContext(pages, { bodyChars: 6000, paragraphs: 30 }),
    siteContactJson: JSON.stringify({
      mailtos: [...siteContact.mailtos],
      tels:    [...siteContact.tels],
      emails:  [...siteContact.emails],
      phones:  [...siteContact.phones],
    }, null, 2),
    detectedJson: JSON.stringify(detected, null, 2),
    jsonLdJson: JSON.stringify(jsonLd.slice(0, 12), null, 2),
    footerText,
    siteNav: JSON.stringify(bronze.siteAssets?.navigation || [], null, 2),
    socialLinks: JSON.stringify(bronze.siteAssets?.socialLinks || [], null, 2),
  });

  const { slice } = await runPassCall({ name, model: MODELS.default, prompt, maxTokens: 6000 });

  // Deterministic fallbacks: if the model missed fax/hours/portal but our regex
  // found them, trust the regex. Guard fax≠phone.
  slice.practice = slice.practice || {};
  const phoneDigits = (slice.practice.phone || '').replace(/\D/g, '');
  if (!slice.practice.fax && detected.fax) {
    const faxDigits = detected.fax.replace(/\D/g, '');
    if (faxDigits !== phoneDigits) slice.practice.fax = detected.fax;
  }
  if (!slice.practice.patientPortalUrl && detected.portal) {
    slice.practice.patientPortalUrl = detected.portal;
  }
  if (detected.hoursRaw) {
    slice.hours = slice.hours || {};
    if (!slice.hours.raw) slice.hours.raw = detected.hoursRaw;
  }

  // Sanity-check hours — correct obvious am/pm CMS typos; only drop if unrecoverable
  if (slice.hours) {
    const { sanitizeHours } = await import('../hours-sanity.js');
    const { corrected, rejected } = sanitizeHours(slice.hours);
    if (corrected.length) {
      console.warn(`[ai-silver:contact] corrected ${corrected.length} hour row(s): ${corrected.map(r => `${r.day}:${r.from}→${r.to}`).join(', ')}`);
    }
    if (rejected.length) {
      console.warn(`[ai-silver:contact] rejected ${rejected.length} implausible hour row(s): ${rejected.map(r => `${r.day}:${r.time}(${r.reason})`).join(', ')}`);
    }
  }

  // Geo + map URL fallbacks
  slice.address = slice.address || {};
  if (geo.lat != null && slice.address.lat == null) { slice.address.lat = geo.lat; slice.address.lng = geo.lng; }
  if (geo.mapUrl && !slice.address.mapUrl) slice.address.mapUrl = geo.mapUrl;
  // Google review/profile link fallbacks (deterministic classification beats the LLM here).
  // PREFER the practice's canonical g.page/...review share link over a generic
  // writereview?placeid= form when both exist — it's the link the practice actually shares.
  if (geo.reviewUrl) {
    const cur = slice.practice.googleReviewLink || '';
    const detIsCanonical = /g\.page\//i.test(geo.reviewUrl);
    const curIsGeneric = /writereview|search\.google/i.test(cur);
    if (!cur || (detIsCanonical && curIsGeneric)) slice.practice.googleReviewLink = geo.reviewUrl;
  }
  if (geo.profileUrl && !slice.practice.googleProfileLink) slice.practice.googleProfileLink = geo.profileUrl;
  // Also surface ALL distinct google review/profile/map URLs in sameAs[] so that
  // sites exposing multiple variants (g.page/review + writereview form) are fully captured.
  slice.practice.sameAs = Array.isArray(slice.practice.sameAs) ? slice.practice.sameAs : [];
  for (const u of [geo.reviewUrl, geo.profileUrl, geo.mapUrl,
                   slice.practice.googleReviewLink, slice.practice.googleProfileLink].filter(Boolean)) {
    if (!slice.practice.sameAs.includes(u)) slice.practice.sameAs.push(u);
  }
  // Collect every google review/writereview link found across the crawl into sameAs
  for (const p of bronze.pages || []) {
    for (const l of [...(p.internalLinks || []), ...(p.externalLinks || [])]) {
      const h = l.href || '';
      if (/writereview|g\.page\//i.test(h) && !slice.practice.sameAs.includes(h)) slice.practice.sameAs.push(h);
    }
  }
  // Never let a review link leak into mapUrl
  if (slice.address.mapUrl && /writereview|\/review(\b|\?|$)|g\.page\/r\//i.test(slice.address.mapUrl)) {
    slice.address.mapUrl = geo.mapUrl && !/writereview|\/review|g\.page\/r\//i.test(geo.mapUrl) ? geo.mapUrl : null;
  }
  return slice;
}
