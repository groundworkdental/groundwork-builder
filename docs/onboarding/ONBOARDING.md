# Operator onboarding playbook — Signed → Live

> Lifecycle stage: **Signed → Onboarding → Live**  
> Pre-requisite: Audit run, pitch delivered, contract signed.  
> Related: [gbp-setup-walkthrough.md](../gbp/gbp-setup-walkthrough.md) · [HANDOFF.md](./HANDOFF.md) · [CUSTOMER_JOURNEY.md](../lifecycle/CUSTOMER_JOURNEY.md)

---

## Phase 1 — Before the call (you, ~20 min)

### 1.1 Run the existing-site audit

```bash
npm run audit -- --url https://their-current-site.com --source manual
```

This runs the full SEO + AEO + tech audit and saves results under `_audits/<slug>/`. You'll use the findings to prioritize what intake info matters most.

### 1.2 Update lifecycle stage in D1 / ops dashboard

```
Account → Lifecycle Stage → Onboarding (ops.groundworkdental.com)
```

Or via code: `setAccountLifecycle(slug, 'Onboarding')` in `d1.js`.

### 1.3 Create the client directory

```bash
mkdir -p clients/<slug>
```

Where `<slug>` is the kebab-case practice name (e.g. `riverside-family-dental`). This matches the D1 `accounts.slug`.

### 1.4 Send the pre-call email

Send two attachments before the call:
- **[gbp-client-browser-checklist.md](../gbp/gbp-client-browser-checklist.md)** — what they'll do on screen share (non-technical one-pager)
- The **intake questionnaire** (see Phase 2 — send as a Google Doc or typeform; you need answers before you build)

---

## Phase 2 — Collect from the practice (async, before or during call)

Everything below feeds `intake.json`. Send as a form or Google Doc; fill it in yourself if you collected it verbally on a call. Store the result at `clients/<slug>/intake.json` **or** set `accounts.intake_json` in D1 / ops dashboard.

Template: [`docs/onboarding/intake-template.json`](./intake-template.json)

### Practice basics

| What | Notes |
|------|-------|
| **Legal / trading name** | Exactly as it appears on their GBP and signage |
| **Phone number** | Main patient-facing line |
| **Email** | Public patient-facing email |
| **Website domain** | Current domain they want to keep |
| **Street address** | Full address with suite |
| **City, state, ZIP** | |
| **Office hours** | All days, including "closed" days |

### Doctor / team

