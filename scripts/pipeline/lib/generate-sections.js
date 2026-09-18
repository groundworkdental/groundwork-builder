/**
 * generate-sections.js — Orchestrates AI generation of all section components.
 *
 * Atomic design pipeline:
 *   Stage 1 (ai-director)   → DNA tokens (archetype, radius, density, etc.)
 *   Stage 2 (ai-molecules)  → Molecule library (shared button/card/heading classes)
 *   Stage 3 (skill-generate)→ Individual section components, all using Stage 2 molecules
 *
 * The homepage dispatcher (`src/pages/index.astro`) statically imports every
 * section component from `src/components/generated/*` and renders them in
 * `designDNA.sectionOrder`. This generator simply overwrites those component
 * files with AI-produced content. Sections we can't (or don't) generate are
 * left as stubs that ship with the source template.
 */

import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { run as runGenerate } from '../skills/skill-generate.js';
import { buildMolecules } from './ai-molecules.js';

// Sections always generated
// FAQ moved to ALWAYS_GENERATE: the FAQ skill synthesizes content from
// services + practice data even when no FAQs were scraped, so it never
// has zero data to render.
const ALWAYS_GENERATE = ['nav', 'footer', 'cta', 'hero', 'faq'];

// Sections generated only when present in sectionOrder
const CONDITIONAL_GENERATE = ['services', 'doctor-intro', 'stat-bar', 'reviews'];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * @param {object} dna        - Design DNA
 * @param {object} practice   - { name, doctor, city, phone, address }
 * @param {object} merged     - Full merged practice data
 * @param {object} bronze     - Raw scrape data (for real navigation links)
 * @param {string} outputDir  - Absolute path to the output project directory
 * @returns {Promise<{ generated: string[], files: string[], errors: string[] }>}
 */
/**
 * Remove opacity from text colours in a generated component.
 *
 * Opacity on text is the one thing that can defeat every other colour guard.
 * The palette guard proves each token clears AA at full strength; compositing it
 * against its background at 30% or 70% throws that guarantee away, and the
 * result depends on a background the component cannot see. Measured cases:
 * `text-white/70` on brand-primary at 3.49:1, `text-neutral-mid/30` on white at
 * 1.48:1.
 *
 * Tuning to a "safe" opacity does not hold either — `/90` cleared 4.67:1 against
 * one generated primary and 4.45:1 against a slightly darker one the next run.
 * The palette changes per practice, so any fixed percentage is a coin flip.
 *
 * So: text goes solid. If a design genuinely wants subdued text, the answer is a
 * muted *token* that passes AA at full opacity — not a strong token dimmed.
 *
 * Only text utilities are touched. Borders, dividers, and decorative icons keep
 * their opacity; contrast requirements do not apply to them.
 */
function repairTextOpacity(content) {
  let fixes = 0;
  // Any text colour, not just white/black — `text-neutral-mid/30` slipped
  // through the narrower form and shipped 8 nodes at 1.48:1.
  const repaired = String(content || '').replace(
    /\btext-([a-z]+(?:-[a-z0-9]+)*)\/(\d{1,3})\b/g,
    (match, token, pct) => {
      if (Number(pct) >= 100) return match;
      fixes++;
      return `text-${token}`;
    }
  );
  return { content: repaired, fixes };
}

/**
 * Both colour repairs, applied to whichever markup a section generator emitted.
 * Sections are written through two paths (shim + legacy) and both carry the
 * same classes, so the repair has to sit on both or it silently covers half.
 */
function repairComponentColours(content) {
  const opacity = repairTextOpacity(content);
  const onDark  = repairPrimaryOnDark(opacity.content);
  const notes = [
    opacity.fixes && `raised ${opacity.fixes} low text-opacity value(s)`,
    onDark.fixes  && `re-pointed ${onDark.fixes} brand-primary text to brand-on-dark`,
  ].filter(Boolean).join(' and ');
  return { content: onDark.content, notes };
}

