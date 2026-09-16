#!/usr/bin/env node
/**
 * Generator smoke tests — actually call the generators.
 *
 * Nothing else in the toolchain does. `node --check` sees syntax,
 * test-fixtures.js sees artifact shapes, and verify-build.js sees the built
 * site — but the functions in between were only ever exercised by a full
 * ~15-minute pipeline run. Three crashes shipped that way in one session, each
 * the same shape: an input verified, the line consuming it never executed.
 *
 *   `svc is not defined`          page-generator, loop variable is `d.svc`
 *   `nearbyLocations is not defined`  Astro hoists getStaticPaths into its own chunk
 *   description over 160 chars    passed straight from metaDescription
 *
 * Each of those would have failed here in well under a second.
 *
 * Fixtures are minimal but shaped like real silver/bronze output. Assertions are
 * deliberately shallow — this catches "it throws" and "it produced nothing",
 * not content quality, which verify-build.js already covers against a real build.
 */

import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

let failed = 0;
const ok   = (name, detail = '') => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
const bad  = (name, err) => { failed++; console.error(`  ✗ ${name} — ${err?.message || err}`); };

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (err) {
    bad(name, err);
    if (process.env.VERBOSE) console.error(err.stack);
  }
}

// ---------------------------------------------------------------------------
// Fixtures — minimal, but shaped like what silver/bronze actually emit.
// ---------------------------------------------------------------------------

const SERVICES = [
  { slug: 'dental-implants', name: 'Dental Implants', category: 'restorative',
    source: '/dental-implants.html', description: 'Replace missing teeth.',
    details: ['Titanium post fuses with the jawbone.'] },
  { slug: 'teeth-whitening', name: 'Teeth Whitening', category: 'cosmetic',
    source: '/teeth-whitening.html', description: 'Brighten your smile.', details: [] },
];

