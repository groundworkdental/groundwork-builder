#!/usr/bin/env node
/**
 * Generate an interactive practice dashboard — all built sites & artifacts.
 *
 * Usage:
 *   node scripts/generate-practice-dashboard.js
 *   node scripts/generate-practice-dashboard.js --open
 *
 * Output: _memory/practice-dashboard.html
 */

import { readFile, writeFile, readdir, stat, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { slugFromUrl } from './pipeline/lib/slug.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = resolve(ROOT, '_memory/practice-dashboard.html');
const LIVE_BASE = process.env.GROUNDWORK_SUBDOMAIN || 'groundworkdental.com';

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readJsonSafe(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

async function loadRuns() {
  const p = resolve(ROOT, '_memory/runs.jsonl');
  if (!(await exists(p))) return [];
  const lines = (await readFile(p, 'utf8')).trim().split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function parseSiteTs(text) {
  const name = text.match(/name:\s*['"]([^'"]+)['"]/)?.[1];
  const url = text.match(/(?:url|domain):\s*['"]([^'"]+)['"]/)?.[1]
    || text.match(/website:\s*['"]([^'"]+)['"]/)?.[1];
  return { name, url };
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  try {
    const h = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return h === 'example.com' || h === 'localhost';
  } catch { return true; }
}

async function practiceMeta(clientDir) {
  const merge = await readJsonSafe(resolve(clientDir, '_pipeline/06-merge.json'));
  const out = merge?.output || merge;
  const fromMerge = {
    name: out?.practice?.name,
    url: out?.practice?.url || (out?.practice?.domain ? `https://${out.practice.domain}` : null),
  };
  if (fromMerge.name || (fromMerge.url && !isPlaceholderUrl(fromMerge.url))) return fromMerge;

  const siteTs = resolve(clientDir, 'src/config/site.ts');
  if (await exists(siteTs)) {
    const parsed = parseSiteTs(await readFile(siteTs, 'utf8'));
    if (parsed.url && isPlaceholderUrl(parsed.url)) parsed.url = null;
    if (parsed.name || parsed.url) return parsed;
  }
  return fromMerge;
}

/** @typedef {{ file: string, label: string, desc: string, audience: string, phase: number, scanTarget?: string, relates?: string[], hosted?: string, note?: string }} ArtifactDef */

/** @type {ArtifactDef[]} */
const AUDIT_ARTIFACTS = [
  {
    file: 'audit-data.json',
    label: 'Audit data (JSON)',
    desc: 'Source of truth — one scan emits this; every audit HTML doc is a render of it.',
    audience: 'Machine + operator',
    phase: 1,
    scanTarget: 'Live practice site',
    relates: ['audit-summary.html', 'audit-report.html', 'build-spec.html'],
    note: 'Written by audit-site.js to _audits/<slug>/ and _data/',
  },
  {
    file: 'audit-summary.html',
    label: 'Audit one-pager',
    desc: 'Curated sales doc — top findings, paired fixes, lead-magnet CTA. Prospect-facing.',
    audience: 'Prospect',
    phase: 1,
    scanTarget: 'Live practice site',
    relates: ['audit-report.html', 'audit-data.json'],
    hosted: '/audits/<slug>/',
    note: 'Subset of audit-data.json — not the full report',
  },
  {
    file: 'audit-report.html',
    label: 'Full audit report',
    desc: 'Tabbed deep-dive (SEO, speed, GBP, agentic). Same scan as one-pager, complete detail.',
    audience: 'Prospect',
    phase: 1,
    scanTarget: 'Live practice site',
    relates: ['audit-summary.html', 'audit-data.json'],
    hosted: '/audits/<slug>/audit-report',
    note: 'Gated behind email on the one-pager — not linked from cold traffic',
  },
  {
    file: 'build-spec.html',
    label: 'Build spec',
    desc: 'Internal operator view of the entire audit-data.json — every finding, build hints, evidence.',
    audience: 'Operator / build agent',
    phase: 1,
    scanTarget: 'Live practice site',
    relates: ['audit-data.json'],
    note: 'Closest sibling is audit-data.json, not audit-report.html',
  },
  {
    file: 'precall-brief.html',
    label: 'Pre-call brief',
    desc: 'Slim operator doc for sales calls — highlights without full report weight.',
    audience: 'Operator',
    phase: 1,
    scanTarget: 'Live practice site',
    relates: ['audit-summary.html', 'audit-data.json'],
    note: 'npm run audit:precall',
  },
  {
    file: 'audit-report-after.html',
    label: 'After report (rescan)',
    desc: 'Before → after diff — re-scans the preview URL vs original findings after publish.',
    audience: 'Operator + prospect',
    phase: 4,
    scanTarget: 'Preview URL (*.groundworkdental.com)',
    relates: ['audit-report.html', 'findings-diff.json'],
    note: 'Does not replace audit-data.json — baseline stays the live-site scan',
  },
];

/** @type {ArtifactDef[]} */
const PIPELINE_ARTIFACTS = [
  {
    file: 'index.html',
    label: 'Operator report',
    desc: 'Full build pipeline report — every phase, scores, and step output in one page.',
    audience: 'Operator',
    phase: 2,
    scanTarget: 'Built dist/ (post-build)',
    relates: ['summary.json', '09-build.json'],
  },
  {
    file: 'external-report.html',
    label: 'Client audit (post-build)',
    desc: 'Client-facing before/after redesign brief on the new site — not the pre-build audit.',
    audience: 'Client',
    phase: 2,
    scanTarget: 'Built dist/ (post-build)',
    relates: ['one-pager.html', 'audit-report-after.html'],
    note: 'Different family from _audits/audit-summary.html',
  },
  {
    file: 'one-pager.html',
    label: 'Pitch one-pager',
    desc: 'Post-build sales summary for the redesign — lives in clients/<slug>/_pipeline/.',
    audience: 'Prospect / sales',
    phase: 2,
    scanTarget: 'Built dist/ (post-build)',
    relates: ['external-report.html', 'pitch.html'],
    note: 'Not the same as audit-summary.html (pre-build)',
  },
  {
    file: 'pitch.html',
    label: 'Pitch page',
    desc: 'Local handoff pitch HTML before hosting at /pitch/<slug>/.',
    audience: 'Operator',
    phase: 2,
    relates: ['one-pager.html'],
    hosted: '/pitch/<slug>/',
  },
  {
    file: 'missing.html',
    label: 'Ship gates / missing',
    desc: 'Blocked handoff items — what must be fixed before the site can ship.',
    audience: 'Operator',
    phase: 2,
    relates: ['12-ship-gates.json'],
  },
];

/** @type {{ num: number, id: string, title: string, subtitle: string, tag: string }[]} */
const LIFECYCLE_PHASES = [
  { num: 1, id: 'audit', title: 'Pre-build audit', subtitle: 'audit-site.js scans the live practice domain', tag: 'local' },
  { num: 2, id: 'build', title: 'Site build', subtitle: 'build-site.js generates the redesigned Astro site', tag: 'local' },
  { num: 3, id: 'publish', title: 'Publish & live', subtitle: 'Preview deploy + hosted audit/pitch pages', tag: 'live' },
  { num: 4, id: 'rescan', title: 'Post-build rescan', subtitle: 'rescan.js diffs preview vs original findings', tag: 'mixed' },
];

/** @type {ArtifactDef[]} */
const LIVE_ARTIFACTS = [
  {
    file: 'preview',
    label: 'Preview site',
    desc: 'Deployed rebuilt site on a temporary subdomain.',
    audience: 'Prospect + operator',
    phase: 3,
    hosted: 'https://<slug>.groundworkdental.com',
    relates: ['audit-report-after.html', 'dist/index.html'],
    note: 'Some checks defer until the practice domain is connected at go-live',
  },
  {
    file: 'pitch-hosted',
    label: 'Pitch page (hosted)',
    desc: 'Public handoff page — share with the practice after build.',
    audience: 'Prospect',
    phase: 3,
    hosted: '/pitch/<slug>/',
    relates: ['one-pager.html', 'pitch.html'],
  },
  {
    file: 'audit-hosted',
    label: 'Audit one-pager (hosted)',
    desc: 'Same document as local audit-summary.html, served publicly.',
    audience: 'Prospect',
    phase: 3,
    hosted: '/audits/<slug>/',
    relates: ['audit-summary.html'],
  },
  {
    file: 'audit-report-hosted',
    label: 'Full audit report (hosted)',
    desc: 'Same document as local audit-report.html.',
    audience: 'Prospect',
    phase: 3,
    hosted: '/audits/<slug>/audit-report',
    relates: ['audit-report.html'],
  },
  {
    file: 'before-after',
    label: 'Before / after page',
    desc: 'Hosted visual comparison of old site vs preview.',
    audience: 'Prospect',
    phase: 3,
    hosted: '/audits/<slug>/before-after',
    relates: ['audit-report-after.html'],
  },
  {
    file: 'dist/index.html',
    label: 'Built site (local dist)',
    desc: 'Static output from npm run build — what gets deployed to preview.',
    audience: 'Operator',
    phase: 3,
    relates: ['preview', '09-build.json'],
  },
];

function metaFor(def, path) {
  return { ...def, path };
}

async function listPipelineArtifacts(clientDir, relToRoot) {
  const pipeline = resolve(clientDir, '_pipeline');
  if (!(await exists(pipeline))) return { html: [], json: [] };

  const files = await readdir(pipeline);
  const html = [];
  for (const def of PIPELINE_ARTIFACTS) {
    if (files.includes(def.file)) {
      html.push(metaFor(def, join(relToRoot, '_pipeline', def.file)));
    }
  }
  const json = files
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ file: f, path: join(relToRoot, '_pipeline', f) }));
  return { html, json };
}

