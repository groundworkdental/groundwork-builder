/**
 * Gmail, as a library the pipeline and an agent can both call.
 *
 * Client conversation goes through the inbox the practice already writes to.
 * The alternative — a separate capture address — only works if every outgoing
 * message carries the right reply-to, and one forgotten header silently drops
 * a client's feedback out of the system. Mail lands where it lands; read it
 * there.
 */

import { accessToken } from './google-jwt.js';
import { logEvent } from './events.js';
import { d1Query } from './d1.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

function settings() {
  const keyPath = process.env.GMAIL_KEY_FILE
    || process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const subject = process.env.GMAIL_USER;
  if (!keyPath) throw new Error('set GMAIL_KEY_FILE (or GOOGLE_SERVICE_ACCOUNT_PATH) in .env');
  if (!subject) throw new Error('set GMAIL_USER in .env — the mailbox to act as');
  return { keyPath, subject };
}

export function gmailConfigured() {
  try { settings(); return true; } catch { return false; }
}

async function api(path, { method = 'GET', body = null } = {}) {
  const { keyPath, subject } = settings();
  const token = await accessToken({ keyPath, scopes: SCOPES, subject });
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`gmail ${method} ${path} → ${res.status} ${data?.error?.message || ''}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';

/** Depth-first walk for the first text/plain part; falls back to stripped HTML. */
function bodyOf(payload) {
  const decode = (d) => Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const find = (part, mime) => {
    if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
    for (const child of part.parts || []) {
      const hit = find(child, mime);
      if (hit) return hit;
    }
    return null;
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain;
  const html = find(payload, 'text/html');
  return html ? html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ') : '';
}

/** Trim a reply chain to what is actually new. */
export function topOfThread(body) {
  // Drop quoted lines first. A client replying inline quotes our own earlier
  // message back at us with ">" prefixes, and everything downstream then reads
  // our words as theirs: the router found "coming soon" and "TBD" in three
  // messages and raised proposals about scaffold text reaching a client, when
  // the client was quoting an email in which we described fixing exactly that.
  // Evidence drawn from your own prior sentence is not evidence.
  const unquoted = body
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');

  const cut = unquoted.search(/^(On .+ wrote:|-----Original Message-----|_{10,}|From:\s.+@)/m);
  const trimmed = cut === -1 ? unquoted : unquoted.slice(0, cut);
  const head = trimmed.replace(/\n{3,}/g, '\n\n').trim();

  // A message that is ONLY quotation has nothing of its own. Keep the original
  // rather than filing an empty row.
  return head.length ? head : body.replace(/\n{3,}/g, '\n\n').trim();
}

export async function listMessages({ query = 'is:unread', max = 20 } = {}) {
  const data = await api(`/messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
  return data.messages || [];
}

export async function getMessage(id) {
  const msg = await api(`/messages/${id}?format=full`);
  return {
    id: msg.id,
    threadId: msg.threadId,
    messageId: header(msg, 'message-id'),
    from: header(msg, 'from'),
    to: header(msg, 'to'),
    subject: header(msg, 'subject') || '(no subject)',
    date: header(msg, 'date'),
    body: topOfThread(bodyOf(msg.payload || {})),
    labelIds: msg.labelIds || [],
  };
}

export async function markRead(id) {
  await api(`/messages/${id}/modify`, { method: 'POST', body: { removeLabelIds: ['UNREAD'] } });
}

// ---------------------------------------------------------------------------
// Routing a message to a practice
// ---------------------------------------------------------------------------

/**
 * Decide which practice a message belongs to, and say how confident that is.
 *
 * Only two signals count as certain: the sender is the account's recorded
 * contact, or the sender's domain is the practice's own domain. Everything
 * else returns null. Filing a message under the wrong practice is worse than
 * not filing it — it puts words in a client's mouth on someone else's
 * timeline, and nobody re-reads a row that already looks filed.
 */
