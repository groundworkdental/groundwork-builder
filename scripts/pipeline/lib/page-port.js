/**
 * Page porting — turns the Architect ledger into real pages.
 *
 * Architect decides *where* each source page's content goes; this module moves
 * it. Content is carried over verbatim from bronze `contentBlocks`, the same
 * deterministic path blog-migrate.js uses — no model, no cost, no drift.
 *
 *   port / standalone-port  → its own route
 *   merge-into / absorb-as-section → a section appended to the target route
 *   drop                    → nothing
 *
 * Routes already owned by another generator (services, team, blog, and the
 * template's own pages) are left alone: Architect names them in the ledger
 * because they are real destinations, not because it should write them.
 *
 * Consumer: build-site.js Phase 3b-ter
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

/** Routes generated elsewhere in the pipeline — never written by this module. */
const OWNED_ROUTE = /^\/(?:$|services(?:\/|$)|team(?:\/|$)|blog(?:\/|$)|about$|faq$|financing$|gallery$|schedule$|thank-you$)/;

/** Marks appended content so a partial re-run doesn't stack duplicates. */
const PORTED_MARKER = '<!-- groundwork:ported-sections -->';

/** Stamped into every page this module writes, so stale ones can be found later. */
const PORTED_PAGE_MARKER = 'groundwork:ported-page';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const normRoute = (r) => {
  const s = String(r || '').trim();
  if (!s) return null;
  const withSlash = s.startsWith('/') ? s : `/${s}`;
  return withSlash.replace(/\/+$/, '') || '/';
};

/**
 * Render bronze contentBlocks to HTML.
 *
 * The leading H1 is dropped — the page template renders the title itself, so
 * keeping it would produce two competing H1s. Remaining headings are clamped to
 * h2..h4 so the ported document nests correctly under that title.
 */
export function renderBlocksToHtml(blocks, { dropLeadingH1 = true, headingBase = 2 } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const out = [];
  let droppedH1 = false;

  for (const b of list) {
    if (!b || typeof b !== 'object') continue;

    if (b.type === 'heading') {
      const text = String(b.text || '').trim();
      if (!text) continue;
      const level = Number(b.level) || 2;
      if (dropLeadingH1 && level === 1 && !droppedH1) { droppedH1 = true; continue; }
      const tag = `h${Math.min(Math.max(level + headingBase - 2, headingBase), 5)}`;
      out.push(`      <${tag}>${escapeHtml(text)}</${tag}>`);
      continue;
    }

    if (b.type === 'paragraph') {
      const text = String(b.text || '').trim();
      if (text) out.push(`      <p>${escapeHtml(text)}</p>`);
      continue;
    }

    if (b.type === 'list') {
      const items = (Array.isArray(b.items) ? b.items : []).filter(Boolean);
      if (!items.length) continue;
      const tag = b.ordered ? 'ol' : 'ul';
      out.push(`      <${tag}>`);
      for (const item of items) {
        out.push(`        <li>${escapeHtml(String(item).replace(/\s+/g, ' ').trim())}</li>`);
      }
      out.push(`      </${tag}>`);
    }
  }
  return out.join('\n');
}

