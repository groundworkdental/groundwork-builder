# reports-site — prospect audit & pitch hosting

The staging tree for the **groundwork-reports** Cloudflare Pages project
(`https://reports.groundworkdental.com`). This replaced hosting audits and
pitches inside the groundwork-dental marketing repo (which now only carries
`/audits/*` and `/pitch/*` redirects here for links sent before the migration).

## Layout

- `public/audits/<slug>/` — audit summary (`index.html`), full report, before/after, screenshot
- `public/pitch/<slug>/` — pitch one-pager
- `functions/api/audit-preview-request.js` — lead-capture endpoint (Pages Function)
- `functions/lib/` — synced from `scripts/pipeline/lib/` by `host-reports.js` on every deploy — **do not edit here**

`public/audits/` and `public/pitch/` are **gitignored but must persist locally**:
direct-upload deploys replace the full asset set, so losing this directory
means older slugs disappear from the live site on the next deploy.

## How it deploys

`scripts/pipeline/lib/host-reports.js` stages report files here and runs
`wrangler pages deploy public --project-name groundwork-reports` (cwd: this
directory, so wrangler picks up `functions/`). Called from audit-site.js,
build-site.js (via publish.js), and rescue-build.js.

Env overrides: `REPORTS_PAGES_PROJECT` (default `groundwork-reports`),
`REPORTS_DOMAIN` (default `reports.groundworkdental.com`).

## One-time setup (operator)

```bash
# from repo root, with .env loaded
npx wrangler pages project create groundwork-reports --production-branch main --force

# first deploy (from this directory)
cd reports-site && npx wrangler pages deploy public --project-name groundwork-reports --commit-dirty=true --force

# set the Pages Function's env (D1 REST access for lead capture; use the
# groundwork-ops D1 database id) — via the Cloudflare dashboard:
#   Pages → groundwork-reports → Settings → Environment variables →
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN

# attach the custom domain (dashboard: Pages → groundwork-reports → Custom
# domains → add reports.groundworkdental.com; CF creates the CNAME in-zone)
```

Only after `reports.groundworkdental.com` serves an existing audit URL should
the groundwork-dental cleanup PR (redirects + artifact removal) be merged.
