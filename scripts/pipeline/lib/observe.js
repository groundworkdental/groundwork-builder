/**
 * observe.js — Screenshot + vision observation tool.
 *
 * The Designer Agent's eyes. Given a built Astro project, serves it locally,
 * screenshots it at multiple viewports and pages, and returns structured
 * observations (either raw base64 images for Vision, or a Claude-narrated
 * structured observation object).
 *
 * Usage:
 *   import { observe } from './observe.js';
 *   const obs = await observe({
 *     projectDir: '/tmp/springst-build',
 *     routes:     ['/', '/about', '/services'],
 *     viewports:  [{ w: 1280, h: 900 }, { w: 375, h: 812 }],
 *     narrate:    true,    // call Claude Vision to describe + flag issues
 *   });
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const MODEL = 'claude-sonnet-4-6';

const AXE_CORE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';

// Anthropic's vision API rejects images whose largest dimension exceeds 8000px.
// `fullPage: true` screenshots of long landing pages routinely break this on
// pages with many sections (hero + doctor + services + reviews + gallery + cta).
// We resize down to this cap before sending to the API. Headroom from 8000.
const MAX_IMAGE_DIMENSION = 7500;

// Above roughly this size on the long edge, the vision API downsamples the
// image before the model sees it. A 1280×5391 full-page capture therefore
// arrives as something near 372×1568 — a desktop layout squeezed to phone
// width, which is unreadable for judging typography, spacing, or hierarchy.
// The critique was scoring that. Tiles stay under the threshold on both edges,
// so they are passed through at full fidelity.
const VISION_LONG_EDGE = 1568;

// Tiles per viewport. The whole page isn't needed to judge craft, and each tile
// costs real tokens — the top of the page carries most of the design signal.
const MAX_TILES_PER_VIEWPORT = 3;

/**
 * Observe a built Astro project.
 *
 * @param {object} opts
 * @param {string} opts.projectDir  - path to the astro project (must be built already)
 * @param {string[]} [opts.routes]  - routes to capture. Default: ['/']
 * @param {{w:number,h:number}[]} [opts.viewports]
 * @param {boolean} [opts.narrate]  - if true, run Claude Vision over screenshots and return observations
 * @param {boolean} [opts.fullPage] - full-page screenshot (default true)
 * @returns {Promise<{ screenshots: {route, viewport, path, base64}[], observations?: any }>}
 */
