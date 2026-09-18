// @ts-check
/**
 * Cloudflare D1 client — drop-in replacement for airtable.js.
 *
 * Identical exports and call signatures as airtable.js; writes to Cloudflare
 * D1 via the REST API instead of Airtable.
 *
 * Tables (SQLite, managed in D1):
 *   accounts — one row per practice (identity, lifecycle, contact)
 *   audits   — one row per audit run (findings, scores, GBP snapshot)
 *   builds   — one row per generated site (deployed URLs, rescan diff,
 *               linked to its source audit)
 *
 * Required env vars (all optional — every function returns null if missing):
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_D1_DATABASE_ID
 *   CLOUDFLARE_API_TOKEN
 */

const D1_BASE = 'https://api.cloudflare.com/client/v4/accounts';

/** Account lifecycle stages — wire via upsertAccount({ lifecycleStage }). */
export const ACCOUNT_LIFECYCLE_STAGES = [
  'Prospect',
  'Audited',
  'Preview Requested',
  'Pitched',
  'Contacted',
  'Signed',
  'Onboarding',
  'Live',
  'Active',
  'Churned',
];

function config() {
  return {
    accountId:  process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    token:      process.env.CLOUDFLARE_API_TOKEN,
  };
}

function enabled() {
  const c = config();
  return !!(c.accountId && c.databaseId && c.token);
}

/**
 * Execute a SQL statement against D1.
 *
 * @param {string} sql
 * @param {Array<string|number|null>} params
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function d1Query(sql, params = []) {
  const c = config();
  const url = `${D1_BASE}/${c.accountId}/d1/database/${c.databaseId}/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  const data = await res.json();

  if (!data.success) {
    const msg = data.errors?.map(e => e.message).join('; ') || 'unknown error';
    throw new Error(`[d1] query failed: ${msg}`);
  }

  return data.result?.[0]?.results ?? [];
}

/**
 * Throw a formatted D1 error.
 * @param {string} method
 * @param {string} table
 * @param {unknown} err
 */
function d1Error(method, table, err) {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(`[d1] ${method} ${table}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Upsert an account row by slug. On conflict, update all non-null fields while
 * preserving the original created_at. Returns the row id.
 *
 * @param {Object} args
 * @returns {Promise<string|null>}
 */
export async function upsertAccount(args = {}) {
  if (!enabled()) return null;
  const { slug } = args;
  if (!slug) throw new Error('upsertAccount: slug is required');

  try {
    // Check whether the row already exists so we can preserve created_at.
    const existing = await d1Query(
      'SELECT id, created_at FROM accounts WHERE slug = ? LIMIT 1',
      [slug],
    );

    const now = new Date().toISOString();

    if (existing.length > 0) {
      const row = existing[0];
      const id = /** @type {string} */ (row.id);
      await d1Query(
        `UPDATE accounts SET
          practice_name   = COALESCE(?, practice_name),
          practice_url    = COALESCE(?, practice_url),
          business_email  = COALESCE(?, business_email),
          contact_email   = COALESCE(?, contact_email),
          contact_name    = COALESCE(?, contact_name),
          phone           = COALESCE(?, phone),
          city            = COALESCE(?, city),
          state           = COALESCE(?, state),
          source          = COALESCE(?, source),
          lifecycle_stage = COALESCE(?, lifecycle_stage),
          baseline_pagespeed = COALESCE(?, baseline_pagespeed),
          baseline_ranks  = COALESCE(?, baseline_ranks),
          launch_date     = COALESCE(?, launch_date),
          reaudit_due     = COALESCE(?, reaudit_due),
          intake_json     = COALESCE(?, intake_json),
          updated_at      = ?
        WHERE slug = ?`,
        [
          args.practiceName   ?? null,
          args.practiceUrl    ?? null,
          args.businessEmail  ?? null,
          args.contactEmail   ?? null,
          args.contactName    ?? null,
          args.phone          ?? null,
          args.city           ?? null,
          args.state          ?? null,
          args.source         ?? null,
          args.lifecycleStage ?? null,
          args.baselineMobilePagespeed ?? null,
          args.baselineRanks  ?? null,
          args.launchDate     ?? null,
          args.reauditDue     ?? null,
          args.intakeJson != null
            ? (typeof args.intakeJson === 'string' ? args.intakeJson : JSON.stringify(args.intakeJson))
            : null,
          now,
          slug,
        ],
      );
      return id;
    }

    // Insert new row.
    const id = crypto.randomUUID();
    await d1Query(
      `INSERT INTO accounts (
        id, slug, practice_name, practice_url, business_email,
        contact_email, contact_name, phone, city, state, source,
        lifecycle_stage, baseline_pagespeed, baseline_ranks,
        launch_date, reaudit_due, intake_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        slug,
        args.practiceName   ?? null,
        args.practiceUrl    ?? null,
        args.businessEmail  ?? null,
        args.contactEmail   ?? null,
        args.contactName    ?? null,
        args.phone          ?? null,
        args.city           ?? null,
        args.state          ?? null,
        args.source         ?? null,
        args.lifecycleStage ?? 'Prospect',
        args.baselineMobilePagespeed ?? null,
        args.baselineRanks  ?? null,
        args.launchDate     ?? null,
        args.reauditDue     ?? null,
        args.intakeJson != null
          ? (typeof args.intakeJson === 'string' ? args.intakeJson : JSON.stringify(args.intakeJson))
          : null,
        now,
        now,
      ],
    );
    return id;
  } catch (err) {
    d1Error('upsertAccount', 'accounts', err);
  }
}

