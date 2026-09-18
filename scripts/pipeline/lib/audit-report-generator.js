/**
 * Audit Report Generator
 *
 * Generates two client-facing HTML reports from audit data:
 *   outputDir/audit-report.html  — full tabbed report (4 tabs)
 *   outputDir/audit-summary.html — 1-page printable summary
 *
 * Export:
 *   generateAuditReports(outputDir, { url, practiceName, pagespeed, techAudit, aiAudit, scraped, previewUrl })
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assembleAuditData, buildAgenticBrowsing, buildLighthouseChecks } from './audit-data-assembler.js';
import { buildFindingEvidenceRows, renderFindingEvidenceHtml } from './finding-evidence.js';
import { LIGHTHOUSE_METRICS } from './metric-glossary.js';
import { renderSalesAudit } from './sales-audit-renderer.js';
import { renderBuildSpec } from './build-spec-renderer.js';
import { previewScanCallout } from './preview-rescan.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  try {
    return new Date(iso || Date.now()).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });
  } catch { return String(iso || ''); }
}

function scoreColor(score) {
  if (score == null) return 'var(--on-dark-muted)';
  if (score >= 90) return '#2E7D4F';
  if (score >= 50) return '#C07A1A';
  return '#C0392B';
}

function scoreBg(score) {
  if (score == null) return 'var(--border-light)';
  if (score >= 90) return 'var(--success-bg)';
  if (score >= 50) return 'var(--warning-bg)';
  return 'var(--danger-bg)';
}

// Objective-counts hero. No subjective composite score — just the same
// numbers a prospect could verify themselves by counting cards in the
// findings tab. The left side narrates "we checked N things, here's the
// state." The right side breaks down the issues by severity.
function buildCountsHero(findingsSummary, gbpMeta) {
  if (!findingsSummary) return '';
  const { total, passed, critical, warnings, issues } = findingsSummary;
  // Color the border by how many critical issues exist. Red = real problem
  // worth surfacing; amber = warnings only; green = clean.
  const accent = critical > 0 ? '#C0392B' : warnings > 0 ? '#C07A1A' : '#2E7D4F';
  const bg     = critical > 0 ? 'var(--danger-bg)' : warnings > 0 ? 'var(--warning-bg)' : 'var(--success-bg)';

  const gbpLine = gbpMeta?.displayName
    ? `<div class="growth-hero-sub">GBP: <strong>${esc(gbpMeta.displayName)}</strong> · ${gbpMeta.userRatingCount ?? 0} reviews · ${gbpMeta.rating != null ? gbpMeta.rating.toFixed(1) + '★' : '—'}</div>`
    : '';

  const headline = issues === 0
    ? `All ${total} checks passed.`
    : `${issues} of ${total} checks need attention.`;

  return `
<section class="growth-hero" style="background:${bg};border-left:6px solid ${accent}">
  <div class="growth-hero-left">
    <div class="growth-hero-eyebrow">Site audit</div>
    <div class="growth-hero-headline" style="color:var(--ink)">${esc(headline)}</div>
    ${gbpLine}
  </div>
  <div class="growth-hero-right">
    <div class="growth-stat"><span class="growth-stat-num" style="color:var(--green)">${passed}</span><span class="growth-stat-label">Passed</span></div>
    <div class="growth-stat"><span class="growth-stat-num" style="color:var(--amber)">${warnings}</span><span class="growth-stat-label">Warnings</span></div>
    <div class="growth-stat"><span class="growth-stat-num" style="color:var(--red)">${critical}</span><span class="growth-stat-label">Critical</span></div>
  </div>
</section>`;
}

function scoreLabel(score) {
  if (score == null) return '—';
  if (score >= 90) return 'Good';
  if (score >= 50) return 'Needs work';
  return 'Poor';
}

// ---------------------------------------------------------------------------
// Diff-mode (before/after) rendering
// ---------------------------------------------------------------------------

function buildDiffHero(diff) {
  if (!diff?.summary) return '';
  const { counts } = diff.summary;
  const fixed        = counts.fixed || 0;
  const stillIss     = counts['still-issue'] || 0;
  const regressed    = counts.regressed || 0;
  const previewLim   = counts['preview-limited'] || 0;
  const notMeasured  = counts['not-measured'] || 0;
  const deferred     = previewLim + notMeasured;
  // Green if the build cleaned everything up; amber if some issues remain;
  // red if anything regressed (rare — would mean the rebuild was worse).
  const accent = regressed > 0 ? '#C0392B' : stillIss > 0 ? '#C07A1A' : '#2E7D4F';
  const bg     = regressed > 0 ? 'var(--danger-bg)' : stillIss > 0 ? 'var(--warning-bg)' : 'var(--success-bg)';

  const headline = regressed > 0
    ? `${fixed} fixed, but ${regressed} regressed in the rebuild.`
    : stillIss > 0
      ? `${fixed} fixed. ${stillIss} ${stillIss === 1 ? 'issue' : 'issues'} still need attention.`
      : fixed > 0
        ? `${fixed} previously-failing checks are now passing.`
        : 'Before → after comparison on rebuilt preview.';

  const subline = deferred > 0
    ? `${deferred} check${deferred === 1 ? '' : 's'} deferred (preview-only or not measured) — see below.`
    : '';

  return `
<section class="growth-hero diff-hero" style="background:${bg};border-left:6px solid ${accent}">
  <div class="growth-hero-left">
    <div class="growth-hero-eyebrow">Before → After</div>
    <div class="growth-hero-headline" style="color:var(--ink)">${esc(headline)}</div>
    ${subline ? `<div class="growth-hero-sub" style="font-size:13px;color:var(--text-dim);margin-top:8px;line-height:1.45">${esc(subline)}</div>` : ''}
  </div>
  <div class="growth-hero-right">
    <div class="growth-stat"><span class="growth-stat-num" style="color:var(--green)">${fixed}</span><span class="growth-stat-label">Fixed</span></div>
    <div class="growth-stat"><span class="growth-stat-num" style="color:var(--amber)">${stillIss}</span><span class="growth-stat-label">Still issue</span></div>
    <div class="growth-stat"><span class="growth-stat-num" style="color:var(--red)">${regressed}</span><span class="growth-stat-label">Regressed</span></div>
    ${deferred > 0 ? `<div class="growth-stat"><span class="growth-stat-num" style="color:var(--text-dim)">${deferred}</span><span class="growth-stat-label">Deferred</span></div>` : ''}
  </div>
</section>`;
}

function diffTransitionMeta(transition) {
  return {
    fixed:             { label: 'Fixed',              color: 'var(--green)',     symbol: '✓' },
    'still-issue':     { label: 'Still issue',        color: 'var(--amber)',     symbol: '!' },
    regressed:         { label: 'Regressed',          color: 'var(--red)',       symbol: '↓' },
    unchanged:         { label: 'Still passing',      color: 'var(--green)',     symbol: '✓' },
    new:               { label: 'New finding',        color: 'var(--amber)',     symbol: '+' },
    removed:           { label: 'Not re-scanned',     color: 'var(--text-dim)',  symbol: '—' },
    'not-measured':    { label: 'Not measured',       color: 'var(--text-dim)',  symbol: '?' },
    'preview-limited': { label: 'Preview / go-live',  color: 'var(--text-dim)',  symbol: '◇' },
  }[transition] || { label: transition, color: 'var(--text-dim)', symbol: '·' };
}

function buildDiffCard(d, productionDomain = '') {
  const meta = diffTransitionMeta(d.transition);
  const beforeDetail = d.before?.detail || '—';
  const afterDetail  = d.after?.detail
    || (d.transition === 'removed' ? 'Not included in the after scan.' : '—');
  const fixedLine = d.transition === 'fixed' && d.fixed_copy
    ? `<div class="diff-fixed-line">${esc(d.fixed_copy)}</div>`
    : '';
  const defaultNotMeasuredNote = d.transition === 'not-measured'
    ? 'This check was not measured on the preview rescan (typically because PageSpeed did not run). Re-run with GOOGLE_PAGESPEED_API_KEY set for a full before/after comparison.'
    : '';
  const prod = productionDomain || 'your practice domain';
  const defaultGoLiveNote = d.resolves_on_go_live && d.transition === 'preview-limited'
    ? `Resolves at go-live when <strong>${esc(prod)}</strong> is connected to this site and Google Business Profile is updated to match.`
    : '';
  const previewNote = d.preview_note
    ? `<div class="diff-preview-note"><strong>Preview note:</strong> ${esc(d.preview_note)}</div>`
    : (defaultGoLiveNote || defaultNotMeasuredNote
      ? `<div class="diff-preview-note">${defaultGoLiveNote || esc(defaultNotMeasuredNote)}</div>`
      : '');

  return `
<article class="diff-card diff-card-${d.transition}">
  <header class="diff-card-header">
    <span class="diff-card-symbol" style="color:${meta.color}">${meta.symbol}</span>
    <div class="diff-card-titles">
      <div class="diff-card-title">${esc(d.title || d.id)}</div>
      <div class="diff-card-category">${esc(d.category || '')}</div>
    </div>
    <span class="diff-card-badge" style="color:${meta.color};border-color:${meta.color}">${esc(meta.label)}</span>
  </header>
  ${fixedLine}
  <div class="diff-card-row">
    <div class="diff-card-side diff-card-before">
      <div class="diff-side-label">Before</div>
      <div class="diff-side-detail">${esc(beforeDetail)}</div>
    </div>
    <div class="diff-card-side diff-card-after">
      <div class="diff-side-label">After</div>
      <div class="diff-side-detail">${esc(afterDetail)}</div>
    </div>
  </div>
  ${previewNote}
  ${d.benefit ? `<div class="diff-card-benefit">Why this matters: ${esc(d.benefit)}</div>` : ''}
</article>`;
}

function buildDiffFindings(diff) {
  if (!diff?.diff?.length) {
    return `<div class="empty-state"><p>No diff data available.</p></div>`;
  }
  const callout = `<div class="lighthouse-callout" style="margin-bottom:24px">${previewScanCallout(diff.productionDomain)}</div>`;
  // Order groups for narrative: wins first, then problems, then context.
  const ORDER = ['fixed', 'regressed', 'still-issue', 'preview-limited', 'not-measured', 'new', 'unchanged', 'removed'];
  const byTransition = {};
  for (const d of diff.diff) {
    (byTransition[d.transition] ||= []).push(d);
  }

  const groups = [];
  for (const t of ORDER) {
    const items = byTransition[t];
    if (!items?.length) continue;
    const meta = diffTransitionMeta(t);
    groups.push(`
<section class="diff-group">
  <h3 class="diff-group-title" style="color:${meta.color}">${esc(meta.label)} (${items.length})</h3>
  <div class="diff-group-list">
    ${items.map(d => buildDiffCard(d, diff.productionDomain)).join('\n')}
  </div>
</section>`);
  }
  return callout + groups.join('\n');
}

function metricStatus(value, metric) {
  if (value == null) return 'na';
  if (metric === 'lcp') return value <= 2500 ? 'pass' : value <= 4000 ? 'warn' : 'fail';
  if (metric === 'fcp') return value <= 1800 ? 'pass' : value <= 3000 ? 'warn' : 'fail';
  if (metric === 'tbt') return value <= 200  ? 'pass' : value <= 600  ? 'warn' : 'fail';
  if (metric === 'cls') return value <= 0.1  ? 'pass' : value <= 0.25 ? 'warn' : 'fail';
  if (metric === 'si')  return value <= 3400 ? 'pass' : value <= 5800 ? 'warn' : 'fail';
  if (metric === 'tti') return value <= 3800 ? 'pass' : value <= 7300 ? 'warn' : 'fail';
  return 'na';
}

function formatMetric(value, metric) {
  if (value == null) return '—';
  if (metric === 'cls') return value.toFixed(3);
  if (metric === 'tbt') return `${Math.round(value).toLocaleString()}ms`; // TBT stays in ms (usually <1000)
  return `${(value / 1000).toFixed(2)}s`;
}

function severityIcon(severity) {
  if (severity === 'critical') return '✕';
  if (severity === 'warning')  return '!';
  return '✓';
}

// Human-readable display titles for finding IDs
const FINDING_DISPLAY_TITLES = {
  'missing-meta':      'Missing search result descriptions',
  'missing-title':     'Pages with no title in Google',
  'duplicate-titles':  'Pages competing against each other in Google',
  'missing-h1':        'Pages with no clear headline structure',
  'multiple-h1':       'Confusing headline structure on multiple pages',
  'thin-content':      'Pages with too little information for Google',
  'missing-schema':    'Not claiming your business identity in search',
  'missing-canonical': 'Search engines don\'t know which page to rank',
  'low-performance':   'Site is too slow on mobile phones',
  'low-lcp':           'First impression loads too slowly',
  'high-cls':          'Page content shifts around while loading',
  'missing-alt':       'Images invisible to Google and visually impaired patients',
  'no-testimonials':   'No patient reviews or social proof on site',
  'no-faq':            'No FAQ section to capture Google question searches',
  'thin-about':        'About page doesn\'t build enough trust',
};

function findingDisplayTitle(f) {
  return FINDING_DISPLAY_TITLES[f.id] || f.title;
}

// Human-readable "What We'd Fix" outcome text for each finding ID. Plain
// English, future-tense, ends with the patient/practice payoff. Should
// cover every check the grader can fire — otherwise the summary shows
// "No automated fix" placeholders.
const IMPROVEMENT_OUTCOMES = {
  // SEO — tech-audit.js
  'missing-meta':      'Every page gets a compelling description in Google search results, so patients actually click through to your site.',
  'missing-title':     'Every page gets a clear, keyword-rich title so Google knows what it\'s about — and so do patients.',
  'duplicate-titles':  'Each page targets a different search term, so your pages work together instead of canceling each other out.',
  'missing-h1':        'Patients and Google can immediately see what each page is about, making your content easier to navigate and rank.',
  'multiple-h1':       'Each page has exactly one H1, so search engines understand the primary topic without competing signals.',
  'thin-content':      'Key service pages get the depth of information patients are searching for — and Google rewards.',
  'missing-schema':    'Your practice name, location, hours, and services are claimed in Google\'s knowledge graph for richer search listings.',
  'missing-canonical': 'Search engines consolidate ranking power behind the right page version instead of splitting it across duplicates.',
  'title-no-city':     'Service page titles include your city, so local-intent ad keywords ("dental implants huntington beach") match strongest.',

  // Performance — tech-audit.js
  'low-performance':   'Faster loading so phone visitors stay on your site — instead of leaving before they ever read your name.',
  'low-lcp':           'The first thing a patient sees loads in under 2.5 seconds, giving a strong first impression on any device.',
  'high-cls':          'Content stays in place as the page loads — no shifting, no accidental taps, no frustrated visitors.',

  // Accessibility — tech-audit.js
  'missing-alt':       'Every image is described for Google Image Search and for patients using screen readers or low vision.',

  // Content — tech-audit.js
  'no-testimonials':   'Patient reviews and social proof are woven into the design so new patients feel confident choosing you.',
  'no-faq':            'A FAQ section captures patients asking questions in Google — and reduces repetitive phone calls to your front desk.',
  'thin-about':        'A rich About page with your story, credentials, and team photography that converts curious visitors into booked patients.',

  // Mobile — tech-audit.js
  'no-viewport':       'Pages render properly on phones so Google can index your site as mobile-friendly and patients don\'t pinch-to-zoom.',

  // Trust / contact — trust-scanner.js
  'no-phone-on-site':       'Click-to-call phone number lives in the header on every page, so mobile patients can dial without a search.',
  'no-address-on-site':     'Your address is surfaced on every page so prospects can locate your practice and Google sees a clear NAP signal.',
  'no-hours-on-site':       'Operating hours are visible everywhere so patients know when to call — and don\'t arrive to a closed office.',
  'no-social-links':        'Social profiles are linked in the footer, extending reach and giving prospects another channel to verify your practice.',

  // Hosting — hosting-scanner.js
  'using-third-party-domain': 'A first-party domain so the practice owns its SEO equity, brand authority, and tracking instead of borrowing from a hosted-site provider.',
  'fractured-web-presence':   'A single primary domain so Google ranks one authoritative source instead of splitting authority across duplicates.',

  // GBP — gbp-scanner.js
  'gbp-no-title':            'The Google Business Profile title is set to the practice name so prospects find you on Maps.',
  'gbp-no-description':      'A keyword-rich GBP description controls your narrative on Google Maps and improves "dentist near me" ranking.',
  'gbp-description-no-keywords': 'The GBP description includes the services and city you want to rank for in local search.',
  'gbp-no-phone':            'A click-to-call phone number on GBP enables direct calls from Google Maps — the highest-converting local action.',
  'gbp-no-hours':            'Hours on GBP enable the "Open now" filter and prevent visitors from showing up to a closed office.',
  'gbp-no-website-linked':   'The practice website is linked from GBP, driving qualified Maps traffic to your booking flow.',
  'gbp-low-review-count':    'A review-request flow grows your Google reviews — the #1 ranking factor in the local pack after relevance.',
  'gbp-category-mismatch':   'GBP categories are aligned with the services you offer, so you appear for the right local searches.',
  'gbp-incomplete-profile':  'Every essential GBP field is filled in, which Google rewards with higher placement in the local pack.',
  'gbp-website-mismatches-audit-url': 'GBP points to your primary domain, consolidating authority instead of bleeding to a secondary URL.',

  // Conversion tracking — conversion-scanner.js
  'no-ga4-configured':        'GA4 is wired up so Google Ads can import conversion signals — without it, Smart Bidding has nothing to optimize against.',
  'no-phone-click-tracking':  'A phone_click event fires on every tel: link, giving Google Ads the signal it needs to prioritize keywords that drive calls.',
};

// Derive key improvements from findings for "What We'd Fix" section
function deriveImprovements(techAudit, aiAudit) {
  const items = [];

  const findings = techAudit?.findings || [];
  const criticals = findings.filter(f => f.severity === 'critical');
  const warnings  = findings.filter(f => f.severity === 'warning');

  const seen = new Set();
  for (const f of [...criticals, ...warnings]) {
    const msg = IMPROVEMENT_OUTCOMES[f.id];
    if (msg && !seen.has(f.id)) {
      seen.add(f.id);
      items.push({ id: f.id, msg, severity: f.severity, findingTitle: findingDisplayTitle(f) });
    }
  }

  // Add AI audit improvements if available
  if (aiAudit?.contentGaps?.length) {
    items.push({
      id: 'content-gaps',
      msg: `New content addressing what patients in your area are actually searching for: ${aiAudit.contentGaps.slice(0, 2).join(', ')}.`,
      severity: 'warning',
    });
  }
  if (aiAudit?.positioning?.recommended) {
    items.push({
      id: 'positioning',
      msg: `Repositioned messaging that speaks directly to what makes your practice different: "${aiAudit.positioning.recommended.slice(0, 80)}…"`,
      severity: 'info',
    });
  }

  return items.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------

function sharedCss() {
  return `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    /* Groundwork Dental design system v2 — see /docs/design/DESIGN.md.
       Single source of truth: token names match the design doc 1:1.
       Legacy aliases below (--ink, --terracotta, --cream, etc.) point at
       the new tokens so existing CSS keeps working through the migration. */

    /* Brand — sage is THE accent (non-text); sage-dark is text/links/buttons */
    --sage:        #5F7F6B;
    --sage-dark:   #4A6B55;
    --sage-darker: #3D5A48;
    --sage-tint:   #EBF0EC;

    /* Neutrals */
    --charcoal:    #334155;
    --mid-gray:    #64748B;
    --border-light:#E0DDD5;

    /* Surfaces */
    --surface-1:   #FFFFFF;
    --surface-2:   #F8F8F3;
    --on-dark:     #E7EBF0;
    --on-dark-muted:#AAB4C2;

    /* Semantic — contrast-audited against their own backgrounds */
    --success:     #4A6B55;  /* same as sage-dark by design — one green */
    --success-bg:  #EBF0EC;
    --warning:     #92400E;
    --warning-bg:  #FCF4E8;
    --pending:     #475569;
    --pending-bg:  #F1F0EB;
    --danger:      #B42318;
    --danger-bg:   #FDF0EE;

    /* Legacy aliases — kept so existing rules in this file still resolve.
       Prefer the design-system tokens above for new code. */
    --ink:         var(--charcoal);
    --terracotta:  var(--sage-dark);    /* design system has no terracotta */
    --cream:       var(--surface-2);
    --surface:     var(--surface-1);
    --border:      var(--border-light);
    --text-dim:    var(--mid-gray);
    --green:       var(--success);
    --red:         var(--danger);
    --amber:       var(--warning);
    --blue:        var(--sage-dark);    /* drop the blue, brand is sage */

    /* Radius — design system: default = 4px, full = 9999. */
    --radius:      4px;

    /* Typography — Georgia for prose (zero font bytes), Figtree for UI
       chrome (one webfont, on-brand), system mono for numerals. */
    --font:        Georgia, "Times New Roman", serif;
    --font-ui:     Figtree, "Helvetica Neue", Helvetica, Arial, sans-serif;
    --mono:        ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  body { font-family: var(--font); background: var(--surface-1); color: var(--charcoal); font-size: 14px; line-height: 1.5; }

  /* UI chrome — Figtree on buttons, badges, eyebrows, labels, nav, tabs.
     Applied via class OR the selectors below cover the common cases. */
  .ui, button, .tab-btn, .badge, .badge-green,
  .gw-mark, .gw-logo .mark, .gw-logo .domain,
  .section-note, .source-note,
  .findings-group-title, .diff-group-title,
  .diff-card-category, .diff-card-badge, .diff-fixed-line, .diff-side-label,
  .score-name, .score-subtitle, .score-lbl, .score-pill,
  .compare-table th, .metric-sublabel, .metric-label, .metric-threshold,
  .finding-meta, .finding-source, .pages-label,
  .fs-label, .fs-num, .ai-block h4, .current-tag, .rec-tag,
  .tag-primary, .tag-secondary, .impr-finding-ref,
  .ba-header, .ba-label, .design-info h4, .design-key,
  .sev-badge, .section-title, .pair-found-severity, .pair-header,
  .pair-found-pages-label, .lead-magnet-eyebrow, .lead-magnet-btn,
  .lead-magnet-fineprint, .hero-screenshot-cap,
  .scores-headline, .scores-attribution,
  .report-footer, .empty-state {
    font-family: var(--font-ui);
  }

  /* Score circles */
  .score-circle {
    width: 100px; height: 100px; border-radius: 50%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    border: 4px solid currentColor;
    flex-shrink: 0;
  }
  .score-num { font-size: 28px; font-weight: 800; line-height: 1; }
  .score-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 3px; opacity: 0.75; }

  /* Metric row */
  .metric-status-pass { color: var(--green); }
  .metric-status-warn { color: var(--amber); }
  .metric-status-fail { color: var(--red); }
  .metric-status-na   { color: var(--text-dim); }

  /* Finding cards */
  .finding-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .finding-card.critical { border-left: 4px solid var(--red); }
  .finding-card.warning  { border-left: 4px solid var(--amber); }
  .finding-card.passed   { border-left: 4px solid var(--green); }

  .finding-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
  .finding-icon {
    width: 24px; height: 24px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 800; flex-shrink: 0; margin-top: 1px;
  }
  .finding-icon.critical { background: var(--danger-bg); color: var(--red); }
  .finding-icon.warning  { background: var(--warning-bg); color: var(--amber); }
  .finding-icon.passed   { background: var(--success-bg); color: var(--green); }

  .finding-title  { font-family: var(--font); font-size: 17px; font-weight: 400; line-height: 1.3; color: var(--charcoal); letter-spacing: -0.1px; }
  .finding-meta   { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-top: 2px; }
  .finding-detail { font-size: 13px; color: var(--ink); line-height: 1.55; margin-top: 8px; }
  .finding-evidence { font-size: 13px; font-weight: 700; color: var(--ink); line-height: 1.4; margin-top: 8px; }
  .finding-impact { font-size: 12px; color: var(--sage); line-height: 1.5; margin-top: 6px; font-style: italic; }
  .finding-source { font-size: 11px; color: var(--text-dim); margin-top: 6px; }
  .finding-pages  { margin-top: 8px; font-size: 11px; color: var(--text-dim); }
  .finding-pages summary { cursor: pointer; font-weight: 600; user-select: none; }
  .finding-pages summary:hover { color: var(--ink); }
  .finding-pages ul { list-style: none; margin-top: 5px; display: flex; flex-direction: column; gap: 2px; }
  .finding-pages li { font-family: var(--mono); font-size: 11px; padding: 2px 0; word-break: break-all; }

  /* Critical findings: show affected pages inline, no disclosure */
  .finding-pages-inline { margin-top: 10px; }
  .finding-pages-inline .pages-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 4px; }
  .finding-pages-inline ul { list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .finding-pages-inline li { font-family: var(--mono); font-size: 11px; padding: 2px 0; word-break: break-all; color: var(--ink); }

  .finding-page-evidence { margin-top: 14px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .finding-page-evidence summary { cursor: pointer; padding: 10px 14px; font-size: 12px; font-weight: 700; background: var(--surface-2); color: var(--sage-dark); list-style: none; }
  .finding-page-evidence summary::-webkit-details-marker { display: none; }
  .page-evidence-list { display: flex; flex-direction: column; }
  .page-evidence-card { padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .page-evidence-card:last-child { border-bottom: none; }
  .page-evidence-path { font-size: 12px; font-weight: 700; font-family: var(--mono); color: var(--sage-dark); text-decoration: none; display: inline-block; margin-bottom: 10px; }
  .page-evidence-path:hover { text-decoration: underline; }
  .page-evidence-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .pe-side { border-radius: 6px; padding: 10px 12px; font-size: 12px; line-height: 1.5; }
  .pe-side.pe-now { background: #FCF4E8; border: 1px solid #E8D4A8; }
  .pe-side.pe-good { background: var(--sage-tint); border: 1px solid var(--sage); }
  .pe-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; color: var(--text-dim); }
  .pe-value { color: var(--ink); }
  .pe-detail { margin-top: 6px; font-size: 11px; color: var(--text-dim); }
  .page-evidence-foot { font-size: 11px; color: var(--text-dim); padding: 8px 14px; background: var(--surface-2); border-top: 1px solid var(--border); }
  .finding-page-evidence .evidence-scroll { max-height: 280px; overflow-y: auto; }
  .finding-page-evidence .evidence-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0; font-family: var(--mono); font-size: 11.5px; border-bottom: 1px solid var(--border); }
  .finding-page-evidence .evidence-row.head { background: var(--surface-2); position: sticky; top: 0; font-family: var(--font-ui); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-dim); }
  .finding-page-evidence .evidence-row span { padding: 8px 12px; word-break: break-word; }
  .finding-page-evidence .evidence-row .url { border-right: 1px solid var(--border); }
  .finding-page-evidence .evidence-row .url a { color: var(--sage-dark); text-decoration: none; }
  .finding-page-evidence .evidence-row .url a:hover { text-decoration: underline; }
  @media (max-width: 700px) { .page-evidence-compare { grid-template-columns: 1fr; } }
  `;
}

// ---------------------------------------------------------------------------
// Full report builder (audit-report.html)
// ---------------------------------------------------------------------------

function buildFullReport({ url, practiceName, pagespeed, techAudit, aiAudit, scraped, previewUrl, findingsSummary = null, gbpMeta = null, diff = null, existingAgentic = null, agenticBrowsing = null, bronze = null }) {
  const runDate = formatDate(new Date().toISOString());
  const mobile  = pagespeed?.mobile  || null;
  const desktop = pagespeed?.desktop || null;

  const criticalCount = techAudit?.summary?.critical || 0;
  const diffMode = !!diff?.diff?.length;
  const hero = diffMode
    ? buildDiffHero(diff)
    : buildCountsHero(findingsSummary, gbpMeta);
  const findingsTabContent = diffMode
    ? buildDiffFindings(diff)
    : buildFindingsTab(techAudit, { bronze, scraped });
  const findingsTabLabel = diffMode ? 'Before → After' : 'What We Found';
  const findingsTabBadgeCount = diffMode ? diff.summary.counts.fixed : criticalCount;
  const findingsTabBadgeClass = diffMode ? 'badge-green' : 'badge';
  const agenticIssue = agenticBrowsing?.llms_txt_status && agenticBrowsing.llms_txt_status !== 'good';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Site Audit — ${esc(practiceName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${sharedCss()}

/* ── Header ── */
/* Header — charcoal band per design system. Wordmark + practice title.
   Georgia for the practice title (it's prose, not UI chrome). */
.header { background: var(--charcoal); color: var(--on-dark); padding: 24px 32px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.header-left h1 { font-family: var(--font); font-size: 22px; font-weight: 400; letter-spacing: -0.3px; color: var(--on-dark); }
.header-left .sub { color: var(--on-dark-muted); font-size: 13px; margin-top: 4px; font-family: var(--font-ui); }
.header-badge { font-size: 12px; color: var(--on-dark-muted); text-align: right; line-height: 1.7; }
/* Brand wordmark per /docs/design/DESIGN.md — Georgia 'Groundwork' + sage divider + Figtree 'dental'. */
.gw-mark { display: inline-flex; align-items: baseline; gap: 8px; font-size: 16px; }
.gw-mark .word { font-family: var(--font); font-weight: 400; color: var(--on-dark); letter-spacing: -0.2px; }
.gw-mark .divider { width: 1px; height: 12px; background: var(--sage); align-self: center; }
.gw-mark .suffix { font-family: var(--font-ui); font-size: 10px; font-weight: 500; color: var(--sage); letter-spacing: 0.14em; text-transform: uppercase; }

/* ── Tab Nav ── */
.tab-nav { background: var(--surface); border-bottom: 2px solid var(--border); padding: 0 32px; display: flex; gap: 0; overflow-x: auto; }
.tab-btn { background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -2px; padding: 13px 20px; font-size: 13px; font-weight: 600; color: var(--text-dim); cursor: pointer; white-space: nowrap; transition: color 0.15s, border-color 0.15s; }
.tab-btn:hover { color: var(--ink); }
.tab-btn.active { color: var(--terracotta); border-bottom-color: var(--terracotta); }
.badge { background: var(--red); color: white; font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 10px; margin-left: 5px; vertical-align: middle; }

/* ── Main ── */
.main { max-width: 1080px; margin: 0 auto; padding: 32px 32px 80px; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* ── Section layout ── */
.section-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--border); margin-bottom: 28px; }
/* Section headings — Georgia per design system (prose). */
.section-header h2 { font-family: var(--font); font-size: 22px; font-weight: 400; letter-spacing: -0.2px; color: var(--charcoal); }
.section-note { font-size: 12px; color: var(--text-dim); }

/* ── Audit Hero ── */
.growth-hero { max-width: 1080px; margin: 28px auto 0; padding: 22px 28px; border-radius: var(--radius); display: flex; align-items: center; justify-content: space-between; gap: 32px; flex-wrap: wrap; }
.growth-hero-eyebrow { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); margin-bottom: 6px; }
.growth-hero-headline { font-family: var(--font); font-size: 30px; font-weight: 400; line-height: 1.2; letter-spacing: -0.4px; }
.growth-hero-sub { font-size: 12px; color: var(--text-dim); margin-top: 8px; }
.growth-hero-right { display: flex; gap: 28px; }
.growth-stat { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.growth-stat-num { font-size: 30px; font-weight: 800; font-family: var(--mono); line-height: 1; }
.growth-stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); }

/* ── Diff hero + cards (re-scan / before→after mode) ── */
.badge-green { background: var(--green); color: white; font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 10px; margin-left: 5px; vertical-align: middle; }

.diff-group { margin-bottom: 32px; }
.diff-group-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 14px; }
.diff-group-list { display: flex; flex-direction: column; gap: 12px; }

.diff-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
.diff-card-fixed { border-left: 4px solid var(--green); }
.diff-card-regressed { border-left: 4px solid var(--red); }
.diff-card-still-issue { border-left: 4px solid var(--amber); }
.diff-card-preview-limited,
.diff-card-not-measured { border-left: 4px solid var(--border); }
.diff-card-new { border-left: 4px solid var(--amber); }
.diff-card-unchanged { border-left: 4px solid var(--green); opacity: 0.7; }
.diff-preview-note { font-size: 12px; line-height: 1.5; color: var(--text-dim); background: var(--surface-2); border-radius: var(--radius); padding: 10px 12px; margin-top: 10px; }
.diff-card-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.diff-card-symbol { font-size: 18px; font-weight: 800; line-height: 1.2; }
.diff-card-titles { flex: 1; }
.diff-card-title { font-family: var(--font); font-size: 17px; font-weight: 400; color: var(--charcoal); letter-spacing: -0.1px; }
.diff-card-category { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-top: 2px; }
.diff-card-badge { font-size: 10px; font-weight: 800; padding: 3px 8px; border-radius: 12px; border: 1px solid; text-transform: uppercase; letter-spacing: 0.5px; }
.diff-fixed-line { font-size: 13px; font-weight: 600; color: var(--green); margin-bottom: 12px; }
.diff-card-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.diff-card-side { padding: 12px 14px; }
.diff-card-before { background: var(--danger-bg); border-right: 1px solid var(--border); }
.diff-card-after  { background: var(--success-bg); }
.diff-side-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 4px; }
.diff-side-detail { font-size: 12px; line-height: 1.5; }
.diff-card-benefit { font-size: 12px; font-style: italic; color: var(--text-dim); margin-top: 10px; line-height: 1.5; }

/* ── Scorecard ── */
.score-strip { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 32px; }
.score-cell { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.score-name { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); text-align: center; }
.score-subtitle { font-size: 11px; color: var(--text-dim); font-weight: 400; text-align: center; max-width: 90px; line-height: 1.35; }

.lighthouse-callout { background: var(--sage-tint); border: 1px solid var(--sage); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 28px; font-size: 13px; line-height: 1.6; color: var(--charcoal); }
.lighthouse-callout strong { color: var(--sage-dark); }
.lighthouse-callout a { color: var(--sage-dark); }

.compare-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 32px; }
.compare-table th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); padding: 8px 12px; background: var(--surface-2); border: 1px solid var(--border); }
.compare-table td { padding: 10px 12px; border: 1px solid var(--border); font-weight: 600; }
.compare-table td.score-desc { font-size: 11px; color: var(--text-dim); font-weight: 400; }
.compare-table tr:nth-child(even) td { background: var(--surface-2); }
.score-val { display: inline-flex; align-items: center; gap: 8px; }
.score-pill { font-size: 13px; font-weight: 800; padding: 3px 10px; border-radius: 20px; display: inline-block; }

.metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 32px; }
@media (max-width: 700px) { .metrics-grid { grid-template-columns: 1fr 1fr; } }
.metric-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.metric-label { font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 2px; }
.metric-sublabel { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 6px; }
.metric-value { font-size: 22px; font-weight: 800; font-family: var(--mono); line-height: 1; }
.metric-threshold { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.metric-desc { font-size: 11px; line-height: 1.45; color: var(--text-dim); margin-top: 6px; }
.source-note { font-size: 11px; color: var(--text-dim); font-style: italic; margin-top: 8px; }

/* ── Agentic browsing tab ── */
.agentic-status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 24px; }
@media (max-width: 700px) { .agentic-status-grid { grid-template-columns: 1fr; } }
.agentic-stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.agentic-stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 6px; }
.agentic-stat-value { font-size: 20px; font-weight: 800; font-family: var(--mono); line-height: 1.1; }
.agentic-stat-outof { font-size: 14px; font-weight: 600; color: var(--text-dim); }
.agentic-stat-sublabel { font-size: 11px; line-height: 1.45; color: var(--text-dim); margin-top: 8px; }
.agentic-headline { font-size: 14px; line-height: 1.55; padding: 14px 18px; border-radius: var(--radius); margin-bottom: 20px; }
.agentic-headline.agentic-warn { background: #FCF4E8; border: 1px solid #E8D4A8; color: var(--amber); }
.agentic-headline.agentic-ok { background: var(--sage-tint); border: 1px solid var(--sage); color: var(--sage-dark); }
.agentic-evidence { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 16px; }
.agentic-evidence-head { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 10px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-dim); }
.agentic-issues { padding: 12px 14px 12px 28px; font-size: 13px; line-height: 1.5; }
.agentic-issues li { margin-bottom: 6px; }
.agentic-details { margin: 12px 0; border: 1px solid var(--border); border-radius: var(--radius); }
.agentic-details summary { cursor: pointer; padding: 10px 14px; font-size: 12px; font-weight: 700; background: var(--surface-2); }
.agentic-pre { margin: 0; padding: 12px 14px; font-family: var(--mono); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: #FAFAF8; max-height: 240px; overflow: auto; }
.agentic-pre-good { background: var(--sage-tint); }
.agentic-checks { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 24px; }
.agentic-checks-head { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 10px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-dim); }
.agentic-check-row { display: flex; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--border); align-items: flex-start; }
.agentic-check-row:last-child { border-bottom: none; }
.agentic-check-badge { flex-shrink: 0; font-size: 10px; font-weight: 800; letter-spacing: 0.04em; padding: 4px 8px; border-radius: 4px; font-family: var(--mono); margin-top: 2px; }
.agentic-check-badge.pass { background: var(--sage-tint); color: var(--sage-dark); border: 1px solid var(--sage); }
.agentic-check-badge.fail { background: #FCE8E8; color: var(--red); border: 1px solid #E8B4B4; }
.agentic-check-badge.na { background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--border); }
.agentic-check-badge.unknown { background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--border); }
.agentic-check-body { flex: 1; min-width: 0; }
.agentic-check-title { font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 4px; }
.agentic-check-summary { font-size: 12px; line-height: 1.5; color: var(--text-dim); margin-bottom: 6px; }
.agentic-check-note { font-size: 12px; line-height: 1.5; color: var(--charcoal); padding: 8px 10px; background: var(--surface-2); border-radius: 4px; }
.agentic-check-note.future { background: #F5F5F3; color: var(--text-dim); font-style: italic; }

/* ── Technical Findings ── */
.findings-summary { background: var(--charcoal); color: var(--on-dark); border-radius: var(--radius); padding: 16px 22px; margin-bottom: 24px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.fs-stat { display: flex; align-items: center; gap: 8px; }
.fs-num { font-size: 22px; font-weight: 800; font-family: var(--mono); line-height: 1; }
/* On the dark findings-summary band: brighter accents so the numerals
   read against charcoal. AA-checked: #FF8B7E ~5.1:1 / #F5C745 ~9.5:1. */
.fs-num.critical { color: #FF8B7E; }
.fs-num.warning  { color: #F5C745; }
.fs-label { font-size: 12px; font-weight: 600; color: var(--on-dark-muted); }

.findings-group { margin-bottom: 28px; }
.findings-group-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.findings-group-title.critical { color: var(--red); }
.findings-group-title.warning  { color: var(--amber); }
.findings-group-title.passed   { color: var(--green); }
.findings-list { display: flex; flex-direction: column; gap: 10px; }

.passed-checklist { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
.passed-item { background: var(--surface); border: 1px solid var(--success-bg); border-radius: var(--radius); padding: 10px 14px; display: flex; align-items: center; gap: 10px; font-size: 13px; }
.passed-check { color: var(--green); font-weight: 800; flex-shrink: 0; }

/* ── AI Audit Tab ── */
.ai-source-note { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; margin-bottom: 24px; font-size: 13px; line-height: 1.6; color: var(--ink); }
.ai-source-note strong { color: var(--terracotta); }
.ai-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 700px) { .ai-grid { grid-template-columns: 1fr; } }
.ai-block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
.ai-block h4 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim); margin-bottom: 12px; }
.current-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 3px; }
.rec-tag     { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--terracotta); margin-top: 10px; margin-bottom: 3px; }
.rec-text    { font-weight: 700; color: var(--terracotta); font-size: 13px; line-height: 1.5; }
.rationale   { font-size: 12px; color: var(--text-dim); font-style: italic; line-height: 1.5; margin-top: 4px; }
.tag-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.tag-primary   { background: var(--terracotta); color: white; font-size: 12px; padding: 3px 10px; border-radius: 20px; font-weight: 600; }
.tag-secondary { background: var(--border-light); color: var(--ink); font-size: 12px; padding: 3px 10px; border-radius: 20px; font-weight: 500; }
.bullet-list { list-style: none; display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
.bullet-list li { font-size: 13px; padding-left: 16px; position: relative; line-height: 1.5; }
.bullet-list li::before { content: '•'; position: absolute; left: 4px; color: var(--terracotta); font-weight: 700; }
.empty-state { text-align: center; padding: 48px 24px; color: var(--text-dim); }
.empty-state p { font-size: 14px; line-height: 1.6; }

/* ── What We'd Fix ── */
.preview-block { background: var(--charcoal); border-radius: var(--radius); padding: 32px; text-align: center; margin-bottom: 32px; }
.preview-block h3 { font-family: var(--font); font-size: 26px; font-weight: 400; color: var(--on-dark); margin-bottom: 10px; letter-spacing: -0.3px; }
.preview-block p { color: var(--on-dark-muted); font-size: 14px; margin-bottom: 20px; line-height: 1.5; }
/* Matches .btn-primary spec — see /docs/design/DESIGN.md buttons section. */
.preview-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--sage-dark); color: white; text-decoration: none; font-family: var(--font-ui); font-size: 14px; font-weight: 500; padding: 12px 24px; border-radius: var(--radius); letter-spacing: 0.025em; min-height: 44px; line-height: 20px; transition: background-color 200ms; }
.preview-btn:hover { background: var(--sage-darker); }
.preview-btn:focus-visible { outline: 2px solid var(--sage); outline-offset: 2px; }
.preview-iframe { width: 100%; height: 500px; border: none; border-radius: var(--radius); margin-bottom: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.12); }

.improvements-list { display: flex; flex-direction: column; gap: 12px; }
.improvement-item { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
.impr-finding-ref { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 5px; }
.impr-finding-ref.critical { color: var(--red); }
.impr-finding-ref.warning  { color: var(--amber); }
.impr-text { font-size: 13px; line-height: 1.55; }

.before-after-block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 12px; }
.before-after-block .ba-header { padding: 12px 18px; background: var(--surface-2); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); }
.ba-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.ba-col { padding: 14px 18px; }
.ba-col:first-child { border-right: 1px solid var(--border); }
.ba-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.ba-label.before { color: var(--red); }
.ba-label.after  { color: var(--green); }
.ba-content { font-size: 13px; line-height: 1.5; }

.design-info { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-top: 24px; }
.design-info h4 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim); margin-bottom: 12px; }
.design-row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border-light); font-size: 13px; }
.design-row:last-child { border-bottom: none; }
.design-key { color: var(--text-dim); min-width: 100px; flex-shrink: 0; font-weight: 600; font-size: 12px; }
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <h1>${esc(practiceName)} — Site Audit</h1>
    <div class="sub">${esc(url)} &nbsp;·&nbsp; ${esc(runDate)}</div>
  </div>
  <div class="header-badge">
    <div class="gw-mark">
      <span class="word">Groundwork</span>
      <span class="divider"></span>
      <span class="suffix">dental</span>
    </div>
    <div style="color:var(--on-dark-muted);font-size:11px;margin-top:6px;font-family:var(--font-ui)">groundworkdental.com</div>
  </div>
</header>

${hero}

<nav class="tab-nav">
  <button class="tab-btn active" data-tab="scorecard">Scorecard</button>
  <button class="tab-btn" data-tab="agentic">AI Agent Readiness ${agenticIssue ? '<span class="badge">!</span>' : ''}</button>
  <button class="tab-btn" data-tab="findings">${esc(findingsTabLabel)} ${findingsTabBadgeCount > 0 ? `<span class="${findingsTabBadgeClass}">${findingsTabBadgeCount}</span>` : ''}</button>
  <button class="tab-btn" data-tab="content">Your Messaging</button>
  <button class="tab-btn" data-tab="build">What We'd Fix</button>
</nav>

<main class="main">

  <!-- ═══ TAB: Scorecard ═══════════════════════════════════════════════════ -->
  <div class="tab-panel active" id="tab-scorecard">
    ${buildScorecardTab(mobile, desktop, existingAgentic)}
  </div>

  <!-- ═══ TAB: AI Agent Readiness ════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-agentic">
    ${buildAgenticTab(agenticBrowsing, techAudit)}
  </div>

  <!-- ═══ TAB: What We Found / Before → After ════════════════════════════ -->
  <div class="tab-panel" id="tab-findings">
    ${findingsTabContent}
  </div>

  <!-- ═══ TAB: Your Messaging ════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-content">
    ${buildAiAuditTab(aiAudit)}
  </div>

  <!-- ═══ TAB: What We'd Fix ══════════════════════════════════════════════ -->
  <div class="tab-panel" id="tab-build">
    ${buildWhatWedbuildTab(techAudit, aiAudit, scraped, previewUrl)}
  </div>

</main>

<script>
  const btns   = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      btns.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + target)?.classList.add('active');
    });
  });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Agentic Readiness section (existing site — pre-build before-state)
// ---------------------------------------------------------------------------

function buildAgenticReadinessSection(existingAgentic) {
  if (!existingAgentic || existingAgentic.skipped) return '';

  const { results = [], passed, total, fraction } = existingAgentic;

  const accentColor = passed === 0 ? 'var(--red)' : passed < total ? 'var(--amber)' : 'var(--green)';
  const bgColor     = passed === 0 ? 'var(--danger-bg)' : passed < total ? 'var(--warning-bg)' : 'var(--success-bg)';

  const rows = results.map(r => {
    const icon  = r.pass ? '✓' : '✗';
    const color = r.pass ? 'var(--green)' : 'var(--red)';
    return `<tr>
      <td style="padding:10px 14px;border:1px solid var(--border);font-weight:600;font-size:13px">${esc(r.title)}</td>
      <td style="padding:10px 14px;border:1px solid var(--border);color:${color};font-weight:800;font-size:15px;text-align:center">${icon}</td>
      <td style="padding:10px 14px;border:1px solid var(--border);font-size:12px;color:var(--text-dim)">${esc(r.detail || '')}</td>
    </tr>`;
  }).join('');

  return `
  <div style="margin-top:40px">
    <div class="section-header">
      <h2>AI &amp; Agent Readiness</h2>
      <span class="section-note">Current site — before rebuild</span>
    </div>
    <div style="background:${bgColor};border-left:5px solid ${accentColor};border-radius:var(--radius);padding:18px 22px;margin-bottom:22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px">
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);margin-bottom:5px">Agentic browsing score</div>
        <div style="font-family:var(--font);font-size:26px;font-weight:400;letter-spacing:-0.3px;color:var(--ink)">Your existing site scores <strong style="color:${accentColor}">${esc(fraction)}</strong> on AI-agent readiness checks.</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:6px">AI assistants like ChatGPT, Perplexity, and Google AI Overview use these signals to decide whether to surface your practice.</div>
      </div>
      <div style="font-size:42px;font-weight:800;font-family:var(--mono);color:${accentColor};line-height:1">${esc(fraction)}</div>
    </div>
    <table class="compare-table" style="margin-bottom:0">
      <thead>
        <tr>
          <th style="width:30%">Check</th>
          <th style="width:60px;text-align:center">Result</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="source-note" style="margin-top:10px">Checked by fetching your live site. These checks mirror the Agentic Browsing criteria in Lighthouse 13.3+. After the Groundwork rebuild, your site is designed to score 4/4.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Tab: Scorecard