export async function observe({
  projectDir,
  routes    = ['/'],
  viewports = [{ w: 1280, h: 900 }, { w: 375, h: 812 }],
  narrate   = false,
  fullPage  = true,
  measureContrast = true,
} = {}) {
  if (!projectDir) throw new Error('observe: projectDir required');

  // 1. Start preview server
  const server = await startPreview(projectDir);
  const base   = `http://localhost:${server.port}`;

  const outDir = join(projectDir, '_pipeline', 'screenshots');
  await mkdir(outDir, { recursive: true });

  const screenshots = [];
  let contrast = null;

  try {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const vp of viewports) {
        const ctx  = await browser.newContext({ viewport: { width: vp.w, height: vp.h }});
        const page = await ctx.newPage();
        for (const route of routes) {
          const url  = base + route;
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          const slug = `${route.replace(/^\/+|\/+$/g, '') || 'home'}-${vp.w}x${vp.h}`.replace(/\//g, '_');
          const path = join(outDir, `${slug}.png`);
          let buf    = await page.screenshot({ path, fullPage, type: 'png' });

          // Resize if either dimension exceeds the API's 8000px ceiling.
          // Long landing pages with full-page screenshots routinely hit this.
          buf = await ensureWithinDimensionCap(buf, path);

          // Slice the tall capture into viewport-sized tiles the API won't
          // downsample. One 1280×5391 image tells the model almost nothing;
          // three 1280×900 tiles show it the actual design.
          // Contrast is measurable, so measure it once rather than asking the
          // critique to judge it from a picture. One run scored contrast 7/10
          // and passed the gate on a page axe found 177 failures on.
          if (measureContrast && contrast === null) {
            contrast = await measureContrastViolations(page);
          }

          const tiles = await sliceIntoTiles(buf, vp, outDir, slug);
          for (const tile of tiles) {
            screenshots.push({
              route,
              viewport: vp,
              path:     tile.path,
              base64:   tile.buf.toString('base64'),
              bytes:     tile.buf.length,
              mediaType: tile.mediaType,
              tile:      tile.index,
              tiles:     tiles.length,
            });
          }
        }
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }

  let observations;
  if (narrate) observations = await narrateScreenshots(screenshots);

  return { screenshots, observations, contrast, base };
}

// ---------------------------------------------------------------------------
// Measured contrast
// ---------------------------------------------------------------------------

/**
 * Run axe-core's `color-contrast` rule against the live page.
 *
 * Returns null when axe can't be injected (offline, CSP) so callers can tell
 * "no violations" apart from "not measured" — scoring a dimension as clean
 * because the check failed to run is how the design gate lied in the first place.
 */
async function measureContrastViolations(page) {
  try {
    await page.addScriptTag({ url: AXE_CORE_CDN });
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const r = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } });
      const v = (r.violations || []).find(x => x.id === 'color-contrast');
      if (!v) return { violations: 0, samples: [] };
      return {
        violations: (v.nodes || []).length,
        samples: (v.nodes || []).slice(0, 5).map(n => ({
          html: (n.html || '').slice(0, 140),
          summary: (n.any?.[0]?.message || n.failureSummary || '').slice(0, 200),
        })),
      };
    });
    return result;
  } catch (err) {
    console.warn(`[observe] contrast measurement unavailable (${err.message}).`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tiling
// ---------------------------------------------------------------------------

/**
 * Cut a full-page capture into viewport-height tiles.
 *
 * Returns the original buffer as a single tile when the image is already small
 * enough to survive the vision pipeline intact, or when `sharp` is unavailable.
 */
async function sliceIntoTiles(buf, vp, outDir, slug) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    return [{ index: 0, buf, path: join(outDir, `${slug}.png`), mediaType: 'image/png' }];
  }

  try {
    const meta = await sharp(buf).metadata();
    const width  = meta.width  || vp.w;
    const height = meta.height || vp.h;

    // Already within the pass-through window — no tiling needed.
    if (Math.max(width, height) <= VISION_LONG_EDGE) {
      return [{ index: 0, buf, path: join(outDir, `${slug}.png`), mediaType: 'image/png' }];
    }

    // Tile height is capped so neither edge crosses the threshold.
    const tileHeight = Math.min(vp.h, VISION_LONG_EDGE, Math.max(1, height));
    const count = Math.min(MAX_TILES_PER_VIEWPORT, Math.ceil(height / tileHeight));

    const tiles = [];
    for (let i = 0; i < count; i++) {
      const top = i * tileHeight;
      const h   = Math.min(tileHeight, height - top);
      if (h <= 0) break;
      const tilePath = join(outDir, `${slug}-tile${i + 1}.jpg`);
      // JPEG, not PNG: per-tile PNGs actually total *more* bytes than the one
      // full-page PNG they replace, and payload size is what was dropping the
      // socket. q85 is visually lossless for judging layout and type.
      const tileBuf = await sharp(buf)
        .extract({ left: 0, top, width, height: h })
        .jpeg({ quality: 85 })
        .toBuffer();
      await writeFile(tilePath, tileBuf);
      tiles.push({ index: i, buf: tileBuf, path: tilePath, mediaType: 'image/jpeg' });
    }
    return tiles.length ? tiles : [{ index: 0, buf, path: join(outDir, `${slug}.png`) }];
  } catch (err) {
    console.warn(`[observe] tiling failed (${err.message}); using the full-page capture.`);
    return [{ index: 0, buf, path: join(outDir, `${slug}.png`), mediaType: 'image/png' }];
  }
}

