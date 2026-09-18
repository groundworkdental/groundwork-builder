/**
 * content-coverage.js — bronze-vs-final content coverage audit.
 *
 * Companion to coverage-audit.js. Where coverage-audit.js catches WEAK signals
 * (e.g. service page captured only 31% of source body text), THIS module
 * catches HARD CATEGORY LOSSES — when whole types of content disappear
 * between the raw scrape and the rebuilt site:
 *
 *   - Team / staff pages vanish entirely
 *   - Multi-doctor practices collapse to one
 *   - Top-level nav shrinks from 10 items to 4
 *   - Informational pages ("Office Tour", "Patient Forms") never get rebuilt
 *   - Doctor portrait photos paired with the wrong person
 *
 * Read-only. No AI calls. Deterministic regex + JSON parsing only.
 * Should run in well under 5s.
 *
 * Inputs:
 *   - clients/<slug>/_pipeline/01-bronze.json     (raw scrape ground-truth)
 *   - clients/<slug>/src/config/site.ts           (final rebuilt site config)
 *   - clients/<slug>/src/config/navigation.ts     (final nav structure)
 *   - clients/<slug>/_pipeline/09-image-roles.json (image role assignments)
 *   - clients/<slug>/public/images/team/          (downloaded team photos)
 *   - clients/<slug>/src/pages/                   (final rendered pages)
 *
 * Outputs:
 *   - _pipeline/content-coverage.md   (human report)
 *   - return { findings: [], summary: { critical, warning, note } }
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const SEVERITY = { CRITICAL: 'CRITICAL', WARNING: 'WARNING', NOTE: 'NOTE' };

// Path tokens that identify "structural" pages (homepage, services, team,
// about, contact) — anything NOT matching these is treated as an
// "informational page" (the kind that gets silently dropped).
const STRUCTURAL_PATH_PATTERNS = [
  /^\/$/,
  /^\/index(\.\w+)?$/,
  /^\/home(\.\w+)?$/,
  /^\/about/,
  /^\/contact/,
  /^\/services?(\/|$)/,
  /^\/dental-services/,    // common service hub names
  /^\/meet-(dr|our|the)-/, // doctor / team pages
  /^\/dr-/,                // /dr-anthony-hoang etc.
  /^\/doctor-/,
  /^\/before-after/,       // captured separately via gallery
  /^\/reviews?/,           // typically surfaced inline
  /^\/(special-)?offers?/, // promos
  /^\/team/,
  /^\/our-team/,
  /^\/staff/,
  /^\/our-doctors?/,
  /^\/meet-the-(doctor|team)/,
  /^\/blog/,
  /^\/faq/,
  /^\/appointment/,        // scheduling pages
  /^\/request-an-appointment/,
  /^\/new-patients?/,
  /^\/locations?/,
  /^\/disclaimers?\//,
  /^\/(privacy|terms|sitemap|accessibility|website-accessibility)/,
  /^\/form-/,              // downloadable forms
  /^\/page\//,             // pagination
  /\/page\/\d+\/?$/,
];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.outputDir          - root of the rebuilt project (clients/<slug>)
 * @param {string} [opts.bronzePath]       - override path to bronze JSON
 * @param {string} [opts.finalConfigPath]  - override path to site.ts
 * @returns {Promise<{ findings: Array, summary: object, markdown: string }>}
 */