/** First substantive paragraph, clamped — used as the meta description. */
function deriveDescription(blocks, maxLen = 157) {
  const para = (blocks || []).find(b => b?.type === 'paragraph' && String(b.text || '').trim().length > 40);
  const clean = String(para?.text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > maxLen * 0.5) return cut.slice(0, stop + 1).trim();
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 0 ? cut.slice(0, sp) : cut).trim()}…`;
}

function titleOf(page, fallback) {
  const h1 = (page?.contentBlocks || []).find(b => b?.type === 'heading' && Number(b.level) === 1);
  return String(h1?.text || page?.title || fallback || '').trim() || fallback || 'Page';
}

/**
 * Turn a ledger into a concrete plan.
 *
 * @param {object} architecture - { pages, ledger }
 * @param {Array}  bronzePages
 * @param {Set<string>} [existingRoutes] - routes already generated; skipped
 * @returns {{ pages: Array, sections: Map, skipped: Array, unresolved: Array }}
 */
export function buildPortPlan(architecture, bronzePages, existingRoutes = new Set()) {
  const byPath = new Map(
    (bronzePages || []).map(p => [normRoute(p.path || p.url), p])
  );
  const proposed = new Map(
    (architecture?.pages || []).map(p => [normRoute(p.route), p])
  );

  const pages = [];
  const sections = new Map();   // target route → [{ title, html, source }]
  const skipped = [];
  const unresolved = [];

  for (const entry of architecture?.ledger || []) {
    const source = normRoute(entry.source);
    const bronzePage = byPath.get(source);
    if (!bronzePage) { unresolved.push({ source: entry.source, reason: 'no bronze page' }); continue; }

    const blocks = bronzePage.contentBlocks || [];
    if (!blocks.length) { unresolved.push({ source: entry.source, reason: 'no content blocks' }); continue; }

    if (entry.disposition === 'drop') { skipped.push({ source, reason: 'dropped by ledger' }); continue; }

    if (entry.disposition === 'port' || entry.disposition === 'standalone-port') {
      const target = normRoute(entry.target) || normRoute(
        (architecture?.pages || []).find(p => (p.sources || []).some(s => normRoute(s) === source))?.route
      );
      if (!target) { unresolved.push({ source: entry.source, reason: 'no target route' }); continue; }
      if (OWNED_ROUTE.test(target) || existingRoutes.has(target)) {
        skipped.push({ source, target, reason: 'route owned by another generator' });
        continue;
      }
      pages.push({
        route: target,
        title: proposed.get(target)?.title || titleOf(bronzePage, target.replace(/^\//, '')),
        description: deriveDescription(blocks),
        html: renderBlocksToHtml(blocks),
        sources: [source],
        disposition: entry.disposition,
      });
      continue;
    }

    if (entry.disposition === 'merge-into' || entry.disposition === 'absorb-as-section') {
      const target = normRoute(entry.target);
      if (!target) { unresolved.push({ source: entry.source, reason: 'no target route' }); continue; }
      if (!sections.has(target)) sections.set(target, []);
      sections.get(target).push({
        title: titleOf(bronzePage, ''),
        html: renderBlocksToHtml(blocks, { headingBase: 3 }),
        source,
      });
      continue;
    }

    unresolved.push({ source: entry.source, reason: `unhandled disposition "${entry.disposition}"` });
  }

  // Merge sections whose target is itself a newly ported page.
  for (const page of pages) {
    const own = sections.get(page.route);
    if (!own) continue;
    page.html += '\n' + own.map(s => sectionHtml(s)).join('\n');
    page.sources.push(...own.map(s => s.source));
    sections.delete(page.route);
  }

  return { pages, sections, skipped, unresolved };
}

function sectionHtml(section) {
  const heading = section.title ? `      <h2>${escapeHtml(section.title)}</h2>\n` : '';
  return `${heading}${section.html}`;
}

/**
 * Pages this module wrote on a previous run, found by the marker it stamps into
 * every generated file. Only these are eligible for cleanup — template pages and
 * other generators' output must never be touched.
 */
async function findPortedPages(outputDir, dir = '', found = []) {
  const base = resolve(outputDir, 'src/pages', dir);
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { await findPortedPages(outputDir, rel, found); continue; }
    if (!e.name.endsWith('.astro')) continue;
    const file = resolve(base, e.name);
    let src;
    try { src = await readFile(file, 'utf8'); } catch { continue; }
    if (!src.includes(PORTED_PAGE_MARKER)) continue;
    found.push({ file, route: `/${rel.replace(/\.astro$/, '')}` });
  }
  return found;
}

/** Route → src/pages file path. `/patients` → src/pages/patients.astro */
function routeToFile(outputDir, route) {
  const rel = route.replace(/^\//, '') || 'index';
  return resolve(outputDir, 'src/pages', `${rel}.astro`);
}

function pageTemplate({ title, description, html, depth }) {
  const up = '../'.repeat(depth) || './';
  return `---
