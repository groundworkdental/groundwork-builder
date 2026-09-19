# Reaching a human — terminal, email, Telegram

## Channels

Three, tried in order, all optional:

| | reaches you | setup |
|---|---|---|
| `terminal` | at the machine, instantly | none — macOS notification + stdout |
| `email` | the phone you already carry | none beyond Gmail, which is already wired |
| `telegram` | a stream separate from your inbox | a bot token |

`NOTIFY_CHANNELS=terminal,email` picks and orders them. Unset means every
channel that has credentials.

Email is the best default: it reaches a phone through an app you already open,
with no new account, and it is the one channel that works whether or not you
are at the desk. Terminal is the best companion to it — free, instant, and
silent when you are not there. Telegram earns its place only once alerts would
otherwise compete with client mail for your attention.

## What it is for

One branch of the router needs a human: a client message that is ambiguous, or
a decision that is not ours to make — pricing, scope, whether a doctor actually
practises at a location. Before this, "ask the human" meant waiting until
someone opened a session, which is the weakest link in a loop meant to run
unattended.

## What it is not for

Builds, runs, deploys, gate results, or anything that happens several times a
day. **A channel that pings constantly is one you mute, and a muted channel is
worse than no channel** — the system now believes it can reach you and it
cannot.

If this gets noisy, that is a bug in what is calling it, not a reason to turn
off notifications.

## Setup

**1. Create a bot.** Message [@BotFather](https://t.me/botfather) on Telegram:

```
/newbot
```

Give it a name and a username. It replies with a token like
`8123456789:AAH…`. That token can post as the bot, so treat it like a
password — `.env`, never a repo.

**2. Get your chat id.** Send your new bot any message first (a bot cannot
start a conversation), then:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[0-9-]*' | head -1
```

**3. `.env`:**

```
TELEGRAM_BOT_TOKEN=8123456789:AAH…
TELEGRAM_CHAT_ID=123456789
```

**4. Verify:**

```bash
npm run tg -- test
```

You should get one message. If nothing arrives, the usual cause is step 2 —
the bot cannot message you until you have messaged it.

## Use

```bash
npm run tg -- test                       # confirm the wiring
npm run tg -- ask <slug> "question"      # ask something blocking
npm run tg -- notify <slug> "message"    # tell, blocks nothing
```

The router calls `ask()` on its own whenever it decides a message needs a
human, so the common case needs no command at all.

## Why the ledger write comes first

`ask()` writes the question to `client_events` **before** it tries to send.
Telegram is the unreliable part, not the record. If delivery fails, the
question is still on the practice's timeline and still shows up in
`npm run log -- open` and on the dashboard — and the caller is told
`delivered: false` rather than having an exception thrown into the middle of a
pipeline run.

Losing a notification is an inconvenience. Losing the question is a client
waiting on an answer nobody knows they owe.
