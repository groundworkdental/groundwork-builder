# client-inbox — inbound client email becomes ledger events

## What problem this solves

Client feedback arrives as email, so it lives in an inbox. An inbox is
invisible to everything else: the pipeline cannot see it, an agent cannot read
it, and nothing can answer *"what has this practice asked us for?"* The only
path into the system is a human retyping it — and the things a human has to
remember are the things that get dropped.

This makes each message a row on the practice's timeline. Feedback becomes
**system state** instead of **inbox state**.

It does not replace your inbox. Every message is still forwarded to
`FORWARD_TO`, because a parser bug must never be able to lose a client's
email.

## Routing: the address is the slug

```
mansfielddds@in.groundworkdental.com   ->  slug 'mansfielddds'
mansfielddds+urgent@…                  ->  slug 'mansfielddds'  (+tags stripped)
```

Deliberate. Guessing the practice from the sender's domain or the subject line
is a heuristic, and a heuristic that files a message under the wrong practice
is worse than not filing it — it puts words in a client's mouth on someone
else's timeline. An address that doesn't match a known `accounts.slug` is
forwarded and logged under `_unrouted`, never guessed at.

**A subdomain is used on purpose.** `groundworkdental.com`'s MX belongs to
Google Workspace. This must not touch the mail you and the practice actually
use, so it lives on `in.groundworkdental.com` and leaves the apex alone.

## Setup

Email Routing needs a token scope the pipeline token doesn't carry, so the
first two steps are dashboard work.

1. **Cloudflare → Email → Email Routing**, enable it for
   `in.groundworkdental.com`. Cloudflare adds that subdomain's MX records; it
   does not alter the apex.

2. **Routing rules**: add a catch-all for the subdomain routed to this Worker.
   Per-address rules also work but need one per client, which defeats the
   point.

3. **Deploy:**
   ```bash
   cd workers/client-inbox && npx wrangler deploy
   ```

4. **Give each client the address** as the reply-to on anything you send them:
   `<slug>@in.groundworkdental.com`.

## Verifying

```bash
# send a message to mansfielddds@in.groundworkdental.com, then:
npm run log -- timeline mansfielddds
```

The message should appear as `communication ←` with the subject as summary,
and the mail should also land in `FORWARD_TO`.

Duplicate `Message-ID`s are ignored, so a Cloudflare retry cannot double-log.

## Outbound

The other half lives in `scripts/pipeline/lib/email-out.js`, not here.
`draftReply()` records what we intend to say; `sendReply()` refuses to send
without `approved: true` and logs as a side effect of sending — sending and
logging are one call, because two steps means the second gets skipped.

`sendReply` takes a `transport` function rather than owning one. The pipeline
has no mail transport, and inventing one here would create a second place that
knows how to email a client.
