/**
 * Merge synthesize (silver) + intake into a single PracticeData object.
 *
 * MENTAL MODEL — two sources, resolved by authority:
 *   • Silver  = observed truth (what the old site said).  The ONLY content source.
 *   • Intake  = declared truth (what the client says is correct NOW).  A thin
 *               "fact correction" layer over a fixed allowlist — NOT a content channel.
 *
 * Mechanism:
 *   1. Clone silver wholesale  → 100% lossless + schema-flexible by construction.
 *      (Any field synthesize adds flows through untouched; merge-eval enforces 100%.)
 *   2. Override ONLY the correction-critical facts in INTAKE_OVERRIDE_PATHS, when
 *      the client provided them. Intake cannot touch anything else.
 *   3. Apply structural normalization + derived fields the downstream shape expects.
 *
 * Because intake writes into the SAME canonical paths silver uses (intake.js
 * normalizes the client's raw form → practice.phone, address.street, …), the
 * result is a clean per-key override — never two similarly-named keys.
 */

import { DEFAULT_HOURS, DEFAULT_COLORS } from './schema.js';
import { slugify } from './utils.js';

// ---------------------------------------------------------------------------
// Intake allowlist — Step 3's entire surface area.
// The client can correct ONLY these facts (the ones that go stale on an old
// site and are costly to get wrong). Everything else always comes from silver.
// To let intake control another field later, add its canonical path here.
// ---------------------------------------------------------------------------
export const INTAKE_OVERRIDE_PATHS = [
  'practice.name',
  'practice.phone',
  'practice.email',
  'practice.domain',   // website
  'practice.bookingUrl', // the practice's own booking software — what they
                         // tell us always beats a link the scraper guessed at
  'address.street',
  'address.city',
  'address.state',
  'address.zip',
  'hours',             // full hours object (Tue–Fri 8–5, etc.)
];

const _isEmpty = (v) =>
  v === null || v === undefined || v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object} scrapeData - Silver (synthesize output). The content source.
 * @param {object} intakeData - Normalised intake (from loadIntake). Correction layer.
 * @param {object} [preset]   - Loaded vertical preset (for redirect rules).
 * @returns {object} Complete PracticeData
 */
