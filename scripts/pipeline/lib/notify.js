/**
 * Where the system reaches a human, and in what order.
 *
 * One branch of the router needs a person: a message it cannot read
 * confidently, or a decision that is not ours — pricing, scope, whether a
 * doctor actually practises somewhere. The question is which channel, and the
 * honest answer is that it depends on where you already are.
 *
 *   terminal   instant, free, zero setup — but only when you are at the
 *              machine. Best while you are working.
 *   email      reaches the phone you already carry, through an app you
 *              already open, with no new account. Best while you are not.
 *   telegram   a separate stream that is not your inbox, which matters once
 *              alerts would otherwise compete with client mail for attention.
 *
 * All configured channels are tried. Delivery is never the point of failure:
 * the ledger write happens first and unconditionally, so a question exists
 * whether or not any channel worked. Losing a notification is an
 * inconvenience; losing the question is a client waiting on an answer nobody
 * knows they owe.
 *
 * NOTIFY_CHANNELS picks and orders them, e.g. "terminal,email". Unset means
 * every channel that has credentials.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logEvent } from './events.js';

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Channels — each returns true on delivery, or throws
// ---------------------------------------------------------------------------

const CHANNELS = {
  /**
   * macOS notification centre, plus the line on stdout.
   *
   * The stdout write matters more than the banner: when this runs inside a
   * pipeline the operator is usually watching the log, and a banner that
   * appears while they are looking at a terminal is redundant.
   */
  terminal: {
    available: () => process.platform === 'darwin',
    async send({ title, text }) {
      console.log(`\n  ⟢ ${title}\n    ${text.split('\n').join('\n    ')}\n`);
      const esc = (s) => String(s).replace(/["\\]/g, '\\$&').slice(0, 200);
      await run('osascript', [
        '-e',
        `display notification "${esc(text.split('\n')[0])}" with title "${esc(title)}"`,
      ]).catch(() => {});   // a refused banner must not fail the ask
      return true;
    },
  },

  /** Mail to yourself — reaches the phone without a new app. */
  email: {
    available: () => !!(process.env.GMAIL_USER && (process.env.GMAIL_KEY_FILE || process.env.GOOGLE_SERVICE_ACCOUNT_PATH)),
    async send({ title, text }) {
      const { notifySelf } = await import('./gmail.js');
      await notifySelf({ subject: title, body: text });
      return true;
    },
  },

  /** A stream separate from the inbox the system is also reading. */
  telegram: {
    available: () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    async send({ title, text }) {
      const { sendMessage } = await import('./telegram.js');
      await sendMessage(`${title}\n\n${text}`);
      return true;
    },
  },
};

export const CHANNEL_NAMES = Object.keys(CHANNELS);

/** Which channels will actually be used, in order. */
export function activeChannels() {
  const requested = (process.env.NOTIFY_CHANNELS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const names = requested.length ? requested : CHANNEL_NAMES;
  return names.filter((n) => CHANNELS[n]?.available());
}

async function dispatch({ title, text }) {
  const results = [];
  for (const name of activeChannels()) {
    try {
      await CHANNELS[name].send({ title, text });
      results.push({ channel: name, delivered: true });
    } catch (err) {
      results.push({ channel: name, delivered: false, error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------

/**
 * Ask a question that is blocking work.
 *
 * The ledger write is first and unconditional. Everything after it is best
 * effort.
 */
export async function ask({ slug, question, context = null, options = [], sourceRef = null }) {
  if (!slug) throw new Error('ask: slug is required');
  if (!question) throw new Error('ask: question is required');

  const eventId = await logEvent({
    slug,
    kind: 'decision',
    actor: 'router',
    summary: `ASK: ${question}`,
    detail: [
      context ? `context: ${context}` : null,
      options.length ? `options: ${options.join(' | ')}` : null,
      '',
      'Blocking. Answer in a session, or on the dashboard.',
    ].filter((l) => l !== null).join('\n'),
    sourceRef,
  });

  const text = [
    question,
    context ? `\n${context}` : '',
    options.length ? `\nOptions: ${options.join(' | ')}` : '',
    `\nref ${eventId.slice(0, 8)}  ·  npm run log -- open`,
  ].filter(Boolean).join('\n');

  const results = await dispatch({ title: `${slug} — needs a decision`, text });
  return {
    eventId,
    delivered: results.some((r) => r.delivered),
    channels: results,
  };
}

/** Tell, rather than ask. Blocks nothing; use sparingly. */
export async function notify({ slug, message, sourceRef = null, log = true }) {
  let eventId = null;
  if (log) {
    eventId = await logEvent({
      slug: slug || '_platform',
      kind: 'note',
      actor: 'notify',
      summary: message.slice(0, 300),
      sourceRef,
    });
  }
  const results = await dispatch({ title: slug || 'groundwork', text: message });
  return { eventId, delivered: results.some((r) => r.delivered), channels: results };
}
