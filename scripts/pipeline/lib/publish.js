/**
 * Publish — deploys a built client site and generates the pitch page.
 *
 * Steps (in order):
 *   1. Ensure Cloudflare Pages project exists + custom domain attached
 *   2. Git commit + push monorepo (groundwork-builder) — triggers CF Pages deploy
 *   3. Wait for the preview URL to come live (poll until HTTP 200, ~60-180s)
 *   4. Run PageSpeed on the now-live preview — real after-scores
 *   5. Run rescan against the preview — diff vs original audit
 *   6. Generate pitch.html (with real after-scores)
 *   7. Stage pitch.html + updated audit folder into reports-site/ and
 *      direct-upload deploy the groundwork-reports Pages project
 *      (reports.groundworkdental.com) — the marketing repo is not touched
 *   5b. Evaluate ship gates (mobile perf ≥ 90, Lighthouse a11y ≥ 90, 0 axe critical/serious)
 *   9. Write Airtable Build row — Pitched if gates pass, Blocked if not
 *
 * Earlier version had PageSpeed and rescan running BEFORE the deploy push —
 * which meant they hit an empty preview URL every time, recorded null scores
 * and bogus diff counts. Reordered so deploy goes first, then we measure.
 *
 * Usage:
 *   import { publish } from './publish.js';
 *   await publish({ outputDir, slug, practiceUrl, previewUrl });
 *
 * Required env vars:
 *   CLOUDFLARE_API_TOKEN     — CF API token with Pages:Edit permission
 *   CLOUDFLARE_ACCOUNT_ID    — CF account ID
 *   REPORTS_DOMAIN           — reports host (default: reports.groundworkdental.com)
 *   REPORTS_PAGES_PROJECT    — reports Pages project (default: groundwork-reports)
 *   AIRTABLE_API_KEY            — Airtable personal access token
 *   AIRTABLE_BASE_ID            — Airtable base ID
 *   AIRTABLE_ACCOUNTS_TABLE     — Accounts table name
 *   AIRTABLE_AUDITS_TABLE       — Audits table name
 *   AIRTABLE_BUILDS_TABLE       — Builds table name
 *   GROUNDWORK_SUBDOMAIN        — base subdomain (default: groundworkdental.com)
 *   GITHUB_REPO_OWNER        — GitHub repo owner (default: gwgunther)
 *   GITHUB_REPO_NAME         — GitHub repo name (default: groundwork-builder)
 */

