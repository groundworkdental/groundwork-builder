/**
 * Page generator — keep/remove service hub pages based on detected services.
 *
 * 1. Deletes service hub pages from src/pages/services/ that the practice doesn't offer.
 * 2. Updates src/pages/services.astro to only list active services.
 * 3. Injects doctor bio into src/pages/about.astro if available.
 */

import { unlink, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { slugFromUrl } from './image-downloader.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// For values interpolated INTO a JS template literal (Astro frontmatter exprs).
// Doesn't HTML-escape; just escapes backticks/dollar/backslash.
function escapeQuotes(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Render structured page sections from ai-service-page.js into Astro markup.
// Each section type maps to a distinct visual treatment.
// ---------------------------------------------------------------------------
function renderStructuredSections(page, headline, subheadline, cta, practiceName) {
  const sections = page.sections || [];
  const intro = page.intro || '';
  const ctaSection = page.ctaSection || { headline: 'Ready to schedule?', primaryCta: cta };

  const introHtml = intro
    ? intro.split(/\n\s*\n/).map(p => `      <p class="text-lg text-neutral-mid leading-relaxed mb-6">${escapeHtml(p.trim())}</p>`).join('\n')
    : '';

  const sectionBodies = sections.map(s => renderSection(s)).filter(Boolean).join('\n');

  return `  <!-- Hero -->
  <section class="border-b border-border-light">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
      <p class="text-xs font-semibold uppercase tracking-widest text-brand-primary mb-4">
        <a href="/services" class="hover:underline">← All Services</a>
      </p>
      <h1 class="font-serif text-4xl md:text-5xl lg:text-6xl font-bold text-neutral-dark mb-6 leading-tight">
        ${escapeHtml(headline)}
      </h1>
      ${subheadline ? `<p class="text-xl md:text-2xl text-neutral-mid leading-relaxed mb-8 max-w-3xl">${escapeHtml(subheadline)}</p>` : ''}
${introHtml}
      <div class="mt-8 flex gap-4 flex-wrap">
        <a href="/schedule" class="btn-primary">${escapeHtml(page.primaryCta || cta)}</a>
        <a href={\`tel:\${site.phone.replace(/\\D/g, '')}\`} class="btn-secondary">Call {site.phone}</a>
      </div>
    </div>
  </section>

${sectionBodies}

  <!-- Final CTA -->
  <section class="bg-neutral-dark text-white">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20 text-center">
      <h2 class="font-serif text-3xl md:text-4xl font-bold mb-4">${escapeHtml(ctaSection.headline)}</h2>
      ${ctaSection.body ? `<p class="text-white/70 text-lg mb-8 max-w-2xl mx-auto">${escapeHtml(ctaSection.body)}</p>` : ''}
      <div class="flex gap-4 flex-wrap justify-center">
        <a href="/schedule" class="bg-white text-neutral-dark px-8 py-4 rounded-lg font-bold hover:bg-white/90 transition-colors">${escapeHtml(ctaSection.primaryCta || cta)}</a>
        <a href={\`tel:\${site.phone.replace(/\\D/g, '')}\`} class="border-2 border-white/30 text-white px-8 py-4 rounded-lg font-bold hover:bg-white/10 transition-colors">{site.phone}</a>
      </div>
    </div>
  </section>
`;
}

function renderSection(s) {
  if (!s || !s.type) return '';
  switch (s.type) {

    case 'highlight': {
      // Bold standout: small label above + large quote-style headline + optional body
      const label = s.label ? `<p class="text-sm font-bold uppercase tracking-widest text-brand-primary mb-4">${escapeHtml(s.label)}</p>` : '';
      const body = s.body ? `<p class="text-lg text-neutral-mid mt-6 max-w-2xl mx-auto leading-relaxed">${escapeHtml(s.body)}</p>` : '';
      return `  <section class="bg-brand-light border-y border-border-light">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20 text-center">
      ${label}
      <p class="font-serif text-2xl md:text-3xl lg:text-4xl font-bold text-neutral-dark leading-tight max-w-3xl mx-auto">
        ${escapeHtml(s.headline)}
      </p>
      ${body}
    </div>
  </section>`;
    }

    case 'subsection': {
      // Standard heading + paragraph block
      const paragraphs = (s.body || '').split(/\n\s*\n/).map(p => `        <p class="mb-5">${escapeHtml(p.trim())}</p>`).join('\n');
      return `  <section>
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
      <h2 class="font-serif text-3xl md:text-4xl font-bold text-neutral-dark mb-6 leading-tight">
        ${escapeHtml(s.heading)}
      </h2>
      <div class="text-neutral-mid text-base md:text-lg leading-relaxed">
${paragraphs}
      </div>
    </div>
  </section>`;
    }

    case 'callout-list': {
      // Heading + grid of labelled callouts
      const items = (s.items || []).map(it => `        <div class="border-l-2 border-brand-primary pl-5">
          <h3 class="font-serif text-lg font-bold text-neutral-dark mb-2">${escapeHtml(it.label)}</h3>
          <p class="text-neutral-mid text-sm leading-relaxed">${escapeHtml(it.body)}</p>
        </div>`).join('\n');
      return `  <section class="bg-surface-2">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-20">
      <h2 class="font-serif text-3xl md:text-4xl font-bold text-neutral-dark mb-10 max-w-2xl">
        ${escapeHtml(s.heading)}
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
${items}
      </div>
    </div>
  </section>`;
    }

    case 'process': {
      // Numbered process steps
      const steps = (s.steps || []).map((st, i) => `        <div class="grid grid-cols-12 gap-4 py-6 border-b border-border-light last:border-b-0">
          <div class="col-span-2 md:col-span-1">
            <span class="font-serif text-3xl font-bold text-brand-primary">${String(i+1).padStart(2,'0')}</span>
          </div>
          <div class="col-span-10 md:col-span-11">
            <h3 class="font-serif text-xl font-bold text-neutral-dark mb-2">${escapeHtml(st.title)}</h3>
            <p class="text-neutral-mid text-base leading-relaxed">${escapeHtml(st.body)}</p>
          </div>
        </div>`).join('\n');
      return `  <section>
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
      <h2 class="font-serif text-3xl md:text-4xl font-bold text-neutral-dark mb-8">
        ${escapeHtml(s.heading)}
      </h2>
      <div>
${steps}
      </div>
    </div>
  </section>`;
    }

    case 'benefits': {
      // Simple bullet list
      const items = (s.items || []).map(it => `        <li class="flex gap-3 items-start">
          <span class="text-brand-primary font-bold mt-1 flex-shrink-0">→</span>
          <span class="text-neutral-mid text-base md:text-lg leading-relaxed">${escapeHtml(it)}</span>
        </li>`).join('\n');
      return `  <section class="bg-brand-light">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
      <h2 class="font-serif text-3xl md:text-4xl font-bold text-neutral-dark mb-6">
        ${escapeHtml(s.heading)}
      </h2>
      <ul class="space-y-4">
${items}
      </ul>
    </div>
  </section>`;
    }

    case 'faq': {
      // Service-specific FAQs (simple stack, no accordion)
      const items = (s.items || []).map(it => `        <div class="py-6 border-b border-border-light last:border-b-0">
          <h3 class="font-serif text-lg md:text-xl font-bold text-neutral-dark mb-3">${escapeHtml(it.q)}</h3>
          <p class="text-neutral-mid text-base leading-relaxed">${escapeHtml(it.a)}</p>
        </div>`).join('\n');
      const heading = s.heading || 'Common Questions';
      return `  <section class="bg-surface-2 border-y border-border-light">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
      <h2 class="font-serif text-3xl md:text-4xl font-bold text-neutral-dark mb-8">
        ${escapeHtml(heading)}
      </h2>
      <div>
${items}
      </div>
    </div>
  </section>`;
    }

    default:
      return '';
  }
}

/**
 * Generate / prune pages based on scraped + merged practice data.
 *
 * @param {object} data      - Merged practice data (schema shape from schema.js)
 * @param {string} outputDir - Root of the generated Astro project
 * @param {object} [preset]  - Loaded vertical preset (from preset-loader).
 */
export async function generatePages(data, outputDir, preset = null, contentPlan = null, opts = {}) {
  // Hubs are disabled — delete all preset hub template pages from the template.
  // Service pages are generated fresh from scraped data only.
  const presetHubSlugs = Object.keys(preset?.hubs?.descriptions || {});
  let removed = 0;
  for (const hub of presetHubSlugs) {
    try {
      await unlink(resolve(outputDir, `src/pages/services/${hub}.astro`));
      removed++;
    } catch { /* already gone */ }
  }

  // Build services listing from all scraped services — no filtering, no hub suppression.
  const allOfferedServices = (data.services?.offered || []).filter(s => s.slug);
  await updateServicesIndex(outputDir, allOfferedServices, data);
  console.log(`  Updated services.astro with ${allOfferedServices.length} service(s).`);

  // Inject about page with doctor bio if available
  if (data.doctor?.bio) {
    await injectAboutBio(data, outputDir);
    console.log('  Injected doctor bio into about.astro.');
  }

  // Inject scraped FAQs into faq.astro (replaces template placeholders).
  await injectFaqs(data, outputDir);

  // Render the content-plan's "rescued" about sections — all additionalContent
  // the plan placed on /about (faithful mimicry; nothing is omitted).
  if (contentPlan) await injectAboutRescued(data, outputDir, contentPlan);

  // Render the content-plan's financial sections (insurance / financing /
  // payment) verbatim into financing.astro.
  if (contentPlan) await injectFinancial(data, outputDir, contentPlan);

  // Generate a page for every scraped service
  const generatedServicePages = await generateIndividualServicePages(data, outputDir, opts.suppressIntroFor);
  if (generatedServicePages > 0) {
    console.log(`  Generated ${generatedServicePages} individual service page(s).`);
  }

  return { removed, kept: 0, generatedServicePages };
}

/**
 * Write the services array in services.astro from scraped services.
 * Uses real descriptions from the content map where available.
 */
async function updateServicesIndex(outputDir, services = [], data = {}) {
  const filePath = resolve(outputDir, 'src/pages/services.astro');
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.warn('  Warning: services.astro not found — skipping index update.');
    return;
  }

  // Pull descriptions from content map (keyed by service slug)
  const contentMap = data?.content?.generated?.services || {};
  const practiceName = data?.practice?.name || 'our practice';

  const allEntries = services.length > 0
    ? services.map(svc => {
        const name = svc.name.replace(/'/g, "\\'");
        const contentEntry = contentMap[svc.slug];
        const rawDesc = contentEntry?.subheadline || contentEntry?.intro?.slice(0, 120) || svc.description || svc.blurb || null;
        const desc = rawDesc
          ? rawDesc.replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 150)
          : `${svc.name} at ${practiceName}.`;
        return `  { name: '${name}', slug: '${svc.slug}', href: '/services/${svc.slug}', desc: '${desc}' },`;
      }).join('\n')
    : `  { name: 'Our Services', slug: '', desc: 'Contact us to learn about our services.' },`;

  const newArray = `const services = [\n${allEntries}\n];`;

  // Match the existing services array declaration in frontmatter.
  // Handles both single-line and multi-line array definitions.
  const arrayPattern = /const\s+services\s*=\s*\[[\s\S]*?\];/;

  if (arrayPattern.test(content)) {
    content = content.replace(arrayPattern, newArray);
  } else {
    console.warn('  Warning: Could not locate services array in services.astro — skipping.');
    return;
  }

  await writeFile(filePath, content);
}

/**
 * Generate individual Astro pages for each detected service.
 * These sit at /services/[slug] and are separate from the 4 hub landing pages.
 * If AI-written content exists for the service (from content phase), it's used.
 * Otherwise a minimal page is generated using the service name and practice info.
 */
async function generateIndividualServicePages(data, outputDir, suppressIntroFor = null) {
  const services = data.services?.offered || [];
  if (services.length === 0) return 0;

  // The AI content map (Phase 2e) writes to `merged.content.generated.services`,
  // not `merged.content.services`. Read both for safety; the generated path
  // is the canonical source for AI-produced intros.
  const contentServices = data.content?.generated?.services
    || data.content?.services
    || {};
  const practiceName = data.practice?.name || '';
  const city = data.address?.city || '';
  const doctorName = data.doctor?.name || '';
  const practiceCtx = { name: practiceName, doctor: doctorName, city };

  // Map slug → bronze page content (for AI rewrite fallback).
  const bronzePages = data.bronze?.pages || [];
  const bronzeBySlug = {};
  for (const pg of bronzePages) {
    const path = pg.path || '';
    if (path.startsWith('/services/')) {
      const pgSlug = path.replace('/services/', '').replace(/\/$/, '');
      if (pgSlug) bronzeBySlug[pgSlug] = pg;
    }
  }

  const servicesDir = resolve(outputDir, 'src/pages/services');
  await mkdir(servicesDir, { recursive: true });

  // Clear starter-template service pages (cosmetic-dentistry.astro, etc.).
  // Scraped services are the source of truth — a starter placeholder must never
  // shadow a scraped service of the same slug (it would keep generic copy and
  // drop the practice's verbatim service facts). We regenerate every page below.
  try {
    const { readdir } = await import('node:fs/promises');
    for (const f of await readdir(servicesDir)) {
      if (f.endsWith('.astro')) await unlink(resolve(servicesDir, f)).catch(() => {});
    }
  } catch { /* dir was just created / empty */ }

  // Decide content per service (AI content map > AI rewrite of bronze >
  // hard skip), then run all rewrites in parallel before writing pages.
  const decisions = services.map(svc => {
    if (!svc.slug) return null;
    const aiContent = contentServices[svc.slug];
    if (aiContent?.intro) {
      return { svc, source: 'ai-content', aiContent };
    }
    const bronze = bronzeBySlug[svc.slug] || bronzeBySlug[svc.name?.toLowerCase().replace(/\s+/g, '-')];
    if (bronze) {
      return { svc, source: 'ai-rewrite', aiContent, bronze };
    }
    // No AI content, no bronze — render header-only page (no body).
    return { svc, source: 'minimal', aiContent };
  }).filter(Boolean);

  const rewritesNeeded = decisions.filter(d => d.source === 'ai-rewrite');
  let rewriteResults = [];
  if (rewritesNeeded.length > 0) {
    // New structured-section generator (replaces ai-service-rewrite.js).
    // Returns full multi-section page schema instead of one paragraph blob.
    const { generateServicePage } = await import('./ai-service-page.js');

    // Filter additionalContent for each specific service:
    //   - items whose source path matches the service slug (came from THIS service's original page elsewhere)
    //   - items of broadly service-relevant types (technology, specialty-deep-dive, treatment-detail)
    // X2: read top-level; legacy nested location supported
    const allAdditional = data.additionalContent || data.content?.additionalContent || [];
    const additionalForService = (svcSlug) => {
      const slugRe = new RegExp(`/services/${svcSlug.replace(/[-/]/g, '[-/]?')}\\b`, 'i');
      return allAdditional.filter(item => {
        const type = String(item.type || '').toLowerCase();
        const src  = String(item.source || '').toLowerCase();
        // Match by source path
        if (src && slugRe.test(src)) return true;
        // Match by relevant type (technology / specialty-deep-dive applies to many service pages)
        if (/technology|specialty|treatment-detail|process|clinical/.test(type)) return true;
        return false;
      }).slice(0, 4);
    };

    rewriteResults = await Promise.allSettled(
      rewritesNeeded.map(d => generateServicePage(
        d.bronze,
        d.svc,
        { ...practiceCtx, phone: data.practice?.phone },
        additionalForService(d.svc.slug),
      ))
    );
  }

  let count = 0;
  let aiContentCount = 0;
  let aiRewriteCount = 0;
  let minimalCount = 0;
  let rewriteIdx = 0;

  for (const d of decisions) {
    const slug = d.svc.slug;
    const pagePath = resolve(servicesDir, `${slug}.astro`);
    try { await readFile(pagePath); continue; } catch {} // don't overwrite

    const content = d.aiContent;
    const headline    = content?.headline    || d.bronze?.title?.split(' - ')[0] || d.svc.name;
    const subheadline = content?.subheadline || d.svc.description || (city ? `${d.svc.name} in ${city}` : d.svc.name);
    const cta         = content?.cta         || 'Schedule a Consultation';
    const benefits    = content?.benefits    || [];

    // Title for the <title> tag: append the city to the service name so the
    // local-intent keyword ("Dental Implants Huntington Beach") shows up in
    // SERPs and Google Ads quality signals. Skips city if not available (the
    // headline alone is a safe fallback). The service slug — not the full
    // marketing headline — is the right keyword anchor here, because
    // AI-generated headlines drift toward emotive phrasing ("Get a
    // Confident Smile") that doesn't match ad keywords.
    const titleService = d.svc.name || headline;
    const titleWithCity = city ? `${titleService} ${city}` : titleService;

    let intro = content?.intro || null;

    // When the practice's own page for this service is ported onto this route
    // verbatim (see page-port.js), the written intro is a summary of the very
    // text rendered directly beneath it. Measured across 13 service pages, the
    // intro repeated a mean of 48% of the body — one page 100%. The practice's
    // own words win, so the summary is dropped rather than shown twice.
    if (suppressIntroFor?.has(d.svc.slug)) {
      intro = null;
    }
    let structuredPage = null;  // Full structured output from ai-service-page.js
    if (d.source === 'ai-rewrite') {
      const r = rewriteResults[rewriteIdx++];
      if (r?.status === 'fulfilled' && r.value?.ok && r.value?.page) {
        structuredPage = r.value.page;
        // Also populate intro for backward compat with the prose block fallback
        intro = structuredPage.intro || null;
        aiRewriteCount++;
      } else {
        const reason = r?.status === 'rejected' ? r.reason?.message : r?.value?.error;
        console.warn(`  [service-page] ${slug} — falling back to header-only (${reason || 'unknown'})`);
        d.source = 'minimal';
      }
    }
    if (d.source === 'ai-content') aiContentCount++;
    if (d.source === 'minimal') minimalCount++;

    const benefitsHtml = benefits.length > 0
      ? `<ul class="space-y-3 my-6">\n${benefits.map(b => `        <li class="flex gap-3"><span class="text-brand-primary font-bold mt-1">→</span><span>${b}</span></li>`).join('\n')}\n      </ul>`
      : '';

    // Render intro as one or more <p> tags (the AI rewriter returns multi-paragraph
    // markdown separated by blank lines; preserve that).
    const introHtml = intro
      ? intro.split(/\n\s*\n/).map(p => `      <p class="mb-4">${escapeHtml(p.trim())}</p>`).join('\n')
      : '';

    // VERBATIM facts — the service's scraped details[] must always appear, never
    // dropped in favor of the AI-optimized intro alone. This is the content-plan's
    // `service-fact` content; rendering it here keeps the page faithful (the intro
    // optimizes/summarizes, the facts preserve the source verbatim).
    const facts = Array.isArray(d.svc.details)
      ? d.svc.details.filter(x => typeof x === 'string' && x.trim().length > 1)
      : [];
    const factsHtml = facts.length
      ? `\n  <section class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 md:pb-24">
    <div class="prose prose-lg max-w-none text-neutral-mid leading-relaxed space-y-4">
${facts.map(f => `      <p>${escapeHtml(f.trim())}</p>`).join('\n')}
    </div>
  </section>`
      : '';

    // Build a MedicalProcedure schema for this service. Per the SEO
    // guidelines doc, every service-detail page should emit a procedure-
    // or service-typed schema in addition to the auto-emitted
    // BreadcrumbList. The provider points back to the practice (LocalBusiness).
    const procedureSchema = {
      '@context': 'https://schema.org',
      '@type': 'MedicalProcedure',
      'name': headline,
      'description': subheadline,
      'procedureType': 'https://schema.org/Therapeutic',
      'provider': {
        '@type': 'Dentist',
        'name': practiceName,
        ...(city ? { 'address': { '@type': 'PostalAddress', 'addressLocality': city } } : {}),
      },
    };

    // If we have a fully structured page (from ai-service-page.js), render
    // each section with its appropriate visual treatment. Otherwise fall back
    // to the legacy single-prose-block layout.
    const sectionsHtml = structuredPage
      ? renderStructuredSections(structuredPage, headline, subheadline, cta, practiceName)
      : null;

    const pageContent = sectionsHtml
      ? `---
import BaseLayout from '../../layouts/BaseLayout.astro';
import { site, localBusinessSchema } from '../../config/site';

const procedureSchema = ${JSON.stringify(procedureSchema, null, 2)};
---

<BaseLayout
  title={\`${escapeQuotes(titleWithCity)} | \${site.name}\`}
  description="${escapeQuotes(subheadline)}"
  schema={[localBusinessSchema, procedureSchema]}
>
${sectionsHtml}
${factsHtml}
</BaseLayout>
`
      : `---
import BaseLayout from '../../layouts/BaseLayout.astro';
import { site, localBusinessSchema } from '../../config/site';

const procedureSchema = ${JSON.stringify(procedureSchema, null, 2)};
---

<BaseLayout
  title={\`${escapeQuotes(titleWithCity)} | \${site.name}\`}
  description="${escapeQuotes(subheadline)}"
  schema={[localBusinessSchema, procedureSchema]}
>
  <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
    <p class="text-xs font-semibold uppercase tracking-widest text-brand-primary mb-4">
      <a href="/services" class="hover:underline">Services</a>
    </p>
    <h1 class="font-serif text-4xl md:text-5xl font-bold text-neutral-dark mb-4 leading-tight">
      ${escapeHtml(headline)}
    </h1>
    <p class="text-xl text-neutral-mid mb-8 leading-relaxed">
      ${escapeHtml(subheadline)}
    </p>
    <div class="prose prose-lg max-w-none text-neutral-mid leading-relaxed">
${introHtml}
      ${benefitsHtml}
    </div>
    <div class="mt-10 flex gap-4 flex-wrap">
      <a href="/schedule" class="btn-primary">${escapeHtml(cta)}</a>
      <a href="/services" class="btn-secondary">View All Services</a>
    </div>
  </div>
${factsHtml}
</BaseLayout>
`;

    await writeFile(pagePath, pageContent, 'utf-8');
    count++;
  }

  if (count > 0) {
    const breakdown = [
      aiContentCount > 0 && `${aiContentCount} from AI content map`,
      aiRewriteCount > 0 && `${aiRewriteCount} via AI rewrite of scraped page`,
      minimalCount > 0 && `${minimalCount} header-only (no source content)`,
    ].filter(Boolean).join(', ');
    console.log(`  Service pages: ${breakdown}`);
  }

  return count;
}

/**
 * Replace the placeholder FAQ array in faq.astro with the practice's actual
 * scraped FAQs (verbatim question/answer). Keeps template defaults only if none
 * were scraped. JSON.stringify gives safe JS string literals (handles quotes).
 */
async function injectFaqs(data, outputDir) {
  const filePath = resolve(outputDir, 'src/pages/faq.astro');
  let content;
  try { content = await readFile(filePath, 'utf-8'); } catch { return; }

  // Scraped FAQs are the practice's own answers and always win. Generated ones
  // (written only when the site had none) are the fallback — this page used to
  // ignore them entirely while the homepage and llms.txt consumed them.
  const faqs = (
    (data.content?.faqs?.length ? data.content.faqs : null)
    || data.content?.generatedFAQs
    || data.faqs
    || []
  ).filter(f => f && f.question && f.answer);

  if (!faqs.length) {
    // The template ships six generic Q&As with invented answers about insurance,
    // financing, and emergency policy. Publishing those for a practice that
    // stated none is fabrication — empty the list and let the page render bare.
    const emptied = content.replace(/const\s+faqs\s*=\s*\[[\s\S]*?\];/, 'const faqs = [];');
    if (emptied !== content) {
      await writeFile(filePath, emptied, 'utf-8');
      console.log('  No FAQs found — cleared the template\'s generic placeholder FAQs.');
    }
    return;
  }

  const arr = faqs
    .map(f => `  { question: ${JSON.stringify(f.question)}, answer: ${JSON.stringify(f.answer)} },`)
    .join('\n');
  const newArray = `const faqs = [\n${arr}\n];`;
  const pattern = /const\s+faqs\s*=\s*\[[\s\S]*?\];/;
  if (!pattern.test(content)) {
    console.warn('  Warning: could not locate faqs array in faq.astro — skipping.');
    return;
  }
  content = content.replace(pattern, newArray)
    .replace(/^\s*\/\/\s*TODO: Add practice-specific FAQs\s*\n/m, '');
  await writeFile(filePath, content, 'utf-8');
  console.log(`  Injected ${faqs.length} scraped FAQ(s) into faq.astro.`);
}

/**
 * Append the content-plan's "rescued" about sections (all additionalContent the
 * plan placed on /about) to about.astro — verbatim, before </BaseLayout>.
 * Faithful mimicry: everything the practice had is reproduced, nothing omitted.
 */
async function injectAboutRescued(data, outputDir, contentPlan) {
  const aboutPlan = (contentPlan.pages || []).find(p => p.role === 'about');
  const rescued = (aboutPlan?.sections || []).filter(s => s.type === 'rescued' && (s.body || s.heading));
  if (!rescued.length) return;

  const filePath = resolve(outputDir, 'src/pages/about.astro');
  let content;
  try { content = await readFile(filePath, 'utf-8'); } catch { return; }

  const blocks = rescued.map(s => `  <section class="py-12">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      ${s.heading ? `<h2 class="section-heading mb-4">${escapeHtml(s.heading)}</h2>` : ''}
      ${s.body ? `<div class="prose prose-lg max-w-none text-neutral-mid leading-relaxed">${s.body.split(/\n\s*\n/).map(p => `<p class="mb-4">${escapeHtml(p.trim())}</p>`).join('')}</div>` : ''}
    </div>
  </section>`).join('\n');

  const idx = content.lastIndexOf('</BaseLayout>');
  if (idx === -1) { console.warn('  Warning: no </BaseLayout> in about.astro — skipping rescued.'); return; }
  content = content.slice(0, idx) + blocks + '\n' + content.slice(idx);
  await writeFile(filePath, content, 'utf-8');
  console.log(`  Injected ${rescued.length} rescued about section(s).`);
}

/**
 * Render the content-plan's financial sections (insurance/financing/payment)
 * verbatim into financing.astro, before </BaseLayout>.
 */
async function injectFinancial(data, outputDir, contentPlan) {
  const finPlan = (contentPlan.pages || []).find(p => p.role === 'financial');
  const secs = (finPlan?.sections || []).filter(s => s.body || s.heading);
  if (!secs.length) return;

  const filePath = resolve(outputDir, 'src/pages/financing.astro');
  let content;
  try { content = await readFile(filePath, 'utf-8'); } catch { return; }

  const blocks = secs.map(s => `  <section class="py-12">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      ${s.heading ? `<h2 class="section-heading mb-4">${escapeHtml(s.heading)}</h2>` : ''}
      ${s.body ? `<p class="text-neutral-mid leading-relaxed">${escapeHtml(s.body)}</p>` : ''}
    </div>
  </section>`).join('\n');

  const idx = content.lastIndexOf('</BaseLayout>');
  if (idx === -1) return;
  content = content.slice(0, idx) + blocks + '\n' + content.slice(idx);
  await writeFile(filePath, content, 'utf-8');
  console.log(`  Injected ${secs.length} financial section(s).`);
}

/**
 * Replace the placeholder paragraph in about.astro with the actual doctor bio.
 */
async function injectAboutBio(data, outputDir) {
  const filePath = resolve(outputDir, 'src/pages/about.astro');
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.warn('  Warning: about.astro not found — skipping bio injection.');
    return;
  }

  const doctorName = data.doctor.name
    || (data.doctor.firstName
      ? `Dr. ${data.doctor.firstName} ${data.doctor.lastName}`
      : 'Our Doctor');

  const credentials = data.doctor.credentials ? `, ${data.doctor.credentials}` : '';

  // Replace the entire <p> block containing the doctor intro TODO comment + placeholder text
  // Handles both "TODO: Doctor intro" and "TODO: Write a compelling introduction..." variants
  const todoBlockPattern = /(<p[^>]*>)\s*<!--\s*TODO:[^>]*-->\s*[\s\S]*?(<\/p>)/;

  const bio = data.doctor?.bio || `${doctorName} is dedicated to providing exceptional dental care.`;
  const replacement = `<p class="text-lg text-neutral-mid leading-relaxed mb-4">${bio}</p>`;

  if (todoBlockPattern.test(content)) {
    content = content.replace(todoBlockPattern, replacement);
  } else {
    // Broader fallback: replace any paragraph containing [X] years or TODO comment
    const fallbackPattern = /<!--\s*TODO[\s\S]*?-->\s*\n\s*With \[X\] years[\s\S]*?<\/p>/;
    if (fallbackPattern.test(content)) {
      content = content.replace(fallbackPattern, replacement);
    } else {
      console.warn('  Warning: Could not locate doctor intro placeholder in about.astro.');
      return;
    }
  }

  // Also inject doctor / team photo if available.
  // Image download runs AFTER this step, so we predict the local path. We must
  // mirror image-downloader's naming exactly: `team-{idx}-{slug}.{ext}` if the
  // URL yields a slug, else `team-{idx}.{ext}`.
  const teamSourceUrls = data.images?.team || [];
  let doctorPhoto = null;
  if (teamSourceUrls.length > 0) {
    const firstUrl = String(teamSourceUrls[0]);
    const extMatch = firstUrl.match(/\.(jpe?g|png|webp)(?:\?|$)/i);
    const ext = (extMatch?.[1] || 'jpg').toLowerCase();
    const safeExt = ext === 'jpeg' ? 'jpg' : ext;
    const slug = slugFromUrl(firstUrl);
    const baseName = slug ? `team-1-${slug}` : 'team-1';
    doctorPhoto = `/images/team/${baseName}.${safeExt}`;
  }

  if (doctorPhoto) {
    const imgSrc = doctorPhoto;
    // object-position: top — source photos vary in aspect ratio; faces are
    // typically in the upper half. Forcing center-crop on a slightly-wide
    // source pushes the face out of frame (forehead-only result). Top-anchor
    // keeps the face visible for ANY portrait orientation.
    const imgTag = `<img src="${imgSrc}" alt="${doctorName}" class="w-full h-full object-cover object-top rounded-2xl" loading="lazy" />`;
    // Replace the placeholder div containing "Doctor Photo" text
    const photoDivPattern = /<div[^>]*class="[^"]*rounded-2xl[^"]*aspect-\[4\/5\][^"]*"[^>]*>[\s\S]*?<\/div>/;
    if (photoDivPattern.test(content)) {
      content = content.replace(photoDivPattern, `<div class="rounded-2xl overflow-hidden aspect-[4/5]">${imgTag}</div>`);
    } else {
      // Narrow fallback: just swap the placeholder text node
      content = content.replace(
        /<p class="text-neutral-mid text-sm">Doctor Photo<\/p>/,
        imgTag
      );
    }
  }

  await writeFile(filePath, content);
}
