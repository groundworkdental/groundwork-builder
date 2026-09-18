// Cloudflare D1 sink for the sourcing pipeline.
//
// Replaces Airtable sync (historical: scripts/legacy/airtable-sourcing.js).
// Writes pipeline records to the `sourced_practices` table — same table the
// ops dashboard reads and that migrate-airtable-sourced.mjs seeded.
//
// Pattern follows scripts/pipeline/lib/d1.js:
//   - D1 HTTP API (POST /query)
//   - env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN
//   - silent no-op (with one warning) when credentials are missing
//
// D1 HTTP API limit: max 100 bound parameters per statement.
// 32 columns/row → 3 rows per INSERT (96 params).

const D1_API = 'https://api.cloudflare.com/client/v4/accounts';

function creds() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !databaseId || !apiToken) return null;
  return { accountId, databaseId, apiToken };
}

export function d1Enabled() {
  return creds() !== null;
}

/** Execute one SQL statement against D1. Throws on API error. */
export async function d1Query(sql, params = []) {
  const c = creds();
  if (!c) throw new Error('D1 credentials missing (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN)');
  const res = await fetch(`${D1_API}/${c.accountId}/d1/database/${c.databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json().catch(() => null);
  if (!json?.success) {
    const msg = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`D1: ${msg}`);
  }
  return json.result?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Pipeline record → D1 row
// ---------------------------------------------------------------------------

const COLUMNS = [
  'place_id', 'practice_name', 'address', 'city', 'state', 'zip', 'msa_market',
  'website_url', 'final_url', 'gbp_url', 'phone', 'email', 'primary_type',
  'rating', 'review_count', 'business_status', 'status', 'tier', 'business_tier',
  'quadrant', 'weakness_score', 'weakness_tier', 'quality_score',
  'vendor', 'vendor_category',
  'lighthouse_performance', 'lighthouse_accessibility', 'lighthouse_seo', 'lighthouse_best_practices',
  'sourced_at', 'last_audited_at', 'raw',
];

/**
 * Everything that has no dedicated D1 column lives in `raw` (JSON).
 * Keys mirror the legacy Airtable field names so `raw` stays uniform with the
 * 673 rows migrated by migrate-airtable-sourced.mjs.
 */
function buildRawFields(p) {
  return {
    'Place ID': p.placeId,
    'Practice Name': p.practiceName,
    'Source': p.source || 'google-places-text-search',
    'Sourced At': p.sourcedAt,
    'MSA / Market': p.msa || '',
    'Address': p.address || '',
    'City': p.city || '',
    'State': p.state || '',
    'Zip': p.zip || '',
    'Latitude': p.lat ?? null,
    'Longitude': p.lng ?? null,
    'Google Maps / GBP': p.gbpUrl || '',
    'Website URL': p.websiteUrl || '',
    'Final URL': p.finalUrl || '',
    'Phone': p.phone || '',
    'Email': p.email || '',
    'Primary Type': p.primaryType || '',
    'Types': (p.types || []).join(', '),
    'Rating': p.rating ?? null,
    'Review Count': p.reviewCount ?? null,
    'Business Status': p.businessStatus || 'OPERATIONAL',
    'HTTP Status': p.httpStatus ?? null,
    'Vendor': p.vendor || '',
    'Vendor Category': p.vendorCategory || 'unknown',
    'WordPress Theme': p.wpTheme?.name || '',
    'Rendered HTML (GCS)': p.htmlGcsPath || '',
    'Is Chain / DSO': !!p.isChain,
    'Chain Name': p.chainName || '',
    'Multi-Location': !!p.multiLocation?.multiLocation,
    'Multi-Location Signals': p.multiLocation?.reason || '',
    'Lighthouse Performance': p.lighthouse?.performance ?? null,
    'Lighthouse Accessibility': p.lighthouse?.accessibility ?? null,
    'Lighthouse Best Practices': p.lighthouse?.bestPractices ?? null,
    'Lighthouse SEO': p.lighthouse?.seo ?? null,
    'Perf Band': p.bands?.performance || null,
    'Accessibility Band': p.bands?.accessibility || null,
    'Best-Practices Band': p.bands?.bestPractices || null,
    'SEO Band': p.bands?.seo || null,
    'llms.txt Status': p.llms?.status || null,
    'llms.txt URL': p.llms?.url || null,
    'Has HTTPS': !!p.features?.hasHttps,
    'Has Viewport Meta': !!p.features?.hasViewportMeta,
    'Has Schema.org': !!p.features?.hasSchemaOrg,
    'Has Click-to-Call': !!p.features?.hasClickToCall,
    'Has Booking Widget': !!p.features?.booking?.present,
    'Booking Vendor': p.features?.booking?.vendor || '',
    'Has Contact Form': !!p.features?.hasContactForm,
    'Per-Service Page Count': p.features?.serviceLinkCount ?? 0,
    'Dated-Tech Flags': p.features?.datedTechFlagCount ?? 0,
    'Dated-Tech Flag List': (p.features?.datedTechFlags || []).map((f) => f.id).join(', '),
    'Desktop Screenshot': p.desktopUrl || null,
    'Mobile Screenshot': p.mobileUrl || null,
    'Quality Score': p.scores?.qualityScore ?? null,
    'Weakness Score': p.scores?.weaknessScore ?? null,
    'Missing Items': (p.checklist?.missing || []).join('\n• '),
    'Business Tier': p.scores?.bizTier || null,
    'Weakness Tier': p.scores?.weakTier || null,
    'Is Exemplar': !!p.isExemplar,
    'Exemplar Blocked By': (p.exemplarFailedOn || []).join(', '),
    'Research Tier': p.researchTier || null,
    'Is Research Pool': !!p.isResearchPool,
    'Research Blocked By': (p.researchFailedOn || []).join(', '),
    'Tier': p.scores?.tier || null,
    'Quadrant': p.scores?.quadrant || null,
    'Status': p.status || 'new',
    'Last Audited At': p.lastAuditedAt || null,
    'Rubric Version': p.rubricVersion || '',
  };
}

/** Map one pipeline record to the COLUMNS param array. */
export function practiceToRow(p) {
  return [
    p.placeId,
    p.practiceName ?? null,
    p.address ?? null,
    p.city ?? null,
    p.state ?? null,
    p.zip ?? null,
    p.msa ?? null,
    p.websiteUrl ?? null,
    p.finalUrl ?? null,
    p.gbpUrl ?? null,
    p.phone ?? null,
    p.email ?? null,
    p.primaryType ?? null,
    p.rating ?? null,
    p.reviewCount ?? null,
    p.businessStatus ?? 'OPERATIONAL',
    p.status ?? 'new',
    p.scores?.tier ?? null,
    p.scores?.bizTier ?? null,
    p.scores?.quadrant ?? null,
    p.scores?.weaknessScore ?? null,
    p.scores?.weakTier ?? null,
    p.scores?.qualityScore ?? null,
    p.vendor ?? null,
    p.vendorCategory ?? 'unknown',
    p.lighthouse?.performance ?? null,
    p.lighthouse?.accessibility ?? null,
    p.lighthouse?.seo ?? null,
    p.lighthouse?.bestPractices ?? null,
    p.sourcedAt ?? null,
    p.lastAuditedAt ?? null,
    JSON.stringify(buildRawFields(p)),
  ];
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

const BATCH = 3; // 32 cols × 3 rows = 96 bound params (< 100 D1 limit)

// ON CONFLICT upsert (not INSERT OR REPLACE) so a re-sourcing run can never
// demote a prospect that was already promoted to Accounts: the stored status
// wins over an incoming 'new'.
const UPDATE_SET = COLUMNS.filter((c) => c !== 'place_id' && c !== 'status')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ');
const UPSERT_SQL_TAIL = `
  ON CONFLICT(place_id) DO UPDATE SET ${UPDATE_SET},
  status = CASE
    WHEN sourced_practices.status = 'promoted-to-accounts' AND excluded.status = 'new'
    THEN sourced_practices.status
    ELSE excluded.status
  END`;

/**
 * Upsert pipeline records into sourced_practices.
 * @param {object} opts
 * @param {Array<object>} opts.records   pipeline records (the same `p` shape recordToFields took)
 * @param {function} [opts.onProgress]   called with { done, total } after each batch, { error, batch } on failure
 * @returns {{ upserted: number, failed: number, skipped: boolean }}
 */
export async function upsertSourcedPractices({ records, onProgress } = {}) {
  if (!d1Enabled()) {
    console.error('  [d1] credentials missing — skipping DB sync (set CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN)');
    return { upserted: 0, failed: 0, skipped: true };
  }
  const rows = (records || []).filter((p) => p?.placeId);
  const placeholders = `(${COLUMNS.map(() => '?').join(', ')})`;

  let upserted = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const sql =
      `INSERT INTO sourced_practices (${COLUMNS.join(', ')}) VALUES ` +
      batch.map(() => placeholders).join(', ') +
      UPSERT_SQL_TAIL;
    try {
      await d1Query(sql, batch.flatMap(practiceToRow));
      upserted += batch.length;
      onProgress?.({ done: Math.min(i + BATCH, rows.length), total: rows.length });
    } catch (err) {
      failed += batch.length;
      onProgress?.({ error: err.message, batch: batch.map((b) => b.placeId) });
    }
  }
  return { upserted, failed, skipped: false };
}

/** Fetch one sourced practice by Place ID (for promote.js). */
export async function findSourcedByPlaceId(placeId) {
  const result = await d1Query('SELECT * FROM sourced_practices WHERE place_id = ? LIMIT 1', [placeId]);
  return result?.results?.[0] ?? null;
}

/** Update the status of one sourced practice (for promote.js). */
export async function setSourcedStatus(placeId, status) {
  await d1Query('UPDATE sourced_practices SET status = ? WHERE place_id = ?', [status, placeId]);
}

/**
 * Mark scrape failure by website URL (eval / builder path).
 * Matches website_url OR final_url; best-effort (0 rows OK).
 */
export async function setSourcedUnableToScrape(websiteUrl, detail = {}) {
  if (!websiteUrl) return { updated: 0 };
  const status = 'unable_to_scrape';
  let hostname = '';
  try { hostname = new URL(websiteUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const norm = String(websiteUrl).replace(/\/+$/, '');
  const result = await d1Query(
    `UPDATE sourced_practices
     SET status = ?
     WHERE lower(rtrim(website_url, '/')) = lower(?)
        OR lower(rtrim(final_url, '/')) = lower(?)
        OR (length(?) > 0 AND (
             lower(website_url) LIKE '%' || lower(?) || '%'
          OR lower(final_url) LIKE '%' || lower(?) || '%'
        ))`,
    [status, norm, norm, hostname, hostname, hostname],
  );
  return { updated: result?.meta?.changes ?? 0, status, detail };
}
