/**
 * AI content expansion — used by the SEO optimizer to remediate thin pages
 * (service detail pages and blog posts) flagged for content_depth or
 * ai_content_depth in the audit.
 *
 * Single-purpose helper: given an existing thin body + practice context + a
 * target word count, return an expanded body that follows the same
 * copywriting principles as section generation (no template phrases, real
 * factual statements, FAQ-friendly structure).
 *
 * Returns { ok: boolean, body: string|null, error?: string }.
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

/**
 * @param {object} args
 * @param {'service-detail'|'blog-post'} args.kind
 * @param {string} args.url               - the page URL (for context)
 * @param {string} args.existingBody      - current body content (markdown for blog, raw text for services)
 * @param {string} args.title             - page H1
 * @param {object} args.practice          - { name, doctor, city }
 * @param {object} args.service           - { name, slug } if kind=service-detail
 * @param {number} args.targetWords       - aim for this word count (typically 1500 for blog, 700 for service)
 * @returns {Promise<{ ok: boolean, body: string|null, error?: string }>}
 */
export async function expandContent(args) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, body: null, error: 'ANTHROPIC_API_KEY not set' };

  const prompt = buildPrompt(args);

  try {
    const { callAnthropic } = await import('./ai-call.js');
    const res = await callAnthropic({
      phase:     args.kind === 'blog-post' ? 'blog-expand' : 'service-expand',
      model:     MODEL,
      maxTokens: MAX_TOKENS,
      messages:  [{ role: 'user', content: prompt }],
    });
    const raw = res.text;
    const body = parseBody(raw);
    if (!body || body.length < args.existingBody.length) {
      return { ok: false, body: null, error: 'AI did not return a longer body' };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, body: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(args) {
  const { kind, url, existingBody, title, practice, service, targetWords } = args;
  const practiceName = practice?.name || 'this practice';
  const city         = practice?.city || '';
  const doctor       = practice?.doctor || '';

  const kindLabel = kind === 'service-detail' ? 'service detail page' : 'blog post';
  const kindGuidance = kind === 'service-detail'
    ? `This is a service detail page about "${service?.name || title}". Cover what the service is, who it's for, how it typically works, what a patient can expect during a visit, common questions, and how this practice handles it. Keep it grounded in this practice's context — do not invent credentials or stats.`
    : `This is a long-form blog post for the practice's blog. Cover the topic comprehensively: explain the subject, who/why it matters, common questions, comparisons where natural, and a takeaway. Keep it in the practice's voice, not a generic SEO copywriter.`;

  return `You are expanding a thin ${kindLabel} on a dental practice website. The current body is too short to rank well in search and too thin to be useful to LLMs that might cite it. Your job: produce an expanded body that reaches roughly ${targetWords} words while staying truthful, practice-specific, and useful.

# Context
- Page URL: ${url}
- Page title: ${title}
- Practice: ${practiceName}${city ? `, located in ${city}` : ''}
- Doctor: ${doctor || '(not specified)'}
- Page kind: ${kindLabel}
- Target length: ~${targetWords} words

# Current (thin) body — preserve every accurate factual claim that's already here. Expand around it; do not contradict it.

"""
${existingBody.slice(0, 6000)}
"""

# Guidance specific to this kind of page

${kindGuidance}

# Universal principles (apply at all times)

- **No fabrication.** Do not invent credentials, statistics, awards, or quotes. If you don't know whether the practice offers something, write generally about the topic, not a claim about this practice.
- **No generic boilerplate.** Avoid phrases like "your trusted partner", "second to none", "we care about your smile", "comprehensive care", or "your healthiest smile starts here". These are template tells.
- **No gatekeeping.** Do not write "this is not that office", "not the usual dentist", or "if you want X, go elsewhere". Be helpful. Describe what happens here.
- **Direct answer up top.** Within the first two paragraphs, plainly answer the obvious question this page is about. LLMs need an extractable answer.
- **Comprehensive coverage.** A reader skimming H2s should see the structure of the topic. Use 3–5 H2 subheadings to organize. Use markdown ## for subheads.
- **Specifics over marketing.** Concrete: "A typical filling appointment takes 30–60 minutes." Generic: "We make sure you're comfortable." Choose the concrete every time.
- **Don't perform honesty.** Do not write as if you must prove you are truthful or different. No "actually", "the real difference", "not a slogan", "so you can see what we see". State the fact and stop.
- **One FAQ block at the end** with 3–5 real questions a patient would ask, answered plainly. This is gold for AI citation.
- **Local context** mentioned 1–3 times naturally (the city, neighborhood, "patients in ${city || 'the area'}"). Don't keyword-stuff.
- **Markdown output.** Use ## for subheadings, paragraphs separated by blank lines, plain bullet lists where natural.

# Output format

Return ONLY the expanded markdown body. No frontmatter. No title heading at the top (the page already has an H1). Start with the opening paragraph, end with the FAQ section.`;
}

function parseBody(raw) {
  let text = (raw || '').trim();
  // Strip markdown fences if present
  const fence = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/);
  if (fence) text = fence[1].trim();
  // Drop a leading H1 if the model added one despite instructions
  text = text.replace(/^#\s+[^\n]+\n+/, '').trim();
  return text || null;
}
