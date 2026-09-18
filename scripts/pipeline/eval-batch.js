#!/usr/bin/env node
/**
 * eval-batch.js — parallel multi-URL builder with preflight + hang tracking.
 *
 * Usage:
 *   node scripts/pipeline/eval-batch.js \
 *     --concurrency 3 --limit 30 \
 *     --job arts-family-dentistry|https://www.artsfamilydentistry.com/|klinik \
 *     --job arizona-orthodontic-centers|https://www.azorthodonticcenter.com/|wellbe \
 *     --job cute-smiles-4-kids|https://cutesmiles4kids.com/|dentora
 *
 * Or: npm run eval:batch -- --concurrency 3 --limit 30 --jobs-file clients/_test-runs/jobs.json
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
dotenvConfig({ path: resolve(ROOT, '.env'), override: true });

// Long AI phases (content write, section gen, director) often go 20–40 min with
// no stdout — prefer pipeline heartbeat.json over log growth alone.
const HANG_MS = Number(process.env.EVAL_HANG_MS || 45 * 60 * 1000);
const HEARTBEAT_MS = 15_000;

function parseArgs(argv) {
  const opts = {
    concurrency: 2,
    limit: 30,
    agent: true,
    skipPagespeed: false,
    jobs: [],
    outDir: resolve(ROOT, 'clients/_test-runs'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency') opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10) || 30;
    else if (a === '--no-agent') opts.agent = false;
    else if (a === '--skip-pagespeed') opts.skipPagespeed = true;
    else if (a === '--job') opts.jobs.push(parseJob(argv[++i]));
    else if (a === '--jobs-file') opts.jobsFile = argv[++i];
    else if (a === '--out') opts.outDir = resolve(argv[++i]);
    else if (a === '--help') {
      console.log(`eval-batch — parallel builds with preflight

  --concurrency N     parallel workers (default 2)
  --limit N           crawl page cap (default 30)
  --job slug|url|ref  repeatable job spec
  --jobs-file path    JSON array of {slug,url,reference}
  --no-agent          disable designer agent
  --skip-pagespeed
  --out dir           status/logs directory
`);
      process.exit(0);
    }
  }
  return opts;
}

function parseJob(spec) {
  const [slug, url, reference] = String(spec).split('|');
  if (!slug || !url) throw new Error(`Bad --job "${spec}" (want slug|url|ref)`);
  return { slug, url, reference: reference || null };
}

async function preflight() {
  const issues = [];
  if (!process.env.ANTHROPIC_API_KEY) issues.push('ANTHROPIC_API_KEY missing');
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (err) {
    issues.push(`Playwright browser missing: ${err.message.split('\n')[0]}`);
    issues.push('Fix: npx playwright install chromium');
  }
  return issues;
}

async function writeStatus(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function runOne(job, opts, batchStatusPath) {
  const startedAt = new Date().toISOString();
  const logPath = join(opts.outDir, `${job.slug}.log`);
  const clientOut = resolve(ROOT, 'clients', job.slug);
  const args = [
    resolve(ROOT, 'scripts/pipeline/build-site.js'),
    '--url', job.url,
    '--output', clientOut,
    '--limit', String(opts.limit),
    '--verbose',
  ];
  if (job.reference) args.push('--reference', job.reference);
  if (opts.agent) args.push('--agent');
  else args.push('--no-agent');
  if (opts.skipPagespeed) args.push('--skip-pagespeed');

  await writeFile(logPath, `=== ${job.slug} started ${startedAt} ===\n`);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, GROUNDWORK_AGENT: opts.agent ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lastActivity = Date.now();
  let bytes = 0;
  const markActivity = () => { lastActivity = Date.now(); };
  const append = async (buf) => {
    const s = buf.toString();
    bytes += s.length;
    markActivity();
    await writeFile(logPath, s, { flag: 'a' });
  };
  child.stdout.on('data', (b) => { append(b).catch(() => {}); process.stdout.write(`[${job.slug}] ${b}`); });
  child.stderr.on('data', (b) => { append(b).catch(() => {}); process.stderr.write(`[${job.slug}] ${b}`); });

  const hangTimer = setInterval(async () => {
    // Prefer pipeline heartbeat (survives silent Claude calls) over stdout alone.
    try {
      const hb = await stat(join(clientOut, '_pipeline', 'heartbeat.json'));
      if (hb.mtimeMs > lastActivity) lastActivity = hb.mtimeMs;
    } catch { /* no heartbeat yet */ }
    const idle = Date.now() - lastActivity;
    if (idle > HANG_MS) {
      console.error(`[${job.slug}] HUNG — no log/heartbeat for ${Math.round(idle / 1000)}s — killing pid ${child.pid}`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    } else {
      try {
        const raw = JSON.parse(await readFile(batchStatusPath, 'utf8'));
        const row = raw.jobs?.find((j) => j.slug === job.slug);
        if (row) {
          row.heartbeatAt = new Date().toISOString();
          row.logBytes = bytes;
          row.idleSec = Math.round(idle / 1000);
          row.pid = child.pid;
          await writeStatus(batchStatusPath, raw);
        }
      } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);

  const exitCode = await new Promise((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  });
  clearInterval(hangTimer);

  let scrapeStatus = null;
  try {
    scrapeStatus = JSON.parse(await readFile(join(clientOut, '_pipeline', 'status.json'), 'utf8'));
  } catch { /* none */ }

  let buildSuccess = false;
  try {
    const b = JSON.parse(await readFile(join(clientOut, '_pipeline', '09-build.json'), 'utf8'));
    buildSuccess = !!(b.output || b).buildSuccess;
  } catch { /* none */ }

  const scrapeFailed = exitCode === 2 || scrapeStatus?.code === 'unable_to_scrape';
  return {
    slug: job.slug,
    url: job.url,
    reference: job.reference,
    exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    log: logPath,
    scrapeStatus,
    buildSuccess,
    ok: !scrapeFailed && exitCode === 0 && buildSuccess,
  };
}

