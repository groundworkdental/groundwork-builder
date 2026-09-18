/**
 * router — decide what an inbound message means, and what may be done about it.
 *
 * The router is deliberately small. It does not fix anything and it does not
 * write to a repo; it reads a communication off the ledger, works out what
 * kind of thing it is, and produces one of three outcomes:
 *
 *   act       clear enough to change the client site, scoped to that repo
 *   ask       ambiguous, or a decision that is not ours — go to the human
 *   propose   the underlying cause would recur on the next build
 *
 * The boundary that matters: the router may cause a change in a CLIENT repo,
 * and may only PROPOSE a change to the builder or the marketing site. A client
 * fix is scoped and reversible. A builder change reaches every future
 * practice. A marketing change is a public claim. Those want a human, so the
 * router writes a proposal and stops.
 *
 * Classification is heuristic and says so. `confidence` is on every result,
 * and anything below `high` routes to `ask` rather than `act` — a wrong guess
 * that edits a live practice site is far more expensive than a question.
 */

import { logEvent } from './events.js';
import { d1Query } from './d1.js';

/** What a client message is asking for. */
export const INTENTS = [
  'content-change',   // copy, photos, hours — the site says the wrong thing
  'defect',           // something is broken
  'question',         // they want an answer, not a change
  'approval',         // sign-off on something we sent
  'scope',            // new work, pricing, or a decision about the engagement
  'unclear',
];

/**
 * Signals that a message is describing something the generator would repeat.
 *
 * These are weak on their own. They raise a proposal for a human to judge;
 * they never justify touching the builder directly.
 */
