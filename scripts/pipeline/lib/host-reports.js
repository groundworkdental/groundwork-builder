/**
 * Host the audit + before/after reports on the dedicated reports site
 * (groundwork-reports Cloudflare Pages project, reports.groundworkdental.com).
 *
 * Stages the rendered HTML files (and screenshot) into the builder's own
 * reports-site/public/audits/<slug>/ folder, then direct-uploads the whole
 * site with `wrangler pages deploy`. The marketing repo (groundwork-dental)
 * is no longer touched — it only carries /audits/* and /pitch/* redirects
 * to this project for links sent out before the migration.
 *
 * IMPORTANT: direct upload replaces the FULL asset set on every deploy, so
 * reports-site/public/ must persist locally across runs (it is gitignored,
 * same as clients/). Losing it means older slugs disappear on next deploy.
 *
 * Layout under reports-site/public/audits/<slug>/:
 *   index.html          — sales audit one-pager (lead-capture CTA). The page
 *                         a prospect lands on from an email link.
 *   audit-report.html   — the full deep-dive tabbed report. Filename kept
 *                         as-is so the summary's "See all N issues →"
 *                         relative link resolves without rewriting templates.
 *   before-after.html   — the diff report (present only after a build)
 *   homepage.png        — homepage screenshot (if captured)
 *
 * Public URLs:
 *   https://reports.groundworkdental.com/audits/<slug>/                — summary
 *   https://reports.groundworkdental.com/audits/<slug>/audit-report    — full report
 *   https://reports.groundworkdental.com/audits/<slug>/before-after    — diff (post-build)
 *
 * The lead-capture endpoint POST /api/audit-preview-request ships with this
 * project as a Pages Function (reports-site/functions/), synced from
 * scripts/pipeline/lib/ on every deploy.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPELINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT     = resolve(PIPELINE_ROOT, '..', '..');
const REPORTS_SITE  = resolve(REPO_ROOT, 'reports-site');
const PAGES_PROJECT = process.env.REPORTS_PAGES_PROJECT || 'groundwork-reports';

export function reportsDomain() {
  return process.env.REPORTS_DOMAIN || 'reports.groundworkdental.com';
}

/**
 * @typedef {object} HostedReportPaths
 * @property {string|null} indexUrl         — public URL for the customer-facing summary (audits/<slug>/)
 * @property {string|null} fullReportUrl    — public URL for the deep-dive tabbed report
 * @property {string|null} beforeAfterUrl   — public URL for the before/after report
 * @property {boolean}     pushed           — did the reports site deploy?
 * @property {string|null} skippedReason    — null if hosted, else why not
 */

/**
 * Stage audit-report.html + audit-summary.html (+ homepage.png if present)
 * into reports-site and deploy. Returns the public URLs.
 *
 * Called after audit-site.js finishes successfully.
 *
 * @param {object} args
 * @param {string} args.auditDir   — local _audits/<slug>/ path
 * @param {string} args.slug       — canonical slug
 * @param {boolean} [args.deploy]  — set false to stage only (publish.js
 *                                   stages the pitch first, then deploys once)
 * @returns {Promise<HostedReportPaths>}
 */
export async function hostAuditReport({ auditDir, slug, deploy = true }) {
  const out = {
    indexUrl:       null,
    fullReportUrl:  null,
    beforeAfterUrl: null,
    pushed:         false,
    skippedReason:  null,
  };

  if (!auditDir || !existsSync(auditDir)) {
    out.skippedReason = `audit dir not found at ${auditDir}`;
    return out;
  }

  const destDir = resolve(REPORTS_SITE, 'public', 'audits', slug);
  await mkdir(destDir, { recursive: true });

  const copies = [
    // Customer-facing summary lands at the index URL — that's the page a
    // prospect opens from an email. The dense tabbed full-report stays at
    // its own URL, linked from the summary's "See all N issues →" CTA.
    { from: join(auditDir, 'audit-summary.html'),      to: join(destDir, 'index.html') },
    { from: join(auditDir, 'audit-report.html'),       to: join(destDir, 'audit-report.html') },
    { from: join(auditDir, 'audit-report-after.html'), to: join(destDir, 'before-after.html') },
    { from: join(auditDir, 'homepage.png'),            to: join(destDir, 'homepage.png') },
  ];
  for (const { from, to } of copies) {
    if (existsSync(from)) await copyFile(from, to);
  }

  await syncPreviewRequestApi();

  const domain = reportsDomain();
  out.indexUrl       = `https://${domain}/audits/${slug}/`;
  out.fullReportUrl  = `https://${domain}/audits/${slug}/audit-report`;
  if (existsSync(join(destDir, 'before-after.html'))) {
    out.beforeAfterUrl = `https://${domain}/audits/${slug}/before-after`;
  }

  if (!deploy) return out;

  // Deploy. Non-fatal on failure — local files still staged.
  try {
    deployReportsSite();
    out.pushed = true;
  } catch (err) {
    out.skippedReason = `reports deploy failed: ${err.message}`;
  }
  return out;
}

/**
 * After a build + rescan: re-host so the before/after report is published.
 * Same as hostAuditReport but with a different name for call-site clarity.
 */
export async function hostBeforeAfterReport({ auditDir, slug }) {
  const out = await hostAuditReport({ auditDir, slug });
  return out;
}

/**
 * Stage a pitch page at reports-site/public/pitch/<slug>/index.html.
 * Does not deploy — call deployReportsSite() (or hostAuditReport) after.
 * @returns {Promise<string>} the staged file path
 */
export async function stagePitchPage({ pitchHtml, slug }) {
  const destDir = resolve(REPORTS_SITE, 'public', 'pitch', slug);
  await mkdir(destDir, { recursive: true });
  const destFile = join(destDir, 'index.html');
  await copyFile(pitchHtml, destFile);
  return destFile;
}

/**
 * Direct-upload the full reports site (assets + Pages Functions) to the
 * groundwork-reports project. Wrangler picks up reports-site/functions/
 * because the command runs with reports-site as cwd.
 */
export function deployReportsSite() {
  if (!existsSync(resolve(REPORTS_SITE, 'public'))) {
    throw new Error(`reports-site/public not found at ${REPORTS_SITE} — seed it before deploying`);
  }
  execSync(
    `npx wrangler pages deploy public --project-name "${PAGES_PROJECT}" --commit-dirty=true`,
    { cwd: REPORTS_SITE, stdio: 'pipe', env: process.env },
  );
}

/** Keep the deployed lead-capture Pages Function in sync with lib/. */
async function syncPreviewRequestApi() {
  const destLib = resolve(REPORTS_SITE, 'functions', 'lib');
  const destApi = resolve(REPORTS_SITE, 'functions', 'api');
  await mkdir(destLib, { recursive: true });
  await mkdir(destApi, { recursive: true });

  const libFiles = ['audit-preview-cf.js', 'audit-preview-request.js', 'd1.js'];
  for (const name of libFiles) {
    const from = join(PIPELINE_ROOT, 'lib', name);
    if (existsSync(from)) {
      await copyFile(from, join(destLib, name));
    }
  }

  const apiFrom = join(
    PIPELINE_ROOT,
    'templates',
    'groundwork-dental',
    'functions',
    'api',
    'audit-preview-request.js',
  );
  if (existsSync(apiFrom)) {
    await copyFile(apiFrom, join(destApi, 'audit-preview-request.js'));
  }
}
