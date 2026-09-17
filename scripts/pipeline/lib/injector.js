/**
 * Clone the starter template and inject all config files from merged PracticeData.
 *
 * This module generates complete TypeScript/JS config files (not string-replace)
 * and sweeps .astro/.md files for placeholder tokens.
 */

import { cp, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import { DEFAULT_HOURS, DEFAULT_COLORS } from './schema.js';
import { esc } from './utils.js';
import { ensureContrast, validatePalette } from './contrast.js';
import { upsertManagedFile } from './managed-file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Template root is 3 levels up from this file (scripts/pipeline/lib -> project root) */
const TEMPLATE_ROOT = resolve(__dirname, '../../..');

/**
 * Directories / files to skip when cloning the template.
 *
 * Each entry is matched against the relative path from TEMPLATE_ROOT
 * (see cloneTemplate). Anything matched is excluded entirely — neither
 * the folder nor its contents are copied into clients/<slug>/.
 *
 * Rule of thumb: include a path here if it's
 *   (a) per-prospect operator state that should NOT ship with builds
 *       (audits, internal docs, credentials, pipeline artifacts)
 *   (b) the pipeline source itself (recursive copy hazard)
 *   (c) huge / regenerable (node_modules, dist)
 */
const CLONE_EXCLUDE = new Set([
  // Build artifacts + dependencies
  'node_modules',
  'dist',
  '.git',

  // Pipeline source — recursive copy hazard
  'scripts/pipeline',
  'skills',          // skill source files — runtime-loaded, not part of template output

  // Per-prospect operator state — must not ship with clients
  '_audits',         // OTHER prospects' audit outputs (HTML reports, findings, screenshots)
  '_memory',         // design-library of past builds
  '_pipeline',       // operator-side run artifacts
  '_credentials',    // service-account keys + secrets (gitignored, but stop the disk copy)
  'output',          // local dev output

  // Operator docs + clients — neither belongs in a client build
  'docs',            // Groundwork's internal architecture + design docs
  'clients',         // built sites — never copy other clients into a new build
]);

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Clone the template into outputDir and inject all configuration.
 *
 * @param {object} data      - Complete PracticeData from merger.
 * @param {string} outputDir - Absolute path to the target directory.
 * @param {object} [preset]  - Loaded vertical preset (from preset-loader).
 */
export async function injectTemplate(data, outputDir, preset = null, design = null, opts = {}) {
  console.log(`[injector] Cloning template into ${outputDir}`);
  await cloneTemplate(TEMPLATE_ROOT, outputDir);

  // Lint: every component in src/components/generated/ that loads
  // image-roles.json must use the same `../../public/...` depth. Drift here
  // produces silent failure (the gallery bug). Fail fast at template-clone
  // time so the operator sees a clear error instead of a missing section.
  await lintGeneratedComponentPaths(outputDir);

  console.log('[injector] Injecting site config');
  await injectSiteConfig(data, outputDir, preset);

  console.log('[injector] Injecting navigation');
  await injectNavigation(data, outputDir, buildLedgerRouteMap(opts.architecture, data));

  console.log('[injector] Injecting Tailwind config');
  await injectTailwindConfig(data, outputDir);

  console.log('[injector] Injecting Astro config');
  await injectAstroConfig(data, outputDir);

  console.log('[injector] Injecting deploy config');
  await injectDeployConfig(data, outputDir);

  console.log('[injector] Injecting env file');
  await injectEnvFile(data, outputDir);

  console.log('[injector] Injecting content config');
  await injectContentConfig(data, outputDir);

  console.log('[injector] Replacing page placeholders');
  await injectPagePlaceholders(data, outputDir, design);

  console.log('[injector] Linting colour tokens');
  await lintColorTokens(outputDir);

  console.log('[injector] Done.');
}

// ---------------------------------------------------------------------------
// Clone helper
// ---------------------------------------------------------------------------

/**
 * Verify every `.astro` file under `outputDir/src/components/generated/` that
 * loads `image-roles.json` uses the canonical `../../public/...` path. The
 * Astro runtime resolves `import.meta.url` for components in `generated/`
 * such that this is the correct depth. Three slashes (`../../../public/...`)
 * silently fails to load and any such section renders empty — that's the
 * gallery bug we hunted down by hand once.
 *
 * Throws with a clear error if drift is detected. Better to fail at template
 * clone than ship a broken section.
 */
async function lintGeneratedComponentPaths(outputDir) {
  const generatedDir = resolve(outputDir, 'src', 'components', 'generated');
  let entries;
  try {
    entries = await readdir(generatedDir, { withFileTypes: true });
  } catch {
    return; // dir may not exist on first runs
  }

  const offenders = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.astro')) continue;
    const filePath = join(generatedDir, e.name);
    const content = await readFile(filePath, 'utf8');

    // Look for any URL constructor referencing image-roles.json.
    const re = /new URL\(['"]([^'"]*image-roles\.json)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const refPath = m[1];
      // Allowed: '../../public/images/image-roles.json' (depth-2 from generated/)
      // Disallowed: anything else (most commonly '../../../public/...').
      if (!/^\.\.\/\.\.\/public\/images\/image-roles\.json$/.test(refPath)) {
        offenders.push({ file: e.name, refPath });
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map(o => `  - ${o.file}: ${o.refPath}`).join('\n');
    throw new Error(
      `[injector] Path-consistency lint failed in src/components/generated/.\n` +
      `Components in generated/ must reference image-roles.json as '../../public/images/image-roles.json'.\n` +
      `Drift detected:\n${list}\n` +
      `Fix the offending stub before re-running. (Other depths silently fail and the section renders empty.)`
    );
  }
}

/**
 * Every `brand-*` / `surface-*` utility used in a template must resolve to a
 * token the generated Tailwind config actually defines.
 *
 * Tailwind emits nothing for an unknown class rather than failing, so a stale
 * name degrades silently: `GalleryGrid.astro` styled its active filter pill
 * `bg-brand-navy text-white`, and because `brand-navy` was never a token the
 * background vanished and white text rendered on a near-white page at 1.07:1.
 * Nothing caught it until an axe run, several phases later.
 *
 * Warns rather than throws — a colour that doesn't resolve is a visual defect,
 * not a broken build, and failing the run would be a worse trade.
 */
async function lintColorTokens(outputDir) {
  let config;
  try { config = await readFile(resolve(outputDir, 'tailwind.config.mjs'), 'utf8'); }
  catch { return; }

  // Collect the leaf keys defined under each custom namespace.
  const defined = new Set();
  for (const ns of ['brand', 'surface']) {
    const block = config.match(new RegExp(`${ns}:\\s*\\{([\\s\\S]*?)\\}`));
    if (!block) continue;
    for (const m of block[1].matchAll(/['"]?([a-zA-Z0-9_-]+)['"]?\s*:/g)) {
      defined.add(`${ns}-${m[1]}`);
    }
  }
  if (defined.size === 0) return;

  const files = await glob('src/**/*.{astro,ts,js}', { cwd: outputDir, absolute: true });
  const offenders = new Map();
  const USED = /\b(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow)-((?:brand|surface)-[a-z0-9]+(?:-[a-z0-9]+)*)/g;

  for (const file of files) {
    let content;
    try { content = await readFile(file, 'utf8'); } catch { continue; }
    for (const m of content.matchAll(USED)) {
      // Strip Tailwind opacity suffixes (`bg-brand-primary/80`).
      const token = m[1].split('/')[0];
      if (defined.has(token)) continue;
      if (!offenders.has(token)) offenders.set(token, new Set());
      offenders.get(token).add(relative(outputDir, file));
    }
  }

  if (offenders.size === 0) return;
  console.warn(`[injector] ${offenders.size} colour token(s) used in templates but not defined in tailwind.config.mjs:`);
  for (const [token, where] of offenders) {
    console.warn(`    ✗ ${token} — ${[...where].slice(0, 3).join(', ')}`);
  }
  console.warn(`    Tailwind emits nothing for these, so paired text/background colours will not render as intended.`);
  console.warn(`    Defined: ${[...defined].join(', ')}`);
}

async function cloneTemplate(srcRoot, destRoot, finalDestRoot = null) {
  // finalDestRoot tracks the original output dir across recursive calls so we
  // can detect "destination is inside the template" loops. Without this, when
  // the user passes --output ../groundwork-builder/clients/foo (a path INSIDE
  // the template root), we'd recursively copy `clients/` into `clients/foo/clients/`
  // and infinite-loop until ENAMETOOLONG.
  finalDestRoot = finalDestRoot || resolve(destRoot);

  await mkdir(destRoot, { recursive: true });

  const entries = await readdir(srcRoot, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(srcRoot, entry.name);
    const destPath = join(destRoot, entry.name);

    // Compute the relative path from the template root for exclusion checks
    const relFromRoot = relative(TEMPLATE_ROOT, srcPath);

    // Check if this entry (or a parent path) is in the exclusion set
    const shouldExclude = [...CLONE_EXCLUDE].some(
      ex => relFromRoot === ex || relFromRoot.startsWith(ex + '/')
    );
    if (shouldExclude) continue;

    // Skip the destination itself if it lives inside the template root —
    // prevents the recursive copy from copying its own destination into itself.
    const absSrcPath = resolve(srcPath);
    if (absSrcPath === finalDestRoot || finalDestRoot.startsWith(absSrcPath + '/')) {
      continue;
    }

    if (entry.isDirectory()) {
      await cloneTemplate(srcPath, destPath, finalDestRoot);
    } else {
      await mkdir(dirname(destPath), { recursive: true });
      await cp(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// site.ts
// ---------------------------------------------------------------------------

export async function injectSiteConfig(data, outputDir, preset = null) {
  const p = data.practice;
  // doctors[] is the canonical source (set by merger). doctor (singular) is
  // the back-compat mirror of doctors[0].
  const allDoctors = Array.isArray(data.doctors) && data.doctors.length > 0
    ? data.doctors
    : (data.doctor && data.doctor.name ? [data.doctor, ...(data.additionalDoctors || [])] : (data.additionalDoctors || []));
  const d = allDoctors[0] || data.doctor || {};
  const secondaryDoctors = allDoctors.slice(1);
  const staffList = Array.isArray(data.staff) ? data.staff : [];
  const a = data.address;
  const h = data.hours || DEFAULT_HOURS;

  const hoursDisplay = (h.display || DEFAULT_HOURS.display)
    .map(e => `    { day: '${esc(e.day)}', time: '${esc(e.time)}' },`)
    .join('\n');

  const hoursSchema = (h.schema || DEFAULT_HOURS.schema)
    .map(s => `'${esc(s)}'`)
    .join(', ');

  const sameAs = (p.sameAs || [])
    .filter(Boolean)
    .map(url => `    '${esc(url)}',`)
    .join('\n');

  const sameAsBlock = sameAs
    ? `[\n    site.googleProfileLink,\n${sameAs}\n  ]`
    : `[\n    site.googleProfileLink,\n  ]`;

  const googleRating = data.content?.stats?.googleRating || data.reviews?.rating || null;
  const reviewCount  = data.reviews?.reviewCount || null;
  const ratingBlock  = (googleRating && reviewCount)
    ? `\n  'aggregateRating': {\n    '@type': 'AggregateRating',\n    'ratingValue': ${parseFloat(googleRating)},\n    'reviewCount': ${parseInt(reviewCount)},\n    'bestRating': 5,\n  },`
    : '';

  const businessType = preset?.schema?.businessType || 'Dentist';
  const defaultCredentials = preset?.schema?.defaultCredentials || 'DDS';

  const content = `// Central source of truth for practice information.
// Auto-generated by the build pipeline — do not edit manually.

export const site = {
  name: '${esc(p.name || '')}',
  url: 'https://${esc(p.domain || 'example.com')}',
  phone: '${esc(p.phone || '')}',
  phoneDigits: '${esc(p.phoneDigits || '')}',
  email: '${esc(p.email || '')}',
  googleReviewLink: '${esc(p.googleReviewLink || '')}',
  googleProfileLink: '${esc(p.googleProfileLink || '')}',
};

export const doctor = {
  // \`name\` includes the title prefix (e.g. "Dr. Anthony Hoang"). Use it as-is.
  // For copy that already provides a title, use \`nameNoTitle\` instead.
  name: '${esc(d.name || '')}',
  firstName: '${esc(d.firstName || '')}',
  lastName: '${esc(d.lastName || '')}',
  nameNoTitle: '${esc((d.name || '').replace(/^(Dr|Doctor|Mr|Mrs|Ms|Prof)\.?\s+/i, ''))}',
  credentials: '${esc(d.credentials || defaultCredentials)}',
  // Bio MUST come from the doctor's own about/bio page. We never fall back to
  // practice.aboutText / mission copy — that produces the "bio bleed" bug
  // where the practice's philosophy ends up posing as a doctor's biography.
  bio: ${JSON.stringify(d.bio || '')},
};

// Additional doctors — secondary clinicians at the practice. Templates that
// support multi-doctor display (about.astro, team page) iterate this array.
// Empty for single-doctor practices.
// (Back-compat mirror of doctors[1..] — new templates should use \`doctors\` directly.)
export const additionalDoctors = ${JSON.stringify(
  secondaryDoctors.filter(x => x?.name).map(x => ({
    name:        x.name        || '',
    firstName:   x.firstName   || '',
    lastName:    x.lastName    || '',
    nameNoTitle: (x.name || '').replace(/^(Dr|Doctor|Mr|Mrs|Ms|Prof)\.?\s+/i, ''),
    credentials: x.credentials || '',
    bio:         x.bio         || '',
    education:   x.education   || '',
    specialties: x.specialties || [],
    photoPath:   x.photoPath   || null,
  })),
  null,
  2,
)};

// Unified doctors[] — primary first, then additionalDoctors. Use this when
// you want to render ALL doctors uniformly (e.g. team page, multi-doctor
// "Meet Our Doctors" section).
export const doctors = [doctor, ...additionalDoctors];

// Non-doctor staff (hygienists, dental assistants, receptionists, office
// managers). Rendered as the supporting team on /about and /team pages.
// Empty for practices with no staff captured.
export const staff = ${JSON.stringify(
  staffList.filter(x => x?.name).map(x => ({
    name:        x.name        || '',
    role:        x.role        || 'other',
    bio:         x.bio         || '',
    credentials: x.credentials || '',
    photoPath:   x.photoPath   || null,
  })),
  null,
  2,
)};

export const address = {
  street: '${esc(a.street || '')}',
  city: '${esc(a.city || '')}',
  state: '${esc(a.state || '')}',
  zip: '${esc(a.zip || '')}',
  country: '${esc(a.country || 'US')}',
  full: '${esc(a.full || '')}',
};

export const hours = {
  display: [
${hoursDisplay}
  ],
  schema: [${hoursSchema}],
};

export const localBusinessSchema = {
  '@context': 'https://schema.org',
  '@type': '${esc(businessType)}',
  'name': site.name,
  'url': site.url,
  'telephone': site.phone,
  'address': {
    '@type': 'PostalAddress',
    'streetAddress': address.street,
    'addressLocality': address.city,
    'addressRegion': address.state,
    'postalCode': address.zip,
    'addressCountry': address.country,
  },
  'openingHours': hours.schema,
  'priceRange': '${esc(p.priceRange || '$$')}',${
    p.medicalSpecialty
      ? `\n  'medicalSpecialty': '${esc(p.medicalSpecialty)}',`
      : ''
  }${ratingBlock}
  'sameAs': ${sameAsBlock},
};

// Person schema for the practice's primary doctor — used on the about page
// and any page that profiles the doctor specifically.
// (Back-compat scalar; new code should iterate \`personSchemas[]\` instead.)
export const personSchema = {
  '@context': 'https://schema.org',
  '@type': 'Person',
  'name': doctor.name,
  'jobTitle': '${esc((d.credentials || defaultCredentials).trim())} ${esc((preset?.schema?.businessType || 'Dentist'))}',
  'worksFor': {
    '@type': '${esc(businessType)}',
    'name': site.name,
    'url': site.url,
    'address': localBusinessSchema.address,
  },${d.bio ? `
  'description': doctor.bio,` : ''}${d.education ? `
  'alumniOf': '${esc(d.education)}',` : ''}${d.specialties && d.specialties.length ? `
  'knowsAbout': ${JSON.stringify(d.specialties)},` : ''}
};

// Person schemas for ALL doctors — one entry per clinician. Use this on
// /about/ (so search engines see every doctor as a Person entity) and on
// per-doctor /team/<slug>/ pages. \`personSchema\` (singular, above) remains
// for back-compat = personSchemas[0].
export const personSchemas = doctors.map((doc) => ({
  '@context': 'https://schema.org',
  '@type': 'Person',
  'name': doc.name,
  'jobTitle': \`\${(doc.credentials || '${esc(defaultCredentials)}').trim()} ${esc(preset?.schema?.businessType || 'Dentist')}\`,
  'worksFor': {
    '@type': '${esc(businessType)}',
    'name': site.name,
    'url': site.url,
    'address': localBusinessSchema.address,
  },
  ...(doc.bio       ? { 'description': doc.bio } : {}),
  ...(doc.education ? { 'alumniOf':   doc.education } : {}),
  ...(doc.specialties && doc.specialties.length ? { 'knowsAbout': doc.specialties } : {}),
  ...(doc.photoPath ? { 'image': doc.photoPath } : {}),
}));
`;

  const filePath = resolve(outputDir, 'src/config/site.ts');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// navigation.ts
// ---------------------------------------------------------------------------

export async function injectNavigation(data, outputDir, ledgerRoutes = null) {
  // Build navLinks from data.navigation (source-site nav passthrough) if
  // available; otherwise fall back to the legacy hardcoded shape using the
  // services list. Source-site nav wins because hardcoding "About / Services /
  // Blog / FAQ" loses every practice's actual nav structure.
  const sourceNav = Array.isArray(data.navigation) ? data.navigation : [];
  const navLinksJs = sourceNav.length > 0
    ? buildNavLinksFromSource(sourceNav, data, ledgerRoutes)
    : buildLegacyNavLinks(data);

  const content = `// Navigation link structure for Header.astro
// Auto-generated by the build pipeline — do not edit manually.
// NOTE: The AI-generated Header.astro may build its own nav from site config + DNA.
// This file serves as a structured reference and fallback.

export interface NavDropdownItem {
  label: string;
  href: string;
  desc?: string;
}

export interface NavLink {
  label: string;
  href: string;
  dropdown?: NavDropdownItem[];
}

export const navLinks: NavLink[] = ${navLinksJs};
`;

  const filePath = resolve(outputDir, 'src/config/navigation.ts');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Navigation mapping helpers
// ---------------------------------------------------------------------------

/** Route prefixes owned by another generator — mirrors page-port.js. */
const PORT_OWNED_ROUTE = /^\/(?:$|services(?:\/|$)|team(?:\/|$)|blog(?:\/|$)|about$|faq$|financing$|gallery$|schedule$|thank-you$)/;

/**
 * Source href → rebuilt route, taken from the Architect ledger.
 *
 * Targets are checked against the routes the build will actually produce.
 * Architect names destinations in its own terms — `/team/dr-azimi` where the
 * team generator emits `/team/shayan-azimi` — and an unchecked target becomes a
 * nav link to a 404. Entries that don't resolve are dropped so the existing
 * heuristics (which do know the real slugs) handle them instead.
 */
function buildLedgerRouteMap(architecture, data = {}) {
  if (!architecture?.ledger?.length) return null;

  const real = new Set([
    '/', '/about', '/services', '/faq', '/financing',
    '/gallery', '/schedule', '/thank-you', '/blog',
  ]);
  for (const svc of data.services?.offered || []) {
    if (svc?.slug) real.add(`/services/${svc.slug}`);
  }
  for (const doc of data.doctors || []) {
    const slug = slugifyName(doc?.name);
    if (slug) real.add(`/team/${slug}`);
  }
  // Routes this run will port into existence. Targets under a prefix another
  // generator owns are skipped by page-port, so they are real only if the
  // service/doctor lists above already produced them — otherwise Architect's
  // naming (`/team/dr-azimi`) would mask the generator's (`/team/shayan-azimi`).
  for (const entry of architecture.ledger) {
    if (!entry?.target || entry.disposition === 'drop') continue;
    const target = normalizeNavPath(entry.target);
    if (!PORT_OWNED_ROUTE.test(target)) real.add(target);
  }
  const map = new Map();
  const dropped = [];
  for (const entry of architecture.ledger) {
    if (!entry?.source || !entry.target) continue;
    if (entry.disposition === 'drop') continue;
    const target = normalizeNavPath(entry.target);
    if (!real.has(target)) { dropped.push(`${entry.source} → ${entry.target}`); continue; }
    map.set(normalizeNavPath(entry.source), entry.target);
  }
  if (dropped.length) {
    console.log(`[injector.nav] Ignoring ${dropped.length} ledger target(s) with no matching route: ${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? '…' : ''}`);
  }
  return map.size ? map : null;
}

function normalizeNavPath(href) {
  let p = String(href || '').trim().toLowerCase();
  try { if (/^https?:\/\//.test(p)) p = new URL(p).pathname; } catch { /* keep as-is */ }
  p = p.split(/[?#]/)[0].replace(/\/+$/, '');
  return p || '/';
}

// Patterns we always drop (login portals, admin URLs)
const NAV_JUNK = [
  /patient-?login/i,
  /\/admin\b/i,
  /\/login\b/i,
  /\/account\b/i,
];

const NAV_MAX_TOP_LEVEL = 7;
const NAV_MAX_DROPDOWN  = 10;

function isJunkNav(href) {
  if (!href) return true;
  for (const re of NAV_JUNK) if (re.test(href)) return true;
  return false;
}

function slugifyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^dr\.?\s+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Map a source-site href to the rebuilt-site equivalent, when we can.
 * Returns null if the link should be dropped (no equivalent on the new site).
 */
function mapNavHref(href, data, ledgerRoutes = null) {
  if (!href) return null;
  if (isJunkNav(href)) return null;

  // The Architect ledger already decided where each source page's content went,
  // so it is the authoritative nav mapping. Without it the heuristics below send
  // real destinations to the wrong place — /reviews.html to /about even when a
  // /reviews page exists — or drop the link entirely.
  if (ledgerRoutes) {
    const direct = ledgerRoutes.get(normalizeNavPath(href));
    if (direct) return direct;
  }

  // Skip external/absolute URLs that aren't our domain
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      const ownDomain = data.practice?.domain || '';
      if (ownDomain && !u.hostname.includes(ownDomain)) return null;
      href = u.pathname + u.search + u.hash;
    } catch { return null; }
  }

  // Strip .php / .html / .htm extensions
  let path = href.replace(/\.(php|html?|aspx)$/i, '');
  if (path === '/index' || path === '') path = '/';

  // Homepage link in nav — typically the logo handles this. Drop from menu.
  if (path === '/') return null;

  // Doctor pages: /meet-dr-cortez or /dr-cortez → /team/<doctor slug>.
  // Legacy dental sites use both shapes; matching only the `meet-` form dropped
  // every bio link on sites that use the bare form.
  const drMatch = path.match(/\/(?:meet[-_]?)?dr[-_.]([a-z][a-z0-9-]*)/i);
  if (drMatch) {
    const token = drMatch[1].toLowerCase();
    const doctors = data.doctors || [];
    const found = doctors.find(d =>
      (d?.lastName && d.lastName.toLowerCase() === token) ||
      slugifyName(d?.name).split('-').includes(token)
    );
    if (found) return `/team/${slugifyName(found.name)}`;
    console.log(`[injector.nav] Dropping doctor link "${href}" — no matching doctor in doctors[]`);
    return null;
  }

  // Standard page paths most sites have
  if (/^\/(about|about-us|our-practice|what-sets-us-apart)\b/i.test(path)) return '/about';
  if (/^\/(contact|location|directions|appointment-scheduling|schedule|book)/i.test(path)) return '/contact';
  if (/^\/(team|staff|meet-our-team|meet-our-staff|our-team)\b/i.test(path)) return '/about';
  if (/^\/(blog|news)\b/i.test(path)) return '/blog';
  if (/^\/(faq|faqs|questions)\b/i.test(path)) return '/faq';
  if (/^\/(services|treatments|dental-services|procedures)\b/i.test(path)) return '/services';
  if (/^\/(testimonials|reviews|patient-testimonials)\b/i.test(path)) return '/about';

  // Service pages: try to match against offered services by slug
  const services = data.services?.offered || [];
  const lastSeg = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
  if (lastSeg) {
    const matched = services.find(s => s.slug === lastSeg || slugifyName(s.name) === lastSeg);
    if (matched) return `/services/${matched.slug}`;
  }

  // No mapping — drop (don't ship 404 nav)
  console.log(`[injector.nav] Dropping unmapped link "${href}" (no rebuilt-site equivalent)`);
  return null;
}

function buildNavLinksFromSource(sourceNav, data, ledgerRoutes = null) {
  // Normalize: each item is { text, href, children? }
  const mapped = [];
  const seenHrefs = new Set();

  for (const item of sourceNav) {
    const label = String(item?.text || '').trim().split(/\s{2,}|\n/)[0].slice(0, 40); // strip trailing crawled body
    if (!label) continue;
    const href = mapNavHref(item?.href, data, ledgerRoutes);
    if (!href) continue;
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);

    let dropdown = null;
    if (Array.isArray(item.children) && item.children.length > 0) {
      const children = [];
      const seenChild = new Set();
      for (const c of item.children) {
        const cLabel = String(c?.text || '').trim().split(/\s{2,}|\n/)[0].slice(0, 40);
        if (!cLabel) continue;
        const cHref = mapNavHref(c?.href, data, ledgerRoutes);
        if (!cHref || seenChild.has(cHref)) continue;
        seenChild.add(cHref);
        children.push({ label: cLabel, href: cHref });
        if (children.length >= NAV_MAX_DROPDOWN) break;
      }
      if (children.length > 0) dropdown = children;
    }
    mapped.push({ label, href, dropdown });
  }

  // If we got nothing usable, fall back
  if (mapped.length === 0) return buildLegacyNavLinks(data);

  // Cap top-level. Overflow → a "More" dropdown at the end.
  let top = mapped;
  if (mapped.length > NAV_MAX_TOP_LEVEL) {
    const keep = mapped.slice(0, NAV_MAX_TOP_LEVEL - 1);
    const overflow = mapped.slice(NAV_MAX_TOP_LEVEL - 1).slice(0, NAV_MAX_DROPDOWN);
    keep.push({
      label: 'More',
      href: '/about',
      dropdown: overflow.map(o => ({ label: o.label, href: o.href })),
    });
    top = keep;
  }

  return serializeNavLinks(top);
}

function buildLegacyNavLinks(data) {
  const offered = (data.services?.offered || []).slice(0, 8);
  const dropdown = offered.map(s => ({
    label: typeof s === 'string' ? s : s.name,
    href: `/services/${typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, '-') : (s.slug || s.name?.toLowerCase().replace(/\s+/g, '-'))}`,
    desc: typeof s === 'object' ? (s.description || s.blurb || '') : '',
  }));
  dropdown.push({ label: 'All Services', href: '/services' });
  const links = [
    { label: 'About', href: '/about' },
    { label: 'Services', href: '/services', dropdown },
    { label: 'Blog', href: '/blog' },
    { label: 'FAQ', href: '/faq' },
  ];
  return serializeNavLinks(links);
}

function serializeNavLinks(links) {
  const lines = ['['];
  for (const l of links) {
    const dropdownStr = l.dropdown
      ? `, dropdown: [${l.dropdown.map(d =>
          `{ label: '${esc(d.label)}', href: '${esc(d.href)}'${d.desc ? `, desc: '${esc(d.desc)}'` : ''} }`
        ).join(', ')}]`
      : '';
    lines.push(`  { label: '${esc(l.label)}', href: '${esc(l.href)}'${dropdownStr} },`);
  }
  lines.push(']');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// tailwind.config.mjs
// ---------------------------------------------------------------------------

/**
 * Write src/styles/tokens.css — the single place colour values exist.
 *
 * Colours are declared as Tailwind v4 @theme variables, and context classes
 * override THOSE SAME `--color-*` names. That detail is the whole design, and
 * it is easy to get subtly wrong:
 *
 *   An earlier version added a `--c-primary` indirection and set
 *   `--color-brand-primary: rgb(var(--c-primary))`, expecting a context to
 *   flip the palette by reassigning `--c-primary`. It does not work. A custom
 *   property's var() references are substituted at the element that DECLARES
 *   it, so the root value gets baked in and inherited. Measured in a browser:
 *   plain `text-brand-primary` read rgb(27,58,92) inside the dark context —
 *   identical to light — while the opacity variant correctly read
 *   rgb(71,133,201), because that one inlines the var() at the use site.
 *   Half the utilities would have honoured the theme and half would not.
 *
 * Overriding `--color-*` directly is what we ship: plain utilities resolve
 * correctly in every context.
 *
 * Known limit: Tailwind v4 constant-folds an opacity modifier when the theme
 * colour is a literal, so `bg-brand-primary/10` becomes `#1b3a5c1a` and keeps
 * the light value inside `.section-dark`. The alternatives are worse — see the
 * measured comparison in the generated tokens.css. Inside a dark band, use an
 * explicit token (`text-brand-on-dark`) rather than an opacity modifier.
 *
 * Verify any change here with getComputedStyle on BOTH a plain and an
 * opacity-modified utility. The CSS looks correct in all three variants; only
 * the computed value tells them apart.
 */
async function writeTokensCss(
  { colors, highlight, onDark, accentOnDark, highlightOnDark, textRole, borderRole, pageBg },
  outputDir,
) {
  const css = `/* Auto-generated by injector.js — do not edit by hand.
   Colour values live here and ONLY here. tailwind.config.mjs carries no
   colours; Tailwind v4 reads them from the @theme block below. */

@theme {
  --color-brand-primary:   ${colors.primary};
  --color-brand-secondary: ${colors.secondary};
  --color-brand-light:     ${colors.light};
  --color-brand-accent:    ${colors.accent};
  --color-brand-highlight: ${highlight};
  /* Kept for templates that place text on a dark band explicitly. Inside
     .section-dark, brand-primary already resolves to this. */
  --color-brand-on-dark:   ${onDark};

  --color-neutral-dark:    ${colors.dark};
  --color-neutral-text:    ${textRole};
  --color-neutral-mid:     ${colors.muted};
  --color-neutral-light:   ${colors.light};
  --color-neutral-border:  ${borderRole};

  --color-surface-1:       ${pageBg};
  --color-surface-2:       ${colors.light};

  --color-charcoal:        ${colors.dark};
  --color-mid-gray:        ${colors.muted};
  --color-border-light:    ${borderRole};
}

/* Dark band. Add to any section sitting on the dark ground; everything inside
   resolves correctly with no per-component overrides and no dark variants.

   Correcting a colour for AA on a light ground pushes it away from AA on a
   dark one, so each ground carries its own counterpart — the accent darkened
   to pass on white measured 3.21:1 here without one.

   This replaces a \`.bg-neutral-dark .text-brand-primary\` descendant rule,
   which matched every element under a dark section including white cards
   nested inside it, and produced more contrast failures than it fixed. An
   opt-in class does not leak downward. */
.section-dark {
  --color-brand-primary:   ${onDark};
  --color-brand-accent:    ${accentOnDark};
  --color-brand-highlight: ${highlightOnDark};

  --color-neutral-dark:    ${pageBg};
  --color-neutral-text:    ${pageBg};
  --color-neutral-mid:     ${colors.light};
  --color-neutral-border:  ${colors.muted};

  --color-surface-1:       ${colors.dark};
  --color-surface-2:       ${colors.dark};

  background-color: var(--color-surface-1);
  color: var(--color-neutral-text);
}
`;
  const dir = resolve(outputDir, 'src/styles');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'tokens.css'), css, 'utf-8');
}

export async function injectTailwindConfig(data, outputDir) {
  // Strict — every design token must come from the brand step. No hardcoded
  // fallbacks. If a required key is missing, that means the upstream brand
  // step (the brand step) failed to produce it, and we want loud
  // failure rather than silently shipping generic defaults across builds.
  let colors = data.brand?.colors || {};
  const fonts  = data.brand?.fonts  || {};
  // Full brand-dna roles (Step 6): real page background, divider, and body-text
  // colors. When absent (no brand step) we fall back to derived
  // values so this stays backward-compatible.
  const roles  = data.brand?.roles  || {};
  const pageBg     = roles.background || '#FFFFFF';
  const borderRole = roles.border     || colors.muted;
  const textRole   = roles.text       || colors.dark;

  const required = ['primary', 'secondary', 'light', 'accent', 'dark', 'muted'];
  const missingColors = required.filter(k => !colors[k]);
  // Throw here, not after the WCAG guard below. validatePalette/ensureContrast
  // dereference these same colors, so a missing key crashed them first with
  // `Invalid hex color: "undefined"` from contrast.js — burying this actionable
  // message behind a stack trace that names neither the brand step nor the key.
  if (missingColors.length > 0) {
    throw new Error(
      `[injector] Brand palette missing required keys: ${missingColors.join(', ')}. ` +
      `The brand step (brand-dna.js → applyBrandToMerged) must produce all of: ${required.join(', ')}. ` +
      `Refusing to ship hardcoded fallback colors.`
    );
  }
  // WCAG guard at the boundary.
  //
  // brand-tokens.js corrects the palette when it maps brand-dna, but later steps
  // (reference catalog, distill, director) can replace `brand.colors` afterwards
  // — one run reached this point with accent #7ab800 and light #e8f5f5, neither
  // of which the earlier guard had ever seen. This is the last place colours
  // exist before they become the site's Tailwind config, so validate here too.
  const guarded = validatePalette({
    primary:   colors.primary,
    accent:    colors.accent,
    highlight: colors.highlight || colors.accent,
    light:     colors.light,
    dark:      colors.dark,
    muted:     colors.muted,
  });
  for (const adj of guarded.adjustments || []) {
    console.log(`[injector] WCAG auto-correct: ${adj.key} ${adj.from} → ${adj.to}`);
  }
  for (const issue of guarded.issuesAfter || []) {
    console.warn(`[injector] palette still fails AA: ${issue.label} at ${issue.contrast}:1`);
  }
  colors = { ...colors, primary: guarded.palette.primary, accent: guarded.palette.accent };

  // Accent-as-highlight on light surfaces (eyebrow labels) must meet AA 4.5:1.
  const highlight = ensureContrast(guarded.palette.highlight || colors.accent, colors.light, 4.5).hex;
  // ...and its counterpart for text on the dark band.
  const onDark = colors.primaryOnDark
    || ensureContrast(guarded.palette.primary, colors.dark || '#111827', 4.5, { direction: 'lighter' }).hex;
  if (!fonts.heading || !fonts.body) {
    throw new Error(
      `[injector] Brand fonts missing: heading=${fonts.heading || '(missing)'}, body=${fonts.body || '(missing)'}. ` +
      `The brand step (brand-dna) must produce both. Refusing to ship Playfair/DM Sans defaults.`
    );
  }

  // Derived system tokens — every value traces back to the brand palette:
  //   surface-1   = pure white (the page background; not a brand decision)
  //   surface-2   = brand.light  (warm off-white from brand)
  //   neutral-*   = derived from brand.dark / brand.muted / brand.light
  // No literal hex values appear in this output that didn't come from brand.
  //
  // Colours reach Tailwind through CSS variables rather than as hex, which is
  // what lets a section redefine the whole palette by adding one class. See
  // tokens.css below: `.section-dark` reassigns the same variable names, so
  // `text-brand-primary` inside a dark band resolves to the lightened primary
  // without any component needing a dark-mode variant.
  //
  // This supersedes the descendant-selector attempt documented in
  // injectGlobalCss. `.bg-neutral-dark .text-brand-primary` matched every
  // element under a dark section — including white cards nested inside one —
  // and produced more failures than it fixed. An explicit opt-in class does
  // not leak into nested contexts.
  // Correcting a colour for AA on a light ground necessarily pushes it away
  // from AA on a dark one — the accent darkened to 4.5:1 on white measured
  // 3.21:1 on the dark band. Each ground needs its own counterpart, or
  // .section-dark ships a contrast failure the moment anyone uses it.
  const accentOnDark = ensureContrast(colors.accent, colors.dark, 4.5, { direction: 'lighter' }).hex;
  const highlightOnDark = ensureContrast(highlight, colors.dark, 4.5, { direction: 'lighter' }).hex;

  await writeTokensCss(
    { colors, highlight, onDark, accentOnDark, highlightOnDark, textRole, borderRole, pageBg },
    outputDir,
  );

  const content = `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      // Colours are NOT here. Tailwind v4 reads them from the @theme block in
        // src/styles/tokens.css, which is also where the per-context grounds
        // live. Defining them here as rgb(var(--x) / <alpha-value>) looks
        // right and is v3 syntax — under v4 it compiles to / 1, silently
        // making every opacity modifier fully opaque.
      fontFamily: {
        serif: ['${esc(fonts.heading)}', 'Georgia', 'serif'],
        sans:  ['${esc(fonts.body)}',    'system-ui', 'sans-serif'],
      },
    },
  },
};
`;

  const filePath = resolve(outputDir, 'tailwind.config.mjs');
  await writeFile(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// global.css — DNA-driven component classes
// ---------------------------------------------------------------------------

/**
 * Generate src/styles/global.css from the design DNA so that btn-primary,
 * btn-secondary, .card, and .section-heading reflect the archetype choices
 * (radius, density, heading scale) instead of being hardcoded.
 */
export async function injectGlobalCss(dna, outputDir, colors = null) {
  if (!dna) return;

  // Radius token → Tailwind rounded class
  const radiusMap = {
    none:  'rounded-none',
    sm:    'rounded-sm',
    md:    'rounded-md',
    lg:    'rounded-lg',
    xl:    'rounded-xl',
    full:  'rounded-full',
  };
  const btnRadius = radiusMap[dna.radius] || 'rounded-md';
  const cardRadius = dna.radius === 'none' ? 'rounded-none'
    : dna.radius === 'full' ? 'rounded-2xl'
    : dna.radius === 'xl'   ? 'rounded-2xl'
    : dna.radius === 'lg'   ? 'rounded-xl'
    : 'rounded-xl';

  // Density token → button padding
  const paddingMap = {
    compact: 'px-5 py-2.5',
    default: 'px-6 py-3',
    airy:    'px-8 py-4',
  };
  const btnPadding = paddingMap[dna.density] || 'px-6 py-3';

  // Heading scale → font sizes
  const headingMap = {
    dramatic:   'text-5xl md:text-6xl',
    moderate:   'text-4xl md:text-5xl',
    restrained: 'text-3xl md:text-4xl',
  };
  const sectionHeading = headingMap[dna.headingScale] || headingMap.moderate;

  // Card treatment → border/shadow
  const cardTreatmentMap = {
    'flat':        'border border-border-light bg-surface-2',
    'soft-shadow': 'shadow-sm bg-surface-1',
    'hard-shadow': 'shadow-md bg-surface-1',
    'outlined':    'border-2 border-neutral-dark bg-surface-1',
    'ghost':       'bg-surface-2',
  };
  const cardStyle = cardTreatmentMap[dna.cardTreatment] || 'border border-border-light bg-surface-2';

  // Motion token → transition speed
  const motionMap = {
    none:    'duration-0',
    subtle:  'duration-200',
    moderate:'duration-300',
    expressive: 'duration-500',
  };
  const transitionDuration = motionMap[dna.motion] || 'duration-200';

  // Tailwind 4 syntax: @import "tailwindcss" replaces the old
  // @tailwind base/components/utilities directives. @config points at the
  // project-root tailwind.config.mjs so theme tokens resolve in @apply rules.
  // Without this, `@apply font-sans` (and every other utility class) fails
  // with "Cannot apply unknown utility class".
  // NOTE: an earlier attempt re-pointed `text-brand-primary` to a lightened
  // variant via `.bg-neutral-dark .text-brand-primary`. It made things worse:
  // a descendant selector matches every element under a dark section, including
  // white cards nested inside one, so the lightened colour landed on white and
  // produced 14 new failures where it fixed fewer. CSS cannot see an element's
  // real background — only its nearest styled ancestor — so primary-on-dark has
  // to be fixed where the template actually places it.
  const css = `@import "tailwindcss";
@config "../../tailwind.config.mjs";
/* Colour tokens. Generated alongside tailwind.config.mjs; every colour class
   in this file resolves through the variables it declares. */
@import "./tokens.css";

/* Auto-generated from design DNA — archetype: ${dna.archetype || 'default'} */

@layer base {
  html {
    scroll-behavior: smooth;
  }

  body {
    @apply font-sans antialiased text-neutral-dark;
  }

  h1 {
    @apply font-serif;
  }

  a {
    @apply transition-colors ${transitionDuration};
  }
}

@layer components {
  .btn-primary {
    @apply inline-block bg-brand-primary text-white font-semibold ${btnPadding} ${btnRadius} transition-all ${transitionDuration} text-center hover:opacity-90;
  }

  .btn-secondary {
    @apply inline-block bg-transparent text-brand-primary font-semibold ${btnPadding} ${btnRadius} transition-all ${transitionDuration} text-center border border-brand-primary hover:bg-brand-primary hover:text-white;
  }

  .btn-accent {
    @apply inline-block bg-brand-accent text-white font-semibold ${btnPadding} ${btnRadius} transition-all ${transitionDuration} text-center hover:opacity-90;
  }

  .section-heading {
    @apply ${sectionHeading} font-bold leading-tight tracking-tight text-neutral-dark;
  }

  .section-subheading {
    @apply text-2xl md:text-3xl font-semibold leading-tight tracking-tight text-neutral-dark;
  }

  .card {
    @apply ${cardRadius} p-6 ${cardStyle};
  }

  .prose-dental {
    @apply text-neutral-mid leading-relaxed;
  }

  .prose-dental a {
    @apply text-brand-primary underline underline-offset-2 decoration-brand-primary/40 hover:decoration-brand-primary;
  }

  .prose-dental p {
    @apply mb-4;
  }

  .prose-dental h2 {
    @apply text-2xl md:text-3xl font-semibold leading-tight tracking-tight text-neutral-dark mt-8 mb-4;
  }

  .prose-dental h3 {
    @apply font-serif text-xl font-semibold mt-6 mb-3 text-neutral-dark;
  }

  .prose-dental ul {
    @apply list-disc list-inside mb-4 space-y-2;
  }

  .prose-dental ol {
    @apply list-decimal list-inside mb-4 space-y-2;
  }

  .nav-link {
    @apply font-medium transition-colors ${transitionDuration} text-neutral-dark hover:text-brand-primary;
  }
}
`;

  const filePath = resolve(outputDir, 'src/styles/global.css');
  await writeFile(filePath, css, 'utf-8');
}

// ---------------------------------------------------------------------------
// astro.config.mjs
// ---------------------------------------------------------------------------

export async function injectAstroConfig(data, outputDir) {
  const domain = data.practice?.domain || 'example.com';
  const siteUrl = `https://${domain}`;

  const hubPaths = (data.services?.hubs || [])
    .map(h => `'/${h.slug}/'`)
    .join(', ');

  // Astro 6 + Tailwind 4 — Tailwind is wired via the Vite plugin
  // (@tailwindcss/vite), not the deprecated @astrojs/tailwind integration.
  // Matches this repo's root astro.config.mjs and the generated project's
  // package.json (which already lists @tailwindcss/vite as a dependency).
  const content = `import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: '${esc(siteUrl)}',
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      entries: ['src/pages/**/*.astro'],
      noDiscovery: true,
    },
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/thank-you'),
      serialize(item) {
        const siteUrl = '${esc(siteUrl)}';
        if (item.url === siteUrl + '/') {
          return { ...item, priority: 1.0, changefreq: 'weekly' };
        }
        const highPriority = [${hubPaths ? hubPaths + ', ' : ''}'/about'];
        if (highPriority.some(p => item.url.endsWith(p) || item.url.endsWith(p + '/'))) {
          return { ...item, priority: 0.9, changefreq: 'weekly' };
        }
        if (item.url.includes('/blog/') && !item.url.replace(siteUrl + '/blog/', '').includes('/')) {
          return { ...item, priority: 0.7, changefreq: 'weekly' };
        }
        if (item.url.includes('/blog/')) {
          return { ...item, priority: 0.6, changefreq: 'monthly' };
        }
        return { ...item, priority: 0.8, changefreq: 'monthly' };
      },
    }),
  ],
});
`;

  const filePath = resolve(outputDir, 'astro.config.mjs');
  await writeFile(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// .github/workflows/deploy.yml
// ---------------------------------------------------------------------------

export async function injectEnvFile(data, outputDir) {
  const ga4Id = data.content?.ga4MeasurementId || null;
  if (!ga4Id) return;

  const envPath = resolve(outputDir, '.env');
  let existing = '';
  try { existing = await readFile(envPath, 'utf-8'); } catch { /* new file */ }

  // Overwrite or append PUBLIC_GA4_MEASUREMENT_ID
  const line = `PUBLIC_GA4_MEASUREMENT_ID=${ga4Id}`;
  const updated = existing.includes('PUBLIC_GA4_MEASUREMENT_ID=')
    ? existing.replace(/^PUBLIC_GA4_MEASUREMENT_ID=.*/m, line)
    : (existing.trimEnd() ? existing.trimEnd() + '\n' + line + '\n' : line + '\n');

  await writeFile(envPath, updated, 'utf-8');
}

export async function injectDeployConfig(data, outputDir) {
  const deployPath = resolve(outputDir, '.github/workflows/deploy.yml');

  let content;
  try {
    content = await readFile(deployPath, 'utf-8');
  } catch {
    // No deploy file in the cloned output — nothing to patch
    return;
  }

  const domain = data.practice?.domain || 'example.com';
  const projectName = domain.replace(/\./g, '-');

  content = content.replace(/https:\/\/\[DOMAIN\]/g, `https://${domain}`);
  content = content.replace(/\[DOMAIN\]/g, domain);
  content = content.replace(/\[PROJECT_NAME\]/g, projectName);

  await writeFile(deployPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// content/config.ts  (update default author)
// ---------------------------------------------------------------------------

export async function injectContentConfig(data, outputDir) {
  const configPath = resolve(outputDir, 'src/content/config.ts');

  let content;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    return;
  }

  const practiceName = data.practice?.name || '';
  if (practiceName) {
    content = content.replace(
      /\.default\(['"].*?['"]\)/g,
      `.default('${esc(practiceName)}')`
    );
  }

  await writeFile(configPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Placeholder sweep across .astro and .md files
// ---------------------------------------------------------------------------

export async function injectPagePlaceholders(data, outputDir, design = null) {
  const patterns = [
    resolve(outputDir, 'src/**/*.astro'),
    resolve(outputDir, 'src/**/*.md'),
  ];

  let files = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { nodir: true });
    files = files.concat(matches);
  }

  // Build replacement map from data
  const city = data.address?.city || '';
  const state = data.address?.state || '';
  const practiceName = data.practice?.name || '';
  const doctorFirst = data.doctor?.firstName || '';
  const doctorLast = data.doctor?.lastName || '';
  const credentials = data.doctor?.credentials || 'DDS';
  const domain = data.practice?.domain || 'example.com';
  const street = data.address?.street || '';
  const zip = data.address?.zip || '';

  // Stats replacements — replace [X]+ patterns near known stat labels
  const stats = data.content?.stats || {};

  const doctorFullName = data.doctor?.name
    || (doctorFirst ? `Dr. ${doctorFirst} ${doctorLast}`.trim() : '');
  const doctorBio = data.doctor?.bio
    || (doctorFullName ? `${doctorFullName} is dedicated to providing exceptional dental care to patients in ${city || 'the community'}.` : '');

  // Build the fonts CSS URL (provider-aware: google | fontshare) from brand
  // fonts (preferred — produced by the brand step) with the design-detection
  // fonts as a backstop only when the brand step didn't run. We never fall
  // back to a hardcoded family.
  const fontsCss = buildFontsCssUrl(data.brand?.fonts || design?.fonts);

  const replacements = [
    // Exact bracket placeholders
    [/\[CITY\]/g, city],
    [/\[STATE\]/g, state],
    [/\[PRACTICE_NAME\]/g, practiceName],
    [/\[FIRST_NAME\]/g, doctorFirst],
    [/\[LAST_NAME\]/g, doctorLast],
    [/\[DOCTOR_NAME\]/g, doctorFullName],
    [/\[DOCTOR_BIO\]/g, doctorBio],
    [/\[CREDENTIALS\]/g, credentials],
    [/\[DOMAIN\]/g, domain],
    [/\[STREET_ADDRESS\]/g, street],
    [/\[ZIP\]/g, zip],
    [/\[YOUR_GOOGLE_REVIEW_ID\]/g, extractGoogleId(data.practice?.googleReviewLink) || 'YOUR_GOOGLE_REVIEW_ID'],
    [/\[YOUR_GOOGLE_PROFILE_ID\]/g, extractGoogleId(data.practice?.googleProfileLink) || 'YOUR_GOOGLE_PROFILE_ID'],
    [/\[GOOGLE_FONTS_URL\]/g, fontsCss.url],
    [/\[FONTS_PRECONNECT\]/g, fontsCss.preconnect],
  ];

  for (const filePath of files) {
    let content = await readFile(filePath, 'utf-8');
    let changed = false;

    for (const [pattern, replacement] of replacements) {
      const before = content;
      content = content.replace(pattern, replacement);
      if (content !== before) changed = true;
    }

    // Replace stat [X]+ placeholders with actual values when available
    if (stats.yearsExperience) {
      const before = content;
      content = content.replace(
        /(\[X\]\+)([\s\S]{0,40}Years?\s*Experience)/gi,
        `${stats.yearsExperience}+$2`
      );
      if (content !== before) changed = true;
    }
    if (stats.happyPatients) {
      const before = content;
      content = content.replace(
        /(\[X\]\+)([\s\S]{0,40}Happy\s*Patients?)/gi,
        `${stats.happyPatients}+$2`
      );
      if (content !== before) changed = true;
    }
    if (stats.fiveStarReviews) {
      const before = content;
      content = content.replace(
        /(\[X\]\+)([\s\S]{0,40}5[- ]?Star\s*Reviews?)/gi,
        `${stats.fiveStarReviews}+$2`
      );
      if (content !== before) changed = true;
    }

    // Replace any remaining [X]+ with a safe placeholder
    {
      const before = content;
      content = content.replace(/\[X\]\+/g, '—');
      if (content !== before) changed = true;
    }

    if (changed) {
      await writeFile(filePath, content, 'utf-8');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Google Place ID from a g.page URL.
 * e.g. 'https://g.page/r/CU4itT3RNhmQEBM/review' -> 'CU4itT3RNhmQEBM'
 */
function extractGoogleId(url) {
  if (!url) return null;
  const match = url.match(/\/r\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Build a fonts CSS URL from brand-dna font choices — provider-aware
 * (google | fontshare; see lib/brand/font-pairings.js for the curation +
 * license notes). Returns { url, preconnect } so the template's preconnect
 * hints match the provider actually used.
 * Strict — fails loudly if fonts aren't provided. We never ship a default
 * typeface across builds; that's exactly the contamination we're avoiding.
 */
function buildFontsCssUrl(fonts) {
  const heading = fonts?.heading || fonts?.display;
  const body    = fonts?.body;
  if (!heading || !body) {
    throw new Error(
      `[buildFontsCssUrl] Brand fonts missing: heading=${heading || '(missing)'}, body=${body || '(missing)'}. ` +
      `The brand step (brand-dna) must produce both.`
    );
  }

  if ((fonts?.provider || 'google') === 'fontshare') {
    // Fontshare v2 CSS API: family slug lowercase-hyphenated; weights comma
    // list; italics = weight+1 (401 = 400 italic). Serif display faces get an
    // italic (the emphasis device many references rely on); sans don't.
    const slug = (n) => n.toLowerCase().replace(/\s+/g, '-');
    const SERIF_HEADINGS = new Set(['sentient', 'erode', 'zodiak', 'boska', 'gambetta']);
    const headingWeights = SERIF_HEADINGS.has(slug(heading)) ? '400,401,500,700' : '400,500,700';
    const fams = heading === body
      ? [`f[]=${slug(heading)}@${headingWeights}`]
      : [`f[]=${slug(heading)}@${headingWeights}`, `f[]=${slug(body)}@400,500,700`];
    return {
      url: `https://api.fontshare.com/v2/css?${fams.join('&')}&display=swap`,
      preconnect: `<link rel="preconnect" href="https://api.fontshare.com" />\n    <link rel="preconnect" href="https://cdn.fontshare.com" crossorigin />`,
    };
  }
  return {
    url: buildGoogleFontsUrl(heading, body),
    preconnect: `<link rel="preconnect" href="https://fonts.googleapis.com" />\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
  };
}

function buildGoogleFontsUrl(heading, body) {

  // Map font names → Google Fonts API param strings
  const fontParams = {
    'Playfair Display':     'Playfair+Display:wght@600;700',
    'Cormorant Garamond':   'Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400',
    'Libre Baskerville':    'Libre+Baskerville:ital,wght@0,400;0,700;1,400',
    'Lora':                 'Lora:ital,wght@0,400;0,600;0,700;1,400',
    'Merriweather':         'Merriweather:ital,wght@0,300;0,400;0,700;1,300',
    'EB Garamond':          'EB+Garamond:ital,wght@0,400;0,600;0,700;1,400',
    'DM Serif Display':     'DM+Serif+Display:ital,wght@0,400;1,400',
    'Fraunces':             'Fraunces:opsz,wght@9..144,300;9..144,600;9..144,700',
    'Spectral':             'Spectral:ital,wght@0,400;0,600;0,700;1,400',
    'Bitter':               'Bitter:ital,wght@0,400;0,600;0,700;1,400',
    'Abril Fatface':        'Abril+Fatface:wght@400',
    'Bebas Neue':           'Bebas+Neue:wght@400',
    'Raleway':              'Raleway:ital,wght@0,400;0,600;0,700;1,400',
    'Josefin Sans':         'Josefin+Sans:ital,wght@0,300;0,400;0,600;1,300',
    'Syne':                 'Syne:wght@400;600;700;800',
    'DM Sans':              'DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400',
    'Inter':                'Inter:wght@400;500;600;700',
    'Outfit':               'Outfit:wght@300;400;500;600;700',
    'Plus Jakarta Sans':    'Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400',
    'Nunito':               'Nunito:ital,wght@0,400;0,600;0,700;1,400',
    'Nunito Sans':          'Nunito+Sans:ital,wght@0,400;0,600;0,700;1,400',
    'Lato':                 'Lato:ital,wght@0,400;0,700;1,400',
    'Source Sans 3':        'Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400',
    'Work Sans':            'Work+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400',
    'Karla':                'Karla:ital,wght@0,400;0,500;0,600;0,700;1,400',
    'Manrope':              'Manrope:wght@400;500;600;700',
    'Figtree':              'Figtree:ital,wght@0,400;0,500;0,600;0,700;1,400',
  };

  const headingParam = fontParams[heading] || `${heading.replace(/ /g, '+')}:wght@400;600;700`;
  const bodyParam    = fontParams[body]    || `${body.replace(/ /g, '+')}:wght@400;500;600;700`;

  // Avoid duplicating if heading and body are the same family
  const params = heading === body
    ? headingParam
    : `${headingParam}&family=${bodyParam}`;

  return `https://fonts.googleapis.com/css2?family=${params}&display=swap`;
}

// ---------------------------------------------------------------------------
// Design DNA — written by the Creative Director phase
// ---------------------------------------------------------------------------

/**
 * Write src/config/design-dna.ts in the output project so the homepage
 * consumes the DNA at build time.
 */
export async function writeDesignDna(dna, outputDir) {
  // Override chrome variants with deterministic values from designTokens.
  // The AI director picks these freely — we replace them post-hoc so two sites
  // with different archetypes always get different nav/footer/gallery.
  const tokens = dna.designTokens || {};
  const dnaWithOverrides = {
    ...dna,
    navVariant:     tokens.navVariant     || dna.navVariant     || 'left-logo',
    footerVariant:  tokens.footerVariant  || dna.footerVariant  || 'editorial-split',
    galleryVariant: tokens.galleryVariant || dna.galleryVariant || 'masonry-3col',
  };

  const dnaJson = JSON.stringify(dnaWithOverrides, null, 2);
  const body = `/**
 * Design DNA — generated by Creative Director phase.
 * Do not hand-edit; overwrite by re-running the pipeline.
 */

export interface DesignTokens {
  cornerRadius:       'sharp' | 'moderate' | 'rounded' | 'full';
  buttonTreatment:    'filled' | 'outline' | 'soft-fill';
  labelStyle:         'inline' | 'badge';
  sectionSpacing:     'compact' | 'default' | 'airy';
  contentDensity:     'tight' | 'default' | 'loose';
  layoutWidth:        'narrow' | 'standard' | 'full';
  // 5 hero variants
  heroLayout:         'centered' | 'split' | 'split-offset' | 'poster' | 'text-only';
  // 5 services variants
  servicesLayout:     'card-grid' | 'alternating-rows' | 'accordion' | 'two-col-feature' | 'numbered-list';
  // 5 doctor-intro variants
  aboutLayout:        'split-photo' | 'full-width-card' | 'editorial-full' | 'minimal-text' | 'two-col-brief';
  // 5 reviews variants
  testimonialsLayout: 'card-row' | 'pull-quotes' | 'single-featured' | 'list-testimonials' | 'grid-mosaic';
  // 5 CTA variants
  ctaLayout:          'centered-banner' | 'split-image' | 'inline-minimal' | 'floating-card' | 'two-button';
  // 5 FAQ variants
  faqLayout:          'accordion-expandable' | 'two-column' | 'simple-stack' | 'cards-grid' | 'split-by-category';
  // 5 nav variants — deterministic per archetype
  navVariant:         'centered-logo' | 'left-logo' | 'split-logo' | 'transparent-overlay' | 'top-bar';
  // 5 footer variants
  footerVariant:      'minimal-dark' | 'editorial-split' | 'classic-4col' | 'compact-centered' | 'bold-cta-footer';
  // 5 gallery variants
  galleryVariant:     'masonry-3col' | 'editorial-2col' | 'filmstrip' | 'featured-grid' | 'full-bleed-row';
  // Visual personality signals
  typePersonality:    'grotesque' | 'display-serif' | 'humanist-serif' | 'geometric-sans';
  colorFamily:        'warm' | 'cool' | 'neutral';
}

export interface DesignDNA {
  archetype: string;
  heroVariant: 'centered' | 'asymmetric-left' | 'asymmetric-right' | 'split-image' | 'full-bleed' | 'poster';
  servicesVariant: 'cards-3up' | 'editorial-list' | 'accordion';
  navVariant: 'centered-logo' | 'left-logo' | 'split-logo' | 'transparent-overlay' | 'top-bar';
  footerVariant: 'minimal-dark' | 'editorial-split' | 'classic-4col' | 'compact-centered' | 'bold-cta-footer';
  galleryVariant: 'masonry-3col' | 'editorial-2col' | 'filmstrip' | 'featured-grid' | 'full-bleed-row';
  sectionOrder: string[];
  cardTreatment: 'bordered-flat' | 'soft-shadow' | 'elevated' | 'ghost';
  density: 'airy' | 'balanced' | 'dense';
  motion: 'none' | 'subtle' | 'expressive';
  radius: 'sharp' | 'sm' | 'md' | 'lg' | 'pill';
  borrowedFrom?: string | null;
  borrowedTrait?: string | null;
  divergenceRationale?: string;
  creativeDirection?: string;
  // typeui-style design system fields — populated by Creative Director
  typographyScale?: string;
  colorPalette?: string;
  spacingScale?: string;
  writingTone?: string;
  brandSummary?: string;
  doRules?: string[];
  dontRules?: string[];
  designTokens?: DesignTokens;
}

export const designDNA: DesignDNA = ${dnaJson};

export interface ImageRoles {
  hero: string | null;
  doctorPortrait: string | null;
  team: string[];
  interior: string[];
  gallery: string[];
  beforeAfter: string[];
  alts?: Record<string, string>;
}

export function imagePath(role: string | null | undefined): string | null {
  if (!role) return null;
  return \`/images/\${role.replace(/^\\/+/, '')}\`;
}

/** Resolve alt text for a local image-roles path; falls back to \`fallback\`. */
export function imageAlt(
  roles: ImageRoles | null | undefined,
  localPath: string | null | undefined,
  fallback = '',
): string {
  if (!localPath) return fallback;
  const key = localPath.replace(/^\\/+/, '').replace(/^images\\//, '');
  const fromMap = roles?.alts?.[key] || roles?.alts?.[localPath];
  return (fromMap && String(fromMap).trim()) || fallback;
}
`;
  await writeFile(join(outputDir, 'src', 'config', 'design-dna.ts'), body);
}

// Exported for tests — nav mapping correctness is not observable otherwise.
export { buildLedgerRouteMap as __buildLedgerRouteMap };
