#!/usr/bin/env node
/**
 * log — the client ledger, from the command line.
 *
 *   npm run log -- add <slug> <kind> "<summary>" [flags]
 *   npm run log -- open [slug]
 *   npm run log -- timeline <slug>
 *   npm run log -- triage <id> --systemic yes --routed <url>
 *
 * Kinds: communication, change, decision, run, gate, launch, note
 *
 * Flags:
 *   --detail <text>     body, reasoning, a diff — anything longer than a line
 *   --ref <ref>         commit sha, PR url, message id, build id
 *   --in | --out        direction, for a communication
 *   --systemic yes|no   would this defect exist on the next site we build?
 *   --routed <url>      where the general fix lives (requires --systemic yes)
 *   --actor <who>       defaults to $GROUNDWORK_OPERATOR
 *   --at <iso>          when it happened, if not now
 *
 * Examples:
 *
 *   npm run log -- add mansfielddds communication "Dr. Patel wants the hero photo swapped" --in
 *   npm run log -- add mansfielddds change "Swapped hero to the new exterior shot" --ref 4f21a9c
 *   npm run log -- open
 *   npm run log -- triage 9f3c… --systemic yes --routed https://github.com/…/pull/72
 */

import { logEvent, timeline, openTriage, triage, EVENT_KINDS, d1Enabled } from './pipeline/lib/events.js';

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') flags.direction = 'in';
    else if (a === '--out') flags.direction = 'out';
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

const short = (id) => String(id).slice(0, 8);
const when = (iso) => String(iso).replace('T', ' ').slice(0, 16);

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (!command || command === 'help') {
    console.log(`log — the client ledger

  add <slug> <kind> "<summary>"   record something that happened
  open [slug]                     changes still needing triage or routing
  timeline <slug>                 everything, oldest first
  triage <id> --systemic yes|no [--routed <url>]

kinds: ${EVENT_KINDS.join(', ')}`);
    process.exit(command ? 0 : 2);
  }

  if (!d1Enabled()) {
    console.error(
      'D1 is not configured. Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID\n' +
      'and CLOUDFLARE_API_TOKEN — run through `npm run log` so .env is loaded.',
    );
    process.exit(2);
  }

  if (command === 'add') {
    const [slug, kind, ...summaryParts] = rest;
    const summary = summaryParts.join(' ');
    if (!slug || !kind || !summary) {
      console.error('usage: log add <slug> <kind> "<summary>"');
      process.exit(2);
    }
    const id = await logEvent({
      slug, kind, summary,
      detail: flags.detail ?? null,
      sourceRef: flags.ref ?? null,
      direction: flags.direction ?? null,
      systemic: flags.systemic ?? null,
      routedTo: flags.routed ?? null,
      actor: flags.actor,
      occurredAt: flags.at ?? null,
    });
    console.log(`logged ${short(id)}  ${slug}  ${kind}`);
    if (kind === 'change' && !flags.systemic) {
      console.log('  untriaged — would this defect exist on the next site? `log open` will keep asking.');
    }
    return;
  }

  if (command === 'open') {
    const { untriaged, unrouted } = await openTriage({ slug: rest[0] ?? null });
    if (!untriaged.length && !unrouted.length) {
      console.log('nothing open — every change is triaged and every systemic one is routed.');
      return;
    }
    if (untriaged.length) {
      console.log(`\nNEEDS A DECISION (${untriaged.length})\n`);
      for (const e of untriaged) {
        const kind = e.kind === 'decision' ? 'proposal' : 'triage';
        console.log(`  ${short(e.id)}  ${when(e.occurred_at)}  [${kind}]  ${e.slug}  ${e.summary}`);
      }
    }
    if (unrouted.length) {
      console.log(`\nSYSTEMIC BUT UNROUTED (${unrouted.length}) — the general fix has no home yet\n`);
      for (const e of unrouted) {
        console.log(`  ${short(e.id)}  ${when(e.occurred_at)}  ${e.slug}  ${e.summary}`);
      }
    }
    console.log('');
    return;
  }

  if (command === 'timeline') {
    const slug = rest[0];
    if (!slug) { console.error('usage: log timeline <slug>'); process.exit(2); }
    const rows = await timeline(slug);
    if (!rows.length) { console.log(`no events for ${slug}`); return; }
    console.log(`\n${slug} — ${rows.length} event(s)\n`);
    for (const e of rows) {
      const dir = e.direction ? ` ${e.direction === 'in' ? '←' : '→'}` : '';
      const mark = e.kind === 'change'
        ? (e.systemic === 'yes' ? (e.routed_to ? ' [routed]' : ' [SYSTEMIC, unrouted]')
          : e.systemic === 'no' ? '' : ' [untriaged]')
        : '';
      console.log(`  ${when(e.occurred_at)}  ${e.kind.padEnd(13)}${dir} ${e.summary}${mark}`);
      if (e.source_ref) console.log(`${' '.repeat(33)}${e.source_ref}`);
    }
    console.log('');
    return;
  }

  if (command === 'triage') {
    const id = rest[0];
    if (!id || !flags.systemic) {
      console.error('usage: log triage <id> --systemic yes|no [--routed <url>]');
      process.exit(2);
    }
    await triage(id, { systemic: flags.systemic, routedTo: flags.routed ?? null });
    console.log(`triaged ${short(id)} → systemic=${flags.systemic}${flags.routed ? ` routed=${flags.routed}` : ''}`);
    return;
  }

  console.error(`unknown command "${command}" — try: add, open, timeline, triage`);
  process.exit(2);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
