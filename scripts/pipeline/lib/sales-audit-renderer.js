/**
 * Client sales one-pager — renders audit-data.json (groundwork-audit/v1).
 * Output: audit-summary.html (hosted at /audits/<slug>/).
 */

import { renderFindingEvidenceHtml } from './finding-evidence.js';

const SALES_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --sage: #5F7F6B; --sage-dark: #4A6B55; --sage-darker: #3D5A48; --sage-tint: #EBF0EC;
    --charcoal: #334155; --mid-gray: #64748B; --border-light: #E0DDD5;
    --surface-1: #FFFFFF; --surface-2: #F8F8F3;
    --on-dark: #E7EBF0; --on-dark-muted: #AAB4C2;
    --danger: #B42318; --warning: #92400E;
    --radius: 4px;
    --font: Georgia, "Times New Roman", serif;
    --font-ui: Figtree, "Helvetica Neue", Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: var(--font); background: var(--surface-2); color: var(--charcoal); font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .sheet { max-width: 940px; margin: 0 auto; background: var(--surface-1); padding: 44px 56px 52px; }
  @media (max-width: 700px) { .sheet { padding: 28px 22px 36px; } }
  .masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 22px; border-bottom: 1px solid var(--border-light); margin-bottom: 30px; }
  .doc-type { font-family: var(--font-ui); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.16em; color: var(--sage-dark); margin-bottom: 12px; }
  .subject { font-size: 30px; font-weight: 400; letter-spacing: -0.4px; line-height: 1.1; }
  .subject-url { display: inline-block; font-family: var(--font-ui); font-size: 13px; color: var(--mid-gray); text-decoration: none; margin-top: 7px; }
  .subject-url:hover { color: var(--sage-dark); }
  .masthead-by { text-align: right; flex-shrink: 0; padding-top: 2px; }
  .by-label { font-family: var(--font-ui); font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.12em; color: var(--mid-gray); margin-bottom: 7px; }
  .gw-mark { display: inline-flex; align-items: baseline; gap: 7px; }
  .gw-mark .word { font-family: var(--font); font-size: 15px; color: var(--charcoal); letter-spacing: -0.2px; }
  .gw-mark .divider { width: 1px; height: 11px; background: var(--sage); align-self: center; }
  .gw-mark .suffix { font-family: var(--font-ui); font-size: 9px; font-weight: 500; color: var(--sage-dark); letter-spacing: 0.14em; text-transform: uppercase; }
  .gw-domain { font-family: var(--font-ui); font-size: 11px; color: var(--mid-gray); margin-top: 4px; }
  .by-date { font-family: var(--font-ui); font-size: 11px; color: var(--mid-gray); margin-top: 4px; }
  .headline { font-size: 24px; font-weight: 400; line-height: 1.25; letter-spacing: -0.3px; margin-top: 34px; margin-bottom: 16px; }
  .headline em { font-style: italic; }
  .headline strong { font-weight: 700; }
  .scorecard { margin-top: 4px; border: 1px solid var(--border-light); border-radius: var(--radius); overflow: hidden; }
  .scorecard-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 11px 20px; background: var(--surface-2); border-bottom: 1px solid var(--border-light); }
  .scorecard-head .lbl { font-family: var(--font-ui); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--charcoal); }
  .scorecard-head .attr { font-family: var(--font-ui); font-size: 11px; color: var(--mid-gray); }
  .scorecard-head .attr a { color: var(--sage-dark); text-decoration: none; font-weight: 500; }
  .gauges { display: grid; grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 620px) { .gauges { grid-template-columns: 1fr 1fr; } }
  .gauge { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 20px 10px 18px; border-right: 1px solid var(--border-light); }
  .gauge:last-child { border-right: none; }
  @media (max-width: 620px) { .gauge:nth-child(2) { border-right: none; } .gauge:nth-child(1), .gauge:nth-child(2) { border-bottom: 1px solid var(--border-light); } }
  .gauge .gname { font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--charcoal); text-align: center; }
  .gauge .gdesc { font-family: var(--font-ui); font-size: 10px; color: var(--mid-gray); text-align: center; line-height: 1.3; max-width: 112px; }
  .scan-stats { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--border-light); border-radius: var(--radius); overflow: hidden; margin-top: 10px; margin-bottom: 0; }
  @media (max-width: 560px) { .scan-stats { grid-template-columns: 1fr; } }
  .scan-stat { padding: 14px 16px; border-right: 1px solid var(--border-light); text-align: center; }
  .scan-stat:last-child { border-right: none; }
  @media (max-width: 560px) { .scan-stat { border-right: none; border-bottom: 1px solid var(--border-light); } .scan-stat:last-child { border-bottom: none; } }
  .scan-stat .n { font-family: var(--mono); font-size: 22px; font-weight: 600; color: var(--charcoal); line-height: 1; }
  .scan-stat .n.flag { color: var(--danger); }
  .scan-stat .l { font-family: var(--font-ui); font-size: 11px; color: var(--mid-gray); margin-top: 6px; line-height: 1.3; }
  .agentic-line { font-family: var(--font-ui); font-size: 13px; line-height: 1.5; color: var(--charcoal); margin-top: 14px; padding: 12px 16px; background: var(--surface-2); border: 1px solid var(--border-light); border-radius: var(--radius); }
  .agentic-line.warn { background: #FCF4E8; border-color: #E8D4A8; color: var(--warning); }
  .agentic-line.ok { background: var(--sage-tint); border-color: var(--sage); color: var(--sage-darker); }
  .llms-evidence { margin-top: 12px; border: 1px solid var(--border-light); border-radius: var(--radius); overflow: hidden; }
  .llms-evidence-head { font-family: var(--font-ui); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 10px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border-light); color: var(--mid-gray); }
  .llms-issues { padding: 12px 14px; font-family: var(--font-ui); font-size: 13px; line-height: 1.5; }
  .llms-issues li { margin: 0 0 6px 1.1em; }
  .llms-pre { margin: 0; padding: 12px 14px; font-family: var(--mono); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: #FAFAF8; color: var(--charcoal); max-height: 220px; overflow: auto; }
  .llms-pre.good { background: var(--sage-tint); }
  .llms-verify { font-family: var(--font-ui); font-size: 11px; padding: 8px 14px 12px; color: var(--mid-gray); }
  .llms-verify a { color: var(--sage-dark); }
  .finding { padding: 20px 0; border-bottom: 1px solid var(--border-light); }
  .finding-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .finding-num { font-family: var(--mono); font-size: 12px; color: var(--sage); }
  .finding-cat { font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--charcoal); }
  .finding-badge { margin-left: auto; font-family: var(--mono); font-size: 16px; font-weight: 600; color: var(--danger); white-space: nowrap; }
  .finding-badge.amber { color: var(--warning); }
  .finding-badge .lbl { font-family: var(--font-ui); font-size: 11px; font-weight: 500; color: var(--mid-gray); margin-left: 4px; }
  .finding-status { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-ui); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--danger); background: #FCF1EF; border-radius: 9999px; padding: 4px 12px; white-space: nowrap; }
  .finding-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
  .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--border-light); border-radius: var(--radius); overflow: hidden; }
  @media (max-width: 560px) { .compare { grid-template-columns: 1fr; } }
  .compare-side { padding: 13px 16px; }
  .compare-now { background: #FCF1EF; }
  .compare-good { background: var(--sage-tint); border-left: 1px solid var(--border-light); }
  @media (max-width: 560px) { .compare-good { border-left: none; border-top: 1px solid var(--border-light); } }
  .compare-label { display: flex; align-items: center; gap: 6px; font-family: var(--font-ui); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; }
  .compare-now .compare-label { color: var(--danger); }
  .compare-good .compare-label { color: var(--sage-dark); }
  .compare-text { font-family: var(--font-ui); font-size: 13.5px; line-height: 1.45; color: var(--charcoal); }
  .evidence { margin-top: 8px; }
  .evidence summary { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--sage-dark); cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 0; }
  .evidence summary::-webkit-details-marker { display: none; }
  .evidence summary::before { content: '+'; font-family: var(--mono); font-size: 13px; color: var(--sage); }
  .evidence[open] summary::before { content: '–'; }
  .evidence-table { margin-top: 8px; border: 1px solid var(--border-light); border-radius: var(--radius); overflow: hidden; }
  .evidence-scroll { max-height: 224px; overflow-y: auto; }
  .evidence-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0; font-family: var(--mono); font-size: 11.5px; border-bottom: 1px solid var(--border-light); }
  .evidence-row:last-child { border-bottom: none; }
  .evidence-row.head { background: var(--surface-2); position: sticky; top: 0; z-index: 1; }
  .evidence-row.head span { font-family: var(--font-ui); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--mid-gray); }
  .evidence-row span { padding: 8px 12px; word-break: break-all; }
  .evidence-row .url { border-right: 1px solid var(--border-light); }
  .evidence-row .url a { color: var(--sage-dark); text-decoration: none; }
  .evidence-row .url a:hover { text-decoration: underline; }
  .evidence-row .val { color: var(--charcoal); }
  .evidence-row.head span:first-child { border-right: 1px solid var(--border-light); }
  .evidence-foot { font-family: var(--font-ui); font-size: 11px; color: var(--mid-gray); padding: 7px 12px; background: var(--surface-2); border-top: 1px solid var(--border-light); }
  @media (max-width: 560px) { .evidence-row { grid-template-columns: 1fr; } .evidence-row .url { border-right: none; border-bottom: 1px dashed var(--border-light); } .evidence-row.head span:first-child { border-right: none; } }
  .finding-page-evidence { margin-top: 12px; border: 1px solid var(--border-light); border-radius: var(--radius); overflow: hidden; }
  .finding-page-evidence summary { cursor: pointer; padding: 10px 14px; font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--sage-dark); list-style: none; }
  .finding-page-evidence summary::-webkit-details-marker { display: none; }
  .page-evidence-card { padding: 12px 14px; border-bottom: 1px solid var(--border-light); }
  .page-evidence-card:last-child { border-bottom: none; }
  .page-evidence-path { font-size: 12px; font-weight: 700; font-family: var(--mono); color: var(--sage-dark); text-decoration: none; display: inline-block; margin-bottom: 8px; }
  .page-evidence-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .pe-side { border-radius: 4px; padding: 8px 10px; font-size: 12px; line-height: 1.45; }
  .pe-side.pe-now { background: #FCF4E8; border: 1px solid #E8D4A8; }
  .pe-side.pe-good { background: var(--sage-tint); border: 1px solid var(--sage); }
  .pe-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; color: var(--mid-gray); }
  .page-evidence-foot { font-size: 11px; color: var(--mid-gray); padding: 7px 12px; background: var(--surface-2); border-top: 1px solid var(--border-light); }
  @media (max-width: 560px) { .page-evidence-compare { grid-template-columns: 1fr; } }
  .offer { background: var(--charcoal); border-radius: var(--radius); padding: 38px; margin-top: 34px; text-align: center; }
  .offer-headline { font-size: 26px; font-weight: 400; line-height: 1.3; letter-spacing: -0.3px; color: var(--on-dark); margin-bottom: 12px; }
  .offer-headline em { font-style: italic; color: #fff; }
  .offer-body { font-family: var(--font-ui); font-size: 14px; line-height: 1.6; color: var(--on-dark-muted); max-width: 500px; margin: 0 auto 22px; }
  .offer-btn { display: inline-block; background: var(--sage-dark); color: #fff; text-decoration: none; font-family: var(--font-ui); font-size: 14px; font-weight: 500; letter-spacing: 0.025em; padding: 13px 28px; border-radius: var(--radius); min-height: 44px; line-height: 20px; }
  .offer-btn:hover { background: var(--sage-darker); }
  .offer-fineprint { font-family: var(--font-ui); font-size: 12px; color: var(--on-dark-muted); margin-top: 14px; }
  .offer-btn { cursor: pointer; border: none; font-family: inherit; }
  .preview-panel { display: none; margin-top: 28px; text-align: left; max-width: 480px; margin-left: auto; margin-right: auto; }
  .preview-panel.is-open { display: block; }
  .preview-panel label { display: block; font-family: var(--font-ui); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--on-dark-muted); margin-bottom: 6px; }
  .preview-panel input, .preview-panel textarea, .preview-panel select {
    width: 100%; font-family: var(--font-ui); font-size: 14px; padding: 10px 12px; border-radius: var(--radius);
    border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: var(--on-dark); margin-bottom: 14px;
  }
  .preview-panel input::placeholder, .preview-panel textarea::placeholder { color: rgba(231,235,240,0.45); }
  .preview-panel textarea { min-height: 88px; resize: vertical; }
  .hp { position: absolute; left: -9999px; opacity: 0; pointer-events: none; }
  .preview-submit { width: 100%; margin-top: 4px; }
  .preview-status { font-family: var(--font-ui); font-size: 13px; margin-top: 12px; min-height: 1.2em; }
  .preview-status.ok { color: #b8e0c8; }
  .preview-status.err { color: #f5c4c0; }
  .preview-thanks { display: none; text-align: center; }
  .preview-thanks.is-visible { display: block; }
  .preview-thanks h3 { font-size: 22px; color: var(--on-dark); margin-bottom: 10px; font-weight: 400; }
  .preview-thanks p { font-family: var(--font-ui); font-size: 14px; color: var(--on-dark-muted); line-height: 1.55; }
  .offer.is-submitted .offer-default { display: none; }
  .vendor-card { margin-top: 28px; border: 1px solid var(--border-light); border-radius: var(--radius); padding: 18px 20px; background: var(--surface-2); }
  .vendor-card h3 { font-family: var(--font-ui); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--mid-gray); margin-bottom: 8px; }
  .vendor-name { font-size: 18px; font-weight: 400; margin-bottom: 6px; }
  .vendor-tco { font-family: var(--font-ui); font-size: 13.5px; line-height: 1.5; color: var(--charcoal); }
  .vendor-tco em { font-style: normal; color: var(--danger); font-weight: 600; }
  .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--border-light); font-family: var(--font-ui); font-size: 11px; color: var(--mid-gray); }
  @media print { body { background: #fff; } .sheet { padding: 0; max-width: none; } .offer { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .finding, .offer { page-break-inside: avoid; } }
  @media (max-width: 620px) { .headline { font-size: 23px; } .masthead { flex-direction: column; gap: 18px; } .masthead-by { text-align: left; } .subject { font-size: 26px; } }
`;

/**
 * @param {object} data - groundwork-audit/v1 document
 * @param {object} [opts]
 * @param {string} [opts.fullReportHref] - link to deep-dive report
 */
export function renderSalesAudit(data, opts = {}) {
  const meta = data.meta || {};
  const scan = data.scan || {};
  const lh = data.lighthouse || {};
  const agentic = data.agentic_browsing || {};
  const summaryFindings = (data.findings || [])
    .filter(f => f.show_in_summary)
    .sort((a, b) => (a.summary_rank || 99) - (b.summary_rank || 99));

  const audience = meta.audience_noun || 'patients';
  const issueCount = summaryFindings.length;
  const siteUrl = meta.source_url || `https://${meta.url}`;
  const formattedDate = formatDisplayDate(meta.generated_at);
  // Same origin as the reports site's Pages Function — relative, no CORS.
  const leadApiUrl = opts.leadApiUrl || '/api/audit-preview-request';
  const slug = meta.slug || '';
  const vendor = data.vendor || {};
  const tco = vendor.subscription_tco;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>For ${esc(meta.business_name)} — Groundwork</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${SALES_CSS}</style>
</head>
<body>
<div class="sheet">

  <header class="masthead">
    <div class="masthead-main">
      <div class="doc-type">Website Audit</div>
      <h1 class="subject">${esc(meta.business_name)}</h1>
      <a class="subject-url" href="${esc(siteUrl)}" target="_blank" rel="noopener">${esc(meta.url)}</a>
    </div>
    <div class="masthead-by">
      <div class="by-label">Prepared by</div>
      <div class="gw-mark"><span class="word">Groundwork</span><span class="divider"></span><span class="suffix">dental</span></div>
      <div class="gw-domain">hello@groundworkdental.com</div>
      <div class="by-date">${esc(formattedDate)}</div>
    </div>
  </header>

  <div class="scorecard">
    <div class="scorecard-head">
      <div class="lbl">Your site, scored by Google Lighthouse</div>
      <div class="attr"><a href="${esc(lh.verify_url || 'https://pagespeed.web.dev')}" target="_blank" rel="noopener">Verify it yourself at pagespeed.web.dev →</a></div>
    </div>
    <div class="gauges">
      ${(lh.consumer_scores || []).map(g => renderGauge(g)).join('')}
    </div>
  </div>

  <div class="scan-stats">
    <div class="scan-stat"><div class="n">${esc(scan.pages_crawled)}</div><div class="l">Pages crawled</div></div>
    <div class="scan-stat"><div class="n">${esc(scan.images_checked)}</div><div class="l">Images checked</div></div>
    <div class="scan-stat"><div class="n flag">${esc(scan.issues_found)}</div><div class="l">Issues found</div></div>
  </div>

  ${agentic.headline ? `<p class="agentic-line ${agentic.llms_txt_status === 'good' ? 'ok' : 'warn'}">${esc(agentic.headline)}</p>` : ''}

  ${vendor.id && vendor.id !== 'unknown' ? `
  <div class="vendor-card">
    <h3>Current website provider</h3>
    <div class="vendor-name">${esc(vendor.display_name || vendor.id)}</div>
    ${tco ? `<p class="vendor-tco">${esc(tco.copy)} <em>That's money you don't own.</em></p>` : `<p class="vendor-tco">Provider category: ${esc((vendor.category || '').replace(/-/g, ' '))}.</p>`}
  </div>` : ''}

  <h2 class="headline"><strong>${issueCount} issue${issueCount === 1 ? '' : 's'}</strong> that could be standing between you and <em>more ${esc(audience)}</em>.</h2>

  ${summaryFindings.map((f, i) => renderFinding(f, i + 1)).join('')}

  <div class="offer" id="preview-offer">
    <div class="offer-default">
      <h2 class="offer-headline">See your site <em>redesigned</em>. For free.</h2>
      <p class="offer-body">Request your full audit write-up and a live preview of your redesigned site.<br>We'll email it within 24 hours — no sales call required.</p>
      <button type="button" class="offer-btn" id="preview-open-btn">Get my full audit + site preview →</button>
      <div class="offer-fineprint">We'll only use your details to send your audit and preview.</div>
      <div class="preview-panel" id="preview-panel">
        <form id="preview-form" novalidate>
          <input class="hp" type="text" name="company_website" tabindex="-1" autocomplete="off" aria-hidden="true">
          <label for="pf-name">Your name</label>
          <input id="pf-name" name="name" type="text" required autocomplete="name" placeholder="Dr. Jane Smith">
          <label for="pf-email">Email</label>
          <input id="pf-email" name="email" type="email" required autocomplete="email" placeholder="you@practice.com">
          <label for="pf-phone">Phone <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
          <input id="pf-phone" name="phone" type="tel" autocomplete="tel" placeholder="(555) 555-5555">
          <label for="pf-role">Your role <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
          <select id="pf-role" name="role">
            <option value="">Select…</option>
            <option value="Owner / Dentist">Owner / Dentist</option>
            <option value="Office Manager">Office Manager</option>
            <option value="Marketing">Marketing</option>
            <option value="Other">Other</option>
          </select>
          <label for="pf-message">Anything we should know? <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
          <textarea id="pf-message" name="message" placeholder="e.g. We're planning a rebrand this fall…"></textarea>
          <button type="submit" class="offer-btn preview-submit" id="preview-submit-btn">Send my request →</button>
          <div class="preview-status" id="preview-status" role="status" aria-live="polite"></div>
        </form>
      </div>
    </div>
    <div class="preview-thanks" id="preview-thanks">
      <h3>You're on the list.</h3>
      <p>We'll email your full audit and a link to your redesigned site preview within 24 hours.<br>Watch for a message from hello@groundworkdental.com.</p>
    </div>
  </div>

  <footer class="footer">
    <span>Groundwork Dental · groundworkdental.com</span>
    <span>hello@groundworkdental.com</span>
  </footer>

</div>
<script>
(function () {
  const API_URL = ${JSON.stringify(leadApiUrl)};
  const SLUG = ${JSON.stringify(slug)};
  const PRACTICE_NAME = ${JSON.stringify(meta.business_name || '')};
  const PRACTICE_URL = ${JSON.stringify(siteUrl)};
  const openBtn = document.getElementById('preview-open-btn');
  const panel = document.getElementById('preview-panel');
  const form = document.getElementById('preview-form');
  const statusEl = document.getElementById('preview-status');
  const offer = document.getElementById('preview-offer');
  const thanks = document.getElementById('preview-thanks');
  const submitBtn = document.getElementById('preview-submit-btn');

  openBtn?.addEventListener('click', function () {
    panel?.classList.add('is-open');
    document.getElementById('pf-name')?.focus();
  });

  form?.addEventListener('submit', async function (e) {
    e.preventDefault();
    statusEl.textContent = '';
    statusEl.className = 'preview-status';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const fd = new FormData(form);
    const payload = {
      slug: SLUG,
      name: fd.get('name'),
      email: fd.get('email'),
      phone: fd.get('phone') || undefined,
      role: fd.get('role') || undefined,
      message: fd.get('message') || undefined,
      company_website: fd.get('company_website') || '',
      practiceName: PRACTICE_NAME,
      practiceUrl: PRACTICE_URL,
      auditPageUrl: window.location.href,
    };

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        throw new Error((data.errors && data.errors[0]) || 'Request failed');
      }
      offer.classList.add('is-submitted');
      thanks.classList.add('is-visible');
    } catch (err) {
      statusEl.textContent = err.message || 'Something went wrong. Email hello@groundworkdental.com.';
      statusEl.className = 'preview-status err';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send my request →';
    }
  });
})();
</script>
</body>
</html>`;
}

function renderGauge(g) {
  const score = g.score ?? 0;
  const stroke = g.status === 'good' ? '#4A6B55' : '#92400E';
  const circumference = 195;
  const offset = Math.round(circumference * (1 - Math.min(100, Math.max(0, score)) / 100));
  const display = g.score != null ? g.score : '—';

  return `<div class="gauge">
    <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
      <circle cx="36" cy="36" r="31" fill="none" stroke="#E0DDD5" stroke-width="6"/>
      <circle cx="36" cy="36" r="31" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 36 36)"/>
      <text x="36" y="42" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="600" fill="#334155">${esc(display)}</text>
    </svg>
    <span class="gname">${esc(g.label)}</span>
    <span class="gdesc">${esc(g.desc)}</span>
  </div>`;
}

function renderFinding(f, num) {
  const m = f.measurement || {};
  const badge = m.type === 'status'
    ? `<span class="finding-status">${esc(m.value)}</span>`
    : `<span class="finding-badge${m.tone === 'warning' ? ' amber' : ''}">${esc(m.value)}<span class="lbl">${esc(m.label || '')}</span></span>`;

  const evidence = f.evidence_rows?.rows?.length
    ? renderEvidence(f.evidence_rows)
    : '';
  const llmsBlock = f.llms_evidence ? renderLlmsFindingEvidence(f.llms_evidence) : '';

  return `<div class="finding">
    <div class="finding-head">
      <span class="finding-num">${String(num).padStart(2, '0')}</span>
      <span class="finding-cat">${esc(f.category)}</span>
      ${badge}
    </div>
    <div class="compare">
      <div class="compare-side compare-now">
        <div class="compare-label">✕ Now</div>
        <div class="compare-text">${esc(f.consumer?.now || '')}</div>
      </div>
      <div class="compare-side compare-good">
        <div class="compare-label">✓ What good looks like</div>
        <div class="compare-text">${esc(f.consumer?.good || '')}</div>
      </div>
    </div>
    ${llmsBlock}
    ${evidence}
  </div>`;
}

function renderLlmsFindingEvidence(ev, opts = {}) {
  if (!ev || (ev.status !== 'absent' && ev.status !== 'poor')) return '';

  const issues = (ev.issues || []).map(i => `<li>${esc(i)}</li>`).join('');
  const flagged = (ev.flagged_lines || []).slice(0, 4).map(f =>
    `<li><code>${esc(f.line)}</code> — ${esc(f.reason)}</li>`
  ).join('');

  const current = ev.current_excerpt
    ? `<details class="evidence" open>
        <summary>What your llms.txt looks like today</summary>
        <pre class="llms-pre">${esc(ev.current_excerpt)}</pre>
      </details>`
    : `<p class="llms-verify">No file found at <a href="${esc(ev.verify_url || '')}" target="_blank" rel="noopener">${esc(ev.verify_url || '/llms.txt')}</a></p>`;

  const recommended = ev.recommended_excerpt
    ? `<details class="evidence">
        <summary>What good looks like (Groundwork rebuild)</summary>
        <pre class="llms-pre good">${esc(ev.recommended_excerpt)}</pre>
      </details>`
    : '';

  const verify = ev.verify_url
    ? `<p class="llms-verify">Verify yourself: <a href="${esc(ev.verify_url)}" target="_blank" rel="noopener">${esc(ev.verify_url)}</a>${ev.lighthouse_note ? ` · Lighthouse: ${esc(ev.lighthouse_note)}` : ''}</p>`
    : '';

  const head = opts.compact ? '' : '<div class="llms-evidence-head">llms.txt evidence</div>';

  return `<div class="llms-evidence">
    ${head}
    ${issues ? `<ul class="llms-issues">${issues}</ul>` : ''}
    ${flagged ? `<ul class="llms-issues">${flagged}</ul>` : ''}
    ${current}
    ${recommended}
    ${verify}
  </div>`;
}

function renderEvidence(er) {
  return renderFindingEvidenceHtml(er, esc, { open: false });
}

function formatDisplayDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return iso || '';
  }
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