/**
 * Fetch an account row by slug. Returns { id, fields } or null.
 *
 * @param {string} slug
 * @returns {Promise<{id: string, fields: Record<string, unknown>}|null>}
 */
export async function findAccountBySlug(slug) {
  if (!enabled() || !slug) return null;
  try {
    const rows = await d1Query(
      'SELECT * FROM accounts WHERE slug = ? LIMIT 1',
      [slug],
    );
    if (!rows.length) return null;
    const { id, ...fields } = rows[0];
    return { id: /** @type {string} */ (id), fields };
  } catch (err) {
    d1Error('findAccountBySlug', 'accounts', err);
  }
}

/**
 * Find the most recent Queued build row for a slug (for dedup on publish).
 *
 * @param {string} slug
 * @returns {Promise<string|null>}
 */
export async function findQueuedBuildBySlug(slug) {
  if (!enabled() || !slug) return null;
  try {
    const rows = await d1Query(
      `SELECT id FROM builds
       WHERE build_slug = ? AND status = 'Queued'
       ORDER BY date_added DESC
       LIMIT 1`,
      [slug],
    );
    return rows.length ? /** @type {string} */ (rows[0].id) : null;
  } catch (err) {
    d1Error('findQueuedBuildBySlug', 'builds', err);
  }
}

/**
 * Set account lifecycle stage by slug.
 *
 * @param {string} slug
 * @param {string} lifecycleStage
 * @returns {Promise<string|null>}
 */
