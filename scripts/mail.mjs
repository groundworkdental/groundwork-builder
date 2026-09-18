#!/usr/bin/env node
/**
 * mail — client email from the terminal, so it never needs a browser.
 *
 *   npm run mail -- inbox [--query "is:unread"] [--max 20]
 *   npm run mail -- ingest [--query …] [--mark-read]
 *   npm run mail -- read <messageId>
 *   npm run mail -- draft <slug> --to x@y --subject "…" --body "…" [--reply-to <msg-id>]
 *   npm run mail -- send <draftEventId> --approve
 *
 * `ingest` is the one that matters: it puts client mail on the ledger, keyed
 * to the practice, so everything downstream can see it. Everything else is
 * for reading and replying without leaving the session.
 */

import { listMessages, getMessage, ingest, routeToAccount, send, gmailConfigured } from './pipeline/lib/gmail.js';
import { logEvent, timeline } from './pipeline/lib/events.js';
import { d1Enabled } from './pipeline/lib/d1.js';

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--approve') flags.approve = true;
    else if (a === '--mark-read') flags.markRead = true;
    else if (a.startsWith('--')) flags[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

const line = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (!command || command === 'help') {
    console.log(`mail — client email, from here

  inbox [--query "is:unread"] [--max 20]   list, with the practice each maps to
  ingest [--query …] [--mark-read]         put client mail on the ledger
  read <messageId>                         one message in full
  draft <slug> --to --subject --body       record a reply as a proposal
  send <draftEventId> --approve            send it, and log the send`);
    process.exit(command ? 0 : 2);
  }

  if (!gmailConfigured()) {
    console.error(
      'Gmail is not configured. In .env:\n' +
      '  GMAIL_USER=you@groundworkdental.com     the mailbox to act as\n' +
      '  GMAIL_KEY_FILE=./_credentials/…json     service account key\n\n' +
      'The service account also needs domain-wide delegation — see docs/email.md.',
    );
    process.exit(2);
  }
  if (!d1Enabled()) {
    console.error('D1 is not configured — run through `npm run mail` so .env is loaded.');
    process.exit(2);
  }

  if (command === 'inbox') {
    const msgs = await listMessages({ query: flags.query || 'is:unread', max: Number(flags.max || 20) });
    if (!msgs.length) { console.log('nothing matching.'); return; }
    console.log('');
    for (const { id } of msgs) {
      const m = await getMessage(id);
      const { slug, reason } = await routeToAccount(m.from);
      console.log(`  ${id}  ${slug ? slug.padEnd(16) : '(unrouted)'.padEnd(16)} ${line(m.subject, 58)}`);
      console.log(`  ${' '.repeat(id.length)}  ${line(m.from, 40)}${slug ? '' : `  — ${reason}`}`);
    }
    console.log('');
    return;
  }

  if (command === 'ingest') {
    const r = await ingest({
      query: flags.query || 'is:unread',
      max: Number(flags.max || 20),
      markSeen: !!flags.markRead,
    });
    for (const m of r.logged) console.log(`  logged    ${m.slug.padEnd(16)} ${line(m.subject, 58)}`);
    for (const m of r.skipped) console.log(`  already   ${''.padEnd(16)} ${line(m.subject, 58)}`);
    for (const m of r.unrouted) {
      console.log(`  UNROUTED  ${''.padEnd(16)} ${line(m.subject, 58)}`);
      console.log(`            ${line(m.from, 40)} — ${m.reason}`);
    }
    console.log(`\n${r.logged.length} logged, ${r.skipped.length} already present, ${r.unrouted.length} unrouted\n`);
    if (r.unrouted.length) {
      console.log('Unrouted mail is reported, never filed under a guess. Set the account\'s');
      console.log('contact_email, or log it by hand with `npm run log -- add <slug> communication`.\n');
    }
    return;
  }

  if (command === 'read') {
    const m = await getMessage(rest[0]);
    const { slug } = await routeToAccount(m.from);
    console.log(`\nFrom:    ${m.from}\nSubject: ${m.subject}\nDate:    ${m.date}\nPractice:${slug ? ` ${slug}` : ' (unrouted)'}\nMsg-ID:  ${m.messageId}\n\n${m.body}\n`);
    return;
  }

  if (command === 'draft') {
    const slug = rest[0];
    if (!slug || !flags.to || !flags.subject || !flags.body) {
      console.error('usage: mail draft <slug> --to x@y --subject "…" --body "…" [--reply-to <msg-id>]');
      process.exit(2);
    }
    const id = await logEvent({
      slug, kind: 'communication', direction: 'out', actor: 'agent',
      summary: `DRAFT: ${flags.subject}`,
      detail: [`To: ${flags.to}`, flags.replyTo ? `In-Reply-To: ${flags.replyTo}` : null, '', flags.body]
        .filter((l) => l !== null).join('\n'),
      sourceRef: flags.replyTo ? `draft-reply-to:${flags.replyTo}` : null,
    });
    console.log(`\ndrafted ${id.slice(0, 8)} — not sent.\n`);
    console.log(`  To:      ${flags.to}\n  Subject: ${flags.subject}\n\n${flags.body}\n`);
    console.log(`Send with:  npm run mail -- send ${id.slice(0, 8)} --approve\n`);
    return;
  }

  if (command === 'send') {
    const draftId = rest[0];
    if (!draftId) { console.error('usage: mail send <draftEventId> --approve'); process.exit(2); }
    if (!flags.approve) {
      console.error('refusing without --approve. A drafted reply is a proposal; sending is yours.');
      process.exit(2);
    }
    // Find the draft by short id across every practice.
    const all = await timeline('%', { limit: 1 }).catch(() => []);
    void all;
    const { d1Query } = await import('./pipeline/lib/d1.js');
    const rows = await d1Query(
      `SELECT * FROM client_events WHERE kind='communication' AND direction='out'
         AND summary LIKE 'DRAFT:%' AND (id = ? OR id LIKE ?)`,
      [draftId, `${draftId}%`],
    );
    if (!rows.length) { console.error(`no draft matching "${draftId}"`); process.exit(1); }
    if (rows.length > 1) { console.error(`"${draftId}" matches ${rows.length} drafts — use more characters`); process.exit(1); }

    const draft = rows[0];
    const to = /^To:\s*(.+)$/m.exec(draft.detail)?.[1]?.trim();
    const replyTo = /^In-Reply-To:\s*(.+)$/m.exec(draft.detail)?.[1]?.trim() || null;
    const body = draft.detail.split('\n\n').slice(1).join('\n\n');
    const subject = draft.summary.replace(/^DRAFT:\s*/, '');
    if (!to) { console.error('draft has no To: line'); process.exit(1); }

    const res = await send({
      slug: draft.slug, to, subject, body, inReplyTo: replyTo,
      approved: true, approvalOf: draft.id,
    });
    console.log(`sent to ${to} (gmail ${res.id})`);
    return;
  }

  console.error(`unknown command "${command}" — try: inbox, ingest, read, draft, send`);
  process.exit(2);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