const merged = () => ({
  practice: { name: 'Test Family Dental', phone: '(555) 123-4567', domain: 'example.com' },
  doctor:   { name: 'Dr. Jane Roe', credentials: 'DDS', bio: 'Practising since 2005.' },
  doctors:  [{ name: 'Dr. Jane Roe', credentials: 'DDS', bio: 'Practising since 2005.' }],
  additionalDoctors: [],
  staff:    [],
  address:  { street: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' },
  hours:    { display: ['Mon–Fri 9–5'], byDay: {} },
  services: { offered: SERVICES },
  navigation: [{ text: 'About Us', href: '/about-us.html', children: [] }],
  migration: { oldUrls: [], redirectMap: [] },
  brand: {
    colors: { primary: '#1fa8b0', secondary: '#1a1a3d', light: '#f0f8f9',
              accent: '#b8860b', dark: '#1e1e2e', muted: '#5a6a6a' },
    roles:  { background: '#ffffff', text: '#1a1a1a', border: '#e2e8e8',
              neutralDark: '#1e1e2e', neutralLight: '#f0f8f9' },
    fonts:  { heading: 'Epilogue', body: 'Public Sans' },
  },
  content: {
    faqs: [{ question: 'Do you take insurance?', answer: 'Yes, most major plans.' }],
    testimonials: [], insurance: [], financingOptions: [], additionalContent: [],
    generated: {
      services: {
        'dental-implants': { headline: 'Dental Implants', subheadline: 'Restore your smile',
                             intro: 'Implants replace the root as well as the crown.',
                             benefits: ['Permanent'], cta: 'Book' },
        'teeth-whitening': { headline: 'Teeth Whitening', subheadline: 'Brighter in one visit',
                             intro: 'Professional whitening lifts stains gently.',
                             benefits: [], cta: 'Book' },
      },
      blogTopics: [{ title: 'Caring for Implants', excerpt: 'What to expect.' }],
    },
  },
});

const bronze = () => ({
  baseUrl: 'https://example.com',
  softDups: [],
  pages: [
    { path: '/', title: 'Home', wordCount: 400, bodyText: 'Welcome to the practice. '.repeat(30),
      headings: [{ level: 1, text: 'Home' }], paragraphs: ['Welcome to the practice.'],
      contentBlocks: [
        { type: 'heading', level: 1, text: 'Welcome' },
        { type: 'paragraph', text: 'We have served Springfield families for twenty years and counting.' },
      ] },
    { path: '/dental-implants.html', title: 'Dental Implants', wordCount: 900,
      bodyText: 'Implant detail. '.repeat(120), headings: [{ level: 1, text: 'Dental Implants' }],
      paragraphs: ['Implants are a permanent solution for missing teeth.'],
      contentBlocks: [
        { type: 'heading', level: 1, text: 'Dental Implants' },
        { type: 'paragraph', text: 'Implants are a permanent solution for missing teeth in Springfield.' },
        { type: 'list', ordered: false, items: ['Durable', 'Natural looking'] },
      ] },
    { path: '/se-habla-espanol.html', title: 'Español', wordCount: 500,
      bodyText: 'Hablamos espanol. '.repeat(60), headings: [{ level: 1, text: 'Bienvenido' }],
      paragraphs: ['Bienvenido a nuestra oficina dental.'],
      contentBlocks: [
        { type: 'heading', level: 1, text: 'Bienvenido' },
        { type: 'paragraph', text: 'Bienvenido a nuestra oficina dental en Springfield, hablamos espanol.' },
      ] },
    { path: '/blog/caring-for-implants', title: 'Caring for Implants', wordCount: 300,
      bodyText: 'Post body. '.repeat(60), headings: [{ level: 1, text: 'Caring for Implants' }],
      paragraphs: ['Brush twice daily.'],
      contentBlocks: [
        { type: 'heading', level: 1, text: 'Caring for Implants' },
        { type: 'paragraph', text: 'March 4, 2024' },
        { type: 'paragraph', text: 'Brush twice daily and keep your regular hygiene appointments to protect the implant site. ' + 'An implant cannot decay, but the gum and bone around it can still suffer if plaque is allowed to build up along the margin. '.repeat(3) },
        { type: 'paragraph', text: 'Flossing around an implant matters as much as it does around a natural tooth. ' + 'Your hygienist can show you a threader or a water flosser technique that reaches under the crown without disturbing the abutment. '.repeat(3) },
      ] },
  ],
});

const architecture = () => ({
  pages: [
    { route: '/', type: 'home', title: 'Home', sources: ['/'] },
    { route: '/services/dental-implants', type: 'service', title: 'Dental Implants', sources: ['/dental-implants.html'] },
    { route: '/espanol', type: 'standalone', title: 'Español', sources: ['/se-habla-espanol.html'] },
  ],
  ledger: [
    { source: '/', disposition: 'port', target: '/' },
    { source: '/dental-implants.html', disposition: 'merge-into', target: '/services/dental-implants' },
    { source: '/se-habla-espanol.html', disposition: 'standalone-port', target: '/espanol' },
  ],
  pageQuality: [
    { path: '/', quality: 'strong', uniqueWords: 400, mustPreserve: true },
    { path: '/dental-implants.html', quality: 'strong', uniqueWords: 900, mustPreserve: true },
    { path: '/se-habla-espanol.html', quality: 'strong', uniqueWords: 500, mustPreserve: true },
  ],
});

/** Minimal template scaffold — the generators read these before writing. */
async function scaffold(dir) {
  for (const d of ['src/pages/services', 'src/pages/locations', 'src/config',
                   'src/content/blog', 'src/styles', 'src/components', 'public']) {
    await mkdir(join(dir, d), { recursive: true });
  }
  await writeFile(join(dir, 'src/pages/services.astro'),
    '---\nconst services = [];\n---\n<div>services</div>\n');
  await writeFile(join(dir, 'src/pages/about.astro'),
    '---\n---\n<BaseLayout>\n  <p>about</p>\n</BaseLayout>\n');
  await writeFile(join(dir, 'src/pages/faq.astro'),
    '---\nconst faqs = [\n  { question: "Placeholder?", answer: "Placeholder." },\n];\n---\n<div>faq</div>\n');
  await writeFile(join(dir, 'src/pages/financing.astro'),
    '---\n---\n<BaseLayout>\n  <p>financing</p>\n</BaseLayout>\n');
  await writeFile(join(dir, 'tailwind.config.mjs'),
    "export default { theme: { extend: { colors: { brand: { primary: '#1fa8b0' } } } } };\n");
}

// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'gw-generators-'));
console.log('generator smoke tests\n');

try {
  // -- page-generator ------------------------------------------------------
  await check('generatePages', async () => {
    const dir = join(root, 'pages'); await mkdir(dir, { recursive: true }); await scaffold(dir);
    const { generatePages } = await import('../lib/page-generator.js');
    const data = { ...merged(), bronze: bronze() };
    const r = await generatePages(data, dir, null, null, {});
    const written = await readdir(join(dir, 'src/pages/services'));
    if (!written.some(f => f.endsWith('.astro'))) throw new Error('no service pages written');
    return `${r.generatedServicePages} service page(s)`;
  });

  // The exact crash: suppressIntroFor reaches the per-service loop.
  await check('generatePages · suppressIntroFor', async () => {
    const dir = join(root, 'pages-suppress'); await mkdir(dir, { recursive: true }); await scaffold(dir);
    const { generatePages } = await import('../lib/page-generator.js');
    const data = { ...merged(), bronze: bronze() };
    await generatePages(data, dir, null, null, { suppressIntroFor: new Set(['dental-implants']) });
    const page = await readFile(join(dir, 'src/pages/services/dental-implants.astro'), 'utf8');
    if (page.includes('Implants replace the root as well as the crown.')) {
      throw new Error('intro was not suppressed');
    }
    const kept = await readFile(join(dir, 'src/pages/services/teeth-whitening.astro'), 'utf8');
    if (!kept.includes('Professional whitening lifts stains gently.')) {
      throw new Error('intro wrongly suppressed on an unlisted service');
    }
    return 'suppressed on the listed slug only';
  });

  // -- page-port -----------------------------------------------------------
  await check('buildPortPlan', async () => {
    const { buildPortPlan } = await import('../lib/page-port.js');
    const plan = buildPortPlan(architecture(), bronze().pages);
    if (!plan.pages.some(p => p.route === '/espanol')) throw new Error('standalone-port not planned');
    if (!plan.sections.has('/services/dental-implants')) throw new Error('merge-into not planned');
    return `${plan.pages.length} page(s), ${plan.sections.size} section target(s)`;
  });

  await check('generatePortedPages', async () => {
    const dir = join(root, 'port'); await mkdir(dir, { recursive: true }); await scaffold(dir);
    await writeFile(join(dir, 'src/pages/services/dental-implants.astro'),
      '---\n---\n<BaseLayout>\n  <p>service</p>\n</BaseLayout>\n');
    const { generatePortedPages } = await import('../lib/page-port.js');
    const r = await generatePortedPages(architecture(), bronze(), dir);
    if (!r.written.includes('/espanol')) throw new Error('/espanol not written');
    const html = await readFile(join(dir, 'src/pages/espanol.astro'), 'utf8');
    if (!html.includes('hablamos espanol')) throw new Error('source text missing from ported page');
    if (!Array.isArray(r.writtenFiles) || !r.writtenFiles.length) throw new Error('writtenFiles not reported');
    if (!r.appended.some(a => a.target === '/services/dental-implants')) {
      throw new Error('merge-into did not append to the service page');
    }
    const svc = await readFile(join(dir, 'src/pages/services/dental-implants.astro'), 'utf8');
    if (!svc.includes('permanent solution for missing teeth')) {
      throw new Error('source text missing from the appended section');
    }
    if (r.unresolved.length) throw new Error(`unresolved: ${r.unresolved.map(u => u.reason).join(', ')}`);
    return `${r.written.length} ported, ${r.appended.length} appended`;
  });

  // -- blog ----------------------------------------------------------------
  await check('generateBlogStubs', async () => {
    const dir = join(root, 'blog'); await mkdir(dir, { recursive: true }); await scaffold(dir);
    const { generateBlogStubs } = await import('../lib/blog-generator.js');
    const r = await generateBlogStubs({ ...merged(), bronze: bronze() }, dir, null);
    const files = (await readdir(join(dir, 'src/content/blog'))).filter(f => f.endsWith('.md'));
    if (!files.includes('caring-for-implants.md')) throw new Error('post slug not preserved');
    const md = await readFile(join(dir, 'src/content/blog/caring-for-implants.md'), 'utf8');
    const desc = md.match(/^description:\s*"([\s\S]*?)"\s*$/m)?.[1] || '';
    if (desc.length > 160) throw new Error(`description ${desc.length} chars — over the collection limit`);
    if (!/^migrated: true$/m.test(md)) throw new Error('migrated flag missing');
    return `${r.count} post(s), description ${desc.length} chars`;
  });

  // -- injector ------------------------------------------------------------
  await check('injectTailwindConfig · WCAG guard', async () => {
    const dir = join(root, 'tw'); await mkdir(dir, { recursive: true }); await scaffold(dir);
    const { injectTailwindConfig } = await import('../lib/injector.js');
    await injectTailwindConfig(merged(), dir);
    // Colours live in src/styles/tokens.css, not in tailwind.config.mjs. This
    // test used to parse hex out of the config; against a tokenised config
    // that regex matches nothing, every role is skipped by `if (!brand[role])`
    // and the check passes vacuously — it reported "primary undefined, accent
    // undefined both >= 4.5:1". Assert the values were found, so the next move
    // fails loudly instead of quietly.
    const tokens = await readFile(join(dir, 'src/styles/tokens.css'), 'utf8');
    const { contrast } = await import('../lib/contrast.js');

    const themeBlock = /@theme\s*\{([\s\S]*?)\}/.exec(tokens)?.[1] || '';
    const brand = {};
    for (const m of themeBlock.matchAll(/--color-brand-(\w[\w-]*)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      brand[m[1]] = m[2];
    }
    for (const role of ['primary', 'accent']) {
      if (!brand[role]) throw new Error(`tokens.css has no --color-brand-${role}`);
      const ratio = contrast(brand[role], '#ffffff');
      if (ratio < 4.5) throw new Error(`${role} ${brand[role]} is ${ratio.toFixed(2)}:1 on white`);
    }

    // The dark band needs its own counterparts: a colour corrected for AA on
    // white is pushed away from AA on the dark ground.
    const darkBlock = /\.section-dark\s*\{([\s\S]*?)\}/.exec(tokens)?.[1] || '';
    const dark = {};
    for (const m of darkBlock.matchAll(/--color-([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      dark[m[1]] = m[2];
    }
    if (!dark['surface-1']) throw new Error('.section-dark declares no surface-1');
    for (const role of ['brand-primary', 'brand-accent', 'brand-highlight']) {
      if (!dark[role]) throw new Error(`.section-dark has no --color-${role}`);
      const ratio = contrast(dark[role], dark['surface-1']);
      if (ratio < 4.5) throw new Error(`${role} ${dark[role]} is ${ratio.toFixed(2)}:1 on the dark band`);
    }
    return `light + dark contexts both >= 4.5:1 (primary ${brand.primary} / ${dark['brand-primary']})`;
  });

  await check('injectNavigation · ledger mapping', async () => {
    const dir = join(root, 'nav'); await mkdir(dir, { recursive: true }); await scaffold(dir);
    const { injectNavigation, __buildLedgerRouteMap } = await import('../lib/injector.js');
    const data = merged();
    await injectNavigation(data, dir, __buildLedgerRouteMap(architecture(), data));
    const nav = await readFile(join(dir, 'src/config/navigation.ts'), 'utf8');
    if (!/navLinks/.test(nav)) throw new Error('navLinks not written');
    return 'navigation.ts written';
  });

  // -- generated-component colour repairs ----------------------------------
  // These run on markup a model produced, so they are the last line of defence
  // between a low-contrast component and 16 pages of the built site.
  await check('generated component colour repairs', async () => {
    const mod = await readFile(resolve('scripts/pipeline/lib/generate-sections.js'), 'utf8');
    const src = /function repairComponentColours\(content\) \{[\s\S]*?\n\}/.exec(mod)?.[0];
    const opa = /function repairTextOpacity\(content\) \{[\s\S]*?\n\}/.exec(mod)?.[0];
    const dark = /function repairPrimaryOnDark\(content\) \{[\s\S]*?\n\}/.exec(mod)?.[0];
    if (!src || !opa || !dark) throw new Error('repair functions not found');
    // eslint-disable-next-line no-new-func
    const repair = new Function(`${opa}\n${dark}\n${src}\nreturn repairComponentColours;`)();

    const darkFooter = repair('<footer class="bg-neutral-dark"><p class="text-brand-primary text-white/70">C</p></footer>');
    if (darkFooter.content.includes('text-brand-primary')) throw new Error('brand-primary left on a dark surface');
    if (darkFooter.content.includes('text-white/70')) throw new Error('low text opacity left in place');

    // Any text token, not just white/black — text-neutral-mid/30 shipped 8
    // nodes at 1.48:1 through the narrower form of this repair.
    const ghosted = repair('<section class="bg-white"><span class="text-neutral-mid/30">01</span></section>');
    if (ghosted.content.includes('text-neutral-mid/30')) throw new Error('non-white text opacity left in place');
    if (!ghosted.content.includes('text-neutral-mid')) throw new Error('token lost while stripping opacity');

    const bgOpacity = repair('<div class="bg-neutral-dark/80"><p class="text-white">x</p></div>');
    if (!bgOpacity.content.includes('bg-neutral-dark/80')) throw new Error('background opacity wrongly stripped');

    const lightSection = repair('<section class="bg-white"><p class="text-brand-primary">C</p></section>');
    if (!lightSection.content.includes('text-brand-primary')) throw new Error('brand-primary wrongly re-pointed on a light surface');

    const mixed = repair('<div class="bg-neutral-dark"><div class="bg-white"><p class="text-brand-primary">C</p></div></div>');
    if (!mixed.content.includes('text-brand-primary')) throw new Error('mixed-surface component wrongly re-pointed');

    const borders = repair('<div class="bg-neutral-dark"><hr class="border-white/20" /></div>');
    if (!borders.content.includes('border-white/20')) throw new Error('border opacity wrongly raised');

    return 'dark re-pointed, text opacity stripped, light + mixed + borders + bg untouched';
  });

  // -- ai-call wiring ------------------------------------------------------
  // A missing module-level constant here is a ReferenceError thrown the moment
  // callAnthropic is invoked — invisible to `node --check` and to any suite that
  // makes no API calls. That shipped once. Invoking without a key exercises the
  // parameter defaults without touching the network.
  await check('callAnthropic · module wiring', async () => {
    const mod = await import('../lib/ai-call.js');
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await mod.callAnthropic({ phase: 'content', model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'x' }] });
    } catch (err) {
      if (/is not defined/.test(err.message)) throw new Error(`unresolved constant — ${err.message}`);
      // Any other failure (missing key, auth) means the defaults resolved fine.
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
    const ledger = mod.getCostLedger();
    for (const k of ['networkLostSeconds', 'retriedCalls']) {
      if (!(k in ledger)) throw new Error(`ledger missing ${k}`);
    }
    return 'defaults resolve; ledger reports network telemetry';
  });

  // -- build manifest ------------------------------------------------------
  await check('build manifest · prunes only its own output', async () => {
    const dir = join(root, 'manifest'); await mkdir(join(dir, 'src/pages'), { recursive: true });
    const { openManifest } = await import('../lib/build-manifest.js');
    await writeFile(join(dir, 'src/pages/old.astro'), 'x');
    await writeFile(join(dir, 'src/pages/template.astro'), 'x');
    let m = await openManifest(dir);
    m.record('page-port', ['src/pages/old.astro']); await m.write();

    await writeFile(join(dir, 'src/pages/new.astro'), 'x');
    m = await openManifest(dir);
    m.record('page-port', ['src/pages/new.astro']);
    const { removed } = await m.prune(); await m.write();

    const left = await readdir(join(dir, 'src/pages'));
    if (left.includes('old.astro')) throw new Error('stale file not pruned');
    if (!left.includes('template.astro')) throw new Error('unrecorded file was pruned');
    return `pruned ${removed.length}, left template untouched`;
  });

} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} generator check(s) failed` : '\nAll generator checks passed');
process.exit(failed ? 1 : 0);
