/**
 * storage.js — Unified storage abstraction: GCS + local.
 *
 * Project:  groundwork-dental
 * Bucket:   builder-data
 *
 * GCS path structure:
 *   {client-slug}/runs/{run-id}/01-bronze.json
 *   {client-slug}/runs/{run-id}/03-content.json
 *   {client-slug}/images/{filename}
 *   _library/{fingerprint-slug}.json
 *
 * Configuration (set in .env):
 *   GOOGLE_CLOUD_STORAGE_BUCKET=builder-data
 *   GOOGLE_CLOUD_CREDENTIALS_JSON={"type":"service_account",...}   ← inline JSON key
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json               ← file path (alternative)
 *
 * Always writes locally. GCS upload is parallel + best-effort (non-blocking).
 * If GCS is not configured, local-only mode runs silently.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';


let _gcsClient  = null;
let _gcsEnabled = null; // null = not yet checked

// ---------------------------------------------------------------------------
// GCS client — lazy init, credential-method auto-detect
// ---------------------------------------------------------------------------

/**
 * Remote uploads go to R2. Everything writes locally first regardless, so a
 * missing or misconfigured bucket degrades to "local only" rather than losing
 * a run's artifacts — which is what happened for weeks when the GCS
 * credentials silently vanished from .env and nothing complained.
 */
let _warned = false;

function mimeFor(key) {
  return key.endsWith('.json') ? 'application/json'
    : key.endsWith('.html') ? 'text/html'
    : key.endsWith('.txt') ? 'text/plain'
    : /\.(jpg|jpeg)$/i.test(key) ? 'image/jpeg'
    : key.endsWith('.png') ? 'image/png'
    : key.endsWith('.webp') ? 'image/webp'
    : key.endsWith('.avif') ? 'image/avif'
    : 'application/octet-stream';
}

export async function storageWrite(gcsPath, content, localPath) {
  // Always write locally first
  await mkdir(dirname(localPath), { recursive: true });
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  await writeFile(localPath, buf);

  // R2 — fire and forget. A failed upload must never fail a build: the
  // artifact is already on disk and the run has more useful work to do.
  remoteUpload(gcsPath, buf).catch((err) =>
    console.warn(`  [storage] R2 upload failed (${gcsPath}): ${err.message}`),
  );
}

/**
 * Upload a file to GCS only (already exists locally — e.g. downloaded images).
 * Non-blocking.
 */
export function storageUpload(gcsPath, localPath) {
  return remoteUpload(gcsPath, localPath, true).catch((err) =>
    console.warn(`  [storage] R2 upload failed (${gcsPath}): ${err.message}`),
  );
}

async function remoteUpload(key, content, isFilePath = false) {
  const { r2Configured, r2Put } = await import('./r2.js');
  if (!r2Configured()) {
    if (!_warned) {
      console.warn('  [storage] R2 not configured — artifacts are local only');
      _warned = true;
    }
    return;
  }
  const body = isFilePath ? await readFile(content) : content;
  await r2Put(key, body, mimeFor(key));
}

export async function storageRead(localPath) {
  return readFile(localPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Run-scoped factory — bind a client slug + run ID for the entire pipeline run
// ---------------------------------------------------------------------------

/**
 * Create a storage instance bound to a specific client run.
 * All paths are automatically namespaced under {clientSlug}/runs/{runId}/.
 *
 * @param {string} clientSlug  - e.g. "spring-st-dentistry"
 * @param {string} [runId]     - e.g. "20260425-143022" (auto-generated if omitted)
 * @returns {RunStorage}
 */
export function createRunStorage(clientSlug, runId) {
  const id = runId || new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-').replace(/-$/, '');
  const prefix = `${clientSlug}/runs/${id}`;

  return {
    runId: id,
    clientSlug,

    /** Write a pipeline artifact JSON file */
    async writeArtifact(name, content, localPath) {
      const gcsPath = `${prefix}/${name}`;
      await storageWrite(gcsPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), localPath);
    },

    /** Upload an image file that already exists locally */
    uploadImage(filename, localPath) {
      return storageUpload(`${clientSlug}/images/${filename}`, localPath);
    },

    /** Upload the design trace HTML */
    uploadTrace(localPath) {
      return storageUpload(`${prefix}/design-trace.html`, localPath);
    },

    /**
     * Object-key prefix for this run. Still called gcsPrefix because callers
     * and the D1 `gcs_run_folder` column use that name; renaming it is a
     * separate change from moving the bucket.
     */
    gcsPrefix: prefix,

    /** Where to look at this run's artifacts. */
    gcsUrl: `https://dash.cloudflare.com/?to=/:account/r2/default/buckets/${process.env.R2_BUCKET || 'groundwork-builder-data'}`,
  };
}

// ---------------------------------------------------------------------------
// Library storage — design fingerprints (shared across environments)
// ---------------------------------------------------------------------------

/**
 * Write a design library fingerprint to remote storage.
 * Called by distill-design.js after saving locally.
 */
export async function libraryWrite(slug, content, localPath) {
  await storageWrite(`_library/${slug}.json`, content, localPath);
}

/**
 * Is remote storage configured, and does it answer?
 *
 * `reachable` does a real round trip rather than trusting that credentials
 * exist. Configured-but-broken is the state that cost weeks of silently
 * local-only runs.
 */
export async function storageStatus({ probe = false } = {}) {
  const { r2Configured, r2Check } = await import('./r2.js');
  const enabled = r2Configured();
  let reachable = null;
  if (enabled && probe) {
    reachable = await r2Check().catch(() => false);
  }
  return {
    enabled,
    reachable,
    backend: 'r2',
    bucket: process.env.R2_BUCKET || 'groundwork-builder-data',
  };
}
