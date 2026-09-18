/**
 * Phase: AI Content Map (Audit / Blueprint)
 *
 * The audit pass that decides — BEFORE any copy is written — what each page
 * needs and what existing source material best fits each section. Produces a
 * `contentAudit` keyed by section, recording existing source text, quality
 * score, and recommended action (keep/optimize/create).
 *
 * The Content Write phase consumes this blueprint to compose copy. The split
 * gives each phase one job: Map judges; Write writes.
 *
 * Output is saved to _pipeline/03-content-blueprint.json.
 */

import { renderSkillPrompt } from './skill-loader.js';

/**
 * Run the Content Map audit phase.
 *
 * @param {object} scraped - Raw scraped data (includes pageInventory)
 * @param {object} merged  - Merged practice data (silver + intake)
 * @param {object} audit   - Site-audit output (may be null)
 * @param {object} preset  - Loaded vertical preset
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]
 * @returns {object|null} Blueprint { contentAudit, coverage, differentiatorMatches, rationale }, or null
 */
export async function runContentMap(scraped, merged, audit, preset, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('  ANTHROPIC_API_KEY not set — skipping Content Map.');
    return null;
  }
  if (!scraped) {
    console.log('  No scrape data — skipping Content Map.');
    return null;
  }

  let prompt;
  try {
    prompt = await buildPrompt(scraped, merged, audit, preset);
  } catch (err) {
    console.warn(`  [content-map] Could not render prompt: ${err.message}`);
    return null;
  }

  if (opts.verbose) {
    console.log('  [content-map] Prompt length:', prompt.length, 'chars');
  }

  const startTime = Date.now();
  try {
    const { callAnthropic } = await import('./ai-call.js');
    const result = await callAnthropic({
      phase:     'content-map',
      cache:     true,
      model:     'claude-sonnet-4-6',
      // Audit-only output is smaller than full content map (no per-section copy)
      // but with 30+ services × audit entry it can still be ~6-8k tokens.
      maxTokens: 12288,
      messages:  [{ role: 'user', content: prompt }],
    }, { parseJson: true });

    const durationMs = Date.now() - startTime;
    if (!result.parsed) {
      console.warn(`  [content-map] JSON parse failed. Output length: ${result.text?.length || 0} chars, output_tokens: ${result.usage?.output_tokens}`);
      if (opts.verbose) console.log('  [content-map] Last 300 chars:', result.text?.slice(-300));
      return null;
    }
    result.parsed._meta = {
      model:         result.model,
      input_tokens:  result.usage?.input_tokens,
      output_tokens: result.usage?.output_tokens,
      duration_ms:   durationMs,
      cost:          result.cost,
    };

    // Required-keys schema enforcement. The expected audit keys are derived
    // deterministically from silver (homepage + about + per-service intros).
    // Any expected key the model didn't return → backfill with `quality:missing,
    // action:create` so downstream Write always sees a complete audit.
    const expectedKeys = computeExpectedAuditKeys(merged);
    const audit = result.parsed.contentAudit || {};
    const present = new Set(Object.keys(audit));
    const missing = expectedKeys.filter(k => !present.has(k));
    const extra   = [...present].filter(k => !expectedKeys.includes(k));

    for (const key of missing) {
      audit[key] = {
        existing:  null,
        source:    null,
        quality:   'missing',
        action:    'create',
        rationale: '(auto-backfilled — Map did not produce an entry for this required key)',
      };
    }
    result.parsed.contentAudit = audit;
    result.parsed._meta.schemaValidation = {
      expectedKeyCount: expectedKeys.length,
      missingKeys:      missing,
      extraKeys:        extra,
      backfilled:       missing.length,
    };

    if (missing.length > 0) {
      console.warn(`  [content-map] Backfilled ${missing.length} missing audit keys (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})`);
    }
    if (opts.verbose && extra.length > 0) {
      console.log(`  [content-map] ${extra.length} extra audit keys returned (kept): ${extra.slice(0, 5).join(', ')}`);
    }

    // Source-path validator. Every non-null `source` in the audit MUST point
    // to a real path that appeared in pageInventory (or the homepage `/`).
    // Hallucinated source paths break Write's "look up the verbatim text"
    // logic, so flag and null-out invalid entries.
    const sourcePathAudit = validateAuditSourcePaths(audit, scraped.pageInventory || []);
    if (sourcePathAudit.invalid.length > 0) {
      console.warn(`  [content-map] ${sourcePathAudit.invalid.length} audit entries reference invalid source paths — nulling them:`);
      for (const item of sourcePathAudit.invalid.slice(0, 5)) {
        console.warn(`    ✗ ${item.key}: source="${item.source}" (not in pageInventory)`);
        // Null out the bad source so Write doesn't follow it
        if (audit[item.key]) audit[item.key].source = null;
      }
    }
    result.parsed._meta.sourcePathValidation = sourcePathAudit;

    return result.parsed;
  } catch (err) {
    console.warn(`  [content-map] API call failed: ${err.message}`);
    return null;
  }
}

