/**
 * Assembles groundwork-audit/v1 JSON — single source of truth for audit renders.
 */

import { getCatalogEntry } from '../findings-catalog.js';
import {
  CATEGORY_LABELS,
  WORKSTREAMS,
  SUMMARY_EXCLUDE,
  CUSTOMER_IMPACT,
  CONSUMER_COPY,
  BUILD_HINTS,
} from './audit-data-copy.js';
import { previewLlmsTxt } from './generate-llms-txt.js';
import { buildFindingEvidenceRows } from './finding-evidence.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPELINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readClientLlmsTxt(slug) {
  if (!slug) return null;
  const p = join(PIPELINE_ROOT, 'clients', slug, 'public', 'llms.txt');
  if (!existsSync(p)) return null;
  try {
    const text = readFileSync(p, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

const SCHEMA = 'groundwork-audit/v1';
const MAX_SUMMARY = 5;
/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {object|null} opts.bronze
 * @param {object|null} opts.pagespeed
 * @param {object[]} opts.findings - enriched findings (all severities)
 * @param {object|null} opts.scraped - silver / merged practice data
 * @param {object|null} opts.aiAudit
 * @param {object|null} opts.findingsSummary
 * @param {object|null} opts.vendor - from buildVendorBlock()
 * @param {object|null} opts.agenticBrowsing - from runAgenticScan().meta
 */
export function assembleAuditData(opts) {
  const {
    url,
    slug = '',
    bronze = null,
    pagespeed = null,
    findings = [],
    scraped = null,
    aiAudit = null,
    findingsSummary = null,
    vendor = null,
    agenticBrowsing = null,
    citability = null,
    recommendedLlmsTxt: recommendedLlmsTxtOpt = null,
  } = opts;

  const practiceName = scraped?.practice?.name || hostnameLabel(url);
  const city = scraped?.address?.city || '';
  const audienceNoun = 'patients';
  const domain = normalizeDomain(url);

  const issueFindings = findings.filter(
    f => f.severity === 'critical' || f.severity === 'warning',
  );
  const summaryIds = pickSummaryIds(issueFindings, pagespeed);

  const recommendedLlmsTxt = recommendedLlmsTxtOpt
    || readClientLlmsTxt(slug)
    || buildRecommendedLlmsPreview(scraped, url);

  const assembledFindings = findings.map(f =>
    transformFinding(f, {
      bronze,
      scraped,
      pagespeed,
      url,
      city,
      audienceNoun,
      inSummary: summaryIds.has(f.id),
      summaryRank: summaryIds.get(f.id) ?? null,
      recommendedLlmsTxt,
    }),
  );

  const critical = findings.filter(f => f.severity === 'critical').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;
  const issuesFound = issueFindings.length;
  const checksPassing = findingsSummary?.passed
    ?? findings.filter(f => f.severity === 'passed').length;

  const crawlStats = deriveCrawlStats(bronze, findings);

  return {
    $schema: SCHEMA,
    _doc: 'SOURCE OF TRUTH. Scanners emit facts; renderers read this file only. LLM may rewrite consumer.now/good for tone, never numbers, scores, or evidence rows.',

    meta: {
      business_name: practiceName,
      url: domain,
      slug: slug || domain.replace(/\./g, '-'),
      vertical: 'dental',
      audience_noun: audienceNoun,
      city,
      generated_at: new Date().toISOString().slice(0, 10),
      target_stack: ['Astro', 'Tailwind', 'Cloudflare Pages'],
      source_url: url,
    },

    scan: {
      pages_crawled: crawlStats.pages_crawled,
      images_checked: crawlStats.images_checked,
      issues_found: issuesFound,
      severity_counts: { critical, warning: warnings },
      checks_passing: checksPassing,
    },

    lighthouse: buildLighthouse(pagespeed, assembledFindings),

    agentic_browsing: buildAgenticBrowsing(agenticBrowsing, assembledFindings, recommendedLlmsTxt),

    vendor: vendor || {
      id: 'unknown',
      category: 'unknown',
      confidence: 0,
      display_name: 'Unknown provider',
      subscription_tco: null,
    },

    findings: assembledFindings,

    ...(citability && !citability.skipped ? {
      ai_citability: {
        prompt: citability.prompt,
        mentioned: citability.mentioned,
        total: citability.total,
        fraction: citability.fraction,
        phase: citability.phase,
        recommendation: citability.phaseRecommendation,
        models: (citability.results || []).map(r => ({ model: r.model, mentioned: r.mentioned })),
      },
    } : {}),

    strategy_bridge: buildStrategyBridge(aiAudit, scraped, citability),
  };
}

function pickSummaryIds(issueFindings, pagespeed) {
  const hasLcpIssue = issueFindings.some(f => f.id === 'low-lcp');
  const candidates = issueFindings.filter(f => {
    if (SUMMARY_EXCLUDE.has(f.id)) return false;
    if (!CONSUMER_COPY[f.id]) return false;
    if (f.id === 'low-performance' && hasLcpIssue) return false;
    return true;
  });

  const scored = candidates.map(f => {
    const entry = getCatalogEntry(f.id);
    const sevMult = f.severity === 'critical' ? 3 : 2;
    const impact = CUSTOMER_IMPACT[f.id] ?? 1;
    return { id: f.id, score: (entry.weight ?? 1) * sevMult * impact };
  });
  scored.sort((a, b) => b.score - a.score);

  const rankMap = new Map();
  scored.slice(0, MAX_SUMMARY).forEach((item, i) => {
    rankMap.set(item.id, i + 1);
  });
  return rankMap;
}

function transformFinding(f, ctx) {
  const { bronze, pagespeed, city, audienceNoun, inSummary, summaryRank, recommendedLlmsTxt, scraped } = ctx;
  const entry = getCatalogEntry(f.id);
  const workstream = WORKSTREAMS[f.id] || categoryToWorkstream(f.category);
  const category = CATEGORY_LABELS[f.id] || f.title;

  const measurement = buildMeasurement(f, pagespeed, bronze);
  const technical = buildTechnical(f, entry, bronze);
  const evidence_rows = buildFindingEvidenceRows(f, bronze, ctx.scraped);
  const consumer = inSummary
    ? buildConsumer(f, { city, audienceNoun, pagespeed, measurement })
    : null;

  let llms_evidence = f.llmsEvidence || null;
  if (llms_evidence && recommendedLlmsTxt) {
    llms_evidence = { ...llms_evidence, recommended_excerpt: recommendedLlmsTxt };
  }

  const out = {
    id: f.id,
    category,
    workstream,
    severity: f.severity === 'passed' ? 'passed' : f.severity,
    impact: f.severity === 'critical' ? 'high' : f.severity === 'warning' ? 'med' : 'low',
    effort: entry.fix_action?.kind === 'manual' ? 'med' : 'low',
    show_in_summary: inSummary,
    summary_rank: inSummary ? summaryRank : null,
    measurement,
    consumer,
    technical,
    evidence_rows,
  };
  if (llms_evidence) out.llms_evidence = llms_evidence;
  return out;
}

function duplicateTitlePageCount(bronze) {
  const pages = bronze?.pages || [];
  const titleMap = {};
  for (const p of pages) {
    const t = p.title?.trim();
    if (!t) continue;
    if (!titleMap[t]) titleMap[t] = 0;
    titleMap[t] += 1;
  }
  return Object.values(titleMap).filter(n => n > 1).reduce((sum, n) => sum + n, 0);
}

function buildMeasurement(f, pagespeed, bronze) {
  const tone = f.severity === 'critical' ? 'danger' : 'warning';

  if (f.id === 'duplicate-titles' && bronze?.pages?.length) {
    const n = duplicateTitlePageCount(bronze);
    if (n > 0) {
      return { type: 'metric', value: String(n), label: 'pages, same title', tone };
    }
  }

  if (f.id === 'low-lcp' && pagespeed?.mobile?.metrics?.lcp != null) {
    const sec = (pagespeed.mobile.metrics.lcp / 1000).toFixed(1);
    return { type: 'metric', value: `${sec}s`, label: 'LCP (main content load)', target: '2.5s', tone };
  }

  if (f.id === 'low-performance' && pagespeed?.mobile?.performance != null) {
    return {
      type: 'metric',
      value: String(pagespeed.mobile.performance),
      label: 'mobile score',
      target: '90',
      tone,
    };
  }

  if (f.id === 'high-cls' && pagespeed?.mobile?.metrics?.cls != null) {
    return {
      type: 'metric',
      value: String(pagespeed.mobile.metrics.cls.toFixed(3)),
      label: 'CLS (layout shift)',
      target: '0.1',
      tone,
    };
  }

  if (f.id === 'gbp-incomplete-profile' && f.detail) {
    const m = f.detail.match(/(\d+)%/);
    if (m) {
      return { type: 'metric', value: `${m[1]}%`, label: 'profile complete', tone };
    }
  }

  if (f.id === 'no-llms-txt' && f.severity !== 'passed') {
    return { type: 'status', value: 'Missing', tone };
  }
  if (f.id === 'llms-txt-poor' && f.severity !== 'passed') {
    return { type: 'status', value: 'Subpar', tone };
  }

  const statusIds = new Set([
    'no-faq', 'no-testimonials', 'no-phone-click-tracking', 'no-ga4-configured',
    'no-phone-on-site', 'no-address-on-site', 'no-hours-on-site', 'no-social-links',
    'missing-schema', 'gbp-no-description', 'gbp-no-title', 'gbp-no-phone', 'gbp-no-hours',
    'gbp-no-website-linked', 'using-third-party-domain', 'fractured-web-presence',
  ]);
  if (statusIds.has(f.id) && f.count > 0) {
    return { type: 'status', value: 'Missing', tone };
  }

  if (f.count > 0) {
    const label = measurementLabel(f.id, f, bronze);
    return { type: 'metric', value: String(f.count), label, tone };
  }

  return { type: 'status', value: f.severity === 'passed' ? 'OK' : 'Issue', tone };
}

function measurementLabel(id, f, bronze) {
  const labels = {
    'duplicate-titles': 'pages, same title',
    'missing-alt': 'photos, no alt text',
    'missing-meta': 'pages, no description',
    'missing-canonical': 'pages, no canonical',
    'missing-h1': 'pages, no H1',
    'multiple-h1': 'pages, multiple H1',
    'thin-content': 'pages under 200 words',
    'title-no-city': 'titles missing city',
    'gbp-low-review-count': 'reviews',
  };
  if (labels[id]) return labels[id];
  if (id === 'duplicate-titles' && f.affectedPages?.length) {
    return 'pages, same title';
  }
  return 'affected';
}

function buildTechnical(f, entry, bronze) {
  const target = entry.fix_action?.target;
  const build = target ? (BUILD_HINTS[target] || `${entry.fix_action.kind}: ${target}`) : null;
  return {
    evidence: f.detail || f.title,
    root_cause: f.benefit ? null : undefined,
    build: build || (f.benefit ? `See fix worklist for ${f.id}.` : null),
  };
}

function buildConsumer(f, ctx) {
  const template = CONSUMER_COPY[f.id];
  if (!template) return null;

  const lcpSec = ctx.pagespeed?.mobile?.metrics?.lcp != null
    ? Math.round(ctx.pagespeed.mobile.metrics.lcp / 1000)
    : null;
  const perfScore = ctx.pagespeed?.mobile?.performance ?? null;

  const vars = {
    city: ctx.city || 'your area',
    audience: ctx.audienceNoun,
    count: String(f.count || ctx.measurement?.value || ''),
    lcpSec: lcpSec != null ? String(lcpSec) : '10+',
    perfScore: perfScore != null ? String(perfScore) : '—',
  };

  return {
    now: interpolate(template.now, vars),
    good: interpolate(template.good, vars),
  };
}

function buildRecommendedLlmsPreview(scraped, url) {
  if (!scraped?.practice?.name) return null;
  try {
    let domain = scraped.practice.domain || scraped.practice.url || url;
    if (domain && !/^https?:\/\//i.test(domain) && url) {
      try { domain = new URL(url).origin; } catch { domain = url; }
    }
    return previewLlmsTxt({
      practice: { ...scraped.practice, url: domain, domain },
      address: scraped.address || {},
      doctor: scraped.doctor || {},
      services: scraped.services || { offered: [] },
    });
  } catch {
    return null;
  }
}

/** Canonical Lighthouse agentic-browsing audits (order matches Lighthouse config). */
const AGENTIC_CHECK_DEFS = [
  {
    id: 'llms-txt',
    title: 'llms.txt follows recommendations',
    summary: 'A Markdown file at /llms.txt that tells AI crawlers what your practice offers and which pages matter.',
    priority: 'now',
    failNote: 'Without a proper llms.txt, ChatGPT, Gemini, and Perplexity may misrepresent your services or skip your site entirely.',
  },
  {
    id: 'agent-accessibility-tree',
    title: 'Accessibility tree is well-formed',
    summary: 'Buttons, links, forms, and landmarks are labeled so agents can navigate the page.',
    priority: 'now',
    failNote: 'AI agents read your site through the accessibility tree. Missing labels or broken ARIA means they cannot reliably find your booking form or contact info.',
  },
  {
    id: 'webmcp-registered-tools',
    title: 'WebMCP tools registered',
    summary: 'Machine-callable actions declared via WebMCP (e.g. book appointment, get directions).',
    priority: 'future',
    naNote: 'WebMCP is a new Google/Chrome standard (2026). No major AI assistant uses it for dental sites yet — nothing to fix today.',
    failNote: 'No WebMCP tools are registered. That is normal for most practices today; only matters when you deliberately add agent-callable actions.',
    futureNote: 'When agents adopt WebMCP, registered tools could let assistants book appointments or answer practice questions without leaving the chat.',
  },
  {
    id: 'webmcp-form-coverage',
    title: 'WebMCP form coverage',
    summary: 'Whether forms (contact, booking) carry WebMCP annotations so agents know how to fill them.',
    priority: 'future',
    naNote: 'No forms on the page, or WebMCP is not supported in the test browser — nothing actionable for a brochure-style dental site today.',
    futureNote: 'Annotated forms could let an agent submit a contact request on a patient\'s behalf once WebMCP is widely supported.',
  },
  {
    id: 'webmcp-schema-validity',
    title: 'WebMCP schemas are valid',
    summary: 'Whether WebMCP tool and form schemas are correctly structured.',
    priority: 'future',
    naNote: 'Your site does not use WebMCP yet — this check does not apply. No action needed.',
    failNote: 'WebMCP schema errors would block agents from using your tools correctly — only relevant once you add WebMCP integrations.',
    futureNote: 'Valid schemas will matter when you add WebMCP tools so agents can interpret parameters correctly.',
  },
  {
    id: 'cumulative-layout-shift',
    title: 'Cumulative Layout Shift (CLS)',
    summary: 'How much the page jumps around while loading — affects both patients and agents trying to click elements.',
    priority: 'now',
    failNote: 'Layout shifts can cause agents (and users) to click the wrong element. Often fixed by sizing images and reserving space for fonts.',
    passNote: 'Page layout is stable during load — good for both human visitors and automated navigation.',
  },
];

/**
 * @param {object|null} agenticScan - meta from runAgenticScan / auditAgenticUrl
 * @returns {object[]}
 */
export function buildLighthouseChecks(agenticScan) {
  const audits = agenticScan?.audits || {};

  return AGENTIC_CHECK_DEFS.map(def => {
    const audit = audits[def.id] || null;
    let status = 'unknown';
    if (audit) {
      if (audit.notApplicable) status = 'na';
      else if (audit.score === 1) status = 'pass';
      else status = 'fail';
    }

    let note = null;
    if (status === 'na') {
      note = def.naNote || def.futureNote;
    } else if (status === 'fail') {
      note = def.failNote || null;
    } else if (status === 'pass') {
      note = def.priority === 'future'
        ? (def.futureNote || def.naNote)
        : (def.passNote || null);
    }

    const lhDetail = audit?.displayValue || audit?.explanation || null;
    if (lhDetail && status !== 'unknown') {
      note = note ? `${lhDetail} — ${note}` : lhDetail;
    }

    return {
      id: def.id,
      title: audit?.title || def.title,
      summary: def.summary,
      priority: def.priority,
      status,
      score: audit?.score ?? null,
      note,
    };
  });
}

export function buildAgenticBrowsing(agenticScan, findings, recommendedLlmsTxt = null) {
  const llmsFinding = findings.find(f => f.id === 'llms-txt-poor' || f.id === 'no-llms-txt');
  const status = agenticScan?.llmsTxtStatus
    ?? agenticScan?.llms?.status
    ?? (llmsFinding?.id === 'no-llms-txt' ? 'absent' : llmsFinding?.id === 'llms-txt-poor' ? 'poor' : null);

  const ratio = agenticScan?.passRatio || null;
  let headline = null;
  if (status === 'absent') {
    headline = 'No llms.txt — AI assistants cannot reliably discover your site content.';
  } else if (status === 'poor') {
    headline = 'llms.txt exists but does not follow best practices — AI assistants may get the wrong summary of your practice.';
  } else if (status === 'good') {
    headline = 'llms.txt is present and follows agent-readiness best practices.';
  }

  const llms_evidence = {
    ...(agenticScan?.llms || {}),
    ...(llmsFinding?.llms_evidence || {}),
    status,
    recommended_excerpt: recommendedLlmsTxt || llmsFinding?.llms_evidence?.recommended_excerpt || null,
    verify_url: agenticScan?.llms?.verifyUrl || agenticScan?.llms?.url || llmsFinding?.llms_evidence?.verify_url,
  };

  const fractionalScore = agenticScan?.fractionalScore ?? null;
  const lighthouseScore = fractionalScore != null
    ? {
        value: Math.round(fractionalScore * 100),
        out_of: 100,
        display: `${Math.round(fractionalScore * 100)}/100`,
        source: 'Google Lighthouse',
        category: 'agentic-browsing',
        note: 'Weighted average of applicable Agentic Browsing audits. Experimental Lighthouse category — same 0–100 scale as Performance and SEO.',
      }
    : null;

  return {
    source: 'Lighthouse CLI + HTTP fetch',
    llms_txt_status: status,
    llms_txt_present: status === 'good',
    pass_ratio: ratio,
    fractional_score: fractionalScore,
    lighthouse_score: lighthouseScore,
    headline,
    llms_evidence,
    lighthouse_checks: buildLighthouseChecks(agenticScan),
    audits: agenticScan?.audits || null,
  };
}

function buildLighthouse(pagespeed, findings) {
  const mobile = pagespeed?.mobile;
  const m = mobile?.metrics || {};

  const raw_metrics = [
    metricRow('LCP', 'Largest Contentful Paint', m.lcp, 2500, 's'),
    metricRow('FCP', 'First Contentful Paint', m.fcp, 1800, 's'),
    metricRow('SI', 'Speed Index', m.si, 3400, 's'),
    metricRow('TTI', 'Time to Interactive', m.tti, 3800, 's'),
    metricRow('TBT', 'Total Blocking Time', m.tbt, 200, 'ms'),
    metricRow('CLS', 'Cumulative Layout Shift', m.cls, 0.1, '', false),
  ].filter(Boolean);

  const issueIds = new Set(
    findings.filter(f => f.show_in_summary || f.severity !== 'passed').map(f => f.id),
  );

  const seoRelated = ['duplicate-titles', 'missing-meta', 'missing-schema', 'no-faq', 'title-no-city', 'thin-content'];
  const perfRelated = ['low-lcp', 'low-performance', 'high-cls'];
  const a11yRelated = ['missing-alt', 'no-viewport'];

  const consumer_scores = [
    {
      key: 'mobile_speed',
      label: 'Mobile Speed',
      desc: 'How fast it loads on a phone',
      score: mobile?.performance ?? null,
      status: scoreStatus(mobile?.performance),
      derived_from: perfRelated.filter(id => issueIds.has(id) || findings.some(x => x.id === id && x.severity !== 'passed')),
    },
    {
      key: 'google_visibility',
      label: 'Google Visibility',
      desc: 'How easily patients find you',
      score: mobile?.seo ?? null,
      status: scoreStatus(mobile?.seo),
      derived_from: seoRelated.filter(id => findings.some(x => x.id === id && (x.severity === 'critical' || x.severity === 'warning'))),
    },
    {
      key: 'ease_of_use',
      label: 'Ease of Use',
      desc: 'Works on all devices',
      score: mobile?.accessibility ?? null,
      status: scoreStatus(mobile?.accessibility),
      derived_from: a11yRelated.filter(id => findings.some(x => x.id === id && (x.severity === 'critical' || x.severity === 'warning'))),
    },
    {
      key: 'technical_health',
      label: 'Technical Health',
      desc: 'Security & standards',
      score: mobile?.bestPractices ?? null,
      status: scoreStatus(mobile?.bestPractices),
      derived_from: [],
    },
  ];

  return {
    profile: 'mobile',
    source: 'PageSpeed Insights API v5',
    verify_url: 'https://pagespeed.web.dev',
    raw_metrics,
    consumer_scores,
  };
}

function metricRow(id, name, valueMs, target, unit, isMs = true) {
  if (valueMs == null) return null;
  const value = isMs && unit === 's' ? +(valueMs / 1000).toFixed(2) : +Number(valueMs).toFixed(3);
  const targetVal = isMs && unit === 's' ? target / 1000 : target;
  let status = 'pass';
  if (id === 'CLS') status = value <= target ? 'pass' : value <= 0.25 ? 'warn' : 'fail';
  else if (unit === 'ms') status = value <= target ? 'pass' : 'fail';
  else status = value <= targetVal ? 'pass' : 'fail';

  return { id, name, value, unit, target: isMs && unit === 's' ? targetVal : target, status };
}

function scoreStatus(score) {
  if (score == null) return 'warn';
  if (score >= 90) return 'good';
  if (score >= 50) return 'warn';
  return 'warn';
}

function buildStrategyBridge(aiAudit, scraped, citability = null) {
  const bridge = [];
  // Earned-vs-owned sequencing: the AI citability diagnostic decides the
  // first AEO move, so it leads the bridge when available.
  if (citability && !citability.skipped && citability.phase) {
    bridge.push({
      gap: citability.phase === 'trust_building'
        ? `AI assistants don't yet mention the practice (${citability.fraction} models)`
        : `AI assistants cite the practice (${citability.fraction} models) — citations must stay accurate`,
      build: citability.phase === 'trust_building'
        ? 'Earned signals first: review velocity, directory listings, and third-party mentions — then content optimization.'
        : 'Owned content next: accurate facts on every page, schema depth, FAQ coverage, answer-first service pages.',
    });
  }
  for (const gap of (aiAudit?.contentGaps || []).slice(0, 6)) {
    bridge.push({ gap, build: 'Address in rebuilt site content and navigation.' });
  }
  for (const opp of (aiAudit?.seoOpportunities || []).slice(0, 4)) {
    bridge.push({ gap: opp, build: 'Incorporate into service pages and local SEO structure.' });
  }
  if (bridge.length === 0 && scraped?.services?.offered?.length) {
    bridge.push({
      gap: 'Service coverage vs. site structure',
      build: 'Align navigation and dedicated pages with offered services from intake data.',
    });
  }
  return bridge;
}

function categoryToWorkstream(category) {
  if (category === 'performance' || category === 'accessibility') return 'performance';
  if (category === 'content') return 'content';
  if (category === 'seo' || category === 'hosting') return 'foundation';
  return 'conversion';
}

function interpolate(s, vars) {
  return String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function normalizeDomain(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function hostnameLabel(url) {
  const d = normalizeDomain(url);
  return d.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Site Audit';
}

function deriveCrawlStats(bronze, findings) {
  let pages_crawled = bronze?.pageCount ?? bronze?.pages?.length ?? 0;
  let images_checked = 0;
  for (const p of bronze?.pages || []) {
    images_checked += (p.images || []).length;
  }

  if (!pages_crawled) {
    for (const f of findings || []) {
      const m = String(f.detail || '').match(/(\d+) of (\d+) pages/);
      if (m) pages_crawled = Math.max(pages_crawled, parseInt(m[2], 10));
    }
  }

  if (!images_checked) {
    const alt = findings?.find(f => f.id === 'missing-alt');
    if (alt?.count) {
      images_checked = alt.count;
    }
  }

  return { pages_crawled, images_checked };
}