const RECURRENCE_HINTS = [
  [/\b(every|all) (of )?(the )?(pages?|services?|sections?)\b/i, 'describes a site-wide pattern'],
  [/\bwrong (doctor|name|phone|address|hours)\b/i, 'a practice fact is wrong somewhere it was generated'],
  [/\b(placeholder|lorem|coming soon|TBD)\b/i, 'scaffold text reached the client'],
  [/\bstill says\b/i, 'something did not update where it should have'],
  [/\b(broken|404|doesn'?t work|not working)\b/i, 'a defect rather than a preference'],
];

/**
 * Checked in order, first match wins.
 *
 * Precedence matters more than the patterns do. "Can you swap the hero photo?"
 * matches both a question and a change request, and it is plainly a change
 * request — the question mark is politeness. Collecting every match and
 * calling the overlap ambiguous sent ordinary requests to the human, which is
 * the failure that makes a router worth ignoring.
 *
 * Money and sign-off outrank everything: they change what we are allowed to
 * do, not what the site says.
 */
const INTENT_RULES = [
  ['approval', [/\b(looks good|approved?|go ahead|ship it|lgtm|all set|perfect,? (thanks|send))\b/i]],
  ['scope',    [/\b(how much|what would it cost|price|quote|invoice|contract|proposal|retainer)\b/i]],
  ['defect',   [/\b(broken|error|404|blank page|doesn'?t (work|load)|not working|still says|missing)\b/i]],
  ['content-change', [/\b(change|update|swap|replace|remove|delete|add|fix|correct|reword|shorten)\b/i]],
  ['question', [/\?/]],
];


/**
 * Classify a message body. Returns intent, confidence and the evidence, so a
 * human reading the proposal can see why rather than being told.
 */
export function classify(text = '') {
  const body = String(text);

  let intent = 'unclear';
  let matchedRule = null;
  for (const [name, patterns] of INTENT_RULES) {
    if (patterns.some((re) => re.test(body))) { intent = name; matchedRule = name; break; }
  }

  const recurrence = RECURRENCE_HINTS
    .filter(([re]) => re.test(body))
    .map(([, why]) => why);

  // Long messages carry more than one request more often than not, and a
  // single intent on a long message is a claim the classifier cannot support.
  const confidence = !matchedRule ? 'low'
    : body.length > 600 ? 'medium'
      : intent === 'question' ? 'medium'
        : 'high';

  return {
    intent,
    confidence,
    evidence: matchedRule
      ? `matched ${matchedRule}${body.length > 600 ? ' (long message — may contain more than one ask)' : ''}`
      : 'no intent pattern matched',
    recurrence,
  };
}

/**
 * Decide what happens next.
 *
 * `act` requires high confidence AND an intent whose remedy is confined to the
 * client's own content. Everything else asks.
 */
export function decide(classification) {
  const { intent, confidence, recurrence } = classification;

  const actionable = ['content-change', 'defect'].includes(intent);
  const action = actionable && confidence === 'high' ? 'act' : 'ask';

  return {
    action,
    proposal: recurrence.length > 0,
    reason: action === 'act'
      ? `${intent} at high confidence — remedy is inside the client repo`
      : intent === 'unclear'
        ? 'could not tell what is being asked'
        : ['question', 'approval', 'scope'].includes(intent)
          ? `${intent} is a reply, not a change`
          : `${intent} at ${confidence} confidence — too uncertain to edit a live site`,
  };
}

/**
 * Write a proposal: a systemic finding for a human to approve or reject.
 *
 * It lands as an untriaged-but-systemic change, which is what puts it on
 * `log open` and the dashboard queue. `routed_to` stays null until a human
 * decides where the general fix belongs — that unset field IS the queue.
 */
export async function writeProposal({
  slug, observed, hypothesis, affects, evidence, proposed, confidence, sourceRef = null,
}) {
  if (!['builder', 'website', 'both'].includes(affects)) {
    throw new Error(`writeProposal: affects must be builder, website or both — got "${affects}"`);
  }
  const detail = [
    `observed:    ${observed}`,
    `hypothesis:  ${hypothesis}`,
    `affects:     ${affects}`,
    `evidence:    ${evidence}`,
    `proposed:    ${proposed}`,
    `confidence:  ${confidence}`,
    '',
    'Not implemented. A builder change reaches every future practice and a',
    'website change is a public claim; both want a human. Approve by opening',
    'the PR and running: npm run log -- triage <id> --systemic yes --routed <url>',
  ].join('\n');

  return logEvent({
    slug,
    kind: 'decision',
    actor: 'router',
    summary: `PROPOSAL: ${observed}`,
    detail,
    sourceRef,
    systemic: null,       // untriaged on purpose — this is the human's queue
  });
}

/**
 * Run the router over communications that have not been routed yet.
 *
 * A communication is "unrouted" when nothing on the timeline references it,
 * which keeps this idempotent without a status column to maintain.
 */
export async function route({ slug = null, limit = 20, dryRun = false } = {}) {
  const rows = await d1Query(
    `SELECT e.* FROM client_events e
      WHERE e.kind = 'communication' AND e.direction = 'in'
        ${slug ? 'AND e.slug = ?' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM client_events r
           WHERE r.source_ref = 'routed:' || e.id
        )
      ORDER BY e.occurred_at ASC LIMIT ?`,
    slug ? [slug, limit] : [limit],
  );

  const out = [];
  for (const msg of rows) {
    const classification = classify(msg.detail || msg.summary);
    const decision = decide(classification);
    const result = { event: msg, ...classification, ...decision, proposalId: null };

    if (!dryRun) {
      // A marker event, so the same message is never routed twice.
      await logEvent({
        slug: msg.slug,
        kind: 'note',
        actor: 'router',
        summary: `routed: ${classification.intent} → ${decision.action}`,
        detail: `${decision.reason}\n\nre: ${msg.summary}`,
        sourceRef: `routed:${msg.id}`,
      });

      if (decision.proposal) {
        result.proposalId = await writeProposal({
          slug: msg.slug,
          observed: msg.summary,
          hypothesis: classification.recurrence.join('; '),
          affects: 'builder',
          evidence: `client message ${msg.id.slice(0, 8)} — ${classification.recurrence.length} recurrence signal(s)`,
          proposed: 'needs a human to root-cause before a fix is specified',
          confidence: classification.confidence,
          sourceRef: `proposal-for:${msg.id}`,
        });
      }
    }
    out.push(result);
  }
  return out;
}
