/**
 * Shared Anthropic API call wrapper.
 *
 * Three responsibilities:
 *   1. **Retry** — one retry with backoff on transient errors (5xx, 429,
 *      network). 4xx (auth, bad request) are bugs; never retried.
 *   2. **Cost accounting** — every call reports its token usage, accumulated
 *      into a process-wide ledger that build-site can read at the end.
 *   3. **Debug dumps** — when GROUNDWORK_DEBUG_PROMPTS=1, every prompt and
 *      response is written to `_pipeline/_debug/<phase>-<n>.md` for later
 *      inspection. Off by default.
 *
 * Pricing (claude-sonnet-4-6, as of 2026-04):
 *   $3 per 1M input tokens, $15 per 1M output tokens.
 *   Cache reads count as input but at a discount (used by some skills).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/**
 * Abort a stream after this long with no data.
 *
 * Well above normal inter-token latency, far below the point where a run has
 * silently lost an hour. A *total* timeout cannot do this job: a degraded
 * socket that trickles one token occasionally never trips one. One run spent
 * 2h03m inside a phase that normally takes 137s, logging only 4 transient
 * errors — the connection was not failing, it was crawling.
 */
const DEFAULT_STALL_MS = 60_000;

/**
 * Per-phase ceilings, roughly 4x the observed median (content-map ~128s,
 * content ~155s, architect ~71s). Generous enough for a legitimately slow
 * call, tight enough that a wedged one cannot consume the run.
 */
const PHASE_TIMEOUT_MS = {
  content:       600_000,
  'content-map': 500_000,
  architect:     300_000,
  critique:      300_000,
};
const DEFAULT_TIMEOUT_MS = 300_000;

const PRICE_INPUT_PER_M  = 3.00;
const PRICE_OUTPUT_PER_M = 15.00;

// Process-wide ledger, read by build-site at the end of the run.
const _ledger = {
  calls: [],
  totalInputTokens:  0,
  totalOutputTokens: 0,
  totalCost:         0,
};

let _debugCounter = 0;

/**
 * @param {object} args
 * @param {string} args.phase           - Short phase name for the ledger ("audit", "brand", "content", "section:hero", etc.)
 * @param {string} args.model           - Anthropic model id
 * @param {number} args.maxTokens
 * @param {Array}  args.messages        - Anthropic Messages API shape
 * @param {string} [args.system]        - Optional system prompt
 * @param {number} [args.temperature]   - Pass-through to Anthropic API
 * @param {object} [args.extra]         - Any other native API params (top_p, top_k, stop_sequences, …)
 * @param {object} [opts]
 * @param {string} [opts.outputDir]     - Used for debug dumps; if omitted, dumps go to /tmp
 * @param {boolean} [opts.parseJson]    - Convenience: returns parsed JSON if the response is JSON-shaped
 * @returns {Promise<{ text: string, content: any, parsed?: any, usage: object, cost: number, model: string }>}
 */