async function listAuditArtifacts(auditDir, relToRoot) {
  if (!(await exists(auditDir))) return { html: [], hasData: false };
  const files = await readdir(auditDir);
  const dataDir = resolve(auditDir, '_data');
  const dataFiles = (await exists(dataDir)) ? await readdir(dataDir) : [];
  const html = [];
  for (const def of AUDIT_ARTIFACTS) {
    if (def.file.endsWith('.json')) {
      if (files.includes(def.file) || dataFiles.includes(def.file)) {
        const inData = dataFiles.includes(def.file);
        const jsonPath = inData ? join(relToRoot, '_data', def.file) : join(relToRoot, def.file);
        html.push(metaFor(def, jsonPath));
      }
    } else if (files.includes(def.file)) {
      html.push(metaFor(def, join(relToRoot, def.file)));
    }
  }
  return { html, hasData: files.includes('audit-data.json') || dataFiles.includes('audit-data.json') };
}

function psiScore(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'object') return val.performance ?? val.score ?? null;
  return null;
}

async function loadScores(clientDir) {
  const ps = await readJsonSafe(resolve(clientDir, '_pipeline/03-pagespeed-after.json'))
    || await readJsonSafe(resolve(clientDir, '_pipeline/03-pagespeed.json'));
  const a11y = await readJsonSafe(resolve(clientDir, '_pipeline/11b-a11y-audit.json'));
  const build = await readJsonSafe(resolve(clientDir, '_pipeline/09-build.json'));
  const psOut = ps?.output || ps;
  const a11yOut = a11y?.output || a11y;
  return {
    mobile: psiScore(psOut?.mobile),
    desktop: psiScore(psOut?.desktop),
    a11ySerious: a11yOut?.byImpact?.serious ?? null,
    buildSuccess: build?.output?.buildSuccess ?? build?.buildSuccess ?? null,
  };
}

function normKey(s) {
  return s.replace(/-/g, '').toLowerCase();
}

function resolveGroupKey(dirName, canonical, groups) {
  if (canonical && canonical !== 'example') return canonical;
  const n = normKey(dirName);
  for (const [key, g] of groups) {
    if (normKey(key) === n) return key;
    if (g.clientDirs.some(d => normKey(d.name) === n)) return key;
    if (g.aliases.some(a => normKey(a) === n)) return key;
  }
  return canonical === 'example' ? null : (canonical || dirName);
}

