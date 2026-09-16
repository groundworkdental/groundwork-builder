#!/usr/bin/env node
/**
 * verify-build.js — deterministic assertions against a built client directory.
 *
 * Every check here exists because the corresponding bug actually shipped, and
 * because nothing cheaper than a ~15-minute pipeline run caught it. The offline
 * fixture suite passed on all of them: it validates artifact *shapes*, not the
 * site that comes out the other end.
 *
 *   undefined colour token   `bg-brand-navy` was never a token; Tailwind emits
 *                            nothing for unknown classes, so white text landed
 *                            on white at 1.07:1
 *   palette below AA         accent reached the Tailwind config uncorrected
 *                            because a later step replaced brand.colors
 *   shadowing redirect       /blog/<slug> 301'd to /services while that exact
 *                            post existed at that exact URL
 *   dangling redirect        /team/dr-azimi — Architect's naming, not the
 *                            generator's
 *   content 301'd to /       26 pages, ~27k words, pointed at the homepage
 *   blog frontmatter         metaDescription over the 160-char collection limit
 *                            failed the Astro build
 *   placeholder route        locations/sample-city shipped on every site
 *
 * No AI, no network, runs in about a second.
 *
 *   node scripts/pipeline/verify-build.js clients/<slug>
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { contrast } from './lib/contrast.js';

const AA = 4.5;
const DESCRIPTION_LIMIT = 160;

const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });

const exists = (p) => access(p).then(() => true).catch(() => false);
const readMaybe = (p) => readFile(p, 'utf8').catch(() => null);
const norm = (p) => String(p || '').toLowerCase().replace(/\/+$/, '') || '/';

/** Every route the build actually serves. */
async function builtRoutes(distDir) {
  const routes = new Set();
  async function walk(dir, rel = '') {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${rel}/${e.name}`);
      else if (e.name === 'index.html') routes.add(rel || '/');
    }
  }
  await walk(distDir);
  return routes;
}

// ---------------------------------------------------------------------------

/**
 * Contrast sweep over the real token contexts.
 *
 * Colour values live in src/styles/tokens.css now, not as hex in
 * tailwind.config.mjs. The old check parsed hex out of the config with
 * /(\w+):\s*'(#[0-9a-fA-F]{3,8})'/ — against a tokenised config that regex
 * matches nothing, `brand.primary` is undefined and the check FAILS OPEN,
 * silently reporting "no brand colours found" while the AA gate does nothing.
 * If you ever move colour values again, move this with them.
 *
 * It also composites the surfaces each context actually declares, instead of
 * assuming white and brand-light. A token that passes on white can fail badly
 * on a dark band, and per-context grounds are the whole reason tokens.css
 * exists.
 */
function tripletToHex(triplet) {
  const parts = String(triplet).trim().split(/[\s,]+/).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return '#' + parts.slice(0, 3).map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
}

/** { ':root': {…}, '.section-dark': {…} } — each a map of token → hex. */
function parseTokenContexts(css) {
  const contexts = {};
  for (const m of css.matchAll(/(^|\n)\s*([:.][\w-]+)\s*\{([^}]*)\}/g)) {
    const [, , selector, body] = m;
    const vars = {};
    for (const v of body.matchAll(/--c-([\w-]+)\s*:\s*([^;]+);/g)) {
      const hex = tripletToHex(v[2]);
      if (hex) vars[v[1]] = hex;
    }
    if (Object.keys(vars).length) contexts[selector] = vars;
  }
  return contexts;
}

async function checkPalette(clientDir) {
  const tokensCss = await readMaybe(resolve(clientDir, 'src/styles/tokens.css'));

  // Pre-tokenisation client directories still carry hex in the config.
  if (!tokensCss) return checkPaletteLegacy(clientDir);

  const contexts = parseTokenContexts(tokensCss);
  const root = contexts[':root'];
  if (!root?.primary) return fail('palette', 'tokens.css has no :root --c-primary');

  // Foreground roles that carry text or UI, and the grounds they sit on.
  const FOREGROUNDS = ['primary', 'accent', 'highlight', 'text', 'dim'];
  const GROUNDS = ['surface-1', 'surface-2'];

  const bad = [];
  let pairs = 0;
  for (const [selector, ownVars] of Object.entries(contexts)) {
    // A context only overrides some names; the rest inherit from :root.
    const vars = { ...root, ...ownVars };
    for (const fg of FOREGROUNDS) {
      if (!vars[fg]) continue;
      for (const ground of GROUNDS) {
        if (!vars[ground]) continue;
        pairs++;
        const ratio = contrast(vars[fg], vars[ground]);
        if (ratio < AA) {
          bad.push(`${selector} ${fg} ${vars[fg]} on ${ground} ${vars[ground]} = ${ratio.toFixed(2)}`);
        }
      }
    }
  }

  bad.length
    ? fail('palette AA', bad.join('; '))
    : pass(
        'palette AA',
        `${pairs} pair(s) across ${Object.keys(contexts).length} context(s): ` +
          Object.keys(contexts).join(', '),
      );
}

/** Kept for client dirs generated before colours moved into tokens.css. */
async function checkPaletteLegacy(clientDir) {
  const cfg = await readMaybe(resolve(clientDir, 'tailwind.config.mjs'));
  if (!cfg) return fail('palette', 'tailwind.config.mjs not found');

  const brand = {};
  const block = cfg.match(/brand:\s*\{([\s\S]*?)\}/);
  for (const m of (block?.[1] || '').matchAll(/(\w+):\s*'(#[0-9a-fA-F]{3,8})'/g)) brand[m[1]] = m[2];
  if (!brand.primary) {
    return fail(
      'palette',
      'no brand colours in tailwind.config.mjs and no src/styles/tokens.css — ' +
        'if this site is tokenised, tokens.css failed to generate',
    );
  }

  const surfaces = [['white', '#ffffff'], ['brand-light', brand.light]].filter((s) => s[1]);
  const bad = [];
  for (const role of ['primary', 'accent', 'highlight']) {
    if (!brand[role]) continue;
    for (const [label, bg] of surfaces) {
      const ratio = contrast(brand[role], bg);
      if (ratio < AA) bad.push(`${role} ${brand[role]} on ${label} = ${ratio.toFixed(2)}`);
    }
  }
  bad.length
    ? fail('palette AA', bad.join('; '))
    : pass('palette AA', `${Object.keys(brand).length} token(s) pass on white + brand-light (legacy hex config)`);
}

async function checkColorTokens(clientDir) {
  const cfg = await readMaybe(resolve(clientDir, 'tailwind.config.mjs'));
  if (!cfg) return;
  const defined = new Set();
  for (const ns of ['brand', 'surface']) {
    const block = cfg.match(new RegExp(`${ns}:\\s*\\{([\\s\\S]*?)\\}`));
    for (const m of (block?.[1] || '').matchAll(/['"]?([a-zA-Z0-9_-]+)['"]?\s*:/g)) defined.add(`${ns}-${m[1]}`);
  }
  if (!defined.size) return;

  const undef = new Map();
  const RE = /\b(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow)-((?:brand|surface)-[a-z0-9]+(?:-[a-z0-9]+)*)/g;
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!/\.(astro|ts|js)$/.test(e.name)) continue;
      const c = await readMaybe(p);
      for (const m of (c || '').matchAll(RE)) {
        const t = m[1].split('/')[0];
        if (!defined.has(t)) undef.set(t, (undef.get(t) || 0) + 1);
      }
    }
  }
  await walk(resolve(clientDir, 'src'));
  undef.size
    ? fail('colour tokens', [...undef.entries()].map(([t, n]) => `${t} (×${n})`).join(', '))
    : pass('colour tokens', `all resolve against ${defined.size} defined`);
}

async function checkRedirects(clientDir, routes) {
  const txt = await readMaybe(resolve(clientDir, 'dist/_redirects'));
  if (!txt) return pass('redirects', 'none written');

  const rows = txt.trim().split('\n').map(l => l.trim().split(/\s+/)).filter(r => r.length >= 2);
  const dangling = [], shadowing = [], toRoot = [];

  for (const [from, to] of rows) {
    if (routes.has(norm(from))) shadowing.push(`${from} → ${to}`);
    if (!routes.has(norm(to))) dangling.push(`${from} → ${to}`);
    if (norm(to) === '/' && !/^\/(index|home|default|main)(\.\w+)?$/i.test(norm(from))) toRoot.push(from);
  }

  shadowing.length
    ? fail('redirects: shadowing a built page', shadowing.slice(0, 5).join(', '))
    : pass('redirects: no shadowing', `${rows.length} checked`);
  dangling.length
    ? fail('redirects: target does not exist', dangling.slice(0, 5).join(', '))
    : pass('redirects: targets resolve');
  // Informational only — some → / are legitimate (soft-dups, uncrawled pages).
  pass('redirects: → / count', `${toRoot.length}${toRoot.length ? ' (verify each is a dup or uncrawled)' : ''}`);
}

async function checkNav(clientDir, routes) {
  const nav = await readMaybe(resolve(clientDir, 'src/config/navigation.ts'));
  if (!nav) return;
  const hrefs = [...new Set([...nav.matchAll(/href:\s*'([^']+)'/g)].map(m => m[1]))]
    .filter(h => h.startsWith('/'));
  const broken = hrefs.filter(h => !routes.has(norm(h)));
  broken.length
    ? fail('nav links', `${broken.length} dead: ${broken.slice(0, 5).join(', ')}`)
    : pass('nav links', `${hrefs.length} resolve`);
}

async function checkBlog(clientDir) {
  const dir = resolve(clientDir, 'src/content/blog');
  let files;
  try { files = (await readdir(dir)).filter(f => f.endsWith('.md')); } catch { return; }
  if (!files.length) return pass('blog', 'no posts');

  const tooLong = [], noBody = [];
  for (const f of files) {
    const raw = await readMaybe(join(dir, f)) || '';
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const desc = fm?.[1].match(/^description:\s*"([\s\S]*?)"\s*$/m)?.[1] || '';
    if (desc.length > DESCRIPTION_LIMIT) tooLong.push(`${f} (${desc.length})`);
    const body = raw.replace(/^---[\s\S]*?---/, '').trim();
    if (body.split(/\s+/).filter(Boolean).length < 50) noBody.push(f);
  }
  tooLong.length
    ? fail('blog descriptions', `over ${DESCRIPTION_LIMIT} chars: ${tooLong.slice(0, 4).join(', ')}`)
    : pass('blog descriptions', `${files.length} within ${DESCRIPTION_LIMIT}`);
  noBody.length
    ? fail('blog bodies', `under 50 words: ${noBody.slice(0, 4).join(', ')}`)
    : pass('blog bodies', `${files.length} substantive`);
}

async function checkPlaceholders(clientDir, routes) {
  const placeholderRoutes = [...routes].filter(r => /sample|placeholder|lorem|example-city/i.test(r));
  placeholderRoutes.length
    ? fail('placeholder routes', placeholderRoutes.join(', '))
    : pass('placeholder routes', 'none');

  const idx = await readMaybe(resolve(clientDir, 'dist/index.html')) || '';
  const tokens = ['[PHONE]', '[City]', '[Practice Name]', 'Lorem ipsum', 'TODO:'];
  const found = tokens.filter(t => idx.includes(t));
  found.length
    ? fail('placeholder tokens', found.join(', '))
    : pass('placeholder tokens', 'none in homepage');
}

async function checkLedger(clientDir, routes) {
  const raw = await readMaybe(resolve(clientDir, '_pipeline/03-architecture.json'));
  if (!raw) return;
  let arch;
  try { arch = JSON.parse(raw).output; } catch { return; }
  const cov = arch?.coverage;
  if (!cov) return;

  cov.unassigned?.length
    ? fail('ledger closed', `${cov.unassigned.length} page(s) unassigned`)
    : pass('ledger closed', `${cov.sourcePageCount} source page(s) accounted for`);
  cov.droppedKeep?.length
    ? fail('ledger: KEEP dropped', cov.droppedKeep.map(d => d.source).slice(0, 4).join(', '))
    : pass('ledger: no KEEP page dropped');
}


/**
 * Contrast, from the a11y artifact the pipeline already produces.
 *
 * The design gate reports a single number ("7 violations"); that is enough to
 * refuse a build but not enough to fix one. This surfaces the failing colour
 * pairs and the pages they appear on, without spinning up a browser.
 */
async function checkContrast(clientDir) {
  const raw = await readMaybe(resolve(clientDir, '_pipeline/11b-a11y-audit.json'));
  if (!raw) return;
  let o;
  try { o = JSON.parse(raw).output; } catch { return; }
  if (!o?.pages) return;

  const pairs = new Map();
  let nodes = 0;
  for (const page of o.pages) {
    for (const v of page.violations || []) {
      if (v.id !== 'color-contrast') continue;
      nodes += v.nodeCount || 0;
      for (const sample of v.sample || []) {
        const m = /contrast of ([\d.]+).*?foreground color: (#\w+), background color: (#\w+)/.exec(sample.failureSummary || '');
        if (!m) continue;
        const key = `${m[2]} on ${m[3]} (${m[1]}:1)`;
        if (!pairs.has(key)) pairs.set(key, new Set());
        pairs.get(key).add(page.url);
      }
    }
  }

  if (nodes === 0) return pass('contrast', 'no colour-contrast violations');
  const detail = [...pairs.entries()]
    .map(([pair, pages]) => `${pair} on ${pages.size} page(s)`)
    .slice(0, 5)
    .join('; ');
  fail('contrast', `${nodes} node(s) across ${o.pages.length} page(s) — ${detail}`);
}

/** Flatten every built page's visible text once, for content-presence checks. */
async function builtText(distDir) {
  const chunks = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (e.name !== 'index.html') continue;
      const html = await readMaybe(p) || '';
      chunks.push(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' '));
    }
  }
  await walk(distDir);
  return chunks.join(' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The session's deepest invariant: content the Architect marked KEEP has to be
 * findable in the built site. `info-pages-loss` and `redirect-to-root-loss`
 * both described this failure after the fact — 31 pages gone, ~44k words
 * pointed at the homepage. This asserts it directly, per page.
 */
async function checkContentPreserved(clientDir, text) {
  const archRaw = await readMaybe(resolve(clientDir, '_pipeline/03-architecture.json'));
  const bronzeRaw = await readMaybe(resolve(clientDir, '_pipeline/01-bronze.json'));
  if (!archRaw || !bronzeRaw) return;

  let arch, bronze;
  try {
    arch = JSON.parse(archRaw).output;
    const b = JSON.parse(bronzeRaw);
    bronze = b.output ?? b;
  } catch { return; }

  // Only `port` / `standalone-port` promise verbatim carry-over. `merge-into`
  // and `absorb-as-section` route content through Content Write, which rewrites
  // it by design — asserting verbatim text there would fail correct builds.
  const VERBATIM = new Set(['port', 'standalone-port']);
  const verbatimSources = new Set(
    (arch?.ledger || []).filter(e => VERBATIM.has(e.disposition)).map(e => norm(e.source))
  );
  const keep = new Set(
    (arch?.pageQuality || [])
      .filter(p => p.mustPreserve && verbatimSources.has(norm(p.path)))
      // The homepage is composed from written copy and generated sections, not
      // ported — Architect labels it `port → /` but page-port skips `/` as an
      // owned route. Asserting its source text verbatim fails correct builds.
      .filter(p => norm(p.path) !== '/')
      .map(p => norm(p.path))
  );
  if (!keep.size) return pass('content preserved', 'no verbatim-port pages to check');

  const byPath = new Map((bronze.pages || []).map(p => [norm(p.path), p]));
  const missing = [];

  for (const path of keep) {
    const page = byPath.get(path);
    if (!page) continue;
    // Longest paragraph is the most distinctive and least likely to be chrome.
    const paras = (page.contentBlocks || [])
      .filter(b => b?.type === 'paragraph' && b.text)
      .map(b => b.text)
      .sort((a, b) => b.length - a.length);
    if (!paras.length) continue;
    const probe = paras[0].replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase();
    if (probe.length < 30) continue;
    if (!text.includes(probe)) missing.push(path);
  }

  missing.length
    ? fail('content preserved', `${missing.length}/${keep.size} verbatim-port page(s) whose text is not in the build: ${missing.slice(0, 5).join(', ')}`)
    : pass('content preserved', `${keep.size} verbatim-port page(s) present in the build`);
}

/** Written service copy has to reach the service page it was keyed to. */
async function checkServiceIntros(clientDir, distDir) {
  const raw = await readMaybe(resolve(clientDir, '_pipeline/03-content.json'));
  if (!raw) return;
  let services;
  try { services = JSON.parse(raw).output?.services || {}; } catch { return; }
  const slugs = Object.keys(services);
  if (!slugs.length) return;

  // Service pages that receive the practice's own page verbatim have their
  // written intro deliberately suppressed (page-generator `suppressIntroFor`),
  // because it summarised the text rendered directly below it — a mean 48%
  // repeat. Asserting its presence there would fail a build that is correct.
  const suppressed = new Set();
  const archRaw = await readMaybe(resolve(clientDir, '_pipeline/03-architecture.json'));
  if (archRaw) {
    try {
      for (const e of JSON.parse(archRaw).output?.ledger || []) {
        const t = norm(e.target);
        if (t.startsWith('/services/') && (e.disposition === 'merge-into' || e.disposition === 'absorb-as-section')) {
          suppressed.add(t.replace('/services/', ''));
        }
      }
    } catch { /* fall through — assert on everything */ }
  }

  const missing = [], noPage = [];
  for (const slug of slugs) {
    if (suppressed.has(slug)) continue;   // ported verbatim; intro intentionally dropped
    const intro = (services[slug]?.intro || '').replace(/\s+/g, ' ').trim();
    if (!intro) continue;   // deliberately withheld — no source
    const html = await readMaybe(join(distDir, 'services', slug, 'index.html'));
    if (html === null) { noPage.push(slug); continue; }
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').toLowerCase();
    if (!text.includes(intro.slice(0, 50).toLowerCase())) missing.push(slug);
  }

  noPage.length
    ? fail('service pages', `${noPage.length} written slug(s) with no page: ${noPage.slice(0, 5).join(', ')}`)
    : pass('service pages', `${slugs.length} written slug(s) all have pages`);
  missing.length
    ? fail('service intros', `${missing.length} page(s) missing their written intro: ${missing.slice(0, 5).join(', ')}`)
    : pass('service intros', `all present (${suppressed.size} suppressed where the practice's own page was ported)`);
}

/**
 * The starter template ships six generic Q&As with invented answers about
 * insurance, financing, and emergency policy. Publishing those for a practice
 * that stated none is fabrication.
 */
async function checkFaqs(clientDir, distDir) {
  const html = await readMaybe(join(distDir, 'faq', 'index.html'));
  if (html === null) return;
  const TEMPLATE_FAQS = [
    'What should I bring to my first appointment?',
    'Do you offer financing or payment plans?',
    'Are you accepting new patients?',
  ];
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
  const leaked = TEMPLATE_FAQS.filter(q => text.includes(q));
  // Only a problem when they're the *only* FAQs — a practice may genuinely ask these.
  const total = (text.match(/\?/g) || []).length;
  leaked.length && total <= TEMPLATE_FAQS.length + 2
    ? fail('FAQ fallback', `page appears to be template placeholders (${leaked.length} generic, ~${total} total)`)
    : pass('FAQ page', `${total} question(s), not template defaults`);
}

/** Migrated posts must keep their original slug so old URLs redirect to themselves. */
async function checkBlogSlugs(clientDir, routes) {
  const dir = resolve(clientDir, 'src/content/blog');
  let files;
  try { files = (await readdir(dir)).filter(f => f.endsWith('.md')); } catch { return; }

  const drifted = [];
  for (const f of files) {
    const raw = await readMaybe(join(dir, f)) || '';
    const src = raw.match(/^sourcePath:\s*"([^"]+)"/m)?.[1];
    if (!src) continue;   // generated stub, not a migration
    if (norm(src) !== norm(`/blog/${f.replace(/\.md$/, '')}`)) drifted.push(`${f} ← ${src}`);
  }
  drifted.length
    ? fail('blog slug preservation', drifted.slice(0, 4).join(', '))
    : pass('blog slug preservation', `${files.length} post(s) keep their original URL`);
}

// ---------------------------------------------------------------------------

const clientDir = resolve(process.argv[2] || '.');
if (!(await exists(join(clientDir, 'dist')))) {
  console.error(`verify-build: no dist/ in ${clientDir} — build first.`);
  process.exit(2);
}

const routes = await builtRoutes(join(clientDir, 'dist'));

await checkPalette(clientDir);
await checkColorTokens(clientDir);
await checkRedirects(clientDir, routes);
await checkNav(clientDir, routes);
await checkBlog(clientDir);
await checkPlaceholders(clientDir, routes);
await checkLedger(clientDir, routes);
await checkContrast(clientDir);
await checkServiceIntros(clientDir, join(clientDir, 'dist'));
await checkFaqs(clientDir, join(clientDir, 'dist'));
await checkBlogSlugs(clientDir, routes);
await checkContentPreserved(clientDir, await builtText(join(clientDir, 'dist')));

const failed = results.filter(r => !r.ok);
console.log(`\nverify-build — ${clientDir.split('/').pop()}  (${routes.size} routes)\n`);
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` · ${failed.length} FAILED` : ''}\n`);
process.exit(failed.length ? 1 : 0);
