/**
 * client-inbox — inbound client email becomes ledger events.
 *
 * WHY THIS EXISTS
 *
 * Client feedback arrives as email, which means it lives in an inbox. An
 * inbox is invisible to everything else: the pipeline cannot see it, an agent
 * cannot read it, and nothing can ask "what has this practice asked us for?"
 * The only way it reaches the system today is a human retyping it, and the
 * things a human has to remember to do are exactly the things that get
 * dropped — the same failure that left ten of twelve generator rules adopted
 * and two forgotten.
 *
 * This turns each message into a row on the practice's timeline, so feedback
 * is system state rather than inbox state. Nothing else changes: the mail is
 * still forwarded to the human inbox, because a parser bug must never be able
 * to lose a client's email.
 *
 * ROUTING
 *
 * The local part of the address IS the account slug:
 *
 *     mansfielddds@in.groundworkdental.com  ->  slug 'mansfielddds'
 *
 * That is deliberate. Guessing the practice from the sender's domain or the
 * subject line is a heuristic, and a heuristic that files a message under the
 * wrong practice is worse than not filing it: it puts words in a client's
 * mouth on someone else's timeline. An address that does not match a known
 * account is forwarded and logged under the reserved slug '_unrouted' rather
 * than guessed at.
 *
 * A subdomain is used because the apex MX belongs to Google Workspace, and
 * this must not touch the mail the practice and the operator actually use.
 */

const UNROUTED = '_unrouted';
const MAX_DETAIL = 16_000;   // a long thread is still a row, not a document

/** Slug rules mirror the pipeline's: lowercase, alphanumeric and dashes. */
function slugFromAddress(address) {
  const local = String(address || '').split('@')[0].toLowerCase().trim();
  // Strip +tags so mansfielddds+urgent@ still files correctly.
  const base = local.split('+')[0];
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(base) ? base : null;
}

async function readStream(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  return new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const merged = new Uint8Array(acc.length + c.length);
      merged.set(acc); merged.set(c, acc.length);
      return merged;
    }, new Uint8Array()),
  );
}

/**
 * Pull the human-readable part out of a raw MIME message.
 *
 * Deliberately shallow: headers, then the first text/plain part, then a tag
 * strip if the message is HTML only. A full MIME parser in an email path is a
 * liability — this only needs to be good enough that a person reading the
 * ledger recognises what was said, and the original is forwarded intact.
 */
function extractBody(raw) {
  const split = raw.indexOf('\r\n\r\n') !== -1 ? '\r\n\r\n' : '\n\n';
  let body = raw.slice(raw.indexOf(split) + split.length);

  const plain = body.match(/Content-Type:\s*text\/plain[\s\S]*?(?:\r?\n){2}([\s\S]*?)(?=\r?\n--|\r?\n*$)/i);
  if (plain) body = plain[1];
  else if (/<html/i.test(body)) body = body.replace(/<[^>]+>/g, ' ');

  return body
    .replace(/=\r?\n/g, '')            // quoted-printable soft breaks
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DETAIL);
}

/** Trim a reply chain to the part that is actually new. */
function topOfThread(body) {
  const cut = body.search(/^(On .+ wrote:|-----Original Message-----|_{10,}|From:\s.+@)/m);
  if (cut === -1) return body.replace(/\n{3,}/g, '\n\n').trim();
  const head = body.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim();
  // A message that is ONLY a quoted chain has nothing above the marker. Keep
  // the whole thing rather than filing an empty row; an arbitrary character
  // threshold here silently dropped real two-line replies.
  return head.length ? head : body.replace(/\n{3,}/g, '\n\n').trim();
}

async function knownAccount(db, slug) {
  const row = await db.prepare('SELECT slug FROM accounts WHERE slug = ?').bind(slug).first();
  return !!row;
}

export default {
  /**
   * @param {ForwardableEmailMessage} message
   */
  async email(message, env, ctx) {
    const messageId = message.headers.get('message-id') || `no-id-${Date.now()}`;

    // Forward first. If logging throws, the human still gets the mail — the
    // ledger is an improvement on an inbox, never a replacement for one.
    const forward = env.FORWARD_TO
      ? message.forward(env.FORWARD_TO).catch((err) => {
          console.error('forward failed', messageId, err.message);
        })
      : Promise.resolve();

    try {
      const candidate = slugFromAddress(message.to);
      const slug = candidate && (await knownAccount(env.DB, candidate)) ? candidate : UNROUTED;

      const subject = (message.headers.get('subject') || '(no subject)').slice(0, 300);
      const from = message.headers.get('from') || String(message.from || 'unknown');
      const dateHeader = message.headers.get('date');
      const occurredAt = dateHeader && !Number.isNaN(Date.parse(dateHeader))
        ? new Date(dateHeader).toISOString()
        : new Date().toISOString();

      // Same Message-ID twice means a retry, not a second email.
      const seen = await env.DB
        .prepare('SELECT id FROM client_events WHERE source_ref = ?')
        .bind(messageId).first();

      if (!seen) {
        const raw = await readStream(message.raw, 256_000);
        const detail = topOfThread(extractBody(raw));
        const note = slug === UNROUTED && candidate
          ? `\n\n[unrouted: no account with slug "${candidate}"]`
          : slug === UNROUTED ? '\n\n[unrouted: address did not name an account]' : '';

        await env.DB.prepare(
          `INSERT INTO client_events
             (id, slug, occurred_at, kind, direction, actor, summary, detail, source_ref, systemic, routed_to, created_at)
           VALUES (?,?,?,'communication','in',?,?,?,?,NULL,NULL,?)`,
        ).bind(
          crypto.randomUUID(),
          slug,
          occurredAt,
          from.slice(0, 200),
          subject,
          (detail + note).slice(0, MAX_DETAIL),
          messageId,
          new Date().toISOString(),
        ).run();
      }
    } catch (err) {
      // Never reject the message over a logging failure.
      console.error('ledger write failed', messageId, err.message);
    }

    ctx.waitUntil(forward);
  },
};