export async function setAccountLifecycle(slug, lifecycleStage) {
  if (!ACCOUNT_LIFECYCLE_STAGES.includes(lifecycleStage)) {
    throw new Error(`setAccountLifecycle: invalid stage "${lifecycleStage}"`);
  }
  return upsertAccount({ slug, lifecycleStage });
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

/**
 * Create an audit row linked to an account.
 *
 * @param {Object} args
 * @returns {Promise<string|null>} audit row id
 */
export async function createAudit(args = {}) {
  if (!enabled()) return null;
  const { accountId, slug, status } = args;
  if (!accountId) throw new Error('createAudit: accountId is required');
  if (!slug)      throw new Error('createAudit: slug is required');
  if (!status)    throw new Error('createAudit: status is required');

  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const completedAt =
      status === 'Audited' || status === 'Failed' ? now : null;

    await d1Query(
      `INSERT INTO audits (
        id, account_id, slug, status, website_url, source, contact_email,
        total_checks, passed, critical, warnings,
        mobile_score, desktop_score,
        gbp_reviews, gbp_rating,
        audit_report_url, gcs_run_folder, error_detail,
        completed_at, date_added
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        accountId,
        slug,
        status,
        args.websiteUrl      ?? null,
        args.source          ?? null,
        args.contactEmail    ?? null,
        args.totalChecks     ?? null,
        args.passed          ?? null,
        args.critical        ?? null,
        args.warnings        ?? null,
        args.mobileScore     ?? null,
        args.desktopScore    ?? null,
        args.gbpReviews      ?? null,
        args.gbpRating       ?? null,
        args.auditReportUrl  ?? null,
        args.gcsRunFolder    ?? null,
        args.errorDetail     ?? null,
        completedAt,
        now,
      ],
    );
    return id;
  } catch (err) {
    d1Error('createAudit', 'audits', err);
  }
}

/**
 * Update an existing audit row (never overwrites account_id link).
 *
 * @param {string} auditId
 * @param {Object} args
 * @returns {Promise<string|null>} auditId
 */
export async function updateAudit(auditId, args = {}) {
  if (!enabled()) return null;
  if (!auditId) throw new Error('updateAudit: auditId is required');

  try {
    const { status } = args;
    const completedAt =
      status === 'Audited' || status === 'Failed'
        ? new Date().toISOString()
        : null;

    await d1Query(
      `UPDATE audits SET
        status           = COALESCE(?, status),
        website_url      = COALESCE(?, website_url),
        source           = COALESCE(?, source),
        contact_email    = COALESCE(?, contact_email),
        total_checks     = COALESCE(?, total_checks),
        passed           = COALESCE(?, passed),
        critical         = COALESCE(?, critical),
        warnings         = COALESCE(?, warnings),
        mobile_score     = COALESCE(?, mobile_score),
        desktop_score    = COALESCE(?, desktop_score),
        gbp_reviews      = COALESCE(?, gbp_reviews),
        gbp_rating       = COALESCE(?, gbp_rating),
        audit_report_url = COALESCE(?, audit_report_url),
        gcs_run_folder   = COALESCE(?, gcs_run_folder),
        error_detail     = COALESCE(?, error_detail),
        completed_at     = COALESCE(?, completed_at)
      WHERE id = ?`,
      [
        args.status         ?? null,
        args.websiteUrl     ?? null,
        args.source         ?? null,
        args.contactEmail   ?? null,
        args.totalChecks    ?? null,
        args.passed         ?? null,
        args.critical       ?? null,
        args.warnings       ?? null,
        args.mobileScore    ?? null,
        args.desktopScore   ?? null,
        args.gbpReviews     ?? null,
        args.gbpRating      ?? null,
        args.auditReportUrl ?? null,
        args.gcsRunFolder   ?? null,
        args.errorDetail    ?? null,
        completedAt,
        auditId,
      ],
    );
    return auditId;
  } catch (err) {
    d1Error('updateAudit', 'audits', err);
  }
}

/**
 * Find the most recent audit row for an account slug.
 *
 * @param {string} slug
 * @returns {Promise<string|null>} audit row id or null
 */
export async function findLatestAuditBySlug(slug) {
  if (!enabled() || !slug) return null;
  try {
    const rows = await d1Query(
      `SELECT id FROM audits
       WHERE slug = ?
       ORDER BY date_added DESC
       LIMIT 1`,
      [slug],
    );
    return rows.length ? /** @type {string} */ (rows[0].id) : null;
  } catch (err) {
    d1Error('findLatestAuditBySlug', 'audits', err);
  }
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/**
 * Create a build row linked to an account and (optionally) a source audit.
 *
 * @param {Object} args
 * @returns {Promise<string|null>} build row id
 */
export async function createBuild(args = {}) {
  if (!enabled()) return null;
  const { accountId, buildSlug, status } = args;
  if (!accountId) throw new Error('createBuild: accountId is required');
  if (!buildSlug) throw new Error('createBuild: buildSlug is required');
  if (!status)    throw new Error('createBuild: status is required');

  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const completedAt =
      status === 'Pitched' || status === 'Failed' || status === 'Blocked'
        ? now
        : null;

    await d1Query(
      `INSERT INTO builds (
        id, account_id, source_audit_id, build_slug, status,
        website_url, request_notes,
        contact_name, contact_email, contact_phone, contact_role,
        preview_url, pitch_url, github_folder_url, gcs_run_folder,
        mobile_score, desktop_score,
        fixed_count, still_issue_count, regressed_count,
        rescanned_at, cost_est, error_detail,
        completed_at, date_added
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        accountId,
        args.sourceAuditId   ?? null,
        buildSlug,
        status,
        args.websiteUrl      ?? null,
        args.requestNotes    ?? null,
        args.contactName     ?? null,
        args.contactEmail    ?? null,
        args.contactPhone    ?? null,
        args.contactRole     ?? null,
        args.previewUrl      ?? null,
        args.pitchUrl        ?? null,
        args.githubFolderUrl ?? null,
        args.gcsRunFolder    ?? null,
        args.mobileScore     ?? null,
        args.desktopScore    ?? null,
        args.fixedCount      ?? null,
        args.stillIssueCount ?? null,
        args.regressedCount  ?? null,
        args.rescannedAt     ?? null,
        args.costEst         ?? null,
        args.errorDetail     ?? null,
        completedAt,
        now,
      ],
    );
    return id;
  } catch (err) {
    d1Error('createBuild', 'builds', err);
  }
}

