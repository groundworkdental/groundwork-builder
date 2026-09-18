-- Groundwork Builder — Cloudflare D1 Schema
-- SQLite-compatible; apply via: wrangler d1 execute <DB> --file=scripts/pipeline/lib/d1-schema.sql

-- ---------------------------------------------------------------------------
-- accounts: one row per practice (CRM identity + lifecycle)
-- Columns mirror lib/d1.js upsertAccount() exactly — d1.js is the writer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,            -- uuid (crypto.randomUUID)
  slug               TEXT NOT NULL UNIQUE,        -- e.g. "springstdentistry"
  practice_name      TEXT,
  practice_url       TEXT,
  business_email     TEXT,
  contact_email      TEXT,
  contact_name       TEXT,
  phone              TEXT,
  city               TEXT,
  state              TEXT,
  source             TEXT,
  lifecycle_stage    TEXT DEFAULT 'Prospect',
  baseline_pagespeed INTEGER,
  baseline_ranks     TEXT,                        -- JSON
  launch_date        TEXT,
  reaudit_due        TEXT,
  intake_json        TEXT,                        -- JSON blob
  design_profile     TEXT,                        -- JSON: latest design-library fingerprint (palette/type/archetype/variants). Read-cache for the dashboard "Design Library" tab; query fields via json_extract. Source of truth is _memory/library/<slug>.json.
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_slug ON accounts (slug);

-- ---------------------------------------------------------------------------
-- audits: one row per audit run, FK → accounts
-- Columns mirror lib/d1.js createAudit()/updateAudit() exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audits (
  id               TEXT PRIMARY KEY,              -- uuid
  account_id       TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  slug             TEXT NOT NULL,                 -- denormalized for fast lookups
  status           TEXT,
  website_url      TEXT,
  source           TEXT,
  contact_email    TEXT,
  total_checks     INTEGER,
  passed           INTEGER,
  critical         INTEGER,
  warnings         INTEGER,
  mobile_score     INTEGER,
  desktop_score    INTEGER,
  gbp_reviews      INTEGER,
  gbp_rating       REAL,
  audit_report_url TEXT,
  gcs_run_folder   TEXT,
  error_detail     TEXT,
  completed_at     TEXT,
  date_added       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  airtable_id      TEXT                          -- source record id from Airtable backfill (migrate-airtable-crm.mjs)
);

CREATE INDEX IF NOT EXISTS idx_audits_slug       ON audits (slug);
CREATE INDEX IF NOT EXISTS idx_audits_account_id ON audits (account_id);

-- ---------------------------------------------------------------------------
-- builds: one row per generated site, FK → accounts + audits
-- Columns mirror lib/d1.js createBuild()/updateBuild() exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builds (
  id                TEXT PRIMARY KEY,             -- uuid
  account_id        TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  source_audit_id   TEXT REFERENCES audits (id)   ON DELETE SET NULL,
  build_slug        TEXT NOT NULL,                -- matches client_slug / slug
  status            TEXT,
  website_url       TEXT,
  request_notes     TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  contact_role      TEXT,
  preview_url       TEXT,
  pitch_url         TEXT,
  github_folder_url TEXT,
  gcs_run_folder    TEXT,
  mobile_score      INTEGER,
  desktop_score     INTEGER,
  fixed_count       INTEGER,
  still_issue_count INTEGER,
  regressed_count   INTEGER,
  rescanned_at      TEXT,
  cost_est          REAL,
  error_detail      TEXT,
  completed_at      TEXT,
  date_added        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  airtable_id       TEXT                         -- source record id from Airtable backfill (migrate-airtable-crm.mjs)
);

CREATE INDEX IF NOT EXISTS idx_builds_build_slug  ON builds (build_slug);
CREATE INDEX IF NOT EXISTS idx_builds_account_id  ON builds (account_id);

