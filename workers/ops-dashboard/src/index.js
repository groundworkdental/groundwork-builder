// ops-dashboard — Cloudflare Worker
//
// Serves the whole ops ledger: client communications, accounts, audits,
// builds, prospect pipeline. It must never be reachable by the public.
//
// It previously said it was "protected by Cloudflare Access (no auth logic
// here)" and carried no check for that being true. It was deployed before
// Access was configured, and for a few minutes answered unauthenticated
// requests with real client data. The assumption was correct and the
// verification was missing — the same shape of defect as a consent line that
// defaults to true, or a site asserting worksFor for a doctor it never
// checked.
//
// So it now fails CLOSED. Access puts a signed Cf-Access-Jwt-Assertion header
// on every request it forwards; without one, this serves nothing. Deploying
// without Access in front now produces a dead dashboard rather than a public
// one.
//
// D1 binding: env.DB  (database_name = "groundwork-ops")

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Defense in depth: the workers.dev hostname bypasses Cloudflare Access
    // (which only guards ops.groundworkdental.com). Refuse to serve on it.
    if (url.hostname.endsWith('.workers.dev')) {
      return new Response('Forbidden — use ops.groundworkdental.com', { status: 403 });
    }

    // Fail closed. Access sets this header on everything it forwards; nothing
    // else can, because the hostname is proxied and the origin is this worker.
    // ALLOW_UNAUTHENTICATED exists for `wrangler dev` and is deliberately not
    // set in wrangler.toml, so production cannot acquire it by accident.
    if (env.ALLOW_UNAUTHENTICATED !== 'true' && !request.headers.get('Cf-Access-Jwt-Assertion')) {
      return new Response(
        'Forbidden — no Cloudflare Access assertion on this request.\n\n' +
        'This dashboard serves client data and refuses to run without Access in\n' +
        'front of it. Configure a Zero Trust Access application for this hostname,\n' +
        'or set ALLOW_UNAUTHENTICATED=true for local development only.\n',
        { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
    if (url.pathname.startsWith('/api/')) return handleApi(url, env);
    return serveUI(env);
  },
};

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleApi(url, env) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  try {
    const path = url.pathname;

    if (path === '/api/stats') {
      const [totals, successes, practices, week] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS n FROM runs').first(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE build_success = 1').first(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE design_profile IS NOT NULL').first(),
        env.DB.prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE created_at >= datetime('now', '-7 days')"
        ).first(),
      ]);
      return json({
        totalBuilds: totals?.n ?? 0,
        successRate:
          totals?.n > 0 ? Math.round(((successes?.n ?? 0) / totals.n) * 100) : 0,
        practices: practices?.n ?? 0,
        weekRuns: week?.n ?? 0,
      });
    }

    if (path === '/api/runs') {
      const { results } = await env.DB.prepare(
        `SELECT
           id, created_at, client_slug, practice_name, city,
           archetype, font_heading, font_body,
           build_success, duration_ms, gcs_prefix
         FROM runs
         ORDER BY created_at DESC
         LIMIT 200`
      ).all();
      return json(results ?? []);
    }

    // The queue: what is waiting on a human. Same source as `npm run log --
    // open`, because two answers to "what needs me?" is one answer too many.
    if (path === '/api/queue') {
      const [untriaged, unrouted, proposals, recent] = await Promise.all([
        env.DB.prepare(
          `SELECT id, slug, occurred_at, summary, actor FROM client_events
            WHERE kind = 'change' AND systemic IS NULL
            ORDER BY occurred_at DESC LIMIT 50`).all(),
        env.DB.prepare(
          `SELECT id, slug, occurred_at, summary, actor FROM client_events
            WHERE kind = 'change' AND systemic = 'yes'
              AND (routed_to IS NULL OR routed_to = '')
            ORDER BY occurred_at DESC LIMIT 50`).all(),
        env.DB.prepare(
          `SELECT id, slug, occurred_at, summary, detail FROM client_events
            WHERE kind = 'decision' AND summary LIKE 'PROPOSAL:%'
              AND (routed_to IS NULL OR routed_to = '')
            ORDER BY occurred_at DESC LIMIT 50`).all(),
        env.DB.prepare(
          `SELECT id, slug, occurred_at, kind, direction, summary, actor
             FROM client_events ORDER BY occurred_at DESC LIMIT 40`).all(),
      ]);
      return json({
        untriaged: untriaged.results || [],
        unrouted: unrouted.results || [],
        proposals: proposals.results || [],
        recent: recent.results || [],
      });
    }

    if (path === '/api/timeline') {
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, 400);
      const rows = await env.DB.prepare(
        `SELECT * FROM client_events WHERE slug = ? ORDER BY occurred_at DESC LIMIT 200`,
      ).bind(slug).all();
      return json({ events: rows.results || [] });
    }

    if (path === '/api/accounts') {
      const { results } = await env.DB.prepare(
        `SELECT a.slug, a.practice_name, a.city, a.state,
           a.practice_url AS url, a.lifecycle_stage,
           (SELECT MAX(r.created_at) FROM runs r WHERE r.client_slug = a.slug) AS last_build_at
         FROM accounts a
         ORDER BY a.practice_name ASC`
      ).all();
      return json(results ?? []);
    }

    if (path === '/api/practices') {
      const { results } = await env.DB.prepare(
        `SELECT a.slug,
           COALESCE(a.practice_name, MAX(r.practice_name), a.slug) AS practice_name,
           COALESCE(a.city, MAX(r.city)) AS city,
           json_extract(a.design_profile, '$.archetype')       AS archetype,
           json_extract(a.design_profile, '$.font_heading')    AS font_heading,
           json_extract(a.design_profile, '$.font_body')       AS font_body,
           json_extract(a.design_profile, '$.palette_primary') AS palette_primary,
           json_extract(a.design_profile, '$.adjectives')      AS adjectives,
           MAX(r.created_at) AS last_run
         FROM accounts a
         LEFT JOIN runs r ON r.client_slug = a.slug
         WHERE a.design_profile IS NOT NULL
         GROUP BY a.slug
         ORDER BY last_run DESC`
      ).all();
      return json(results ?? []);
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ---------------------------------------------------------------------------
// Inline UI  (all data fetched server-side — no client XHR, CF Access safe)
// ---------------------------------------------------------------------------

async function serveUI(env) {
  // Fetch everything in parallel before rendering
  let stats = { totalBuilds: 0, successRate: 0, practices: 0, weekRuns: 0, sourced: 0 };
  let runs = [], accounts = [], practices = [], builds = [], sourced = [], audits = [];
  let queue = { untriaged: [], unrouted: [], proposals: [], recent: [] };
  let dbError = null;
  // The queue is fetched separately: client_events is newer than the rest of
  // the schema, and a dashboard that 500s because one table is missing is a
  // dashboard nobody opens.
  try {
    const [untriaged, unrouted, proposals, recent] = await Promise.all([
      env.DB.prepare("SELECT id, slug, occurred_at, summary, actor FROM client_events WHERE kind = 'change' AND systemic IS NULL ORDER BY occurred_at DESC LIMIT 50").all(),
      env.DB.prepare("SELECT id, slug, occurred_at, summary, actor FROM client_events WHERE kind = 'change' AND systemic = 'yes' AND (routed_to IS NULL OR routed_to = '') ORDER BY occurred_at DESC LIMIT 50").all(),
      env.DB.prepare("SELECT id, slug, occurred_at, summary, detail FROM client_events WHERE kind = 'decision' AND (routed_to IS NULL OR routed_to = '') ORDER BY occurred_at DESC LIMIT 50").all(),
      env.DB.prepare("SELECT id, slug, occurred_at, kind, direction, summary, actor FROM client_events ORDER BY occurred_at DESC LIMIT 40").all(),
    ]);
    queue = {
      untriaged: untriaged.results || [], unrouted: unrouted.results || [],
      proposals: proposals.results || [], recent: recent.results || [],
    };
  } catch (err) {
    queue.error = err.message;
  }

  try {
    const [totals, successes, practiceCount, week, sourcedCount,
           runsRows, accountRows, practiceRows, buildRows, sourcedRows, auditRows] =
      await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS n FROM runs').first(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE build_success = 1').first(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE design_profile IS NOT NULL').first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE created_at >= datetime('now', '-7 days')").first(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM sourced_practices').first(),
        env.DB.prepare(`SELECT id, created_at, client_slug, practice_name, doctor_name, city, phone,
           archetype, hero_variant, font_heading, font_body, palette_primary, palette_mood,
           services_count, build_success, duration_ms, gcs_prefix, url
           FROM runs ORDER BY created_at DESC LIMIT 200`).all(),
        env.DB.prepare(`SELECT a.slug, a.practice_name, a.city, a.state, a.phone,
           a.contact_email, a.business_email, a.source, a.created_at,
           a.practice_url AS url, a.lifecycle_stage,
           (SELECT MAX(r.created_at) FROM runs r WHERE r.client_slug = a.slug) AS last_build_at
           FROM accounts a ORDER BY a.practice_name ASC`).all(),
        env.DB.prepare(`SELECT a.slug,
           COALESCE(a.practice_name, MAX(r.practice_name), a.slug) AS practice_name,
           COALESCE(a.city, MAX(r.city)) AS city,
           json_extract(a.design_profile, '$.archetype')        AS archetype,
           json_extract(a.design_profile, '$.hero_variant')     AS hero_variant,
           json_extract(a.design_profile, '$.font_heading')     AS font_heading,
           json_extract(a.design_profile, '$.font_body')        AS font_body,
           json_extract(a.design_profile, '$.palette_primary')  AS palette_primary,
           json_extract(a.design_profile, '$.palette_mood')     AS palette_mood,
           json_extract(a.design_profile, '$.adjectives')       AS adjectives,
           json_extract(a.design_profile, '$.tag')              AS tag,
           json_extract(a.design_profile, '$.note')             AS note,
           MAX(r.created_at) AS last_run
           FROM accounts a
           LEFT JOIN runs r ON r.client_slug = a.slug
           WHERE a.design_profile IS NOT NULL
           GROUP BY a.slug ORDER BY last_run DESC`).all(),
        env.DB.prepare(`SELECT id, build_slug, status, website_url, preview_url, pitch_url,
           github_folder_url, mobile_score, desktop_score, contact_name, contact_email,
           fixed_count, still_issue_count, completed_at, date_added
           FROM builds ORDER BY date_added DESC LIMIT 200`).all(),
        env.DB.prepare(`SELECT place_id, practice_name, address, city, state, zip, msa_market,
           website_url, final_url, gbp_url, phone, email, primary_type, rating, review_count,
           business_status, status, tier, business_tier, quadrant,
           weakness_score, weakness_tier, quality_score, vendor, vendor_category,
           lighthouse_performance, lighthouse_accessibility, lighthouse_seo, sourced_at,
           json_extract(raw, '$."Is Exemplar"')          AS is_exemplar,
           json_extract(raw, '$."Research Tier"')        AS research_tier,
           json_extract(raw, '$."Exemplar Blocked By"')  AS exemplar_blocked_by
           FROM sourced_practices
           ORDER BY
             CASE tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 WHEN 'D' THEN 3 ELSE 4 END,
             weakness_score DESC NULLS LAST
           LIMIT 1000`).all(),
        env.DB.prepare(`SELECT id, slug, status, website_url, source, contact_email,
           total_checks, passed, critical, warnings, mobile_score, desktop_score,
           gbp_reviews, gbp_rating, audit_report_url, gcs_run_folder, error_detail,
           completed_at, date_added
           FROM audits ORDER BY date_added DESC LIMIT 200`).all(),
      ]);
    stats = {
      totalBuilds: totals?.n ?? 0,
      successRate: totals?.n > 0 ? Math.round(((successes?.n ?? 0) / totals.n) * 100) : 0,
      practices: practiceCount?.n ?? 0,
      weekRuns: week?.n ?? 0,
      sourced: sourcedCount?.n ?? 0,
    };
    runs      = runsRows?.results     ?? [];
    accounts  = accountRows?.results  ?? [];
    practices = practiceRows?.results ?? [];
    builds    = buildRows?.results    ?? [];
    sourced   = sourcedRows?.results  ?? [];
    audits    = auditRows?.results    ?? [];
  } catch (e) {
    console.error('serveUI D1 error:', e.message);
    dbError = e.message;
  }

  // Safe JSON embedding: escape </script> so it never terminates the script tag
  const safeJson = (d) => JSON.stringify(d).replace(/<\//g, '<\\/');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Groundwork Ops</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    /* Brand */
    --sage:         #5F7F6B;
    --sage-dark:    #4A6B55;
    --sage-darker:  #3D5A48;
    --sage-tint:    #EBF0EC;
    /* Neutrals */
    --charcoal:     #334155;
    --mid-gray:     #64748B;
    --border-light: #E0DDD5;
    /* Surfaces */
    --surface-1:    #FFFFFF;
    --surface-2:    #F8F8F3;
    /* Semantic */
    --success-text: #4A6B55;
    --success-bg:   #EBF0EC;
    --warning-text: #92400E;
    --warning-bg:   #FCF4E8;
    --pending-text: #475569;
    --pending-bg:   #F1F0EB;
    --danger-text:  #B42318;
    --danger-bg:    #FDF0EE;
    /* Type */
    --font-sans: 'Figtree', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    --font-serif: Georgia, 'Times New Roman', serif;
    --font-mono:  ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    --radius: 4px;
  }

  body {
    font-family: var(--font-sans);
    background: var(--surface-1);
    color: var(--charcoal);
    font-size: 14px;
    line-height: 1.5;
  }

  /* ---- Header ---- */
  header {
    background: var(--surface-1);
    border-bottom: 1px solid var(--border-light);
    padding: 0 24px;
    height: 56px;
    display: flex;
    align-items: center;
    gap: 10px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header .logo {
    font-family: var(--font-serif);
    font-size: 18px;
    color: var(--charcoal);
    text-decoration: none;
    display: flex;
    align-items: baseline;
    gap: 0;
  }
  header .logo-sub {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--sage-dark);
    margin-left: 6px;
  }
  header .divider {
    width: 1px;
    height: 16px;
    background: var(--border-light);
    margin: 0 4px;
  }
  header .env-badge {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    background: var(--sage-tint);
    color: var(--sage-dark);
    padding: 2px 8px;
    border-radius: 99px;
  }

  /* ---- Stats bar ---- */
  .stats-bar {
    background: var(--surface-2);
    border-bottom: 1px solid var(--border-light);
    padding: 0 24px;
    display: flex;
    gap: 0;
  }
  .stat {
    padding: 14px 24px 14px 0;
    border-right: 1px solid var(--border-light);
    margin-right: 24px;
  }
  .stat:last-child { border-right: none; }
  .stat-val {
    font-family: var(--font-mono);
    font-size: 22px;
    color: var(--sage);
    line-height: 1;
  }
  .stat-label {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--mid-gray);
    margin-top: 4px;
  }

  /* ---- Tabs ---- */
  .tabs {
    border-bottom: 1px solid var(--border-light);
    padding: 0 24px;
    display: flex;
    background: var(--surface-1);
  }
  .tab-btn {
    padding: 14px 18px;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 500;
    color: var(--mid-gray);
    border: none;
    background: none;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 0.2s, border-color 0.2s;
    letter-spacing: 0.01em;
  }
  .tab-btn.active { color: var(--charcoal); border-bottom-color: var(--sage); }
  .tab-btn:hover  { color: var(--charcoal); }
  .tab-sep { width: 1px; background: var(--border-light); margin: 12px 10px; }

  /* ---- Content ---- */
  .content { padding: 24px; max-width: 1400px; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* ---- Toolbar (every tab): view toggle + columns + search ---- */
  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .view-toggle { display: flex; gap: 0; }
  .view-btn {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    padding: 6px 14px;
    border: 1px solid var(--border-light);
    background: var(--surface-1);
    color: var(--mid-gray);
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }
  .view-btn:first-child { border-radius: var(--radius) 0 0 var(--radius); border-right: none; }
  .view-btn:last-child  { border-radius: 0 var(--radius) var(--radius) 0; }
  .view-btn.active { background: var(--sage-tint); color: var(--sage-dark); }

  .toolbar input[type="search"] {
    font-family: var(--font-sans);
    font-size: 13px;
    padding: 7px 12px;
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    width: 280px;
    max-width: 100%;
    color: var(--charcoal);
    background: var(--surface-1);
  }
  .toolbar input[type="search"]:focus { outline: 2px solid var(--sage); outline-offset: 1px; }
  .filter-count { font-size: 12px; color: var(--mid-gray); margin-left: auto; }

  /* ---- Columns dropdown ---- */
  .col-picker { position: relative; }
  .col-btn {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    padding: 6px 14px;
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    background: var(--surface-1);
    color: var(--mid-gray);
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }
  .col-btn:hover, .col-picker.open .col-btn { color: var(--charcoal); }
  .col-menu {
    display: none;
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    background: var(--surface-1);
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgba(51,65,85,0.10);
    padding: 8px;
    min-width: 190px;
    max-height: 320px;
    overflow-y: auto;
  }
  .col-picker.open .col-menu { display: block; }
  .col-menu label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--charcoal);
    padding: 5px 8px;
    border-radius: var(--radius);
    cursor: pointer;
    user-select: none;
  }
  .col-menu label:hover { background: var(--surface-2); }
  .col-menu input { accent-color: var(--sage-dark); }
  .col-menu-actions {
    display: flex;
    gap: 6px;
    padding: 2px 4px 8px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--border-light);
  }
  .col-menu-actions button {
    flex: 1;
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    padding: 5px 8px;
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    background: var(--surface-1);
    color: var(--sage-dark);
    cursor: pointer;
    transition: background 0.2s;
  }
  .col-menu-actions button:hover { background: var(--sage-tint); }

  /* ---- Generic grid cards ---- */
  .gcard-title {
    font-family: var(--font-serif);
    font-size: 15px;
    color: var(--charcoal);
    line-height: 1.3;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .gcard-rows { display: flex; flex-direction: column; gap: 5px; }
  .gcard-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
  .gcard-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--mid-gray);
    min-width: 72px;
    flex-shrink: 0;
  }

  /* ---- Table ---- */
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    background: var(--surface-1);
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    background: var(--surface-2);
    padding: 10px 14px;
    text-align: left;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--mid-gray);
    border-bottom: 1px solid var(--border-light);
    white-space: nowrap;
  }
  td {
    padding: 11px 14px;
    border-bottom: 1px solid var(--border-light);
    vertical-align: middle;
    color: var(--charcoal);
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface-2); }

  /* ---- Build badge ---- */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 99px;
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge-ok  { background: var(--success-bg); color: var(--success-text); }
  .badge-err { background: var(--danger-bg);  color: var(--danger-text);  }

  /* ---- Lifecycle badges ---- */
  .lc-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 99px;
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .lc-prospect  { background: var(--pending-bg);  color: var(--pending-text); }
  .lc-audited   { background: #EEF2FF;             color: #3730A3; }
  .lc-preview   { background: #F5F0FF;             color: #5B21B6; }
  .lc-pitched   { background: var(--warning-bg);   color: var(--warning-text); }
  .lc-contacted { background: #FFF4ED;             color: #9A3412; }
  .lc-signed    { background: var(--success-bg);   color: var(--success-text); }
  .lc-live      { background: var(--sage-tint);    color: var(--sage-dark); }
  .lc-active    { background: var(--sage-tint);    color: var(--sage-darker); }
  .lc-churned   { background: var(--surface-2);    color: var(--mid-gray); }

  /* ---- Opportunity grade badges ---- */
  .grade-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    padding: 2px 7px;
    border-radius: var(--radius);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
  }
  .grade-A { background: var(--sage-dark);   color: #fff; }
  .grade-B { background: var(--sage-tint);   color: var(--sage-darker); }
  .grade-C { background: var(--warning-bg);  color: var(--warning-text); }
  .grade-D { background: var(--pending-bg);  color: var(--pending-text); }

  /* ---- Sortable headers ---- */
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--charcoal); }
  th.sorted { color: var(--sage-dark); }

  /* ---- Archetype label ---- */
  .archetype-tag {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 500;
    color: var(--sage-dark);
    background: var(--sage-tint);
    padding: 2px 8px;
    border-radius: var(--radius);
    white-space: nowrap;
  }

  /* ---- Swatch ---- */
  .swatch {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid rgba(0,0,0,.1);
    vertical-align: middle;
    flex-shrink: 0;
  }

  /* ---- Practice cards ---- */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
    gap: 16px;
  }
  .practice-card {
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    padding: 20px;
    background: var(--surface-2);
    transition: border-color 0.2s;
  }
  .practice-card:hover { border-color: rgba(95,127,107,0.4); }
  .practice-card .card-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 12px;
  }
  .practice-card .card-name {
    font-family: var(--font-serif);
    font-size: 15px;
    color: var(--charcoal);
    line-height: 1.3;
  }
  .practice-card .card-city {
    font-size: 12px;
    color: var(--mid-gray);
    margin-top: 2px;
  }
  .practice-card .card-meta {
    font-size: 12px;
    color: var(--mid-gray);
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 10px;
  }
  .practice-card .meta-row { display: flex; align-items: baseline; gap: 6px; }
  .practice-card .meta-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--mid-gray);
    min-width: 54px;
    flex-shrink: 0;
  }
  .practice-card .meta-val { color: var(--charcoal); }
  .pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
  .pill {
    background: var(--surface-1);
    border: 1px solid var(--border-light);
    border-radius: 99px;
    padding: 2px 9px;
    font-size: 11px;
    color: var(--mid-gray);
  }

  /* ---- GCS link ---- */
  .gcs-link {
    color: var(--sage-dark);
    text-decoration: none;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }
  .gcs-link:hover { text-decoration: underline; }

  /* ---- Loading / empty ---- */
  .loading-row td, .empty-row td {
    text-align: center;
    color: var(--mid-gray);
    padding: 40px;
    font-size: 13px;
    font-style: italic;
  }

  /* ---- Mobile ---- */
  @media (max-width: 640px) {
    .stats-bar { flex-wrap: wrap; padding: 0 16px; }
    .stat { padding: 10px 16px 10px 0; margin-right: 16px; }
    .content { padding: 16px; }
    .tab-btn { padding: 12px; font-size: 12px; }
  }
