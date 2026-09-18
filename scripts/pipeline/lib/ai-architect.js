/**
 * Phase: Architect (IA + disposition ledger)
 *
 * Decides the rebuilt site's page set and assigns every ingested source page a
 * disposition. No phase previously reasoned about pages: Content Map scores
 * sections, Content Write fills a fixed schema, and the page list was hardcoded
 * in the template — so anything that didn't fit was dropped without a signal.
 *
 * Writes `_pipeline/03-architecture.json`, which page-port.js, the redirect
 * writer, and navigation all consume.
 *
 * The model chooses the shape; this module enforces the accounting. Validation
 * is deterministic and runs after every call:
 *   - every input page appears exactly once in the ledger
 *   - no `mustPreserve` page is dropped
 *   - every `target` resolves to a proposed route
 *   - every `sources[]` entry is a real input page
 */

import { renderSkillPrompt } from './skill-loader.js';
import { scorePages } from './page-quality.js';
import { isBlogPath } from './crawl-select.js';

/** Page types every site needs regardless of what the source site had. */
const DEFAULT_FLOOR = [
  { type: 'home',     route: '/',         why: 'Entry point.' },
  { type: 'services', route: '/services', why: 'Service index; individual service pages are generated from the taxonomy.' },
  { type: 'contact',  route: '/contact',  why: 'NAP, hours, map — required for local SEO and the conversion path.' },
  { type: 'schedule', route: '/schedule', why: 'The booking action. A site with no bookable route cannot convert.' },
];

