#!/usr/bin/env node
/**
 * verify-launch.js — go-live gates against a built client directory.
 *
 * verify-build.js asks "did the generator produce a coherent site?".
 * This asks "is this site fit to put in front of patients and Google?".
 * Every check below is a bug that shipped to production on a live client
 * site and was found by hand afterwards, not by any script:
 *
 *   no contact path     the site launched with zero forms, zero mailto
 *                       links and zero tel: links. Nobody could reach the
 *                       practice from the website at all, and the Google
 *                       listing had already logged 45 interactions.
 *   scaffold placeholder robots.txt shipped pointing at
 *                       example.com/sitemap-index.xml — a domain we do not
 *                       own. Search Console submission was blocked.
 *   empty config href   an unset phone produced `href="tel:"` twice,
 *                       including one wrapping empty link text, so the page
 *                       read "call us at ." with an empty clickable link.
 *   redirecting sitemap a page kept its route while _redirects also matched
 *                       it, so the sitemap advertised a URL that 301s.
 *                       Search Console reports these as "Page with redirect".
 *   soft 404s           no 404.html in the build, so Cloudflare Pages served
 *                       index.html with a 200 for every unmatched route.
 *                       /anything-at-all/ returned the full homepage. Every
 *                       typo was an indexable duplicate.
 *   dirty working tree  a deploy ships what is on disk, not what is in git.
 *                       One client repo had 33 uncommitted files diverging
 *                       from production; this repo had 99. If several people
 *                       or agents share a checkout, a deploy can carry
 *                       someone else's half-finished work.
 *   mismatched crops    a replaced headshot at a different aspect ratio to
 *                       its siblings is glaring in a team grid, and a
 *                       thumbnail that disagrees with its parent makes
 *                       responsive <picture> swaps jump.
 *   dead asset refs     BaseLayout defaulted og:image to a file the pipeline
 *                       never generated. It 404'd in production, so every
 *                       social share and link preview of the site was broken
 *                       — silently, because nothing validates an og: URL.
 *   truncated meta      descriptions cut mid-word by a hard slice, which is
 *                       what a searcher reads in the result.
 *
 * The through-line: an unset value renders as broken output rather than as
 * absent output. Templates must guard, and this catches them when they don't.
 *
 * No AI, no network, runs in about a second.
 *
 *   node scripts/pipeline/verify-launch.js clients/<slug>
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });
/**
 * Advisory: surfaced, but does not block the launch.
 *
 * Reserved for findings a human has to judge. A dirty working tree may be a
 * legitimate mid-build tweak or may be someone else's unfinished work; a crop
 * mismatch may be deliberate. Failing on either would train people to pass
 * --force, which costs more than the check is worth.
 */
const warn = (name, detail) => results.push({ ok: true, warn: true, name, detail });

const exists = (p) => access(p).then(() => true).catch(() => false);
const readMaybe = (p) => readFile(p, 'utf8').catch(() => null);

/** Every built HTML file, as [routePath, html]. */
async function htmlPages(distDir) {
  const pages = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.html')) {
        pages.push([`/${relative(distDir, full)}`, await readFile(full, 'utf8')]);
      }
    }
  }
  await walk(distDir);
  return pages;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * A patient must be able to start a conversation from the website.
 *
 * Deliberately generous about *how*: a form, a mailto, or a tel: all count,
 * because which one is available depends on what the practice has given us.
 * Zero of the three is never acceptable, whatever is still pending.
 */
