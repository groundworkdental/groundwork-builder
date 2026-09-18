/**
 * build-manifest.js — record what each generator wrote, and remove what it
 * stopped writing.
 *
 * `cloneTemplate` copies the template over the output directory but never
 * deletes, so every run inherits the previous run's files. When a generator
 * renamed its output — Architect calling a page `/se-habla-espanol` one run and
 * `/es` the next — the old page stayed live: a real route, in the sitemap,
 * linked from nothing, and counted as coverage by an audit that only ever asked
 * "is this file on disk?".
 *
 * The manifest makes that question answerable. Each generator declares the
 * files it produced; at the end of a run, anything the previous manifest
 * recorded that this run did not is deleted.
 *
 * Safety: only paths a manifest recorded are ever removed. Template files,
 * hand-edits, and anything written outside a registered generator are never
 * touched, which is what separates this from wiping `src/` before each build —
 * this pipeline supports operator edits (see managed-file.js).
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';

const MANIFEST_PATH = '_pipeline/build-manifest.json';
const VERSION = 1;

/** Paths a manifest is allowed to prune. Anything else is refused. */
const PRUNABLE = [
  'src/pages/',
  'src/content/blog/',
  'src/components/generated/',
];

const norm = (p) => String(p || '').split(sep).join('/').replace(/^\.\//, '');

function isPrunable(relPath) {
  const p = norm(relPath);
  if (p.includes('..')) return false;
  return PRUNABLE.some(prefix => p.startsWith(prefix));
}

/**
 * Open a manifest for this run.
 *
 * @param {string} outputDir
 * @returns {Promise<object>} recorder
 */
export async function openManifest(outputDir) {
  const file = resolve(outputDir, MANIFEST_PATH);

  let previous = { version: VERSION, generators: {} };
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (raw && raw.version === VERSION && raw.generators) previous = raw;
  } catch {
    // No prior manifest — first run under manifest tracking. Nothing to prune,
    // which deliberately leaves pre-manifest files alone rather than guessing.
  }

  const current = {};

  return {
    /**
     * Declare the files a generator produced this run.
     * Paths may be absolute or relative to outputDir.
     */
    record(generator, files = []) {
      const rel = (Array.isArray(files) ? files : [files])
        .filter(Boolean)
        .map(f => norm(relative(outputDir, resolve(outputDir, f))));
      current[generator] = [...new Set([...(current[generator] || []), ...rel])];
    },

    /** Everything recorded this run, flattened. */
    files() {
      return new Set(Object.values(current).flat());
    },

    /**
     * Delete files the previous run recorded that this run did not.
     * Only generators that reported something this run are pruned — a generator
     * that failed or was skipped must not have its output swept away.
     */
    async prune() {
      const removed = [];
      const skipped = [];

      for (const [generator, files] of Object.entries(previous.generators)) {
        if (!current[generator]) {
          skipped.push(generator);   // didn't run this time — leave its output alone
          continue;
        }
        const keep = new Set(current[generator]);
        for (const f of files) {
          if (keep.has(f)) continue;
          if (!isPrunable(f)) continue;
          try {
            await rm(resolve(outputDir, f), { force: true });
            removed.push(f);
          } catch { /* already gone */ }
        }
      }
      return { removed, skippedGenerators: skipped };
    },

    async write() {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({
        version: VERSION,
        generators: current,
      }, null, 2), 'utf8');
    },

    previous,
  };
}
