/**
 * distill-design.js — translate any design reference into a compact fingerprint.
 *
 * Input: a URL or a local repo path.
 * Output: ~1–2 KB JSON design fingerprint in _memory/library/{slug}.json,
 *         manifest entry appended to _memory/library/index.json.
 *
 * Usage (programmatic):
 *   import { distillDesign } from './distill-design.js';
 *   await distillDesign({ source: 'https://example.com', slug: 'foo', tag: 'inspo' });
 *
 * Usage (CLI, see distill-cli.js):
 *   node scripts/pipeline/distill-cli.js --url https://x.com --slug x --tag inspo
 */

import { readFile, writeFile, mkdir, readdir, stat, open, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { selectInspoEntries } from './design-library-catalog.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const LIBRARY_DIR  = join(PROJECT_ROOT, '_memory', 'library');
const INDEX_FILE   = join(LIBRARY_DIR, 'index.json');
const MODEL        = 'claude-haiku-4-5';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function distillDesign({ source, slug, tag = 'inspo', note = '' }) {
  if (!source || !slug) throw new Error('distillDesign: source and slug are required');
  if (!['own', 'inspo', 'anti'].includes(tag)) {
    throw new Error(`distillDesign: tag must be own|inspo|anti (got "${tag}")`);
  }

  await mkdir(LIBRARY_DIR, { recursive: true });

  const payload = /^https?:\/\//.test(source)
    ? await gatherFromUrl(source)
    : await gatherFromRepo(source);

  const fingerprint = await callClaudeForFingerprint(payload, slug, tag, note);
  fingerprint.slug     = slug;
  fingerprint.source   = source;
  fingerprint.tag      = tag;
  fingerprint.captured = new Date().toISOString().slice(0, 10);
  if (note) fingerprint.note = note;

  const outPath = join(LIBRARY_DIR, `${slug}.json`);
  const fingerprintJson = JSON.stringify(fingerprint, null, 2);
  await writeFile(outPath, fingerprintJson);
  await updateIndex(fingerprint);

  // Sync to GCS so the design library is shared across environments
  try {
    const { libraryWrite } = await import('./storage.js');
    await libraryWrite(slug, fingerprintJson, outPath);
  } catch { /* non-fatal — local file remains the source of truth */ }

  // Sync to local design library index (_memory/library/)
  try {
    const { upsertDesignLibrary } = await import('./db.js');
    await upsertDesignLibrary(fingerprint);
  } catch { /* non-fatal */ }

  return { fingerprint, path: outPath };
}

/**
 * Return a curated set of fingerprints for the Creative Director:
 *   - owns:   recent own-builds to DIVERGE from
 *   - inspos: external references to pull toward
 * Also returns the full index so the director can reason about freshness/tags.
 */
/**
 * @param {object} opts
 * @param {number} [opts.ownLimit=5]
 * @param {number} [opts.inspoLimit=4]
 * @param {string} [opts.moodHint] - brand/design mood for mood-aware inspo selection
 */
export async function sampleLibrary({ ownLimit = 5, inspoLimit = 4, moodHint = '' } = {}) {
  const pickEntries = (index) => {
    const owns = index.entries.filter(e => e.tag === 'own')
      .sort((a, b) => (b.captured || '').localeCompare(a.captured || ''))
      .slice(0, ownLimit);

    const inspoPool = index.entries.filter(e => e.tag === 'inspo');
    const inspos = inspoPool.some(e => Array.isArray(e.dentalMoods) && e.dentalMoods.length)
      ? selectInspoEntries(inspoPool, moodHint, inspoLimit)
      : inspoPool.sort(() => Math.random() - 0.5).slice(0, inspoLimit);

    const antis = index.entries.filter(e => e.tag === 'anti');
    return { owns, inspos, antis };
  };

  // Load from local _memory/library/ index
  let index = null;
  try {
    const { queryDesignLibrary, loadDesignFingerprint } = await import('./db.js');
    const dbIndex = await queryDesignLibrary();
    if (dbIndex) {
      index = dbIndex;
      const { owns, inspos, antis } = pickEntries(index);

      const loadDb = (e) => loadDesignFingerprint(e.slug);
      const [ownFP, inspoFP, antiFP] = await Promise.all([
        Promise.all(owns.map(loadDb)),
        Promise.all(inspos.map(loadDb)),
        Promise.all(antis.map(loadDb)),
      ]);
      return {
        own:   ownFP.filter(Boolean),
        inspo: inspoFP.filter(Boolean),
        anti:  antiFP.filter(Boolean),
        totals: { own: owns.length, inspo: inspos.length, anti: antis.length, library: index.entries.length },
      };
    }
  } catch { /* fall through to local */ }

  // Local fallback
  index = await readIndex();
  const { owns, inspos, antis } = pickEntries(index);

  const load = async (e) => {
    try { return JSON.parse(await readFile(join(LIBRARY_DIR, `${e.slug}.json`), 'utf8')); }
    catch { return null; }
  };
  const [ownFP, inspoFP, antiFP] = await Promise.all([
    Promise.all(owns.map(load)),
    Promise.all(inspos.map(load)),
    Promise.all(antis.map(load)),
  ]);
  return {
    own:   ownFP.filter(Boolean),
    inspo: inspoFP.filter(Boolean),
    anti:  antiFP.filter(Boolean),
    totals: { own: owns.length, inspo: inspos.length, anti: antis.length, library: index.entries.length },
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function gatherFromUrl(url) {
  const res  = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Groundwork/distill' } });
  const html = await res.text();
  const dom  = new JSDOM(html, { url });
  const doc  = dom.window.document;

  const title = doc.querySelector('title')?.textContent?.trim() || '';

  // Collect inline styles + linked stylesheets (first 3, capped)
  const cssPieces = [];
  for (const el of doc.querySelectorAll('style')) cssPieces.push(el.textContent || '');
  const links = [...doc.querySelectorAll('link[rel="stylesheet"]')].slice(0, 3);
  for (const link of links) {
    try {
      const href = new URL(link.getAttribute('href'), url).href;
      const txt  = await fetch(href).then(r => r.text()).catch(() => '');
      if (txt) cssPieces.push(txt);
    } catch {}
  }
  const css = cssPieces.join('\n\n').slice(0, 40_000);

  // Strip heavy tags so Claude sees structure, not noise.
  for (const el of doc.querySelectorAll('script, noscript, svg, iframe')) el.remove();
  const htmlStripped = doc.body?.innerHTML?.slice(0, 50_000) || '';

  return { kind: 'url', url, title, html: htmlStripped, css };
}

async function gatherFromRepo(repoPath) {
  const root = resolve(repoPath);
  const want = [
    'tailwind.config.mjs', 'tailwind.config.js',
    'src/styles/global.css', 'src/styles/main.css',
    'src/pages/index.astro',
    'src/layouts/BaseLayout.astro',
    'src/components/Header.astro',
    'src/components/CTABlock.astro',
    'src/config/site.ts',
  ];
  const parts = [];
  for (const rel of want) {
    try {
      const content = await readFile(join(root, rel), 'utf8');
      parts.push(`=== ${rel} ===\n${content.slice(0, 10_000)}`);
    } catch {}
  }
  // Also peek at what components exist
  let componentsList = '';
  try {
    const files = await readdir(join(root, 'src', 'components'));
    componentsList = files.join(', ');
  } catch {}
  return { kind: 'repo', root, files: parts.join('\n\n'), componentsList };
}

// ---------------------------------------------------------------------------
// Claude call
// ---------------------------------------------------------------------------

const FINGERPRINT_SCHEMA = `
Return ONLY a JSON object, no prose, no markdown fences:
{
  "palette":   { "primary":"#...","secondary":"#...","accent":"#...","background":"#...","mood":"<2–4 words>" },
  "type":      { "display":"<family>","body":"<family>","scale":"editorial|standard|compact","contrast":"high|medium|low" },
  "layout":    { "archetype":"editorial-asymmetric|centered-classic|magazine-split|minimal-brutalist|warm-editorial|card-heavy|poster-hero|other",
                 "density":"airy|balanced|dense",
                 "grid":"12col|broken|asymmetric|none" },
  "hero":      { "variant":"centered|asymmetric-left|asymmetric-right|split-image|full-bleed|poster|text-only",
                 "imageTreatment":"warm-documentary|clinical-bright|editorial-muted|none" },
  "sections":  ["array","of","section-keywords","in","order"],
  "cards":     "bordered-flat|soft-shadow|elevated|ghost|none",
  "motion":    "none|subtle|expressive",
  "radius":    "sharp|sm|md|lg|pill|mixed",
  "fontPair":  "HeadingFont/BodyFont (e.g. Fraunces/Figtree)",
  "adjectives":["3 to 6 short descriptors for the overall feel"]
}`;

async function callClaudeForFingerprint(payload, slug, tag, note) {
  const { callAnthropic } = await import('./ai-call.js');

  const sourceBlock = payload.kind === 'url'
    ? `SOURCE: URL ${payload.url}\nTITLE: ${payload.title}\n\n--- CSS (truncated) ---\n${payload.css}\n\n--- HTML (body, truncated) ---\n${payload.html}`
    : `SOURCE: Repo ${payload.root}\nComponents folder: ${payload.componentsList}\n\n--- Key files ---\n${payload.files}`;

  const prompt = [
    `You are a senior design director distilling a reference into a compact fingerprint.`,
    `Target slug: ${slug} (tagged "${tag}"). ${note ? 'Note: ' + note : ''}`,
    ``,
    `Read the reference below and emit a fingerprint JSON.`,
    `Be decisive — pick ONE value per field, no hedging. Keep adjectives short and specific.`,
    FINGERPRINT_SCHEMA,
    ``,
    sourceBlock,
  ].join('\n');

  const res = await callAnthropic({
    phase:       'distill',
    model:       MODEL,
    maxTokens:   1500,
    temperature: 0.3,
    messages:    [{ role: 'user', content: prompt }],
  });

  const text = res.text;
  const first = text.indexOf('{'); const last = text.lastIndexOf('}');
  const raw   = first !== -1 && last > first ? text.slice(first, last + 1) : text;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`distill: failed to parse fingerprint JSON for ${slug}: ${err.message}\n${raw.slice(0,400)}`);
  }
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

async function readIndex() {
  try {
    const txt = await readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed;
  } catch {
    return { entries: [] };
  }
}

async function updateIndex(fp) {
  await mkdir(LIBRARY_DIR, { recursive: true });
  const lockPath = `${INDEX_FILE}.lock`;
  const started = Date.now();
  // Simple exclusive lock so parallel builds don't clobber index.json (RMW race).
  while (true) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - started > 15_000) {
        // Stale lock — steal
        try { await unlink(lockPath); } catch { /* ignore */ }
        continue;
      }
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  try {
    const idx = await readIndex();
    const entry = {
      slug:       fp.slug,
      tag:        fp.tag,
      source:     fp.source,
      captured:   fp.captured,
      archetype:  fp.layout?.archetype || null,
      mood:       fp.palette?.mood || null,
      fontPair:   fp.fontPair || null,
      adjectives: fp.adjectives || [],
    };
    const existingIdx = idx.entries.findIndex(e => e.slug === fp.slug);
    if (existingIdx >= 0) idx.entries[existingIdx] = entry;
    else idx.entries.push(entry);
    await writeFile(INDEX_FILE, JSON.stringify(idx, null, 2));
  } finally {
    try { await unlink(lockPath); } catch { /* ignore */ }
  }
}