function checkContactPath(pages) {
  const routes = { form: [], mailto: [], tel: [] };
  for (const [route, html] of pages) {
    if (/<form[\s>]/i.test(html)) routes.form.push(route);
    if (/href="mailto:[^"]+"/i.test(html)) routes.mailto.push(route);
    if (/href="tel:[^"]+"/i.test(html)) routes.tel.push(route);
  }
  const total = routes.form.length + routes.mailto.length + routes.tel.length;
  if (total === 0) {
    fail(
      'contact path',
      'no form, mailto: or tel: anywhere in the build — a visitor has no way ' +
        'to reach the practice. Ship at least one before go-live.',
    );
    return;
  }
  const kinds = Object.entries(routes)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k} on ${v.length} page(s)`);
  pass('contact path', kinds.join(', '));
}

/**
 * An unset config value must render as nothing, not as a broken link.
 * `href="tel:"` and `href="mailto:"` are the signatures of a template
 * interpolating an empty string instead of guarding on it.
 */
function checkEmptyHrefs(pages) {
  const bad = [];
  for (const [route, html] of pages) {
    for (const m of html.matchAll(/href="(tel:|mailto:|)"/gi)) {
      bad.push(`${route} → href="${m[1]}"`);
    }
  }
  if (bad.length) {
    fail(
      'empty hrefs',
      `${bad.length} dead link(s) from unset config: ${bad.slice(0, 5).join(', ')}` +
        `${bad.length > 5 ? ` (+${bad.length - 5} more)` : ''}`,
    );
    return;
  }
  pass('empty hrefs', 'no tel:/mailto:/empty href placeholders');
}

/**
 * Scaffold text that must never reach a patient or a crawler.
 *
 * Every pattern here is deliberately narrow. An earlier version flagged the
 * bare words TODO, TBD and "lorem ipsum" anywhere in the output, which
 * produced three false positives on the first real site it ran against:
 *
 *   "Real content, not lorem ipsum"          — sales copy, a selling point
 *   "Still TBD. Address and hours are on..." — accurate prose about a phone
 *   "Phone and official logo remain TBD"     — a genuine status note
 *
 * A gate that cries wolf on legitimate prose gets muted, and then it misses
 * the real thing. So match the SHAPE of scaffolding — a comment, a bracketed
 * stub, an unreplaced token, a known placeholder literal — not vocabulary
 * that normal writing shares with it.
 */
const PLACEHOLDERS = [
  // The scaffold origin: a site shipped robots.txt pointing at example.com.
  ['example.com', /\bexample\.com\b/i],
  // Unreplaced template tokens.
  ['unreplaced token', /\{\{[^}]{1,60}\}\}/],
  // Placeholder literals we ship in scaffolds. G-XXXXXXXXXX reached a live
  // site and was then faithfully reported by our own audit tool as
  // "GA4 script detected (G-XXXXXXXXXX)" in client-facing collateral.
  ['placeholder literal', /G-X{4,}|\[PHONE\]|\[EMAIL\]|\[ADDRESS\]|YOUR_[A-Z_]{3,}/],
  // Authoring notes left in markup — the shape, not the word. This is what
  // caught a blog post published with nothing but section stubs.
  ['authoring comment', /<!--\s*(TODO|TBD|FIXME|XXX)\b/i],
  // Bracketed writing prompts: "[Write an introduction addressing...]".
  ['bracketed stub', /\[(Write|Add|Insert|Describe|Section)\b[^\]]{6,120}\]/i],
  // Lorem only when it runs as actual filler prose, not when a sentence
  // mentions it. Three or more consecutive latin filler words.
  ['lorem filler', /\blorem ipsum dolor\b/i],
  // A CTA whose own label says it does not work.
  ['dead CTA label', /<a\b[^>]*>[^<]*\bcoming soon\b[^<]*<\/a>/i],
];

function checkPlaceholders(pages, robotsTxt) {
  const hits = [];
  const scan = (label, text) => {
    for (const [name, re] of PLACEHOLDERS) {
      if (re.test(text)) hits.push(`${label}: ${name}`);
    }
  };
  for (const [route, html] of pages) scan(route, html);
  if (robotsTxt) scan('robots.txt', robotsTxt);

  if (hits.length) {
    fail('placeholders', `${hits.length} hit(s): ${[...new Set(hits)].slice(0, 6).join(', ')}`);
    return;
  }
  pass('placeholders', 'no scaffold text in output');
}

/**
 * The sitemap is a list of canonical destinations, so every URL in it must
 * return 200. A path that also matches a _redirects rule will 301, and
 * Cloudflare Pages evaluates _redirects BEFORE static assets — so the page
 * existing in dist/ does not save it. Redirect a path, delete its page.
 */
async function checkSitemapVsRedirects(distDir, pages) {
  const sitemap = await readMaybe(join(distDir, 'sitemap-0.xml'));
  if (!sitemap) {
    pass('sitemap vs redirects', 'no sitemap-0.xml to check');
    return;
  }
  const redirects = await readMaybe(join(distDir, '_redirects'));
  const rules = (redirects || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);

  const norm = (p) => `/${String(p).replace(/^\/+|\/+$/g, '')}`.replace(/\/+$/, '') || '/';
  const ruleSet = new Set(rules.map(norm));

  const shadowed = [];
  for (const m of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    let path;
    try { path = norm(new URL(m[1]).pathname); } catch { continue; }
    if (ruleSet.has(path)) shadowed.push(m[1]);
  }

  if (shadowed.length) {
    fail(
      'sitemap vs redirects',
      `${shadowed.length} sitemap URL(s) also match a _redirects rule and will ` +
        `301: ${shadowed.slice(0, 4).join(', ')}. Delete the page or drop the rule.`,
    );
    return;
  }
  pass('sitemap vs redirects', `${ruleSet.size} rule(s), none shadow a sitemap URL`);
}

/**
 * PUBLIC_* build variables must live in wrangler.toml.
 *
 * When a Wrangler config file is present, Cloudflare Pages reads build
 * configuration from it and IGNORES variables set in the dashboard. A GA4 id
 * added through the dashboard was silently dropped from three builds before
 * the build log made it obvious ("Build environment variables: NODE_VERSION"
 * and nothing else). Retrying the deployment never helps.
 */
async function checkWranglerVars(clientDir) {
  const toml = await readMaybe(join(clientDir, 'wrangler.toml'));
  if (!toml) {
    pass('wrangler vars', 'no wrangler.toml — dashboard variables apply normally');
    return;
  }
  if (!/^\s*\[vars\]/m.test(toml)) {
    // Advisory, not fatal: whether this matters depends on how the project
    // deploys and where its values come from. On Cloudflare's own build
    // system a wrangler.toml supersedes dashboard variables, so a PUBLIC_*
    // set there is silently dropped — that cost three builds on one site.
    // But a project deployed with a local `wrangler pages deploy` never uses
    // either mechanism (its build reads .env or committed config), and a
    // value committed to source needs no [vars] at all. Failing here would
    // flag correct setups, and a gate that flags correct setups gets muted.
    warn(
      'wrangler vars',
      'wrangler.toml has no [vars] block. If this site relies on PUBLIC_* at ' +
        'BUILD time and is built by Cloudflare, those values must be declared ' +
        'here — dashboard variables are ignored when this file exists. ' +
        'Not a problem if the values are committed or the site deploys locally.',
    );
    return;
  }
  const declared = [...toml.matchAll(/^\s*(PUBLIC_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
  pass(
    'wrangler vars',
    declared.length
      ? `[vars] declares ${declared.join(', ')}`
      : '[vars] present (no PUBLIC_* yet — add them here, not in the dashboard)',
  );
}



/**
 * A deploy ships the working tree, not the last commit.
 *
 * "git push" and "deploy" are different risk levels: push ships committed
 * history, deploy builds whatever is physically on disk — including edits
 * nobody has reviewed, and including other people's if a checkout is shared.
 * Warn rather than fail: mid-build local tweaks are legitimate, walking past
 * 33 unexplained files is not.
 */
async function checkWorkingTree(clientDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  let stdout;
  try {
    ({ stdout } = await run('git', ['status', '--porcelain'], { cwd: clientDir }));
  } catch {
    pass('working tree', 'not a git repo — nothing to compare');
    return;
  }
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    pass('working tree', 'clean — the build matches committed history');
    return;
  }
  warn(
    'working tree',
    `${lines.length} uncommitted change(s); a deploy ships these. ` +
      `If they are not yours, find out whose before deploying: ` +
      lines.slice(0, 3).map((l) => l.split(/\s+/).pop()).join(', ') +
      (lines.length > 3 ? ` (+${lines.length - 3} more)` : ''),
  );
}

/**
 * Images in a set must share an aspect ratio, and a size variant must match
 * its parent.
 *
 * A headshot swapped in at a different crop is obvious in a team grid, and a
 * -480 variant that disagrees with its full-size parent makes responsive
 * swaps jump on resize. Both are cheap to measure and easy to miss by eye.
 *
 * Reads intrinsic dimensions straight from the file headers so it needs no
 * image library.
 */
function imageSize(buf) {
  // PNG: IHDR at byte 16
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: walk segments to the first SOF
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  // WebP (VP8X / VP8 / VP8L)
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

async function checkImageSets(clientDir) {
  const { readdir: rd, readFile: rf } = await import('node:fs/promises');
  const dirs = ['public/images/doctors', 'public/images/team', 'public/images/staff'];
  const problems = [];
  let checked = 0;

  for (const rel of dirs) {
    const dir = join(clientDir, rel);
    let files;
    try { files = await rd(dir); } catch { continue; }

    const sizes = new Map();
    for (const f of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const size = imageSize(await rf(join(dir, f)));
      if (size?.w && size?.h) sizes.set(f, { ...size, ratio: size.w / size.h });
    }
    if (sizes.size < 2) continue;
    checked += sizes.size;

    // A variant (name-480.webp) must match its parent's ratio.
    for (const [name, s] of sizes) {
      const parent = name.replace(/-\d+(\.[a-z]+)$/i, '$1');
      if (parent === name) continue;
      const p = sizes.get(parent);
      if (p && Math.abs(p.ratio - s.ratio) > 0.02) {
        problems.push(`${rel}/${name} ${s.ratio.toFixed(2)} vs parent ${p.ratio.toFixed(2)}`);
      }
    }

    // Full-size siblings should share one crop convention.
    const fulls = [...sizes.entries()].filter(([n]) => !/-\d+\.[a-z]+$/i.test(n));
    if (fulls.length > 1) {
      const ratios = fulls.map(([, s]) => s.ratio);
      const spread = Math.max(...ratios) - Math.min(...ratios);
      if (spread > 0.02) {
        problems.push(
          `${rel}: siblings disagree on crop (${fulls.map(([n, s]) => `${n} ${s.ratio.toFixed(2)}`).join(', ')})`,
        );
      }
    }
  }

  if (!checked) {
    pass('image sets', 'no multi-image sets to compare');
    return;
  }
  problems.length
    ? warn('image sets', problems.join('; '))
    : pass('image sets', `${checked} image(s) share a consistent crop`);
}



/**
 * Every local asset a page points at must exist in the output.
 *
 * og:image is the dangerous one: nothing validates it, no page looks broken,
 * and the failure is only visible when someone shares a link. One site
 * shipped with every social preview broken because the layout defaulted to a
 * conventional filename the pipeline never generated.
 *
 * Checks src, href, og:image and schema image. Skips absolute URLs and data
 * URIs — those are somebody else's to serve.
 */
async function checkAssetReferences(distDir, pages) {
  const { access: acc } = await import('node:fs/promises');
  const exists = (p) => acc(p).then(() => true).catch(() => false);

  const missing = new Map();
  const seen = new Set();

  for (const [route, html] of pages) {
    const refs = new Set();

    for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) refs.add(m[1]);
    for (const m of html.matchAll(/property="og:image"[^>]*content="([^"]+)"/g)) refs.add(m[1]);
    for (const m of html.matchAll(/content="([^"]+)"[^>]*property="og:image"/g)) refs.add(m[1]);
    // schema.org image values, which are often absolute URLs on our own host
    for (const m of html.matchAll(/"image"\s*:\s*"([^"]+)"/g)) refs.add(m[1]);

    for (let ref of refs) {
      // Absolute URLs on our own site still resolve to a file in dist.
      if (/^https?:\/\//i.test(ref)) {
        try { ref = new URL(ref).pathname; } catch { continue; }
      }
      if (!ref.startsWith('/') || ref.startsWith('//')) continue;
      if (ref.startsWith('/_') || ref === '/') continue;

      const key = ref;
      if (seen.has(key)) continue;
      seen.add(key);

      const clean = decodeURIComponent(ref.split('?')[0].split('#')[0]);
      // A route renders as a directory index; an asset is a plain file.
      const candidates = [
        join(distDir, clean),
        join(distDir, clean, 'index.html'),
        join(distDir, `${clean}.html`),
      ];
      const found = (await Promise.all(candidates.map(exists))).some(Boolean);
      if (!found) missing.set(clean, (missing.get(clean) || 0) + 1);
    }
  }

  if (missing.size) {
    const list = [...missing.keys()].slice(0, 6).join(', ');
    fail(
      'asset references',
      `${missing.size} reference(s) point at files not in the build: ${list}` +
        `${missing.size > 6 ? ' …' : ''}`,
    );
    return;
  }
  pass('asset references', `${seen.size} local reference(s) all resolve`);
}

/**
 * Meta descriptions are what a searcher actually reads, so a hard slice that
 * ends mid-word is visible in the result. Google truncates around 160
 * characters anyway; anything longer is written for nobody.
 */
function checkMetaDescriptions(pages) {
  const problems = [];
  for (const [route, html] of pages) {
    const m = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)
      || /<meta\s+content="([^"]*)"\s+name="description"/i.exec(html);
    if (!m) { problems.push(`${route}: none`); continue; }
    const desc = m[1].trim();
    if (!desc) { problems.push(`${route}: empty`); continue; }
    if (desc.length > 160) problems.push(`${route}: ${desc.length} chars`);
    // A slice that landed mid-word, rather than a deliberate ellipsis.
    if (/[A-Za-z]{2}(\.\.\.|…)$/.test(desc)) problems.push(`${route}: cut mid-word`);
  }
  problems.length
    ? warn('meta descriptions', `${problems.length}: ${problems.slice(0, 4).join('; ')}`)
    : pass('meta descriptions', `${pages.length} page(s) within 160 chars`);
}


/**
 * Every tel: link must be attributable and dialable.
 *
 * Two Mansfield-era bugs live here. Calls turned out to be the primary
 * conversion, but GA4 could only say "a call happened," not which surface
 * drove it — until every tel: anchor carried a data-phone-location tag
 * (header, footer, cta-band, ...). And tel: hrefs that interpolate the
 * display string ship parens and spaces inside the URL, which some dialers
 * reject; hrefs must be digits (E.164-ish), display text stays pretty.
 */
function checkTelLinks(pages) {
  const unlabeled = [];
  const undialable = [];
  for (const [route, html] of pages) {
    for (const m of html.matchAll(/<a\b[^>]*href="tel:([^"]+)"[^>]*>/gi)) {
      const tag = m[0];
      const number = m[1];
      if (!/data-phone-location=/.test(tag)) unlabeled.push(route);
      if (/[\s()\-.]/.test(number.replace(/^\+/, '').trim()) || /%20|\(/.test(number)) {
        undialable.push(`${route} → tel:${number}`);
      }
    }
  }
  if (unlabeled.length || undialable.length) {
    const parts = [];
    if (unlabeled.length) {
      parts.push(
        `${unlabeled.length} tel: link(s) without data-phone-location (GA4 cannot ` +
          `attribute the call to a surface): ${[...new Set(unlabeled)].slice(0, 4).join(', ')}`,
      );
    }
    if (undialable.length) {
      parts.push(
        `${undialable.length} tel: href(s) carrying display formatting instead of ` +
          `digits: ${undialable.slice(0, 3).join(', ')}`,
      );
    }
    fail('tel links', parts.join('; '));
    return;
  }
  pass('tel links', 'all tel: anchors labeled for attribution and digit-only');
}

/**
 * Node must be pinned in BOTH .nvmrc and wrangler.toml.
 *
 * Cloudflare Pages defaults to a Node that Astro 6 refuses, and the two pins
 * serve different masters: .nvmrc is what a human's shell picks up,
 * NODE_VERSION in wrangler.toml is what Cloudflare's build system reads.
 * Mansfield shipped each fix separately, a broken deploy apart. Pin both at
 * once or the half you skipped fails later, on someone else's machine.
 */
async function checkNodePinning(clientDir) {
  const nvmrc = (await readMaybe(join(clientDir, '.nvmrc')))?.trim() || null;
  const toml = await readMaybe(join(clientDir, 'wrangler.toml'));
  const tomlPin = toml ? /NODE_VERSION\s*=/.test(toml) : null;

  if (toml && !tomlPin) {
    fail(
      'node pinning',
      'wrangler.toml exists but declares no NODE_VERSION — Cloudflare Pages ' +
        "builds with its default Node, which Astro 6 rejects. Pin it in [vars].",
    );
    return;
  }
  if (!nvmrc) {
    warn(
      'node pinning',
      'no .nvmrc — local shells and CI without wrangler context fall back to ' +
        'whatever Node is ambient. Pin the same major as wrangler.toml.',
    );
    return;
  }
  pass('node pinning', `.nvmrc=${nvmrc}${toml ? ', wrangler.toml NODE_VERSION set' : ''}`);
}

/**
 * The homepage must carry the two blobs Google actually reads first:
 * a LocalBusiness-family JSON-LD with a dialable telephone and an address,
 * and an og:image. Mansfield launched with neither complete; both were
 * found by hand afterwards. Other pages missing og:image is only advisory —
 * shares still fall back to the homepage card.
 */
function checkHomepageSeo(pages) {
  const home = pages.find(([route]) => route === '/index.html');
  if (!home) {
    warn('homepage seo', 'no /index.html in dist — cannot check schema/og:image');
    return;
  }
  const [, html] = home;
  const problems = [];

  const ldBlocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]);
  const business = ldBlocks.find((b) => /"@type"\s*:\s*"?\[?[^"]*?(Dentist|LocalBusiness|MedicalBusiness|Orthodontic)/i.test(b));
  if (!business) {
    problems.push('no LocalBusiness/Dentist JSON-LD on the homepage');
  } else {
    if (!/"telephone"\s*:\s*"[^"]+"/.test(business)) problems.push('schema is missing telephone');
    if (!/"address"\s*:/.test(business)) problems.push('schema is missing address');
  }
  if (!/property="og:image"\s+content="[^"]+"/i.test(html) &&
      !/content="[^"]+"\s+property="og:image"/i.test(html)) {
    problems.push('no og:image on the homepage');
  }

  if (problems.length) {
    fail('homepage seo', problems.join('; '));
    return;
  }

  const missingOg = pages
    .filter(([, h]) => !/property="og:image"|og:image"\s+content|content="[^"]*"\s+property="og:image"/i.test(h))
    .map(([r]) => r)
    .filter((r) => !/^\/404\.html$/.test(r));
  if (missingOg.length) {
    warn('homepage seo', `homepage complete; ${missingOg.length} other page(s) lack og:image: ${missingOg.slice(0, 4).join(', ')}`);
    return;
  }
  pass('homepage seo', 'LocalBusiness schema (telephone + address) and og:image present');
}

/**
 * robots.txt and the sitemap must agree on which origin this site is.
 *
 * Mansfield's robots.txt pointed its Sitemap: line at the wrong origin, so
 * Search Console rejected the submission — while the sitemap itself was fine.
 * Cross-checking the two catches a wrong `site` in astro.config, a stale
 * template origin, or a preview hostname about to be handed to Google.
 */
async function checkOriginAgreement(distDir) {
  const robots = await readMaybe(join(distDir, 'robots.txt'));
  const sitemap = await readMaybe(join(distDir, 'sitemap-0.xml'));
  if (!robots || !sitemap) {
    pass('origin agreement', 'robots.txt or sitemap missing — covered by other gates');
    return;
  }
  const robotsHost = robots.match(/Sitemap:\s*https?:\/\/([^/\s]+)/i)?.[1] || null;
  const locHost = sitemap.match(/<loc>https?:\/\/([^/<]+)/i)?.[1] || null;
  if (robotsHost && locHost && robotsHost !== locHost) {
    fail(
      'origin agreement',
      `robots.txt says the sitemap lives on ${robotsHost} but sitemap URLs are ` +
        `on ${locHost} — Search Console will reject one of them. Fix the origin.`,
    );
    return;
  }
  if (locHost && /\.pages\.dev$/i.test(locHost)) {
    warn(
      'origin agreement',
      `sitemap URLs point at ${locHost} — a preview host. Fine for a cold-build ` +
        'preview; must change before the live-domain cutover.',
    );
    return;
  }
  pass('origin agreement', `robots.txt and sitemap agree on ${locHost || 'origin'}`);
}

/**
 * GA4 wiring is advisory: a cold-build preview may deliberately ship without
 * a measurement id, but a LIVE site missing one collects nothing forever —
 * Mansfield's id was silently dropped for three deploys because wrangler.toml
 * superseded the dashboard variable. Absence is worth a line either way.
 */
function checkGa4(pages) {
  const withGa4 = pages.filter(([, h]) => /G-[A-Z0-9]{6,}/.test(h)).length;
  if (!withGa4) {
    warn(
      'ga4',
      'no G-XXXXXXX measurement id in any page — expected on a cold preview, ' +
        'a silent data loss on a live site. Verify before the domain cutover.',
    );
    return;
  }
  pass('ga4', `measurement id present on ${withGa4}/${pages.length} page(s)`);
}

/**
 * A built 404.html is what makes Pages answer 404 at all.
 *
 * With none, it falls back to index.html with a 200 for unmatched routes, so
 * the site silently accrues unlimited soft-404 duplicates of its homepage.
 * The failure is invisible in a browser — the page you get back looks right.
 */
async function check404(distDir) {
  const html = await readMaybe(join(distDir, '404.html'));
  if (!html) {
    fail(
      '404 page',
      'no dist/404.html — Cloudflare Pages will serve index.html with a 200 ' +
        'for every unmatched route, making each one an indexable duplicate ' +
        'of the homepage. Add src/pages/404.astro.',
    );
    return;
  }
  if (!/noindex/i.test(html)) {
    fail('404 page', 'dist/404.html is missing a noindex directive');
    return;
  }
  pass('404 page', 'built and noindexed');
}

// ---------------------------------------------------------------------------

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/pipeline/verify-launch.js clients/<slug>');
    process.exit(2);
  }
  const clientDir = resolve(target);
  const distDir = join(clientDir, 'dist');

  if (!(await exists(distDir))) {
    console.error(`no dist/ in ${clientDir} — build the site first`);
    process.exit(2);
  }

  const pages = await htmlPages(distDir);
  if (!pages.length) {
    console.error(`no HTML in ${distDir}`);
    process.exit(2);
  }

  const robotsTxt = await readMaybe(join(distDir, 'robots.txt'));

  checkContactPath(pages);
  checkEmptyHrefs(pages);
  checkTelLinks(pages);
  checkPlaceholders(pages, robotsTxt);
  checkHomepageSeo(pages);
  checkGa4(pages);
  await checkSitemapVsRedirects(distDir, pages);
  await checkAssetReferences(distDir, pages);
  checkMetaDescriptions(pages);
  await checkOriginAgreement(distDir);
  await checkNodePinning(clientDir);
  await check404(distDir);
  await checkWorkingTree(clientDir);
  await checkImageSets(clientDir);
  await checkWranglerVars(clientDir);

  const failed = results.filter((r) => !r.ok);
  const warned = results.filter((r) => r.warn);
  for (const r of results) {
    const label = !r.ok ? 'FAIL' : r.warn ? 'WARN' : 'PASS';
    console.log(`${label}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(
    `\n${results.length - failed.length - warned.length}/${results.length - warned.length} ` +
      `launch gates passed (${pages.length} pages scanned)` +
      (warned.length ? `, ${warned.length} advisory` : ''),
  );
  process.exit(failed.length ? 1 : 0);
}

main();