export async function routeToAccount(fromHeader) {
  const email = (String(fromHeader).match(/<([^>]+)>/)?.[1] || String(fromHeader)).trim().toLowerCase();
  if (!email.includes('@')) return { slug: null, reason: 'no address in From header' };
  const domain = email.split('@')[1];

  const byContact = await d1Query(
    `SELECT slug FROM accounts WHERE lower(contact_email) = ? OR lower(business_email) = ?`,
    [email, email],
  );
  if (byContact.length === 1) return { slug: byContact[0].slug, reason: `contact email matches ${email}` };
  if (byContact.length > 1) return { slug: null, reason: `${email} is the contact for ${byContact.length} accounts` };

  const byDomain = await d1Query(
    `SELECT slug FROM accounts WHERE practice_url LIKE ? OR practice_url LIKE ?`,
    [`%${domain}%`, `%${domain.replace(/^www\./, '')}%`],
  );
  if (byDomain.length === 1) return { slug: byDomain[0].slug, reason: `sender domain matches ${domain}` };
  if (byDomain.length > 1) return { slug: null, reason: `domain ${domain} matches ${byDomain.length} accounts` };

  return { slug: null, reason: `no account matches ${email}` };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Pull matching mail onto the ledger. Idempotent on RFC Message-ID.
 *
 * Unroutable mail is reported, not filed: an unattributed row is a guess
 * wearing a timestamp.
 */
export async function ingest({ query = 'is:unread', max = 20, markSeen = false } = {}) {
  const { subject: me } = settings();
  const results = { logged: [], skipped: [], unrouted: [] };
  for (const { id } of await listMessages({ query, max })) {
    const msg = await getMessage(id);

    const seen = await d1Query(
      `SELECT id FROM client_events WHERE source_ref = ?`, [msg.messageId],
    );
    if (seen.length) { results.skipped.push(msg); continue; }

    // A thread contains our own replies as well as theirs. Routing those by
    // SENDER files them as unrouted mail from a stranger, when they are in
    // fact our side of a conversation we already know the practice for — so
    // route our own messages by recipient, and record them as outbound.
    const mine = String(msg.from).toLowerCase().includes(String(me).toLowerCase());
    const { slug, reason } = mine
      ? await routeToAccount(msg.to)
      : await routeToAccount(msg.from);
    const direction = mine ? 'out' : 'in';

    if (!slug) { results.unrouted.push({ ...msg, reason, direction }); continue; }

    await logEvent({
      slug,
      kind: 'communication',
      direction,
      actor: msg.from.slice(0, 200),
      summary: msg.subject.slice(0, 300),
      detail: msg.body.slice(0, 16_000),
      sourceRef: msg.messageId,
      occurredAt: msg.date && !Number.isNaN(Date.parse(msg.date))
        ? new Date(msg.date).toISOString() : null,
    });
    if (markSeen) await markRead(id);
    results.logged.push({ ...msg, slug, reason, direction });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function mime({ to, from, subject, body, inReplyTo }) {
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    inReplyTo ? `References: ${inReplyTo}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].filter((l) => l !== null);
  return Buffer.from(lines.join('\r\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send, and log as a side effect of sending.
 *
 * Refuses without approved: true. An agent may compose a reply to a client;
 * it may not decide to send one.
 */
export async function send({ slug, to, subject, body, inReplyTo = null, threadId = null, approved = false, approvalOf = null }) {
  if (approved !== true) {
    throw new Error('gmail send: refusing without approved: true — a draft is a proposal, not a decision');
  }
  const { subject: from } = settings();
  const res = await api('/messages/send', {
    method: 'POST',
    body: { raw: mime({ to, from, subject, body, inReplyTo }), ...(threadId ? { threadId } : {}) },
  });

  await logEvent({
    slug,
    kind: 'communication',
    direction: 'out',
    actor: from,
    summary: subject,
    detail: [`To: ${to}`, approvalOf ? `Approved draft: ${approvalOf}` : null, '', body]
      .filter((l) => l !== null).join('\n'),
    sourceRef: res.id ? `gmail:${res.id}` : null,
  });
  return res;
}