import { execSync }                        from 'node:child_process';
import { readFile }                        from 'node:fs/promises';
import { existsSync }                      from 'node:fs';
import { resolve, dirname, basename }      from 'node:path';
import { generatePitchPage }              from './pitch-generator.js';
import { upsertAccount, createBuild, updateBuild, findLatestAuditBySlug, findQueuedBuildBySlug } from './d1.js';
import {
  evaluateShipGates,
  loadA11yArtifact,
  recordShipGateResult,
  MOBILE_PERF_MIN,
  LIGHTHOUSE_A11Y_MIN,
} from './ship-gates.js';

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function publish(opts = {}) {
  const {
    outputDir,                                    // absolute path to clients/<slug>/
    slug,                                         // chang-orthodontics
    practiceUrl  = null,                          // changorthodontics.com
    previewUrl   = null,                          // changorthodontics.groundworkdental.com (auto-derived if null)
    ctaUrl       = null,                          // override CTA link on pitch page
    gcsPrefix    = null,                          // e.g. 'chang-orthodontics/runs/2026-...'
  } = opts;

  if (!outputDir) throw new Error('publish: outputDir is required');
  if (!slug)      throw new Error('publish: slug is required');

  const pipelineDir = resolve(outputDir, '_pipeline');

  const baseDomain  = process.env.GROUNDWORK_SUBDOMAIN || 'groundworkdental.com';
  const resolvedPreviewUrl = previewUrl || `${slug}.${baseDomain}`;
  const { reportsDomain, stagePitchPage, hostAuditReport } = await import('./host-reports.js');
  const pitchUrl    = `${reportsDomain()}/pitch/${slug}`;

  console.log('');
  console.log('[Publish] Starting publish pipeline...');
  console.log(`  slug:       ${slug}`);
  console.log(`  preview:    ${resolvedPreviewUrl}`);
  console.log(`  pitch:      ${pitchUrl}`);

  const results = {
    pitchHtml:      null,
    pitchLive:      null,
    cfProject:      null,
    cfDomain:       null,
    airtable:       null,
    gitBuilder:     null,
    gitDental:      null,
    shipGates:      null,
    handoffBlocked: false,
  };

  // Repo root for `git -C` invocations. publish.js lives at
  // scripts/pipeline/lib/publish.js — three levels up is the repo root,
  // four was the previous (broken) value pointing at the parent dir.
  const repoRoot   = resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..');

  // ── 1. Ensure CF Pages project + domain exist BEFORE the push ──
  // CF Pages will auto-deploy whatever main branch contains on next push,
  // so the project needs to exist first. ensureCfPagesProject is idempotent
  // (no-op if it already exists).
  try {
    const cfResult = await ensureCfPagesProject({ slug, baseDomain });
    results.cfProject = cfResult.project;
    results.cfDomain  = cfResult.domain;
    console.log(`  ✓ CF Pages: ${cfResult.created ? 'created' : 'already exists'} — ${resolvedPreviewUrl}`);
  } catch (err) {
    console.warn(`  ⚠ Cloudflare setup failed: ${err.message}`);
  }

  // ── 2. Push monorepo — triggers CF Pages deploy ──
  // Capture pushTime BEFORE the push so waitForCfDeploy can identify
  // OUR deployment (any deployment.created_on > pushTime).
  const pushTime = Date.now();
  const previewHttps = `https://${resolvedPreviewUrl}`;
  let pushedNewDeploy = false;
  try {
    pushedNewDeploy = gitCommitPush(repoRoot, `feat: add ${slug} client site`, [
      `clients/${slug}`,
    ]);
    if (pushedNewDeploy) {
      results.gitBuilder = 'pushed';
      console.log(`  ✓ Monorepo pushed → CF Pages auto-deploying ${slug}`);
    }
  } catch (err) {
    console.warn(`  ⚠ Monorepo push failed: ${err.message}`);
    try {
      const dist = resolve(outputDir, 'dist');
      if (existsSync(resolve(dist, 'index.html'))) {
        console.log('  Falling back to wrangler pages deploy of dist/ (clients/ is gitignored)...');
        execSync(
          `npx wrangler pages deploy "${dist}" --project-name "${slug}" --commit-dirty=true`,
          { cwd: outputDir, stdio: 'inherit', env: process.env },
        );
        pushedNewDeploy = true;
        results.gitBuilder = 'wrangler-direct';
        console.log(`  ✓ Wrangler deployed dist/ → ${slug}`);
      }
    } catch (deployErr) {
      console.warn(`  ⚠ Wrangler fallback failed: ${deployErr.message}`);
    }
  }

  // ── 3. Wait for the deploy via CF Pages API ──
  // Polls the deployments endpoint directly rather than probing the URL —
  // avoids the DNS/SSL/522-cache lag that caused earlier runs to time out
  // even after the deploy was actually live. Detects failures immediately.
  // When git had nothing new to commit, skip the 15-min deploy poll and
  // verify the existing preview URL instead (re-publish / gate re-check).
  let previewLive = false;
  try {
    if (!pushedNewDeploy) {
      console.log(`  No new monorepo deploy — checking if preview is already live...`);
      previewLive = await verifyUrl(previewHttps);
    } else {
      previewLive = await waitForCfDeploy({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken:  process.env.CLOUDFLARE_API_TOKEN,
        slug,
        url:       previewHttps,
        pushTime,
      });
    }
    if (!previewLive) {
      console.log(`  Deploy wait missed — final HTTP check on ${previewHttps}...`);
      previewLive = await verifyUrl(previewHttps);
    }
    if (previewLive) {
      console.log(`  ✓ Preview live — proceeding with PageSpeed + rescan`);
    } else {
      console.warn(`  ⚠ Preview did not come live within timeout — after-scores will be null`);
    }
  } catch (err) {
    console.warn(`  ⚠ Deploy wait error: ${err.message}`);
  }

  // ── 4. PageSpeed on the now-live preview ──
  let afterScores = null;
  if (previewLive) {
    try {
      console.log(`  Running PageSpeed on rebuilt site (${resolvedPreviewUrl})...`);
      const { runPageSpeed, extractScoreReasons } = await import('./pagespeed.js');
      const ps = await runPageSpeed(`https://${resolvedPreviewUrl}`);
      afterScores = {
        mobile:  ps.mobile?.performance    ?? null,
        desktop: ps.desktop?.performance   ?? null,
        seo:     ps.mobile?.seo            ?? null,
        accessibility: ps.mobile?.accessibility ?? null,
        // Top reasons score isn't 100 (honest tradeoffs)
        reasons: extractScoreReasons(ps.mobile, 3),
      };
      console.log(`  ✓ After scores — Mobile: ${afterScores.mobile} Desktop: ${afterScores.desktop} A11y: ${afterScores.accessibility ?? '—'}`);
      // Write to pipeline so pitch can read it later
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        resolve(pipelineDir, '03-pagespeed-after.json'),
        JSON.stringify({ step: '03-pagespeed-after', timestamp: new Date().toISOString(), output: afterScores }, null, 2)
      );
    } catch (err) {
      console.warn(`  ⚠ After PageSpeed skipped: ${err.message}`);
    }
  }

  // ── 4b. Agentic-browsing on the now-live preview (llms.txt gate) ──
  let agenticAfter = null;
  if (previewLive) {
    try {
      console.log(`  Running agentic-browsing audit on rebuilt site (${resolvedPreviewUrl})...`);
      const { auditAgenticUrl } = await import('./agentic-scanner.js');
      agenticAfter = await auditAgenticUrl(`https://${resolvedPreviewUrl}`);
      const llmsLabel = agenticAfter.llmsTxtStatus === 'good' ? 'good'
        : agenticAfter.llmsTxtStatus === 'poor' ? 'present but subpar'
          : agenticAfter.llmsTxtStatus === 'absent' ? 'missing' : 'not checked';
      console.log(`  ✓ Agentic — llms.txt: ${llmsLabel}`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        resolve(pipelineDir, '03-agentic-after.json'),
        JSON.stringify({ step: '03-agentic-after', timestamp: new Date().toISOString(), output: agenticAfter }, null, 2)
      );
    } catch (err) {
      console.warn(`  ⚠ After agentic-browsing audit skipped: ${err.message}`);
    }
  }

  // ── 5. Rescan against the now-live preview ──
  // Re-runs every scanner against the deployed site, diffs vs original
  // findings.json, writes audit-report-after.html. Counts go to Airtable.
  let rescanResult = null;
  if (previewLive) {
    try {
      console.log(`  Running rescan vs. original audit...`);
      const { runRescan } = await import('./rescan-core.js');
      const auditDir = resolve(repoRoot, '_audits', slug);
      rescanResult = await runRescan({
        auditDir,
        previewUrl:  `https://${resolvedPreviewUrl}`,
      });
      if (rescanResult) {
        const c = rescanResult.summary.counts;
        console.log(`  ✓ Rescan: ${c.fixed} fixed · ${c['still-issue']} still issue · ${c.regressed} regressed`);
      } else {
        console.log(`  ⚠ Rescan skipped — original audit findings not found at expected path`);
      }
    } catch (err) {
      console.warn(`  ⚠ Rescan failed (non-fatal): ${err.message}`);
    }
  }

  // ── 5b. Ship gates (PageSpeed + axe + Lighthouse a11y) ──
  let a11yReport = await loadA11yArtifact(pipelineDir);
  // Builds that finished in a sandbox often skip axe (Playwright binary missing).
  // Re-run against dist/ at publish time when the preview is live.
  if ((!a11yReport || a11yReport.pageCount === 0) && existsSync(resolve(outputDir, 'dist', 'index.html'))) {
    try {
      console.log('  Running axe-core audit on built dist/ (artifact missing from build)...');
      const { auditA11y } = await import('./a11y-audit.js');
      a11yReport = await auditA11y(outputDir);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        resolve(pipelineDir, '11b-a11y-audit.json'),
        JSON.stringify({ step: '11b-a11y-audit', timestamp: new Date().toISOString(), output: a11yReport }, null, 2),
        'utf-8',
      );
      const c = a11yReport.byImpact || {};
      console.log(`  ✓ axe-core — ${a11yReport.pageCount} page(s), critical=${c.critical || 0} serious=${c.serious || 0}`);
    } catch (err) {
      console.warn(`  ⚠ axe-core re-run failed: ${err.message}`);
    }
  }
  const gateResult = evaluateShipGates({
    mobilePerformance:      afterScores?.mobile ?? null,
    lighthouseAccessibility: afterScores?.accessibility ?? null,
    a11yReport,
    llmsTxtPresent:         agenticAfter?.llmsTxtPresent ?? null,
    llmsTxtStatus:          agenticAfter?.llmsTxtStatus ?? null,
  });
  results.shipGates = gateResult;
  results.handoffBlocked = !gateResult.passed;

  try {
    await recordShipGateResult(outputDir, gateResult, {
      scores: {
        mobilePerformance: afterScores?.mobile ?? null,
        lighthouseAccessibility: afterScores?.accessibility ?? null,
        llmsTxtPresent: agenticAfter?.llmsTxtPresent ?? null,
        llmsTxtStatus:  agenticAfter?.llmsTxtStatus ?? null,
        axeCritical: a11yReport?.byImpact?.critical ?? 0,
        axeSerious:  a11yReport?.byImpact?.serious  ?? 0,
      },
    });
  } catch (err) {
    console.warn(`  ⚠ Ship gate artifact write failed: ${err.message}`);
  }

  if (gateResult.passed) {
    console.log(`  ✓ Ship gates passed (mobile perf ≥ ${MOBILE_PERF_MIN}, Lighthouse a11y ≥ ${LIGHTHOUSE_A11Y_MIN}, llms.txt present, 0 axe critical/serious)`);
  } else {
    console.warn(`  ✗ Ship gates FAILED — handoff blocked (${gateResult.failures.length} issue(s)):`);
    for (const f of gateResult.failures) {
      console.warn(`      · ${f.field}: ${f.hint}`);
    }
    console.warn(`    Missing report updated: _pipeline/missing.html`);
  }

  // ── 6. Generate pitch.html (with the real after-scores) ──
  try {
    results.pitchHtml = await generatePitchPage(pipelineDir, {
      previewUrl: resolvedPreviewUrl,
      slug,
      pitchUrl,
      ctaUrl,
      afterScores,
      a11yReport,
      shipGatesPassed: gateResult.passed,
    });
    console.log(`  ✓ Pitch page generated: ${results.pitchHtml}`);
  } catch (err) {
    console.warn(`  ⚠ Pitch generation failed: ${err.message}`);
  }

  // ── 7a. Stage pitch.html into reports-site (only when gates pass) ──
  try {
    if (results.handoffBlocked) {
      console.warn(`  ⚠ Pitch not published — ship gates must pass before handoff`);
    } else if (results.pitchHtml) {
      results.pitchLive = await stagePitchPage({ pitchHtml: results.pitchHtml, slug });
      console.log(`  ✓ Pitch staged: reports-site/public/pitch/${slug}/index.html`);
    }
  } catch (err) {
    console.warn(`  ⚠ Pitch staging failed: ${err.message}`);
  }

  // ── 7b. Host audit folder + pitch — one direct-upload deploy ──
  // hostAuditReport() stages the audit files (incl. audit-report-after.html)
  // next to the pitch staged above, then deploys the whole reports site.
  let hostedReports = { indexUrl: null, beforeAfterUrl: null, skippedReason: null };
  try {
    const auditDir = resolve(repoRoot, '_audits', slug);
    hostedReports = await hostAuditReport({ auditDir, slug });
    if (hostedReports.pushed) {
      results.gitDental = 'reports-deployed';
      if (hostedReports.beforeAfterUrl) {
        console.log(`  ✓ Before/after report: ${hostedReports.beforeAfterUrl}`);
      }
      if (results.pitchLive) {
        console.log(`  ✓ Reports site deployed → pitch live at https://${pitchUrl}`);
      }
    } else if (hostedReports.skippedReason) {
      console.warn(`  ⚠ Reports deploy skipped: ${hostedReports.skippedReason}`);
    }
  } catch (err) {
    console.warn(`  ⚠ Reports hosting failed (non-fatal): ${err.message}`);
  }

  // ── 8b. Handoff baseline snapshot (when gates pass) ──
  if (!results.handoffBlocked) {
    try {
      const { captureHandoffBaseline } = await import('./baseline-capture.js');
      const baseline = await captureHandoffBaseline({
        slug,
        practiceUrl,
        pipelineDir,
        repoRoot,
        afterScores,
      });
      console.log(`  ✓ Baseline captured — re-audit due ${baseline.reaudit_due}`);
    } catch (err) {
      console.warn(`  ⚠ Baseline capture failed (non-fatal): ${err.message}`);
    }
  }

  // ── 9. Airtable — Build row with real diff counts + after-scores ──
  try {
    const tracked = await recordBuildRun({
      slug,
      practiceUrl,
      resolvedPreviewUrl,
      pitchUrl,
      pipelineDir,
      gcsPrefix,
      afterScores,
      rescanCounts: rescanResult?.summary?.counts || null,
      gateResult,
    });
    results.airtable = tracked.buildId;
    if (tracked.buildId) {
      const linked = tracked.sourceAuditId ? ` · Source Audit ${tracked.sourceAuditId}` : ' · no prior Audit found';
      const status = tracked.blocked ? 'Failed' : 'Pitched';
      const lifecycle = tracked.blocked ? 'unchanged' : 'Pitched';
      console.log(`  ✓ Airtable: Build ${tracked.buildId} created (Account ${tracked.accountId}, Status: ${status}, Lifecycle: ${lifecycle}${linked})`);
    } else {
      console.log(`  ⚠ Airtable disabled (env vars missing) — skipped tracking`);
    }
  } catch (err) {
    console.warn(`  ⚠ Airtable write failed: ${err.message}`);
  }

  console.log('');
  console.log('[Publish] Done.');
  console.log(`  Preview:  https://${resolvedPreviewUrl}`);
  if (results.handoffBlocked) {
    console.log(`  Handoff:  BLOCKED — fix ship gates in _pipeline/missing.html`);
    console.log(`  Pitch:    operator-only (_pipeline/pitch.html — not published)`);
  } else {
    console.log(`  Pitch:    https://${pitchUrl}`);
  }
  console.log('');

  return results;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a Cloudflare Pages deploy to finish, by polling the CF API
 * directly instead of probing the URL until it responds 200.
 *
 * Why this matters: URL-polling has three failure modes that caused
 * earlier runs to time out even after the deploy actually succeeded —
 *   (1) DNS propagation lag after the CNAME is created (~30-60s)
 *   (2) Cloudflare briefly caches 522s while the deploy is in progress
 *   (3) SSL cert issuance happens AFTER the build finishes (+30-90s)
 *
 * CF Pages' own API tells us exactly when the deploy reached the
 * "deploy / success" stage. After that, we do a short HTTP retry to
 * cover the SSL/DNS tail, and we're done.
 *
 * Other benefits over URL polling:
 *   - Detects build failure immediately (vs. timing out on a stuck preview)
 *   - Skips ambiguity when an older deployment is still serving — we
 *     identify OUR deploy by created_on > pushTime
 *
 * @param {object} args
 * @param {string} args.accountId  Cloudflare account id
 * @param {string} args.apiToken   Bearer token with Pages:Read at minimum
 * @param {string} args.slug       Pages project name
 * @param {string} args.url        Public URL — used for final HTTP verify
 * @param {number} args.pushTime   Date.now() captured BEFORE the git push
 * @param {number} [args.totalTimeoutMs]  Cap, default 15 min
 * @returns {Promise<boolean>}  true on deploy/success + URL HTTP 200
 */
