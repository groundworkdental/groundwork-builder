/**
 * run-status.js — local + D1 status for scrape/build failures (eval harness).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Write clients/<slug>/_pipeline/status.json (and optional batch-visible copy).
 */
export async function writeRunStatus(outputDir, status) {
  if (!outputDir) return null;
  const pipe = join(outputDir, '_pipeline');
  await mkdir(pipe, { recursive: true });
  const payload = {
    ...status,
    updatedAt: new Date().toISOString(),
  };
  const path = join(pipe, 'status.json');
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}

/**
 * Touch clients/<slug>/_pipeline/heartbeat.json so eval-batch hang detection
 * does not kill long silent AI phases (content write, section gen, director).
 */
export async function touchHeartbeat(outputDir, phase = null) {
  if (!outputDir) return null;
  const pipe = join(outputDir, '_pipeline');
  await mkdir(pipe, { recursive: true });
  const path = join(pipe, 'heartbeat.json');
  const payload = {
    at: new Date().toISOString(),
    phase: phase || null,
    pid: process.pid,
  };
  await writeFile(path, JSON.stringify(payload));
  return path;
}

/**
 * Start a periodic heartbeat writer. Returns a stop() function.
 */
export function startHeartbeat(outputDir, intervalMs = 30_000) {
  let phase = 'starting';
  const tick = () => { touchHeartbeat(outputDir, phase).catch(() => {}); };
  tick();
  const id = setInterval(tick, intervalMs);
  return {
    setPhase(p) { phase = p; tick(); },
    stop() { clearInterval(id); },
  };
}

/**
 * Best-effort: flag sourced_practices as unable_to_scrape by website URL.
 */
export async function recordUnableToScrape(url, detail = {}) {
  try {
    const { setSourcedUnableToScrape } = await import('../../sourcing/lib/d1.js');
    return await setSourcedUnableToScrape(url, detail);
  } catch (err) {
    return { updated: 0, error: err.message };
  }
}