// ---------------------------------------------------------------------------
// Image dimension cap
// ---------------------------------------------------------------------------

/**
 * Resize the screenshot if its largest dimension exceeds Anthropic's 8000px
 * limit. We use `sharp` (already a transitive dep) to keep aspect ratio while
 * downscaling. Returns the same buffer if already in range.
 *
 * Persists the resized buffer to disk too, so the saved screenshot matches
 * what the Vision API receives.
 */
async function ensureWithinDimensionCap(buf, savePath) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    // sharp not available — caller will get a too-large image and a 400 from
    // the API, but the build won't crash. Surface and move on.
    console.warn('[observe] `sharp` not available — screenshots not resized; long pages may exceed the Vision API 8000px limit.');
    return buf;
  }

  try {
    const meta = await sharp(buf).metadata();
    if ((meta.width || 0) <= MAX_IMAGE_DIMENSION && (meta.height || 0) <= MAX_IMAGE_DIMENSION) {
      return buf;
    }
    const resized = await sharp(buf)
      .resize({
        width:  MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit:    'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    if (savePath) await writeFile(savePath, resized);
    return resized;
  } catch (err) {
    console.warn(`[observe] resize failed (${err.message}); using original buffer.`);
    return buf;
  }
}

// ---------------------------------------------------------------------------
// Preview server (astro preview)
// ---------------------------------------------------------------------------

async function startPreview(projectDir) {
  // Pick a port in a high range to avoid collisions.
  const port = 4300 + Math.floor(Math.random() * 500);

  const proc = spawn('npx', ['astro', 'preview', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: projectDir,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for "is available" signal from astro preview
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString();
      // Astro v4: "preview server" / "is available" / "localhost:PORT"
      // Astro v5: " astro  v5.x.x ready in" or "Local   http://..."
      if (/preview server|is available|localhost:\d+|ready in \d+|Local\s+http/i.test(text)) {
        cleanup(); resolve();
      }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('astro preview did not start in 30s')); }, 30000);
    const cleanup = () => {
      proc.stdout?.off('data', onData);
      proc.stderr?.off('data', onData);
      proc.off('error', onErr);
      clearTimeout(timer);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', onErr);
  });

  return {
    port,
    stop: () => { try { proc.kill('SIGTERM'); } catch {} },
  };
}

// ---------------------------------------------------------------------------
// Claude narration (optional)
// ---------------------------------------------------------------------------

async function narrateScreenshots(shots) {
  const { callAnthropic } = await import('./ai-call.js');

  // Narrate each shot individually; keeps each request small and parseable.
  const perShot = [];
  for (const s of shots) {
    const res = await callAnthropic({
      phase:     'observe:narrate',
      model:     MODEL,
      maxTokens: 600,
      messages:  [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: s.mediaType || 'image/png', data: s.base64 } },
          {
            type: 'text',
            text:
`Observe this screenshot of route "${s.route}" at ${s.viewport.w}×${s.viewport.h}.

Return JSON only:
{
  "first_impression": "<1 sentence, what a visitor sees first>",
  "composition":      "<1-2 sentence description of layout / rhythm>",
  "text_hierarchy":   "<is the main message clear? what competes with it?>",
  "concerns":         ["<concrete observation 1>", "<observation 2>", "..."],
  "ai_slop_tells":    ["<specific tells if any; empty if clean>"],
  "mobile_issues":    ["<only for narrow viewports>"],
  "notable_details":  ["<positive or neutral things worth naming>"]
}`,
          },
        ],
      }],
    });

    const text = res.text;
    const f = text.indexOf('{'), l = text.lastIndexOf('}');
    let parsed = null;
    try { parsed = JSON.parse(text.slice(f, l + 1)); } catch {}
    perShot.push({ route: s.route, viewport: s.viewport, observation: parsed, raw: !parsed ? text : undefined });
  }
  return perShot;
}