async function waitForCfDeploy({ accountId, apiToken, slug, url, pushTime, totalTimeoutMs = 15 * 60_000 }) {
  const start = Date.now();
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${slug}/deployments?per_page=3`;
  const headers = { Authorization: `Bearer ${apiToken}` };

  console.log(`  Polling CF Pages API for ${slug} deploy status...`);
  // Tolerance: deployments can be created slightly before our local clock
  // registers the push response (clock skew). 30s back-window is generous.
  const acceptCreatedAfter = pushTime - 30_000;
  let lastStageReported = null;
  let ourDeployId = null;

  while (Date.now() - start < totalTimeoutMs) {
    try {
      const res = await fetch(base, { headers });
      const data = await res.json();
      // Find the deployment created AFTER our push (i.e. ours).
      const ours = (data.result || []).find(d => new Date(d.created_on).getTime() > acceptCreatedAfter);

      if (ours) {
        if (!ourDeployId) {
          ourDeployId = ours.id;
          console.log(`    Tracking deployment ${ours.id.slice(0, 8)} (created ${ours.created_on})`);
        }
        const stage = ours.latest_stage || {};
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const stageKey = `${stage.name}/${stage.status}`;

        if (stageKey !== lastStageReported) {
          console.log(`    [${elapsed}s] ${stageKey}`);
          lastStageReported = stageKey;
        }

        if (stage.status === 'failure') {
          console.warn(`    ✗ Build failed at stage "${stage.name}" after ${elapsed}s`);
          return false;
        }
        if (stage.name === 'deploy' && stage.status === 'success') {
          console.log(`    ✓ CF says deploy/success after ${elapsed}s — verifying URL...`);
          // Short HTTP retry for the SSL/DNS tail (~5s typical, ~60s worst case)
          return await verifyUrl(url);
        }
      }
      // else: our push hasn't been picked up yet (webhook delay), keep waiting
    } catch (err) {
      // Network blip — keep retrying
    }
    await new Promise(r => setTimeout(r, 5_000));
  }

  const totalSec = ((Date.now() - start) / 1000).toFixed(0);
  console.warn(`    ⚠ Deploy did not reach success within ${totalSec}s`);
  return false;
}

/**
 * Brief HTTP retry loop to confirm a CF-reported-success deploy is actually
 * serving content. Covers the 5-60s SSL/DNS tail after CF Pages says it's done.
 */
async function verifyUrl(url, { maxAttempts = 12, intervalMs = 5_000 } = {}) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (res.ok) {
        console.log(`    ✓ ${url} → HTTP ${res.status}`);
        return true;
      }
    } catch {
      // DNS/SSL not ready yet — keep retrying
    }
    if (i < maxAttempts) await new Promise(r => setTimeout(r, intervalMs));
  }
  console.warn(`    ⚠ ${url} did not return HTTP 200 within ${maxAttempts * intervalMs / 1000}s`);
  return false;
}

/** @returns {boolean} true when a commit was pushed (new CF Pages deploy expected) */
function gitCommitPush(repoPath, message, paths = []) {
  const addTargets = paths.length > 0 ? paths.join(' ') : '.';
  execSync(`git -C "${repoPath}" add ${addTargets}`, { stdio: 'pipe' });

  // Check if there's anything to commit
  const status = execSync(`git -C "${repoPath}" status --porcelain`, { stdio: 'pipe' }).toString().trim();
  if (!status) {
    console.log(`    (nothing new to commit in ${basename(repoPath)})`);
    return false;
  }

  execSync(`git -C "${repoPath}" commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: 'pipe' });
  execSync(`git -C "${repoPath}" push`, { stdio: 'pipe' });
  return true;
}