// ---------------------------------------------------------------------------

function buildScorecardTab(mobile, desktop, existingAgentic = null) {
  const categories = [
    {
      key: 'performance',
      label: 'Mobile Speed',
      subtitle: 'How fast your site loads on a phone',
    },
    {
      key: 'seo',
      label: 'Google Visibility',
      subtitle: 'How easily patients can find you',
    },
    {
      key: 'accessibility',
      label: 'Ease of Use',
      subtitle: 'Works for all patients, all devices',
    },
    {
      key: 'bestPractices',
      label: 'Technical Health',
      subtitle: 'Security & modern standards',
    },
  ];

  // Big score circles — use mobile as primary
  const scoreCircles = categories.map(cat => {
    const score = mobile?.[cat.key] ?? null;
    const color = scoreColor(score);
    const bg    = scoreBg(score);
    return `<div class="score-cell">
      <div class="score-circle" style="background:${esc(bg)};color:${esc(color)};border-color:${esc(color)}">
        <span class="score-num">${score != null ? score : '—'}</span>
        <span class="score-lbl">${esc(scoreLabel(score))}</span>
      </div>
      <div class="score-name">${esc(cat.label)}</div>
      <div class="score-subtitle">${esc(cat.subtitle)}</div>
    </div>`;
  }).join('');

  // Mobile vs Desktop comparison table
  const rows = categories.map(cat => {
    const m = mobile?.[cat.key]  ?? null;
    const d = desktop?.[cat.key] ?? null;
    return `<tr>
      <td>
        <strong>${esc(cat.label)}</strong><br>
        <span class="score-desc">${esc(cat.subtitle)}</span>
      </td>
      <td><span class="score-pill" style="background:${esc(scoreBg(m))};color:${esc(scoreColor(m))}">${m != null ? m : '—'}</span></td>
      <td><span class="score-pill" style="background:${esc(scoreBg(d))};color:${esc(scoreColor(d))}">${d != null ? d : '—'}</span></td>
    </tr>`;
  }).join('');

  // Key metrics — plain language names. Shared with summary via
  // buildMobileSpeedBreakdown() so both reports render the same block.
  const metricsBreakdown = buildMobileSpeedBreakdown(mobile);

  const noData = !mobile && !desktop;

  return `
  <div class="section-header">
    <h2>Your Site Scores</h2>
    <span class="section-note">${noData ? 'PageSpeed not run' : 'Mobile scores shown · measured by Google'}</span>
  </div>

  ${noData ? `<div class="empty-state"><p>PageSpeed Insights was not run for this audit.<br>Re-run without <code>--skip-pagespeed</code> to see scores.</p></div>` : `

  <div class="lighthouse-callout">
    <strong>Where these scores come from:</strong> These scores are measured by Google Lighthouse — the same tool Google uses to evaluate sites for search ranking. They are objective measurements, not our opinion. You can verify any score yourself at <a href="https://pagespeed.web.dev" target="_blank">pagespeed.web.dev</a>.
  </div>

  <div class="score-strip">${scoreCircles}</div>

  <table class="compare-table">
    <thead>
      <tr>
        <th>Score</th>
        <th>Mobile (primary)</th>
        <th>Desktop</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  ${metricsBreakdown}

  <p class="source-note">All metrics sourced from Google PageSpeed Insights API v5. Mobile scores are the primary signal Google uses for search ranking.</p>
  `}

  ${buildAgenticReadinessSection(existingAgentic)}`;
}

