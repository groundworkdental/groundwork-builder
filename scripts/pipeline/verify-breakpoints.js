#!/usr/bin/env node
/**
 * verify-breakpoints.js — layout checks at the widths where things actually break.
 *
 * Layout bugs do not live at the sizes people test. They live one pixel below
 * a breakpoint, where the desktop nav is still rendering but has run out of
 * room. A longer practice name is enough to do it, and checking a wide desktop
 * and a phone — the two sizes everyone checks — misses it completely.
 *
 * So this samples the edges: 1px under and over each Tailwind breakpoint,
 * plus the narrowest realistic phone.
 *
 * Two failure modes, both measured rather than eyeballed:
 *   overflow   the document scrolls horizontally — something is wider than
 *              the viewport
 *   collision  two header items overlap, which is what a nav looks like just
 *              before it wraps
 *
 * Needs a server; run it against a preview deployment or a local preview.
 *
 *   node scripts/pipeline/verify-breakpoints.js http://localhost:4321 [/about /services]
 */

import { chromium } from 'playwright';

// 1px either side of each Tailwind breakpoint, plus a small phone. The -1
// widths are the interesting ones: the layout above still applies there.
const WIDTHS = [375, 639, 641, 767, 769, 1023, 1025, 1279, 1281];
const HEIGHT = 900;

const results = [];

/** Do two rects overlap by more than a hairline? */
function overlaps(a, b, tolerance = 1) {
  return (
    a.x + a.width - tolerance > b.x &&
    b.x + b.width - tolerance > a.x &&
    a.y + a.height - tolerance > b.y &&
    b.y + b.height - tolerance > a.y
  );
}

async function checkWidth(page, url, width) {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(url, { waitUntil: 'networkidle' });

  const report = await page.evaluate((overlapsSrc) => {
    const overlapsFn = eval(`(${overlapsSrc})`);
    const out = { overflow: null, collisions: [] };

    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      // Name the widest offender — "something overflows" is not actionable.
      let worst = null;
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const past = r.right - doc.clientWidth;
        if (past > 1 && (!worst || past > worst.past)) {
          worst = { past: Math.round(past), tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60) };
        }
      }
      out.overflow = { by: doc.scrollWidth - doc.clientWidth, worst };
    }

    // Header children colliding is the signature of a nav about to wrap.
    const header = document.querySelector('header');
    if (header) {
      const items = [...header.querySelectorAll('a, button')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r, el }) => r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden');
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          // Skip ancestor/descendant pairs — those overlap by definition.
          if (items[i].el.contains(items[j].el) || items[j].el.contains(items[i].el)) continue;
          if (overlapsFn(items[i].r, items[j].r)) {
            out.collisions.push(
              `${(items[i].el.textContent || '').trim().slice(0, 20)} / ${(items[j].el.textContent || '').trim().slice(0, 20)}`,
            );
          }
        }
      }
    }
    return out;
  }, overlaps.toString());

  return report;
}

async function main() {
  const base = process.argv[2];
  const paths = process.argv.slice(3);
  if (!base) {
    console.error('usage: node scripts/pipeline/verify-breakpoints.js <base-url> [paths...]');
    process.exit(2);
  }
  const routes = paths.length ? paths : ['/'];

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    for (const route of routes) {
      const url = new URL(route, base).href;
      for (const width of WIDTHS) {
        let r;
        try {
          r = await checkWidth(page, url, width);
        } catch (err) {
          results.push({ ok: false, name: `${route} @${width}`, detail: err.message });
          continue;
        }
        const problems = [];
        if (r.overflow) {
          const w = r.overflow.worst;
          problems.push(
            `scrolls horizontally by ${r.overflow.by}px` +
              (w ? ` — widest offender <${w.tag} class="${w.cls}"> past edge by ${w.past}px` : ''),
          );
        }
        if (r.collisions.length) {
          problems.push(`header items overlap: ${[...new Set(r.collisions)].slice(0, 3).join('; ')}`);
        }
        results.push({ ok: !problems.length, name: `${route} @${width}px`, detail: problems.join(' · ') });
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`FAIL  ${r.name} — ${r.detail}`);
  console.log(
    `\n${results.length - failed.length}/${results.length} viewport checks passed ` +
      `(${routes.length} route(s) × ${WIDTHS.length} widths)`,
  );
  process.exit(failed.length ? 1 : 0);
}

main();
