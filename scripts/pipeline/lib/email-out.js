/**
 * Outbound client email — drafted, approved, sent, logged.
 *
 * The important property is that sending and logging are ONE call. If they
 * are two steps, the second gets skipped, and half a conversation on the
 * timeline is worse than none: it reads as complete while missing the reply
 * that actually mattered.
 *
 * Same reasoning as BeforeAfter refusing an image without provenance, and
 * triage refusing a systemic change without a destination. Where the
 * bookkeeping is the thing people drop, the API has to carry it.
 *
 * Nothing here sends without an explicit approval flag. A drafted reply is a
 * proposal — it lands on the timeline as a draft, and becomes 'sent' only
 * when a human says so.
 */

import { logEvent } from './events.js';

/**
 * Record a drafted reply without sending it.
 *
 * The draft is a real event: what we intend to say to a client is worth
 * keeping even when it is revised or discarded, because the revision is
 * usually where the useful reasoning lives.
 *
 * @returns {Promise<string>} the event id — pass it to send() as approvalOf
 */
export async function draftReply({ slug, to, subject, body, inReplyTo = null, actor = 'agent' }) {
  if (!slug) throw new Error('draftReply: slug is required');
  if (!to) throw new Error('draftReply: to is required');
  if (!subject) throw new Error('draftReply: subject is required');
  if (!body) throw new Error('draftReply: body is required');

  return logEvent({
    slug,
    kind: 'communication',
    direction: 'out',
    actor,
    summary: `DRAFT: ${subject}`,
    detail: [`To: ${to}`, inReplyTo ? `In-Reply-To: ${inReplyTo}` : null, '', body]
      .filter((l) => l !== null)
      .join('\n'),
    sourceRef: inReplyTo ? `draft-reply-to:${inReplyTo}` : null,
  });
}

/**
 * Send a previously drafted reply. Requires explicit approval.
 *
 * `send` is a transport function: it is given something that can actually put
 * mail on the wire, rather than reaching for one. The pipeline has no mail
 * transport of its own, and inventing one here would mean a second place that
 * knows how to email a client.
 *
 * @param {object} args
 * @param {boolean} args.approved  must be literally true
 * @param {(msg: {to,subject,body,inReplyTo}) => Promise<{id?:string}>} args.transport
 */
export async function sendReply({
  slug, to, subject, body, inReplyTo = null,
  approved = false, approvalOf = null, transport, actor = 'operator',
}) {
  if (approved !== true) {
    throw new Error(
      'sendReply: refusing to send without approved: true — a draft is a proposal, ' +
      'and a client reply is not something an agent decides to send on its own',
    );
  }
  if (typeof transport !== 'function') {
    throw new Error('sendReply: a transport function is required');
  }

  const result = await transport({ to, subject, body, inReplyTo });

  await logEvent({
    slug,
    kind: 'communication',
    direction: 'out',
    actor,
    summary: subject,
    detail: [`To: ${to}`, inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      approvalOf ? `Approved draft: ${approvalOf}` : null, '', body]
      .filter((l) => l !== null)
      .join('\n'),
    sourceRef: result?.id || (inReplyTo ? `reply-to:${inReplyTo}` : null),
  });

  return result;
}
