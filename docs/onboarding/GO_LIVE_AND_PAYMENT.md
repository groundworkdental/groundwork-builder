# Go-live & payment policy

> Operator policy: preview → deposit → full payment → revisions.  
> Related: [ONBOARDING.md](./ONBOARDING.md) · [HANDOFF.md](./HANDOFF.md) · [CUSTOMER_JOURNEY.md](../lifecycle/CUSTOMER_JOURNEY.md)  
> Website offer copy: [WEBSITE_OFFER_GO_LIVE.md](../resources/WEBSITE_OFFER_GO_LIVE.md)

---

## Offer ladder (product)

| Step | What they get | Money | Revisions? |
|------|----------------|-------|------------|
| **1. Preview** | Site on **Groundwork** Pages (`*.pages.dev` / `slug.groundworkdental.com`) | $0 | No |
| **2. Deposit** | Same build **as-is** (no revision rounds) live on **their** Cloudflare + custom domain | **$500** (credited to $2,000) | No |
| **3. Full build** | Balance paid; ownership complete; included revision window | **$2,000 total** ($1,500 remaining if deposit paid) | **Yes — 30 days** |

Skip step 2 if they prefer: pay $2,000 once → domain + their CF + revision window in one move.

### 30-day revision window (timer)

- Included revisions unlock at **full payment** ($2,000 total).  
- Clock starts on the **first revision request after full payment**.  
- Then they get **30 consecutive days** of included feedback.  
- Open-ended wait after payment is fine — we already have payment.  
- After that window: self-serve, or managed hosting / paid change month.

Record on the Account: `full_payment_date`, `revision_window_start` (first feedback), `revision_window_end` (start + 30 days).

### What “deposit live, no changes” means

- Deploy the approved preview into **their** Cloudflare Pages and attach the domain.  
- No copy/design revision rounds until full payment.  
- Critical fixes only (site down, SSL, broken book button) — not taste/content iteration.  
- Hold: GBP website update, GSC push, launch announcement help, GitHub collaborator invite — until full payment (optional soft leverage). Deposit already moved hosting into their CF, so domain removal is no longer a clean lever; the deposit is the protection.

---

## Safety myth: disconnecting the GitHub repo

**Disconnecting the repo from Cloudflare Pages does not take the site down.** The last successful deployment stays live. Repo disconnect only stops *new* builds from Git.

| Control | When it helps |
|---------|----------------|
| Keep Pages on **Groundwork** CF | Preview and any pre-deposit experiments — you can remove custom domain |
| **$500 deposit** before their CF + domain | Paid commitment before you hand over hosting |
| Hold GBP / GSC / announcement / GitHub invite | Soft leverage after deposit |
| Written terms | Fee due, revision rules, what’s included |

Once Pages + domain are in **their** Cloudflare, you are not relying on a kill switch. Don’t skip the deposit.

---

## Client-facing blurbs

### Before $500 deposit (domain + their CF)

> Paying the $500 deposit moves this preview live onto your Cloudflare and domain as-is — no revision rounds yet. The deposit applies to the $2,000 build. The remaining $1,500 unlocks 30 days of included feedback, starting when you send your first revision request after full payment.

### Before full payment (if deposit already live)

> The remaining $1,500 completes the build fee. After it posts, you get 30 days of included revisions starting when you send your first feedback request.

---

## Operator checklist

### Preview ($0)
- [ ] Build on Groundwork Pages  
- [ ] Client reviews preview URL  

### Deposit ($500) — optional early live
- [ ] Deposit received (credited to $2,000)  
- [ ] Blurb acknowledged  
- [ ] New Pages project in **their** CF; custom domain attached  
- [ ] No revision rounds (critical fixes only)  
- [ ] Hold GBP / GSC / announcement / GitHub invite until full payment  

### Full payment ($2,000 total)
- [ ] Balance posted  
- [ ] Record `full_payment_date`  
- [ ] Unlock revisions; window starts on first revision request  
- [ ] On first feedback: record `revision_window_start` and `revision_window_end` (= start + 30 days)  
- [ ] GBP, GSC, handoff, GitHub access  

### Skip-deposit path
- [ ] $2,000 once → their CF + domain + revision window (same timer rules)  

---

## Cloudflare Pages notes (ops)

Astro 6 needs Node ≥ 22.12. If the client repo has `wrangler.toml` with `pages_build_output_dir`, pin Node in Wrangler — dashboard env vars are ignored:

```toml
[vars]
NODE_VERSION = "22"
```

Also keep `.nvmrc` / `package.json` `engines` aligned.  
`*.pages.dev` names can’t be renamed; a suffix is fine — production uses the custom domain.  
Add the domain in **Pages → Custom domains** first; a raw CNAME with no Pages association returns 522.

---

## Mansfield lesson (2026-09)

Went live on client domain with Pages already in **their** Cloudflare before payment. That removed the easy custom-domain lever. Going forward: **$500 deposit before their CF + domain**, or full $2,000 in one shot — not unpaid ownership transfer.