export function mergeData(scrapeData, intakeData, preset = null) {
  scrapeData = scrapeData || {};
  intakeData = intakeData || {};
  const flags = [];

  // 1) Lossless base — everything silver produced flows through untouched.
  const data = structuredClone(scrapeData);

  // 2) Intake overrides — correction-critical facts ONLY.
  for (const path of INTAKE_OVERRIDE_PATHS) {
    const val = getPath(intakeData, path);
    if (!_isEmpty(val)) {
      setPath(data, path, val);
      flags.push(`intake override: ${path}`);
    }
  }

  // Greenfield / coming-soon sites have almost no silver. Intake is then the
  // only source for doctor, services, and concept copy — fill those gaps
  // without overwriting anything silver already observed.
  seedFromIntakeWhenEmpty(data, intakeData, flags);

  // 3) Structural normalization — the canonical shape downstream consumes.

  // doctors[] is the source of truth; mirror to legacy doctor + additionalDoctors,
  // deriving the legacy `education` string from educationList[] when present.
  const withEdu = (d) => {
    if (!d) return d;
    const education = d.education
      || (Array.isArray(d.educationList) && d.educationList.length ? d.educationList.join('; ') : null);
    return { ...d, education };
  };
  let doctors = Array.isArray(data.doctors) ? data.doctors : [];
  if (doctors.length === 0) {
    doctors = [
      ...(data.doctor && data.doctor.name ? [data.doctor] : []),
      ...((data.additionalDoctors || []).filter(d => d && d.name)),
    ];
  }
  doctors = doctors.map(withEdu);
  data.doctors = doctors;
  if (doctors.length > 0) {
    data.doctor = doctors[0];
    data.additionalDoctors = doctors.slice(1);
  } else {
    data.additionalDoctors = data.additionalDoctors || [];
  }

  // services: normalize shape + dedup by slug. Hubs disabled — mirror source structure.
  const offered = (data.services?.offered || []).map(s => ({
    ...(typeof s === 'object' && s ? s : {}),
    name: typeof s === 'string' ? s : s.name,
    slug: typeof s === 'string' ? slugify(s) : (s.slug || slugify(s.name)),
    source: (typeof s === 'object' && s && s.source) || 'scrape',
    confidence: (typeof s === 'object' && s && s.confidence != null) ? s.confidence : 0.7,
  })).filter(s => s.name);
  data.services = { offered: deduplicateServices(offered), hubs: [] };

  data.staff = Array.isArray(data.staff) ? data.staff : [];
  data.navigation = Array.isArray(data.navigation) ? data.navigation : [];

  // 4) Sensible defaults where silver was silent (downstream back-compat).
  if (_isEmpty(data.hours)) { data.hours = { ...DEFAULT_HOURS }; flags.push('hours: using defaults'); }
  data.brand = data.brand || {};
  if (_isEmpty(data.brand.colors)) { data.brand.colors = { ...DEFAULT_COLORS }; flags.push('brand.colors: using defaults'); }
  if (_isEmpty(data.brand.fonts)) data.brand.fonts = { heading: 'Playfair Display', body: 'DM Sans' };
  if (data.doctor && !data.doctor.credentials) data.doctor.credentials = 'DDS';
  if (!data.practice?.name) flags.push('practice.name: missing');
  if (!data.practice?.phone) flags.push('practice.phone: missing');

  // 5) Derived fields.
  data.practice = data.practice || {};
  data.practice.phoneDigits = data.practice.phone ? String(data.practice.phone).replace(/\D/g, '') : null;
  data.practice.priceRange = data.practice.priceRange || '$$';
  const a = (data.address = data.address || {});
  a.country = a.country || 'US';
  a.full = [a.street, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;

  // Migration redirect map (from silver's crawled URLs).
  const oldUrls = data.migration?.oldUrls || [];
  data.migration = {
    oldUrls,
    redirectMap: generateRedirectMap(oldUrls, [], preset?.redirectRules || []),
  };

  // Meta.
  data.meta = data.meta || {};
  data.meta.intakeSource = intakeData.meta?.intakeSource || data.meta.intakeSource || null;
  data.meta.confidenceFlags = flags;

  return data;
}

/**
 * When silver left a field empty, copy the matching intake value.
 * Never overwrites observed silver. Used for domain-only / coming-soon sites.
 */
function seedFromIntakeWhenEmpty(data, intakeData, flags) {
  const intakeDoctor = intakeData.doctor;
  const hasDoctor = (data.doctors && data.doctors.length > 0)
    || data.doctor?.name
    || data.doctor?.lastName;
  if (!hasDoctor && intakeDoctor && (intakeDoctor.lastName || intakeDoctor.firstName || intakeDoctor.name)) {
    const firstName = intakeDoctor.firstName || null;
    const lastName = intakeDoctor.lastName || null;
    const name = intakeDoctor.name
      || [firstName, lastName].filter(Boolean).join(' ')
      || null;
    data.doctor = {
      ...(data.doctor || {}),
      name,
      firstName,
      lastName,
      credentials: intakeDoctor.credentials || data.doctor?.credentials || null,
      bio: intakeDoctor.bio || null,
      education: intakeDoctor.education || null,
    };
    data.doctors = [data.doctor];
    flags.push('intake seed: doctor (silver empty)');
  }

  const silverServices = data.services?.offered || [];
  const intakeServices = intakeData.services?.offered || [];
  if (intakeServices.length > 0) {
    const bySlug = new Map();
    for (const s of silverServices) {
      const slug = s.slug || slugify(s.name);
      if (slug) bySlug.set(slug, s);
    }
    let added = 0;
    for (const s of intakeServices) {
      const slug = s.slug || slugify(s.name);
      if (!slug) continue;
      if (!bySlug.has(slug)) {
        bySlug.set(slug, s);
        added++;
      }
    }
    if (added > 0 || silverServices.length === 0) {
      data.services = { offered: [...bySlug.values()], hubs: data.services?.hubs || [] };
      flags.push(`intake seed: ${added} services merged (${bySlug.size} total)`);
    }
  }

  data.content = data.content || {};
  const ic = intakeData.content || {};
  if (_isEmpty(data.content.faqs) && !_isEmpty(ic.faqs)) {
    data.content.faqs = ic.faqs;
    flags.push('intake seed: faqs');
  }
  if (_isEmpty(data.content.insurance) && !_isEmpty(ic.insurance)) {
    data.content.insurance = ic.insurance;
    flags.push('intake seed: insurance');
  }
  if (_isEmpty(data.content.testimonials) && !_isEmpty(ic.testimonials)) {
    data.content.testimonials = ic.testimonials;
    flags.push('intake seed: testimonials');
  }
  if (_isEmpty(data.content.philosophy) && ic.philosophy) {
    data.content.philosophy = ic.philosophy;
    flags.push('intake seed: philosophy');
  }
  if (_isEmpty(data.practice?.description) && ic.practiceDescription) {
    data.practice = data.practice || {};
    data.practice.description = ic.practiceDescription;
    flags.push('intake seed: practice.description');
  }
  if (_isEmpty(data.practice?.tagline) && ic.tagline) {
    data.practice = data.practice || {};
    data.practice.tagline = ic.tagline;
    flags.push('intake seed: tagline');
  }
  if (_isEmpty(data.content.additionalContent) && !_isEmpty(ic.additionalContent)) {
    data.content.additionalContent = ic.additionalContent;
    flags.push('intake seed: additionalContent');
  }
  if (_isEmpty(data.differentiators) && !_isEmpty(intakeData.differentiators)) {
    data.differentiators = intakeData.differentiators;
    flags.push('intake seed: differentiators');
  }
  if (_isEmpty(data.content.financing) && !_isEmpty(ic.financing)) {
    data.content.financing = ic.financing;
    flags.push('intake seed: financing');
  }
  // sameAs is a union rather than a fill-when-empty: the scraper finds the
  // Google profile, the practice tells us Facebook and Instagram, and the
  // schema wants all of them.
  const intakeSameAs = intakeData.practice?.sameAs || [];
  if (!_isEmpty(intakeSameAs)) {
    data.practice = data.practice || {};
    const existing = Array.isArray(data.practice.sameAs) ? data.practice.sameAs : [];
    const merged = [...new Set([...existing, ...intakeSameAs])];
    if (merged.length > existing.length) {
      data.practice.sameAs = merged;
      flags.push(`intake seed: ${merged.length - existing.length} sameAs URL(s)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Service hub detection
// ---------------------------------------------------------------------------

/**
 * Determine which service hub pages to keep based on detected services.
 * @param {Array} services       - Array of service objects with { slug, category }.
 * @param {Array} hubDefinitions - Hub definitions from preset.
 * @param {Array} taxonomyServices - Full service taxonomy from preset.
 * @returns {Array} Array of hub objects { slug, label, desc }.
 */
export function determineServiceHubs(services, hubDefinitions = [], taxonomyServices = []) {
  const activeHubs = [];

  for (const hub of hubDefinitions) {
    if (hub.alwaysKeep) {
      const hasExact = services.some(s => s.slug === hub.slug ||
        s.name.toLowerCase() === hub.label.toLowerCase());
      if (!hasExact) continue;
      activeHubs.push({ slug: hub.slug, label: hub.label, desc: hub.desc });
      continue;
    }

    const hasExplicitMatch = services.some(svc => {
      if (svc.slug === hub.slug) return true;
      if (hub.matchSlugs?.includes(svc.slug)) return true;
      const hubWords = hub.label.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const svcName  = svc.name.toLowerCase();
      const matchCount = hubWords.filter(w => svcName.includes(w)).length;
      if (matchCount >= 2) return true;
      return false;
    });

    if (hasExplicitMatch) {
      activeHubs.push({ slug: hub.slug, label: hub.label, desc: hub.desc });
    }
  }

  return activeHubs;
}

// ---------------------------------------------------------------------------
// Redirect map generation
// ---------------------------------------------------------------------------

/**
 * Generate a redirect map from old URL paths to new page paths.
 * @param {string[]} oldUrls       - Array of old URL paths.
 * @param {Array}    serviceHubs    - Active hub objects from determineServiceHubs.
 * @param {Array}    redirectRules  - Redirect rules from preset.
 * @returns {Array} Array of { from, to } redirect entries.
 */
export function generateRedirectMap(oldUrls, serviceHubs, redirectRules = []) {
  if (!oldUrls || oldUrls.length === 0) return [];

  const activeHubSlugs = new Set((serviceHubs || []).map(h => h.slug));
  const redirects = [];
  const seen = new Set();

  for (const rawUrl of oldUrls) {
    let path;
    try {
      const parsed = new URL(rawUrl, 'https://placeholder.local');
      path = parsed.pathname;
    } catch {
      path = rawUrl;
    }

    path = path.replace(/\/+$/, '') || '/';
    if (path === '/' || seen.has(path)) continue;
    seen.add(path);

    let target = null;
    for (const rule of redirectRules) {
      if (rule.pattern.test(path)) {
        target = rule.target;
        if (target.startsWith('/services/')) {
          const hubSlug = target.replace('/services/', '');
          if (!activeHubSlugs.has(hubSlug)) target = '/services';
        }
        break;
      }
    }
    if (!target) target = '/';
    if (path !== target) redirects.push({ from: path, to: target });
  }

  return redirects;
}

// ---------------------------------------------------------------------------
// Service deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate services by slug. When duplicates exist, keep the entry with the
 * highest confidence. If confidence is equal, prefer 'intake' source.
 * @param {Array} services - Array of service objects.
 * @returns {Array} Deduplicated array sorted alphabetically by name.
 */
export function deduplicateServices(services) {
  const bySlug = new Map();

  for (const svc of services) {
    const slug = svc.slug || slugify(svc.name);
    const existing = bySlug.get(slug);

    if (!existing) {
      bySlug.set(slug, { ...svc, slug });
      continue;
    }

    const newConf = svc.confidence ?? 0;
    const oldConf = existing.confidence ?? 0;
    if (newConf > oldConf || (newConf === oldConf && svc.source === 'intake')) {
      bySlug.set(slug, { ...svc, slug });
    }
  }

  return [...bySlug.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  );
}