// ---------------------------------------------------------------------------
// Cloudflare Pages
// ---------------------------------------------------------------------------

async function ensureCfPagesProject({ slug, baseDomain }) {
  const token     = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const repoOwner = process.env.GITHUB_REPO_OWNER || 'gwgunther';
  const repoName  = process.env.GITHUB_REPO_NAME  || 'groundwork-builder';

  if (!token || !accountId) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`;

  // Check if project already exists
  const listRes  = await fetch(`${base}/${slug}`, { headers });
  const existing = await listRes.json();
  let created = false;

  if (!existing.success) {
    // Create the project
    const createRes = await fetch(base, {
      method:  'POST',
      headers,
      body: JSON.stringify({
        name:              slug,
        production_branch: 'main',
        source: {
          type:   'github',
          config: {
            owner:             repoOwner,
            repo_name:         repoName,
            production_branch: 'main',
            root_dir:          `clients/${slug}`,
          },
        },
        build_config: {
          build_command:   'npm run build',
          destination_dir: 'dist',
          root_dir:        `clients/${slug}`,
        },
        // CF Pages defaults to Node 20, but Astro 6 needs >=22.12. Without
        // this, every fresh project's first build crashes with
        //   "Node.js v20.20.0 is not supported by Astro!"
        // Setting on both production + preview branches so PRs work too.
        deployment_configs: {
          production: { env_vars: { NODE_VERSION: { value: '22' } } },
          preview:    { env_vars: { NODE_VERSION: { value: '22' } } },
        },
      }),
    });
    const createData = await createRes.json();
    if (!createData.success) {
      throw new Error(`CF create failed: ${JSON.stringify(createData.errors)}`);
    }
    created = true;
  }

  // Add custom subdomain. CF marks it status: pending until the zone has
  // a CNAME pointing at <slug>.pages.dev — that DNS step happens below.
  // Error 8000018 = "already added," fine on re-runs.
  const subdomain = `${slug}.${baseDomain}`;
  const domainRes = await fetch(`${base}/${slug}/domains`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ name: subdomain }),
  });
  const domainData = await domainRes.json();
  if (!domainData.success && domainData.errors?.[0]?.code !== 8000018) {
    console.warn(`    CF domain warning: ${JSON.stringify(domainData.errors)}`);
  }

  // Create the CNAME in DNS so CF Pages can verify the domain and issue
  // an SSL cert. Without this, the custom domain stays "pending CNAME
  // record not set" forever, the URL never resolves, and PageSpeed/rescan
  // run against an empty preview. This was missing for every build prior
  // to this fix — every project sat in pending-validation purgatory.
  try {
    await ensureCnameRecord({
      headers,
      zoneName: baseDomain,
      hostname: subdomain,
      target:   `${slug}.pages.dev`,
    });
  } catch (err) {
    console.warn(`    DNS CNAME warning: ${err.message}`);
  }

  return { project: slug, domain: subdomain, created };
}

/**
 * Ensure a proxied CNAME exists in the given zone, pointing hostname → target.
 *
 * - Looks up the zone by name (one zone lookup per ensure-call; small cost).
 * - Checks for an existing record at that hostname:
 *   · If none → creates a new proxied CNAME.
 *   · If one exists with matching content → no-op (idempotent).
 *   · If one exists with DIFFERENT content → warns and leaves it alone.
 *     Operator should resolve manually rather than have a deploy silently
 *     overwrite a record we don't understand.
 *
 * @param {object} args
 * @param {object} args.headers   Authorization + Content-Type headers
 * @param {string} args.zoneName  e.g. 'groundworkdental.com'
 * @param {string} args.hostname  e.g. 'springstdentistry.groundworkdental.com'
 * @param {string} args.target    e.g. 'springstdentistry.pages.dev'
 */
async function ensureCnameRecord({ headers, zoneName, hostname, target }) {
  // 1. Find the zone id
  const zoneListRes  = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`,
    { headers },
  );
  const zoneList = await zoneListRes.json();
  const zone = zoneList.result?.[0];
  if (!zone) {
    throw new Error(`Zone "${zoneName}" not found in this CF account — DNS:Edit on a different account?`);
  }
  const zoneId = zone.id;

  // 2. Look for an existing record at hostname
  const recListRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
    { headers },
  );
  const recList = await recListRes.json();
  const existing = recList.result?.[0];

  if (existing) {
    if (existing.type === 'CNAME' && existing.content === target) {
      // Already correct — nothing to do.
      console.log(`    ✓ DNS CNAME ${hostname} → ${target} (already present)`);
      return;
    }
    // Something else lives at this hostname — don't auto-overwrite.
    console.warn(`    ⚠ ${hostname} already has a ${existing.type} record (${existing.content}). Leaving as-is — resolve manually if you intended CF Pages to own this hostname.`);
    return;
  }

  // 3. Create the CNAME, proxied (orange-cloud) so CF Pages edge serves it.
  const createRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type:    'CNAME',
        name:    hostname,
        content: target,
        proxied: true,
        ttl:     1,   // 1 = automatic; required when proxied: true
        comment: 'Auto-created by groundwork-builder publish pipeline',
      }),
    },
  );
  const created = await createRes.json();
  if (!created.success) {
    throw new Error(`DNS create failed: ${JSON.stringify(created.errors)}`);
  }
  console.log(`    ✓ DNS CNAME ${hostname} → ${target} (created)`);
}