export async function callAnthropic({ phase, model, maxTokens = 4096, messages, system, temperature, extra, cache = false, stallMs = DEFAULT_STALL_MS, timeoutMs }, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // Content-map/write prompts are large (100k+ chars) and can need long TTFT;
  // default SDK timeout (~10m) is fine for most, but network stacks sometimes
  // abort earlier — keep an explicit 15m ceiling for big phases.
  // A flat 15-minute client timeout is 6-7x what these calls actually take
  // (content-map ~128s, content ~155s, architect ~71s). Kept only as an outer
  // backstop; the stall watchdog below is what actually bounds a hung stream.
  const client = new Anthropic({ apiKey, timeout: 900_000 });
  const callTimeout = timeoutMs || PHASE_TIMEOUT_MS[phase] || DEFAULT_TIMEOUT_MS;
  let stallSeconds = 0;
  let backoffSeconds = 0;

  // Prompt caching. The immediate win is retries: Content Write re-uploaded its
  // full ~36k-token prompt on each of four attempts during one network blip.
  // Marking the prompt cacheable makes every retry after the first a cache read.
  //
  // Cross-call reuse (Map's prefix serving Write's) needs both prompts to begin
  // with a byte-identical block, which they don't yet — that lands with the
  // Content Write decomposition, and this plumbing is what it will use.
  let messagesToSend = messages;
  if (cache) {
    messagesToSend = messages.map((msg, i) => {
      if (i !== messages.length - 1) return msg;
      const parts = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: msg.content }];
      // The breakpoint marks the end of the cacheable prefix, so it goes on the
      // last block of the prompt we want cached.
      const marked = parts.map((part, j) =>
        j === parts.length - 1 ? { ...part, cache_control: { type: 'ephemeral' } } : part
      );
      return { ...msg, content: marked };
    });
  }

  const requestBody = { model, max_tokens: maxTokens, messages: messagesToSend, ...(extra || {}) };
  if (system) requestBody.system = system;
  if (typeof temperature === 'number') requestBody.temperature = temperature;

  // Stream large generations — long non-streaming content/map calls often die
  // with opaque "Connection error" mid-response; streaming keeps the socket warm.
  // Count text and images separately. A single JSON.stringify over `messages`
  // folds base64 image data into the character count, which is how a critique
  // call carrying two screenshots was read as a 2.8M-character prompt — it was
  // ~3k tokens of pictures, not 700k of text. Streaming keys off text size.
  let promptChars = system?.length || 0;
  let imageBytes = 0;
  for (const msg of messages) {
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    for (const part of parts) {
      if (part?.type === 'image') imageBytes += (part.source?.data?.length || 0);
      else promptChars += (part?.text?.length || 0);
    }
  }
  const imageNote = imageBytes ? `, images≈${Math.round(imageBytes / 1024)}KB base64` : '';
  const cacheNote = cache ? ', cacheable' : '';
  const useStream = maxTokens >= 8192 || promptChars >= 60_000;

  let response;
  let attempt = 0;
  const maxAttempts = 4; // initial + 3 retries on transient errors

  while (attempt < maxAttempts) {
    attempt++;
    try {
      if (useStream) {
        if (attempt === 1) {
          console.log(`  [ai-call:${phase}] streaming (text≈${promptChars} chars${imageNote}${cacheNote}, maxTokens=${maxTokens})`);
        }
        // Watchdog on silence, not on total duration.
        //
        // A total timeout is close to useless on a stream: a degraded socket
        // that trickles one token occasionally never trips it, it just drags.
        // One run spent 2h03m inside a phase that normally takes 137s and
        // logged only 4 transient errors — the connection wasn't failing, it
        // was crawling, and nothing was watching. This aborts after `stallMs`
        // of no data so the existing retry path can take over.
        const stream = client.messages.stream(requestBody, { timeout: callTimeout });
        let lastActivity = Date.now();
        const bump = () => { lastActivity = Date.now(); };
        stream.on('streamEvent', bump);
        stream.on('text', bump);

        let stalled = false;
        const watchdog = setInterval(() => {
          const idle = Date.now() - lastActivity;
          if (idle >= stallMs) {
            stalled = true;
            stallSeconds += Math.round(idle / 1000);
            try { stream.abort(); } catch { /* already settled */ }
          }
        }, 2000);

        try {
          response = await stream.finalMessage();
        } catch (err) {
          if (stalled) {
            const e = new Error(`stream stalled — no data for ${Math.round(stallMs / 1000)}s`);
            e.isStall = true;
            throw e;
          }
          throw err;
        } finally {
          clearInterval(watchdog);
          stream.off?.('streamEvent', bump);
          stream.off?.('text', bump);
        }
      } else {
        response = await client.messages.create(requestBody);
      }
      break;
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      // A stall is transient by construction — the socket went quiet, so retry.
      const transient = err?.isStall || !status || status === 429 || (status >= 500 && status < 600);
      if (!transient || attempt >= maxAttempts) throw err;
      // Exponential backoff: 1.5s, 4s, 10s. Large prompts (75K+ chars) on
      // flaky connections sometimes need multiple retries before the request
      // actually lands, so we're more patient than the original 1.5s × 1.
      backoffSeconds += Math.round(([1500, 4000, 10000][attempt - 1] || 10000) / 1000);
      const backoffMs = [1500, 4000, 10000][attempt - 1] || 10000;
      const why = err?.message || err?.cause?.message || String(err);
      console.warn(`  [ai-call:${phase}] transient error (status ${status || 'network'}, attempt ${attempt}/${maxAttempts}): ${why.slice(0, 160)}; retrying in ${backoffMs}ms…`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  const text = (response.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const content = response.content || [];
  const usage = response.usage || {};
  const inputTokens  = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const cost = (inputTokens * PRICE_INPUT_PER_M / 1_000_000) + (outputTokens * PRICE_OUTPUT_PER_M / 1_000_000);

  _ledger.calls.push({
    phase,
    model,
    inputTokens,
    outputTokens,
    cost: +cost.toFixed(4),
    attempts: attempt,
    // Time lost to a wedged connection, so a slow run is diagnosable from the
    // ledger instead of being mistaken for a code regression.
    stallSeconds,
    backoffSeconds,
  });
  if (stallSeconds || backoffSeconds) {
    console.warn(`  [ai-call:${phase}] lost ${stallSeconds + backoffSeconds}s to network (${attempt} attempt(s), ${stallSeconds}s stalled)`);
  }
  _ledger.totalInputTokens  += inputTokens;
  _ledger.totalOutputTokens += outputTokens;
  _ledger.totalCost         += cost;

  // Optional debug dump
  if (process.env.GROUNDWORK_DEBUG_PROMPTS === '1') {
    await dumpDebug({ phase, model, messages, system, text, usage, cost, outputDir: opts.outputDir });
  }

  // Optional JSON convenience parse
  let parsed;
  if (opts.parseJson) {
    parsed = tryParseJson(text);
  }

  return { text, content, parsed, usage, cost: +cost.toFixed(4), model: response.model || model };
}

/**
 * Returns the cost ledger snapshot. build-site reads this at end-of-run for
 * the cost summary.
 */
export function getCostLedger() {
  return {
    calls:             [..._ledger.calls],
    totalInputTokens:  _ledger.totalInputTokens,
    totalOutputTokens: _ledger.totalOutputTokens,
    totalCost:         +_ledger.totalCost.toFixed(4),
    callCount:         _ledger.calls.length,
    networkLostSeconds: _ledger.calls.reduce((s, c) => s + (c.stallSeconds || 0) + (c.backoffSeconds || 0), 0),
    retriedCalls:       _ledger.calls.filter(c => (c.attempts || 1) > 1).length,
  };
}

/**
 * Reset the ledger (used in tests; not called in normal pipeline runs).
 */
export function resetCostLedger() {
  _ledger.calls.length = 0;
  _ledger.totalInputTokens = 0;
  _ledger.totalOutputTokens = 0;
  _ledger.totalCost = 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJson(text) {
  let t = (text || '').trim();
  // Strip markdown fences if present
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  // Try to find a JSON object anywhere in the text
  const f = t.indexOf('{'), l = t.lastIndexOf('}');
  if (f !== -1 && l > f) {
    try { return JSON.parse(t.slice(f, l + 1)); } catch {}
  }
  return null;
}

async function dumpDebug({ phase, model, messages, system, text, usage, cost, outputDir }) {
  const debugDir = outputDir
    ? resolve(outputDir, '_pipeline', '_debug')
    : '/tmp/groundwork-debug';
  try {
    await mkdir(debugDir, { recursive: true });
    const idx = String(++_debugCounter).padStart(3, '0');
    const safePhase = String(phase).replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = join(debugDir, `${idx}-${safePhase}.md`);

    const promptDump = messages.map((m, i) => {
      const content = typeof m.content === 'string' ? m.content :
        (m.content || []).map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n\n');
      return `### Message ${i + 1} (${m.role})\n\n${content}`;
    }).join('\n\n---\n\n');

    const md = `# AI Call: ${phase}

- **Model:** ${model}
- **Input tokens:** ${usage.input_tokens || 0}${usage.cache_read_input_tokens ? ` (+ ${usage.cache_read_input_tokens} cached)` : ''}
- **Output tokens:** ${usage.output_tokens || 0}
- **Cost:** $${(+cost).toFixed(4)}

${system ? `## System prompt\n\n${system}\n\n---\n\n` : ''}## Request

${promptDump}

---

## Response

${text}
`;
    await writeFile(file, md, 'utf8');
  } catch {
    // Best-effort; don't break the pipeline on a debug-write failure.
  }
}
