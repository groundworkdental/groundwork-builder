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

/** Scaffold text that must never reach a patient or a crawler. */
const PLACEHOLDERS = [
  ['example.com', /\bexample\.com\b/i],
  ['lorem ipsum', /\blorem ipsum\b/i],
  ['unreplaced token', /\{\{[^}]+\}\}/],
  ['TODO/TBD', /\b(TODO|TBD)\b/],
  // Only a CTA whose own label says it does not work — prose may legitimately
  // say "online booking is coming soon", a button saying it may not.
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
    fail(
      'wrangler vars',
      'wrangler.toml exists with no [vars] block. Pages will read build config ' +
        'from this file and ignore dashboard variables, so any PUBLIC_* value ' +
        'set there is silently dropped.',
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
  checkPlaceholders(pages, robotsTxt);
  await checkSitemapVsRedirects(distDir, pages);
  await checkWranglerVars(clientDir);

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} launch gates passed ` +
      `(${pages.length} pages scanned)`,
  );
  process.exit(failed.length ? 1 : 0);
}

main();