/**
 * Update an existing build row (never overwrites account_id or source_audit_id).
 *
 * @param {string} buildId
 * @param {Object} args
 * @returns {Promise<string|null>} buildId
 */
export async function updateBuild(buildId, args = {}) {
  if (!enabled()) return null;
  if (!buildId) throw new Error('updateBuild: buildId is required');

  try {
    const { status } = args;
    const completedAt =
      status === 'Pitched' || status === 'Failed' || status === 'Blocked'
        ? new Date().toISOString()
        : null;

    await d1Query(
      `UPDATE builds SET
        status            = COALESCE(?, status),
        website_url       = COALESCE(?, website_url),
        request_notes     = COALESCE(?, request_notes),
        contact_name      = COALESCE(?, contact_name),
        contact_email     = COALESCE(?, contact_email),
        contact_phone     = COALESCE(?, contact_phone),
        contact_role      = COALESCE(?, contact_role),
        preview_url       = COALESCE(?, preview_url),
        pitch_url         = COALESCE(?, pitch_url),
        github_folder_url = COALESCE(?, github_folder_url),
        gcs_run_folder    = COALESCE(?, gcs_run_folder),
        mobile_score      = COALESCE(?, mobile_score),
        desktop_score     = COALESCE(?, desktop_score),
        fixed_count       = COALESCE(?, fixed_count),
        still_issue_count = COALESCE(?, still_issue_count),
        regressed_count   = COALESCE(?, regressed_count),
        rescanned_at      = COALESCE(?, rescanned_at),
        cost_est          = COALESCE(?, cost_est),
        error_detail      = COALESCE(?, error_detail),
        completed_at      = COALESCE(?, completed_at)
      WHERE id = ?`,
      [
        args.status         ?? null,
        args.websiteUrl     ?? null,
        args.requestNotes   ?? null,
        args.contactName    ?? null,
        args.contactEmail   ?? null,
        args.contactPhone   ?? null,
        args.contactRole    ?? null,
        args.previewUrl     ?? null,
        args.pitchUrl       ?? null,
        args.githubFolderUrl ?? null,
        args.gcsRunFolder   ?? null,
        args.mobileScore    ?? null,
        args.desktopScore   ?? null,
        args.fixedCount     ?? null,
        args.stillIssueCount ?? null,
        args.regressedCount ?? null,
        args.rescannedAt    ?? null,
        args.costEst        ?? null,
        args.errorDetail    ?? null,
        completedAt,
        buildId,
      ],
    );
    return buildId;
  } catch (err) {
    d1Error('updateBuild', 'builds', err);
  }
}

// ---------------------------------------------------------------------------
// Convenience entry point
// ---------------------------------------------------------------------------

/**
 * Upsert account + create initial "Auditing" audit row. Called at the START
 * of audit-site.js so even early failures leave a tracked row.
 *
 * @param {{ slug: string, practiceUrl: string, contactEmail: string, source: string }} opts
 * @returns {Promise<{ accountId: string|null, auditId: string|null }>}
 */
export async function startAudit({ slug, practiceUrl, contactEmail, source }) {
  if (!enabled()) return { accountId: null, auditId: null };
  const accountId = await upsertAccount({
    slug, practiceUrl, contactEmail, source,
    lifecycleStage: 'Prospect',
  });
  const auditId = await createAudit({
    accountId,
    slug,
    status:       'Auditing',
    websiteUrl:   practiceUrl,
    source,
    contactEmail,
  });
  return { accountId, auditId };
}
