# Platform gotchas — Cloudflare Pages, Astro, Google

Behaviours that cost us real time on a live client build. Each one is
counter-intuitive enough that knowing the rule is the whole fix.

---

## Cloudflare Pages

### `wrangler.toml` supersedes dashboard variables

If a `wrangler.toml` exists at the repo root, Pages reads build configuration
from it and **ignores variables set in the dashboard**. There is no warning.
The build log simply lists fewer variables than you set:

```
Found wrangler.toml file. Reading build configuration...
Build environment variables:
  - NODE_VERSION: 22
```

A GA4 measurement id added through *Settings → Variables and Secrets* was
silently dropped from three consecutive builds. "Retry deployment" never helps,
because the variable is not reaching the build at all.

**Rule:** every `PUBLIC_*` build variable goes in `[vars]` in `wrangler.toml`.
Dashboard variables are only for projects with no Wrangler config. Values that
ship in page source (a GA4 id, a Turnstile site key) are not secrets and belong
in the committed file; genuine secrets still go in the dashboard as encrypted
secrets and must be read at runtime, not build time.

`verify-launch.js` checks this.

### `_redirects` beats static assets

Pages evaluates `_redirects` **before** serving files from the build output. A
path with both a page in `dist/` and a redirect rule will 301 — the page never
wins. This is the opposite of the usual "real file takes precedence" intuition.

The practical failure is subtler than a broken URL: the page still *builds*, so
`@astrojs/sitemap` sweeps it into the sitemap, and you publish a sitemap URL
that redirects. Search Console reports these as **"Page with redirect"**.

**Rule:** if you redirect a path, delete the page. `verify-launch.js` cross-
checks the sitemap against `_redirects`.

### `www` and apex both serve 200 by default

Attaching both hostnames to a Pages project makes both serve the site
independently. Canonical tags are a hint; they do not consolidate the two.

**Rule:** at go-live, add a Redirect Rule — match `Hostname equals
www.<domain>`, dynamic redirect to `concat("https://<domain>",
http.request.uri.path)`, 301, preserve query string. The path expression
matters: without it every www URL lands on the homepage. Preserve query string
matters too, or GBP's UTM parameters are stripped.

### Account and role traps

- A zone may live in a **client's or their MSP's** Cloudflare account, not ours.
  Establish who owns it during onboarding, not at launch.
- An API token can only grant permissions **the creating user already holds**.
  A member with read-only DNS gets `Unauthorized to access requested resource`
  at the review step. Fix the role first, or have the owner mint the token.
- Two Pages projects can share a name across accounts. Confirm which project
  serves the domain by checking its **Custom domains** tab — not the name.

---

## Astro

### An unset config value renders as broken output, not absent output

`site.phone = ''` produced `href="tel:"` in two places, one of them wrapping
empty link text, so a page read *"call us at ."* with an empty clickable link.
Templates interpolate empty strings happily.

**Rule:** guard at the point of use (`{site.phoneDigits && ...}`), and prefer a
spread-conditional for list entries so the item disappears rather than
rendering hollow. `verify-launch.js` fails the build on `href="tel:"`,
`href="mailto:"` and `href=""`.

### Draft filtering must be repeated in `getStaticPaths`

Filtering drafts on the index page is not enough. `/blog/[slug]` calls
`getCollection('blog')` separately, so a draft still gets a built page and a
sitemap entry — it is merely unlinked. An unwritten stub was live and indexed
on a client site with its section placeholders intact.

**Rule:** filter in both places:

```js
const posts = await getCollection('blog', ({ data }) => !data.draft);
```

### Generate `robots.txt`, don't ship it

A static `public/robots.txt` cannot know the production origin, so the scaffold
placeholder (`https://example.com/sitemap-index.xml`) reaches production
whenever someone forgets. It did. Search Console submission was blocked until
someone noticed by hand.

`src/pages/robots.txt.ts` reads `site` from `astro.config.mjs`, so it cannot
drift.

---

## Google

### Business Profile API is gated; there is no API key

The Business Profile APIs take **OAuth 2.0 user credentials** only — API keys
are rejected. Access also requires an approved application through Google's
Business Profile API access request form, tied to a GCP project, which takes
days to weeks and is aimed at bulk multi-location managers.

For a single practice, the API is slower than doing it by hand, and category or
name edits trigger re-review regardless of how they are submitted. **Worth
applying at agency scale** (bulk hours, programmatic posts, review reporting) —
never worth blocking a launch on.

### Analytics Admin API cannot create accounts

It can create **properties inside an existing account**; account creation is
console-only. It also needs OAuth scopes the default `gcloud` token lacks —
a bare access token returns `ACCESS_TOKEN_SCOPE_INSUFFICIENT`.

For one property, do it in the console.

### Google aliases cannot sign in

An alias only receives mail. `hello@` as an alias of `garrett@` means you log in
as `garrett@`. This matters when deciding which identity owns client assets —
see the ownership rules in the Groundwork Dental playbook.

### Search Console: use a Domain property

Domain properties cover apex, `www` and every subdomain in one property, at the
cost of a DNS TXT record. URL-prefix properties are easier to verify and cover
less. Take the DNS step.
