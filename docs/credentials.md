# Credentials — what exists, where it lives, and why

One place to check when something says "unauthorised", and the list to work
from when rotating or handing over.

## The shape

**`.env` holds IDs, paths and the three secrets that have no file form.** Key
material lives in `~/.secrets/Groundwork/`, backed up in 1Password so a dead
laptop is an inconvenience rather than a business outage. Cloudflare holds its
own secrets for Workers and Pages; nothing is duplicated into the repo.

Seventeen live variables. It was forty-nine, of which thirty-five were read by
no code — three superseded Anthropic keys, six empty GBP placeholders, a
Railway token from a retired service, six Airtable variables from the CRM that
D1 replaced, and two Cloudflare tokens, one of which reached an unrelated
business's account.

## Cloudflare

One account matters: **Groundwork Dental** `a409f49a7107335a30ebdf9f4f954eb7`.
It holds D1, Pages, Workers, DNS, Access and R2. A second account exists
(`Hello@groundworkdental.com's`) and holds nothing.

One token, `groundworkbuilder`, widened one scope at a time as specific needs
arose. Keep doing that. Each wall it hit caught something: the Workers wall
revealed a worker that had never deployed, and the Access wall is the only
reason anyone noticed the ops dashboard was briefly serving the client ledger
to the public internet.

Current scopes: D1 Edit, Pages Edit, Workers Scripts Edit, Workers R2 Storage
Edit, Access (Apps + Identity Providers) Edit, Email Sending Edit, and per-zone
DNS Edit, Workers Routes Edit, Analytics Read.

**R2 S3 credentials are separate** and can only be minted in the dashboard:
R2 → Manage API Tokens → Create → Object Read & Write. They land in `.env` as
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

## Google

Two projects, and the split is historical rather than intentional:

| Project | Number | Owner | Holds |
|---|---|---|---|
| `groundworkdental` | 1054101464125 | the Workspace org | service account, OAuth clients |
| `groundwork-dental` | 657519989137 | a personal account | the old bucket, an old service account |

The hyphenated one predates the Workspace. Storage has moved to R2, so nothing
live depends on it any more; it is kept only until someone confirms the old
bucket has nothing worth keeping.

**One service account**: `groundworkdental@groundworkdental.iam.gserviceaccount.com`,
key at `~/.secrets/Groundwork/groundworkdental-*.json`, authorised for Gmail by
domain-wide delegation in the Workspace admin console (client id
`104570148203579312355`, three Gmail scopes).

A service-account key file is the right choice here, not a weakness. The
alternative — `gcloud auth application-default login` and impersonation — is
better for a human at a terminal and worse for what this system actually does,
because an unattended run at 3am has no browser to re-authenticate in when a
refresh token lapses.

**OAuth clients are a different kind of credential** and get confused with
service accounts because both have a field called `client_id`. A service
account signs its own assertions with a private key and needs no human. An
OAuth client exists to hand a *person* to Google and receive them back at a
registered URL. Cloudflare Access needs the second kind, `web` type, with
`https://groundworkdental.cloudflareaccess.com/cdn-cgi/access/callback`
registered. Its secret lives in Cloudflare, not here.

Google still does real work beyond Gmail: Places and PageSpeed run on API keys
today, and GA4, Search Console and Google Business Profile will each need their
own grant when they are configured. GBP has no service-account path at all — it
requires OAuth and a human manager's consent.

## What is not configured, despite appearances

- **GA4** — no property id was ever set
- **Search Console** — `GSC_SITE_URL` was still the literal `[DOMAIN]`
- **GBP** — blocked until the organisation is 60 days old

The playbook describes all three as delivered capability. They are not.

## Rotating

1. Create the replacement first, and confirm it works.
2. Update `.env` and `~/.secrets/Groundwork/`, then 1Password.
3. Only then revoke the old one.

Reversed, you discover what depended on it by breaking it. A key was rotated in
May and the path in `.env` pointed at the dead file for four months; nothing
noticed because the only consumer had also stopped being called.