-- ---------------------------------------------------------------------------
-- runs: mirrors _memory/runs.jsonl (full build pipeline output)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id                 TEXT PRIMARY KEY,           -- e.g. "run-1781115244565"
  created_at         TEXT NOT NULL,
  client_slug        TEXT NOT NULL,
  gcs_prefix         TEXT,
  url                TEXT,
  practice_name      TEXT,
  doctor_name        TEXT,
  city               TEXT,
  phone              TEXT,
  archetype          TEXT,
  hero_variant       TEXT,
  font_heading       TEXT,
  font_body          TEXT,
  palette_primary    TEXT,
  palette_mood       TEXT,
  services_count     INTEGER,
  signals_count      INTEGER,
  signals            TEXT,                       -- JSON array
  sections_generated TEXT,                       -- JSON array
  build_success      INTEGER NOT NULL DEFAULT 0, -- 0 | 1
  duration_ms        INTEGER,
  errors             TEXT,                       -- JSON array
  -- extra fields present on some records
  supabase_id        TEXT,
  migrated_from      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_client_slug ON runs (client_slug);
CREATE INDEX IF NOT EXISTS idx_runs_created_at  ON runs (created_at);

-- ---------------------------------------------------------------------------
-- sourced_practices: prospect pipeline (Google Places sourcing + site audits)
-- One row per Place ID. Migrated from Airtable "Sourced Practices".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sourced_practices (
  place_id        TEXT PRIMARY KEY,
  practice_name   TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  msa_market      TEXT,
  website_url     TEXT,
  final_url       TEXT,
  gbp_url         TEXT,
  phone           TEXT,
  email           TEXT,
  primary_type    TEXT,
  rating          REAL,
  review_count    INTEGER,
  business_status TEXT,
  status          TEXT,
  tier            TEXT,
  business_tier   TEXT,
  quadrant        TEXT,
  weakness_score  REAL,
  weakness_tier   TEXT,
  quality_score   REAL,
  vendor          TEXT,
  vendor_category TEXT,
  lighthouse_performance    INTEGER,
  lighthouse_accessibility  INTEGER,
  lighthouse_seo            INTEGER,
  lighthouse_best_practices INTEGER,
  sourced_at      TEXT,
  last_audited_at TEXT,
  raw             TEXT                          -- full Airtable fields JSON
);

CREATE INDEX IF NOT EXISTS idx_sourced_state    ON sourced_practices (state);
CREATE INDEX IF NOT EXISTS idx_sourced_status   ON sourced_practices (status);
CREATE INDEX IF NOT EXISTS idx_sourced_weakness ON sourced_practices (weakness_score);

-- Design-library fingerprints are folded into accounts.design_profile (JSON),
-- not a separate table. The latest fingerprint per practice lives there; the
-- source of truth remains _memory/library/<slug>.json.

-- ---------------------------------------------------------------------------
-- client_events — one timeline per practice, whatever the source
-- ---------------------------------------------------------------------------
--
-- accounts/audits/builds/runs record what the PIPELINE did. Nothing recorded
-- what a person did: an email, a manual fix, a decision on a call. That
-- knowledge lived in working trees, commit messages and chat sessions, and
-- died with them — which is how a twelve-rule document had ten rules adopted
-- and two silently dropped for a week.
--
-- Append-only. Rows are never updated except to close a triage (see below).
--
-- The triage columns are the point. A `change` event with systemic = NULL is
-- UNTRIAGED: nobody has answered "would this defect exist on the next site we
-- build?". A change with systemic = 'yes' and routed_to = NULL is triaged but
-- UNROUTED: the generalisable fix has no home yet. Both states are queryable,
-- so the follow-through that always gets skipped becomes a list instead of a
-- memory.
CREATE TABLE IF NOT EXISTS client_events (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,          -- accounts.slug
  occurred_at TEXT NOT NULL,          -- ISO 8601, when it HAPPENED
  kind        TEXT NOT NULL,          -- communication|change|decision|run|gate|launch|note
  direction   TEXT,                   -- in|out, for communication
  actor       TEXT NOT NULL,          -- operator email, 'pipeline', or an agent name
  summary     TEXT NOT NULL,          -- one line, human-readable
  detail      TEXT,                   -- body, diff, JSON — anything longer
  source_ref  TEXT,                   -- commit sha, PR url, message id, build id
  systemic    TEXT,                   -- yes|no|NULL(untriaged) — changes only
  routed_to   TEXT,                   -- PR url, gate name, rule id
  created_at  TEXT NOT NULL           -- when the row was written
);

CREATE INDEX IF NOT EXISTS idx_events_slug     ON client_events (slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_kind     ON client_events (kind);
CREATE INDEX IF NOT EXISTS idx_events_systemic ON client_events (systemic);
