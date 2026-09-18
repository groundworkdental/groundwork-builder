#!/usr/bin/env node
/**
 * tg — the interrupt channel from the terminal.
 *
 *   npm run tg -- test
 *   npm run tg -- ask <slug> "question" [--context "…"] [--options "a|b|c"]
 *   npm run tg -- notify <slug> "message"
 *
 * Only for questions that block work. See docs/telegram.md.
 */

import { ask, notify, selfTest, telegramConfigured } from './pipeline/lib/telegram.js';

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const [cmd, slug, ...rest] = pos;

if (!cmd || cmd === 'help') {
  console.log(`tg — the interrupt channel

  test                              confirm the bot can reach you
  ask <slug> "question"             ask something that blocks work
  notify <slug> "message"           tell; blocks nothing

  --context "…"   what prompted it
  --options "a|b" discrete choices`);
  process.exit(cmd ? 0 : 2);
}

if (!telegramConfigured()) {
  console.error('Telegram is not configured — see docs/telegram.md for TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
  process.exit(2);
}

try {
  if (cmd === 'test') {
    const r = await selfTest();
    console.log(`bot @${r.bot} reached chat ${r.chatId} — check your phone.`);
  } else if (cmd === 'ask') {
    if (!slug || !rest.length) { console.error('usage: tg ask <slug> "question"'); process.exit(2); }
    const r = await ask({
      slug,
      question: rest.join(' '),
      context: flags.context || null,
      options: flags.options ? flags.options.split('|').map((s) => s.trim()) : [],
    });
    console.log(`asked ${r.eventId.slice(0, 8)} — ${r.delivered ? 'delivered' : 'NOT delivered: ' + r.error}`);
    if (!r.delivered) console.log('The question is on the ledger regardless; it will show in `log open`.');
  } else if (cmd === 'notify') {
    if (!slug || !rest.length) { console.error('usage: tg notify <slug> "message"'); process.exit(2); }
    const r = await notify({ slug, message: rest.join(' ') });
    console.log(r.delivered ? 'sent.' : `NOT delivered: ${r.error}`);
  } else {
    console.error(`unknown command "${cmd}" — try: test, ask, notify`);
    process.exit(2);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
