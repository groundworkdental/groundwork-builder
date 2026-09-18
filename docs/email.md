# Client email, from the terminal

## Why Gmail and not a capture address

Cloudflare Email Routing can receive but **cannot send**, so it could only ever
be half the loop — and the half it does cover needs clients to write to a new
address, which only works if every outgoing message carries the right
`reply-to`. One forgotten header and a client's feedback silently misses the
system.

Mail already goes to Gmail. Read it there, reply from there, and the practice
never has to learn a second address.

`workers/client-inbox/` still exists and is **not deployed**. It is a fine
capture path for machine mail — form notifications, alerts — where there is no
reply and the address is ours to choose. It is not the path for client
conversation.

## Why a service account rather than OAuth

Gmail has no service-account path of its own: mail belongs to a person, so
something has to act *as* that person. The usual answer is an OAuth flow with
a refresh token to store and rotate.

Workspace offers a better one. **Domain-wide delegation** lets an admin
authorise a service account to impersonate a user, so the key already on disk
becomes the only credential — no browser step, no refresh token. That matters
here because every path has to be callable from a terminal with nobody
watching it.

## Setup

One admin step, then two lines of config.

**1. Authorise the service account** — Workspace admin console:

```
Security → Access and data control → API controls → Domain-wide delegation
  → Add new

Client ID:  105978154019355515778
Scopes:     https://www.googleapis.com/auth/gmail.readonly
            https://www.googleapis.com/auth/gmail.send
            https://www.googleapis.com/auth/gmail.modify
```

The client ID is the `client_id` from the service account JSON, not the
`client_email`.

**2. Enable the Gmail API** in the `groundwork-dental` Cloud project.

**3. `.env`:**

```
GMAIL_USER=you@groundworkdental.com
GMAIL_KEY_FILE=./_credentials/groundwork-dental-e4d49e06a82a.json
```

`GMAIL_USER` is the mailbox to act as, and it must be a real user in the
Workspace domain.

**4. Verify:**

```bash
npm run mail -- inbox --query "newer_than:2d"
```

Each message prints with the practice it maps to, or `(unrouted)` and the
reason. If this returns `unauthorized_client`, step 1 has not propagated yet —
it can take a few minutes.

## Commands

```bash
npm run mail -- inbox [--query "is:unread"] [--max 20]
npm run mail -- ingest [--query …] [--mark-read]
npm run mail -- read <messageId>
npm run mail -- draft <slug> --to x@y --subject "…" --body "…" [--reply-to <msg-id>]
npm run mail -- send <draftEventId> --approve
```

`ingest` is the one that matters — it puts client mail on the ledger keyed to
the practice, which is what lets everything downstream see it.

## How a message finds its practice

Two signals count, and only two:

1. the sender is the account's `contact_email` or `business_email`
2. the sender's domain matches the account's `practice_url`

Anything else returns **unrouted**, and unrouted mail is *reported, never
filed*. Filing a message under the wrong practice is worse than not filing it:
it puts words in a client's mouth on someone else's timeline, and nobody
re-reads a row that already looks filed.

If a practice writes from an address you have not recorded, set
`accounts.contact_email` and re-run, or log it by hand:

```bash
npm run log -- add <slug> communication "what they said" --in
```

## Sending

`draft` records a proposal on the ledger and sends nothing. `send` refuses
without `--approve`, and logs **as a side effect of sending** — one call, so
the log cannot be the step that gets skipped.

An agent may compose a reply to a client. It may not decide to send one.