/**
 * Re-point brand-primary text to the on-dark variant inside dark components.
 *
 * Brand primary is corrected for AA against light surfaces, which necessarily
 * costs it contrast on dark ones — the generated footer put
 * `text-brand-primary` eyebrow labels on `bg-neutral-dark` at 2.35:1, on every
 * page of the site.
 *
 * An earlier attempt solved this with a CSS descendant selector and made things
 * worse: `.bg-neutral-dark .text-brand-primary` also matches white cards nested
 * inside a dark section, so the light variant landed on white. Scoping to a
 * whole component is coarse but sound — a component whose root surface is dark
 * has a dark background throughout, which is exactly the case that fails.
 * Components with any light surface are left alone.
 */
function repairPrimaryOnDark(content) {
  const src = String(content || '');
  const DARK = /\bbg-(?:neutral-dark|brand-secondary)\b/;
  const LIGHT = /\bbg-(?:white|surface-1|surface-2|brand-light|neutral-light)\b/;
  if (!DARK.test(src) || LIGHT.test(src)) return { content: src, fixes: 0 };

  let fixes = 0;
  const repaired = src.replace(/\b((?:hover:|focus:|group-hover:)?)text-brand-primary\b/g, (_m, variant) => {
    fixes++;
    return `${variant}text-brand-on-dark`;
  });
  return { content: repaired, fixes };
}

export async function generateSections(dna, practice, merged, bronze, outputDir) {
  const sectionOrder = dna.sectionOrder || [];

  // Stage 2: Build molecule library from locked DNA tokens
  // This is deterministic — no API call. All sections receive the same snippets.
  const molecules = buildMolecules(dna);

  // Assemble section content from merged + bronze data
  const content = buildSectionContent(merged, bronze);

  // Determine which sections to generate
  const toGenerate = [...ALWAYS_GENERATE];
  for (const section of CONDITIONAL_GENERATE) {
    if (toGenerate.includes(section) || !sectionOrder.includes(section)) continue;

    // Data guards — don't generate sections without data
    if (section === 'doctor-intro' && !practice.doctor) continue;
    if (section === 'stat-bar') {
      const stats = content.stats || {};
      const hasAnyStats = stats.yearsExperience || stats.happyPatients || stats.googleRating || stats.fiveStarReviews;
      if (!hasAnyStats) continue;
    }
    if (section === 'reviews' && (!content.reviews?.testimonials?.length)) continue;
    // FAQ no longer in CONDITIONAL_GENERATE — see ALWAYS_GENERATE comment

    toGenerate.push(section);
  }

  // Ensure generated/ directory exists
  const generatedDir = resolve(outputDir, 'src', 'components', 'generated');
  await mkdir(generatedDir, { recursive: true });

  // Stage 3: Run all section generations in parallel — each receives the same molecules
  const results = await Promise.allSettled(
    toGenerate.map(async (sectionType) => {
      const sectionContent = getSectionContent(sectionType, content);
      const result = await runGenerate({ dna, practice, sectionType, content: sectionContent, molecules });
      return { sectionType, result };
    })
  );

  const generated = [];
  const files = [];
  const errors = [];

  for (const outcome of results) {
    if (outcome.status === 'fulfilled') {
      const { sectionType, result } = outcome.value;
      try {
        if (result.isVariant) {
          // Variant path: write JSON content file + Astro shim
          const jsonAbs  = resolve(outputDir, result.jsonFile);
          const shimAbs  = resolve(outputDir, result.shimFile);
          await mkdir(dirname(jsonAbs), { recursive: true });
          await writeFile(jsonAbs, result.jsonContent, 'utf8');
          const shimRepaired = repairComponentColours(result.shimContent);
          await writeFile(shimAbs, shimRepaired.content, 'utf8');
          generated.push(sectionType);
          files.push(result.shimFile);
          console.log(`    [generate] ${sectionType} → ${result.shimFile} (variant: ${result.meta?.variantKey})`);
          if (shimRepaired.notes) console.log(`    [generate] ${shimRepaired.notes} in ${result.shimFile}`);
        } else {
          // Legacy path: write Astro file directly
          const absPath = resolve(outputDir, result.file);
          await mkdir(dirname(absPath), { recursive: true });
          const fixed = repairComponentColours(result.content);
          await writeFile(absPath, fixed.content, 'utf8');
          if (fixed.notes) console.log(`    [generate] ${fixed.notes} in ${result.file}`);
          generated.push(sectionType);
          files.push(result.file);
          console.log(`    [generate] ${sectionType} → ${result.file}`);
        }
      } catch (writeErr) {
        console.warn(`    [generate] Failed to write ${sectionType}: ${writeErr.message}`);
        errors.push(`${sectionType}: write failed — ${writeErr.message}`);
      }
    } else {
      const reason = outcome.reason?.message || String(outcome.reason);
      console.warn(`    [generate] Skipped section (generation failed): ${reason}`);
      errors.push(reason);
    }
  }

  // Post-generation validation: catch hallucinated paths and naming errors
  // the AI ships despite the prompt rules. Auto-fix where safe; surface the
  // rest as warnings so the operator knows. Unfixable issues are returned in
  // `validationIssues` so build-site can plumb them into the missing report.
  const validationIssues = [];
  if (files.length > 0) {
    const { validateGeneratedFiles, autofixGeneratedIssues } = await import('./validate-generated.js');
    const absPaths = files.map(f => resolve(outputDir, f));
    const issues = await validateGeneratedFiles(absPaths, outputDir);

    if (issues.length > 0) {
      const fixed = await autofixGeneratedIssues(issues, outputDir);
      const fixedCount = [...fixed.values()].reduce((a, b) => a + b, 0);
      const remaining = issues.filter(i => i.issue !== 'double-doctor-prefix'); // these are auto-fixed

      if (fixedCount > 0) {
        console.log(`  [validate] Auto-fixed ${fixedCount} generation issue(s) (double-doctor-prefix).`);
      }
      for (const iss of remaining) {
        console.warn(`  [validate] ${iss.issue} in ${iss.file}: ${iss.detail}`);
        errors.push(`${iss.issue}: ${iss.detail}`);
        validationIssues.push(iss);
      }
    }
  }

  // Defensive: index.astro statically imports every section component from
  // src/components/generated/*.astro. If a generator was skipped (data guard
  // failed) OR a section in the index's import list has no generator at all
  // (e.g. 'gallery' currently — no skill-generate handler), the Vite build
  // dies on "Could not resolve <path>". Write empty stubs for any imports
  // that didn't get a real file. The stub renders nothing; index.astro only
  // calls the component when its section appears in `designDNA.sectionOrder`.
  const stubbed = await writeMissingGeneratedStubs(outputDir);
  if (stubbed.length > 0) {
    console.log(`  [generate] Wrote ${stubbed.length} stub${stubbed.length === 1 ? '' : 's'} for unresolved imports: ${stubbed.join(', ')}`);
  }

  return { generated, files, errors, validationIssues, stubbed };
}