export async function runContentCoverage({
  slug,
  outputDir,
  bronzePath,
  finalConfigPath,
} = {}) {
  if (!outputDir) throw new Error('runContentCoverage: outputDir is required');

  const bronzeFile     = bronzePath      || resolve(outputDir, '_pipeline/01-bronze.json');
  const siteFile       = finalConfigPath || resolve(outputDir, 'src/config/site.ts');
  const navFile        = resolve(outputDir, 'src/config/navigation.ts');
  const imageRolesFile = resolve(outputDir, '_pipeline/09-image-roles.json');
  const redirectsFile  = resolve(outputDir, 'public/_redirects');
  const silverFile     = resolve(outputDir, '_pipeline/01-scrape.json');
  const teamPhotoDir   = resolve(outputDir, 'public/images/team');
  const finalPagesDir  = resolve(outputDir, 'src/pages');

  // Artifacts are written wrapped as { step, timestamp, output } but older runs
  // (and direct callers) pass the raw bronze object. Every check below reads
  // `bronze.pages`, so reading the wrapper handed them an empty page list and
  // silently disabled the whole bronze-vs-final diff.
  const bronzeRaw  = await tryReadJson(bronzeFile);
  const bronze     = bronzeRaw?.output ?? bronzeRaw;
  // Silver is the authority on who counts as staff — the check compares its
  // output to the built site rather than guessing from image filenames.
  const silverRaw  = await tryReadJson(silverFile);
  const silver     = silverRaw?.output ?? silverRaw;
  const siteTs     = await tryReadText(siteFile);
  const navTs      = await tryReadText(navFile);
  const imageRoles = (await tryReadJson(imageRolesFile))?.output || null;
  const redirectsTxt = await tryReadText(redirectsFile);
  const teamPhotos = await tryReadDir(teamPhotoDir);
  const finalPages = await tryReadDir(finalPagesDir);

  const findings = [];

  // Each checker is wrapped in try/catch so one failure doesn't tank the rest
  await safe(() => checkDoctors(findings,           { bronze, siteTs }));
  await safe(() => checkStaff(findings,             { bronze, siteTs, silver }));
  await safe(() => checkNavigation(findings,        { bronze, navTs }));
  await safe(() => checkInformationalPages(findings,{ bronze, finalPages }));
  await safe(() => checkServicePages(findings,      { bronze, siteTs, finalPages, outputDir }));
  await safe(() => checkRedirectsToRoot(findings,   { bronze, redirectsTxt }));
  await safe(() => checkDoctorPortraits(findings,   { siteTs, imageRoles, teamPhotos }));
  await safe(() => checkPhone(findings,             { bronze, siteTs }));
  await safe(() => checkAddress(findings,           { bronze, siteTs }));

  const summary = {
    total:    findings.length,
    critical: findings.filter(f => f.severity === SEVERITY.CRITICAL).length,
    warning:  findings.filter(f => f.severity === SEVERITY.WARNING).length,
    note:     findings.filter(f => f.severity === SEVERITY.NOTE).length,
  };

  const markdown = renderMarkdown(findings, summary, { slug, bronze });

  // Write the report to disk best-effort
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resolve(outputDir, '_pipeline/content-coverage.md'), markdown);
  } catch {
    // non-fatal — caller may also persist it
  }

  return { findings, summary, markdown };
}

// ---------------------------------------------------------------------------
// Parsing helpers — extract structured data from the final site.ts
// ---------------------------------------------------------------------------

/**
 * Pull doctors out of site.ts. Handles both shapes:
 *   - new:    export const doctors = [ {...}, {...} ]
 *   - legacy: export const doctor = {...}; export const additionalDoctors = [...]
 *
 * Returns: [{ name, firstName, lastName, nameNoTitle, bio, photoPath, ... }]
 */
function parseDoctorsFromSiteTs(siteTs) {
  if (!siteTs) return [];

  // First try unified `doctors` if it's a real array literal (not derived).
  const unified = extractArrayLiteral(siteTs, 'doctors');
  // unified is often `[doctor, ...additionalDoctors]` — skip that and use legacy shape below.
  if (unified && unified.length > 0 && typeof unified[0] === 'object') {
    return unified;
  }

  const primary = extractObjectLiteral(siteTs, 'doctor');
  const additional = extractArrayLiteral(siteTs, 'additionalDoctors') || [];
  return [primary, ...additional].filter(Boolean);
}

/**
 * Extract the contents of `export const NAME = { ... }` (one level deep).
 * Returns a shallow object with string/number fields. Best-effort, regex-based.
 */