/**
 * Validate that every non-null `source` in the audit points to a real page
 * path. Catches hallucinated source attributions (model claims content came
 * from `/about` when the practice has no /about page).
 *
 * Returns { valid, invalid: Array<{key, source}> }.
 * The caller is expected to null-out invalid sources so Write doesn't follow
 * them.
 */
export function validateAuditSourcePaths(audit, pageInventory) {
  const knownPaths = new Set(['/', '']);
  for (const p of pageInventory || []) {
    if (p?.path) knownPaths.add(String(p.path).replace(/\/$/, '') || '/');
  }
  const valid = [];
  const invalid = [];
  for (const [key, entry] of Object.entries(audit || {})) {
    if (!entry?.source) continue;  // null sources are fine
    const normalized = String(entry.source).replace(/\/$/, '') || '/';
    if (knownPaths.has(normalized) || knownPaths.has(entry.source)) {
      valid.push({ key, source: entry.source });
    } else {
      invalid.push({ key, source: entry.source });
    }
  }
  return { valid, invalid, knownPathCount: knownPaths.size };
}

/**
 * Compute the deterministic set of required audit keys for this practice.
 * Drives both the prompt's "Sections you must audit" list AND the post-hoc
 * validator. Keeps Map's contract testable.
 */
export function computeExpectedAuditKeys(merged) {
  const keys = [
    'homepage.heroHeadline',
    'homepage.heroSubheadline',
    'homepage.heroTagline',
    'homepage.valueProp',
    'about.headline',
    'about.introParagraph',
    'about.philosophy',
  ];
  const offered = merged?.services?.offered || [];
  for (const svc of offered) {
    if (svc?.slug) keys.push(`services.${svc.slug}.intro`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

async function buildPrompt(scraped, merged, audit, preset) {
  const practice = merged.practice || {};
  const doctor   = merged.doctor   || {};
  const services = merged.services || {};
  const offered  = services.offered || [];

  // Required sections list — service entries are derived from silver
  const serviceSectionList = offered.length > 0
    ? offered.map(s => `services.${s.slug}.intro`).join('\n')
    : '(no services to audit)';

  const servicesList = offered.map(s => s.name).join(', ') || 'General services';

  // Per-service scraped page content — primary source for service intros
  const servicePageContent = buildServicePageContent(offered, scraped.pageInventory || []);

  // additionalContent rescue (verbatim practice voice)
  const additionalContentBlock = buildAdditionalContentBlock(merged.additionalContent || []);

  // Differentiators — for matching to service intros
  const differentiatorsBlock = buildDifferentiatorsBlock(merged.differentiators || []);

  // Page inventory fallback context (condensed)
  const pageInventory = buildPageInventorySummary(scraped.pageInventory || []);

  return renderSkillPrompt('content/content-map', {
    practiceName:        practice.name      || '[Practice Name]',
    domain:              practice.domain    || '[domain]',
    doctorName:          doctor.name        || '[Doctor Name]',
    credentials:         doctor.credentials || 'DDS',
    city:                merged.address?.city  || '[City]',
    state:               merged.address?.state || '[State]',
    phone:               practice.phone     || '[Phone]',
    servicesList,
    serviceSectionList,
    servicePageContent,
    additionalContentBlock,
    differentiatorsBlock,
    pageInventory,
    auditPositioning:    audit?.positioning?.recommended || '(not specified)',
    auditTone:           audit?.tone?.recommended        || '(not specified)',
    auditPrimaryService: audit?.serviceEmphasis?.primary || '(not specified)',
  });
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from ai-content.js — kept local so Map and Write stay
// independent; if these drift further, factor into a shared module).
// ---------------------------------------------------------------------------

function buildServicePageContent(services, inventory) {
  if (!services.length || !inventory.length) return 'No service page content available.';
  const blocks = [];
  for (const svc of services) {
    const page = inventory.find(p => {
      const path = (p.path || p.url || '').toLowerCase().replace(/\/+$/, '');
      return path === `/services/${svc.slug}` ||
             path.includes(`/services/${svc.slug}`) ||
             path.includes(`/services/${svc.name?.toLowerCase().replace(/\s+/g, '-')}`);
    });
    if (!page) continue;
    const lines = [`### ${svc.slug} (${svc.name})`];
    if (page.h1) lines.push(`H1: ${page.h1}`);
    if (page.metaDesc) lines.push(`Meta: ${page.metaDesc}`);
    if (page.narrative) {
      lines.push(page.narrative.slice(0, 2000));
    } else if (page.paragraphs?.length) {
      page.paragraphs.slice(0, 4).forEach(p => lines.push(`  ${p.slice(0, 300)}`));
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.length > 0 ? blocks.join('\n\n') : 'No matching service pages found in crawl.';
}

function buildAdditionalContentBlock(items) {
  if (!Array.isArray(items) || items.length === 0) return 'No verbatim prose rescued from this site.';
  return items.map(item => {
    const header = `### [${item.type || 'other'}] ${item.title ? item.title + ' — ' : ''}from ${item.source || 'unknown'}`;
    const body   = (item.content || '').trim();
    return `${header}\n${body}`;
  }).join('\n\n---\n\n');
}

function buildDifferentiatorsBlock(items) {
  if (!Array.isArray(items) || items.length === 0) return 'No differentiators extracted from this site.';
  return items.map(d => {
    const detail = d.detail ? ` — ${d.detail}` : '';
    const src    = d.source ? ` (${d.source})` : '';
    return `- [${d.type}] ${d.label}${detail}${src}`;
  }).join('\n');
}

// Cap the pageInventory block at this many pages to keep prompt size bounded.
// Sites with 300+ pages (CMS-generated) blow past API request size limits if
// we include everything. Map's primary inputs are servicePageContent and
// additionalContent — pageInventory is fallback context only.
const PAGE_INVENTORY_CAP = 30;

function buildPageInventorySummary(inventory) {
  if (!inventory || inventory.length === 0) return 'No pages crawled.';

  // Prioritize pages most likely to inform the audit:
  // homepage → about/team/contact → service pages → others by word count.
  const priorityScore = (path) => {
    const p = String(path || '');
    if (p === '/' || p === '') return 0;
    if (/\/(meet[-_]?dr|dr[-_]|doctor|team|staff|providers)/i.test(p)) return 1;
    if (/\/(about|our[-_]?practice|why[-_])/i.test(p)) return 2;
    if (/\/(contact|location|directions|hours)/i.test(p)) return 2;
    if (/\/services?(\/|$)/i.test(p)) return 3;
    if (/\/(testimonials|reviews)/i.test(p)) return 4;
    return 5;
  };

  const ordered = [...inventory].sort((a, b) => {
    const pa = priorityScore(a.path);
    const pb = priorityScore(b.path);
    if (pa !== pb) return pa - pb;
    return (b.wordCount || 0) - (a.wordCount || 0);
  });

  const selected = ordered.slice(0, PAGE_INVENTORY_CAP);
  const dropped  = ordered.length - selected.length;

  const blocks = selected.map(page => {
    const lines = [`### ${page.path || page.url}`];
    if (page.title) lines.push(`Title: ${page.title}`);
    if (page.h1) lines.push(`H1: ${page.h1}`);
    if (page.metaDesc) lines.push(`Meta: ${page.metaDesc}`);
    if (page.narrative) {
      lines.push('Content (narrative):');
      lines.push(page.narrative.slice(0, 2500));
    } else if (page.paragraphs?.length) {
      lines.push(`Content excerpts:`);
      page.paragraphs.slice(0, 3).forEach(p => lines.push(`  • ${p.slice(0, 200)}`));
    }
    lines.push(`Word count: ~${page.wordCount}`);
    return lines.join('\n');
  });

  if (dropped > 0) {
    blocks.push(`### (${dropped} additional pages omitted from this block — capped at ${PAGE_INVENTORY_CAP} for prompt-size limits. Full data lives in silver/bronze for downstream phases.)`);
  }

  return blocks.join('\n\n');
}
