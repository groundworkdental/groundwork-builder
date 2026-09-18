/**
 * Missing Page Generator
 *
 * Analyzes the merged practice data + pipeline artifacts to produce:
 *   1. A standalone _pipeline/missing.html for the human designer to review
 *   2. src/pages/missing.astro in the output site (accessible at /missing)
 *
 * The page categorizes everything the designer/client needs to provide
 * before the site can go live: images, copy, business info, etc.
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateDataFields } from '../standards/practice-contract.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the "What's Missing" page and JSON artifact.
 *
 * @param {object} merged      - Merged practice data
 * @param {string} outputDir   - Root of the generated Astro project
 * @param {object} [validation] - Build validation result (optional, for post-build placeholders)
 * @returns {object} missingData — the structured list of missing items
 */
/**
 * @param {object} merged
 * @param {string} outputDir
 * @param {object} [validation]
 * @param {object} [imageRoles]
 * @param {object} [opts]
 * @param {boolean} [opts.includeAstroPage] — when true, also writes
 *   src/pages/missing.astro so /missing is reachable in the deployed site.
 *   Defaults to false: the standalone HTML in _pipeline/missing.html is the
 *   operator's view; the deployed site does not expose internal debug routes.
 */
export async function generateMissingPage(merged, outputDir, validation = null, imageRoles = null, opts = {}) {
  const missing = analyzeMissing(merged, validation, imageRoles, opts);
  const pipelineDir = resolve(outputDir, '_pipeline');
  await mkdir(pipelineDir, { recursive: true });

  // Write JSON artifact
  await writeFile(
    resolve(outputDir, '_pipeline', 'missing.json'),
    JSON.stringify(missing, null, 2),
    'utf-8'
  );

  // Write standalone HTML for the pipeline report folder. This is the
  // operator-facing view; always produced.
  const html = buildMissingHtml(missing, merged);
  await writeFile(
    resolve(outputDir, '_pipeline', 'missing.html'),
    html,
    'utf-8'
  );

  // Optionally write the Astro page into the output site. By default we DO
  // NOT — shipping /missing to production exposes internal debug content
  // ("Doctor bio missing", "Domain not configured") to real visitors.
  // The operator can opt in with --include-debug-pages or env var.
  if (opts.includeAstroPage) {
    const astroPage = buildAstroPage(missing, merged);
    await writeFile(
      resolve(outputDir, 'src', 'pages', 'missing.astro'),
      astroPage,
      'utf-8'
    );
  } else {
    // Defensive: if a previous run left a missing.astro behind, remove it so
    // the next astro build doesn't ship a stale /missing route.
    const stalePath = resolve(outputDir, 'src', 'pages', 'missing.astro');
    try {
      await rm(stalePath);
    } catch { /* not present — fine */ }
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Analyzer — builds the structured missing items report
// ---------------------------------------------------------------------------

function analyzeMissing(merged, validation, imageRoles = null, opts = {}) {
  const practice = merged.practice || {};
  const doctor = merged.doctor || {};
  const address = merged.address || {};
  const hours = merged.hours || {};
  const content = merged.content || {};
  const images = merged.images || {};
  const brand = merged.brand || {};

  const items = {
    critical: [],     // Site cannot launch without these
    important: [],    // Should be done before launch
    optional: [],     // Nice to have
    placeholders: [], // Leftover [PLACEHOLDER] tokens from build
    generationIssues: [],   // Issues caught by post-generation validator (broken refs, etc.)
    buildIntegrity: [],     // Post-build issues: missing sections, broken images/links
    coverageGaps: [],       // Sections the director dropped due to insufficient data
    unusedImages: [],       // Photos downloaded but not assigned to any role
    seoIssues: [],          // SEO audit findings — actionable items per page
    a11yIssues: [],         // Accessibility audit findings (axe-core)
  };

  // ── Critical: the copy itself ────────────────────────────────────────────
  // A build that lost Content Write still renders — it just renders raw scrape
  // fallbacks. That looks finished, so it has to be stated outright.
  if (opts.contentWriteFailed) {
    items.critical.push({
      category: 'Content',
      field: 'Written copy (Content Write failed)',
      hint: 'Content Write did not complete, so page copy is raw scraped text rather than written copy. Re-run the pipeline with --skip-scrape to regenerate before shipping.',
    });
  }

  // ── Contract-driven field presence ───────────────────────────────────────
  // The list of fields, their severities and their hints live in
  // standards/practice-contract.js — the same declaration the pre-build
  // readiness gate and the onboarding checklist read. This used to be a
  // parallel hand-written list, which is how the intake form came to ask
  // for a booking URL that nothing checked for. Bespoke checks that are
  // about more than presence (stock photography, build validation, hero
  // imagery, deployment wiring) stay below.
  const contract = evaluateDataFields(merged);
  for (const field of contract.missing) {
    items[field.severity].push({
      category: field.category,
      field: field.label,
      hint: field.hint,
    });
  }

  // ── Important: Photos ────────────────────────────────────────────────────
  // Always emitted: a hero is a design requirement rather than a data field,
  // so there is nothing in the merged data to test for its absence.
  items.important.push({ category: 'Photos', field: 'Hero / banner image', hint: 'A wide, high-quality photo for the homepage hero section. Place at public/images/heroes/hero-home.jpg' });

  // ── Important: Content ────────────────────────────────────────────────────
  if (!content.heroTagline && !content.heroHeadline) {
    items.important.push({ category: 'Copy', field: 'Homepage hero headline', hint: 'Main H1 for the homepage. AI-generated copy provided in the Content section of this report — review and approve or edit.' });
  }

  // ── Optional ─────────────────────────────────────────────────────────────
  // Testimonials, gallery, social profiles and insurance now come from the
  // contract above. What remains here is stats the contract does not model
  // (they are derived, not collected) and the deployment wiring.
  if (!content.stats?.yearsExperience) {
    items.optional.push({ category: 'Social Proof', field: 'Years in practice', hint: 'How many years has the practice been open? Used in the stats bar on the homepage.' });
  }
  if (!content.stats?.googleRating) {
    items.optional.push({ category: 'Social Proof', field: 'Google rating', hint: 'Current Google star rating (e.g. 4.9). Used in social proof section.' });
  }
  // ── Stock image detection (from bronze.imageAnalysis — subject: 'stock') ──
  if (imageRoles && typeof imageRoles === 'object') {
    const stockEntries = Object.entries(imageRoles)
      .filter(([, analysis]) => analysis?.subject === 'stock');
    const stockCount = stockEntries.length;
    if (stockCount > 0) {
      const stockNames = stockEntries.slice(0, 3)
        .map(([url]) => url.split('/').pop())
        .filter(Boolean);
      items.important.push({
        category: 'Photos',
        field: `Replace ${stockCount} stock photo${stockCount > 1 ? 's' : ''} with authentic images`,
        hint: `${stockCount} image${stockCount > 1 ? 's' : ''} on the original site appear${stockCount === 1 ? 's' : ''} to be generic stock photography. Patients can tell. Replace with real photos of the practice, team, or patients (before/after shots are highest value). Detected: ${stockNames.join(', ') || 'see Images tab in report'}`
      });
    }
  }
  // Deployment wiring. The domain itself is a contract field (Business Info)
  // rather than a deployment item — it is something the practice tells us,
  // not something we configure — so it is not repeated here.
  items.optional.push({ category: 'Deployment', field: 'Google Analytics ID', hint: 'GA4 Measurement ID (G-XXXXXXXXXX). Add to .env as PUBLIC_GA4_MEASUREMENT_ID' });
  items.optional.push({ category: 'Deployment', field: 'Cloudflare Pages project', hint: 'Set up Cloudflare Pages project and add CLOUDFLARE_API_TOKEN + project name to GitHub secrets' });

  // ── Leftover placeholders from build ─────────────────────────────────────
  if (validation?.placeholders) {
    items.placeholders = validation.placeholders;
  }

  // ── Issues caught by the post-generation validator ───────────────────────
  // These are deterministic problems the AI shipped (e.g. hardcoded image
  // src that 404s) that the validator detected but couldn't auto-fix.
  if (validation?.generationIssues?.length) {
    items.generationIssues = validation.generationIssues.map(iss => ({
      category: 'Automated validation',
      field: iss.issue,
      hint: iss.detail,
      file: iss.file,
    }));
  }

  // ── Issues caught by the post-build integrity validator ──────────────────
  if (validation?.buildIntegrity?.length) {
    items.buildIntegrity = validation.buildIntegrity.map(iss => ({
      category: 'Build integrity',
      field: iss.kind,
      hint: iss.detail,
      file: iss.file,
    }));
  }

  // ── Coverage gaps: sections the director dropped due to insufficient data ─
  // The operator may want to fix the input (e.g. add 1 more gallery photo)
  // and re-run, rather than ship without the section.
  if (validation?.coverage?.filteredSections?.length) {
    items.coverageGaps = validation.coverage.filteredSections.map(f => ({
      category: 'Coverage gap',
      field: `${f.section} section was dropped`,
      hint: f.reason,
      meta: { signal: f.signal, dataPresent: f.dataPresent, threshold: f.threshold },
    }));
  }

  // ── Unused images: downloaded but never classified into a role ───────────
  // Branding/logo files are intentionally not in the role buckets (they have
  // their own slot). Skip them — they're not actually unused.
  if (validation?.unusedImages?.length) {
    items.unusedImages = validation.unusedImages
      .filter(path => !path.startsWith('branding/'))
      .map(path => ({
        category: 'Unused asset',
        field: path,
        hint: 'Image was downloaded from the source site but not assigned to a role (hero, doctor portrait, gallery, team, interior). Either re-classify by editing public/images/image-roles.json or remove the file.',
      }));
  }

  // ── SEO audit findings: top issues from per-page rubric scoring ──────────
  // The full audit lives in `_pipeline/11-seo-audit.json`. The missing report
  // surfaces the top scored items so the operator/owner sees the highest-
  // leverage fixes.
  if (validation?.seo?.topIssues?.length) {
    items.seoIssues = validation.seo.topIssues.slice(0, 10).map(iss => ({
      category: 'SEO opportunity',
      field: `${iss.dimension} on ${iss.url}`,
      hint: iss.issue,
      meta: { score: iss.score, url: iss.url, dimension: iss.dimension },
    }));
  }

  // ── Accessibility audit findings (axe-core) ──────────────────────────────
  // Full per-page violations live in `_pipeline/11b-a11y-audit.json`. We
  // surface the top impact-ranked rules here so the operator/owner sees the
  // highest-leverage fixes.
  if (validation?.a11y?.topIssues?.length) {
    items.a11yIssues = validation.a11y.topIssues.slice(0, 10).map(iss => ({
      category: 'Accessibility',
      field: `${iss.id} (${iss.impact})`,
      hint: `${iss.help} — ${iss.occurrences} occurrence(s) across ${iss.pages.length} page(s). ${iss.helpUrl}`,
      meta: { impact: iss.impact, occurrences: iss.occurrences, pages: iss.pages },
    }));
  }

  // Ship gate: axe critical/serious violations block handoff
  const a11yImpact = validation?.a11y?.byImpact || {};
  const axeCritical = a11yImpact.critical || 0;
  const axeSerious  = a11yImpact.serious  || 0;
  if (axeCritical > 0 || axeSerious > 0) {
    const gateHint = `${axeCritical} critical and ${axeSerious} serious WCAG violation(s). Fix before handoff — guarantee requires 0 critical/serious.`;
    if (!items.critical.some(i => i.category === 'Ship Gate' && i.field === 'axe-core violations')) {
      items.critical.push({
        category: 'Ship Gate',
        field: 'axe-core violations',
        hint: gateHint,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      critical: items.critical.length,
      important: items.important.length,
      optional: items.optional.length,
      placeholders: items.placeholders.length,
      generationIssues: items.generationIssues.length,
      buildIntegrity: items.buildIntegrity.length,
      coverageGaps: items.coverageGaps.length,
      unusedImages: items.unusedImages.length,
      seoIssues: items.seoIssues.length,
      a11yIssues: items.a11yIssues.length,
    },
    ...items,
  };
}

// ---------------------------------------------------------------------------
// Astro page builder
// ---------------------------------------------------------------------------

function buildAstroPage(missing, merged) {
  const practiceName = merged.practice?.name || 'Your Practice';
  const criticalCount = missing.critical.length;
  const importantCount = missing.important.length;

  return `---
// What's Missing — generated by Groundwork Builder Pipeline
// This page is for the designer's internal review only.
// Remove or restrict access before going live.
const practiceName = ${JSON.stringify(practiceName)};
const generated = ${JSON.stringify(missing.generatedAt)};
const missing = ${JSON.stringify(missing, null, 2)};
function shortFile(p) {
  if (!p) return '';
  // Show src-relative path; strip everything before src/
  const srcIdx = p.lastIndexOf('/src/');
  if (srcIdx >= 0) return 'src/' + p.slice(srcIdx + 5);
  // Fall back: strip everything up through the last project-name segment
  return p.split('/').slice(-3).join('/');
}
---
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>What's Missing — {practiceName}</title>
  <style>
    ${missingPageStyles()}
  </style>
</head>
<body>
  <header class="page-header">
    <div class="header-inner">
      <div>
        <h1>What's Missing</h1>
        <p class="sub">{practiceName} &nbsp;·&nbsp; Designer review checklist</p>
      </div>
      <div class="header-stats">
        <span class="stat critical">{missing.summary.critical} Critical</span>
        <span class="stat important">{missing.summary.important} Important</span>
        <span class="stat optional">{missing.summary.optional} Optional</span>
      </div>
    </div>
  </header>

  <main class="main">
    <div class="notice">
      <strong>Internal use only.</strong> This page is generated for the designer's review. Remove or add access restrictions before sharing with the client or going live.
    </div>

    {missing.critical.length > 0 && (
      <section>
        <h2 class="section-title critical-title">🚨 Critical — Required Before Launch</h2>
        <div class="card-list">
          {missing.critical.map((item: any) => (
            <div class="item-card critical-card">
              <div class="item-meta">
                <span class="category-badge">{item.category}</span>
              </div>
              <strong class="item-field">{item.field}</strong>
              <p class="item-hint">{item.hint}</p>
            </div>
          ))}
        </div>
      </section>
    )}

    {missing.important.length > 0 && (
      <section>
        <h2 class="section-title important-title">⚠️ Important — Should Complete Before Launch</h2>
        <div class="card-list">
          {missing.important.map((item: any) => (
            <div class="item-card important-card">
              <div class="item-meta">
                <span class="category-badge">{item.category}</span>
              </div>
              <strong class="item-field">{item.field}</strong>
              <p class="item-hint">{item.hint}</p>
            </div>
          ))}
        </div>
      </section>
    )}

    {missing.optional.length > 0 && (
      <section>
        <h2 class="section-title optional-title">✓ Optional — Nice to Have</h2>
        <div class="card-list">
          {missing.optional.map((item: any) => (
            <div class="item-card optional-card">
              <div class="item-meta">
                <span class="category-badge">{item.category}</span>
              </div>
              <strong class="item-field">{item.field}</strong>
              <p class="item-hint">{item.hint}</p>
            </div>
          ))}
        </div>
      </section>
    )}

    {missing.placeholders.length > 0 && (
      <section>
        <h2 class="section-title placeholder-title">🔧 Leftover Placeholders in Built Files</h2>
        <table class="ph-table">
          <thead><tr><th>File</th><th>Pattern</th></tr></thead>
          <tbody>
            {missing.placeholders.map((p: any) => (
              <tr>
                <td class="mono">{p.file?.replace('dist/', '') || '—'}</td>
                <td class="mono red">{p.pattern || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    )}

    {missing.generationIssues && missing.generationIssues.length > 0 && (
      <section>
        <h2 class="section-title placeholder-title">⚠️ Issues caught by automated validation</h2>
        <p class="section-description">Problems the post-generation validator detected in AI-produced section components. These shipped despite the prompt rules and need human review or a re-run.</p>
        <ul class="item-list">
          {missing.generationIssues.map((iss: any) => (
            <li class="item">
              <strong>{iss.field}</strong>
              <div class="hint">{iss.hint}</div>
              {iss.file && <div class="mono" style="font-size: 11px; opacity: 0.7;">{shortFile(iss.file)}</div>}
            </li>
          ))}
        </ul>
      </section>
    )}

    {missing.buildIntegrity && missing.buildIntegrity.length > 0 && (
      <section>
        <h2 class="section-title placeholder-title">🚨 Build integrity issues</h2>
        <p class="section-description">Problems detected after the build completed: a section in the design didn't reach the rendered HTML, an &lt;img&gt; references a missing file, or an internal link points to a route that wasn't built.</p>
        <ul class="item-list">
          {missing.buildIntegrity.map((iss: any) => (
            <li class="item">
              <strong>{iss.field}</strong>
              <div class="hint">{iss.hint}</div>
              {iss.file && <div class="mono" style="font-size: 11px; opacity: 0.7;">{shortFile(iss.file)}</div>}
            </li>
          ))}
        </ul>
      </section>
    )}

    {missing.coverageGaps && missing.coverageGaps.length > 0 && (
      <section>
        <h2 class="section-title optional-title">📋 Coverage gaps — sections the design didn't include</h2>
        <p class="section-description">The Creative Director dropped these sections because the source data was insufficient. With more inputs from the practice, each section can be brought into the design.</p>
        <ul class="item-list">
          {missing.coverageGaps.map((g: any) => (
            <li class="item">
              <strong>{g.field}</strong>
              <div class="hint">{g.hint}</div>
            </li>
          ))}
        </ul>
      </section>
    )}

    {missing.unusedImages && missing.unusedImages.length > 0 && (
      <section>
        <h2 class="section-title optional-title">🖼️ Unused images</h2>
        <p class="section-description">These photos were downloaded from the source site but never assigned to a role. Reclassify them in <code>public/images/image-roles.json</code> or remove them.</p>
        <ul class="item-list">
          {missing.unusedImages.map((g: any) => (
            <li class="item">
              <span class="mono">{g.field}</span>
              <div class="hint">{g.hint}</div>
            </li>
          ))}
        </ul>
      </section>
    )}

    {missing.seoIssues && missing.seoIssues.length > 0 && (
      <section>
        <h2 class="section-title optional-title">🔍 Top SEO opportunities</h2>
        <p class="section-description">Highest-leverage SEO and AI-discoverability fixes from the post-build audit. Full per-page scores live in <code>_pipeline/11-seo-audit.json</code>.</p>
        <ul class="item-list">
          {missing.seoIssues.map((g: any) => (
            <li class="item">
              <strong>[{g.meta?.score}/10] {g.field}</strong>
              <div class="hint">{g.hint}</div>
            </li>
          ))}
        </ul>
      </section>
    )}

    {missing.a11yIssues && missing.a11yIssues.length > 0 && (
      <section>
        <h2 class="section-title placeholder-title">♿ Accessibility violations</h2>
        <p class="section-description">WCAG 2.1 AA violations found by axe-core. Full per-page report lives in <code>_pipeline/11b-a11y-audit.json</code>. Critical and serious issues should be fixed before launch.</p>
        <ul class="item-list">
          {missing.a11yIssues.map((g: any) => (
            <li class="item">
              <strong>{g.field}</strong>
              <div class="hint">{g.hint}</div>
            </li>
          ))}
        </ul>
      </section>
    )}

    <footer class="page-footer">
      Generated by Groundwork Builder Pipeline &nbsp;·&nbsp; {new Date(generated).toLocaleString()}
    </footer>
  </main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Standalone HTML (for _pipeline/missing.html)
// ---------------------------------------------------------------------------

export function buildMissingHtml(missing, merged) {
  const practiceName = merged.practice?.name || 'Your Practice';

  const renderItems = (items, cssClass) => items.map(item => `
    <div class="item-card ${cssClass}">
      <div class="item-meta"><span class="cat-badge">${esc(item.category)}</span></div>
      <strong class="item-field">${esc(item.field)}</strong>
      <p class="item-hint">${esc(item.hint)}</p>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>What's Missing — ${esc(practiceName)}</title>
<style>${missingPageStyles()}</style>
</head>
<body>
<header class="page-header">
  <div class="header-inner">
    <div>
      <h1>What's Missing</h1>
      <p class="sub">${esc(practiceName)} &nbsp;·&nbsp; Designer review checklist</p>
    </div>
    <div class="header-stats">
      <span class="stat critical">${missing.summary.critical} Critical</span>
      <span class="stat important">${missing.summary.important} Important</span>
      <span class="stat optional">${missing.summary.optional} Optional</span>
    </div>
  </div>
</header>

<main class="main">
  <div class="notice">
    <strong>Internal use only.</strong> This page is for the designer's review.
    Remove or add access restrictions before sharing with the client or going live.
  </div>

  ${missing.critical.length > 0 ? `
  <section>
    <h2 class="section-title critical-title">🚨 Critical — Required Before Launch</h2>
    <div class="card-list">${renderItems(missing.critical, 'critical-card')}</div>
  </section>` : ''}

  ${missing.important.length > 0 ? `
  <section>
    <h2 class="section-title important-title">⚠️ Important — Should Complete Before Launch</h2>
    <div class="card-list">${renderItems(missing.important, 'important-card')}</div>
  </section>` : ''}

  ${missing.optional.length > 0 ? `
  <section>
    <h2 class="section-title optional-title">✓ Optional — Nice to Have</h2>
    <div class="card-list">${renderItems(missing.optional, 'optional-card')}</div>
  </section>` : ''}

  ${missing.placeholders.length > 0 ? `
  <section>
    <h2 class="section-title placeholder-title">🔧 Leftover Placeholders in Built Files</h2>
    <table class="ph-table">
      <thead><tr><th>File</th><th>Pattern</th></tr></thead>
      <tbody>
        ${missing.placeholders.map(p => `<tr>
          <td class="mono">${esc(p.file?.replace('dist/', '') || '—')}</td>
          <td class="mono red">${esc(p.pattern || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>` : ''}

  ${missing.generationIssues && missing.generationIssues.length > 0 ? `
  <section>
    <h2 class="section-title placeholder-title">⚠️ Issues caught by automated validation</h2>
    <p class="section-description">Problems the post-generation validator detected in AI-produced section components. These shipped despite the prompt rules and need human review or a re-run.</p>
    <ul class="item-list">
      ${missing.generationIssues.map(iss => `
        <li class="item">
          <strong>${esc(iss.field)}</strong>
          <div class="hint">${esc(iss.hint)}</div>
          ${iss.file ? `<div class="mono" style="font-size: 11px; opacity: 0.7;">${esc(shortFile(iss.file))}</div>` : ''}
        </li>
      `).join('')}
    </ul>
  </section>` : ''}

  ${missing.buildIntegrity && missing.buildIntegrity.length > 0 ? `
  <section>
    <h2 class="section-title placeholder-title">🚨 Build integrity issues</h2>
    <p class="section-description">Problems detected after the build completed: a section in the design didn't reach the rendered HTML, an &lt;img&gt; references a missing file, or an internal link points to a route that wasn't built.</p>
    <ul class="item-list">
      ${missing.buildIntegrity.map(iss => `
        <li class="item">
          <strong>${esc(iss.field)}</strong>
          <div class="hint">${esc(iss.hint)}</div>
          ${iss.file ? `<div class="mono" style="font-size: 11px; opacity: 0.7;">${esc(shortFile(iss.file))}</div>` : ''}
        </li>
      `).join('')}
    </ul>
  </section>` : ''}

  ${missing.coverageGaps && missing.coverageGaps.length > 0 ? `
  <section>
    <h2 class="section-title optional-title">📋 Coverage gaps — sections the design didn't include</h2>
    <p class="section-description">The Creative Director dropped these sections because the source data was insufficient. With more inputs from the practice, each section can be brought into the design.</p>
    <ul class="item-list">
      ${missing.coverageGaps.map(g => `
        <li class="item">
          <strong>${esc(g.field)}</strong>
          <div class="hint">${esc(g.hint)}</div>
        </li>
      `).join('')}
    </ul>
  </section>` : ''}

  ${missing.unusedImages && missing.unusedImages.length > 0 ? `
  <section>
    <h2 class="section-title optional-title">🖼️ Unused images</h2>
    <p class="section-description">These photos were downloaded from the source site but never assigned to a role. Reclassify them in <code>public/images/image-roles.json</code> or remove them.</p>
    <ul class="item-list">
      ${missing.unusedImages.map(g => `
        <li class="item">
          <span class="mono">${esc(g.field)}</span>
          <div class="hint">${esc(g.hint)}</div>
        </li>
      `).join('')}
    </ul>
  </section>` : ''}

  ${missing.seoIssues && missing.seoIssues.length > 0 ? `
  <section>
    <h2 class="section-title optional-title">🔍 Top SEO opportunities</h2>
    <p class="section-description">Highest-leverage SEO and AI-discoverability fixes from the post-build audit. Full per-page scores live in <code>_pipeline/11-seo-audit.json</code>.</p>
    <ul class="item-list">
      ${missing.seoIssues.map(g => `
        <li class="item">
          <strong>[${esc(g.meta?.score)}/10] ${esc(g.field)}</strong>
          <div class="hint">${esc(g.hint)}</div>
        </li>
      `).join('')}
    </ul>
  </section>` : ''}

  ${missing.a11yIssues && missing.a11yIssues.length > 0 ? `
  <section>
    <h2 class="section-title placeholder-title">♿ Accessibility violations</h2>
    <p class="section-description">WCAG 2.1 AA violations found by axe-core. Full per-page report lives in <code>_pipeline/11b-a11y-audit.json</code>. Critical and serious issues should be fixed before launch.</p>
    <ul class="item-list">
      ${missing.a11yIssues.map(g => `
        <li class="item">
          <strong>${esc(g.field)}</strong>
          <div class="hint">${esc(g.hint)}</div>
        </li>
      `).join('')}
    </ul>
  </section>` : ''}

  <footer class="page-footer">
    Generated by Groundwork Builder Pipeline &nbsp;·&nbsp;
    ${new Date(missing.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
  </footer>
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

function missingPageStyles() {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --ink: #1A1A1A;
      --cream: #FAF8F5;
      --surface: #FFFFFF;
      --border: #E5E0DA;
      --red: #C0392B;
      --amber: #C07A1A;
      --green: #2E7D4F;
      --text-dim: #666259;
      --radius: 8px;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --mono: 'SFMono-Regular', 'Consolas', monospace;
    }
    body { font-family: var(--font); background: var(--cream); color: var(--ink); font-size: 14px; line-height: 1.5; }
    .page-header { background: var(--ink); color: white; padding: 20px 32px; }
    .header-inner { max-width: 1000px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .page-header h1 { font-size: 20px; font-weight: 700; }
    .page-header .sub { color: #9E9990; font-size: 13px; margin-top: 3px; }
    .header-stats { display: flex; gap: 10px; flex-wrap: wrap; }
    .stat { padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; letter-spacing: 0.3px; }
    .stat.critical  { background: #FDDCDC; color: var(--red); }
    .stat.important { background: #FEF3CD; color: #7A5014; }
    .stat.optional  { background: #D4EDD9; color: var(--green); }
    .main { max-width: 1000px; margin: 0 auto; padding: 24px 32px 48px; display: flex; flex-direction: column; gap: 32px; }
    .notice { background: #FEF9ED; border: 1px solid #F0D88A; border-radius: var(--radius); padding: 12px 16px; font-size: 13px; color: #7A5014; }
    .section-title { font-size: 15px; font-weight: 700; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid var(--border); }
    .critical-title  { color: var(--red); border-color: #FDDCDC; }
    .important-title { color: #C07A1A; border-color: #FEF3CD; }
    .optional-title  { color: var(--green); border-color: #D4EDD9; }
    .placeholder-title { color: #7A5014; border-color: #F0D88A; }
    .card-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .item-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
    .critical-card  { border-left: 3px solid var(--red); }
    .important-card { border-left: 3px solid #C07A1A; }
    .optional-card  { border-left: 3px solid var(--green); }
    .item-meta { margin-bottom: 6px; }
    .cat-badge { font-size: 10px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: var(--text-dim); background: #F0EDE8; padding: 2px 7px; border-radius: 3px; }
    .item-field { font-size: 13px; font-weight: 700; display: block; margin-bottom: 5px; }
    .item-hint { font-size: 12px; color: var(--text-dim); line-height: 1.45; }
    .ph-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .ph-table th { text-align: left; padding: 7px 10px; background: #F5F2EE; border: 1px solid var(--border); font-weight: 700; color: var(--text-dim); font-size: 11px; }
    .ph-table td { padding: 6px 10px; border: 1px solid var(--border); }
    .mono { font-family: var(--mono); font-size: 11px; }
    .red { color: var(--red); }
    .page-footer { text-align: center; font-size: 12px; color: var(--text-dim); padding-top: 16px; border-top: 1px solid var(--border); }
  `;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Trim an absolute file path down to a short, src-relative form for display.
 * Used by the standalone HTML missing report; the Astro page has its own
 * inline copy of this helper in its frontmatter.
 */
function shortFile(p) {
  if (!p) return '';
  const srcIdx = p.lastIndexOf('/src/');
  if (srcIdx >= 0) return 'src/' + p.slice(srcIdx + 5);
  return p.split('/').slice(-3).join('/');
}
