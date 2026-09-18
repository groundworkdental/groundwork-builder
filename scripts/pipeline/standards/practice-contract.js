/**
 * The practice contract — what Groundwork needs to build and launch a site.
 *
 * ONE declaration of two things:
 *   DATA_FIELDS   what the practice must tell us, and how badly we need it
 *   ACCESS_ITEMS  what accounts and permissions must exist, in which phase,
 *                 and whose account they live in
 *
 * Before this existed the same requirements lived in four places that drifted
 * against each other: prose in docs/onboarding/ONBOARDING.md, an example file
 * in intake-template.json, imperative checks in lib/missing-page.js, and env
 * names in .env.example. The intake form asked for a booking URL that nothing
 * read; the missing-report blamed clients for social profiles they had given
 * us. A contract in one file is how that stops happening.
 *
 * Consumers:
 *   check-readiness.js     gate — can we build this practice yet?
 *   lib/missing-page.js    the post-build "what's still missing" report
 *   render-onboarding.js   renders the human checklist in the docs
 *
 * Adding a requirement means adding it HERE. If a field is not in this file,
 * no part of the pipeline should be asking a client for it.
 */

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * critical   the site cannot launch. A build without these produces
 *            something actively broken — an empty tel: link, a nameless
 *            practice — rather than something merely incomplete.
 * important  ship-blocking for a real client, fine for a cold preview.
 *            This is the line the two build phases fall on.
 * optional   the site is correct without it; it is better with it.
 */
export const SEVERITY = /** @type {const} */ (['critical', 'important', 'optional']);

/**
 * Which phase first needs the item.
 *
 * cold     the automated build, run on Groundwork infrastructure with
 *          Groundwork credentials and no client contact at all
 * deposit  after the $500 deposit — the site moves toward the client's
 *          own infrastructure
 * full     after the $2,000 — ownership transfer, analytics, GBP
 */
export const PHASE = /** @type {const} */ (['cold', 'deposit', 'full']);

// ---------------------------------------------------------------------------
// Data fields
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DataField
 * @property {string}  path      dot-path in merged PracticeData — the thing
 *                               that is actually checked
 * @property {string}  intake    dot-path in the intake form, or '' when the
 *                               field only ever comes from the crawl
 * @property {string}  label     human name, used in reports and the doc
 * @property {string}  category  grouping for the report
 * @property {'critical'|'important'|'optional'} severity
 * @property {string}  hint      what to ask the client for, in their words
 * @property {(v: any, merged: object) => boolean} [satisfied]
 *           overrides plain presence when "present" is not the same as "real"
 */

/** Present, and not an empty string/array/object. */
const isPresent = (v) =>
  v !== null && v !== undefined && v !== '' &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/** @type {DataField[]} */
