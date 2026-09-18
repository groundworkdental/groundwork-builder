/**
 * Shared utilities for multi-pass silver extraction.
 *
 * Each pass in passes/*.js imports from here for:
 *   - page selection helpers (filter bronze.pages by pattern)
 *   - prompt template loading
 *   - Anthropic API call with long-completion friendly timeouts
 *   - tolerant JSON / claims extraction
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, 'prompts');

const API_URL = 'https://api.anthropic.com/v1/messages';

// Long-completion friendly agent — Sonnet 4.6 outputting 30k+ tokens can take
// 3-5 minutes. Node's default headersTimeout/bodyTimeout will fire.
const LONG_AGENT = new Agent({
  headersTimeout: 15 * 60 * 1000,
  bodyTimeout: 15 * 60 * 1000,
  connectTimeout: 30_000,
});

export const MODELS = {
  default: 'claude-sonnet-4-6',
  cheap: 'claude-haiku-4-5-20251001', // for narrow passes like image bucketing
};

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function callAnthropic({ model, system, prompt, maxTokens = 16000, maxRetries = 5, images = [] }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Vision support: `images` = [{ mediaType, data(base64) }]. When present, the
  // user message becomes a content array of image blocks followed by the text.
  let content;
  if (images && images.length) {
    content = [
      ...images.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data },
      })),
      { type: 'text', text: prompt },
    ];
  } else {
    content = prompt;
  }

  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  if (system) body.system = system;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s (+ up to 1s jitter).
      // Deterministic jitter from attempt (no Math.random — keeps runs reproducible-ish).
      const base = 1000 * (2 ** (attempt - 1));
      await sleep(Math.min(base + (attempt * 137) % 1000, 30000));
    }
    let res;
    try {
      res = await undiciFetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        dispatcher: LONG_AGENT,
      });
    } catch (err) {
      lastErr = new Error(`Network error (model=${model}): ${err.message} ${err.cause?.message || ''}`);
      continue; // retry network errors
    }

    if (res.status === 429 || res.status === 529 || (res.status >= 500 && res.status < 600)) {
      const text = await res.text().catch(() => '');
      lastErr = new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
      continue; // retry rate-limit / overloaded / server errors
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`); // non-retryable (4xx)
    }
    const data = await res.json();
    return {
      text: data.content?.[0]?.text || '',
      usage: data.usage || {},
      stopReason: data.stop_reason,
    };
  }
  throw lastErr || new Error('callAnthropic: exhausted retries');
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

const _promptCache = new Map();

export async function loadPrompt(name) {
  if (_promptCache.has(name)) return _promptCache.get(name);
  const path = resolve(PROMPTS_DIR, `${name}.md`);
  const text = await readFile(path, 'utf-8');
  _promptCache.set(name, text);
  return text;
}

export function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) return '';
    const v = vars[key];
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
}

// ---------------------------------------------------------------------------
// Tolerant JSON parsing — handles model output with unescaped quotes,
// trailing commas, mid-stream truncation, etc.
// ---------------------------------------------------------------------------

export function parseJsonStrict(text) {
  const clean = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, m => m.includes('```') ? '' : m)
    .replace(/\s*```\s*$/, '')
    .trim();
  try { return JSON.parse(clean); } catch {}
  try { return JSON.parse(text); } catch {}
  // Balance-match the FIRST complete top-level {...} object and ignore any
  // trailing content (model sometimes emits prose or a second object after).
  const first = extractFirstBalancedObject(text);
  if (first) {
    try { return JSON.parse(first); } catch {}
  }
  // Last resort: first { to last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error('Could not parse JSON from model output');
}

function extractFirstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * Extract objects from a `"<key>": [ ... ]` array even when the surrounding
 * JSON is malformed or truncated. Each object is parsed individually; embedded
 * unescaped quotes in string values are repaired heuristically.
 */