async function discoverPractices() {
  const clientsRoot = resolve(ROOT, 'clients');
  const auditsRoot = resolve(ROOT, '_audits');
  const clientDirs = (await readdir(clientsRoot, { withFileTypes: true }))
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  const groups = new Map();

  for (const dirName of clientDirs) {
    const clientDir = resolve(clientsRoot, dirName);
    const meta = await practiceMeta(clientDir);
    const url = meta.url?.startsWith('http') ? meta.url : meta.url ? `https://${meta.url}` : null;
    const validUrl = url && !isPlaceholderUrl(url) ? url : null;
    const fromUrl = validUrl ? slugFromUrl(validUrl) : null;
    const key = resolveGroupKey(dirName, fromUrl, groups);
    if (!key) continue; // orphan batch dir with placeholder URL, canonical exists elsewhere

    if (!groups.has(key)) {
      groups.set(key, { slug: key, name: meta.name || dirName, url: validUrl, aliases: [], clientDirs: [] });
    }
    const g = groups.get(key);
    if (meta.name && meta.name !== dirName && (!g.name || g.name === g.slug)) g.name = meta.name;
    if (validUrl && !g.url) g.url = validUrl;
    if (dirName !== key) g.aliases.push(dirName);
    g.clientDirs.push({ name: dirName, path: clientDir, mtime: (await stat(clientDir)).mtimeMs });
  }

  const practices = [];
  for (const g of groups.values()) {
    g.clientDirs.sort((a, b) => b.mtime - a.mtime);
    const primary = g.clientDirs.find(d => d.name === g.slug) || g.clientDirs[0];
    const clientDir = primary.path;
    const relClient = relative(ROOT, clientDir);

    const auditCandidates = [g.slug, ...g.aliases, primary.name];
    let auditDir = null;
    let auditRel = null;
    for (const s of auditCandidates) {
      const p = resolve(auditsRoot, s);
      if (await exists(p)) { auditDir = p; auditRel = relative(ROOT, p); break; }
    }

    const hasDist = await exists(resolve(clientDir, 'dist/index.html'));
    const pipeline = await listPipelineArtifacts(clientDir, relClient);
    const audit = auditDir ? await listAuditArtifacts(auditDir, auditRel) : { html: [], hasData: false };
    const scores = await loadScores(clientDir);

    practices.push({
      slug: g.slug,
      name: g.name,
      url: g.url,
      aliases: [...new Set([...g.aliases, ...g.clientDirs.map(d => d.name).filter(n => n !== g.slug)])],
      primaryDir: relClient,
      hasDist,
      scores,
      live: {
        preview: `https://${g.slug}.${LIVE_BASE}`,
        pitch: `https://${LIVE_BASE}/pitch/${g.slug}/`,
        audit: `https://${LIVE_BASE}/audits/${g.slug}/`,
        auditReport: `https://${LIVE_BASE}/audits/${g.slug}/audit-report`,
        beforeAfter: `https://${LIVE_BASE}/audits/${g.slug}/before-after`,
      },
      pipeline,
      audit: { ...audit, dir: auditRel },
      github: `https://github.com/groundworkdental/groundwork-builder/tree/main/${relClient}`,
    });
  }

  // Collapse batch dirs that share a normalized slug with a canonical practice
  const byNorm = new Map();
  for (const p of practices) {
    const nk = normKey(p.slug);
    const existing = byNorm.get(nk);
    if (!existing) { byNorm.set(nk, p); continue; }
    const prefer = (p.url && !existing.url) ? p : (!p.url && existing.url) ? existing : p;
    const other = prefer === p ? existing : p;
    prefer.aliases = [...new Set([...prefer.aliases, other.slug, ...other.aliases, other.primaryDir.replace('clients/', '')])];
    if (!prefer.url && other.url) prefer.url = other.url;
    if (!prefer.name || prefer.name === prefer.slug) prefer.name = other.name || prefer.name;
    if (!prefer.hasDist && other.hasDist) {
      prefer.hasDist = other.hasDist;
      prefer.primaryDir = other.primaryDir;
      prefer.pipeline = other.pipeline;
      prefer.scores = other.scores;
    }
    if (!prefer.audit.html.length && other.audit.html.length) prefer.audit = other.audit;
    byNorm.set(nk, prefer);
  }
  const out = [...byNorm.values()];
  for (const p of out) {
    p.aliases = [...new Set(p.aliases.filter(a => a !== p.slug && a !== p.primaryDir.replace('clients/', '')))];
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function attachRuns(practices, runs) {
  const bySlug = new Map();
  for (const r of runs) {
    const s = r.client_slug;
    if (!bySlug.has(s)) bySlug.set(s, []);
    bySlug.get(s).push(r);
  }
  for (const p of practices) {
    const keys = [p.slug, ...p.aliases];
    const matched = [];
    for (const k of keys) {
      if (bySlug.has(k)) matched.push(...bySlug.get(k));
    }
    matched.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    p.runCount = matched.length;
    if (matched[0]) {
      p.lastRun = {
        date: matched[0].created_at,
        buildSuccess: matched[0].build_success,
        archetype: matched[0].archetype,
        durationMin: matched[0].duration_ms ? Math.round(matched[0].duration_ms / 60000) : null,
      };
    }
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function renderRelChips(relates = []) {
  if (!relates.length) return '';
  return '<span class="rel-chips">' + relates.map(r =>
    `<span class="rel-chip">${escHtml(r)}</span>`
  ).join('') + '</span>';
}

function renderDocRow(a) {
  const scan = a.scanTarget ? `<div class="doc-scan">Scans: ${escHtml(a.scanTarget)}</div>` : '';
  const hosted = a.hosted ? `<div class="doc-hosted">Hosted: <code>${escHtml(a.hosted)}</code></div>` : '';
  const note = a.note ? `<div class="doc-note">${escHtml(a.note)}</div>` : '';
  return `<tr>
    <td class="doc-file"><code>${escHtml(a.file)}</code></td>
    <td><div class="doc-label">${escHtml(a.label)}</div><div class="doc-desc">${escHtml(a.desc)}</div>${note}</td>
    <td class="doc-audience">${escHtml(a.audience)}</td>
    <td>${scan}${hosted}${renderRelChips(a.relates)}</td>
  </tr>`;
}

function renderDocGuide() {
  const phaseBlocks = LIFECYCLE_PHASES.map(phase => {
    const auditRows = AUDIT_ARTIFACTS.filter(a => a.phase === phase.num).map(renderDocRow).join('');
    const pipelineRows = PIPELINE_ARTIFACTS.filter(a => a.phase === phase.num).map(renderDocRow).join('');
    const liveRows = LIVE_ARTIFACTS.filter(a => a.phase === phase.num).map(renderDocRow).join('');
    const rows = auditRows + pipelineRows + liveRows;
    if (!rows) return '';
    return `<section class="guide-phase">
      <header class="guide-phase-head">
        <span class="guide-phase-num">${phase.num}</span>
        <div>
          <h3>${escHtml(phase.title)}</h3>
          <p>${escHtml(phase.subtitle)}</p>
        </div>
        <span class="phase-tag ${phase.tag}">${phase.tag}</span>
      </header>
      <div class="table-wrap guide-table">
        <table class="doc-table">
          <thead><tr>
            <th>File</th><th>What it is</th><th>Audience</th><th>Context &amp; relations</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
  }).join('');

  const lifecycleFlow = LIFECYCLE_PHASES.map((p, i) => {
    const arrow = i < LIFECYCLE_PHASES.length - 1 ? '<span class="flow-arrow">→</span>' : '';
    return `<div class="flow-step"><span class="flow-step-num">${p.num}</span><span class="flow-step-title">${escHtml(p.title)}</span>${arrow}</div>`;
  }).join('');

  return `<section class="doc-guide" id="doc-guide">
    <h2 class="guide-title">Artifact guide</h2>
    <p class="guide-lede">Every document below is a <strong>render or deploy</strong> of earlier data — not a separate scan. Pre-build audit artifacts share one source (<code>audit-data.json</code>); post-build pipeline artifacts come from <code>build-site.js</code>.</p>

    <div class="lifecycle-flow">${lifecycleFlow}</div>

    <div class="guide-callout">
      <strong>Key relationships</strong>
      <ul>
        <li><code>audit-data.json</code> → source of truth; <code>build-spec.html</code> is its full internal view; <code>audit-summary.html</code> and <code>audit-report.html</code> are curated prospect views of the same scan.</li>
        <li><code>audit-summary.html</code> (pre-build, live site) ≠ <code>one-pager.html</code> (post-build, redesigned site) — different pipelines, different folders.</li>
        <li><code>audit-report-after.html</code> runs after publish — diffs preview vs original findings; it does <em>not</em> replace <code>audit-data.json</code>.</li>
        <li>Hosted URLs under <code>/audits/&lt;slug&gt;/</code> mirror local <code>_audits/&lt;slug&gt;/</code> files; <code>/pitch/&lt;slug&gt;/</code> mirrors <code>_pipeline/pitch.html</code>.</li>
      </ul>
    </div>

    ${phaseBlocks}
  </section>`;
}

function renderHtml(practices, generatedAt) {
  const data = JSON.stringify(practices).replace(/</g, '\\u003c');
  const docGuide = renderDocGuide();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Groundwork Practice Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #edeae3;
      --bg-subtle: #e4e0d7;
      --surface: #faf8f4;
      --surface-raised: #fff;
      --border: #cfc9be;
      --border-soft: #ddd8cf;
      --text: #1c2220;
      --muted: #5f6865;
      --muted-light: #8a928f;
      --accent: #1f5c50;
      --accent-mid: #2a6b5e;
      --accent-soft: #dcebe7;
      --accent-glow: rgba(42, 107, 94, 0.12);
      --live: #1a5f8a;
      --live-soft: #e3f0f8;
      --local: #6b5a42;
      --local-soft: #f0ebe3;
      --warn: #9a5b1a;
      --warn-soft: #f8efe4;
      --ok: #2a6b5e;
      --sidebar-w: 272px;
      --radius: 10px;
      --radius-sm: 6px;
      --mono: "IBM Plex Mono", ui-monospace, monospace;
      --sans: "DM Sans", system-ui, sans-serif;
      --shadow: 0 1px 2px rgba(28, 34, 32, 0.04), 0 4px 16px rgba(28, 34, 32, 0.05);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0; font-family: var(--sans); background: var(--bg);
      color: var(--text); line-height: 1.55; font-size: 15px;
      -webkit-font-smoothing: antialiased;
    }
    .layout { display: flex; min-height: 100vh; }

    /* Sidebar */
    aside {
      width: var(--sidebar-w); flex-shrink: 0; background: var(--surface-raised);
      border-right: 1px solid var(--border); display: flex; flex-direction: column;
      position: sticky; top: 0; height: 100vh; overflow: hidden;
      box-shadow: 2px 0 24px rgba(28, 34, 32, 0.03);
    }
    .brand {
      padding: 1.35rem 1.1rem 1rem;
      border-bottom: 1px solid var(--border-soft);
      background: linear-gradient(180deg, var(--surface-raised) 0%, var(--surface) 100%);
    }
    .brand-mark {
      display: inline-flex; align-items: center; gap: 0.45rem;
      font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--accent-mid); margin-bottom: 0.35rem;
    }
    .brand-mark::before {
      content: ""; width: 7px; height: 7px; border-radius: 50%;
      background: var(--accent-mid); box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .brand h1 { margin: 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -0.02em; }
    .brand p { margin: 0.3rem 0 0; font-size: 0.78rem; color: var(--muted); }
    .search { padding: 0.85rem 1rem; border-bottom: 1px solid var(--border-soft); }
    .search input {
      width: 100%; padding: 0.55rem 0.75rem; border: 1px solid var(--border);
      border-radius: var(--radius-sm); font-size: 0.84rem; font-family: var(--sans);
      background: var(--bg); color: var(--text); outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .search input:focus {
      border-color: var(--accent-mid);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .nav-label {
      padding: 0.65rem 1rem 0.35rem; font-size: 0.65rem; font-weight: 600;
      letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted-light);
    }
    .nav { flex: 1; overflow-y: auto; padding: 0 0 1rem; }
    .nav button {
      display: flex; align-items: flex-start; gap: 0.55rem;
      width: 100%; text-align: left; border: none; background: none;
      padding: 0.5rem 1rem; font-size: 0.84rem; cursor: pointer; color: var(--text);
      border-left: 3px solid transparent; font-family: var(--sans);
      transition: background 0.12s;
    }
    .nav button:hover { background: var(--accent-soft); }
    .nav button.active {
      background: var(--accent-soft); border-left-color: var(--accent-mid);
      font-weight: 600;
    }
    .nav .dot {
      width: 7px; height: 7px; border-radius: 50%; margin-top: 0.45rem; flex-shrink: 0;
      background: var(--border); transition: background 0.12s;
    }
    .nav button.active .dot { background: var(--accent-mid); }
    .nav button.nav-guide { font-size: 0.8rem; opacity: 0.92; }
    .nav .nav-text { min-width: 0; }
    .nav .slug {
      display: block; font-family: var(--mono); font-size: 0.66rem;
      color: var(--muted-light); margin-top: 0.08rem; font-weight: 400;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* Main */
    main { flex: 1; padding: 2rem 2.5rem 4rem; max-width: 920px; min-width: 0; }
    .panel { display: none; animation: fadeIn 0.2s ease; }
    .panel.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

    .page-head { margin-bottom: 1.75rem; }
    .page-head h2 {
      margin: 0 0 0.35rem; font-size: 1.65rem; font-weight: 700;
      letter-spacing: -0.03em; line-height: 1.2;
    }
    .page-head .lede { margin: 0; color: var(--muted); font-size: 0.9rem; max-width: 58ch; }

    /* Stats row */
    .stats {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.65rem;
      margin: 1.25rem 0 2rem;
    }
    .stat {
      background: var(--surface-raised); border: 1px solid var(--border-soft);
      border-radius: var(--radius); padding: 0.85rem 1rem;
      box-shadow: var(--shadow);
    }
    .stat strong {
      display: block; font-size: 1.5rem; font-weight: 700;
      color: var(--accent-mid); letter-spacing: -0.03em; line-height: 1.1;
    }
    .stat span { font-size: 0.78rem; color: var(--muted); }

    /* Practice header */
    .practice-hero {
      background: var(--surface-raised); border: 1px solid var(--border-soft);
      border-radius: var(--radius); padding: 1.35rem 1.5rem; margin-bottom: 2rem;
      box-shadow: var(--shadow);
    }
    .practice-hero h2 {
      margin: 0 0 0.5rem; font-size: 1.55rem; font-weight: 700;
      letter-spacing: -0.03em;
    }
    .practice-meta {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.65rem;
      font-size: 0.84rem; color: var(--muted); margin-bottom: 1rem;
    }
    .practice-meta a { color: var(--accent-mid); text-decoration: none; font-weight: 500; }
    .practice-meta a:hover { text-decoration: underline; }
    .slug-chip {
      font-family: var(--mono); font-size: 0.72rem; padding: 0.15rem 0.45rem;
      background: var(--bg); border: 1px solid var(--border-soft); border-radius: 4px;
      color: var(--muted);
    }
    .metrics {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 0.5rem; padding-top: 0.85rem; border-top: 1px solid var(--border-soft);
    }
    .metric {
      padding: 0.55rem 0.65rem; background: var(--bg); border-radius: var(--radius-sm);
      border: 1px solid var(--border-soft);
    }
    .metric .val {
      font-size: 1rem; font-weight: 700; color: var(--text);
      font-family: var(--mono); letter-spacing: -0.02em;
    }
    .metric .val.ok { color: var(--ok); }
    .metric .val.warn { color: var(--warn); }
    .metric .lbl { font-size: 0.68rem; color: var(--muted-light); margin-top: 0.1rem; }

    /* Journey timeline */
    .journey-intro {
      margin-bottom: 1.5rem; padding: 0.85rem 1rem;
      background: var(--accent-soft); border-radius: var(--radius-sm);
      border-left: 3px solid var(--accent-mid);
      font-size: 0.84rem; color: var(--accent);
    }
    .journey-intro strong { font-weight: 600; }
    .flow { position: relative; padding-left: 0; }
    .flow-phase {
      position: relative; margin-bottom: 1.75rem;
      padding-left: 3.25rem;
    }
    .flow-phase::before {
      content: ""; position: absolute; left: 1.15rem; top: 2.6rem; bottom: -1.75rem;
      width: 2px; background: var(--border-soft);
    }
    .flow-phase:last-child::before { display: none; }
    .phase-badge {
      position: absolute; left: 0; top: 0;
      width: 2.3rem; height: 2.3rem; border-radius: 50%;
      background: var(--surface-raised); border: 2px solid var(--accent-mid);
      color: var(--accent-mid); font-weight: 700; font-size: 0.95rem;
      display: flex; align-items: center; justify-content: center;
      box-shadow: var(--shadow); z-index: 1;
    }
    .phase-head { margin-bottom: 0.65rem; }
    .phase-head h3 {
      margin: 0; font-size: 0.95rem; font-weight: 700; letter-spacing: -0.01em;
    }
    .phase-head p {
      margin: 0.15rem 0 0; font-size: 0.78rem; color: var(--muted);
    }
    .phase-tag {
      display: inline-block; font-size: 0.62rem; font-weight: 600;
      letter-spacing: 0.07em; text-transform: uppercase;
      padding: 0.18rem 0.42rem; border-radius: 3px; margin-top: 0.35rem;
    }
    .phase-tag.live { background: var(--live-soft); color: var(--live); }
    .phase-tag.local { background: var(--local-soft); color: var(--local); }
    .phase-tag.mixed { background: var(--accent-soft); color: var(--accent); }

    /* Link rows */
    .link-list {
      background: var(--surface-raised); border: 1px solid var(--border-soft);
      border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow);
    }
    .link-row {
      display: grid; grid-template-columns: 1.75rem 1fr auto;
      gap: 0.65rem; align-items: center;
      padding: 0.7rem 0.9rem; text-decoration: none; color: inherit;
      border-bottom: 1px solid var(--border-soft);
      transition: background 0.12s;
    }
    .link-row:last-child { border-bottom: none; }
    .link-row:hover { background: var(--accent-soft); }
    .link-row .step-num {
      font-family: var(--mono); font-size: 0.68rem; font-weight: 500;
      color: var(--muted-light); text-align: center;
    }
    .link-row .link-body { min-width: 0; }
    .link-row .link-title {
      font-weight: 600; font-size: 0.88rem; letter-spacing: -0.01em;
    }
    .link-row .link-desc {
      font-size: 0.76rem; color: var(--muted); margin-top: 0.1rem;
      line-height: 1.4;
    }
    .link-row .link-meta {
      font-size: 0.68rem; color: var(--muted-light); margin-top: 0.2rem;
    }
    .link-row .link-badge {
      font-size: 0.62rem; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; padding: 0.2rem 0.45rem; border-radius: 3px;
      white-space: nowrap; flex-shrink: 0;
    }
    .link-badge.live { background: var(--live-soft); color: var(--live); }
    .link-badge.local { background: var(--local-soft); color: var(--local); }
    .link-row .arrow {
      color: var(--muted-light); font-size: 0.75rem; margin-left: 0.25rem;
    }

    /* Overview table */
    .table-wrap {
      background: var(--surface-raised); border: 1px solid var(--border-soft);
      border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow);
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    thead { background: var(--bg); border-bottom: 1px solid var(--border); }
    th {
      text-align: left; padding: 0.65rem 1rem; font-size: 0.68rem;
      font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
      color: var(--muted);
    }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tbody tr { cursor: pointer; transition: background 0.1s; }
    tbody tr:hover { background: var(--accent-soft); }
    .t-name { font-weight: 600; }
    .t-slug { font-family: var(--mono); font-size: 0.72rem; color: var(--muted-light); }
    .t-psi { font-family: var(--mono); font-size: 0.8rem; }
    .t-psi.ok { color: var(--ok); }
    .t-psi.warn { color: var(--warn); }
    .t-actions a {
      font-size: 0.76rem; font-weight: 600; color: var(--accent-mid);
      text-decoration: none; margin-right: 0.75rem;
    }
    .t-actions a:hover { text-decoration: underline; }

    /* Collapsible JSON */
    details.raw {
      margin-top: 0.5rem; background: var(--surface-raised);
      border: 1px solid var(--border-soft); border-radius: var(--radius);
      overflow: hidden;
    }
    details.raw summary {
      padding: 0.75rem 1rem; cursor: pointer; font-size: 0.82rem;
      font-weight: 600; color: var(--muted); list-style: none;
      display: flex; align-items: center; gap: 0.5rem;
    }
    details.raw summary::-webkit-details-marker { display: none; }
    details.raw summary::before {
      content: "▸"; font-size: 0.7rem; transition: transform 0.15s;
    }
    details.raw[open] summary::before { transform: rotate(90deg); }
    .json-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 0.25rem; padding: 0 1rem 1rem; border-top: 1px solid var(--border-soft);
    }
    .json-grid a {
      font-family: var(--mono); font-size: 0.7rem; color: var(--accent-mid);
      text-decoration: none; padding: 0.3rem 0;
    }
    .json-grid a:hover { text-decoration: underline; }

    .empty {
      padding: 1rem; color: var(--muted); font-size: 0.84rem;
      background: var(--bg); border-radius: var(--radius-sm);
      border: 1px dashed var(--border);
    }
    .aliases {
      font-size: 0.76rem; color: var(--muted-light); margin-top: 0.25rem;
    }
    footer {
      margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--border-soft);
      font-size: 0.72rem; color: var(--muted-light);
    }
    footer code {
      font-family: var(--mono); font-size: 0.68rem;
      background: var(--bg); padding: 0.15rem 0.35rem; border-radius: 3px;
    }

    /* Artifact guide (overview) */
    .doc-guide { margin: 2.5rem 0 0; padding-top: 2rem; border-top: 2px solid var(--border-soft); }
    .guide-title { margin: 0 0 0.35rem; font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; }
    .guide-lede { margin: 0 0 1.25rem; color: var(--muted); font-size: 0.88rem; max-width: 68ch; line-height: 1.55; }
    .guide-lede code { font-family: var(--mono); font-size: 0.8em; }
    .lifecycle-flow {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.5rem;
      margin-bottom: 1.25rem; padding: 0.85rem 1rem;
      background: var(--surface-raised); border: 1px solid var(--border-soft);
      border-radius: var(--radius); box-shadow: var(--shadow);
    }
    .flow-step { display: flex; align-items: center; gap: 0.4rem; }
    .flow-step-num {
      width: 1.35rem; height: 1.35rem; border-radius: 50%;
      background: var(--accent-soft); color: var(--accent-mid);
      font-size: 0.72rem; font-weight: 700; display: flex; align-items: center; justify-content: center;
    }
    .flow-step-title { font-size: 0.8rem; font-weight: 600; }
    .flow-arrow { color: var(--muted-light); font-size: 0.85rem; margin: 0 0.15rem; }
    .guide-callout {
      margin-bottom: 1.75rem; padding: 0.9rem 1rem;
      background: var(--warn-soft); border-radius: var(--radius-sm);
      border-left: 3px solid var(--warn); font-size: 0.82rem; color: var(--text);
    }
    .guide-callout strong { display: block; margin-bottom: 0.4rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--warn); }
    .guide-callout ul { margin: 0; padding-left: 1.15rem; }
    .guide-callout li { margin: 0.35rem 0; line-height: 1.45; }
    .guide-callout code { font-family: var(--mono); font-size: 0.78em; }
    .guide-phase { margin-bottom: 1.75rem; }
    .guide-phase-head {
      display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.65rem;
    }
    .guide-phase-num {
      width: 1.75rem; height: 1.75rem; border-radius: 50%; flex-shrink: 0;
      background: var(--accent-mid); color: #fff; font-weight: 700; font-size: 0.85rem;
      display: flex; align-items: center; justify-content: center;
    }
    .guide-phase-head h3 { margin: 0; font-size: 0.95rem; font-weight: 700; }
    .guide-phase-head p { margin: 0.12rem 0 0; font-size: 0.76rem; color: var(--muted); }
    .guide-phase-head .phase-tag { margin-left: auto; margin-top: 0.15rem; }
    .guide-table { margin-top: 0; }
    .doc-table td { vertical-align: top; }
    .doc-file code { font-family: var(--mono); font-size: 0.72rem; word-break: break-all; }
    .doc-label { font-weight: 600; font-size: 0.86rem; }
    .doc-desc { font-size: 0.78rem; color: var(--muted); margin-top: 0.15rem; line-height: 1.4; }
    .doc-note { font-size: 0.72rem; color: var(--muted-light); margin-top: 0.25rem; font-style: italic; }
    .doc-audience { font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
    .doc-scan, .doc-hosted { font-size: 0.72rem; color: var(--muted); margin-bottom: 0.25rem; }
    .doc-hosted code { font-family: var(--mono); font-size: 0.68rem; }
    .rel-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.35rem; }
    .rel-chip {
      font-family: var(--mono); font-size: 0.62rem; padding: 0.12rem 0.35rem;
      background: var(--bg); border: 1px solid var(--border-soft); border-radius: 3px; color: var(--accent-mid);
    }

    @media (max-width: 860px) {
      .layout { flex-direction: column; }
      aside { width: 100%; height: auto; position: relative; max-height: 42vh; }
      main { padding: 1.5rem 1.25rem 3rem; }
      .stats { grid-template-columns: 1fr; }
      .link-row { grid-template-columns: 1.5rem 1fr; }
      .link-row .link-badge { display: none; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <div class="brand">
        <div class="brand-mark">Groundwork</div>
        <h1>Practice Dashboard</h1>
        <p>Audit → build → publish</p>
      </div>
      <div class="search">
        <input type="search" id="q" placeholder="Filter practices…" autocomplete="off" />
      </div>
      <div class="nav-label">Practices</div>
      <nav class="nav" id="nav"></nav>
    </aside>
    <main>
      <div class="overview panel active" id="overview">
        <div class="page-head">
          <h2>All practices</h2>
          <p class="lede">Generated ${generatedAt}. Pick a practice for its artifact journey, or read the guide below for what each document is and how they connect in sequence.</p>
        </div>
        <div class="stats" id="stats"></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Practice</th>
                <th>Mobile PSI</th>
                <th>Build</th>
                <th>Quick links</th>
              </tr>
            </thead>
            <tbody id="index-table"></tbody>
          </table>
        </div>
        ${docGuide}
      </div>
      <div id="panels"></div>
      <footer>Regenerate with <code>node scripts/generate-practice-dashboard.js</code></footer>
    </main>
  </div>
  <script>
    const PRACTICES = ${data};

    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];

    function esc(s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
    }

    function linkRow(href, num, label, desc, kind, external, meta) {
      const target = external ? ' target="_blank" rel="noopener"' : '';
      const badge = kind === 'live' ? 'live' : 'local';
      const arrow = external ? '<span class="arrow">↗</span>' : '';
      const metaLine = meta ? '<div class="link-meta">' + esc(meta) + '</div>' : '';
      return '<a class="link-row" href="' + esc(href) + '"' + target + '>'
        + '<span class="step-num">' + num + '</span>'
        + '<div class="link-body"><div class="link-title">' + esc(label) + arrow + '</div>'
        + (desc ? '<div class="link-desc">' + esc(desc) + '</div>' : '')
        + metaLine + '</div>'
        + '<span class="link-badge ' + badge + '">' + badge + '</span></a>';
    }

    function artifactMeta(a) {
      const parts = [];
      if (a.audience) parts.push('For: ' + a.audience);
      if (a.scanTarget) parts.push('Scans: ' + a.scanTarget);
      if (a.relates?.length) parts.push('Related: ' + a.relates.slice(0, 3).join(', '));
      return parts.join(' · ');
    }

    function flowPhase(num, title, subtitle, tag, rowsHtml) {
      const tagClass = tag || 'mixed';
      return '<div class="flow-phase">'
        + '<div class="phase-badge">' + num + '</div>'
        + '<div class="phase-head"><h3>' + esc(title) + '</h3>'
        + '<p>' + esc(subtitle) + '</p>'
        + '<span class="phase-tag ' + tagClass + '">' + tagClass + '</span></div>'
        + (rowsHtml || '<p class="empty">No artifacts in this phase</p>')
        + '</div>';
    }

    function renderPanel(p) {
      const metrics = [];
      if (p.scores.mobile != null) {
        const cls = p.scores.mobile >= 90 ? 'ok' : 'warn';
        metrics.push('<div class="metric"><div class="val ' + cls + '">' + p.scores.mobile + '</div><div class="lbl">Mobile PSI</div></div>');
      }
      if (p.scores.desktop != null) {
        metrics.push('<div class="metric"><div class="val">' + p.scores.desktop + '</div><div class="lbl">Desktop PSI</div></div>');
      }
      if (p.scores.a11ySerious != null) {
        const cls = p.scores.a11ySerious === 0 ? 'ok' : 'warn';
        metrics.push('<div class="metric"><div class="val ' + cls + '">' + p.scores.a11ySerious + '</div><div class="lbl">Axe serious</div></div>');
      }
      if (p.scores.buildSuccess != null) {
        const cls = p.scores.buildSuccess ? 'ok' : 'warn';
        metrics.push('<div class="metric"><div class="val ' + cls + '">' + (p.scores.buildSuccess ? '✓' : '✗') + '</div><div class="lbl">Build</div></div>');
      }
      if (p.lastRun) {
        metrics.push('<div class="metric"><div class="val">' + esc(p.lastRun.date?.slice(0,10)) + '</div><div class="lbl">Last run</div></div>');
      }
      if (p.runCount) {
        metrics.push('<div class="metric"><div class="val">' + p.runCount + '</div><div class="lbl">Pipeline runs</div></div>');
      }

      const auditPhase1 = p.audit.html.filter(a => a.phase !== 4);
      const auditPhase4 = p.audit.html.filter(a => a.phase === 4);

      const auditRows = auditPhase1.length
        ? '<div class="link-list">' + auditPhase1.map((a, i) =>
            linkRow('../' + a.path, i + 1, a.label, a.desc, 'local', false, artifactMeta(a))
          ).join('') + '</div>'
        : '';

      const rescanRows = auditPhase4.length
        ? '<div class="link-list">' + auditPhase4.map((a, i) =>
            linkRow('../' + a.path, i + 1, a.label, a.desc, 'local', false, artifactMeta(a))
          ).join('') + '</div>'
        : '';

      const pipelineRows = p.pipeline.html.length
        ? '<div class="link-list">' + p.pipeline.html.map((a, i) =>
            linkRow('../' + a.path, i + 1, a.label, a.desc, 'local', false, artifactMeta(a))
          ).join('') + '</div>'
        : '';

      const liveItems = [
        [p.live.preview, 'Preview site', 'Deployed rebuilt site on temporary subdomain', 'For: prospect · Related: audit-report-after.html', true],
        [p.live.pitch, 'Pitch page (hosted)', 'Public handoff — share with practice', 'Hosted: /pitch/<slug>/ · mirrors pitch.html', true],
        [p.live.audit, 'Audit one-pager (hosted)', 'Same as local audit-summary.html', 'Hosted: /audits/<slug>/', true],
        [p.live.auditReport, 'Full audit report (hosted)', 'Same as local audit-report.html', 'Hosted: /audits/<slug>/audit-report', true],
        [p.live.beforeAfter, 'Before / after (hosted)', 'Visual comparison of old site vs preview', 'Hosted: /audits/<slug>/before-after', true],
      ];
      if (p.hasDist) liveItems.push(['../' + p.primaryDir + '/dist/index.html', 'Built site (local dist)', 'Static output from npm run build', 'Related: preview site', false]);
      liveItems.push([p.github, 'Source on GitHub', p.primaryDir, 'Operator reference', true]);

      const liveRows = '<div class="link-list">' + liveItems.map((item, i) => {
        const external = item[4];
        return linkRow(item[0], i + 1, item[1], item[2], external ? 'live' : 'local', external, item[3]);
      }).join('') + '</div>';

      const jsonBlock = p.pipeline.json.length
        ? '<details class="raw"><summary>Pipeline JSON (' + p.pipeline.json.length + ' step files)</summary>'
          + '<div class="json-grid">' + p.pipeline.json.map(j =>
              '<a href="../' + j.path + '">' + esc(j.file) + '</a>'
            ).join('') + '</div></details>'
        : '';

      const aliases = p.aliases.length
        ? '<div class="aliases">Legacy folders: ' + p.aliases.map(esc).join(', ') + '</div>' : '';

      return '<div class="panel" id="p-' + esc(p.slug) + '" data-slug="' + esc(p.slug) + '">'
        + '<div class="practice-hero">'
        + '<h2>' + esc(p.name) + '</h2>'
        + '<div class="practice-meta">'
        + '<a href="' + esc(p.url || '#') + '" target="_blank" rel="noopener">' + esc(p.url || '—') + '</a>'
        + '<span class="slug-chip">' + esc(p.slug) + '</span>'
        + aliases
        + '</div>'
        + (metrics.length ? '<div class="metrics">' + metrics.join('') + '</div>' : '')
        + '</div>'

        + '<div class="journey-intro"><strong>Artifact journey</strong> — phases run in order: (1) scan live site → (2) build redesign → (3) publish preview + hosted pages → (4) rescan preview vs baseline. See <a href="#doc-guide">Artifact guide</a> for definitions.</div>'

        + '<div class="flow">'
        + flowPhase(1, 'Pre-build audit', 'audit-site.js · live domain → audit-data.json + HTML renders', 'local', auditRows)
        + flowPhase(2, 'Site build', 'build-site.js · clients/&lt;slug&gt;/_pipeline/ outputs', 'local', pipelineRows)
        + flowPhase(3, 'Publish &amp; live', 'Preview subdomain + hosted /audits/ and /pitch/ URLs', 'live', liveRows)
        + flowPhase(4, 'Post-build rescan', 'rescan.js after publish · preview vs original findings', 'mixed', rescanRows)
        + '</div>'

        + jsonBlock
        + '</div>';
    }

    function show(slug) {
      $$('.panel').forEach(el => el.classList.remove('active'));
      $$('.nav button').forEach(b => b.classList.remove('active'));
      if (slug === 'overview') {
        $('#overview').classList.add('active');
        $('#nav-overview')?.classList.add('active');
      } else {
        const panel = $('#p-' + slug);
        const btn = $('#nav-' + slug);
        if (panel) panel.classList.add('active');
        if (btn) btn.classList.add('active');
      }
      history.replaceState(null, '', '#' + slug);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function init() {
      const nav = $('#nav');
      nav.innerHTML = '<button id="nav-overview" data-slug="overview">'
        + '<span class="dot"></span><span class="nav-text">Overview<span class="slug">all practices</span></span></button>'
        + '<button id="nav-guide" data-slug="doc-guide" class="nav-guide">'
        + '<span class="dot"></span><span class="nav-text">Artifact guide<span class="slug">what each doc is</span></span></button>'
        + PRACTICES.map(p => '<button id="nav-' + esc(p.slug) + '" data-slug="' + esc(p.slug) + '">'
          + '<span class="dot"></span><span class="nav-text">' + esc(p.name)
          + '<span class="slug">' + esc(p.slug) + '</span></span></button>').join('');

      $('#panels').innerHTML = PRACTICES.map(renderPanel).join('');

      const built = PRACTICES.filter(p => p.hasDist).length;
      const withAudit = PRACTICES.filter(p => p.audit.html.length).length;
      $('#stats').innerHTML = [
        ['Practices', PRACTICES.length],
        ['Built', built],
        ['Audited', withAudit],
      ].map(([l, v]) => '<div class="stat"><strong>' + v + '</strong><span>' + l + '</span></div>').join('');

      $('#index-table').innerHTML = PRACTICES.map(p => {
        const psi = p.scores.mobile;
        const psiCls = psi == null ? '' : (psi >= 90 ? 'ok' : 'warn');
        const psiTxt = psi == null ? '—' : psi;
        const buildCls = p.scores.buildSuccess ? 'ok' : (p.scores.buildSuccess === false ? 'warn' : '');
        const buildTxt = p.scores.buildSuccess ? '✓' : (p.scores.buildSuccess === false ? '✗' : '—');
        return '<tr data-slug="' + esc(p.slug) + '">'
          + '<td><div class="t-name">' + esc(p.name) + '</div><div class="t-slug">' + esc(p.slug) + '</div></td>'
          + '<td class="t-psi ' + psiCls + '">' + psiTxt + '</td>'
          + '<td class="t-psi ' + buildCls + '">' + buildTxt + '</td>'
          + '<td class="t-actions">'
          + '<a href="#' + esc(p.slug) + '">Journey</a>'
          + '<a href="' + esc(p.live.preview) + '" target="_blank" rel="noopener">Preview</a>'
          + '<a href="' + esc(p.live.pitch) + '" target="_blank" rel="noopener">Pitch</a>'
          + '</td></tr>';
      }).join('');

      nav.addEventListener('click', e => {
        const btn = e.target.closest('button[data-slug]');
        if (!btn) return;
        if (btn.dataset.slug === 'doc-guide') {
          show('overview');
          history.replaceState(null, '', '#doc-guide');
          setTimeout(() => document.getElementById('doc-guide')?.scrollIntoView({ behavior: 'smooth' }), 80);
        } else {
          show(btn.dataset.slug);
        }
      });

      $('#index-table').addEventListener('click', e => {
        const row = e.target.closest('tr[data-slug]');
        if (row && !e.target.closest('a[target]')) show(row.dataset.slug);
      });

      $('#q').addEventListener('input', e => {
        const q = e.target.value.toLowerCase();
        $$('.nav button').forEach(b => {
          if (b.dataset.slug === 'overview') { b.hidden = false; return; }
          const p = PRACTICES.find(x => x.slug === b.dataset.slug);
          const hay = (p.name + ' ' + p.slug + ' ' + (p.aliases||[]).join(' ')).toLowerCase();
          b.hidden = q && !hay.includes(q);
        });
      });

      const hash = location.hash.slice(1);
      if (hash === 'doc-guide') {
        show('overview');
        setTimeout(() => document.getElementById('doc-guide')?.scrollIntoView({ behavior: 'smooth' }), 80);
      } else {
        show(hash && (hash === 'overview' || PRACTICES.some(p => p.slug === hash)) ? hash : 'overview');
      }
      window.addEventListener('hashchange', () => {
        const h = location.hash.slice(1);
        if (h === 'doc-guide') {
          show('overview');
          setTimeout(() => document.getElementById('doc-guide')?.scrollIntoView({ behavior: 'smooth' }), 80);
        } else if (h === 'overview' || PRACTICES.some(p => p.slug === h)) {
          show(h || 'overview');
        }
      });
    }
    init();
  </script>
</body>
</html>`;
}

async function main() {
  const practices = await discoverPractices();
  const runs = await loadRuns();
  attachRuns(practices, runs);
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const html = renderHtml(practices, generatedAt);
  await writeFile(OUT, html, 'utf8');
  console.log(`Wrote ${OUT} (${practices.length} practices)`);
  if (process.argv.includes('--open')) {
    execSync(`open "${OUT}"`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