async function pool(items, concurrency, worker) {
  const results = [];
  let i = 0;
  async function next() {
    const idx = i++;
    if (idx >= items.length) return;
    results[idx] = await worker(items[idx], idx);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.jobsFile) {
    const raw = JSON.parse(await readFile(resolve(opts.jobsFile), 'utf8'));
    opts.jobs.push(...raw.map((j) => ({
      slug: j.slug,
      url: j.url,
      reference: j.reference || null,
    })));
  }
  if (!opts.jobs.length) {
    console.error('No jobs. Pass --job slug|url|ref or --jobs-file');
    process.exit(1);
  }

  await mkdir(opts.outDir, { recursive: true });
  const batchId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const batchStatusPath = join(opts.outDir, `batch-${batchId}.status.json`);

  console.log('=== eval:batch preflight ===');
  const issues = await preflight();
  if (issues.length) {
    for (const i of issues) console.error('  ✗', i);
    await writeStatus(batchStatusPath, { batchId, ok: false, preflight: issues, jobs: [] });
    process.exit(1);
  }
  console.log('  ✓ Anthropic key');
  console.log('  ✓ Playwright chromium');
  console.log(`  concurrency=${opts.concurrency} limit=${opts.limit} jobs=${opts.jobs.length}`);

  const status = {
    batchId,
    startedAt: new Date().toISOString(),
    concurrency: opts.concurrency,
    limit: opts.limit,
    jobs: opts.jobs.map((j) => ({ ...j, state: 'queued' })),
  };
  await writeStatus(batchStatusPath, status);
  console.log(`  status → ${batchStatusPath}`);

  const results = await pool(opts.jobs, opts.concurrency, async (job) => {
    const row = status.jobs.find((j) => j.slug === job.slug);
    if (row) { row.state = 'running'; row.startedAt = new Date().toISOString(); }
    await writeStatus(batchStatusPath, status);
    console.log(`\n>>> START ${job.slug}`);
    const result = await runOne(job, opts, batchStatusPath);
    Object.assign(row || {}, result, { state: result.ok ? 'ok' : 'failed' });
    await writeStatus(batchStatusPath, status);
    console.log(`>>> DONE ${job.slug} exit=${result.exitCode} buildSuccess=${result.buildSuccess}`);
    return result;
  });

  status.finishedAt = new Date().toISOString();
  status.results = results;
  status.ok = results.every((r) => r.ok);
  await writeStatus(batchStatusPath, status);

  console.log('\n=== eval:batch summary ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.slug}  exit=${r.exitCode} build=${r.buildSuccess} scrape=${r.scrapeStatus?.code || 'ok'}`);
  }
  console.log(`status: ${batchStatusPath}`);
  process.exit(status.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