/**
 * Scan index.astro for static imports of `generated/*.astro` and write empty
 * stubs for any that don't exist on disk. Pure defensive guard against the
 * "import-without-generator" class of build failures.
 *
 * @param {string} outputDir
 * @returns {Promise<string[]>} list of stub component names written
 */
async function writeMissingGeneratedStubs(outputDir) {
  const indexPath = resolve(outputDir, 'src/pages/index.astro');
  const generatedDir = resolve(outputDir, 'src/components/generated');
  let indexSrc;
  try {
    indexSrc = await readFile(indexPath, 'utf8');
  } catch {
    return [];  // no index.astro — nothing to verify
  }

  // Match `from '../components/generated/<Name>.astro'` (single or double quotes)
  const importRe = /from\s+['"]\.\.\/components\/generated\/([A-Z][A-Za-z0-9_-]*)\.astro['"]/g;
  const names = [...indexSrc.matchAll(importRe)].map(m => m[1]);
  const unique = [...new Set(names)];

  const written = [];
  for (const name of unique) {
    const filePath = resolve(generatedDir, `${name}.astro`);
    try {
      await access(filePath);
      // file exists — leave it alone
    } catch {
      const stub = `---\n// Auto-stub: index.astro imports this component but no generator produced it.\n// Renders nothing; only matters if '${name}' is in designDNA.sectionOrder.\n---\n`;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, stub, 'utf8');
      written.push(name);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Section content assembly
// ---------------------------------------------------------------------------

/**
 * Build the complete content object from merged data + raw bronze scrape.
 * Lives here (not in build-site.js) because it's generation-specific logic.
 */
function buildSectionContent(merged, bronze = null) {
  const generated = merged?.content?.generated || {};
  const homepage  = generated?.homepage || {};

  // Build navigation from scraped site — map to known template routes only.
  // The template has a fixed set of pages; scraped links that don't map to them
  // are dropped to prevent 404s.
  //
  // TEMPLATE_ROUTES: exact paths that exist in the Astro template.
  const TEMPLATE_ROUTES = new Set(['/', '/about', '/services', '/blog', '/gallery', '/faq', '/financing', '/schedule']);

  // ROUTE_ALIASES: common scraped paths → nearest template equivalent.
  const ROUTE_ALIASES = {
    '/appointment':    '/schedule',
    '/book':           '/schedule',
    '/contact':        '/schedule',
    '/new-patients':   '/schedule',
    '/request-appointment': '/schedule',
    '/dr-anthony-hoang': '/about',
    '/meet-the-doctor': '/about',
    '/meet-dr':        '/about',
    '/our-team':       '/about',
    '/team':           '/about',
    '/about-us':       '/about',
    '/testimonials':   null,   // no template page — drop
    '/reviews':        null,
    '/before-after':   null,
    '/gallery':        '/gallery',
    '/special-offers': null,
    '/promotions':     null,
    '/careers':        null,
    '/privacy':        null,
  };

  // Map and deduplicate nav entries.
  const navSeen = new Set();
  const scrapedNav = (bronze?.siteAssets?.navigation || [])
    .filter(n => n.href && n.text && n.text.length < 40)
    .filter(n => !/request appointment|learn more|home/i.test(n.text))
    .map(n => {
      const raw = n.href.startsWith('/') ? n.href
        : (() => { try { return new URL(n.href).pathname; } catch { return n.href; } })();
      // Strip trailing slash for comparison
      const path = raw.replace(/\/$/, '') || '/';
      // Only top-level paths (no /services/something, no /blog/slug)
      const segments = path.replace(/^\//, '').split('/').filter(Boolean);
      if (segments.length > 1) return null;
      // Map to known template route
      let mapped = path;
      if (!TEMPLATE_ROUTES.has(path)) {
        // Check aliases (prefix match for paths like /dr-john-smith → /about)
        const aliasKey = Object.keys(ROUTE_ALIASES).find(k => path === k || path.startsWith(k + '/'));
        mapped = aliasKey ? ROUTE_ALIASES[aliasKey] : null;
      }
      if (!mapped) return null;  // no template equivalent — drop
      return { href: mapped, text: n.text };
    })
    .filter(Boolean)
    .filter(n => {
      if (navSeen.has(n.href)) return false;
      navSeen.add(n.href);
      return true;
    })
    .filter(n => n.href !== '/') // never add Home to desktop nav
    .slice(0, 7);

  // Always ensure /about is reachable if a doctor is present
  if (merged?.doctor?.name && !navSeen.has('/about')) {
    const doctorLabel = merged.doctor.name ? `Meet ${merged.doctor.name.split(' ').slice(-1)[0]}` : 'About';
    scrapedNav.push({ href: '/about', text: doctorLabel });
  }

  return {
    hero: {
      tagline:     merged?.content?.heroTagline     || homepage.heroTagline     || null,
      headline:    merged?.content?.heroHeadline    || homepage.heroHeadline    || null,
      subheadline: merged?.content?.heroSubheadline || homepage.heroSubheadline || null,
    },
    services: {
      list: (merged?.services?.offered || []).slice(0, 8).map(s => ({
        name: typeof s === 'string' ? s : s.name,
        slug: typeof s === 'string'
          ? s.toLowerCase().replace(/\s+/g, '-')
          : (s.slug || s.name?.toLowerCase().replace(/\s+/g, '-')),
        desc: typeof s === 'object' ? (s.description || s.blurb || '') : '',
      })),
    },
    navigation: scrapedNav,
    doctor: {
      // X3 — primary doctor pulled from doctors[0]; back-compat with old shape
      name:        merged?.doctors?.[0]?.name        || merged?.doctor?.name        || null,
      // Bio MUST be the doctor's own — never fall back to practice.aboutText.
      // That fallback was the source of the "bio bleed" bug (practice mission
      // statement rendered as the doctor's biography).
      bio:         merged?.doctors?.[0]?.bio         || merged?.doctor?.bio         || null,
      credentials: merged?.doctors?.[0]?.credentials || merged?.doctor?.credentials || null,
      // Relevant rescued content for grounding the bio in real voice.
      // Filter additionalContent to types that make sense for a doctor section:
      // pull-quotes from this doctor, philosophy paragraphs, welcome statements.
      // X2: read top-level; back-compat with nested location
      additionalContent: (merged?.additionalContent || merged?.content?.additionalContent || []).filter(item => {
        const type = String(item.type || '').toLowerCase();
        const text = String(item.content || '').toLowerCase();
        const docName = String(merged?.doctors?.[0]?.name || merged?.doctor?.name || '').toLowerCase();
        const docLast = docName.replace(/^dr\.?\s+/, '').split(/\s+/).pop() || '';
        const matchesType = /pullquote|quote|philosophy|approach|welcome|mission|patient-experience|community/.test(type);
        // Pull quote from THIS doctor specifically (mentions their name)
        const mentionsThisDoctor = docLast && text.includes(docLast);
        return matchesType || mentionsThisDoctor;
      }).slice(0, 4),
    },
    cta: {
      headline:    merged?.content?.ctaText           || homepage.ctaText           || null,
      subheadline: merged?.content?.ctaSecondaryText  || homepage.ctaSecondaryText  || null,
    },
    stats: {
      yearsExperience: merged?.content?.stats?.yearsExperience || null,
      happyPatients:   merged?.content?.stats?.happyPatients   || null,
      googleRating:    merged?.content?.stats?.googleRating    || null,
      fiveStarReviews: merged?.content?.stats?.fiveStarReviews || null,
    },
    reviews: {
      testimonials: merged?.content?.testimonials || merged?.content?.reviews || [],
      rating:       merged?.reviews?.rating       || null,
      reviewCount:  merged?.reviews?.reviewCount  || null,
      gmapsUrl:     merged?.reviews?.gmapsUrl     || merged?.practice?.googleProfileLink || null,
    },
    faqs: merged?.content?.faqs || merged?.content?.generatedFAQs || [],
    // X2 — Catch-all rescued content from silver. Top-level on the new shape;
    // legacy nested location supported for back-compat.
    additionalContent: merged?.additionalContent || merged?.content?.additionalContent || [],
    // X3 — Full doctors[] array (primary at [0]). Section briefs that need ALL
    // doctors (about page, team blocks) read from here. Briefs that need just
    // the primary read content.doctor (above).
    doctors: merged?.doctors || (merged?.doctor && merged.doctor.name
      ? [merged.doctor, ...(merged.additionalDoctors || [])]
      : []),
    // Practice specialty hint for FAQ generation — used to scope question topics
    specialty: merged?.practice?.specialty
            || merged?.preset?.specialty
            || (merged?.practice?.name && /ortho/i.test(merged.practice.name) ? 'orthodontics'
              : merged?.practice?.name && /pediatric|kid/i.test(merged.practice.name) ? 'pediatric dentistry'
              : merged?.practice?.name && /cosmetic/i.test(merged.practice.name) ? 'cosmetic dentistry'
              : 'general dentistry'),
  };
}

/**
 * Extract section-specific content slice from the full content object.
 */
function getSectionContent(sectionType, content = {}) {
  switch (sectionType) {
    case 'hero':         return content.hero         || {};
    case 'services':     return content.services     || {};
    case 'doctor-intro': return content.doctor       || {};
    case 'cta':          return content.cta          || {};
    case 'nav':          return { services: content.services || {}, navigation: content.navigation || [] };
    case 'footer':       return {};
    case 'stat-bar':     return content.stats        || {};
    case 'reviews':      return content.reviews      || {};
    case 'faq':          return {
      faqs:      content.faqs     || [],
      services:  content.services || {},
      specialty: content.specialty || content.practice?.specialty || null,
      // FAQ-relevant rescued content — types that often answer common questions:
      // financing/insurance copy, emergency policy, accessibility/multilingual notes,
      // first-visit / approach descriptions.
      additionalContent: (content.additionalContent || []).filter(item => {
        const type = String(item.type || '').toLowerCase();
        return /financing|insurance|emergency|accessibility|multilingual|approach|first-visit|patient-experience|community|technology/.test(type);
      }).slice(0, 6),
    };
    default:             return content[sectionType] || {};
  }
}