// groundwork:ported-page
// Ported verbatim from the practice's existing site by the Architect ledger.
import BaseLayout from '${up}layouts/BaseLayout.astro';
import { site, localBusinessSchema } from '${up}config/site';
---

<BaseLayout
  title={\`${title.replace(/`/g, '\\`').replace(/\$/g, '\\$')} | \${site.name}\`}
  description="${escapeHtml(description || title).replace(/"/g, '&quot;')}"
  schema={localBusinessSchema}
>
  <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
    <h1 class="font-serif text-4xl md:text-5xl font-bold text-neutral-dark mb-8 leading-tight">
      ${escapeHtml(title)}
    </h1>
    <div class="prose prose-lg max-w-none text-neutral-mid leading-relaxed">
${html}
    </div>
    <div class="mt-10 flex gap-4 flex-wrap">
      <a href="/schedule" class="btn-primary">Book Appointment</a>
      <a href="/services" class="btn-secondary">View All Services</a>
    </div>
  </div>
</BaseLayout>
`;
}

/**
 * Write ported pages and append absorbed sections to their targets.
 *
 * @returns {{ written: Array, appended: Array, skipped: Array, unresolved: Array }}
 */
export async function generatePortedPages(architecture, bronze, outputDir, existingRoutes = new Set()) {
  const plan = buildPortPlan(architecture, bronze?.pages || [], existingRoutes);

  // Architect can name a route differently between runs (`/se-habla-espanol`
  // one run, `/es` the next). cloneTemplate copies over the template but never
  // deletes, so last run's pages would survive as orphans — live routes nothing
  // links to, quietly passing the coverage audit. Clear ours before writing.
  const keep = new Set(plan.pages.map(p => p.route));
  for (const stale of await findPortedPages(outputDir)) {
    if (keep.has(stale.route)) continue;
    await rm(stale.file, { force: true });
  }

  const written = [];
  const writtenFiles = [];
  for (const page of plan.pages) {
    const file = routeToFile(outputDir, page.route);
    const depth = page.route.split('/').filter(Boolean).length;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, pageTemplate({ ...page, depth }), 'utf8');
    written.push(page.route);
    writtenFiles.push(file);
  }

  // Absorbed content goes into pages another generator owns, so it is appended
  // rather than written — same insertion point injectAboutRescued uses.
  const appended = [];
  for (const [target, items] of plan.sections) {
    const file = routeToFile(outputDir, target);
    let src;
    try { src = await readFile(file, 'utf8'); } catch {
      // Architect can name a destination that no generator owns and no template
      // ships — `/contact` is the common one. Its content exists and has a home
      // in the ledger, so create the page rather than stranding it.
      if (OWNED_ROUTE.test(target)) {
        plan.unresolved.push({ source: items.map(i => i.source).join(', '), reason: `target page ${target} not found` });
        continue;
      }
      const title = items.find(i => i.title)?.title || target.replace(/^\//, '').replace(/-/g, ' ');
      const depth = target.split('/').filter(Boolean).length;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, pageTemplate({
        title,
        description: null,
        html: items.map(sectionHtml).join('\n'),
        depth,
      }), 'utf8');
      written.push(target);
      writtenFiles.push(file);
      continue;
    }
    if (!src.includes('</BaseLayout>')) {
      plan.unresolved.push({ source: target, reason: 'no </BaseLayout> insertion point' });
      continue;
    }
    // The pipeline re-clones the template each run, so this normally appends to
    // a fresh file — but a partial re-run must not stack duplicate copies of the
    // same content onto a page.
    if (src.includes(PORTED_MARKER)) {
      appended.push({ target, sections: items.length, skipped: 'already present' });
      continue;
    }
    const block = `
  ${PORTED_MARKER}
  <section class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
    <div class="prose prose-lg max-w-none text-neutral-mid leading-relaxed">
${items.map(sectionHtml).join('\n')}
    </div>
  </section>
`;
    await writeFile(file, src.replace('</BaseLayout>', `${block}</BaseLayout>`), 'utf8');
    appended.push({ target, sections: items.length });
  }

  return { written, writtenFiles, appended, skipped: plan.skipped, unresolved: plan.unresolved };
}