function extractObjectLiteral(text, name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{`);
  const m = text.match(re);
  if (!m) return null;
  const start = m.index + m[0].length - 1;  // index of '{'
  const block = extractBalanced(text, start, '{', '}');
  if (!block) return null;
  return parseShallowObjectFields(block);
}

/**
 * Extract `export const NAME = [ {...}, {...} ]` as an array of shallow objects.
 */
function extractArrayLiteral(text, name) {
  const re = new RegExp(`export\\s+const\\s+${name}(?:\\s*:[^=]+)?\\s*=\\s*\\[`);
  const m = text.match(re);
  if (!m) return null;
  const start = m.index + m[0].length - 1;  // index of '['
  const block = extractBalanced(text, start, '[', ']');
  if (!block) return null;

  // If the array contains spreads or top-level identifiers (e.g.
  // `[doctor, ...additionalDoctors]`), bail out — caller falls back to legacy.
  // Only check the first non-whitespace char.
  const trimmed = block.replace(/^\s+/, '');
  if (trimmed.startsWith('...') || /^[A-Za-z_]/.test(trimmed)) return null;

  // Split into top-level `{ ... }` objects. Walk and extract each balanced one.
  const items = [];
  let i = 0;
  while (i < block.length) {
    const ch = block[i];
    if (ch === '{') {
      const inner = extractBalanced(block, i, '{', '}');
      if (inner == null) break;
      items.push(parseShallowObjectFields(inner));
      i += inner.length + 2;  // +2 for the '{' and '}'
    } else {
      i++;
    }
  }
  return items;
}

/**
 * Given a text and an index of the opening bracket, return everything between
 * the matching open and close brackets (excluding the brackets themselves).
 * Handles string literals so braces inside strings don't fool the depth counter.
 */
function extractBalanced(text, openIdx, openCh, closeCh) {
  if (text[openIdx] !== openCh) return null;
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Parse the BODY of a one-level object literal (no nested objects) into
 * { key: value } pairs. Handles string values and array literals of strings.
 * Used for shallow extraction — good enough for our purposes.
 */
function parseShallowObjectFields(body) {
  const out = {};
  // Match `key: "value"` or `key: 'value'` or `key: [...]` or `key: null`
  const re = /(?:^|,|\n)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:\s*(?:(['"`])((?:\\.|(?!\2).)*)\2|(\[(?:[^\[\]]|\[[^\[\]]*\])*\])|(true|false|null)|([0-9]+(?:\.[0-9]+)?))/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const [, key, , strVal, arrVal, literal, numVal] = m;
    if (strVal !== undefined) {
      out[key] = strVal.replace(/\\(.)/g, '$1');
    } else if (arrVal !== undefined) {
      // Parse simple `["a", "b"]` arrays of strings
      const items = [];
      const strRe = /(['"`])((?:\\.|(?!\1).)*)\1/g;
      let s;
      while ((s = strRe.exec(arrVal)) !== null) items.push(s[2]);
      out[key] = items;
    } else if (literal !== undefined) {
      out[key] = literal === 'true' ? true : literal === 'false' ? false : null;
    } else if (numVal !== undefined) {
      out[key] = Number(numVal);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checkers — each pushes findings[]
// ---------------------------------------------------------------------------

/**
 * Multi-doctor handling + first/last name sanity.
 * Bronze ground-truth: top-level pages named `/meet-dr-<name>` are a strong
 * signal of a separate doctor.
 */
function checkDoctors(findings, { bronze, siteTs }) {
  if (!bronze || !siteTs) return;

  // Bronze: pages whose path matches /meet-dr-<name> are independent doctors.
  const bronzeDoctorSlugs = new Set();
  for (const p of bronze.pages || []) {
    const m = (p.path || '').match(/^\/meet-(?:dr|doctor)-([^./]+)/i);
    if (m) bronzeDoctorSlugs.add(m[1].toLowerCase());
  }

  // Also accept names mentioned consistently in nav items like "Meet Dr. X"
  for (const n of bronze.siteAssets?.navigation || []) {
    const m = (n.text || '').match(/Meet\s+Dr\.?\s+([A-Z][a-z]+)/);
    if (m) bronzeDoctorSlugs.add(m[1].toLowerCase());
  }

  const finalDoctors = parseDoctorsFromSiteTs(siteTs);

  // Name-quality check: each doctor should have BOTH firstName AND lastName.
  // A common failure mode: the surname is stored as firstName and lastName is empty.
  const nameProblems = [];
  for (const d of finalDoctors) {
    if (!d) continue;
    const fn = (d.firstName || '').trim();
    const ln = (d.lastName  || '').trim();
    if (!fn || !ln) {
      nameProblems.push({
        name: d.name,
        firstName: fn || null,
        lastName: ln || null,
        reason: !fn ? 'missing firstName' : 'missing lastName (likely surname stored as firstName)',
      });
    }
  }

  // Count comparison: bronze had N "meet-dr" pages, final has M doctors.
  if (bronzeDoctorSlugs.size > 0 && bronzeDoctorSlugs.size > finalDoctors.length) {
    findings.push({
      severity: SEVERITY.CRITICAL,
      category: 'doctors',
      check: 'doctor-count',
      message: `Doctors: bronze had ${bronzeDoctorSlugs.size}, final has ${finalDoctors.length} (LOSS)`,
      detail: {
        bronzeDoctorSlugs: [...bronzeDoctorSlugs],
        finalDoctorNames: finalDoctors.map(d => d.name),
      },
      hint: 'ai-silver.js may have truncated about-page bodyText before reaching their bios. Check that doctors[] (or doctor + additionalDoctors[]) is fully populated.',
    });
  } else if (bronzeDoctorSlugs.size > 0 && finalDoctors.length > 0) {
    // Same count but missing names check
    if (nameProblems.length > 0) {
      findings.push({
        severity: SEVERITY.WARNING,
        category: 'doctors',
        check: 'doctor-naming',
        message: `Doctors: ${finalDoctors.length} present but naming inconsistent — ${nameProblems.length} missing first or last name`,
        detail: { problems: nameProblems },
        hint: 'Doctor extraction likely captured the surname-only "Dr. Cortez" label without resolving full name. Source likely has "Dr. <First> <Last>" elsewhere — re-parse bios for full name.',
      });
    }
  } else if (nameProblems.length > 0) {
    findings.push({
      severity: SEVERITY.WARNING,
      category: 'doctors',
      check: 'doctor-naming',
      message: `Doctors: ${nameProblems.length} of ${finalDoctors.length} have missing first or last name`,
      detail: { problems: nameProblems },
      hint: 'Final doctor records should have both firstName AND lastName populated.',
    });
  }
}

/**
 * Staff / team members (non-doctor clinicians and support staff).
 * Bronze ground-truth: existence of /meet-our-team page + `team/team-*.jpg` photos.
 */
function checkStaff(findings, { bronze, siteTs, silver }) {
  // Compare structured data to structured data.
  //
  // This used to count files: any `team-N-*.jpg` in public/images/team not
  // matching `-dr-` was treated as a staff member. On the reference site that
  // matched `team-1-index-services-1a.jpg` and `team-2-index-services-2a.jpg`
  // — two decorative images from the homepage services strip — and reported
  // "2 team members lost" for a practice whose site names no staff at all. The
  // count moved between runs (8, 7, 4, 2) purely with what the image downloader
  // happened to grab, because it was never measuring people.
  //
  // Silver decides who is staff (providers pass, `staff[]`). This only checks
  // whether what silver found survived into the built site.
  const extracted = Array.isArray(silver?.staff) ? silver.staff.filter(s => s?.name) : [];

  let rendered = 0;
  if (siteTs) {
    const arr = extractArrayLiteral(siteTs, 'staff');
    if (Array.isArray(arr)) rendered = arr.length;
  }

  if (extracted.length > 0 && rendered === 0) {
    findings.push({
      severity: SEVERITY.CRITICAL,
      category: 'staff',
      check: 'staff-loss',
      message: `Staff: silver extracted ${extracted.length} team member(s), final site has 0 (LOSS)`,
      detail: { extracted: extracted.map(s => s.name).slice(0, 20) },
      hint: 'silver.staff[] was populated but did not reach site.ts. Check injectSiteConfig and the merger.',
    });
    return;
  }

  // Silver found nobody, but the source site has a team page — either the
  // practice genuinely names no staff (common, and fine) or extraction missed
  // them. A warning, not a loss: there is no evidence anything was dropped.
  const hasTeamPage = (bronze?.pages || []).some(p =>
    /^\/(meet-(our|the|your)-team|our-team|team|staff)/i.test(p.path || '')
  );
  if (extracted.length === 0 && rendered === 0 && hasTeamPage) {
    findings.push({
      severity: SEVERITY.WARNING,
      category: 'staff',
      check: 'team-page-no-staff',
      message: 'Source site has a team page but silver extracted 0 staff member(s)',
      detail: { hasTeamPage },
      hint: 'Either the practice names only doctors (no action needed) or the providers pass missed non-doctor staff.',
    });
  }
}

/**
 * Top-level navigation breadth.
 * Bronze ground-truth: bronze.siteAssets.navigation entries (deduped by href).
 * Final ground-truth: navLinks array in navigation.ts.
 */
function checkNavigation(findings, { bronze, navTs }) {
  if (!bronze) return;

  // Bronze: dedupe by href, drop empty/anchor-only and known boilerplate
  const bronzeNav = bronze.siteAssets?.navigation || [];
  const bronzeTop = new Set();
  for (const n of bronzeNav) {
    const href = (n.href || '').trim();
    if (!href || href === '#' || href.startsWith('#')) continue;
    if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    // Skip pure homepage links
    if (/^\/(index\.\w+)?$/.test(href)) continue;
    bronzeTop.add(href);
  }

  // Final: count `{ label:` entries at the top level of navLinks
  let finalCount = 0;
  let finalLabels = [];
  if (navTs) {
    const arr = extractArrayLiteral(navTs, 'navLinks');
    if (Array.isArray(arr)) {
      finalCount = arr.length;
      finalLabels = arr.map(e => e.label).filter(Boolean);
    }
  }

  if (bronzeTop.size === 0) return;

  // Flag if final has <80% of bronze count
  if (finalCount > 0 && finalCount / bronzeTop.size < 0.8) {
    const dropped = bronzeTop.size - finalCount;
    findings.push({
      severity: SEVERITY.CRITICAL,
      category: 'navigation',
      check: 'nav-loss',
      message: `Navigation: bronze had ${bronzeTop.size} top-level items, final has ${finalCount} (LOSS — ${dropped} dropped)`,
      detail: {
        bronzeNavHrefs: [...bronzeTop].slice(0, 20),
        finalNavLabels: finalLabels,
      },
      hint: 'injectNavigation() in injector.js (and the navigation.ts template) hardcodes a small set of links. Top-level practice categories like "New Patients", "Pediatric Dentistry", "Orthodontics" get lost.',
    });
  }
}

/**
 * Informational pages — anything in bronze that isn't a homepage/service/team/about/contact/blog/form page.
 * Examples: "What Sets Us Apart", "Office Tour", "Patient Forms", "Patient Testimonials".
 */
/**
 * A 301 to the bare homepage is the redirect map conceding it had nowhere to
 * put a page. For a page that carried real content that is silent loss: the URL
 * keeps resolving, so nothing 404s and no other check fires.
 *
 * Homepage aliases and soft-dups genuinely belong at `/` — those pages either
 * ARE the homepage or served its content — so only pages bronze saw with
 * substantive unique copy count as losses.
 */
const HOMEPAGE_ALIAS = /^\/(?:index|home|default|main)(?:\.(?:html?|php|aspx?))?\/?$/i;
const REDIRECT_LOSS_MIN_WORDS = 150;

function checkRedirectsToRoot(findings, { bronze, redirectsTxt }) {
  if (!redirectsTxt || !bronze) return;

  const softDupPaths = new Set(
    (bronze.coverage?.softDups || bronze.softDups || []).map(d => (d.path || '').toLowerCase())
  );
  const wordsByPath = new Map(
    (bronze.pages || []).map(p => [(p.path || '').toLowerCase(), p.wordCount || 0])
  );

  const losses = [];
  for (const line of redirectsTxt.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [from, to] = parts;
    if (to !== '/') continue;

    const key = from.toLowerCase();
    if (HOMEPAGE_ALIAS.test(key)) continue;   // alias of the homepage itself
    if (softDupPaths.has(key)) continue;      // served homepage content already

    const words = wordsByPath.get(key) ?? wordsByPath.get(key.replace(/\/$/, '')) ?? 0;
    if (words >= REDIRECT_LOSS_MIN_WORDS) losses.push({ path: from, wordCount: words });
  }

  if (losses.length === 0) return;

  losses.sort((a, b) => b.wordCount - a.wordCount);
  const totalWords = losses.reduce((sum, l) => sum + l.wordCount, 0);

  findings.push({
    severity: SEVERITY.CRITICAL,
    category: 'redirects',
    check: 'redirect-to-root-loss',
    message: `${losses.length} page(s) with real content 301 to the homepage — ${totalWords.toLocaleString()} words unmapped (LOSS)`,
    detail: { losses: losses.slice(0, 20) },
    hint: 'A redirect to bare / means the rebuild had no destination for this page. Give it a page, merge its content into a related one and redirect there, or drop it deliberately — but do not point real content at the homepage.',
  });
}

function checkInformationalPages(findings, { bronze, finalPages }) {
  if (!bronze) return;

  const isStructural = (path) => {
    if (!path) return true;
    return STRUCTURAL_PATH_PATTERNS.some(re => re.test(path));
  };

  // Services live in bronze under various URL shapes — exclude them too
  const isServiceLike = (path) => /^\/services?\//.test(path);

  const bronzeInfoPages = [];
  for (const p of bronze.pages || []) {
    const path = p.path || '';
    if (isStructural(path) || isServiceLike(path)) continue;
    // Reject paths that are just blog posts
    if (/^\/blog/.test(path)) continue;
    // Reject pages that look like service-content pages even though they live at root.
    // We'll lean conservative: count anything not matching structural patterns.
    bronzeInfoPages.push(path);
  }

  if (bronzeInfoPages.length === 0) return;

  // Count "informational" pages in src/pages/ — anything outside known structural files
  const STRUCTURAL_PAGE_FILES = new Set([
    'index.astro', 'about.astro', 'services.astro', 'faq.astro',
    'schedule.astro', 'gallery.astro', 'financing.astro',
    'thank-you.astro', 'contact.astro',
  ]);
  const STRUCTURAL_PAGE_DIRS = new Set([
    'services', 'team', 'blog', 'locations', 'disclaimers',
  ]);

  const finalInfoPages = (finalPages || []).filter(f => {
    if (STRUCTURAL_PAGE_FILES.has(f)) return false;
    if (STRUCTURAL_PAGE_DIRS.has(f)) return false;
    if (f.startsWith('_') || f.startsWith('.')) return false;
    return true;
  });

  if (finalInfoPages.length === 0 && bronzeInfoPages.length >= 3) {
    findings.push({
      severity: SEVERITY.CRITICAL,
      category: 'informational-pages',
      check: 'info-pages-loss',
      message: `Informational pages: bronze had ${bronzeInfoPages.length}, final has 0 (LOSS)`,
      detail: {
        bronzeInfoPages: bronzeInfoPages.slice(0, 20),
      },
      hint: 'The pipeline rebuilds a fixed set of pages (about, services, faq, etc.) and silently drops everything else. Pages like "What Sets Us Apart", "Office Tour", "Patient Forms", "Patient Testimonials" never get regenerated.',
    });
  } else if (finalInfoPages.length < bronzeInfoPages.length * 0.4) {
    findings.push({
      severity: SEVERITY.WARNING,
      category: 'informational-pages',
      check: 'info-pages-thin',
      message: `Informational pages: bronze had ${bronzeInfoPages.length}, final has ${finalInfoPages.length}`,
      detail: {
        bronzeInfoPages: bronzeInfoPages.slice(0, 20),
        finalInfoPages,
      },
    });
  }
}

/**
 * Service-page count sanity. Most service-page coverage is handled by
 * coverage-audit.js; this is just a coarse total.
 */
function checkServicePages(findings, { bronze, siteTs, finalPages, outputDir }) {
  if (!bronze) return;

  const bronzeServiceUrls = new Set();
  for (const p of bronze.pages || []) {
    const m = (p.path || '').match(/^\/services?\/([^/]+)\/?$/);
    if (m) bronzeServiceUrls.add(m[1]);
  }

  // Heuristic: many practices don't put services under /services/ — count by service-like URL slugs
  // that didn't match the structural list and are plausibly services.
  // For now we just compare under /services/.

  // Final services pages: count .astro files in src/pages/services/ if present
  // (we already have `finalPages` for the top of src/pages; need a separate read for /services subdir)
  // For simplicity, parse services array from site.ts.
  // The shape varies — try several common names.

  // Count anything looking like a service under src/pages/services/
  let finalServiceCount = 0;
  try {
    // Synchronous-ish read via top-level finalPages won't work; we listed only src/pages
    // We'll instead read services dir directly via the outputDir.
  } catch {}

  // OK signal only — no finding unless bronze had services and final has none.
  if (bronzeServiceUrls.size === 0) return;

  // Quick check via finalPages: was services/ directory present at all?
  const hasServicesDir = (finalPages || []).includes('services') || (finalPages || []).includes('services.astro');
  if (!hasServicesDir) {
    findings.push({
      severity: SEVERITY.WARNING,
      category: 'service-pages',
      check: 'services-dir-missing',
      message: `Bronze had ${bronzeServiceUrls.size} service page(s) but final has no /services/ directory`,
      detail: { bronzeServices: [...bronzeServiceUrls].slice(0, 20) },
    });
  }
}

/**
 * Doctor portrait pairing: was a `team-*-firstname.jpg` filename promoted to
 * doctorPortrait even though the firstname doesn't match any doctor?
 */
function checkDoctorPortraits(findings, { siteTs, imageRoles, teamPhotos }) {
  if (!imageRoles) return;

  const doctors = parseDoctorsFromSiteTs(siteTs);
  if (doctors.length === 0) return;

  const expectedCount = doctors.length;
  const matchedCount = Object.keys(imageRoles.doctorPortraits || {}).length
                    + (imageRoles.doctorPortrait ? 1 : 0);

  // Build a list of distinctive name tokens from final doctors (firstNames + lastNames, lowercased)
  const doctorTokens = new Set();
  for (const d of doctors) {
    for (const t of [d.firstName, d.lastName, d.nameNoTitle]) {
      if (!t) continue;
      const cleaned = String(t).toLowerCase().split(/\s+/).filter(Boolean);
      for (const c of cleaned) if (c.length >= 3) doctorTokens.add(c);
    }
    // Also tokenize `name` (strip "Dr.")
    const stripped = (d.name || '').replace(/^dr\.?\s+/i, '').toLowerCase();
    for (const c of stripped.split(/\s+/)) if (c.length >= 3) doctorTokens.add(c);
  }

  // Check doctorPortrait filename — does the embedded name match any doctor token?
  const portrait = imageRoles.doctorPortrait;
  if (portrait) {
    const file = basename(portrait).toLowerCase();
    // Pull tokens from the filename
    const fileTokens = file.replace(/\.[^.]+$/, '').split(/[-_.\s]+/).filter(t => t.length >= 3 && !/^\d+$/.test(t));
    // Skip generic tokens
    const genericTokens = new Set(['team', 'img', 'dr', 'jpg', 'png', 'photo']);
    const nameTokens = fileTokens.filter(t => !genericTokens.has(t));

    if (nameTokens.length > 0) {
      const anyMatch = nameTokens.some(t => doctorTokens.has(t));
      if (!anyMatch) {
        findings.push({
          severity: SEVERITY.WARNING,
          category: 'doctor-portraits',
          check: 'doctor-portrait-mismatch',
          message: `Doctor portrait "${portrait}" filename tokens [${nameTokens.join(', ')}] do not match any doctor name (${[...doctorTokens].slice(0, 8).join(', ')})`,
          detail: {
            portrait,
            fileNameTokens: nameTokens,
            doctorTokens: [...doctorTokens],
          },
          hint: 'bindImages() may have promoted a hygienist/staff photo (e.g. team-1-michelle.jpg) to doctorPortrait because no actual doctor headshot/bio-page match was found. Prefer role=headshot + personName, or a dedicated bio page in sourcePages.',
        });
      }
    }
  }

  if (expectedCount > matchedCount) {
    findings.push({
      severity: SEVERITY.WARNING,
      category: 'doctor-portraits',
      check: 'doctor-portraits-incomplete',
      message: `Doctor portraits: ${expectedCount} expected, ${matchedCount} matched`,
      detail: {
        expectedCount,
        matchedCount,
        finalDoctors: doctors.map(d => d.name),
        doctorPortraits: imageRoles.doctorPortraits || {},
        doctorPortrait: imageRoles.doctorPortrait || null,
      },
      hint: 'Each doctor should have an entry in imageRoles.doctorPortraits. Missing entries mean their about page renders without a photo.',
    });
  }
}

/**
 * Sanity check: phone number matches.
 */
function checkPhone(findings, { bronze, siteTs }) {
  if (!siteTs || !bronze) return;
  const m = siteTs.match(/phone:\s*['"]([^'"]+)['"]/);
  const finalPhone = m?.[1];
  if (!finalPhone || /^\(?555/.test(finalPhone)) return;

  // Bronze: hunt for the most common phone string across page bodyText
  const counts = new Map();
  const phoneRe = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
  for (const p of bronze.pages || []) {
    const text = p.bodyText || '';
    for (const match of text.matchAll(phoneRe)) {
      const norm = match[0].replace(/\D/g, '');
      if (norm.length === 10) counts.set(norm, (counts.get(norm) || 0) + 1);
    }
  }
  if (counts.size === 0) return;
  const topPhone = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const finalNorm = finalPhone.replace(/\D/g, '');
  if (topPhone !== finalNorm) {
    findings.push({
      severity: SEVERITY.WARNING,
      category: 'contact',
      check: 'phone-mismatch',
      message: `Phone: bronze top phone "${topPhone}" doesn't match final "${finalPhone}"`,
      detail: { bronzeTopPhone: topPhone, finalPhone },
    });
  }
}

/**
 * Sanity check: address matches (street).
 */
function checkAddress(findings, { bronze, siteTs }) {
  if (!siteTs || !bronze) return;
  const m = siteTs.match(/street:\s*['"]([^'"]+)['"]/);
  const finalStreet = m?.[1];
  if (!finalStreet || /\[STREET/.test(finalStreet)) return;

  // Bronze: simple presence check — does ANY page bodyText contain the
  // first numeric+word token of the final street?
  const streetTokens = finalStreet.toLowerCase().split(/\s+/).slice(0, 2).join(' ');
  let found = false;
  for (const p of bronze.pages || []) {
    if ((p.bodyText || '').toLowerCase().includes(streetTokens)) {
      found = true;
      break;
    }
  }
  if (!found) {
    findings.push({
      severity: SEVERITY.NOTE,
      category: 'contact',
      check: 'address-not-in-bronze',
      message: `Address: final street "${finalStreet}" not found in any bronze page body`,
      detail: { finalStreet },
    });
  }
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function renderMarkdown(findings, summary, { slug, bronze }) {
  const lines = [];
  const practiceName = bronze?.pages?.[0]?.title || slug || 'unknown';

  lines.push(`# Content Coverage Audit — ${practiceName}`);
  lines.push('');
  lines.push(`**Slug:** ${slug || 'unknown'}`);
  lines.push(`**Run at:** ${new Date().toISOString()}`);
  lines.push(`**Summary:** ${summary.critical} critical · ${summary.warning} warning · ${summary.note} note`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (findings.length === 0) {
    lines.push('No content coverage gaps detected. ✓');
    return lines.join('\n');
  }

  const groups = [
    { sev: SEVERITY.CRITICAL, icon: '🔴', title: 'Critical losses' },
    { sev: SEVERITY.WARNING,  icon: '🟡', title: 'Warnings' },
    { sev: SEVERITY.NOTE,     icon: '🔵', title: 'Notes' },
  ];

  for (const { sev, icon, title } of groups) {
    const group = findings.filter(f => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${icon} ${title}`);
    lines.push('');
    for (const f of group) {
      lines.push(`### ${f.message}`);
      lines.push('');
      if (f.hint) {
        lines.push(`**Likely cause:** ${f.hint}`);
        lines.push('');
      }
      if (f.detail && Object.keys(f.detail).length > 0) {
        lines.push('<details><summary>Detail</summary>');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(f.detail, null, 2));
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

async function tryReadJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); }
  catch { return null; }
}
async function tryReadText(path) {
  try { return await readFile(path, 'utf-8'); }
  catch { return null; }
}
async function tryReadDir(path) {
  try { return await readdir(path); }
  catch { return null; }
}
async function safe(fn) {
  try { await fn(); } catch { /* swallow — degrade gracefully */ }
}