export function extractArrayTolerant(text, arrayKey) {
  const open = new RegExp(`"${arrayKey}"\\s*:\\s*\\[`);
  const m = text.match(open);
  if (!m) return { items: [], dropped: 0, repaired: 0 };
  let i = m.index + m[0].length;

  const items = [];
  let dropped = 0, repaired = 0;

  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === ']') break;
    if (text[i] !== '{') { i++; continue; }

    const objStart = i;
    let depth = 0, inStr = false, escape = false, objEnd = -1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (inStr) {
        if (ch === '"') {
          let j = i + 1;
          while (j < text.length && /[ \t]/.test(text[j])) j++;
          const nxt = text[j];
          if (nxt === ',' || nxt === '}' || nxt === ']' || nxt === ':' || nxt === '\n' || nxt === '\r' || j >= text.length) {
            inStr = false;
          }
        }
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = i + 1; i++; break; }
      }
    }
    if (objEnd < 0) break;
    const slice = text.slice(objStart, objEnd);
    let parsed = null;
    try { parsed = JSON.parse(slice); }
    catch {
      const fixed = repairUnescapedQuotes(slice);
      try { parsed = JSON.parse(fixed); repaired++; }
      catch { dropped++; continue; }
    }
    items.push(parsed);
  }
  return { items, dropped, repaired };
}

function repairUnescapedQuotes(s) {
  let out = '', inStr = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }
    if (inStr) {
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length && /[ \t]/.test(s[j])) j++;
        const nxt = s[j];
        if (nxt === ',' || nxt === '}' || nxt === ']' || nxt === ':' || nxt === '\n' || nxt === '\r' || j >= s.length) {
          out += ch; inStr = false;
        } else {
          out += '\\"';
        }
      } else out += ch;
      continue;
    }
    if (ch === '"') { out += ch; inStr = true; continue; }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pass orchestration helper: run prompt → parse → return slice, with safe
// fallback on failure (passes that error return {} so other passes still merge)
// ---------------------------------------------------------------------------

export async function runPassCall({
  name,
  model = MODELS.default,
  system,
  prompt,
  maxTokens = 16000,
  rootArrayKey = null,
  images = [],
}) {
  const started = Date.now();

  // Up to 2 attempts: a parse failure on the first attempt triggers a fresh
  // model call (model output is the failure point, so re-calling often fixes it).
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await callAnthropic({ model, system, prompt, maxTokens, images });
    } catch (err) {
      console.warn(`[silver:${name}] API call failed (attempt ${attempt + 1}): ${err.message}`);
      if (attempt === 0) continue;
      return { ok: false, slice: {}, error: err.message, durationMs: Date.now() - started };
    }
    const { text, usage, stopReason } = result;
    try {
      const parsed = parseJsonStrict(text);
      return { ok: true, slice: parsed, usage, stopReason, durationMs: Date.now() - started };
    } catch (err) {
      if (rootArrayKey) {
        const { items, dropped, repaired } = extractArrayTolerant(text, rootArrayKey);
        if (items.length > 0) {
          return {
            ok: true,
            slice: { [rootArrayKey]: items, _salvage: { dropped, repaired, parseError: err.message } },
            usage, stopReason, durationMs: Date.now() - started,
          };
        }
      }
      console.warn(`[silver:${name}] JSON unparseable (attempt ${attempt + 1}): ${err.message.slice(0, 160)}`);
      if (attempt === 0) continue; // re-call the model once
      return { ok: false, slice: {}, error: err.message, raw: text, durationMs: Date.now() - started };
    }
  }
  return { ok: false, slice: {}, error: 'exhausted attempts', durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Page selection helpers
// ---------------------------------------------------------------------------

export function pagesMatching(pages, patterns) {
  return pages.filter(p => patterns.some(re => re.test(p.path)));
}

/**
 * Render a page as a markdown block. Prefer narrative sections (heading →
 * content in document order) when bronze has them — that is the content
 * reference for rebuild, not disconnected heading/paragraph lists.
 */
export function formatNarrative(page, maxChars = 6000) {
  if (!page?.sections?.length && !page?.contentBlocks?.length) return '';
  const lines = [];
  let used = 0;
  const push = (line) => {
    if (used >= maxChars) return false;
    lines.push(line);
    used += line.length;
    return used < maxChars;
  };

  const sections = page.sections?.length
    ? page.sections
    : groupBlocksFallback(page.contentBlocks || []);

  for (const sec of sections) {
    if (used >= maxChars) break;
    if (sec.heading) {
      const h = `${'#'.repeat(Math.min(sec.heading.level || 2, 6))} ${sec.heading.text}`;
      if (!push(h)) break;
    }
    for (const block of sec.blocks || []) {
      if (used >= maxChars) break;
      if (block.type === 'paragraph') {
        if (!push(block.text.slice(0, 1000))) break;
      } else if (block.type === 'list') {
        for (const item of block.items || []) {
          if (!push(`- ${item}`)) break;
        }
      } else if (block.type === 'table') {
        for (const row of block.rows || []) {
          if (!push(`| ${row.join(' | ')} |`)) break;
        }
      } else if (block.type === 'heading') {
        const h = `${'#'.repeat(Math.min(block.level || 2, 6))} ${block.text}`;
        if (!push(h)) break;
      }
    }
    push('');
  }
  return lines.join('\n').trim();
}

function groupBlocksFallback(blocks) {
  const sections = [];
  let current = { heading: null, blocks: [] };
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (current.heading || current.blocks.length) sections.push(current);
      current = { heading: block, blocks: [] };
    } else {
      current.blocks.push(block);
    }
  }
  if (current.heading || current.blocks.length) sections.push(current);
  return sections;
}