</style>
</head>
<body>

<header>
  <a class="logo" href="/">Groundwork<span class="logo-sub">ops</span></a>
  <span class="divider"></span>
  <span class="env-badge">internal</span>
</header>
${dbError ? `<div style="background:var(--danger-bg);color:var(--danger-text);padding:10px 24px;font-size:13px;font-weight:500">Database error: ${dbError.replace(/</g, '&lt;')}</div>` : ''}

<div class="stats-bar">
  <div class="stat"><div class="stat-val">${stats.sourced}</div><div class="stat-label">Prospects</div></div>
  <div class="stat"><div class="stat-val">${stats.totalBuilds}</div><div class="stat-label">Pipeline Runs</div></div>
  <div class="stat"><div class="stat-val">${stats.successRate}%</div><div class="stat-label">Success Rate</div></div>
  <div class="stat"><div class="stat-val">${stats.weekRuns}</div><div class="stat-label">This Week</div></div>
  <div class="stat"><div class="stat-val">${stats.practices}</div><div class="stat-label">Design Profiles</div></div>
</div>

<style>
  .q-head{font-size:15px;font-weight:600;margin:0 0 18px;color:#e5e7eb}
  .q-clear{padding:28px;text-align:center;color:#9ca3af;border:1px dashed #374151;border-radius:8px}
  .q-section{margin-bottom:26px}
  .q-title{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin:0 0 4px}
  .q-count{display:inline-block;background:#374151;color:#e5e7eb;border-radius:9px;padding:1px 7px;font-size:11px;margin-left:6px}
  .q-note{font-size:12px;color:#6b7280;margin:0 0 10px}
  .q-row{border:1px solid #374151;border-radius:6px;padding:10px 12px;margin-bottom:7px;background:#111827}
  .q-row.q-thin{padding:7px 12px;background:transparent}
  .q-main{font-size:13px;color:#f3f4f6;margin-bottom:3px}
  .q-meta{font-size:11px;color:#9ca3af}
  .q-cmd{display:block;margin-top:7px;font-size:11px;color:#6ee7b7;background:#0b1220;padding:5px 7px;border-radius:4px;overflow-x:auto}
</style>

<div class="tabs">
  <button class="tab-btn active" data-tab="queue">Queue</button>
  <span class="tab-sep"></span>
  <button class="tab-btn" data-tab="sourced">Prospects</button>
  <button class="tab-btn" data-tab="accounts">Accounts</button>
  <button class="tab-btn" data-tab="audits">Audits</button>
  <button class="tab-btn" data-tab="builds">Previews</button>
  <span class="tab-sep"></span>
  <button class="tab-btn" data-tab="runs">Runs</button>
  <button class="tab-btn" data-tab="practices">Design Library</button>
</div>

<div class="content">
  <div class="panel active" id="tab-queue"></div>
  <div class="panel" id="tab-sourced"></div>
  <div class="panel" id="tab-accounts"></div>
  <div class="panel" id="tab-audits"></div>
  <div class="panel" id="tab-builds"></div>
  <div class="panel" id="tab-runs"></div>
  <div class="panel" id="tab-practices"></div>
</div>

<script>
// ---------------------------------------------------------------------------
// Data is injected server-side — no fetch calls needed
// ---------------------------------------------------------------------------
const RUNS      = ${safeJson(runs)};
const PRACTICES = ${safeJson(practices)};
const ACCOUNTS  = ${safeJson(accounts)};
const BUILDS    = ${safeJson(builds)};
const SOURCED   = ${safeJson(sourced)};
const AUDITS    = ${safeJson(audits)};
const QUEUE     = ${safeJson(queue)};

// ---------------------------------------------------------------------------
// Helpers (NOTE: no backslash escapes allowed — this lives in a server template)
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}
function parseAdj(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch (e) { return String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
}
function dim(h)   { return '<span style="color:var(--mid-gray)">' + h + '</span>'; }
function mono(h)  { return '<span style="font-family:var(--font-mono);font-size:12px">' + h + '</span>'; }
function serif(s) { return '<span style="font-family:var(--font-serif);font-weight:600">' + esc(s || '—') + '</span>'; }
function tagEl(s) { return s ? '<span class="archetype-tag">' + esc(s) + '</span>' : dim('—'); }
function swatch(c){ return '<span class="swatch" style="background:' + esc(c || '#94a3b8') + '"></span>'; }
function pills(raw) {
  const a = parseAdj(raw);
  return a.length
    ? a.slice(0, 5).map(function (x) { return '<span class="pill">' + esc(x) + '</span>'; }).join(' ')
    : dim('—');
}
function stripProto(u) {
  return String(u || '').replace('https://', '').replace('http://', '').replace('www.', '');
}
function siteLink(u) {
  if (!u) return dim('—');
  const label = stripProto(u).split('/')[0];
  return '<a href="' + esc(u) + '" target="_blank" rel="noopener" style="color:var(--sage-dark);text-decoration:none;font-size:12px;font-weight:500">' + esc(label) + ' ↗</a>';
}
function namedLink(u, label) {
  if (!u) return dim('—');
  return '<a href="' + esc(u) + '" target="_blank" rel="noopener" style="color:var(--sage-dark);text-decoration:none;font-size:12px;font-weight:500">' + esc(label) + ' ↗</a>';
}
const LC_CLASS = {
  'Prospect': 'lc-prospect', 'Audited': 'lc-audited', 'Preview Requested': 'lc-preview',
  'Pitched': 'lc-pitched', 'Contacted': 'lc-contacted', 'Signed': 'lc-signed',
  'Onboarding': 'lc-signed', 'Live': 'lc-live', 'Active': 'lc-active', 'Churned': 'lc-churned',
};
function lcBadge(stage) {
  if (!stage) return dim('—');
  const cls = LC_CLASS[stage] || 'lc-prospect';
  return '<span class="lc-badge ' + cls + '">' + esc(stage) + '</span>';
}
function okErr(v) {
  return v ? '<span class="badge badge-ok">✓</span>' : '<span class="badge badge-err">✗</span>';
}
// Opportunity grade (tier): A = high-value business with severely weak site,
// B = high biz / moderate weakness, C = mid biz / weak site, D = rest.
function gradeBadge(t) {
  if (!t) return dim('—');
  const cls = (t === 'A' || t === 'B' || t === 'C' || t === 'D') ? 'grade-' + t : 'grade-D';
  return '<span class="grade-badge ' + cls + '">' + esc(t) + '</span>';
}
function dimDate(v) { return dim(mono(fmtDate(v))); }
function dimText(v) { return dim(esc(v || '—')); }
function monoNum(v) { return v != null ? mono(esc(v)) : dim('—'); }

// ---------------------------------------------------------------------------
// Column configs — key, label, on (visible by default), primary (card title),
// html(row) renderer, nowrap
// ---------------------------------------------------------------------------

const COLS = {
  runs: [
    { key: 'created_at',     label: 'Date',       on: true,  nowrap: true, html: function (r) { return dimDate(r.created_at); } },
    { key: 'practice',       label: 'Practice',   on: true,  primary: true, sortKey: 'practice_name', html: function (r) { return serif(r.practice_name || r.client_slug); } },
    { key: 'doctor_name',    label: 'Doctor',     on: false, html: function (r) { return dimText(r.doctor_name); } },
    { key: 'city',           label: 'City',       on: true,  html: function (r) { return dimText(r.city); } },
    { key: 'phone',          label: 'Phone',      on: false, nowrap: true, html: function (r) { return dimText(r.phone); } },
    { key: 'archetype',      label: 'Archetype',  on: true,  html: function (r) { return tagEl(r.archetype); } },
    { key: 'hero_variant',   label: 'Hero',       on: false, html: function (r) { return dimText(r.hero_variant); } },
    { key: 'fonts',          label: 'Fonts',      on: true,  sortKey: 'font_heading',  html: function (r) { return r.font_heading ? dim(esc(r.font_heading + ' / ' + (r.font_body || '…'))) : dim('—'); } },
    { key: 'palette',        label: 'Palette',    on: false, nowrap: true, sortKey: 'palette_primary', html: function (r) { return r.palette_primary ? swatch(r.palette_primary) + ' ' + mono(esc(r.palette_primary)) : dim('—'); } },
    { key: 'palette_mood',   label: 'Mood',       on: false, html: function (r) { return dimText(r.palette_mood); } },
    { key: 'services_count', label: 'Services',   on: false, html: function (r) { return monoNum(r.services_count); } },
    { key: 'build_success',  label: 'Build',      on: true,  html: function (r) { return okErr(r.build_success); } },
    { key: 'duration_ms',    label: 'Duration',   on: true,  nowrap: true, html: function (r) { return dim(mono(fmtDur(r.duration_ms))); } },
    { key: 'url',            label: 'Source Site',on: false, html: function (r) { return siteLink(r.url); } },
    { key: 'gcs_prefix',     label: 'Artifact',   on: true,  nowrap: true, html: function (r) { return r.gcs_prefix ? namedLink('https://console.cloud.google.com/storage/browser/' + r.gcs_prefix, 'GCS') : dim('—'); } },
  ],
  practices: [
    { key: 'practice',     label: 'Practice',   on: true,  primary: true, sortKey: 'practice_name', html: function (r) { return swatch(r.palette_primary) + ' ' + serif(r.practice_name || r.slug); } },
    { key: 'city',         label: 'City',       on: true,  html: function (r) { return dimText(r.city); } },
    { key: 'archetype',    label: 'Archetype',  on: true,  html: function (r) { return tagEl(r.archetype); } },
    { key: 'hero_variant', label: 'Hero',       on: false, html: function (r) { return dimText(r.hero_variant); } },
    { key: 'fonts',        label: 'Fonts',      on: true,  sortKey: 'font_heading',  html: function (r) { return r.font_heading ? dim(esc(r.font_heading + ' / ' + (r.font_body || '…'))) : dim('—'); } },
    { key: 'palette',      label: 'Palette',    on: false, nowrap: true, sortKey: 'palette_primary', html: function (r) { return r.palette_primary ? mono(esc(r.palette_primary)) : dim('—'); } },
    { key: 'palette_mood', label: 'Mood',       on: false, html: function (r) { return dimText(r.palette_mood); } },
    { key: 'adjectives',   label: 'Adjectives', on: true,  html: function (r) { return pills(r.adjectives); } },
    { key: 'tag',          label: 'Tag',        on: false, html: function (r) { return dimText(r.tag); } },
    { key: 'note',         label: 'Note',       on: false, html: function (r) { return dimText(r.note); } },
    { key: 'last_run',     label: 'Last Run',   on: true,  nowrap: true, html: function (r) { return dimDate(r.last_run); } },
  ],
  accounts: [
    { key: 'practice',        label: 'Practice',       on: true,  primary: true, sortKey: 'practice_name', html: function (r) { return serif(r.practice_name || r.slug); } },
    { key: 'lifecycle_stage', label: 'Lifecycle',      on: true,  html: function (r) { return lcBadge(r.lifecycle_stage || 'Prospect'); } },
    { key: 'city',            label: 'City',           on: true,  html: function (r) { return dimText([r.city, r.state].filter(Boolean).join(', ')); } },
    { key: 'phone',           label: 'Phone',          on: false, nowrap: true, html: function (r) { return dimText(r.phone); } },
    { key: 'contact_email',   label: 'Contact Email',  on: true,  html: function (r) { return dimText(r.contact_email); } },
    { key: 'business_email',  label: 'Business Email', on: false, html: function (r) { return dimText(r.business_email); } },
    { key: 'source',          label: 'Source',         on: false, html: function (r) { return dimText(r.source); } },
    { key: 'url',             label: 'URL',            on: true,  html: function (r) { return siteLink(r.url); } },
    { key: 'created_at',      label: 'Created',        on: true,  nowrap: true, html: function (r) { return dimDate(r.created_at); } },
    { key: 'last_build_at',   label: 'Last Build',     on: true,  nowrap: true, html: function (r) { return dimDate(r.last_build_at); } },
  ],
  audits: [
    { key: 'date_added',       label: 'Date',      on: true,  nowrap: true, html: function (r) { return dimDate(r.date_added); } },
    { key: 'slug',             label: 'Slug',      on: true,  primary: true, html: function (r) { return serif(r.slug); } },
    { key: 'status',           label: 'Status',    on: true,  html: function (r) { return lcBadge(r.status); } },
    { key: 'website_url',      label: 'Site',      on: true,  html: function (r) { return siteLink(r.website_url); } },
    { key: 'checks',           label: 'Checks',    on: true,  nowrap: true, sortKey: 'passed', html: function (r) { return (r.passed != null && r.total_checks != null) ? mono(esc(r.passed + ' / ' + r.total_checks)) : dim('—'); } },
    { key: 'critical',         label: 'Critical',  on: true,  html: function (r) { return r.critical != null ? (r.critical > 0 ? '<span class="lc-badge" style="background:var(--danger-bg);color:var(--danger-text)">' + esc(r.critical) + '</span>' : mono('0')) : dim('—'); } },
    { key: 'warnings',         label: 'Warnings',  on: false, html: function (r) { return monoNum(r.warnings); } },
    { key: 'scores',           label: 'Scores',    on: true,  nowrap: true, sortKey: 'mobile_score', html: function (r) { return (r.mobile_score != null || r.desktop_score != null) ? mono(esc((r.mobile_score != null ? r.mobile_score : '–') + ' / ' + (r.desktop_score != null ? r.desktop_score : '–'))) : dim('—'); } },
    { key: 'gbp',              label: 'GBP',       on: false, nowrap: true, sortKey: 'gbp_rating', html: function (r) { return r.gbp_rating != null ? mono(esc(r.gbp_rating)) + ' ' + dim('(' + (r.gbp_reviews != null ? r.gbp_reviews : 0) + ')') : dim('—'); } },
    { key: 'source',           label: 'Source',    on: false, html: function (r) { return dimText(r.source); } },
    { key: 'contact_email',    label: 'Email',     on: true,  html: function (r) { return dimText(r.contact_email); } },
    { key: 'audit_report_url', label: 'Report',    on: true,  html: function (r) { return namedLink(r.audit_report_url, 'Report'); } },
    { key: 'gcs_run_folder',   label: 'GCS',       on: true,  nowrap: true, html: function (r) { return r.gcs_run_folder ? namedLink('https://console.cloud.google.com/storage/browser/' + r.gcs_run_folder, 'GCS') : dim('—'); } },
    { key: 'error_detail',     label: 'Error',     on: false, html: function (r) { return dimText(r.error_detail); } },
    { key: 'completed_at',     label: 'Completed', on: false, nowrap: true, html: function (r) { return dimDate(r.completed_at); } },
  ],
  builds: [
    { key: 'date_added',        label: 'Date',       on: true,  nowrap: true, html: function (r) { return dimDate(r.date_added); } },
    { key: 'build_slug',        label: 'Slug',       on: true,  primary: true, html: function (r) { return serif(r.build_slug); } },
    { key: 'status',            label: 'Status',     on: true,  html: function (r) { return lcBadge(r.status); } },
    { key: 'scores',            label: 'Scores',     on: true,  nowrap: true, sortKey: 'mobile_score', html: function (r) { return (r.mobile_score != null || r.desktop_score != null) ? mono(esc((r.mobile_score != null ? r.mobile_score : '–') + ' / ' + (r.desktop_score != null ? r.desktop_score : '–'))) : dim('—'); } },
    { key: 'preview_url',       label: 'Preview',    on: true,  html: function (r) { return namedLink(r.preview_url, 'Preview'); } },
    { key: 'pitch_url',         label: 'Pitch',      on: true,  html: function (r) { return namedLink(r.pitch_url, 'Pitch'); } },
    { key: 'github_folder_url', label: 'GitHub',     on: false, html: function (r) { return namedLink(r.github_folder_url, 'GitHub'); } },
    { key: 'website_url',       label: 'Site',       on: true,  html: function (r) { return siteLink(r.website_url); } },
    { key: 'contact_name',      label: 'Contact',    on: false, html: function (r) { return dimText(r.contact_name); } },
    { key: 'contact_email',     label: 'Email',      on: true,  html: function (r) { return dimText(r.contact_email); } },
    { key: 'fixed_count',       label: 'Fixed',      on: false, html: function (r) { return monoNum(r.fixed_count); } },
    { key: 'still_issue_count', label: 'Still Open', on: false, html: function (r) { return monoNum(r.still_issue_count); } },
    { key: 'completed_at',      label: 'Completed',  on: true,  nowrap: true, html: function (r) { return dimDate(r.completed_at); } },
  ],
  sourced: [
    { key: 'practice',        label: 'Practice',    on: true,  primary: true, sortKey: 'practice_name', html: function (r) { return serif(r.practice_name); } },
    { key: 'city',            label: 'City',        on: true,  html: function (r) { return dimText(r.city); } },
    { key: 'state',           label: 'State',       on: true,  html: function (r) { return dimText(r.state); } },
    { key: 'zip',             label: 'Zip',         on: false, html: function (r) { return dimText(r.zip); } },
    { key: 'address',         label: 'Address',     on: false, html: function (r) { return dimText(r.address); } },
    { key: 'msa_market',      label: 'Market',      on: false, html: function (r) { return dimText(r.msa_market); } },
    { key: 'opportunity',     label: 'Opportunity', on: true,  sortKey: 'tier', html: function (r) { return gradeBadge(r.tier); } },
    { key: 'quadrant',        label: 'Quadrant',    on: true,  html: function (r) { return dimText(r.quadrant); } },
    { key: 'rating',          label: 'Rating',      on: true,  nowrap: true, html: function (r) { return r.rating != null ? mono(esc(r.rating)) + ' ' + dim('(' + (r.review_count != null ? r.review_count : 0) + ')') : dim('—'); } },
    { key: 'weakness',        label: 'Weakness',    on: true,  nowrap: true, sortKey: 'weakness_score', html: function (r) { return r.weakness_score != null ? mono(Number(r.weakness_score).toFixed(1)) + (r.weakness_tier ? ' ' + dim(esc(r.weakness_tier)) : '') : dim('—'); } },
    { key: 'quality_score',   label: 'Quality',     on: true,  html: function (r) { return r.quality_score != null ? mono(Number(r.quality_score).toFixed(1)) : dim('—'); } },
    { key: 'business_tier',   label: 'Biz Tier',    on: false, html: function (r) { return dimText(r.business_tier); } },
    { key: 'is_exemplar',     label: 'Exemplar',    on: false, html: function (r) { return r.is_exemplar ? '<span class="badge badge-ok">★ Exemplar</span>' : dim('—'); } },
    { key: 'research_tier',   label: 'Research',    on: false, html: function (r) { return gradeBadge(r.research_tier); } },
    { key: 'exemplar_blocked_by', label: 'Blocked By', on: false, html: function (r) { return dimText(r.exemplar_blocked_by); } },
    { key: 'vendor',          label: 'Vendor',      on: true,  html: function (r) { return dimText(r.vendor); } },
    { key: 'vendor_category', label: 'Vendor Cat.', on: false, html: function (r) { return dimText(r.vendor_category); } },
    { key: 'primary_type',    label: 'Type',        on: false, html: function (r) { return dimText(r.primary_type); } },
    { key: 'lh_perf',         label: 'Perf',        on: true,  html: function (r) { return monoNum(r.lighthouse_performance); } },
    { key: 'lh_a11y',         label: 'A11y',        on: false, html: function (r) { return monoNum(r.lighthouse_accessibility); } },
    { key: 'lh_seo',          label: 'SEO',         on: false, html: function (r) { return monoNum(r.lighthouse_seo); } },
    { key: 'status',          label: 'Status',      on: true,  html: function (r) { return lcBadge(r.status); } },
    { key: 'business_status', label: 'Biz Status',  on: false, html: function (r) { return dimText(r.business_status); } },
    { key: 'site',            label: 'Site',        on: true,  sortKey: 'final_url',  html: function (r) { return siteLink(r.final_url || r.website_url); } },
    { key: 'gbp_url',         label: 'GBP',         on: false, html: function (r) { return namedLink(r.gbp_url, 'Maps'); } },
    { key: 'phone',           label: 'Phone',       on: false, nowrap: true, html: function (r) { return dimText(r.phone); } },
    { key: 'email',           label: 'Email',       on: false, html: function (r) { return dimText(r.email); } },
    { key: 'sourced_at',      label: 'Sourced',     on: false, nowrap: true, html: function (r) { return dimDate(r.sourced_at); } },
  ],
};

const DATA = { runs: RUNS, practices: PRACTICES, accounts: ACCOUNTS, builds: BUILDS, sourced: SOURCED, audits: AUDITS };
const EMPTY = {
  runs: 'No pipeline runs yet.',
  practices: 'No design profiles yet.',
  accounts: 'No accounts yet — promote a prospect to create one.',
  audits: 'No audits yet — rows appear when audit-site.js runs.',
  builds: 'No previews yet — rows appear when the pipeline creates preview builds.',
  sourced: 'No prospects match.',
};
const queries = { runs: '', practices: '', accounts: '', builds: '', sourced: '', audits: '' };

// ---------------------------------------------------------------------------
// Preferences (view + visible columns) — persisted in localStorage
// ---------------------------------------------------------------------------

const PREFS_KEY = 'gw-ops-prefs-v2'; // bump to re-apply new column defaults
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { prefs = {}; }

function tabPrefs(tab) {
  if (!prefs[tab] || typeof prefs[tab] !== 'object') prefs[tab] = {};
  const p = prefs[tab];
  if (p.view !== 'grid' && p.view !== 'list') p.view = (tab === 'practices' ? 'grid' : 'list');
  if (!p.cols || typeof p.cols !== 'object') p.cols = {};
  COLS[tab].forEach(function (c) {
    if (typeof p.cols[c.key] !== 'boolean') p.cols[c.key] = !!c.on;
  });
  return p;
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Rendering engine
// ---------------------------------------------------------------------------

function visibleCols(tab) {
  const p = tabPrefs(tab);
  return COLS[tab].filter(function (c) { return p.cols[c.key]; });
}

function rowMatches(row, q) {
  if (!q) return true;
  const vals = Object.values(row);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v != null && String(v).toLowerCase().indexOf(q) !== -1) return true;
  }
  return false;
}

function sortRows(tab, rows, p) {
  if (!p.sort || !p.sort.key) return rows;
  const col = COLS[tab].find(function (c) { return c.key === p.sort.key; });
  if (!col) return rows;
  const sk = col.sortKey || col.key;
  const dir = p.sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort(function (a, b) {
    const av = a[sk], bv = b[sk];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // nulls always last
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

// ---------------------------------------------------------------------------
// Queue — what is waiting on a human
//
// Same source as "npm run log -- open". Two answers to "what needs me?" is one
// answer too many, so both read client_events and neither caches.
// ---------------------------------------------------------------------------

function qTime(iso) {
  return String(iso || '').replace('T', ' ').slice(0, 16);
}

function qSection(title, note, rows, renderRow) {
  if (!rows || !rows.length) return '';
  var items = rows.map(renderRow).join('');
  return '<div class="q-section">'
    + '<h3 class="q-title">' + esc(title) + ' <span class="q-count">' + rows.length + '</span></h3>'
    + '<p class="q-note">' + esc(note) + '</p>'
    + '<div class="q-rows">' + items + '</div></div>';
}

function renderQueue() {
  var el = document.getElementById('tab-queue');
  if (QUEUE.error) {
    el.innerHTML = '<p class="q-note">Ledger unavailable: ' + esc(QUEUE.error) + '</p>';
    return;
  }

  var total = QUEUE.untriaged.length + QUEUE.unrouted.length + QUEUE.proposals.length;
  var head = total === 0
    ? '<div class="q-clear">Nothing waiting on you. Every change is triaged and every systemic one is routed.</div>'
    : '<div class="q-head">' + total + ' item' + (total === 1 ? '' : 's') + ' waiting on you</div>';

  var proposals = qSection(
    'Proposals', 'The router thinks these would recur on the next build. Approve by opening a PR, then route the event to it.',
    QUEUE.proposals,
    function (r) {
      var lines = String(r.detail || '').split(String.fromCharCode(10));
      var affects = '';
      var confidence = '';
      lines.forEach(function (l) {
        if (l.indexOf('affects:') === 0) affects = l.replace('affects:', '').trim();
        if (l.indexOf('confidence:') === 0) confidence = l.replace('confidence:', '').trim();
      });
      return '<div class="q-row">'
        + '<div class="q-main">' + esc(String(r.summary).replace('PROPOSAL: ', '')) + '</div>'
        + '<div class="q-meta">' + esc(r.slug) + ' · ' + qTime(r.occurred_at)
        + (affects ? ' · affects <b>' + esc(affects) + '</b>' : '')
        + (confidence ? ' · ' + esc(confidence) + ' confidence' : '')
        + '</div>'
        + '<code class="q-cmd">npm run log -- triage ' + esc(String(r.id).slice(0, 8)) + ' --systemic yes --routed &lt;pr-url&gt;</code>'
        + '</div>';
    });

  var untriaged = qSection(
    'Untriaged changes', 'Would this defect exist on the next site we build?',
    QUEUE.untriaged,
    function (r) {
      return '<div class="q-row">'
        + '<div class="q-main">' + esc(r.summary) + '</div>'
        + '<div class="q-meta">' + esc(r.slug) + ' · ' + qTime(r.occurred_at) + ' · ' + esc(r.actor) + '</div>'
        + '<code class="q-cmd">npm run log -- triage ' + esc(String(r.id).slice(0, 8)) + ' --systemic yes|no</code>'
        + '</div>';
    });

  var unrouted = qSection(
    'Systemic, but unrouted', 'Marked as general, with nowhere named for the general fix.',
    QUEUE.unrouted,
    function (r) {
      return '<div class="q-row">'
        + '<div class="q-main">' + esc(r.summary) + '</div>'
        + '<div class="q-meta">' + esc(r.slug) + ' · ' + qTime(r.occurred_at) + '</div>'
        + '</div>';
    });

  var recent = qSection(
    'Recent activity', 'Everything on every timeline, newest first.',
    QUEUE.recent,
    function (r) {
      var arrow = r.direction === 'in' ? ' &larr;' : r.direction === 'out' ? ' &rarr;' : '';
      return '<div class="q-row q-thin">'
        + '<div class="q-main">' + esc(r.summary) + '</div>'
        + '<div class="q-meta">' + esc(r.slug) + ' · ' + esc(r.kind) + arrow + ' · ' + qTime(r.occurred_at) + '</div>'
        + '</div>';
    });

  el.innerHTML = head + proposals + untriaged + unrouted + recent;
}

function render(tab) {
  const panel = document.getElementById('tab-' + tab);
  const p = tabPrefs(tab);
  const cols = visibleCols(tab);
  const all = DATA[tab];
  let rows = all.filter(function (r) { return rowMatches(r, queries[tab]); });
  rows = sortRows(tab, rows, p);
  panel.querySelector('.filter-count').textContent = rows.length + ' of ' + all.length;
  const gridEl = panel.querySelector('.card-grid');
  const tableWrap = panel.querySelector('.table-wrap');
  if (p.view === 'grid') {
    tableWrap.style.display = 'none';
    gridEl.style.display = 'grid';
    renderGrid(tab, gridEl, rows, cols);
  } else {
    gridEl.style.display = 'none';
    tableWrap.style.display = 'block';
    renderList(tab, tableWrap, rows, cols);
  }
}

function renderList(tab, wrap, rows, cols) {
  const p = tabPrefs(tab);
  const thead = wrap.querySelector('thead');
  const tbody = wrap.querySelector('tbody');
  thead.innerHTML = '<tr>' + cols.map(function (c) {
    const isSorted = p.sort && p.sort.key === c.key;
    const arrow = isSorted ? (p.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return '<th class="sortable' + (isSorted ? ' sorted' : '') + '" data-key="' + c.key + '">' + esc(c.label) + arrow + '</th>';
  }).join('') + '</tr>';
  thead.querySelectorAll('th').forEach(function (th) {
    th.addEventListener('click', function () {
      const key = th.dataset.key;
      if (p.sort && p.sort.key === key) {
        // asc → desc → off
        p.sort = p.sort.dir === 'asc' ? { key: key, dir: 'desc' } : null;
      } else {
        p.sort = { key: key, dir: 'asc' };
      }
      savePrefs();
      render(tab);
    });
  });
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="' + (cols.length || 1) + '">' + EMPTY[tab] + '</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (r) {
    return '<tr>' + cols.map(function (c) {
      return '<td' + (c.nowrap ? ' style="white-space:nowrap"' : '') + '>' + c.html(r) + '</td>';
    }).join('') + '</tr>';
  }).join('');
}

function renderGrid(tab, el, rows, cols) {
  if (!rows.length) {
    el.innerHTML = '<p style="color:var(--mid-gray);font-size:13px;font-style:italic">' + EMPTY[tab] + '</p>';
    return;
  }
  const primary = COLS[tab].find(function (c) { return c.primary; });
  el.innerHTML = rows.map(function (r) {
    let h = '<div class="practice-card">';
    h += '<div class="gcard-title">' + (primary ? primary.html(r) : '') + '</div>';
    h += '<div class="gcard-rows">';
    cols.forEach(function (c) {
      if (primary && c.key === primary.key) return;
      h += '<div class="gcard-row"><span class="gcard-label">' + esc(c.label) + '</span><span>' + c.html(r) + '</span></div>';
    });
    h += '</div></div>';
    return h;
  }).join('');
}

// ---------------------------------------------------------------------------
// Panel construction (toolbar: view toggle, column picker, search)
// ---------------------------------------------------------------------------

function buildPanel(tab) {
  const panel = document.getElementById('tab-' + tab);
  const p = tabPrefs(tab);
  let h = '';
  h += '<div class="toolbar">';
  h += '<div class="view-toggle">';
  h += '<button class="view-btn' + (p.view === 'grid' ? ' active' : '') + '" data-view="grid" type="button">Grid</button>';
  h += '<button class="view-btn' + (p.view === 'list' ? ' active' : '') + '" data-view="list" type="button">List</button>';
  h += '</div>';
  h += '<div class="col-picker"><button class="col-btn" type="button">Columns ▾</button><div class="col-menu">';
  h += '<div class="col-menu-actions"><button data-act="all" type="button">Select all</button><button data-act="none" type="button">Clear all</button></div>';
  COLS[tab].forEach(function (c) {
    h += '<label><input type="checkbox" data-col="' + c.key + '"' + (p.cols[c.key] ? ' checked' : '') + ' /> ' + esc(c.label) + '</label>';
  });
  h += '</div></div>';
  h += '<input type="search" placeholder="Filter…" />';
  h += '<span class="filter-count"></span>';
  h += '</div>';
  h += '<div class="card-grid" style="display:none"></div>';
  h += '<div class="table-wrap" style="display:none"><table><thead></thead><tbody></tbody></table></div>';
  panel.innerHTML = h;

  panel.querySelectorAll('.view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      p.view = btn.dataset.view;
      panel.querySelectorAll('.view-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
      savePrefs();
      render(tab);
    });
  });

  const picker = panel.querySelector('.col-picker');
  picker.querySelector('.col-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    document.querySelectorAll('.col-picker.open').forEach(function (x) { if (x !== picker) x.classList.remove('open'); });
    picker.classList.toggle('open');
  });
  picker.querySelector('.col-menu').addEventListener('click', function (e) { e.stopPropagation(); });
  picker.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      p.cols[cb.dataset.col] = cb.checked;
      savePrefs();
      render(tab);
    });
  });
  picker.querySelectorAll('.col-menu-actions button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const selectAll = btn.dataset.act === 'all';
      COLS[tab].forEach(function (c) {
        // Clear all keeps the primary column so the table never goes blank
        p.cols[c.key] = selectAll ? true : !!c.primary;
      });
      picker.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        cb.checked = p.cols[cb.dataset.col];
      });
      savePrefs();
      render(tab);
    });
  });

  panel.querySelector('input[type=search]').addEventListener('input', function (e) {
    queries[tab] = e.target.value.trim().toLowerCase();
    render(tab);
  });
}

document.addEventListener('click', function () {
  document.querySelectorAll('.col-picker.open').forEach(function (x) { x.classList.remove('open'); });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function (pn) { pn.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

renderQueue();

['sourced', 'accounts', 'audits', 'builds', 'runs', 'practices'].forEach(function (t) {
  buildPanel(t);
  render(t);
});
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