export const DATA_FIELDS = [
  // ── Business identity ───────────────────────────────────────────────────
  {
    path: 'practice.name', intake: 'practice_info.practice_name',
    label: 'Practice name', category: 'Business Info', severity: 'critical',
    hint: 'Official business name exactly as it should appear on the site and in Google.',
  },
  {
    path: 'practice.phone', intake: 'practice_info.contact_phone',
    label: 'Phone number', category: 'Business Info', severity: 'critical',
    hint: 'The number the front desk actually answers — not a personal cell, not a tracking line.',
  },
  {
    path: 'address.street', intake: 'practice_info.address.street',
    label: 'Street address', category: 'Business Info', severity: 'critical',
    hint: 'Street address including suite number. Must match Google Business Profile exactly.',
  },
  {
    path: 'address.city', intake: 'practice_info.address.city',
    label: 'City', category: 'Business Info', severity: 'critical',
    hint: 'City, matching the Google Business Profile listing.',
  },
  {
    path: 'address.zip', intake: 'practice_info.address.zip',
    label: 'ZIP code', category: 'Business Info', severity: 'critical',
    hint: 'Postal code, matching the Google Business Profile listing.',
  },
  {
    path: 'address.state', intake: 'practice_info.address.state',
    label: 'State', category: 'Business Info', severity: 'important',
    hint: 'Two-letter state code.',
  },
  {
    path: 'practice.email', intake: 'practice_info.contact_email',
    label: 'Practice email', category: 'Business Info', severity: 'important',
    hint: 'Monitored inbox for web enquiries. Form submissions and the mailto: link both go here.',
  },
  {
    path: 'hours', intake: 'practice_info.hours',
    label: 'Office hours', category: 'Business Info', severity: 'important',
    hint: 'Real opening hours per day, including any half-days and lunch closures.',
    // The merger fills DEFAULT_HOURS silently, so presence proves nothing —
    // a site showing a confident, wrong "9am – 5pm" is worse than one showing
    // nothing, because no one thinks to check it.
    satisfied: (_v, merged) => {
      const display = merged?.hours?.display;
      if (!Array.isArray(display) || display.length === 0) return false;
      return display.some(h => h?.time && h.time !== '9am – 5pm');
    },
  },
  {
    path: 'practice.domain', intake: 'practice_info.domain',
    label: 'Domain name', category: 'Business Info', severity: 'important',
    hint: 'The production domain. Confirm who the registrar is and who can log in.',
  },

  // ── The people ──────────────────────────────────────────────────────────
  {
    path: 'doctor.name', intake: 'doctor_team.primary_doctor.last_name',
    label: 'Doctor name', category: 'Doctor Info', severity: 'critical',
    hint: 'Full name as patients know it, plus credentials (e.g. Dr. Jane Smith, DDS).',
    satisfied: (_v, merged) =>
      isPresent(merged?.doctor?.name) || isPresent(merged?.doctor?.lastName) ||
      (Array.isArray(merged?.doctors) && merged.doctors.length > 0),
  },
  {
    path: 'doctor.bio', intake: 'doctor_team.primary_doctor.bio',
    label: 'Doctor bio', category: 'Doctor Info', severity: 'important',
    hint: '2–4 paragraphs: training, experience, philosophy, and something human. Goes on About.',
  },
  {
    path: 'doctor.credentials', intake: 'doctor_team.primary_doctor.credentials',
    label: 'Doctor credentials', category: 'Doctor Info', severity: 'important',
    hint: 'Degree and any specialties (DDS, DMD, FAGD). Defaults to DDS if unset — confirm it.',
  },
  {
    path: 'doctor.education', intake: 'doctor_team.primary_doctor.education',
    label: 'Doctor education', category: 'Doctor Info', severity: 'important',
    hint: 'Dental school, residency, notable continuing education.',
  },

  // ── Photography ─────────────────────────────────────────────────────────
  {
    path: 'images.logo', intake: 'branding.logo',
    label: 'Practice logo', category: 'Photos', severity: 'critical',
    hint: 'PNG or SVG, transparent background, highest resolution they have.',
  },
  {
    path: 'images.team', intake: '',
    label: 'Doctor / team photos', category: 'Photos', severity: 'critical',
    hint: 'Headshots of the doctor and key staff. Consistent crop across the set.',
  },
  {
    path: 'images.office', intake: '',
    label: 'Office / interior photos', category: 'Photos', severity: 'important',
    hint: 'Reception, treatment rooms, waiting area. Real photos — no stock.',
  },
  {
    path: 'images.gallery', intake: '',
    label: 'Before & after gallery', category: 'Photos', severity: 'optional',
    hint: 'Treatment results. Each image needs documented provenance and consent.',
  },

  // ── Services and content ────────────────────────────────────────────────
  {
    path: 'services.offered', intake: 'services.list',
    label: 'Services offered', category: 'Services', severity: 'critical',
    hint: 'What they do — and, just as important, what they explicitly do NOT do.',
    satisfied: (_v, merged) => (merged?.services?.offered || []).length > 0,
  },
  {
    path: 'practice.bookingUrl', intake: 'content.scheduling_url',
    label: 'Booking URL', category: 'Conversion', severity: 'important',
    hint: 'Their scheduling software link (Dentrix, Zocdoc, NexHealth). Drives the primary CTA.',
  },
  {
    path: 'practice.googleReviewLink', intake: '',
    label: 'Google review link', category: 'Conversion', severity: 'important',
    hint: 'Direct review shortlink (g.page/r/…/review). Also becomes the in-office QR code.',
  },
  {
    path: 'content.faqs', intake: 'content.faqs',
    label: 'FAQs', category: 'Content', severity: 'optional',
    hint: 'Questions the front desk answers daily. These become FAQPage schema.',
  },
  {
    path: 'content.testimonials', intake: 'content.testimonials',
    label: 'Patient testimonials', category: 'Social Proof', severity: 'optional',
    hint: '3–5 real reviews, copied from Google at intake.',
  },
  {
    path: 'content.insurance', intake: 'insurance_financing.plans',
    label: 'Insurance accepted', category: 'Insurance', severity: 'optional',
    hint: 'Plans accepted. "We are in-network with…" is what patients search for.',
  },
  {
    path: 'content.financing', intake: 'insurance_financing.financing',
    label: 'Financing options', category: 'Insurance', severity: 'optional',
    hint: 'CareCredit, in-house membership plans, payment arrangements.',
  },
  {
    path: 'practice.sameAs', intake: 'content.social',
    label: 'Social profiles', category: 'Social / Local', severity: 'optional',
    hint: 'Facebook, Instagram, Yelp, Healthgrades URLs. Become schema sameAs and footer links.',
  },

  // ── Brand ───────────────────────────────────────────────────────────────
  {
    path: 'brand.colors', intake: 'branding.colors',
    label: 'Brand colors', category: 'Branding', severity: 'optional',
    hint: 'Hex values if they have them. Defaults are applied silently otherwise.',
  },
];