// ---------------------------------------------------------------------------
// Airtable — two-table model (Accounts + Runs)
// ---------------------------------------------------------------------------

/**
 * Record a build as a new Run row linked to the Account.
 *
 * Steps:
 *   1. Upsert the Account by slug. If audit ran first (PR #24), this updates
 *      the existing row with anything new + flips Lifecycle Stage to 'Pitched'.
 *      If audit was skipped, this creates the Account row from scratch.
 *   2. Look up the latest Audit row for this slug to set Source Audit.
 *   3. Create a new Build row, linked to Account + (optionally) Source Audit.
 *
 * Returns { accountId, buildId, sourceAuditId } — any may be null if
 * Airtable is disabled or no prior audit exists.
 */
async function recordBuildRun({ slug, practiceUrl, resolvedPreviewUrl, pitchUrl, pipelineDir, gcsPrefix, afterScores, rescanCounts, gateResult }) {
  const blocked = gateResult && !gateResult.passed;
  // Load merged.json for contact details to refresh on the Account
  let merged = {};
  try {
    const raw = JSON.parse(await readFile(resolve(pipelineDir, '06-merge.json'), 'utf-8'));
    merged = raw.output || raw;
  } catch { /* optional */ }

  // Cost ledger from this build's AI calls (best-effort)
  let costEst = null;
  try {
    const { getCostLedger } = await import('./ai-call.js');
    const ledger = getCostLedger();
    if (ledger.callCount > 0) costEst = Number(ledger.totalCost.toFixed(2));
  } catch { /* non-fatal */ }

  // GitHub folder URL — derive from env so it's a clickable link in Airtable
  const repoOwner = process.env.GITHUB_REPO_OWNER || 'gwgunther';
  const repoName  = process.env.GITHUB_REPO_NAME  || 'groundwork-builder';
  const githubFolderUrl = `https://github.com/${repoOwner}/${repoName}/tree/main/clients/${slug}`;

  // GCS folder — convert prefix to a clickable Cloud Console URL
  const gcsBucket = process.env.GOOGLE_CLOUD_STORAGE_BUCKET || 'builder-data';
  const gcsRunFolder = gcsPrefix
    ? `https://console.cloud.google.com/storage/browser/${gcsBucket}/${gcsPrefix}`
    : null;

  // 1. Upsert Account — flip lifecycle to Pitched only when gates pass
  const accountFields = {
    slug,
    practiceUrl,
    practiceName:   merged.practice?.name  || null,
    businessEmail:  merged.practice?.email || null,
    phone:          merged.practice?.phone || null,
    city:           merged.address?.city   || null,
    state:          merged.address?.state  || null,
  };
  if (!blocked) accountFields.lifecycleStage = 'Pitched';
  const accountId = await upsertAccount(accountFields);

  if (!accountId) {
    return { accountId: null, buildId: null, sourceAuditId: null };
  }

  // 2. Find the most recent Audit for this slug — sets Source Audit on
  // the new Build. May be null if someone built without auditing first.
  const sourceAuditId = await findLatestAuditBySlug(slug);

  const gateErrorDetail = blocked
    ? gateResult.failures.map(f => `${f.field}: ${f.hint}`).join('\n')
    : null;

  const buildPayload = {
    accountId,
    sourceAuditId,
    buildSlug:       slug,
    status:          blocked ? 'Failed' : 'Pitched',
    websiteUrl:      practiceUrl,
    previewUrl:      `https://${resolvedPreviewUrl}`,
    pitchUrl:        blocked ? null : `https://${pitchUrl}`,
    githubFolderUrl,
    gcsRunFolder,
    mobileScore:     afterScores?.mobile  ?? null,
    desktopScore:    afterScores?.desktop ?? null,
    fixedCount:      rescanCounts?.fixed ?? null,
    stillIssueCount: rescanCounts?.['still-issue'] ?? null,
    regressedCount:  rescanCounts?.regressed ?? null,
    rescannedAt:     (afterScores || rescanCounts) ? new Date().toISOString() : null,
    costEst,
    errorDetail:     gateErrorDetail,
  };

  // 3. Update Queued build from preview-request, or create new row
  const queuedBuildId = await findQueuedBuildBySlug(slug);
  let buildId;
  if (queuedBuildId) {
    buildId = await updateBuild(queuedBuildId, buildPayload);
    console.log(`  ✓ Updated Queued build ${queuedBuildId} → ${buildPayload.status}`);
  } else {
    buildId = await createBuild(buildPayload);
  }

  return { accountId, buildId, sourceAuditId, blocked };
}