/** Matches injector.js slugifyName — how team page slugs are actually built. */
function slugifyDoctor(name) {
  return String(name || '').toLowerCase()
    .replace(/^dr\.?\s+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const VALID_DISPOSITIONS = new Set([
  'port', 'standalone-port', 'merge-into', 'absorb-as-section', 'drop',
]);

/**
 * Run the Architect phase.
 *
 * @param {object} bronze - Bronze crawl ({ pages, softDups })
 * @param {object} merged - Merged practice data
 * @param {object} preset - Loaded vertical preset
 * @param {object} [opts]
 * @returns {object|null} { pages, ledger, coverage, rationale, _meta } or null
 */
export async function runArchitect(bronze, merged, preset, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  ANTHROPIC_API_KEY not set — skipping Architect.');
    return null;
  }
  if (!bronze?.pages?.length) {
    console.log('  No bronze pages — skipping Architect.');
    return null;
  }

  // Blog posts are ported verbatim and need no IA decision, so they are not
  // part of the ledger — including them would bury the pages that do need one.
  const referencePages = bronze.pages.filter(p => !isBlogPath(p.path || p.url || ''));
  const { pages: scored, byQuality } = scorePages(referencePages, {
    softDups: bronze.softDups || bronze.coverage?.softDups || [],
  });
  if (!scored.length) {
    console.log('  No reference pages to architect — skipping.');
    return null;
  }

  let prompt;
  try {
    prompt = await buildPrompt(scored, merged, preset);
  } catch (err) {
    console.warn(`  [architect] Could not render prompt: ${err.message}`);
    return null;
  }
  if (opts.verbose) console.log('  [architect] Prompt length:', prompt.length, 'chars');

  const startTime = Date.now();
  let parsed;
  try {
    const { callAnthropic } = await import('./ai-call.js');
    const result = await callAnthropic({
      phase:     'architect',
      cache:     true,
      model:     'claude-sonnet-4-6',
      maxTokens: 12288,
      messages:  [{ role: 'user', content: prompt }],
    }, { parseJson: true });

    if (!result.parsed) {
      console.warn(`  [architect] JSON parse failed (${result.text?.length || 0} chars out).`);
      return null;
    }
    parsed = result.parsed;
    parsed._meta = {
      model:         result.model,
      input_tokens:  result.usage?.input_tokens,
      output_tokens: result.usage?.output_tokens,
      duration_ms:   Date.now() - startTime,
      cost:          result.cost,
    };
  } catch (err) {
    console.warn(`  [architect] API call failed: ${err.message}`);
    return null;
  }

  const coverage = validate(parsed, scored, byQuality, {
    serviceSlugs: new Set((merged?.services?.offered || []).map(s => s.slug).filter(Boolean)),
    doctorSlugs:  new Set((merged?.doctors || []).map(d => slugifyDoctor(d?.name)).filter(Boolean)),
  });
  parsed.coverage = coverage;
  parsed.pageQuality = scored;
  return parsed;
}

// ---------------------------------------------------------------------------
// Validation — the accounting the model is not trusted to get right
// ---------------------------------------------------------------------------

function validate(parsed, scored, byQuality, { serviceSlugs = new Set(), doctorSlugs = new Set() } = {}) {
  const pages  = Array.isArray(parsed.pages)  ? parsed.pages  : (parsed.pages  = []);
  const ledger = Array.isArray(parsed.ledger) ? parsed.ledger : (parsed.ledger = []);

  const norm      = (p) => String(p || '').toLowerCase().replace(/\/+$/, '') || '/';
  const byPath    = new Map(scored.map(p => [norm(p.path), p]));
  const routes    = new Set(pages.map(p => norm(p.route)));
  const seen      = new Map();

  const violations = [];

  // One entry per source page — dedupe, then backfill anything the model skipped.
  for (const entry of ledger) {
    const key = norm(entry.source);
    if (!byPath.has(key)) {
      violations.push({ type: 'unknown-source', source: entry.source });
      continue;
    }
    if (seen.has(key)) {
      violations.push({ type: 'duplicate-ledger-entry', source: entry.source });
      continue;
    }
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      violations.push({ type: 'invalid-disposition', source: entry.source, disposition: entry.disposition });
      entry.disposition = 'unassigned';
    }
    seen.set(key, entry);
  }

  const unassigned = [];
  for (const page of scored) {
    const key = norm(page.path);
    if (seen.has(key)) continue;
    unassigned.push(page.path);
    const entry = {
      source: page.path,
      disposition: 'unassigned',
      target: null,
      rationale: '(auto-backfilled — Architect returned no disposition for this page)',
    };
    ledger.push(entry);
    seen.set(key, entry);
  }

  // A page carrying real content must land somewhere.
  const droppedKeep = [];
  for (const [key, entry] of seen) {
    const page = byPath.get(key);
    if (!page?.mustPreserve) continue;
    if (entry.disposition === 'drop' || entry.disposition === 'unassigned') {
      droppedKeep.push({ source: page.path, quality: page.quality, uniqueWords: page.uniqueWords, disposition: entry.disposition });
    }
  }

  // Targets must resolve, and a target of `/` is the redirect-to-homepage
  // failure wearing a different hat.
  const danglingTargets = [];
  const homepageDumps   = [];
  for (const entry of seen.values()) {
    if (!entry.target) continue;
    const t = norm(entry.target);
    if (t === '/' && entry.disposition !== 'port') homepageDumps.push(entry.source);
    else if (!routes.has(t)) danglingTargets.push({ source: entry.source, target: entry.target });
  }

  // Proposed pages must cite real sources.
  const invalidSources = [];
  for (const page of pages) {
    for (const s of page.sources || []) {
      if (!byPath.has(norm(s))) invalidSources.push({ route: page.route, source: s });
    }
  }

  // Routes under a prefix another generator owns are named by Architect but
  // authored by the taxonomy / doctor list. A target that doesn't match what
  // those actually emit is a 404 — and it reaches redirects and navigation
  // before anything else notices. Repair rather than report: a slightly generic
  // destination beats a dead one.
  const unknownServiceRoutes = [];
  const repairTarget = (route) => {
    const r = norm(route);
    const svc = r.match(/^\/services\/(.+)$/);
    if (svc && serviceSlugs.size && !serviceSlugs.has(svc[1])) return '/services';
    // A bare `/team` is not a route — the team renders on /about and only
    // `/team/<doctor-slug>` pages are generated.
    if (r === '/team') return '/about';
    const team = r.match(/^\/team\/(.+)$/);
    if (team && doctorSlugs.size && !doctorSlugs.has(team[1])) {
      // `/team/dr-azimi` should resolve to `/team/shayan-azimi`, not be discarded.
      const token = team[1].replace(/^dr-?/, '');
      const match = [...doctorSlugs].find(d => d === token || d.split('-').includes(token));
      return match ? `/team/${match}` : '/about';
    }
    return null;
  };

  for (const p of pages) {
    const fixed = repairTarget(p.route);
    if (!fixed) continue;
    unknownServiceRoutes.push({ route: p.route, where: 'pages', repairedTo: fixed });
    p.route = fixed;
  }
  for (const e of seen.values()) {
    if (!e.target) continue;
    const fixed = repairTarget(e.target);
    if (!fixed) continue;
    unknownServiceRoutes.push({ route: e.target, where: e.source, repairedTo: fixed });
    e.target = fixed;
    // The destination is now a page it shares, not one of its own.
    if (e.disposition === 'port' || e.disposition === 'standalone-port') {
      e.disposition = 'absorb-as-section';
    }
  }

  // A `port` whose target belongs to another generator is not a port. page-port
  // skips owned routes, so that content reaches the site through Content Write —
  // rewritten, not carried over. Leaving it labelled `port` made the ledger claim
  // verbatim preservation the build never performed.
  const OWNED = /^\/(?:services(?:\/|$)|team(?:\/|$)|blog(?:\/|$)|about$|faq$|financing$|gallery$|schedule$|thank-you$)/;
  const reclassified = [];
  for (const entry of seen.values()) {
    if (entry.disposition !== 'port' && entry.disposition !== 'standalone-port') continue;
    const t = norm(entry.target);
    if (t === '/' || !OWNED.test(t)) continue;
    reclassified.push({ source: entry.source, target: entry.target, from: entry.disposition });
    entry.disposition = 'merge-into';
  }

  const byDisposition = {};
  for (const entry of seen.values()) {
    byDisposition[entry.disposition] = (byDisposition[entry.disposition] || 0) + 1;
  }

  const ok = unassigned.length === 0 && droppedKeep.length === 0 &&
             danglingTargets.length === 0 && homepageDumps.length === 0 &&
             invalidSources.length === 0 && violations.length === 0;

  return {
    ok,
    sourcePageCount: scored.length,
    proposedPageCount: pages.length,
    byQuality,
    byDisposition,
    unassigned,
    droppedKeep,
    danglingTargets,
    homepageDumps,
    invalidSources,
    unknownServiceRoutes,
    reclassified,
    violations,
  };
}