// ---------------------------------------------------------------------------
// Access items
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AccessItem
 * @property {string}  id
 * @property {string}  service
 * @property {string}  label
 * @property {'cold'|'deposit'|'full'} phase   when it is FIRST needed
 * @property {'groundwork'|'client'|'shared'} owner  whose account it lives in
 * @property {boolean} automatable  can a harness obtain it unattended?
 * @property {string}  [leadTime]   set when it can block a launch by calendar
 * @property {string[]} [env]       env var names that carry it
 * @property {string}  [doc]        where the procedure is written down
 * @property {string}  note
 */

/** @type {AccessItem[]} */
export const ACCESS_ITEMS = [
  // ── Cold build: Groundwork credentials only ─────────────────────────────
  {
    id: 'anthropic', service: 'Anthropic', label: 'API key',
    phase: 'cold', owner: 'groundwork', automatable: true,
    env: ['ANTHROPIC_API_KEY'],
    note: 'Drives every AI step — silver extraction, copy, design critique, audits.',
  },
  {
    id: 'google-places', service: 'Google Places', label: 'API key',
    phase: 'cold', owner: 'groundwork', automatable: true,
    env: ['GOOGLE_PLACES_API_KEY', 'GOOGLE_PLACE_ID'],
    note: 'Read-only, needs no client consent. Sourcing, review scraping, GBP scan. Distinct from GBP OAuth.',
  },
  {
    id: 'pagespeed', service: 'PageSpeed Insights', label: 'API key',
    phase: 'cold', owner: 'groundwork', automatable: true,
    env: ['GOOGLE_PAGESPEED_API_KEY'],
    note: 'Optional — scores degrade to "not measured" without it.',
  },
  {
    id: 'cloudflare-groundwork', service: 'Cloudflare', label: 'Pages + D1 (Groundwork account)',
    phase: 'cold', owner: 'groundwork', automatable: true,
    env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID'],
    doc: 'References/launch-operations.md §12',
    note: 'Preview hosting and the ops CRM. Use a USER token, never an Account token. Store at ~/.config/groundwork/cloudflare.env (chmod 600), never in a repo.',
  },
  {
    id: 'github-groundwork', service: 'GitHub', label: 'Repo under Groundwork',
    phase: 'cold', owner: 'groundwork', automatable: true,
    env: ['GITHUB_REPO_OWNER', 'GITHUB_REPO_NAME'],
    note: 'Client repo stays Groundwork-owned through the preview.',
  },
  {
    id: 'gcs', service: 'Google Cloud Storage', label: 'Service account',
    phase: 'cold', owner: 'groundwork', automatable: true,
    env: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_STORAGE_BUCKET'],
    note: 'Sourcing screenshots and run artifacts. Key file on disk at chmod 600 — never inline in .env.',
  },

  // ── Discovery: ask at kickoff, not on launch day ────────────────────────
  {
    id: 'registrar', service: 'Domain registrar', label: 'Who holds the login',
    phase: 'deposit', owner: 'client', automatable: false,
    doc: 'References/launch-operations.md',
    note: 'Discover at kickoff. The answer is often "our old web guy", which is itself the finding.',
  },
  {
    id: 'dns-zone', service: 'DNS / Cloudflare zone', label: 'Which account owns the zone',
    phase: 'deposit', owner: 'client', automatable: false,
    note: 'Frequently the client\'s MSP, not the client. Verify with audit-client-zone.js. Batch every DNS ask into one request rather than negotiating a token.',
  },
  {
    id: 'cloudflare-client', service: 'Cloudflare', label: 'Pages project in client account',
    phase: 'deposit', owner: 'client', automatable: false,
    note: 'After the $500 deposit the site moves to their Cloudflare. Confirm via the Custom Domains tab which project truly serves the domain.',
  },

  // ── Full payment: ownership transfer ────────────────────────────────────
  {
    id: 'gbp-oauth', service: 'Google Business Profile', label: 'OAuth + Manager access',
    phase: 'full', owner: 'client', automatable: false,
    leadTime: 'days to weeks — Google must approve the API access request',
    env: ['GBP_CLIENT_ID', 'GBP_CLIENT_SECRET', 'GBP_REFRESH_TOKEN', 'GBP_ACCOUNT_ID', 'GBP_LOCATION_ID'],
    doc: 'docs/gbp/gbp-setup-walkthrough.md',
    note: 'Practice owns the Cloud project and stays listing Owner; Groundwork is Manager. Scripted two-part screen-share. START THE API REQUEST EARLY — it is the longest pole in any launch.',
  },
  {
    id: 'ga4', service: 'GA4', label: 'Property in the client\'s Google account',
    phase: 'full', owner: 'client', automatable: false,
    env: ['PUBLIC_GA4_MEASUREMENT_ID', 'GA4_CREDENTIALS_PATH', 'GA4_PROPERTY_ID'],
    doc: 'References/launch-operations.md §3',
    note: 'Create INSIDE the practice\'s own Google account — never a Groundwork account, or handoff becomes a migration. Add the practice as account-level Administrator at creation, not at handoff. Account creation is console-only.',
  },
  {
    id: 'gsc', service: 'Search Console', label: 'Domain property + DNS TXT verification',
    phase: 'full', owner: 'client', automatable: false,
    leadTime: 'blocked on a DNS change by whoever holds the zone',
    env: ['GSC_SITE_URL', 'GOOGLE_SERVICE_ACCOUNT_PATH'],
    note: 'Use a Domain property (covers apex + www). Practice is Owner. Verification is a manual DNS TXT handshake; sitemap submission is held until full payment.',
  },
  {
    id: 'github-client', service: 'GitHub', label: 'Client repo access',
    phase: 'full', owner: 'client', automatable: false,
    note: 'Redeploy fresh into client-owned infrastructure rather than transferring. Collaborator invite withheld until paid in full.',
  },
  {
    id: 'turnstile', service: 'Cloudflare Turnstile', label: 'Per-client keys',
    phase: 'deposit', owner: 'groundwork', automatable: true,
    env: ['PUBLIC_TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'],
    note: 'Form spam protection. Keys are per-site.',
  },
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Evaluate merged practice data against the data contract.
 *
 * @param {object} merged
 * @returns {{satisfied: DataField[], missing: DataField[], bySeverity: Record<string, DataField[]>}}
 */
export function evaluateDataFields(merged = {}) {
  const satisfied = [];
  const missing = [];

  for (const field of DATA_FIELDS) {
    const value = getPath(merged, field.path);
    const ok = field.satisfied
      ? Boolean(field.satisfied(value, merged))
      : isPresent(value);
    (ok ? satisfied : missing).push(field);
  }

  const bySeverity = { critical: [], important: [], optional: [] };
  for (const f of missing) bySeverity[f.severity].push(f);

  return { satisfied, missing, bySeverity };
}

/**
 * Access items required at or before a given phase.
 * @param {'cold'|'deposit'|'full'} phase
 */
export function accessItemsForPhase(phase) {
  const upto = PHASE.slice(0, PHASE.indexOf(phase) + 1);
  return ACCESS_ITEMS.filter(i => upto.includes(i.phase));
}

/** Items no harness can obtain on its own — the human queue. */
export function manualAccessItems() {
  return ACCESS_ITEMS.filter(i => !i.automatable);
}
