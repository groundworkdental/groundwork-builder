#!/usr/bin/env node
/**
 * Groundwork Builder Pipeline
 *
 * Takes an existing website URL and/or intake form data,
 * and generates a ready-to-customize Astro project from the starter template.
 *
 * Usage:
 *   node scripts/pipeline/build-site.js --url https://old-site.com --output ../clients/smith-dental
 *   node scripts/pipeline/build-site.js --data intake.json --output ../clients/smith-dental
 *   node scripts/pipeline/build-site.js --url https://old-site.com --data intake.json --output ../clients/smith-dental
 *   node scripts/pipeline/build-site.js --slug smith-dental --output ../clients/smith-dental
 *   node scripts/pipeline/build-site.js --preset dental --url https://old-site.com --output ../clients/smith-dental
 *   node scripts/pipeline/build-site.js --url … --reference auto --output ../clients/smith-dental
 *
 * Phase map (see docs/PIPELINE.md):
 *   1 Crawl → 2 Process → 3 Assemble → 4 Build → 5 Designer → 6 SEO → 7 SEO loop → 8 Quality → 9 Reports
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as pathResolve, dirname as pathDirname } from 'node:path';
import { fileURLToPath as pathFileURLToPath } from 'node:url';
// Load .env relative to this file's location, not process.cwd()
dotenvConfig({ path: pathResolve(pathDirname(pathFileURLToPath(import.meta.url)), '..', '..', '.env'), override: true });
import { resolve } from 'node:path';
import { loadPreset } from './lib/preset-loader.js';
import { scrape } from './lib/scraper.js';
import { extractSilver } from './lib/ai-silver.js';
import { loadIntake } from './lib/intake.js';
import { evaluateDataFields } from './standards/practice-contract.js';
import { mergeData } from './lib/merger.js';
import { injectTemplate, injectGlobalCss } from './lib/injector.js';
import { generatePages } from './lib/page-generator.js';
import { generateBlogStubs } from './lib/blog-generator.js';
import { downloadImages } from './lib/image-downloader.js';
import { validate } from './lib/validator.js';
import { slugify } from './lib/utils.js';
import { createArtifactWriter } from './lib/artifacts.js';
import { runSiteAudit } from './lib/ai-audit.js';
import { runContentMapping } from './lib/ai-content.js';
import { runContentMap } from './lib/ai-content-map.js';
import { generateMissingPage } from './lib/missing-page.js';
import { generateReport } from './lib/report-generator.js';
import { scrapeReviews } from './lib/scrape-reviews.js';
import { analyzeImages } from './lib/ai-images.js';
import { writeDesignDna } from './lib/injector.js';
// Clean pipeline (Step 4–7): brand-dna, content-plan, assemble-layout, image binding.
import { defineBrandDna, fallbackBrandDnaFromMerged } from './lib/brand/brand-dna.js';
import { applyBrandToMerged } from './lib/assemble/brand-tokens.js';
import { planContent } from './lib/content/plan-content.js';
import { assembleLayout } from './lib/assemble/assemble-layout.js';
import { bindingToImageRoles } from './lib/assemble/binding-to-image-roles.js';
import { distillDesign } from './lib/distill-design.js';
import { runDesignerAgent, buildAstro } from './lib/designer-agent.js';
import { loadReferenceEntry, selectAutoReference, applyReferenceToBrandDna, applyReferenceToDirector } from './lib/reference-entry.js';
import { generateAgentFiles } from './lib/generate-agent-files.js';

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    url: null,
    data: null,
    clientId: null,       // deprecated — use slug
    airtableSlug: null,   // legacy alias for slug (D1 account)
    slug: null,
    output: null,
    preset: 'dental',
    skipScrape: false,
    requireReady: false,
    skipImages: false,
    skipAudit: false,
    skipDesign: false,
    skipContent: false,
    skipBuild: false,
    skipGenerate: false,
    dryRun: false,
    verbose: false,
    agent: true,
    agentIterations: '6',
    publish: false,
    fixWorklistPath: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
        opts.url = args[++i];
        break;
      case '--data':
        opts.data = args[++i];
        break;
      case '--client-id':
        opts.clientId = args[++i];
        console.warn('  ⚠ --client-id is deprecated; use --slug <slug> instead.');
        break;
      case '--slug':
        opts.slug = args[++i];
        break;
      case '--airtable-slug':
        // Legacy alias — CRM is D1 now; same lookup path as --slug
        opts.airtableSlug = args[++i];
        console.warn('  ⚠ --airtable-slug is deprecated; use --slug <slug> (D1 accounts).');
        break;
      case '--output':
        opts.output = args[++i];
        break;
      case '--preset':
        opts.preset = args[++i];
        break;
      case '--skip-scrape':
        opts.skipScrape = true;
        break;
      case '--require-ready':
        opts.requireReady = true;
        break;
      case '--skip-images':
        opts.skipImages = true;
        break;
      case '--skip-audit':
        opts.skipAudit = true;
        break;
      case '--skip-design':
        opts.skipDesign = true;
        break;
      case '--skip-content':
        opts.skipContent = true;
        break;
      case '--skip-build':
        opts.skipBuild = true;
        break;
      case '--skip-generate':
        opts.skipGenerate = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--agent':
        opts.agent = true;
        break;
      case '--no-agent':
        opts.agent = false;
        break;
      case '--agent-iterations':
        opts.agentIterations = args[++i];
        break;
      case '--reference':
        // Design-catalog entry id (examples/<id>.json | runs/<id>/entry.json) or
        // a path to an entry. Reference owns structure (variant map, atoms,
        // type character, audit gates); practice keeps identity (colors, content).
        opts.reference = args[++i];
        break;
      case '--include-debug-pages':
        // Ship internal debug pages (currently /missing) into the deployed
        // dist/. By default these are operator-only and live in _pipeline/.
        opts.includeDebugPages = true;
        break;
      case '--debug-prompts':
        // Dump every Claude API prompt + response to _pipeline/_debug/ for
        // post-mortem inspection. No-op unless the call sites support it.
        opts.debugPrompts = true;
        process.env.GROUNDWORK_DEBUG_PROMPTS = '1';
        break;
      case '--publish':
        // After build: generate pitch page, push to GitHub, create CF Pages
        // project, add subdomain, write D1 builds row.
        opts.publish = true;
        break;
      case '--fix-worklist':
        // Path to a grader-emitted fix-worklist.json. Generators that have
        // been wired (currently: skill-seo-optimize.js) will gate their tiers
        // on whether their target is listed. Without this flag, generators
        // run unconditionally (legacy behavior).
        opts.fixWorklistPath = args[++i];
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.warn(`Unknown flag: ${args[i]}`);
        break;
    }
  }

  if (!opts.url && !opts.data && !opts.clientId && !opts.airtableSlug && !opts.slug) {
    console.error('Error: At least one of --url, --data, or --slug is required.');
    console.error('Run with --help for usage information.');
    process.exit(1);
  }

  return opts;
}

function printHelp() {
  console.log(`
Groundwork Builder Pipeline

Usage:
  node scripts/pipeline/build-site.js [options]

Options:
  --url <url>        Existing website URL to scrape
  --data <path>      Path to intake JSON file
  --slug <slug>       Load intake from D1 Account (intake_json) or clients/<slug>/intake.json
  --airtable-slug <slug>  Deprecated alias for --slug
  --client-id <slug>      Deprecated alias for --slug
  --output <path>    Output directory for new project
  --preset <name>    Vertical preset (default: dental)
  --skip-scrape      Skip website scraping
  --require-ready    Stop if the practice contract reports critical gaps
  --skip-images      Skip image downloading
  --skip-audit       Skip AI site audit
  --skip-build       Skip build validation
  --reference <id>   Design-catalog entry id (examples/<id>.json or runs/<id>/entry.json),
                     a path, or "auto" (pick curated light run by content appetite
                     after scrape). Env fallback: GROUNDWORK_DEFAULT_REFERENCE.
                     Owns variant map + atoms + type bucket + audit gates; practice
                     keeps its colors and content.
  --dry-run          Scrape + merge only, print JSON
  --verbose          Detailed output
  --help             Show this help message

Examples:
  node scripts/pipeline/build-site.js --url https://old-site.com --output ../clients/smith-dental
  node scripts/pipeline/build-site.js --data intake.json --output ../clients/smith-dental
  node scripts/pipeline/build-site.js --url https://old-site.com --data intake.json --output ../clients/smith-dental
`.trim());
}

// ---------------------------------------------------------------------------
// Main pipeline orchestrator
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // --reference: explicit ids load + validate up front (fail fast before API spend).
  // `--reference auto` waits until after scrape/merge so appetite can soft-match.
  let referenceEntry = null;
  let pendingAutoReference = false;
  // Catalog default: explicit --reference, else GROUNDWORK_DEFAULT_REFERENCE,
  // else none (archetype director). Use --reference auto to pick a curated run.
  if (!opts.reference && process.env.GROUNDWORK_DEFAULT_REFERENCE) {
    opts.reference = process.env.GROUNDWORK_DEFAULT_REFERENCE;
  }
  if (opts.reference) {
    if (opts.reference === 'auto') {
      pendingAutoReference = true;
      console.log('[reference] auto — pick deferred until after scrape/merge (content appetite)');
    } else {
      referenceEntry = await loadReferenceEntry(opts.reference);
      console.log(`[reference] ${referenceEntry.id} — variants locked, audit gates active (${(referenceEntry.audit?.fidelityChecks || []).length} fidelity checks, ${(referenceEntry.audit?.sanctionedPatterns || []).length} sanctioned patterns)`);
    }
  }
  const startTime = Date.now();

  console.log('');
  console.log('=== Groundwork Builder Pipeline ===');
  console.log('');

  // Load vertical preset
  console.log(`[Preset] Loading "${opts.preset}" preset...`);
  const preset = await loadPreset(opts.preset);
  console.log(`[Preset] Loaded: ${preset.name} (${preset.taxonomy.services.length} service taxonomy entries)`);
  console.log('');

  // Optionally load grader-emitted fix worklist. Generators wired to consume
  // it will gate their tiers on whether their target is listed.
  let fixWorklist = null;
  if (opts.fixWorklistPath) {
    try {
      const { readFile: rf } = await import('node:fs/promises');
      const raw = JSON.parse(await rf(opts.fixWorklistPath, 'utf8'));
      // Accept either the top-level array or the wrapped { worklist: [] } shape.
      fixWorklist = Array.isArray(raw) ? raw : (raw?.worklist || null);
      const n = fixWorklist?.length ?? 0;
      console.log(`[FixWorklist] Loaded ${n} action${n === 1 ? '' : 's'} from ${opts.fixWorklistPath}`);
      if (n > 0) {
        const targets = fixWorklist.map(e => e.target).join(', ');
        console.log(`[FixWorklist] Targets: ${targets}`);
      }
      console.log('');
    } catch (err) {
      console.warn(`[FixWorklist] Could not load ${opts.fixWorklistPath}: ${err.message}`);
      console.warn('[FixWorklist] Falling back to unconditional generator behavior.');
      console.log('');
    }
  }

  // Track stats for the summary
  const stats = {
    scrapedUrl: null,
    intakeFile: null,
    practiceName: null,
    doctorName: null,
    phone: null,
    servicesCount: 0,
    blogStubs: 0,
    imagesDownloaded: 0,
    buildSuccess: false,
    placeholders: [],
    brokenLinks: [],
    confidenceFlags: [],
    errors: [],
    hasDesign: false,
    hasContent: false,
    missingCritical: 0,
    missingImportant: 0,
  };

  // -----------------------------------------------------------------------
  // Phase 1a: Crawl existing website — Bronze layer (raw page dump)
  // -----------------------------------------------------------------------
  let bronze = null;
  let scraped = null; // silver-shaped data (for downstream compatibility)
  let reviews = null;

  if (opts.url && !opts.skipScrape) {
    console.log(`[Phase 1a] Crawling ${opts.url} (bronze)...`);
    try {
      bronze = await scrape(opts.url, { verbose: opts.verbose });
      stats.scrapedUrl = opts.url;
      console.log(`  Bronze: ${bronze.pageCount} pages crawled.`);
    } catch (err) {
      console.error(`  Crawl failed: ${err.message}`);
      stats.errors.push(`Crawl failed: ${err.message}`);
    }
    console.log('');

    // -----------------------------------------------------------------------
    // Phase 1b: AI Silver extraction — Bronze → structured PracticeData
    // -----------------------------------------------------------------------
    if (bronze) {
      console.log('[Phase 1b] Extracting silver data via Claude...');
      try {
        scraped = await extractSilver(bronze);
        // Hard check — if silver came back essentially empty, fail loudly.
        // Continuing with empty silver produces a garbage build downstream.
        const isEmpty = !scraped?.practice?.name && !scraped?.doctor?.name && (scraped?.services?.offered?.length ?? 0) === 0;
        if (isEmpty) {
          throw new Error('Silver extraction returned empty data — likely a transient API failure. Re-run the pipeline.');
        }
        console.log('  Silver extraction complete.');
      } catch (err) {
        console.error(`\n  ✗ FATAL: ${err.message}`);
        console.error(`  The pipeline cannot produce a meaningful build without silver data.`);
        console.error(`  Re-run with the same URL — bronze is cached and Phase 1a will be fast.\n`);
        process.exit(1);
      }
      console.log('');

      // -----------------------------------------------------------------------
      // Phase 1c: Scrape reviews from bronze (Google Maps / Yelp / schema.org)
      // -----------------------------------------------------------------------
      console.log('[Phase 1c] Scraping reviews from bronze...');
      try {
        reviews = await scrapeReviews(bronze);
        if (reviews.source) {
          console.log(`  Reviews: source=${reviews.source}, rating=${reviews.rating ?? '—'}, count=${reviews.reviewCount ?? '—'}, scraped=${reviews.reviews.length}`);
          if (reviews.gmapsUrl) console.log(`  Google Maps URL found.`);
          if (reviews.yelpUrl)  console.log(`  Yelp URL found.`);
        } else {
          console.log('  No review URLs found in bronze.');
        }
      } catch (err) {
        console.warn(`  Review scrape failed: ${err.message}`);
        reviews = null;
      }
      console.log('');

      // -----------------------------------------------------------------------
      // Phase 1d: AI image analysis (cached in _memory/images/<slug>.json)
      // -----------------------------------------------------------------------
      console.log('[Phase 1d] Analyzing images...');
      const _imgSlug = opts.url
        ? new URL(opts.url).hostname.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '-')
        : 'unknown';
      try {
        bronze.imageAnalysis = await analyzeImages(bronze, _imgSlug, { verbose: opts.verbose });
        const count = Object.keys(bronze.imageAnalysis).length;
        console.log(`  ${count} images analyzed.`);
        // Store slug for deferred artifact write after artifacts is initialized
        bronze._imageAnalysisSlug = _imgSlug;
      } catch (err) {
        console.warn(`  Image analysis failed (non-fatal): ${err.message}`);
        bronze.imageAnalysis = {};
      }
      console.log('');

    }
  } else if (opts.url && opts.skipScrape) {
    console.log('[Phase 1] Skipping crawl (--skip-scrape).');
    console.log('');
  } else {
    console.log('[Phase 1] No URL provided — skipping crawl.');
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Phase 2: Load intake data + merge
  // -----------------------------------------------------------------------
  console.log('[Phase 2] Loading intake data and merging...');

  let intake = null;
  const intakeSlug = opts.slug || opts.airtableSlug || opts.clientId;
  if (opts.data || intakeSlug) {
    try {
      intake = await loadIntake({
        filePath: opts.data,
        airtableSlug: intakeSlug,
      });
      stats.intakeFile = opts.data || `airtable:${intakeSlug}`;
      console.log('  Intake data loaded.');
    } catch (err) {
      console.error(`  Intake load failed: ${err.message}`);
      stats.errors.push(`Intake load failed: ${err.message}`);
    }
  }

  if (!scraped && !intake) {
    console.error('');
    console.error('Error: No data available. Both scrape and intake failed or were skipped.');
    process.exit(1);
  }

  const merged = mergeData(scraped, intake, preset);

  // ── Readiness against the practice contract ────────────────────────────
  // standards/practice-contract.js is the single declaration of what a build
  // needs; check-readiness.js asks the same question of an intake BEFORE a
  // run. Asking again here, against merged data, is the first point where
  // the answer is complete — the crawl has supplied whatever the intake did
  // not.
  //
  // Advisory by default. A cold build is expected to have gaps; that is what
  // the missing report is for, and blocking here would stop previews that
  // are worth showing. --require-ready makes critical gaps fatal, which is
  // what a client-facing rebuild wants.
  {
    const readiness = evaluateDataFields(merged);
    const crit = readiness.bySeverity.critical;
    const imp = readiness.bySeverity.important;
    stats.readiness = {
      satisfied: readiness.satisfied.length,
      total: readiness.satisfied.length + readiness.missing.length,
      critical: crit.map(f => f.path),
      important: imp.map(f => f.path),
    };

    console.log(
      `  Contract: ${stats.readiness.satisfied}/${stats.readiness.total} fields present` +
      (crit.length ? ` · ${crit.length} critical gap(s)` : '') +
      (imp.length ? ` · ${imp.length} important` : ''),
    );
    for (const f of crit) {
      console.warn(`    ✗ ${f.label} — ${f.hint}`);
    }

    if (crit.length && opts.requireReady) {
      console.error('');
      console.error(`Error: ${crit.length} critical contract gap(s) and --require-ready was set.`);
      console.error('Supply the fields above in the intake, or drop --require-ready to build anyway.');
      process.exit(1);
    }
  }

  // Canonical URL-derived slug — shared across outputDir, --publish, design
  // library distillation, Airtable, GCS, and the auto-rescan lookup. Must
  // be at function scope so every downstream consumer (especially publish())
  // sees the same value. Falls back to scraped domain, then a constant.
  const { slugFromUrl } = await import('./lib/slug.js');
  const slug = (opts.url && slugFromUrl(opts.url))
    || (merged.practice?.domain && slugFromUrl(`https://${merged.practice.domain}`))
    || 'new-dental-site';


  // Merge scraped reviews into merged — store under BOTH keys for compatibility
  if (reviews && reviews.reviews.length > 0) {
    if (!merged.content) merged.content = {};
    if (!merged.content.reviews || merged.content.reviews.length === 0) {
      merged.content.reviews = reviews.reviews;
    }
    // Also populate testimonials — generate-sections.js uses this key
    if (!merged.content.testimonials || merged.content.testimonials.length === 0) {
      merged.content.testimonials = reviews.reviews;
    }
    // Store aggregate review data at top level for director and components
    merged.reviews = {
      source:      reviews.source,
      rating:      reviews.rating,
      reviewCount: reviews.reviewCount,
      gmapsUrl:    reviews.gmapsUrl,
      yelpUrl:     reviews.yelpUrl,
      reviews:     reviews.reviews,
    };
  }

  // Parse social links from bronze siteAssets into practice fields
  if (bronze?.siteAssets?.socialLinks?.length) {
    const socials = bronze.siteAssets.socialLinks;
    if (!merged.practice) merged.practice = {};
    // Google Maps / review URL
    const gmaps = socials.find(u => u.includes('google.com/maps') || u.includes('maps.google'));
    if (gmaps && !merged.practice.googleProfileLink) merged.practice.googleProfileLink = gmaps;
    // Yelp
    const yelp = socials.find(u => u.includes('yelp.com'));
    if (yelp && !merged.practice.yelpUrl) merged.practice.yelpUrl = yelp;
    // Facebook
    const fb = socials.find(u => u.includes('facebook.com') && !u.includes('/reviews'));
    if (fb && !merged.practice.facebookUrl) merged.practice.facebookUrl = fb;
    // Collect all as sameAs for schema
    if (!merged.practice.sameAs?.length) merged.practice.sameAs = socials;
  }

  // Validate googleReviewLink — silver AI sometimes assigns Facebook/Yelp URLs
  // when source link text says "Google Reviews". Must be a real Google URL.
  if (merged.practice?.googleReviewLink) {
    const link = merged.practice.googleReviewLink;
    if (!/google\.(com|[a-z]{2,3})\//i.test(link)) {
      console.log(`  Discarding non-Google review link: ${link.slice(0, 60)}`);
      merged.practice.googleReviewLink = null;
    }
  }
  // Fallback: if review link missing but Google profile/maps URL is present, use it
  if (!merged.practice?.googleReviewLink && merged.practice?.googleProfileLink) {
    merged.practice.googleReviewLink = merged.practice.googleProfileLink;
  }
  // Use Google Maps URL from review scrape as last fallback
  if (!merged.practice?.googleReviewLink && merged.reviews?.gmapsUrl) {
    merged.practice.googleReviewLink = merged.reviews.gmapsUrl;
  }

  // Populate stats from merged data
  stats.practiceName = merged.practice.name || '[unknown]';
  stats.doctorName = merged.doctor?.name
    || (merged.doctor?.firstName
      ? `Dr. ${merged.doctor.firstName} ${merged.doctor.lastName}`
      : '[unknown]');
  stats.phone = merged.practice.phone || '[unknown]';
  stats.servicesCount = merged.services.offered?.length || 0;
  stats.confidenceFlags = merged.meta?.confidenceFlags || [];

  // --reference auto: score catalog appetites against scrape richness, then lock entry
  if (pendingAutoReference) {
    const refId = await selectAutoReference({
      scraped: merged,
      seed: opts.url || slug || opts.slug || opts.airtableSlug || 'dental',
    });
    referenceEntry = await loadReferenceEntry(refId);
    console.log(`[reference] auto → ${referenceEntry.id} — variants locked, audit gates active (${(referenceEntry.audit?.fidelityChecks || []).length} fidelity checks, ${(referenceEntry.audit?.sanctionedPatterns || []).length} sanctioned patterns)`);
  }

  console.log(`  Practice: ${stats.practiceName}`);
  console.log(`  Doctor:   ${stats.doctorName}`);
  console.log(`  Phone:    ${stats.phone}`);
  console.log(`  Services: ${stats.servicesCount}`);
  console.log('');

  // -----------------------------------------------------------------------
  // Dry run — just print merged JSON and exit
  // -----------------------------------------------------------------------
  if (opts.dryRun) {
    console.log('[Dry Run] Merged data:');
    console.log(JSON.stringify(merged, null, 2));
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Resolve output directory
  // -----------------------------------------------------------------------
  // Default placement depends on whether we're publishing:
  //   --publish        → clients/<slug>/   (in-repo, so git push triggers CF Pages)
  //   no --publish     → ../output/<slug>/ (out-of-repo, doesn't pollute the monorepo)
  // Explicit --output always overrides both.
  let outputDir = opts.output;
  if (!outputDir) {
    // Uses the canonical `slug` hoisted above — single source of truth so
    // publish(), Airtable, GCS, and the design library all agree.
    outputDir = opts.publish
      ? resolve('clients', `${slug}`)
      : resolve('..', 'output', `${slug}`);
  }
  outputDir = resolve(outputDir);
  console.log(`[Output] ${outputDir}${opts.publish ? '   (publish mode — committed to monorepo)' : ''}`);
  console.log('');

  // Create run-scoped storage (GCS + local) and artifact writer
  const { createRunStorage, storageStatus } = await import('./lib/storage.js');
  // Canonical URL slug for runs/GCS — matches Airtable, CF Pages, clients/<slug>/
  const clientSlug = slug;
  const runStorage = createRunStorage(clientSlug);
  const artifacts  = createArtifactWriter(outputDir, runStorage);

  // Write deferred image analysis artifact (bronze.imageAnalysis captured in Phase 1d)
  if (bronze?.imageAnalysis && Object.keys(bronze.imageAnalysis).length > 0) {
    await artifacts.writeStep('07-image-analysis', {
      input: { slug: bronze._imageAnalysisSlug || 'unknown', imageCount: Object.keys(bronze.imageAnalysis).length },
      output: bronze.imageAnalysis,
    }).catch(() => {});
  }

  // Log GCS status once
  const gcsStatus = await storageStatus();
  if (gcsStatus.enabled) {
    console.log(`[Storage] GCS enabled → gs://${gcsStatus.bucket}/${runStorage.gcsPrefix}/`);
  } else {
    console.log(`[Storage] Local only (set GOOGLE_CLOUD_CREDENTIALS_JSON to enable GCS)`);
  }
  console.log('');

  // Persist full bronze to disk + GCS for later re-processing.
  if (bronze) {
    try {
      const bronzeJson = JSON.stringify(bronze, null, 2);
      await runStorage.writeArtifact('01-bronze.json', bronzeJson, resolve(outputDir, '_pipeline', '01-bronze.json'));
      console.log(`  Bronze saved: ${bronze.pageCount} pages, ${(bronzeJson.length / 1024).toFixed(0)}KB`);
    } catch (err) {
      console.warn(`  Bronze save failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2b: AI Site Audit (unless --skip-audit or no API key)
  // -----------------------------------------------------------------------
  let audit = null;
  if (!opts.skipAudit && scraped) {
    console.log('[Phase 2b] Running AI site audit...');
    const auditStart = Date.now();
    audit = await runSiteAudit(scraped, merged, preset, { verbose: opts.verbose });
    if (audit) {
      await artifacts.writeStep('02-audit', {
        input: { url: opts.url, preset: opts.preset },
        output: audit,
      }, auditStart);
      console.log('  Audit artifact written.');
    }
    console.log('');
  } else if (opts.skipAudit) {
    console.log('[Phase 2b] Skipping AI audit (--skip-audit).');
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Phase 2b2: PageSpeed Insights — current site scores (non-AI, fast)
  // -----------------------------------------------------------------------
  if (opts.url) {
    console.log('[Phase 2b2] Running PageSpeed Insights on current site...');
    const psStart = Date.now();
    try {
      const { runPageSpeed } = await import('./lib/pagespeed.js');
      const psResult = await runPageSpeed(opts.url);
      await artifacts.writeStep('03-pagespeed', { input: { url: opts.url }, output: psResult }, psStart);
      const mob = psResult?.mobile?.performance;
      const dsk = psResult?.desktop?.performance;
      console.log(`  Mobile: ${mob ?? '—'}  Desktop: ${dsk ?? '—'}`);
    } catch (err) {
      console.warn(`  PageSpeed skipped: ${err.message}`);
    }
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Phase 2b3: Agentic readiness — existing site (pre-build before-state)
  // -----------------------------------------------------------------------
  if (opts.url) {
    console.log('[Phase 2b3] Checking agentic readiness on existing site...');
    const agStart = Date.now();
    try {
      const { runExistingAgentAudit } = await import('./lib/audit-agentic-existing.js');
      const agResult = await runExistingAgentAudit(opts.url);
      await artifacts.writeStep('02b-agentic-existing', { input: { url: opts.url }, output: agResult }, agStart);
      if (agResult.skipped) {
        console.log(`  Skipped: ${agResult.reason}`);
      } else {
        const icons = agResult.results.map(r => r.pass ? '✓' : '✗').join(' ');
        console.log(`  Existing site: ${agResult.fraction} [${icons}]`);
        stats.existingAgenticScore = agResult.fraction;
      }
    } catch (err) {
      console.warn(`  Agentic existing check skipped: ${err.message}`);
    }
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Phase 2c/2d: Define Brand (brand-dna)
  // -----------------------------------------------------------------------
  // CLEAN PATH (Step 4): Define Brand via brand-dna — replaces legacy AI design
  // mapping (2c) + brand direction (2d). Reads merged.currentDesign (observed) →
  // decided visual system + curated-seeded fonts; applyBrandToMerged writes
  // merged.brand.{colors,roles,fonts}. `design` stays null (legacy observation
  // unused downstream; injectTemplate tolerates null).
  let design = null;
  let brandDna = null;
  if (scraped && !opts.skipDesign && process.env.ANTHROPIC_API_KEY) {
    console.log('[Phase 2c/2d] Defining brand (brand-dna)...');
    const brandStart = Date.now();
    try {
      brandDna = await defineBrandDna(merged);
    } catch (err) {
      console.warn(`  Brand DNA failed: ${err.message}`);
    }
    if (!brandDna) {
      brandDna = fallbackBrandDnaFromMerged(merged);
      console.warn('  brand-dna unavailable — using scraped-brand fallback palette.');
    }
    if (brandDna && referenceEntry) {
      // Catalog reference: structure + type character from the entry; the
      // practice's elevated colors stay (reference owns structure, practice
      // owns identity — docs/design-catalog/SCHEMA.md).
      const seedKey = merged.practice?.name || merged.practice?.domain || '';
      applyReferenceToBrandDna(brandDna, referenceEntry, seedKey);
      console.log(`  Reference: ${referenceEntry.id} → shape/elevation/border + type bucket ${brandDna.typography?._fontBucket}`);
    }
    if (brandDna) {
      applyBrandToMerged(merged, brandDna);
      stats.hasDesign = true;
      await artifacts.writeStep('04-brand-dna', { input: { url: opts.url, reference: referenceEntry?.id || null }, output: brandDna }, brandStart);
      console.log(`  Palette: ${brandDna.color?.primary} / ${brandDna.color?.secondary} · Fonts: ${brandDna.typography?.headingFont} / ${brandDna.typography?.bodyFont}`);
    }
    console.log('');
  } else if (opts.skipDesign) {
    console.log('[Phase 2c/2d] Skipping brand-dna (--skip-design).');
    console.log('');
  }

  // Phase 2d (legacy AI brand direction) REMOVED — the brand (palette, fonts,
  // shape, elevation) is now owned by brand-dna (Phase 2c) + applyBrandToMerged.
  // NOTE: the old path also ran a deterministic validatePalette() WCAG
  // auto-correct here as a safety net. brand-dna's prompt enforces AA and
  // brand-eval verifies it, but there is no runtime auto-correct in the clean
  // path — consider porting validatePalette into applyBrandToMerged as a guard.

  // -----------------------------------------------------------------------
  // Phase 2e: Content Map (audit / blueprint) — what each section needs and
  // what existing source material best fits. Produces `_pipeline/03-content-blueprint.json`.
  // -----------------------------------------------------------------------
  let blueprint = null;
  if (!opts.skipContent && scraped) {
    console.log('[Phase 2e] Running Content Map (blueprint / audit)...');
    const mapStart = Date.now();
    blueprint = await runContentMap(scraped, merged, audit, preset, { verbose: opts.verbose });
    if (blueprint) {
      await artifacts.writeStep('03-content-blueprint', {
        input: { url: opts.url, preset: opts.preset },
        output: blueprint,
      }, mapStart);
      const cov = blueprint.coverage || {};
      console.log(`  Blueprint: ${cov.totalSections || '?'} sections — quality ${JSON.stringify(cov.byQuality || {})}, action ${JSON.stringify(cov.byAction || {})}`);
    } else {
      console.log('  Content Map skipped or failed — Write will run in legacy single-pass mode.');
    }
    console.log('');
  }

  // Phase 2f: Content Write — composes copy per the blueprint's keep/optimize/create
  // decisions. Produces `_pipeline/03-content.json` (consumed by page-generator).
  // -----------------------------------------------------------------------
  let contentMap = null;
  if (!opts.skipContent && scraped) {
    console.log('[Phase 2f] Running Content Write...');
    const contentStart = Date.now();
    contentMap = await runContentMapping(scraped, merged, audit, preset, { verbose: opts.verbose }, blueprint);
    if (contentMap) {
      stats.hasContent = true;
      // Surface key generated fields into merged.content for injection
      if (contentMap.homepage) {
        merged.content.heroTagline    = contentMap.homepage.heroTagline    || merged.content.heroTagline;
        merged.content.heroHeadline   = contentMap.homepage.heroHeadline   || merged.content.heroHeadline;
        merged.content.heroSubheadline = contentMap.homepage.heroSubheadline || merged.content.heroSubheadline;
        merged.content.ctaText        = contentMap.homepage.ctaText        || merged.content.ctaText;
        merged.content.ctaSecondaryText = contentMap.homepage.ctaSecondaryText || merged.content.ctaSecondaryText;
        merged.content.valueProp      = contentMap.homepage.valueProp      || merged.content.valueProp;
      }
      if (contentMap.about) {
        merged.content.aboutText      = contentMap.about.introParagraph    || merged.content.aboutText;
        merged.content.aboutHeadline  = contentMap.about.headline          || merged.content.aboutHeadline;
        merged.content.philosophy     = contentMap.about.philosophy        || merged.content.philosophy;
        merged.content.closingCTA     = contentMap.about.closingCTA        || merged.content.closingCTA;
      }
      if (contentMap.faqs?.length > 0 && merged.content.faqs.length === 0) {
        merged.content.generatedFAQs = contentMap.faqs;
      }
      merged.content.generated = contentMap;
      await artifacts.writeStep('03-content', {
        input: { url: opts.url, preset: opts.preset },
        output: contentMap,
      }, contentStart);
      console.log('  Content artifact written.');
    } else {
      console.log('  AI content mapping skipped or failed.');
    }
    console.log('');
  } else if (opts.skipContent) {
    console.log('[Phase 2e+2f] Skipping Content Map + Write (--skip-content).');
    console.log('');
  }

  // Write deferred scrape artifact — full silver output including signals
  if (scraped) {
    await artifacts.writeStep('01-scrape', {
      input: { url: opts.url },
      output: {
        practice: scraped.practice,
        doctor: scraped.doctor ? { name: scraped.doctor.name, credentials: scraped.doctor.credentials } : null,
        address: scraped.address,
        hours: scraped.hours || null,
        brand: scraped.brand || null,
        services: { offered: scraped.services?.offered || [] },
        images: {
          logo:        scraped.images?.logo        || null,
          hero:        scraped.images?.hero        || [],
          team:        scraped.images?.team        || [],
          office:      scraped.images?.office      || [],
          gallery:     scraped.images?.gallery     || [],
          beforeAfter: scraped.images?.beforeAfter || [],
        },
        content: {
          heroTagline:     scraped.content?.heroTagline     || null,
          heroSubheadline: scraped.content?.heroSubheadline || null,
          testimonials:    scraped.content?.testimonials    || [],
          faqs:            scraped.content?.faqs            || [],
          insurance:       scraped.content?.insurance       || [],
          stats:           scraped.content?.stats           || {},
        },
        signals: scraped.signals || [],
        servicesDetected: scraped.services?.offered?.length || 0,
        pagesVisited: scraped.migration?.oldUrls?.length || 0,
        reviews: reviews || null,
      },
      confidence: scraped.meta?.confidenceFlags || [],
    });
  }

  // Write merge artifact
  await artifacts.writeStep('06-merge', {
    input: {
      hasScrape: !!scraped,
      hasIntake: !!intake,
    },
    output: {
      practice: merged.practice.name,
      doctor: stats.doctorName,
      phone: merged.practice.phone,
      servicesOffered: merged.services.offered.length,
      redirectCount: merged.migration?.redirectMap?.length || 0,
    },
    confidence: merged.meta?.confidenceFlags || [],
  });

  // -----------------------------------------------------------------------
  // Phase 2f: Creative Director — emit design DNA
  // -----------------------------------------------------------------------
  // CLEAN PATH (Step 5 + 6): plan content (deterministic placement) + assemble
  // layout (archetype-authoritative variants, brand-owned tokens, deterministic
  // image binding). Replaces the legacy Creative Director. `director` keeps its
  // { dna } shape so downstream (writeDesignDna / generateSections) is unchanged.
  let director = null;
  let contentPlan = null;
  let binding = null;
  if (process.env.ANTHROPIC_API_KEY && brandDna) {
    console.log('[Phase 2e/2f] Plan content + assemble layout (clean path)...');
    try {
      // Faithful mimicry: place ALL the practice's content (reorganize/optimize,
      // never omit). No provider-status classification — whoever the practice
      // features on their own site, we feature. The practice already made the
      // editorial decisions; our job is to reproduce them, not re-derive them.
      contentPlan = planContent(merged);
      const res = await assembleLayout({ merged, contentPlan, brandDna });
      director = { dna: res.dna, _meta: res.meta || {} };
      binding = res.binding;
      if (referenceEntry) {
        // The entry's hand-curated variant map replaces the archetype bundle
        // ("each reference is its own archetype") — section order stays
        // content-plan owned.
        applyReferenceToDirector(director.dna, referenceEntry);
        console.log(`  Reference:  variant map ← ${referenceEntry.id} (${Object.values(referenceEntry.layout.variants).join(', ')})`);
      }
      console.log(`  Archetype:  ${res.dna.archetype}`);
      console.log(`  Sections:   ${res.dna.sectionOrder.join(' → ')}`);
      await artifacts.writeStep('05-assemble', {
        input: { pages: contentPlan.pages?.length || 0, fonts: `${brandDna?.typography?.headingFont}/${brandDna?.typography?.bodyFont}` },
        output: res.dna,
        _meta: res.meta || {},
      });
      console.log('  Assemble artifact written.');
    } catch (err) {
      console.warn(`  Assemble layout failed: ${err.message}`);
      director = null;
    }
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Phase 3: Inject template + generate pages + blog stubs + images
  // -----------------------------------------------------------------------
  console.log('[Phase 3] Building project...');
  const buildStart = Date.now();

  // 3a — Copy starter template and inject practice data
  console.log('  Injecting template...');
  await injectTemplate(merged, outputDir, preset, design);
  console.log('  Template injected.');

  // 3a-bis — Write design DNA (after template clone)
  if (director) {
    await writeDesignDna(director.dna, outputDir);
    await injectGlobalCss(director.dna, outputDir);
    console.log(`  Global CSS injected (radius: ${director.dna.radius}, density: ${director.dna.density}).`);
    console.log('  Design DNA written to src/config/design-dna.ts');
  }

  // 3b — Generate individual service pages (one per scraped service)
  console.log('  Generating pages...');
  const pageResult = await generatePages({ ...merged, bronze }, outputDir, preset, contentPlan);

  // 3b-bis — Generate redirect file from migration map
  const redirectMap = merged?.migration?.redirectMap || [];
  if (redirectMap.length > 0) {
    try {
      const { writeFile: wf } = await import('node:fs/promises');
      const { resolve: res } = await import('node:path');
      // Cloudflare Pages / Netlify _redirects format
      const lines = redirectMap
        .filter(r => r.from && r.to)
        .map(r => `${r.from}  ${r.to}  301`);
      await wf(res(outputDir, 'public', '_redirects'), lines.join('\n') + '\n', 'utf8');
      console.log(`  Wrote ${lines.length} redirect(s) to public/_redirects`);
      stats.redirectCount = lines.length;
    } catch (err) {
      console.warn(`  Redirect file write failed (non-fatal): ${err.message}`);
    }
  }

  // 3c — Generate blog stubs
  console.log('  Generating blog stubs...');
  stats.blogStubs = await generateBlogStubs({ ...merged, bronze }, outputDir, preset);

  // 3c-bis — Generate llms.txt + .well-known/webmcp.json for Lighthouse Agentic Browsing
  try {
    const { navLinks: resolvedNav } = await import(resolve(outputDir, 'src/config/navigation.ts')).catch(() => ({ navLinks: [] }));
    const agentFileResult = await generateAgentFiles(merged, resolvedNav || [], outputDir);
    stats.agentFilesGenerated = true;
    stats.agentFilesTools = agentFileResult.toolCount;
  } catch (err) {
    console.warn(`  Agent files (llms.txt/webmcp.json): ${err.message}`);
    // Generate with nav from merged data as fallback
    try {
      const fallbackNav = (merged.navigation?.primary || merged.navigation || []).map(item => ({
        label: item.label || item.name || '',
        href:  item.href  || item.url  || '/',
        dropdown: item.children || item.dropdown || null,
      }));
      await generateAgentFiles(merged, fallbackNav, outputDir);
      stats.agentFilesGenerated = true;
    } catch (innerErr) {
      console.warn(`  Agent files fallback also failed: ${innerErr.message}`);
      stats.agentFilesGenerated = false;
    }
  }

  // 3c-ter — Ensure image alt text before download (a11y)
  if (!opts.skipImages && merged?.images) {
    try {
      const { ensureImageAlts } = await import('./lib/ensure-image-alts.js');
      const altCtx = {
        practiceName: merged.practice?.name,
        city: merged.address?.city || merged.practice?.city,
      };
      const altStats = ensureImageAlts(merged.images, altCtx);
      if (altStats.filled > 0) {
        console.log(`  Alt text: filled ${altStats.filled} missing description(s).`);
      }
    } catch (err) {
      console.warn(`  Alt text enrichment failed: ${err.message}`);
    }
  }

  // 3d — Download images (unless --skip-images)
  if (!opts.skipImages) {
    console.log('  Downloading images...');
    stats.imagesDownloaded = await downloadImages(merged, outputDir, runStorage);
    console.log(`  Downloaded ${stats.imagesDownloaded} image(s).`);
  } else {
    console.log('  Skipping image download (--skip-images).');
  }

  // 3e-pre — Enrich sidecar alt text BEFORE writing image-roles.json
  // so the alts map includes role-based fallbacks for anything scrape missed.
  const altCtx = {
    practiceName: merged.practice?.name,
    city: merged.address?.city || merged.practice?.city,
  };
  if (!opts.skipImages && stats.imagesDownloaded > 0) {
    try {
      const { enrichSidecarAlts } = await import('./lib/ensure-image-alts.js');
      const { readFileSync: rf, writeFileSync: wf, existsSync: ex } = await import('node:fs');
      const sidecarPath = resolve(outputDir, 'public/images/image-source.json');
      if (ex(sidecarPath)) {
        const sidecar = JSON.parse(rf(sidecarPath, 'utf-8'));
        const { filled } = enrichSidecarAlts(sidecar, altCtx);
        if (filled > 0) {
          wf(sidecarPath, JSON.stringify(sidecar, null, 2));
          console.log(`  Sidecar alts: filled ${filled} missing.`);
        }
      }
    } catch (err) {
      console.warn(`  Sidecar alt enrichment failed: ${err.message}`);
    }
  }

  // 3e — Image roles from the deterministic BINDING (replaces the Vision pass).
  // The binding already has roles + portraits (incl. bio-page join) + per-page
  // service images from the normalized items[]; the bridge maps its source URLs →
  // the downloaded local paths via the downloader's image-source.json sidecar.
  // Declared in outer scope so Phase 5 (missing-page report) can read .roles.unused.
  let imageRolesResult = null;
  if (!opts.skipImages && binding) {
    console.log('  Mapping image roles from binding (deterministic)...');
    try {
      const { readFileSync: rf, writeFileSync: wf, existsSync: ex } = await import('node:fs');
      const sidecarPath = resolve(outputDir, 'public/images/image-source.json');
      const sidecar = ex(sidecarPath) ? JSON.parse(rf(sidecarPath, 'utf-8')) : {};
      const baseUrl = merged.practice?.domain
        ? (/^https?:\/\//i.test(merged.practice.domain) ? merged.practice.domain : `https://${merged.practice.domain}`)
        : null;
      const roles = bindingToImageRoles(binding, sidecar, baseUrl, altCtx);
      imageRolesResult = { roles }; // hoist into outer scope for Phase 5
      wf(resolve(outputDir, 'public/images/image-roles.json'), JSON.stringify(roles, null, 2));
      console.log(`  Image roles: hero=${roles.hero ? '✓' : '✗'} portraits=${Object.keys(roles.doctorPortraits || {}).length} gallery=${(roles.gallery || []).length} servicePages=${Object.keys(roles.byPage || {}).length} alts=${Object.keys(roles.alts || {}).length}`);
      await artifacts.writeStep('09-image-roles', { output: roles });
    } catch (err) {
      console.warn(`  Image-roles bridge failed: ${err.message}`);
    }
  }

  // 3f — Gallery page inject (uses enriched sidecar for alt text)
  if (!opts.skipImages && stats.imagesDownloaded > 0) {
    console.log('  Applying a11y optimizations...');
    try {
      const { runA11yOptimize } = await import('./lib/a11y-optimize.js');
      const a11yOpt = await runA11yOptimize(outputDir, {
        practice: {
          name: merged.practice?.name,
          city: merged.address?.city || merged.practice?.city,
        },
      });
      if (a11yOpt.sidecarFilled > 0) {
        console.log(`  Sidecar alts: filled ${a11yOpt.sidecarFilled} missing.`);
      }
      if (a11yOpt.galleryInjected) {
        console.log(`  Gallery page: injected ${a11yOpt.galleryCount} image(s) with alt text.`);
      }
    } catch (err) {
      console.warn(`  A11y optimize failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 3.5: Generate unique section components via AI (Atomic Design)
  //
  // Stage 1 (DNA) is already done above.
  // Stage 2 (Molecules) + Stage 3 (Organisms) run inside generateSections.
  // The homepage dispatcher (`src/pages/index.astro`) statically imports every
  // section component, so no template-assembly step is needed — generation just
  // overwrites the stub component files.
  // -----------------------------------------------------------------------
  if (!opts.skipGenerate && process.env.ANTHROPIC_API_KEY && director) {
    console.log('[Phase 3.5] Generating unique section components (atomic design)...');
    try {
      const { generateSections } = await import('./lib/generate-sections.js');
      const practiceForSections = {
        name:               merged?.practice?.name               || '',
        doctor:             merged?.doctor?.name                 || '',
        city:               merged?.address?.city                || '',
        phone:              merged?.practice?.phone              || '',
        address:            [merged?.address?.street, merged?.address?.city, merged?.address?.state].filter(Boolean).join(', '),
        googleProfileLink:  merged?.practice?.googleProfileLink  || null,
        googleReviewLink:   merged?.practice?.googleReviewLink   || null,
        yelpUrl:            merged?.practice?.yelpUrl            || null,
        facebookUrl:        merged?.practice?.facebookUrl        || null,
      };
      const genResult = await generateSections(director.dna, practiceForSections, merged, bronze, outputDir);
      console.log(`  Generated: ${genResult.generated.join(', ')}`);
      if (genResult.errors.length > 0) {
        for (const e of genResult.errors) console.warn(`  Skipped: ${e}`);
      }
      // Stash validator issues so the missing-page step can render them later.
      stats.generationIssues = genResult.validationIssues || [];

      // Link scrub — auto-fix known bad hrefs before the build runs.
      // Catches anything the generator snuck in despite route constraints.
      const { scrubLinks } = await import('./lib/link-scrub.js');
      const scrub = await scrubLinks(outputDir);
      if (scrub.fixed.length > 0) {
        console.log(`  Link scrub: auto-fixed ${scrub.fixed.length} bad href(s):`);
        for (const f of scrub.fixed) console.log(`    ${f.from} → ${f.to}  (${f.file})`);
      }
      if (scrub.flagged.length > 0) {
        console.log(`  Link scrub: ${scrub.flagged.length} unknown href(s) need review:`);
        for (const f of scrub.flagged) console.log(`    ${f.href}  (${f.file})`);
      }

      if (!opts.skipBuild && genResult.generated.length > 0) {
        console.log('  Rebuilding with generated components...');
        try {
          const { execSync } = await import('node:child_process');
          // Install deps first if node_modules doesn't exist yet
          const { existsSync } = await import('node:fs');
          if (!existsSync(`${outputDir}/node_modules`)) {
            console.log('  Installing dependencies before rebuild...');
            execSync('npm install --silent', { cwd: outputDir, stdio: 'pipe', timeout: 120_000 });
          }
          execSync('npm run build', { cwd: outputDir, stdio: 'pipe', timeout: 120_000 });
          console.log('  Rebuild succeeded.');
        } catch (rebuildErr) {
          const msg = rebuildErr.stderr?.toString().slice(-800) || rebuildErr.message;
          console.warn(`  Rebuild after generation failed:\n${msg}`);
        }
      }
    } catch (err) {
      console.warn(`  Phase 3.5 failed (non-fatal): ${err.message}`);
    }
    console.log('');
  } else if (opts.skipGenerate) {
    console.log('[Phase 3.5] Skipping AI generation (--skip-generate).');
    console.log('');
  }

  // Write inject + pages artifact
  await artifacts.writeStep('07-inject', {
    output: {
      filesInjected: ['site.ts', 'navigation.ts', 'tailwind.config.mjs', 'astro.config.mjs'],
    },
  }, buildStart);

  await artifacts.writeStep('08-pages', {
    output: {
      servicesOffered: merged.services.offered.length,
      pagesRemoved: pageResult?.removed || 0,
      blogStubs: stats.blogStubs,
      imagesDownloaded: stats.imagesDownloaded,
    },
  });

  console.log('');

  // -----------------------------------------------------------------------
  // Phase 4: Validate build (unless --skip-build)
  // -----------------------------------------------------------------------
  if (!opts.skipBuild) {
    console.log('[Phase 4] Validating build...');
    const validateStart = Date.now();
    const validation = await validate(outputDir);
    stats.buildSuccess = validation.buildSuccess;
    stats.placeholders = validation.placeholders;
    stats.brokenLinks  = validation.brokenLinks || [];
    if (validation.errors.length > 0) {
      stats.errors.push(...validation.errors);
    }

    // Post-build integrity validator: section presence, broken images,
    // broken internal links. Catches silent-failure bugs the Astro build
    // doesn't fail on (most importantly: section in sectionOrder that
    // didn't reach the rendered HTML).
    if (validation.buildSuccess && director?.dna?.sectionOrder) {
      const { validateBuild } = await import('./lib/validate-build.js');
      try {
        stats.buildIntegrity = await validateBuild(outputDir, director.dna.sectionOrder);
        if (stats.buildIntegrity.length > 0) {
          console.log(`  [build-integrity] Found ${stats.buildIntegrity.length} issue(s):`);
          for (const iss of stats.buildIntegrity.slice(0, 8)) {
            console.log(`    - ${iss.kind}: ${iss.detail.slice(0, 140)}`);
          }
        } else {
          console.log('  [build-integrity] No issues found.');
        }
      } catch (err) {
        console.warn(`  [build-integrity] Validator threw: ${err.message}`);
        stats.buildIntegrity = [];
      }
    } else {
      stats.buildIntegrity = [];
    }

    await artifacts.writeStep('09-build', {
      output: {
        buildSuccess: validation.buildSuccess,
        placeholders: validation.placeholders,
        brokenLinks:  validation.brokenLinks || [],
        errors: validation.errors,
        buildIntegrity: stats.buildIntegrity,
      },
    }, validateStart);

    console.log('');
  } else {
    console.log('[Phase 4] Skipping build validation (--skip-build).');
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Phase 4.5: Designer Agent loop (observe → critique → act → rebuild)
  // Runs only when: build succeeded, API key present, and --agent flag set
  // (or GROUNDWORK_AGENT=1 env var). Safe to skip on linear runs.
  // -----------------------------------------------------------------------
  let agentResult = null;
  const runAgent = (opts.agent || process.env.GROUNDWORK_AGENT === '1')
    && stats.buildSuccess
    && !!process.env.ANTHROPIC_API_KEY;

  if (runAgent) {
    console.log('[Phase 4.5] Designer Agent loop starting...');
    const practice = {
      name:   merged?.practice?.name || '',
      city:   merged?.address?.city  || '',
      doctor: merged?.doctor?.name   || '',
    };
    try {
      agentResult = await runDesignerAgent({
        projectDir: outputDir,
        dna:        director?.dna || null,
        practice,
        maxIterations: parseInt(opts.agentIterations || '6', 10),
        buildFn: buildAstro,
        // Catalog builds: auditors become fidelity-QA for the reference —
        // sanctioned taste patterns suppressed, fidelityChecks gate the loop.
        referenceAudit: referenceEntry?.audit || null,
      });
      stats.agentGatePass = agentResult.gate_pass;
      stats.agentIterations = agentResult.iterations;
      const agentDims = ['typography','color_contrast','spatial_layout','information_hierarchy','craft','ux_writing'];
      const humanDims = ['imagery','distinctiveness','trust_signals'];
      const finalDims = agentResult.finalScore?.dimensions || {};

      // Agent gate summary
      const agentScores = agentDims.map(d => {
        const val = finalDims[d]?.score ?? finalDims[d] ?? '?';
        return `${d.slice(0,6)}:${val}`;
      }).join(' ');
      console.log(`  Agent: ${agentResult.iterations} iter · gate=${agentResult.gate_pass} · score=${agentResult.finalScore?.overall}`);
      console.log(`  Dims:  ${agentScores}`);

      // Human gate — extract gripes and surface as action items
      const actionItems = [];
      for (const dim of humanDims) {
        const dimData = finalDims[dim];
        const score = dimData?.score ?? dimData ?? null;
        if (score !== null && score < 7) {
          const gripes = dimData?.gripes || [];
          actionItems.push({ dim, score, gripes });
        }
      }

      if (actionItems.length > 0) {
        console.log('');
        console.log('  ┌─ Action items (require your input before handoff) ─────────────');
        for (const item of actionItems) {
          const label = item.dim === 'imagery' ? 'Imagery'
            : item.dim === 'distinctiveness' ? 'Distinctiveness'
            : 'Trust Signals';
          console.log(`  │  ⚠  ${label} (${item.score}/10)`);
          for (const gripe of item.gripes.slice(0, 2)) {
            console.log(`  │     · ${gripe.slice(0, 100)}${gripe.length > 100 ? '…' : ''}`);
          }
        }
        console.log('  └────────────────────────────────────────────────────────────────');
      }
      await artifacts.writeStep('10-agent', { output: agentResult }, Date.now());
    } catch (err) {
      console.warn(`  Designer Agent failed: ${err.message}`);
    }
    console.log('');
  } else if (opts.agent) {
    console.log('[Phase 4.5] Designer Agent skipped (build not successful or no API key).');
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Phase 4.6: SEO & AI-discoverability QC
  // -----------------------------------------------------------------------
  // Walks built dist/ and scores every notable page on traditional SEO and
  // AI/LLM discoverability lenses. Deterministic checks on every page; AI
  // evaluation on a sampled subset (homepage + one service detail + one
  // blog post + about). Output flows into the missing report.
  if (stats.buildSuccess) {
    console.log('[Phase 4.6] Running SEO audit...');
    const seoStart = Date.now();
    try {
      const { auditSeo } = await import('./lib/ai-seo-audit.js');
      const seoReport = await auditSeo(outputDir, { merged });
      stats.seoReport = seoReport;
      console.log(`  Pages scored: ${seoReport.pageCount}`);
      console.log(`  Overall: ${seoReport.overall}/10 · Traditional: ${seoReport.byLens.traditional}/10 · AI: ${seoReport.byLens.ai}/10`);
      if (seoReport.topIssues.length > 0) {
        console.log(`  Top issues (${seoReport.issueCount} total):`);
        for (const iss of seoReport.topIssues.slice(0, 5)) {
          console.log(`    - [${iss.score}/10] ${iss.dimension} on ${iss.url}: ${iss.issue.slice(0, 110)}`);
        }
      }
      await artifacts.writeStep('11-seo-audit', { output: seoReport }, seoStart);
      console.log('');
    } catch (err) {
      console.warn(`  SEO audit failed: ${err.message}`);
      stats.seoReport = null;
      console.log('');
    }
  }

  // -----------------------------------------------------------------------
  // Phase 4.65: Accessibility audit (axe-core via Playwright)
  // -----------------------------------------------------------------------
  // Walks the built dist/ in a real browser and runs axe-core's WCAG 2.1 AA
  // ruleset. Catches a11y violations static HTML checks can't (color contrast,
  // focus visibility, ARIA misuse, computed-style problems). Zero AI cost.
  if (stats.buildSuccess) {
    console.log('[Phase 4.65] Accessibility audit (axe-core)...');
    const a11yStart = Date.now();
    try {
      const { auditA11y } = await import('./lib/a11y-audit.js');
      stats.a11yReport = await auditA11y(outputDir);
      const r = stats.a11yReport;
      const c = r.byImpact || {};
      console.log(`  Pages audited: ${r.pageCount} · ${r.violationCount} violation(s)`);
      console.log(`  By impact: critical=${c.critical || 0} serious=${c.serious || 0} moderate=${c.moderate || 0} minor=${c.minor || 0}`);
      if ((r.topIssues || []).length > 0) {
        console.log('  Top issues:');
        for (const iss of r.topIssues.slice(0, 5)) {
          console.log(`    - [${iss.impact}] ${iss.id}: ${iss.help} (${iss.occurrences}× on ${iss.pages.length} page(s))`);
        }
      }
      if ((c.critical || 0) + (c.serious || 0) > 0) {
        console.warn(`  ⚠ Ship gate: axe critical/serious must be 0 before handoff (see BUILD_BEST_PRACTICES.md §10)`);
      }
      await artifacts.writeStep('11b-a11y-audit', { output: r }, a11yStart);
      console.log('');
    } catch (err) {
      console.warn(`  A11y audit failed: ${err.message}`);
      stats.a11yReport = null;
      console.log('');
    }
  }

  // -----------------------------------------------------------------------
  // Phase 4.66: Agentic Browsing audit (deterministic file/HTML checks)
  // -----------------------------------------------------------------------
  if (stats.buildSuccess || stats.agentFilesGenerated) {
    console.log('[Phase 4.66] Agentic Browsing audit...');
    const agenticStart = Date.now();
    try {
      const { runAgenticAudit } = await import('./lib/audit-agentic.js');
      const agenticReport = await runAgenticAudit(outputDir);
      stats.agenticReport = agenticReport;
      const icons = agenticReport.results.map(r => `${r.pass ? '✓' : '✗'} ${r.id}`).join('  ');
      console.log(`  Score: ${agenticReport.fraction} checks pass`);
      console.log(`  ${icons}`);
      if (agenticReport.passed < agenticReport.total) {
        const failures = agenticReport.results.filter(r => !r.pass);
        for (const f of failures) {
          console.warn(`  ✗ ${f.title}: ${f.detail}`);
        }
      }
      await artifacts.writeStep('11c-agentic-audit', { output: agenticReport }, agenticStart);
      console.log('');
    } catch (err) {
      console.warn(`  Agentic audit failed: ${err.message}`);
      console.log('');
    }
  }

  // -----------------------------------------------------------------------
  // Phase 4.67: Lighthouse agentic-browsing CLI (live preview of dist/)
  // -----------------------------------------------------------------------
  if (stats.buildSuccess) {
    console.log('[Phase 4.67] Agentic-browsing audit (Lighthouse CLI)...');
    const lhAgenticStart = Date.now();
    try {
      const { runAgenticBrowsingAuditOnProject } = await import('./lib/agentic-browsing-audit.js');
      const agenticLhResult = await runAgenticBrowsingAuditOnProject(outputDir);
      stats.agenticLhReport = agenticLhResult;
      const ratio = agenticLhResult.passRatio;
      const llmsLabel = agenticLhResult.llmsTxtStatus === 'good' ? 'good'
        : agenticLhResult.llmsTxtStatus === 'poor' ? 'present but subpar'
          : agenticLhResult.llmsTxtStatus === 'absent' ? 'missing' : 'not checked';
      console.log(`  llms.txt: ${llmsLabel}${ratio ? ` · checks ${ratio.passed}/${ratio.total}` : ''}`);
      await artifacts.writeStep('11c-agentic-browsing', { output: agenticLhResult }, lhAgenticStart);
      console.log('');
    } catch (err) {
      console.warn(`  Agentic-browsing audit failed: ${err.message}`);
      stats.agenticLhReport = null;
      console.log('');
    }
  }

  // -----------------------------------------------------------------------
  // Phase 4.68: AI Citability audit
  // -----------------------------------------------------------------------
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('[Phase 4.68] AI Citability audit...');
    const citStart = Date.now();
    try {
      const { runAiCitabilityAudit } = await import('./lib/audit-ai-citability.js');
      const citReport = await runAiCitabilityAudit(merged);
      stats.citabilityReport = citReport;
      if (citReport.skipped) {
        console.log(`  Skipped: ${citReport.reason}`);
      } else {
        const icons = citReport.results.map(r => `${r.mentioned ? '✓' : '✗'} ${r.model}`).join('  ');
        console.log(`  ${citReport.fraction} LLMs mentioned ${citReport.practiceName}: ${icons}`);
      }
      await artifacts.writeStep('11d-ai-citability', { output: citReport }, citStart);
      console.log('');
    } catch (err) {
      console.warn(`  AI citability audit failed: ${err.message}`);
      console.log('');
    }
  }

  // -----------------------------------------------------------------------
  // Phase 4.7: SEO Optimizer loop — iteratively apply fixes
  // -----------------------------------------------------------------------
  // Mirrors the Designer Agent loop pattern: optimize → rebuild → re-audit
  // until a gate is met. Each iteration applies the highest-leverage fixes
  // the optimizer finds (deterministic auto-fixes + capped AI rewrites);
  // intermediate audits skip AI evaluation to keep cost down. After the
  // final iteration, one full audit (with AI eval) captures the final
  // state for downstream reports.
  if (!opts.skipSeoOptimize && stats.buildSuccess && stats.seoReport && process.env.ANTHROPIC_API_KEY) {
    const MAX_ITERATIONS = 3;
    const TARGET_OVERALL = 9.0;
    const MIN_DELTA      = 0.1;

    console.log(`[Phase 4.7] SEO optimizer loop (up to ${MAX_ITERATIONS} iterations, gate ${TARGET_OVERALL}/10)`);
    const optStart = Date.now();
    const iterations = [];
    const allApplied = [];
    let stopReason = null;
    let lastReport = stats.seoReport;

    try {
      const { optimizeSeo } = await import('./lib/skill-seo-optimize.js');
      const { auditSeo }     = await import('./lib/ai-seo-audit.js');

      for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        const beforeOverall = lastReport.overall;
        const beforeIssues  = lastReport.issueCount;

        // Gate: already at target?
        if (beforeOverall >= TARGET_OVERALL) {
          stopReason = `score ${beforeOverall}/10 ≥ target ${TARGET_OVERALL}/10`;
          console.log(`  Iteration ${iter}: ${stopReason} — stopping.`);
          break;
        }

        console.log(`  Iteration ${iter}/${MAX_ITERATIONS} (current: ${beforeOverall}/10, ${beforeIssues} issues)`);

        // Optimize
        const optResult = await optimizeSeo({ outputDir, seoReport: lastReport, merged, fixWorklist });
        const fixedCount = optResult.applied.filter(a => a.status === 'fixed').length;
        allApplied.push(...optResult.applied.map(a => ({ ...a, iteration: iter })));

        if (fixedCount === 0) {
          stopReason = 'no fixable issues remain';
          console.log(`    ${stopReason} — stopping.`);
          iterations.push({ iter, beforeOverall, afterOverall: beforeOverall, delta: 0, fixedCount: 0, stopReason });
          break;
        }

        for (const a of optResult.applied.filter(a => a.status === 'fixed')) {
          console.log(`    ✓ [${a.fix}] ${a.url} — ${a.detail || ''}`);
        }

        // Rebuild
        const validation = await validate(outputDir);
        if (!validation.buildSuccess) {
          stopReason = 'rebuild failed';
          console.warn(`    ${stopReason} — stopping.`);
          iterations.push({ iter, beforeOverall, afterOverall: beforeOverall, delta: 0, fixedCount, stopReason });
          break;
        }

        // Re-audit (deterministic-only to keep cost down between iterations;
        // a full audit with AI eval runs once at the end if any iteration applied fixes).
        const newReport = await auditSeo(outputDir, { merged, aiEvaluation: false });
        const delta = +(newReport.overall - beforeOverall).toFixed(1);
        console.log(`    Score: ${beforeOverall}/10 → ${newReport.overall}/10 (Δ ${delta >= 0 ? '+' : ''}${delta}) · issues ${beforeIssues}→${newReport.issueCount}`);

        iterations.push({ iter, beforeOverall, afterOverall: newReport.overall, delta, fixedCount });
        lastReport = newReport;

        // Diminishing returns?
        if (Math.abs(delta) < MIN_DELTA) {
          stopReason = `delta ${delta} < ${MIN_DELTA}, diminishing returns`;
          console.log(`    ${stopReason} — stopping.`);
          break;
        }
      }

      // Final full audit with AI eval — only if we actually applied fixes,
      // and only once. The intermediate audits had AI eval off to save cost.
      const totalFixed = iterations.reduce((sum, it) => sum + (it.fixedCount || 0), 0);
      if (totalFixed > 0) {
        console.log('  Running final full audit with AI evaluation...');
        const finalReport = await auditSeo(outputDir, { merged, aiEvaluation: true });
        stats.seoReport = finalReport;
        console.log(`  Final: ${finalReport.overall}/10 (Traditional ${finalReport.byLens.traditional}, AI ${finalReport.byLens.ai}) · ${finalReport.issueCount} issues`);
      }

      // Persist artifacts. 11-seo-audit.json gets overwritten with the
      // post-optimization snapshot so every downstream report sees the
      // final state.
      await artifacts.writeStep('11-seo-audit', { output: stats.seoReport }, optStart);
      await artifacts.writeStep('12-seo-optimize', {
        output: {
          iterations,
          applied: allApplied,
          totalFixedCount: totalFixed,
          startingOverall: iterations[0]?.beforeOverall ?? stats.seoReport.overall,
          finalOverall: stats.seoReport.overall,
          totalDelta: +(stats.seoReport.overall - (iterations[0]?.beforeOverall ?? stats.seoReport.overall)).toFixed(1),
          stopReason: stopReason || `reached max iterations (${MAX_ITERATIONS})`,
        },
      }, optStart);
      console.log('');
    } catch (err) {
      console.warn(`  SEO optimizer failed: ${err.message}`);
      console.log('');
    }
  }

  // -----------------------------------------------------------------------
  // Phase 5: Generate "What's Missing" page
  // -----------------------------------------------------------------------
  console.log('[Phase 5] Generating "What\'s Missing" page...');
  try {
    // Build the validation payload for the missing report. This is the channel
    // for "things the operator should know that aren't already in items.*":
    //   - placeholders     : leftover [PLACEHOLDER] tokens in built files
    //   - generationIssues : post-generation validator findings (broken refs)
    //   - buildIntegrity   : post-build validator findings (section presence,
    //                        broken images/links in dist)
    //   - coverage         : director-time decisions to drop a section that
    //                        had data we *almost* had enough of
    //   - unusedImages     : photos downloaded but not assigned to a role
    const validationPayload = {
      placeholders: opts.skipBuild ? [] : (stats.placeholders || []),
      generationIssues: stats.generationIssues || [],
      buildIntegrity: stats.buildIntegrity || [],
      coverage: director?.dna?.coverage || null,
      unusedImages: imageRolesResult?.roles?.unused || [],
      seo: stats.seoReport || null,
      a11y: stats.a11yReport || null,
      agentic: stats.agenticReport || null,
    };
    // Whether to ship /missing as a route in the deployed site. Defaults to
    // OFF — the page contains internal debug info (missing fields, broken
    // refs, coverage gaps) that real visitors should never see. Operators
    // can opt in via --include-debug-pages or INCLUDE_DEBUG_PAGES=true.
    const includeAstroPage = !!(opts.includeDebugPages || process.env.INCLUDE_DEBUG_PAGES === 'true');
    const missingResult = await generateMissingPage(
      merged,
      outputDir,
      validationPayload,
      bronze?.imageAnalysis || null,
      { includeAstroPage }
    );
    stats.missingCritical = missingResult.summary.critical;
    stats.missingImportant = missingResult.summary.important;
    console.log(`  Missing: ${missingResult.summary.critical} critical, ${missingResult.summary.important} important, ${missingResult.summary.optional} optional`);
    if (includeAstroPage) {
      console.log('  Missing page written to src/pages/missing.astro and _pipeline/missing.html');
    } else {
      console.log('  Missing report written to _pipeline/missing.html (operator-only — /missing route not built into dist)');
    }

    // If we opted in to /missing as a deployable route, rebuild so it lands in dist.
    if (includeAstroPage && !opts.skipBuild && stats.buildSuccess) {
      try {
        const { execSync } = await import('node:child_process');
        console.log('  Rebuilding to include /missing in dist...');
        execSync('npm run build', { cwd: outputDir, stdio: 'pipe', timeout: 120_000 });
        console.log('  Rebuild complete — /missing is now live.');
      } catch (rebuildErr) {
        const msg = rebuildErr.stderr?.toString().slice(-400) || rebuildErr.message;
        console.warn(`  Final rebuild failed (missing.html artifact still works): ${msg}`);
      }
    }
  } catch (err) {
    console.warn(`  Could not generate missing page: ${err.message}`);
  }
  console.log('');

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('='.repeat(56));
  console.log('  BUILD SUMMARY');
  console.log('='.repeat(56));
  console.log('');
  console.log(`  Practice:     ${stats.practiceName}`);
  console.log(`  Doctor:       ${stats.doctorName}`);
  console.log(`  Phone:        ${stats.phone}`);
  console.log(`  Services:     ${stats.servicesCount}`);
  console.log(`  Output:       ${outputDir}`);
  console.log('');
  console.log(`  Blog stubs:   ${stats.blogStubs}`);
  console.log(`  Images:       ${stats.imagesDownloaded}`);
  console.log(`  AI Design:    ${stats.hasDesign ? 'done' : 'skipped'}`);
  console.log(`  AI Content:   ${stats.hasContent ? 'done' : 'skipped'}`);
  console.log(`  Missing:      ${stats.missingCritical} critical / ${stats.missingImportant} important`);
  console.log(`  Build:        ${stats.buildSuccess ? 'PASSED' : opts.skipBuild ? 'SKIPPED' : 'FAILED'}`);
  if (stats.existingAgenticScore) {
    console.log(`  Agentic (before): ${stats.existingAgenticScore}`);
  }
  if (stats.agenticReport) {
    const ar = stats.agenticReport;
    const icons = ar.results.map(r => r.pass ? '✓' : '✗').join('');
    console.log(`  Agentic (after):  ${ar.fraction} [${icons}] llms.txt · WebMCP · A11y · CLS`);
  }
  if (stats.citabilityReport && !stats.citabilityReport.skipped) {
    const cr = stats.citabilityReport;
    const icons = cr.results.map(r => `${r.mentioned ? '✓' : '✗'}${r.model[0].toUpperCase()}`).join(' ');
    console.log(`  AI Cited:     ${cr.fraction} [${icons}] in "${cr.city}" for "${cr.topService}"`);
  }
  console.log(`  Time:         ${elapsed}s`);

  // Cost & token usage across all AI calls in this build
  try {
    const { getCostLedger } = await import('./lib/ai-call.js');
    const ledger = getCostLedger();
    if (ledger.callCount > 0) {
      console.log(`  AI calls:     ${ledger.callCount} · ${ledger.totalInputTokens.toLocaleString()} in / ${ledger.totalOutputTokens.toLocaleString()} out tokens · $${ledger.totalCost.toFixed(2)} estimated`);
      // Top 3 most expensive phases
      const byPhase = new Map();
      for (const c of ledger.calls) {
        const cur = byPhase.get(c.phase) || { count: 0, cost: 0 };
        cur.count += 1;
        cur.cost  += c.cost;
        byPhase.set(c.phase, cur);
      }
      const topPhases = [...byPhase.entries()]
        .sort((a, b) => b[1].cost - a[1].cost)
        .slice(0, 3)
        .map(([phase, info]) => `${phase} ($${info.cost.toFixed(2)}, ${info.count}×)`);
      if (topPhases.length > 0) {
        console.log(`                Top phases: ${topPhases.join(' · ')}`);
      }
      // Persist to artifact
      try {
        await artifacts.writeStep('99-cost', { output: ledger }, Date.now() - elapsed * 1000);
      } catch { /* best-effort */ }
    }
  } catch { /* ledger not available */ }

  // Confidence flags
  if (stats.confidenceFlags.length > 0) {
    console.log('');
    console.log('  Confidence flags:');
    for (const flag of stats.confidenceFlags) {
      console.log(`    - ${flag}`);
    }
  }

  // Leftover placeholders
  if (stats.placeholders.length > 0) {
    console.log('');
    console.log('  Leftover placeholders found:');
    for (const p of stats.placeholders) {
      console.log(`    - ${p.file}: ${p.pattern}`);
    }
  }

  // Broken internal links
  if (stats.brokenLinks?.length > 0) {
    console.log('');
    console.log('  ⚠  Broken internal links (404s):');
    for (const l of stats.brokenLinks) {
      console.log(`    - ${l.href}  (${l.foundIn})`);
    }
  }

  // Errors
  if (stats.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const err of stats.errors) {
      console.log(`    - ${err}`);
    }
  }

  // Next steps checklist
  console.log('');
  console.log('  Next steps:');
  console.log('  [ ] Review and edit site.ts with any missing practice info');
  console.log('  [ ] Replace placeholder images with real photos');
  console.log('  [ ] Write / expand blog post stubs (marked as draft)');
  if (stats.placeholders.length > 0) {
    console.log('  [ ] Fix leftover placeholders listed above');
  }
  if (stats.brokenLinks?.length > 0) {
    console.log('  [ ] Fix broken internal links listed above');
  }
  if (!stats.buildSuccess && !opts.skipBuild) {
    console.log('  [ ] Fix build errors and re-run: npm run build');
  }
  console.log('  [ ] Review services pages for accuracy');
  console.log('  [ ] Set up Google Analytics / Search Console');
  console.log('  [ ] Deploy to Cloudflare Pages');
  console.log('');
  console.log('='.repeat(56));
  console.log('');

  // Write final summary artifact
  await artifacts.writeSummary({
    preset: opts.preset,
    elapsed_s: parseFloat(elapsed),
    ...stats,
  });

  // Persist run record to local _memory/runs.jsonl
  try {
    const { insertRun } = await import('./lib/db.js');
    const runRow = await insertRun({
      client_slug:       clientSlug,
      gcs_prefix:        runStorage.gcsPrefix || null,
      url:               opts.url || null,
      practice_name:     stats.practiceName,
      doctor_name:       stats.doctorName,
      city:              merged?.address?.city || null,
      phone:             stats.phone,
      archetype:         director?.dna?.archetype || design?.layout?.archetype || null,
      hero_variant:      director?.dna?.heroVariant || design?.hero?.variant || null,
      font_heading:      merged?.brand?.fonts?.heading || null,
      font_body:         merged?.brand?.fonts?.body || null,
      palette_primary:   merged?.brand?.colors?.primary || null,
      palette_mood:      design?.mood || null,
      services_count:    stats.servicesCount,
      signals_count:     scraped?.signals?.length || 0,
      signals:           scraped?.signals || [],
      sections_generated: director?.dna?.sectionOrder || [],
      build_success:     stats.buildSuccess,
      duration_ms:       Math.round(parseFloat(elapsed) * 1000),
      errors:            stats.errors,
    });
    if (runRow) console.log(`  Run logged locally (id: ${runRow.id})`);
  } catch (err) {
    console.warn(`  Local run log failed: ${err.message}`);
  }

  // Auto-distill the shipped build into the design library (own-build — used
  // as anti-inspo on the next run so future sites diverge from this one).
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      // Use the canonical URL-derived slug — same key Airtable, GCS, and
      // the auto-rescan use. Previously this re-derived from practice.name,
      // which drifted from the canonical id and broke library lookups.
      await distillDesign({ source: outputDir, slug, tag: 'own', note: 'auto-distilled at build time' });
      console.log(`  Distilled build into design library as "${slug}" (own).`);
    } catch (err) {
      console.warn(`  Auto-distill skipped: ${err.message}`);
    }
  }

  // Coverage audit: compare scraped/silver data → final rebuild and flag gaps
  // (missing doctors, thinned service pages, mismatched contact info, etc.)
  try {
    const { runCoverageAudit } = await import('./lib/coverage-audit.js');
    const audit = await runCoverageAudit(outputDir);
    const auditDir = resolve(outputDir, '_pipeline');
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(resolve(auditDir, 'coverage-audit.json'), JSON.stringify({ findings: audit.findings, summary: audit.summary }, null, 2));
    await wf(resolve(auditDir, 'coverage-audit.md'), audit.markdown);
    if (audit.summary.total > 0) {
      console.log('');
      console.log(`[Coverage Audit] ${audit.summary.critical} critical · ${audit.summary.warning} warning · ${audit.summary.note} note`);
      // Print critical findings inline so they don't get lost
      for (const f of audit.findings.filter(x => x.severity === 'CRITICAL')) {
        console.log(`  🔴 ${f.check}: ${f.message}`);
      }
      for (const f of audit.findings.filter(x => x.severity === 'WARNING').slice(0, 5)) {
        console.log(`  🟡 ${f.check}: ${f.message}`);
      }
      console.log(`  Full report: ${auditDir}/coverage-audit.md`);
    } else {
      console.log('[Coverage Audit] No gaps detected ✓');
    }
  } catch (err) {
    console.warn(`  Coverage audit failed: ${err.message}`);
  }

  // Step-7 deterministic gates on the FINAL dist (after ALL rebuilds — Phase
  // 3.5/4.5/4.7/5 each rebuild, so this must run last to reflect what ships).
  // anti-slop scan + render-fidelity. Warn + flag, no hard-fail.
  if (stats.buildSuccess) {
    stats.confidenceFlags ||= [];
    try {
      const { scanAntiSlop } = await import('./lib/audit/anti-slop.js');
      const slop = scanAntiSlop(resolve(outputDir, 'dist'), resolve(outputDir, 'src/styles/global.css'));
      stats.antiSlop = slop;
      if (slop.total > 0) {
        console.log('');
        console.warn(`[Anti-Slop] ${slop.total} tell(s): ${Object.keys(slop.hits).join(', ')}`);
        stats.confidenceFlags.push(`anti-slop: ${slop.total} — ${Object.keys(slop.hits).join(', ')}`);
      } else {
        console.log('[Anti-Slop] clean ✓');
      }
    } catch (err) { console.warn(`  Anti-slop scan failed: ${err.message}`); }

    if (contentPlan) {
      try {
        const { checkRenderFidelity } = await import('./lib/audit/render-fidelity.js');
        const fid = checkRenderFidelity(contentPlan, resolve(outputDir, 'dist'));
        stats.renderFidelity = fid;
        console.log(`[Render Fidelity] verbatim ${fid.verbatim.pct}% (${fid.verbatim.found}/${fid.verbatim.total}) · optimizable ${fid.optimizable.pct}%`);
        if (fid.verbatim.pct < 99 && fid.misses.length) {
          console.warn(`  ${fid.misses.length} verbatim item(s) not found: ${fid.misses.slice(0, 3).join(' | ')}`);
          stats.confidenceFlags.push(`render-fidelity: ${fid.verbatim.pct}% verbatim (${fid.misses.length} not found)`);
        }
      } catch (err) { console.warn(`  Render-fidelity check failed: ${err.message}`); }
    }
  }

  // Content Coverage Audit: bronze-vs-final category-level diff. Catches
  // hard losses (whole team pages, multi-doctor collapses, nav shrinking,
  // informational pages vanishing) that coverage-audit.js's weaker signals
  // can miss.
  try {
    const { runContentCoverage } = await import('./lib/content-coverage.js');
    const ccc = await runContentCoverage({ slug, outputDir });
    if (ccc.summary.total > 0) {
      console.log('');
      console.log(`[Content Coverage Audit] ${ccc.summary.critical} critical · ${ccc.summary.warning} warning · ${ccc.summary.note} note`);
      for (const f of ccc.findings.filter(x => x.severity === 'CRITICAL')) {
        console.log(`  🔴 ${f.message}`);
      }
      for (const f of ccc.findings.filter(x => x.severity === 'WARNING')) {
        console.log(`  🟡 ${f.message}`);
      }
      console.log(`  Full report: ${resolve(outputDir, '_pipeline/content-coverage.md')}`);
    } else {
      console.log('[Content Coverage Audit] No category losses detected ✓');
    }
  } catch (err) {
    console.warn(`  Content coverage audit failed: ${err.message}`);
  }

  // Generate HTML reports — three views of the same data:
  //   index.html          — internal report (operator: prompts, JSON, telemetry)
  //   external-report.html — practice-facing detailed report (no internals)
  //   one-pager.html       — practice-facing pitch summary
  const pipelineDir = resolve(outputDir, '_pipeline');
  await generateReport(pipelineDir, { scraped });
  try {
    const { generateExternalReport } = await import('./lib/external-report.js');
    await generateExternalReport(pipelineDir);
  } catch (err) {
    console.warn(`  External report generation failed: ${err.message}`);
  }
  try {
    const { generateOnePager } = await import('./lib/one-pager.js');
    await generateOnePager(pipelineDir);
  } catch (err) {
    console.warn(`  One-pager generation failed: ${err.message}`);
  }
  console.log(`  Internal report:    ${pipelineDir}/index.html`);
  console.log(`  External report:    ${pipelineDir}/external-report.html`);
  console.log(`  One-pager:          ${pipelineDir}/one-pager.html`);
  console.log(`  What's Missing:     ${pipelineDir}/missing.html`);
  console.log(`  Pipeline artifacts: ${pipelineDir}/`);
  console.log('');

  // --publish: deploy site + pitch page
  if (opts.publish) {
    try {
      const { publish } = await import('./lib/publish.js');
      await publish({
        outputDir,
        slug,
        practiceUrl: opts.url || null,
        previewUrl:  null, // auto-derived from slug + GROUNDWORK_SUBDOMAIN
        gcsPrefix:   runStorage.gcsPrefix || null,
      });
    } catch (err) {
      console.warn(`[Publish] Failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('');
  console.error('Fatal error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