export function renderPage(page, { bodyChars = 4000, paragraphs = 20, images = 30, includeJsonLd = true } = {}) {
  const lines = [`## ${page.path}  ${page.title ? `(${page.title})` : ''}`];
  if (page.metaDescription) lines.push(`Meta: ${page.metaDescription}`);
  if (page.heroTexts?.length) {
    lines.push('Hero text:');
    for (const t of page.heroTexts.slice(0, 8)) lines.push(`  · ${t}`);
  }

  const narrativeBudget = bodyChars === Infinity ? 50000 : Math.max(bodyChars, 6000);
  const narrative = formatNarrative(page, narrativeBudget);
  if (narrative) {
    lines.push('Content (narrative):');
    lines.push(narrative);
  } else {
    // Legacy bronze without sections
    if (page.headings?.length) {
      lines.push('Headings:');
      for (const h of page.headings.slice(0, 30)) lines.push(`  H${h.level}: ${h.text}`);
    }
    if (page.paragraphs?.length) {
      lines.push('Paragraphs:');
      for (const p of page.paragraphs.slice(0, paragraphs)) lines.push(`  · ${p.slice(0, 600)}`);
    }
    if (page.bodyText && bodyChars > 0) {
      const body = bodyChars === Infinity ? page.bodyText : page.bodyText.slice(0, bodyChars);
      lines.push(`Body: ${body}`);
    }
  }

  if (page.images?.length) {
    lines.push('Images (src | alt):');
    for (const img of page.images.slice(0, images)) lines.push(`  ${img.src} | ${img.alt}`);
  }
  if (page.contactLinks) {
    const cl = page.contactLinks;
    if (cl.emails?.length) lines.push(`Emails on page: ${cl.emails.join(', ')}`);
    if (cl.phones?.length) lines.push(`Phones on page: ${cl.phones.join(', ')}`);
    if (cl.mailtos?.length) lines.push(`Mailtos: ${cl.mailtos.join(', ')}`);
    if (cl.tels?.length) lines.push(`Tels: ${cl.tels.join(', ')}`);
  }
  if (includeJsonLd && page.structuredData?.length) {
    lines.push('JSON-LD:');
    for (const item of page.structuredData.slice(0, 4)) {
      lines.push('  ' + JSON.stringify(item).slice(0, 800));
    }
  }
  return lines.join('\n');
}

export function renderPagesAsContext(pages, opts = {}) {
  return pages.map(p => renderPage(p, opts)).join('\n\n---\n\n');
}