| What | Notes |
|------|-------|
| **Doctor first + last name** | |
| **Credentials** | DDS, DMD, MS, etc. |
| **Short bio** | 2–4 sentences; what they want patients to know |
| **Education / residency** | School, program, year (only what's true) |
| **Headshot photo** | High-res JPG or PNG; not a selfie |
| **Healthgrades profile URL** | For sameAs schema (entity authority) |
| **LinkedIn URL** | Optional but adds entity signal |
| **Zocdoc / Vitals URLs** | If they have them |

### Services

| What | Notes |
|------|-------|
| **List of services offered** | One per line; these become service pages |
| **Primary / flagship service** | The one they most want to rank for |
| **Services they do NOT offer** | To avoid the pipeline pulling them from scrape |

### Brand

| What | Notes |
|------|-------|
| **Logo file** | SVG preferred; PNG acceptable (transparent background) |
| **Primary color** | Hex code, or "match our existing site" |
| **Secondary / accent color** | If known |
| **Font preference** | Or "use your judgment" |

### Photos

| What | Notes |
|------|-------|
| **Exterior photo** | Storefront / building |
| **Waiting room** | |
| **Treatment room(s)** | |
| **Team photo** | |
| **Before / after cases** | Only with patient consent; optional |

### Content

| What | Notes |
|------|-------|
| **Patient FAQs** | Real questions they hear; 5–10 is ideal |
| **Testimonials** | Real patient quotes (attribution optional) |
| **Insurance plans accepted** | List; "PPO only", "Delta Dental", etc. |
| **Financing options** | CareCredit, in-house plans, etc. |
| **Scheduling software** | Dentrix, NexHealth, Zocdoc, etc. (for booking button link) |
| **Case study consent** | yes / no / pending |

### Accounts and access needed

These are permissions, not passwords. You never need their Google password.

| What | How you get it | Why |
|------|----------------|-----|
| **GBP owner access** | They add you as Manager during setup call | CLI tools for reviews, posts; profile completion |
| **Google Cloud project** (Client ID + Secret) | They create it on the call; you paste into `.env` | GBP API auth |
| **Domain registrar login** | They share (or their IT does) | DNS cutover at go-live |
| **DNS access** | Cloudflare, GoDaddy, Namecheap, etc. | Point domain to new hosting |
| **Current hosting** | Read-only is fine | Understand what's there; not required to build |
| **Google Analytics (existing)** | They add you as Editor | Transfer property or link to new one |
| **Google Search Console (existing)** | They add you as Owner | Submit sitemap, request indexing, verify coverage |
| **Social profile URLs** | They provide | Populate `sameAs` in LocalBusiness schema |

Social URLs to collect:
- [ ] Facebook page URL
- [ ] Instagram profile URL
- [ ] Yelp listing URL
- [ ] Healthgrades listing URL
- [ ] Google Maps listing URL (share from Maps)

---

## Phase 3 — Setup call (~75 min)

**Call agenda (in order):**
1. Their screen share — Google Cloud + GBP API setup (~35 min)
2. Their screen share continued — GBP Manager access, GA4 access, GSC access (~10 min)
3. Your screen share + their remote control — CLI login (~15 min)
4. Verify + close out (~5 min)
5. Outstanding intake questions, DNS discussion (~10 min)

**Before the call — your machine (2 min):**

```bash
npm install                  # confirm dependencies installed
grep "GBP_\|ANALYTICS" .env  # confirm empty GBP_* and GA fields to fill in
```

---

### A — Google Cloud Console (their screen share, ~35 min)

Full detail: [gbp-setup-walkthrough.md Part 1](../gbp/gbp-setup-walkthrough.md).  
They share screen. They must be signed in as the Google account that manages the Business Profile.

**Step 1 — Create a Cloud project**

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Top bar → project dropdown → **New Project**
3. Name it (e.g. `Riverside Dental GBP`) → **Create**
4. Wait ~30 seconds → project dropdown → **select the new project**

**Step 2 — Enable the Business Profile APIs**

Left menu → **APIs & Services** → **Library** → search and enable each:

| Search for | Action |
|------------|--------|
| `My Business Account Management API` | Enable |
| `Google My Business API` | Enable |
| `My Business Business Information API` | Enable |

**Step 3 — Configure OAuth consent screen**

Left menu → **APIs & Services** → **OAuth consent screen**

1. User type: **External** → **Create**
2. App name: `Practice GBP Tools` · Support email: practice email → **Save and Continue**
3. Scopes → **Add or Remove Scopes** → search `business.manage` → select `https://www.googleapis.com/auth/business.manage` → **Update** → **Save and Continue**
4. Test users (only if status shows "Testing") → **Add users** → type the owner's Gmail → **Save and Continue**
5. **Back to Dashboard**

**Step 4 — Request API access** _(can take days — skip Part B until this email arrives)_

1. Go to [developers.google.com/my-business/content/prereqs](https://developers.google.com/my-business/content/prereqs)
2. Submit the access request for this Cloud project
3. Google emails approval — often takes 2–5 business days
4. If not approved yet: finish Steps 5–6 now, book a 15-min follow-up for Part C after approval

**Step 5 — Create OAuth Client ID and secret**

Left menu → **APIs & Services** → **Credentials**

1. **+ Create Credentials** → **OAuth client ID**
2. Application type: **Desktop app** · Name: `gbp-cli-desktop` → **Create**
3. Popup shows **Client ID** and **Client secret**
4. They copy both to Notes on their computer (not email/SMS)
5. They read them to you — you paste into your `.env`:

```
GBP_CLIENT_ID=paste-client-id.apps.googleusercontent.com
GBP_CLIENT_SECRET=paste-GOCSPX-secret
```

6. If **Authorized redirect URIs** appears → add `http://127.0.0.1:3456/oauth2callback` → Save

**Step 6 — Add you to Cloud Console (IAM)**

Still in Cloud Console, same project.

1. Left menu → **IAM & Admin** → **IAM**
2. **Grant access** → New principals: your Gmail → Role: **Editor** → **Save**
3. You'll receive and accept an email invitation

---

### B — Google Business Profile access (their screen share, ~5 min)

1. Go to [business.google.com](https://business.google.com) (still signed in as practice account)
2. Select the correct business location
3. **Settings** → **Business profile settings** → **People and access** (wording varies by UI)
4. **Add** / **Invite** → your agency Gmail → Role: **Manager**
5. You'll receive and accept an email invitation

✅ After this step you can access `business.google.com` as Manager and use the CLI.

---

### C — Google Analytics 4 (their screen share, ~5 min)

**If they already have GA4** — add you and grab the Measurement ID:

1. Go to [analytics.google.com](https://analytics.google.com)
2. Bottom left → **Admin** (gear icon)
3. Under **Account** column → **Account Access Management** → **+** → your Gmail → Role: **Editor** → **Add**
4. Under **Property** column → **Data Streams** → click the web stream → copy the **Measurement ID** (`G-XXXXXXXXXX`) → save it (you'll add it to intake.json)

**If they don't have GA4 yet** — create one now (~5 min):

1. Go to [analytics.google.com](https://analytics.google.com)
2. Bottom left → **Admin** → **+ Create** → **Account**
3. Account name: practice name → **Next** → **Next** → **Create** → accept terms
4. You're now in "Create a property" flow:
   - Property name: their domain (e.g. `riversidefamilydental.com`)
   - Time zone: their local timezone
   - Currency: USD → **Next**
   - Industry: Health → Business size: Small → **Next** → **Create**
5. "Start collecting data" → choose **Web**
   - Website URL: their domain (e.g. `https://riversidefamilydental.com`)
   - Stream name: their domain → **Create stream**
6. Copy the **Measurement ID** (`G-XXXXXXXXXX`) — save it to your notes and intake.json
7. Back in Admin → **Account Access Management** → **+** → your Gmail → **Editor** → **Add**

✅ Measurement ID in hand = you can wire tracking into the build. GA confirmation of live traffic happens after launch.

> **Where the Measurement ID goes:** Add it to `clients/<slug>/intake.json` under `content.ga4_measurement_id`. The site config reads it from there.

---

### D — Google Search Console (their screen share, ~3 min)

**If they already have GSC** — add you as Owner:

1. Go to [search.google.com/search-console](https://search.google.com/search-console)
2. Top left → select the correct property
3. Left menu → **Settings** → **Users and permissions**
4. **Add user** → your Gmail → Permission: **Owner** → **Add**

**If they don't have GSC yet** — skip this step on the call. GSC setup requires the real domain to be live and reachable, so it's done at go-live. See [Phase 7 — Set up Google Search Console](#set-up-google-search-console).

> Owner permission matters: Full user can see data but can't add other users or remove the property. Owner can do both — important for verifying the domain property later.

---

### E — CLI login (your screen share + their remote control, ~15 min)

Full detail: [gbp-setup-walkthrough.md Part 2](../gbp/gbp-setup-walkthrough.md).

You share your screen. Practice takes Zoom remote control when Chrome opens.

```bash
npm run gbp -- login
```

Chrome opens on your machine → they take remote control (Zoom: **Request Remote Control** or you grant it) → they sign in with the practice Google account → click **Continue** on "app not verified" → click **Allow**.

Terminal completes and prints:
```
✓ Saved to .env: GBP_REFRESH_TOKEN, GBP_ACCOUNT_ID, GBP_LOCATION_ID
```

**Skip this step** if API access (Step 4 above) hasn't been approved yet — `login` will return 403. Book a 15-min follow-up call.

---

### F — Verify everything

```bash
npm run gbp -- status      # should show masked refresh token + account/location IDs
npm run gbp -- locations   # should list the practice location
npm run gbp -- reviews --limit 3  # should return real review text
```

All three pass → setup is complete.

**`.env` should now have these five values:**

```
GBP_CLIENT_ID=...
GBP_CLIENT_SECRET=...
GBP_REFRESH_TOKEN=...
GBP_ACCOUNT_ID=...
GBP_LOCATION_ID=...
```

Back these up to your password manager. They don't get committed to git.

---

### Phase 3 checklist

- [ ] Cloud project created and selected
- [ ] Three Business Profile APIs enabled
- [ ] OAuth consent screen: `business.manage` scope; owner email on Test users
- [ ] API access requested (or already approved)
- [ ] Desktop OAuth client created; Client ID + secret in your `.env`
- [ ] You are Editor in Cloud Console IAM
- [ ] You are Manager on Business Profile (`business.google.com`)
- [ ] You are Editor in Google Analytics 4 (or flagged as "not set up yet")
- [ ] You are Owner in Google Search Console (or flagged as "not set up yet")
- [ ] CLI login complete: `npm run gbp -- status` passes

---

## Phase 4 — Create intake.json

Fill in `clients/<slug>/intake.json` from everything collected in Phase 2. Use the template:

```bash
cp docs/onboarding/intake-template.json clients/<slug>/intake.json
# then edit it
```

Or set `accounts.intake_json` in D1 if you prefer the CRM as the source of truth.

Verify the pipeline can load it:

```bash
node -e "
import('./scripts/pipeline/lib/intake.js').then(m =>
  m.loadIntake({ filePath: 'clients/<slug>/intake.json' }).then(d => console.log(JSON.stringify(d, null, 2)))
)
"
```

No errors = ready to build.

---

## Phase 5 — Build the site

```bash
# Full build (scrape + merge + generate + publish to preview URL)
node scripts/pipeline/build-site.js --slug <slug> --publish

# Or via npm start (prompts for slug if not passed)
npm start
```

Preview URL will be: `https://<slug>.groundworkdental.com`

Check `clients/<slug>/_pipeline/` for phase outputs. If anything looks wrong:

```bash
# See the merged data (what the builder used)
cat clients/<slug>/_pipeline/02-merged.json | jq .

# See audit findings the builder responded to
cat _audits/<slug>/_data/findings.json | jq .
```

Ship gates must pass before go-live (`_pipeline/12-ship-gates.json` → `"passed": true`):
- Mobile PageSpeed ≥ 90
- Lighthouse accessibility ≥ 90
- 0 axe critical/serious violations

---

## Phase 6 — Complete the GBP profile via CLI + browser

The CLI handles reviews and posts. Profile fields (categories, description, hours, photos, Q&A) are done via the GBP web UI — you access it as Manager.

### Via CLI

```bash
# Pull and review existing reviews
npm run gbp -- reviews --unanswered

# Reply to a review (prompts for review ID and reply text)
npm run gbp -- reply

# Publish a post (new service, offer, etc.)
npm run gbp -- post

# Check current listing status
npm run gbp -- status
```

### Via browser (business.google.com — log in as their account or use Manager access)

Work through this list after getting Manager access:

- [ ] **Primary category**: Dentist (+ secondary: Cosmetic Dentist, Pediatric Dentist, Emergency Dental Service as applicable)
- [ ] **Business description**: 750 characters, written in their voice, includes city + primary service
- [ ] **Hours**: all days including exceptions (holidays)
- [ ] **Services**: add each service from intake with a short description
- [ ] **Attributes**: wheelchair accessible, parking, insurance accepted, languages, etc.
- [ ] **Website link**: points to final domain (not preview URL — update at go-live)
- [ ] **Photos**: minimum 10 — exterior, waiting room, treatment room, team, doctor headshot
- [ ] **Q&A**: plant 3–5 common patient questions with answers ("Do you accept Delta Dental?" "Is parking available?")
- [ ] **Social links**: add Facebook, Instagram under Info → Social profiles

---

## Phase 7 — DNS cutover and go-live

> **Payment gate:** See [GO_LIVE_AND_PAYMENT.md](./GO_LIVE_AND_PAYMENT.md). Ladder: free preview on Groundwork → optional **$500 deposit** for their CF + domain as-is → **$2,000 total** unlocks 30-day revisions.  
> Disconnecting the GitHub repo does **not** take the site down. Don’t move Pages into their CF until the deposit (or full payment) clears.

### Before cutting DNS

- [ ] Preview site reviewed and approved (Groundwork / pages.dev URL)
- [ ] Ship gates passed
- [ ] **$500 deposit or full $2,000 posted** before their CF + custom domain
- [ ] Old site backup saved
- [ ] Domain registrar / Cloudflare DNS access in hand
- [ ] GBP website link — prefer **after full payment** (soft leverage if only deposit is paid)

### DNS records to set

1. In Cloudflare Pages → **Custom domains** → add `example.com` and `www` **first** (a raw CNAME with no Pages association returns 522).
2. If DNS is on this Cloudflare account, CF creates the records. If not, move nameservers (apex) or CNAME `www` to the project’s `*.pages.dev` host.
3. A `slug-xxxx.pages.dev` suffix is fine when the clean name is taken — production is the custom domain.

Typical records (after Custom domains is set up):

```
CNAME  @    <slug>.pages.dev   (or the assigned Pages domain — CF may use its own apex target)
CNAME  www  <slug>.pages.dev
```

DNS propagation: 5 min to a few hours depending on TTL. SSL is automatic.

### Immediately after DNS propagates

```bash
# Verify the site is live on their domain
curl -I https://their-domain.com

# Run a post-launch audit
npm run audit -- --url https://their-domain.com --source manual
```

- [ ] Update GBP website link — prefer after **full** $2,000
- [ ] If deposit-only: no revision rounds (critical fixes only); remaining balance still due
- [ ] If full payment: revision window starts on **first feedback** after pay, then +30 days (see go-live policy)
- [ ] Transfer Pages into **their** Cloudflare at deposit or full pay — not before

---

### Set up Google Search Console

#### If GSC already existed and you have Owner access (Phase 3D)

1. Go to [search.google.com/search-console](https://search.google.com/search-console)
2. Left menu → **Sitemaps** → enter `sitemap.xml` → **Submit**
3. Left menu → **URL Inspection** → paste homepage URL → **Request Indexing**
4. Repeat URL Inspection for each service page and the About page

#### If GSC doesn't exist yet — create a Domain property (preferred)

A Domain property covers `http://`, `https://`, `www.`, and non-`www.` automatically — cleaner than URL prefix.

1. Go to [search.google.com/search-console](https://search.google.com/search-console)
2. Left panel → **+ Add property** → select **Domain** tab
3. Enter domain without protocol: `riversidefamilydental.com` → **Continue**
4. GSC shows a **TXT record value** — copy it (looks like `google-site-verification=XXXXXXXXXXXX`)
5. In DNS registrar (Cloudflare, GoDaddy, etc.) → add a new DNS record:
   - Type: `TXT`
   - Name / Host: `@`
   - Value: the verification string from step 4
   - TTL: auto or 300
   - Save
6. Back in GSC → **Verify** (may take 1–15 min for DNS to propagate; retry if it fails)
7. Once verified: **Sitemaps** → enter `sitemap.xml` → **Submit**
8. **URL Inspection** → paste each key page URL → **Request Indexing**:
   - Homepage (`https://their-domain.com/`)
   - Each service page (`/services/dental-implants/`, etc.)
   - About page
9. Left menu → **Settings** → **Users and permissions** → **Add user** → their email → **Owner** (so they have access to their own data)

> **If Domain verification fails after 15 min:** try URL prefix as a fallback — Add property → URL prefix → `https://their-domain.com` → verify via the **Google Analytics** method (instant if GA4 tag is live on the site).

---

### Verify GA4 is tracking

1. Go to [analytics.google.com](https://analytics.google.com) → their property
2. Left menu → **Reports** → **Realtime**
3. Open their live site in a new tab and navigate a few pages
4. Realtime should show ≥1 active user within ~30 seconds

If no data appears, the Measurement ID may not be wired into the site — check `src/config/site.ts` or wherever the GA snippet is embedded.

---

- [ ] GSC property verified and sitemap submitted
- [ ] Key pages have indexing requested
- [ ] GA4 Realtime confirmed tracking
- [ ] Update D1 lifecycle: `Onboarding → Live`

```
Account → Lifecycle Stage → Live
```

---

## Phase 8 — Post-launch baseline (automated)

`build-site.js --publish` triggers `baseline-capture.js` when ship gates pass, writing:

- `clients/<slug>/_pipeline/baseline.json`
- D1 Account: `Baseline PageSpeed`, `Launch Date`, `Re-audit Due` (75 days out)

### Manual steps after launch (~20 min)

See [HANDOFF.md](./HANDOFF.md) for full detail. Summary:

1. **Record 3–5 local rank terms** in D1 `Baseline Ranks` (e.g. "dentist Austin", "dental implants Austin", "emergency dentist Austin")
2. **Confirm case study consent** is set in intake or D1
3. **Re-audit is scheduled** — `Re-audit Due` field should be ~75 days from `Launch Date`

---

## Quick-reference — all CLI commands in order

```bash
# 1. Audit existing site (before call)
npm run audit -- --url https://old-site.com

# 2. Prep .env for GBP (before call)
grep GBP_ .env

# 3. GBP login (during call)
npm run gbp -- login

# 4. Verify GBP connection (during call)
npm run gbp -- status
npm run gbp -- locations
npm run gbp -- reviews --limit 3

# 5. Load + verify intake.json (after call)
node -e "import('./scripts/pipeline/lib/intake.js').then(m => m.loadIntake({ filePath: 'clients/<slug>/intake.json' }).then(console.log))"

# 6. Build + publish to preview
node scripts/pipeline/build-site.js --slug <slug> --publish

# 7. Inspect merged data
cat clients/<slug>/_pipeline/02-merged.json | jq .

# 8. Post-launch audit
npm run audit -- --url https://their-domain.com

# 9. GBP: pull unanswered reviews
npm run gbp -- reviews --unanswered

# 10. GBP: post an update
npm run gbp -- post
```

---

## Checklist summary

- [ ] Existing-site audit run
- [ ] Lifecycle → Onboarding
- [ ] Pre-call email + attachments sent
- [ ] Intake questionnaire received and complete
- [ ] `clients/<slug>/intake.json` created (or D1 `intake_json` filled)
- [ ] Setup call done: GBP API auth working (`npm run gbp -- status` passes)
- [ ] `.env` has `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET`, `GBP_LOCATION_ID`, refresh token
- [ ] Build complete; ship gates pass
- [ ] Preview approved by practice
- [ ] GBP profile complete (categories, description, hours, services, 10+ photos, Q&A)
- [ ] DNS cutover done
- [ ] Post-launch audit clean
- [ ] GBP website link updated to real domain
- [ ] Search Console: sitemap submitted, indexing requested
- [ ] Lifecycle → Live
- [ ] Baseline rank terms recorded in D1
- [ ] Re-audit Due date set (~75 days)