/** Console summary — shadow mode reports, it does not fail the run. */
export function printArchitectReport(result) {
  if (!result) return;
  const c = result.coverage || {};
  console.log(`[Architect] ${c.sourcePageCount} source page(s) → ${c.proposedPageCount} proposed route(s)`);
  console.log(`  quality:     ${JSON.stringify(c.byQuality || {})}`);
  console.log(`  disposition: ${JSON.stringify(c.byDisposition || {})}`);
  if (c.reclassified?.length) {
    console.log(`  reclassified ${c.reclassified.length} port(s) → merge-into (target owned by another generator)`);
  }
  if (c.unknownServiceRoutes?.length) {
    const routes = [...new Set(c.unknownServiceRoutes.map(d => d.route))];
    console.log(`  repaired ${routes.length} target(s) pointing at no real route: ${c.unknownServiceRoutes.slice(0, 4).map(d => `${d.route}→${d.repairedTo}`).join(', ')}${routes.length > 4 ? '…' : ''}`);
  }
  if (c.ok) {
    console.log('  ledger closed — every page accounted for ✓');
    return;
  }
  const report = [
    ['unassigned pages',            c.unassigned],
    ['KEEP pages dropped',          c.droppedKeep?.map(d => `${d.source} (${d.quality}, ${d.uniqueWords}w)`)],
    ['targets that resolve nowhere', c.danglingTargets?.map(d => `${d.source} → ${d.target}`)],
    ['content pointed at homepage',  c.homepageDumps],
    ['proposed pages citing unknown sources', c.invalidSources?.map(d => `${d.route} ← ${d.source}`)],

  ];
  for (const [label, items] of report) {
    if (items?.length) console.log(`  🔴 ${label} (${items.length}): ${items.slice(0, 6).join(', ')}${items.length > 6 ? '…' : ''}`);
  }
  console.log('  (reported — the ledger still drives the build)');
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

async function buildPrompt(scored, merged, preset) {
  const floor = preset?.architecture?.floor || DEFAULT_FLOOR;

  const pagesBlock = scored
    .slice()
    .sort((a, b) => b.uniqueWords - a.uniqueWords)
    .map(p => {
      const flag = p.mustPreserve ? 'KEEP' : '    ';
      const title = p.h1 || p.title || '(untitled)';
      return `- ${flag}  ${p.path}  [${p.quality}, ${p.uniqueWords} unique words]  ${title}`;
    })
    .join('\n');

  const floorBlock = floor
    .map(f => `- \`${f.route}\` (${f.type}) — ${f.why}`)
    .join('\n');

  return renderSkillPrompt('content/architect', {
    verticalName: preset?.schema?.verticalName || 'Healthcare',
    practiceName: merged?.practice?.name || '[Practice Name]',
    city:         merged?.address?.city    || '[City]',
    state:        merged?.address?.state   || '[State]',
    serviceSlugs: (merged?.services?.offered || []).map(s => s.slug).filter(Boolean).join(', ') || '(none)',
    floorBlock,
    pagesBlock,
  });
}