/**
 * Render the "Mobile speed breakdown" block — heading + 6 Lighthouse metric
 * cards (LCP, FCP, TBT, CLS, SI, TTI) with goal thresholds and pass/warn/fail
 * coloring. Shared by the full report (scorecard tab) AND the customer-facing
 * summary, so both convey the same visceral "your LCP is 12s vs goal 2.5s"
 * detail rather than just an abstract 0-100 score.
 *
 * Returns empty string if no mobile data.
 */
function buildMobileSpeedBreakdown(mobile) {
  if (!mobile) return '';
  const mMetrics = mobile.metrics || {};
  const metricDefs = [
    { key: 'lcp', label: 'Time to See Your Page' },
    { key: 'fcp', label: 'Time to First Content' },
    { key: 'tbt', label: 'Page Responsiveness' },
    { key: 'cls', label: 'Visual Stability' },
    { key: 'si',  label: 'How Fast It Looks Loaded' },
    { key: 'tti', label: 'Time Until Fully Interactive' },
  ];
  const cards = metricDefs.map(m => {
    const def    = LIGHTHOUSE_METRICS[m.key];
    const val    = mMetrics[m.key] ?? null;
    const status = metricStatus(val, m.key);
    const color  = { pass: 'var(--green)', warn: 'var(--amber)', fail: 'var(--red)', na: 'var(--text-dim)' }[status];
    const threshold = def
      ? `Goal: under ${def.thresholds.good}`
      : '';
    const sublabel = def ? `${def.name} (${def.acronym})` : m.key.toUpperCase();
    const desc = def?.shortDesc || '';
    return `<div class="metric-card">
      <div class="metric-label">${esc(m.label)}</div>
      <div class="metric-sublabel">${esc(sublabel)}</div>
      <div class="metric-value metric-status-${esc(status)}" style="color:${esc(color)}">${esc(formatMetric(val, m.key))}</div>
      <div class="metric-threshold">${esc(threshold)}</div>
      ${desc ? `<div class="metric-desc">${esc(desc)}</div>` : ''}
    </div>`;
  }).join('');
  return `
  <div style="font-size:13px;font-weight:700;margin-bottom:14px;color:var(--ink)">Mobile speed breakdown <span style="font-size:11px;font-weight:400;color:var(--text-dim)">— measured by Google Lighthouse on a simulated phone</span></div>
  <div class="metrics-grid">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Tab: AI Agent Readiness (llms.txt + Lighthouse agentic-browsing)
// ---------------------------------------------------------------------------

function buildAgenticChecksList(checks = []) {
  if (!checks.length) return '';

  const badgeLabel = { pass: 'PASS', fail: 'FAIL', na: 'N/A', unknown: '—' };
  const rows = checks.map(c => {
    const noteClass = c.priority === 'future' && c.status !== 'fail' ? 'future' : '';
    const note = c.note
      ? `<div class="agentic-check-note ${noteClass}">${esc(c.note)}</div>`
      : '';
    return `<div class="agentic-check-row">
      <div class="agentic-check-badge ${esc(c.status)}">${badgeLabel[c.status] || '—'}</div>
      <div class="agentic-check-body">
        <div class="agentic-check-title">${esc(c.title)}</div>
        <div class="agentic-check-summary">${esc(c.summary)}</div>
        ${note}
      </div>
    </div>`;
  }).join('');

  return `<div class="agentic-checks">
    <div class="agentic-checks-head">All Lighthouse agentic checks (${checks.length})</div>
    ${rows}
  </div>`;
}

function buildAgenticTab(agentic, techAudit) {
  if (!agentic && !techAudit) {
    return `<div class="empty-state"><p>Agentic browsing audit was not run for this site.</p></div>`;
  }

  const status = agentic?.llms_txt_status || 'unknown';
  const statusLabel = { absent: 'Missing', poor: 'Present but subpar', good: 'Good', unknown: 'Not checked' }[status] || status;
  const statusColor = status === 'good' ? 'var(--green)' : status === 'unknown' ? 'var(--text-dim)' : 'var(--amber)';
  const ratio = agentic?.pass_ratio;
  const ratioStr = ratio ? `${ratio.passed}/${ratio.total} checks passing` : '—';
  const ev = agentic?.llms_evidence || {};
  const llmsFinding = (techAudit?.findings || []).find(f =>
    f.id === 'no-llms-txt' || f.id === 'llms-txt-poor' || f.id === 'agent-accessibility-tree-poor'
  );

  const issues = (ev.issues || []).map(i => `<li>${esc(i)}</li>`).join('');
  const flagged = (ev.flagged_lines || []).slice(0, 6).map(f =>
    `<li><code>${esc(f.line)}</code> — ${esc(f.reason)}</li>`
  ).join('');

  const currentExcerpt = ev.current_excerpt
    ? `<details class="agentic-details" open>
        <summary>What your llms.txt looks like today</summary>
        <pre class="agentic-pre">${esc(ev.current_excerpt)}</pre>
      </details>`
    : (status === 'absent'
      ? `<p class="source-note">No file found at <a href="${esc(ev.verify_url || '')}" target="_blank">${esc(ev.verify_url || '/llms.txt')}</a></p>`
      : '');

  const recommended = ev.recommended_excerpt
    ? `<details class="agentic-details">
        <summary>What good looks like (Groundwork rebuild)</summary>
        <pre class="agentic-pre agentic-pre-good">${esc(ev.recommended_excerpt)}</pre>
      </details>`
    : '';

  const verify = ev.verify_url
    ? `<p class="source-note">Verify yourself: <a href="${esc(ev.verify_url)}" target="_blank">${esc(ev.verify_url)}</a>${ev.lighthouse_note ? ` · Lighthouse: ${esc(ev.lighthouse_note)}` : ''}</p>`
    : '';

  const findingNote = llmsFinding?.benefit
    ? `<div class="lighthouse-callout" style="margin-top:20px"><strong>Why this matters:</strong> ${esc(llmsFinding.benefit)}</div>`
    : '';

  const lhScore = agentic?.lighthouse_score;
  const scoreValue = lhScore?.value ?? (agentic?.fractional_score != null ? Math.round(agentic.fractional_score * 100) : null);
  const scoreOutOf = lhScore?.out_of ?? 100;
  const scoreNote = lhScore?.note
    || 'Agentic Browsing category — Google\'s 0–100 rating for AI agent readiness (experimental).';
  const scoreCard = scoreValue != null
    ? `<div class="agentic-stat-card">
      <div class="agentic-stat-label">Google Lighthouse agentic score</div>
      <div class="agentic-stat-value">${scoreValue}<span class="agentic-stat-outof">/${scoreOutOf}</span></div>
      <div class="agentic-stat-sublabel">${esc(scoreNote)}</div>
    </div>`
    : '';

  return `
  <div class="section-header">
    <h2>AI Agent Readiness</h2>
    <span class="section-note">${esc(agentic?.source || 'Lighthouse CLI + HTTP fetch')}</span>
  </div>

  <div class="lighthouse-callout">
    <strong>What this measures:</strong> Google Lighthouse now includes an <em>Agentic Browsing</em> category — how well AI assistants (ChatGPT, Gemini, etc.) can read and navigate your site. The <code>llms.txt</code> file is the primary signal: a machine-readable summary of your practice that agents fetch before crawling.
  </div>

  <div class="agentic-status-grid">
    <div class="agentic-stat-card">
      <div class="agentic-stat-label">llms.txt status</div>
      <div class="agentic-stat-value" style="color:${esc(statusColor)}">${esc(statusLabel)}</div>
    </div>
    <div class="agentic-stat-card">
      <div class="agentic-stat-label">Lighthouse checks passing</div>
      <div class="agentic-stat-value">${esc(ratioStr)}</div>
      <div class="agentic-stat-sublabel">How many of the 6 Agentic Browsing audits scored a full pass</div>
    </div>
    ${scoreCard}
  </div>

  ${agentic?.headline ? `<p class="agentic-headline ${status === 'good' ? 'agentic-ok' : 'agentic-warn'}">${esc(agentic.headline)}</p>` : ''}

  ${buildAgenticChecksList(
    agentic?.lighthouse_checks?.length
      ? agentic.lighthouse_checks
      : buildLighthouseChecks(agentic?.audits ? { audits: agentic.audits } : null),
  )}

  ${issues || flagged ? `<div class="agentic-evidence">
    <div class="agentic-evidence-head">llms.txt issues</div>
    ${issues ? `<ul class="agentic-issues">${issues}</ul>` : ''}
    ${flagged ? `<ul class="agentic-issues">${flagged}</ul>` : ''}
  </div>` : ''}

  ${currentExcerpt}
  ${recommended}
  ${verify}
  ${findingNote}

  <p class="source-note">Agentic browsing requires Lighthouse CLI (not PageSpeed Insights API). llms.txt is also fetched directly over HTTP to distinguish missing files from subpar content.</p>`;
}

// ---------------------------------------------------------------------------
// Tab: What We Found (Technical Findings)
// ---------------------------------------------------------------------------

function buildFindingsTab(techAudit, { bronze = null, scraped = null } = {}) {
  if (!techAudit) {
    return `<div class="empty-state"><p>Tech audit data not available.</p></div>`;
  }

  const { findings = [], summary = {} } = techAudit;
  const criticals = findings.filter(f => f.severity === 'critical');
  const warnings  = findings.filter(f => f.severity === 'warning');
  const passed    = findings.filter(f => f.severity === 'passed');

  const renderFinding = (f) => {
    // Determine source citation based on category
    const isPerf = f.category === 'Performance' || f.id?.startsWith('low-') || f.id === 'high-cls';
    const sourceText = isPerf
      ? '(Measured by Google Lighthouse)'
      : '(Detected by crawling your site)';

    const evidenceRows = buildFindingEvidenceRows(f, bronze, scraped);
    const pageEvidenceHtml = evidenceRows
      ? renderFindingEvidenceHtml(evidenceRows, esc, { open: f.severity === 'critical' })
      : '';

    return `
  <div class="finding-card ${esc(f.severity)}">
    <div class="finding-header">
      <div class="finding-icon ${esc(f.severity)}">${esc(severityIcon(f.severity))}</div>
      <div>
        <div class="finding-title">${esc(findingDisplayTitle(f))}</div>
        <div class="finding-meta">${esc(f.category)}</div>
      </div>
    </div>
    <div class="finding-evidence">${esc(f.detail)}</div>
    ${f.benefit ? `<div class="finding-impact">Why this matters to patients: ${esc(f.benefit)}</div>` : ''}
    <div class="finding-source">${esc(sourceText)}</div>
    ${pageEvidenceHtml}
  </div>`;
  };

  return `
  <div class="section-header">
    <h2>What We Found</h2>
    <span class="section-note">Based on crawling your site + Google Lighthouse</span>
  </div>

  <div class="findings-summary">
    <div class="fs-stat"><span class="fs-num critical">${summary.critical || 0}</span><span class="fs-label">Critical issues</span></div>
    <div class="fs-stat"><span class="fs-num warning">${summary.warnings || 0}</span><span class="fs-label">Warnings</span></div>
  </div>

  ${criticals.length > 0 ? `
  <div class="findings-group">
    <div class="findings-group-title critical">Critical Issues (${criticals.length})</div>
    <div class="findings-list">${criticals.map(renderFinding).join('')}</div>
  </div>` : ''}

  ${warnings.length > 0 ? `
  <div class="findings-group">
    <div class="findings-group-title warning">Warnings (${warnings.length})</div>
    <div class="findings-list">${warnings.map(renderFinding).join('')}</div>
  </div>` : ''}

  ${passed.length > 0 ? `
  <div class="findings-group">
    <div class="findings-group-title passed">What's Working (${passed.length})</div>
    <div class="passed-checklist">
      ${passed.map(f => `<div class="passed-item"><span class="passed-check">✓</span><span>${esc(findingDisplayTitle(f))}</span></div>`).join('')}
    </div>
  </div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Tab: Your Messaging (AI Audit)
// ---------------------------------------------------------------------------

function buildAiAuditTab(aiAudit) {
  if (!aiAudit) {
    return `<div class="empty-state"><p>AI content audit was not run.<br>Ensure <code>ANTHROPIC_API_KEY</code> is set to generate positioning recommendations.</p></div>`;
  }

  const pos  = aiAudit.positioning   || {};
  const tone = aiAudit.tone          || {};
  const svc  = aiAudit.serviceEmphasis || {};
  const pageCount = aiAudit.pageCount || '';

  return `
  <div class="section-header">
    <h2>Your Messaging</h2>
    <span class="section-note">Analysis by Claude AI</span>
  </div>

  <div class="ai-source-note">
    <strong>How this analysis works:</strong> We read ${pageCount ? `all ${pageCount} pages of your site` : 'every page of your site'} and analyzed how you're positioned compared to what patients in your area are searching for. This section is <strong>analysis by Claude AI</strong> — not a mechanical score, but a read of your actual content and how it lands on a new visitor.
  </div>

  <div class="ai-grid">

    <div class="ai-block">
      <h4>Positioning</h4>
      <div class="current-tag">Current</div>
      <p style="font-size:13px;line-height:1.55">${esc(pos.current || '—')}</p>
      <div class="rec-tag">Recommended</div>
      <p class="rec-text">${esc(pos.recommended || '—')}</p>
      <p class="rationale">${esc(pos.rationale || '')}</p>
    </div>

    <div class="ai-block">
      <h4>Brand Tone</h4>
      <div class="current-tag">Current</div>
      <p style="font-size:13px;line-height:1.55">${esc(tone.current || '—')}</p>
      <div class="rec-tag">Recommended</div>
      <p class="rec-text">${esc(tone.recommended || '—')}</p>
      <p class="rationale">${esc(tone.rationale || '')}</p>
    </div>

    <div class="ai-block">
      <h4>Service Emphasis</h4>
      <div class="tag-row">
        ${svc.primary ? `<span class="tag-primary">${esc(svc.primary)}</span>` : ''}
        ${(svc.secondary || []).map(s => `<span class="tag-secondary">${esc(s)}</span>`).join('')}
      </div>
      <p class="rationale" style="margin-top:10px">${esc(svc.rationale || '')}</p>
    </div>

    <div class="ai-block">
      <h4>Differentiators Found on Your Site</h4>
      <ul class="bullet-list">
        ${(aiAudit.differentiators || []).map(d => `<li>${esc(d)}</li>`).join('') || '<li style="color:var(--text-dim)">None identified</li>'}
      </ul>
    </div>

    <div class="ai-block">
      <h4>Content Gaps — What's Missing</h4>
      <ul class="bullet-list">
        ${(aiAudit.contentGaps || []).map(g => `<li>${esc(g)}</li>`).join('') || '<li style="color:var(--text-dim)">None identified</li>'}
      </ul>
    </div>

    <div class="ai-block">
      <h4>Search Opportunities</h4>
      <ul class="bullet-list">
        ${(aiAudit.seoOpportunities || []).map(o => `<li>${esc(o)}</li>`).join('') || '<li style="color:var(--text-dim)">None identified</li>'}
      </ul>
    </div>

  </div>`;
}

// ---------------------------------------------------------------------------
// Tab: What We'd Fix
// ---------------------------------------------------------------------------

function buildWhatWedbuildTab(techAudit, aiAudit, scraped, previewUrl) {
  const improvements = deriveImprovements(techAudit, aiAudit);

  // Pull top 3 for Before/After framing
  const topThree = improvements.slice(0, 3);
  const rest     = improvements.slice(3);

  const beforeAfterItems = topThree.map(item => {
    // Generate a before/after based on the finding ID
    const beforeAfterMap = {
      'missing-meta':      { before: 'Search results show just the URL — no description to convince a patient to click.', after: 'Each page has a tailored description in Google results that speaks to what patients are searching for.' },
      'missing-title':     { before: 'Google has no title to show for this page — it falls out of search results entirely.', after: 'Every page has a keyword-rich title that shows up clearly in Google.' },
      'duplicate-titles':  { before: 'Multiple pages have the same title — Google can\'t tell them apart, so none of them rank.', after: 'Every page targets a different search term and competes on its own terms.' },
      'thin-content':      { before: 'Service pages with 100 words — not enough for Google to understand (or rank) what you offer.', after: 'Expanded service pages that answer the questions patients are actually asking.' },
      'low-performance':   { before: 'Your site takes 10+ seconds to load on a phone. Most visitors leave in 3.', after: 'Loads in under 2 seconds on mobile — patients stay long enough to read and book.' },
      'low-lcp':           { before: 'The main content takes 4+ seconds to appear — a blank screen on the most important moment.', after: 'The hero image and headline load instantly, making a strong first impression.' },
      'no-testimonials':   { before: 'No patient reviews on the site — new patients have no social proof to build trust.', after: 'Real patient testimonials woven throughout the site where trust matters most.' },
      'no-faq':            { before: 'No FAQ section — patients can\'t find answers and either call or leave.', after: 'An FAQ section that captures question-based searches and reduces front-desk calls.' },
    };
    const ba = beforeAfterMap[item.id];
    if (!ba) return null;
    return `
    <div class="before-after-block">
      <div class="ba-header">${esc(item.findingTitle || item.id)}</div>
      <div class="ba-row">
        <div class="ba-col">
          <div class="ba-label before">Before</div>
          <div class="ba-content">${esc(ba.before)}</div>
        </div>
        <div class="ba-col">
          <div class="ba-label after">After</div>
          <div class="ba-content">${esc(ba.after)}</div>
        </div>
      </div>
    </div>`;
  }).filter(Boolean).join('');

  const restItems = rest.map(item => `
  <div class="improvement-item">
    <div class="impr-finding-ref ${esc(item.severity)}">${esc(item.severity === 'critical' ? 'Critical fix' : item.severity === 'warning' ? 'Improvement' : 'Enhancement')}${item.findingTitle ? ` — ${item.findingTitle}` : ''}</div>
    <div class="impr-text">${esc(item.msg)}</div>
  </div>`).join('');

  const previewSection = previewUrl ? `
  <div class="preview-block">
    <h3>Your Redesign Preview</h3>
    <p>Here's what your new site could look like — built by Groundwork Dental.</p>
    <a class="preview-btn" href="${esc(previewUrl)}" target="_blank" rel="noopener">
      View Preview →
    </a>
  </div>` : `
  <div class="preview-block">
    <h3>Your Redesign</h3>
    <p>Groundwork Dental builds a custom, SEO-optimized site from your existing content in under 24 hours.</p>
    <a class="preview-btn" href="https://groundworkdental.com" target="_blank" rel="noopener">
      Get Started →
    </a>
  </div>`;

  return `
  <div class="section-header">
    <h2>What We'd Fix</h2>
    <span class="section-note">Every item below is tied to a specific finding above</span>
  </div>

  ${previewSection}

  ${topThree.length > 0 && beforeAfterItems ? `
  <div style="margin-bottom:28px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-dim);margin-bottom:14px">Top 3 changes — before and after</div>
    ${beforeAfterItems}
  </div>` : ''}

  ${rest.length > 0 ? `
  <div style="margin-bottom:24px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-dim);margin-bottom:14px">Additional improvements</div>
    <div class="improvements-list">${restItems}</div>
  </div>` : ''}

  ${improvements.length === 0 ? `<div class="empty-state"><p>Run with a URL to generate personalized improvement recommendations.</p></div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Summary page builder (audit-summary.html)
// ---------------------------------------------------------------------------

function buildSummaryReport({ url, practiceName, pagespeed, techAudit, aiAudit, previewUrl, screenshotFile = null }) {
  const runDate = formatDate(new Date().toISOString());
  const mobile  = pagespeed?.mobile || null;
  // Top of summary: show "we actually looked at your site" — homepage thumb.
  // Path is relative to outputDir (which is where the HTML lives), so the
  // <img src> will resolve when the file is opened locally or hosted.
  const screenshotBlock = screenshotFile ? `
<div class="hero-screenshot">
  <img src="${esc(screenshotFile)}" alt="Homepage of ${esc(practiceName)}" />
  <div class="hero-screenshot-cap">We crawled <strong>${esc(url)}</strong>${techAudit?.findings ? ` and ran ${techAudit.findings.length} checks` : ''}.</div>
</div>` : '';

  const categories = [
    { key: 'performance',   label: 'Mobile Speed',        subtitle: 'How fast your site loads on a phone' },
    { key: 'seo',           label: 'Google Visibility',   subtitle: 'How easily patients can find you' },
    { key: 'accessibility', label: 'Ease of Use',         subtitle: 'Works for all patients, all devices' },
    { key: 'bestPractices', label: 'Technical Health',    subtitle: 'Security & modern standards' },
  ];

  // Score circles (compact, 72px)
  const scoreCircles = categories.map(cat => {
    const score = mobile?.[cat.key] ?? null;
    const color = scoreColor(score);
    const bg    = scoreBg(score);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;min-width:120px">
      <div style="
        width:72px;height:72px;border-radius:50%;
        background:${bg};color:${color};border:3px solid ${color};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        flex-shrink:0;
      ">
        <span style="font-size:20px;font-weight:800;line-height:1">${score != null ? score : '—'}</span>
        <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;opacity:0.7;margin-top:2px">${esc(scoreLabel(score))}</span>
      </div>
      <span style="font-size:11px;font-weight:700;color:var(--ink);text-align:center;line-height:1.3">${esc(cat.label)}</span>
      <span style="font-size:10px;color:var(--text-dim);text-align:center;line-height:1.3;max-width:100px">${esc(cat.subtitle)}</span>
    </div>`;
  }).join('');

  // Critical + warning findings, ordered: critical first, then warnings.
  // Summary shows only the top 5 with a "see all" CTA at the bottom that
  // links to the full audit-report.html (which renders every finding).
  // Past user feedback: 13 rows is too much for a summary; 5 + CTA reads
  // cleaner without losing the credibility of "we found a lot."
  const findings = techAudit?.findings || [];
  const issueFindings = [
    ...findings.filter(f => f.severity === 'critical'),
    ...findings.filter(f => f.severity === 'warning'),
  ];
  const SUMMARY_LIMIT = 5;
  const visibleFindings = issueFindings.slice(0, SUMMARY_LIMIT);
  const hiddenCount     = issueFindings.length - visibleFindings.length;

  // Helper: collapse the /blog//page/3 → /blog/page/3 double-slashes some
  // Sesame-hosted sites emit, so the displayed URL doesn't look like a typo.
  const fixDoubleSlash = (url) => String(url).replace(/(?<!:)\/{2,}/g, '/');

  // Build the paired rows — each row is one issue + the matching change.
  // Visual: 2-column grid, row dividers visually unite the pair.
  const pairedRows = visibleFindings.map(f => {
    const c = f.severity === 'critical'
      ? { icon: '✕', bg: 'var(--danger-bg)', color: 'var(--red)',   label: 'CRITICAL' }
      : { icon: '!', bg: 'var(--warning-bg)', color: 'var(--amber)', label: 'WARNING'  };

    // Affected pages: show the full hyperlinked URL list (up to 10), with
    // overflow rolloff. Earlier we truncated to 3 path-only chips, but that
    // hid the load-bearing insight — when 5 URLs share one title, the
    // duplication only becomes obvious when you see all 5 listed. Full
    // URLs (not just paths) make duplication visible across hosts/blogs.
    const pages = (f.affectedPages || []).slice(0, 10);
    const overflow = (f.affectedPages?.length || 0) - pages.length;
    const exampleHtml = pages.length > 0 ? `
      <div class="pair-found-pages">
        <div class="pair-found-pages-label">Affected page${f.affectedPages.length === 1 ? '' : 's'} (${f.affectedPages.length})</div>
        <ul>
          ${pages.map(u => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(fixDoubleSlash(u))}</a></li>`).join('')}
          ${overflow > 0 ? `<li class="pair-found-pages-more">… and ${overflow} more</li>` : ''}
        </ul>
      </div>` : '';

    // The paired "what we'd change" — 1:1 lookup by finding id.
    const outcome = IMPROVEMENT_OUTCOMES[f.id] || null;
    const outcomeHtml = outcome
      ? `<div class="pair-fix">
           <div class="pair-fix-icon">→</div>
           <div class="pair-fix-text">${esc(outcome)}</div>
         </div>`
      : `<div class="pair-fix pair-fix-none">
           <div class="pair-fix-icon" style="color:var(--text-dim)">·</div>
           <div class="pair-fix-text" style="color:var(--text-dim);font-style:italic">No automated fix — requires manual review.</div>
         </div>`;

    return `<div class="pair-row" style="border-left:3px solid ${c.color}">
      <div class="pair-found">
        <div class="pair-found-header">
          <div class="pair-found-icon" style="background:${c.bg};color:${c.color}">${esc(c.icon)}</div>
          <div class="pair-found-meta">
            <div class="pair-found-title">${esc(findingDisplayTitle(f))}</div>
            <div class="pair-found-severity" style="color:${c.color}">${esc(c.label)}</div>
          </div>
        </div>
        <div class="pair-found-detail">${esc(f.detail)}</div>
        ${exampleHtml}
        ${f.benefit ? `<div class="pair-found-why">${esc(f.benefit)}</div>` : ''}
      </div>
      ${outcomeHtml}
    </div>`;
  }).join('');

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const warningCount  = findings.filter(f => f.severity === 'warning').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Audit Summary — ${esc(practiceName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${sharedCss()}

@page { size: A4; margin: 15mm; }

body {
  background: white;
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 32px 48px;
}

.report-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding-bottom: 20px; border-bottom: 3px solid var(--ink); margin-bottom: 24px;
}
.report-title { font-family: var(--font); font-size: 26px; font-weight: 400; color: var(--charcoal); letter-spacing: -0.3px; line-height: 1.2; }
.report-sub   { font-size: 13px; color: var(--text-dim); margin-top: 4px; line-height: 1.5; }
/* Summary wordmark — same pattern as full report, smaller scale. */
.gw-logo { text-align: right; }
.gw-logo .mark { display: inline-flex; align-items: baseline; gap: 7px; font-size: 15px; }
.gw-logo .mark .word { font-family: var(--font); font-weight: 400; color: var(--charcoal); letter-spacing: -0.2px; }
.gw-logo .mark .divider { width: 1px; height: 11px; background: var(--sage); align-self: center; }
.gw-logo .mark .suffix { font-family: var(--font-ui); font-size: 9px; font-weight: 500; color: var(--sage-dark); letter-spacing: 0.14em; text-transform: uppercase; }
.gw-logo .domain { font-size: 11px; color: var(--mid-gray); margin-top: 4px; font-family: var(--font-ui); }

/* Homepage screenshot — top of summary, proves we looked at the site */
.hero-screenshot {
  margin: -8px 0 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface-2);
}
.hero-screenshot img {
  display: block;
  width: 100%;
  height: auto;
  max-height: 380px;
  object-fit: cover;
  object-position: top center;
}
.hero-screenshot-cap {
  padding: 10px 16px;
  font-size: 12px;
  color: var(--text-dim);
  background: white;
  border-top: 1px solid var(--border);
}
.hero-screenshot-cap strong { color: var(--ink); font-weight: 600; }

/* Lead-magnet CTA — primary conversion path for cold traffic.
   Sage-palette per design system. Surface-2 fill, sage hairline, sage-dark
   button (= .btn-primary spec: white on sage-dark = 5.95:1 AA, vs the AA-failing
   white-on-sage at 4.4:1). This is THE CTA; styled to invite, not shout. */
.lead-magnet-cta {
  background: var(--surface-2);
  border: 1px solid var(--sage);
  border-radius: var(--radius);
  padding: 28px 28px 24px;
  margin-top: 24px;
  text-align: center;
}
.lead-magnet-eyebrow {
  font-family: var(--font-ui);
  font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.14em;
  color: var(--sage-dark); margin-bottom: 10px;
}
.lead-magnet-heading {
  font-family: var(--font);  /* Georgia — design system says prose is serif */
  font-size: 22px; font-weight: 400; color: var(--charcoal); line-height: 1.3;
  letter-spacing: -0.3px; margin-bottom: 10px;
}
.lead-magnet-body {
  font-size: 14px; color: var(--charcoal); line-height: 1.6; max-width: 540px;
  margin: 0 auto 18px;
}
/* Matches .btn-primary spec — sage-dark fill, white text, Figtree 500. */
.lead-magnet-btn {
  display: inline-block;
  background: var(--sage-dark); color: white; text-decoration: none;
  font-family: var(--font-ui);
  font-size: 14px; font-weight: 500; letter-spacing: 0.025em;
  padding: 12px 24px; border-radius: var(--radius);
  white-space: nowrap;
  min-height: 44px; line-height: 20px;
  transition: background-color 200ms;
}
.lead-magnet-btn:hover { background: var(--sage-darker); }
.lead-magnet-btn:focus-visible { outline: 2px solid var(--sage); outline-offset: 2px; }
.lead-magnet-fineprint {
  font-family: var(--font-ui);
  font-size: 11px; color: var(--mid-gray); margin-top: 12px;
}

/* Affected-pages list inside a paired finding row — hyperlinked, scrollable. */
.pair-found-pages { margin-top: 10px; }
.pair-found-pages-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
  color: var(--text-dim); margin-bottom: 4px;
}
.pair-found-pages ul {
  list-style: none; padding: 0; margin: 0;
  background: var(--surface-2); border-radius: 4px; padding: 8px 12px;
  font-family: var(--mono); font-size: 11px; line-height: 1.6;
  max-height: 140px; overflow-y: auto;
}
.pair-found-pages li { padding: 1px 0; }
.pair-found-pages li a {
  color: var(--ink); text-decoration: none; word-break: break-all;
}
.pair-found-pages li a:hover { color: var(--terracotta); text-decoration: underline; }
.pair-found-pages-more { color: var(--text-dim); font-style: italic; }

.scores-section { background: var(--surface-2); border-radius: var(--radius); padding: 24px; margin-bottom: 24px; }
.scores-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.scores-headline { font-family: var(--font); font-size: 18px; font-weight: 400; color: var(--charcoal); letter-spacing: -0.2px; }
.scores-attribution { font-size: 11px; color: var(--text-dim); }
.scores-attribution a { color: var(--blue); }
.score-strip { display: flex; gap: 12px; flex-wrap: wrap; }

.severity-bar { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.sev-badge { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; }
.sev-badge.critical { background: var(--danger-bg); color: var(--red); }
.sev-badge.warning  { background: var(--warning-bg); color: var(--amber); }

.section-title {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
  color: var(--text-dim); margin-bottom: 12px;
  display: flex; align-items: center; gap: 8px;
}
.section-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }

/* Paired rows: each finding sits next to its "what we'd change" outcome
   in the SAME row, so the visual relationship is unambiguous. */
.pair-grid { display: flex; flex-direction: column; gap: 14px; }
.pair-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0;
  background: white; border: 1px solid var(--border);
  border-radius: var(--radius); overflow: hidden;
}
@media (max-width: 560px) { .pair-row { grid-template-columns: 1fr; } }
.pair-found      { padding: 16px 18px; border-right: 1px solid var(--border); }
.pair-fix        { padding: 16px 18px; background: var(--surface-2); display: flex; gap: 10px; align-items: flex-start; }
.pair-fix-icon   { color: var(--terracotta); font-weight: 800; font-size: 16px; flex-shrink: 0; line-height: 1.4; }
.pair-fix-text   { font-size: 13px; line-height: 1.5; color: var(--ink); }

@media (max-width: 560px) {
  .pair-found { border-right: none; border-bottom: 1px solid var(--border); }
}

.pair-found-header { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px; }
.pair-found-icon {
  width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 800; flex-shrink: 0; margin-top: 1px;
}
.pair-found-meta { flex: 1; }
.pair-found-title { font-family: var(--font); font-size: 16px; font-weight: 400; line-height: 1.3; color: var(--charcoal); letter-spacing: -0.1px; }
.pair-found-severity { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; margin-top: 2px; }
.pair-found-detail { font-size: 12px; font-weight: 600; color: var(--ink); line-height: 1.4; }
.pair-found-why { font-size: 11px; color: var(--sage); margin-top: 6px; line-height: 1.4; font-style: italic; }

/* Column headers above the paired rows */
.pair-headers { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin-bottom: 8px; }
@media (max-width: 560px) { .pair-headers { display: none; } }
.pair-header {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
  color: var(--text-dim); padding: 0 18px;
}

.block { background: white; border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }

/* Preview CTA — dark variant per CTABlock spec in /docs/design/DESIGN.md.
   Charcoal panel + on-dark text + sage-dark button (CTABlock 'dark' variant). */
.cta-block {
  background: var(--charcoal); border-radius: var(--radius); padding: 28px 32px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  margin-top: 32px;
}
.cta-left h3 { font-family: var(--font); font-size: 22px; font-weight: 400; color: var(--on-dark); margin-bottom: 6px; letter-spacing: -0.3px; }
.cta-left p  { font-size: 14px; color: var(--on-dark-muted); line-height: 1.5; }
.cta-btn {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--sage-dark); color: white; text-decoration: none;
  font-family: var(--font-ui);
  font-size: 14px; font-weight: 500; letter-spacing: 0.025em;
  padding: 12px 24px; border-radius: var(--radius);
  white-space: nowrap; flex-shrink: 0;
  min-height: 44px; line-height: 20px;
  transition: background-color 200ms;
}
.cta-btn:hover { background: var(--sage-darker); }
.cta-btn:focus-visible { outline: 2px solid var(--sage); outline-offset: 2px; }

.report-footer {
  margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: var(--text-dim);
}

@media print {
  body { padding: 0; }
  .cta-block { display: none; }
  a { text-decoration: none; }
}
</style>
</head>
<body>

<!-- Header -->
<div class="report-header">
  <div>
    <div class="report-title">${esc(practiceName)}</div>
    <div class="report-sub">${esc(url)}<br>Audit generated ${esc(runDate)}</div>
  </div>
  <div class="gw-logo">
    <div class="mark">
      <span class="word">Groundwork</span>
      <span class="divider"></span>
      <span class="suffix">dental</span>
    </div>
    <div class="domain">groundworkdental.com</div>
  </div>
</div>

<!-- Homepage screenshot — proves we actually looked at the site -->
${screenshotBlock}

<!-- Scores -->
${!mobile ? '' : `
<div class="scores-section">
  <div class="scores-top">
    <div class="scores-headline">Your Site Scores</div>
    <div class="scores-attribution">
      Scores measured by Google Lighthouse — an objective tool built into Google Chrome.
      <a href="https://pagespeed.web.dev" target="_blank">Test it yourself →</a>
    </div>
  </div>
  <div class="score-strip">${scoreCircles}</div>

  <!-- Mobile speed breakdown: the visceral detail behind the abstract score.
       Same Lighthouse metrics the full report shows (LCP, FCP, TBT, CLS, SI, TTI). -->
  <div style="margin-top:24px">
    ${buildMobileSpeedBreakdown(mobile)}
  </div>
</div>
`}

<!-- Issue count -->
${(criticalCount > 0 || warningCount > 0) ? `
<div class="severity-bar">
  ${criticalCount > 0 ? `<div class="sev-badge critical">✕ ${criticalCount} critical issue${criticalCount !== 1 ? 's' : ''}</div>` : ''}
  ${warningCount > 0  ? `<div class="sev-badge warning">! ${warningCount} warning${warningCount !== 1 ? 's' : ''}</div>` : ''}
</div>` : ''}

<!-- Paired Findings + Changes — each finding sits next to its corresponding fix -->
${issueFindings.length > 0 ? `
<div class="pair-headers">
  <div class="pair-header">What We Found</div>
  <div class="pair-header">What We'd Change</div>
</div>
<div class="pair-grid">
  ${pairedRows}
</div>
<!-- Lead-magnet CTA — the ONE conversion path for cold traffic.
     Email opt-in unlocks the full report (every issue, not just top 5)
     PLUS a redesigned preview of their homepage. The full report at
     audits/<slug>/audit-report is intentionally NOT linked here — it's
     the carrot we trade for the email. -->
<div class="lead-magnet-cta">
  <div class="lead-magnet-eyebrow">Want the full picture?</div>
  <div class="lead-magnet-heading">Get the complete report${hiddenCount > 0 ? ` — all ${issueFindings.length} issues` : ''} + a free redesigned preview of your homepage</div>
  <div class="lead-magnet-body">
    We'll send the full breakdown across SEO, page speed, accessibility, Google Business Profile, and conversion tracking — plus a working preview of your site, rebuilt with the fixes applied. Sent to your inbox in under 24 hours.
  </div>
  <a class="lead-magnet-btn" href="#get-full-report">Get my full report + free preview →</a>
  <div class="lead-magnet-fineprint">No commitment. We build the preview from your existing content — no intake form needed.</div>
</div>
` : `
<div style="background:var(--success-bg);border:1px solid var(--success-bg);border-radius:var(--radius);padding:18px;font-size:13px;color:var(--ink);text-align:center">
  ✓ No critical or warning issues found — the site is in good shape.
</div>
`}

<!-- Preview CTA — only shown when a real redesigned preview has been built
     (post-publish). For cold traffic with no preview yet, the lead-magnet
     CTA above is the sole conversion path; we don't show a generic
     "Get Started" button that competes with it. -->
${previewUrl ? `
<div class="cta-block">
  <div class="cta-left">
    <h3>See your redesign</h3>
    <p>Built from your existing content — no intake form needed.</p>
  </div>
  <a class="cta-btn" href="${esc(previewUrl)}" target="_blank" rel="noopener">
    View Preview →
  </a>
</div>` : ''}

<!-- Footer -->
<div class="report-footer">
  <span>Generated by Groundwork Dental · groundworkdental.com</span>
  <span>${esc(runDate)}</span>
</div>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate both audit reports and write them to outputDir.
 *
 * @param {string} outputDir
 * @param {object} opts
 * @param {string}        opts.url
 * @param {string}        opts.practiceName
 * @param {object|null}   opts.pagespeed    - { mobile, desktop } from runPageSpeed
 * @param {object|null}   opts.techAudit    - from runTechAudit
 * @param {object|null}   opts.aiAudit      - from runSiteAudit
 * @param {object|null}   opts.scraped      - silver data
 * @param {string|null}   opts.previewUrl   - URL to preview (if any)
 */
export async function generateAuditReports(outputDir, {
  url = '',
  practiceName = 'Site Audit',
  pagespeed = null,
  techAudit = null,
  aiAudit = null,
  scraped = null,
  previewUrl = null,
  findingsSummary = null,
  gbpMeta = null,
  diff = null,
  outputFilename = null,
  screenshotFile = null,
  bronze = null,
  auditData = null,
  vendor = null,
  agenticBrowsing = null,
  dataDir = null,
  slug = null,
  leadApiUrl = null,
  auditPageUrl = null,
  precall = false,
  existingAgentic = null,
  citability = null,
} = {}) {
  await mkdir(outputDir, { recursive: true });

  let shared = { url, practiceName, pagespeed, techAudit, aiAudit, scraped, previewUrl, findingsSummary, gbpMeta, diff, screenshotFile, existingAgentic, agenticBrowsing: null, bronze };

  const baseName = outputFilename || (diff ? 'audit-report-after' : 'audit-report');
  const isAfterOnly = baseName === 'audit-report-after';

  // Audit pages are served from the same origin as the lead-capture Pages
  // Function (the groundwork-reports project) — relative URL, no CORS.
  const resolvedLeadApiUrl = leadApiUrl || '/api/audit-preview-request';

  const writes = [];
  let resolvedAuditData = auditData;
  let auditDataPath = resolve(outputDir, 'audit-data.json');
  let summaryPath = resolve(outputDir, 'audit-summary.html');
  let buildSpecPath = resolve(outputDir, 'build-spec.html');

  if (!isAfterOnly) {
    const slugFromOpts = slug || resolvedAuditData?.meta?.slug || '';
    resolvedAuditData = auditData || assembleAuditData({
      url,
      slug: slugFromOpts,
      bronze,
      pagespeed,
      findings: techAudit?.findings || [],
      scraped,
      aiAudit,
      findingsSummary,
      vendor,
      agenticBrowsing,
      citability,
    });

    const auditDataJson = JSON.stringify(resolvedAuditData, null, 2);
    writes.push(writeFile(auditDataPath, auditDataJson, 'utf-8'));
    if (dataDir) {
      await mkdir(dataDir, { recursive: true });
      writes.push(writeFile(resolve(dataDir, 'audit-data.json'), auditDataJson, 'utf-8'));
    }

    const summaryHtml = renderSalesAudit(resolvedAuditData, { leadApiUrl: resolvedLeadApiUrl });
    const buildSpecHtml = renderBuildSpec(resolvedAuditData);
    summaryPath = resolve(outputDir, 'audit-summary.html');
    buildSpecPath = resolve(outputDir, 'build-spec.html');
    writes.push(
      writeFile(summaryPath, summaryHtml, 'utf-8'),
      writeFile(buildSpecPath, buildSpecHtml, 'utf-8'),
    );

    shared = { ...shared, agenticBrowsing: resolvedAuditData?.agentic_browsing || null };

    if (precall) {
      const { renderPrecallBrief } = await import('./precall-audit-renderer.js');
      const precallPath = resolve(outputDir, 'precall-brief.html');
      writes.push(writeFile(precallPath, renderPrecallBrief(resolvedAuditData), 'utf-8'));
    }
  }

  if (isAfterOnly && agenticBrowsing && !shared.agenticBrowsing) {
    shared = {
      ...shared,
      agenticBrowsing: buildAgenticBrowsing(agenticBrowsing, techAudit?.findings || []),
    };
  }

  const fullHtml = buildFullReport(shared);
  const fullPath = resolve(outputDir, `${baseName}.html`);
  writes.push(writeFile(fullPath, fullHtml, 'utf-8'));

  await Promise.all(writes);

  if (!isAfterOnly) {
    console.log(`[AuditReport] Written: ${auditDataPath}`);
    console.log(`[AuditReport] Written: ${summaryPath}`);
    console.log(`[AuditReport] Written: ${buildSpecPath}`);
  }
  console.log(`[AuditReport] Written: ${fullPath}`);

  const precallPath = !isAfterOnly && precall ? resolve(outputDir, 'precall-brief.html') : null;
  if (precallPath && !isAfterOnly) {
    console.log(`[AuditReport] Written: ${precallPath}`);
  }

  return { fullPath, summaryPath, buildSpecPath, auditDataPath, precallPath, auditData: resolvedAuditData };
}
