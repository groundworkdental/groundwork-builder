/**
 * designer-agent.js — The design pass.
 *
 * Two passes, not a hill-climb:
 *
 *   Pass 1 — diagnose: screenshot, critique once, and plan a fix for every
 *            agent-fixable dimension below the gate. Run each planned skill
 *            against that one diagnosis, then rebuild once.
 *   Pass 2 — audit: re-screenshot, re-score, and run a single standardize
 *            (polish) pass over the combined result. Roll the whole of pass 1
 *            back if the build broke or the score dropped.
 *
 * The previous shape critiqued, fixed one dimension, and rebuilt — six times.
 * That spent six rebuilds and twelve critiques to apply what is usually four
 * independent edits, and because each re-score fed the next decision, a single
 * bad reading steered everything after it.
 *
 * Screenshots reach the critique as viewport-sized tiles (see observe.js). Full
 * page captures were being downsampled to roughly 372px wide before the model
 * saw them, so every score above was derived from an image nothing could read.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve }                from 'node:path';
import { spawn }                        from 'node:child_process';
import { observe }                      from './observe.js';
import { runSkill }                     from '../skills/index.js';
import { upsertManagedFile }            from './managed-file.js';
import { validatePalette }              from './contrast.js';

// Skill linked to each rubric dimension (from rubric.json + skills-registry.json)
const DIM_TO_SKILL = {
  typography:            'typeset',
  color_contrast:        'colorize',
  spatial_layout:        'layout',
  information_hierarchy: 'layout',
  craft:                 'polish',
  ux_writing:            'polish',
  trust_signals:         'polish',
  distinctiveness:       'bolder',   // pushes creative differentiation
  imagery:               'imagery',  // selects better images from analyzed pool
};

// Dimensions that don't block the agent gate — reported as action items instead
const HUMAN_DIMS = new Set(['distinctiveness', 'imagery', 'trust_signals']);
const SKIP_DIMS  = new Set([]); // nothing fully skipped — all dims now have skills

export async function runDesignerAgent({
  projectDir,
  dna,
  practice,
  maxIterations = 6,   // max skills applied in pass 1 (was: loop turns)
  buildFn,        // async (projectDir) => void  — rebuilds the Astro project
  referenceAudit = null, // catalog entry's audit block ({sanctionedPatterns, fidelityChecks})
                         // — re-points critique+skills from taste-audit to fidelity-audit
                         // (docs/design-catalog/SCHEMA.md §5). null → unchanged behavior.
} = {}) {
  if (!projectDir) throw new Error('designer-agent: projectDir required');
  if (!buildFn)    throw new Error('designer-agent: buildFn required');

  const trace = [];
  let previousScore  = null;
  let finalScore     = null;
  let gate_pass      = false;

  // Agent-fixable dimensions. Human dims (imagery, distinctiveness, trust_signals)
  // are reported as action items and never block the gate.
  const AGENT_DIMS = ['typography','color_contrast','spatial_layout','information_hierarchy','craft','ux_writing'];
  const GATE_SCORE = 7;

  const dimsOf   = (score) => score?.dimensions || {};
  const scoreOf  = (d) => (typeof d === 'object' ? d?.score : d) ?? 0;
  const passes   = (score) => AGENT_DIMS.every(d => scoreOf(dimsOf(score)[d]) >= GATE_SCORE)
    && score?.fidelity_pass !== false;

  let measuredContrast = null;
  const look = async (viewports) => {
    const { screenshots, contrast } = await observe({
      projectDir, routes: ['/'],
      viewports: viewports || [{ w: 1280, h: 900 }, { w: 375, h: 812 }],
      narrate: false,
    });
    if (contrast) measuredContrast = contrast;
    return screenshots;
  };

  /**
   * Replace the critique's judged `color_contrast` with the measured result.
   *
   * Contrast has an exact answer, and the model does not have it: one run scored
   * this 7/10 — comfortably past the gate — on a build axe found 177 contrast
   * failures on. When the measurement is unavailable the judged score stands,
   * because an unrun check must not read as a pass.
   */
  const groundContrast = (score) => {
    if (!score?.dimensions || !measuredContrast) return score;
    const n = measuredContrast.violations ?? 0;
    // Any serious contrast failure is disqualifying; the gate is 7.
    const grounded = n === 0 ? 9 : n <= 3 ? 6 : n <= 20 ? 4 : 2;
    const before = scoreOf(score.dimensions.color_contrast);
    score.dimensions.color_contrast = {
      ...(typeof score.dimensions.color_contrast === 'object' ? score.dimensions.color_contrast : {}),
      score: grounded,
      measured: true,
      violations: n,
      note: `axe-core measured ${n} color-contrast violation(s); judged score was ${before}`,
    };
    if (before !== grounded) {
      console.log(`[designer-agent] color_contrast ${before} → ${grounded} (measured: ${n} violation(s))`);
    }
    return score;
  };

  // ── Pass 1: diagnose once, then fix every weak dimension ─────────────────
  //
  // This replaces a hill-climb that critiqued, fixed one dimension, and rebuilt,
  // six times over. That cost six rebuilds and twelve critiques to apply what is
  // usually four independent edits, and each re-score fed the next decision — so
  // one bad reading steered everything after it. Diagnose once, act on the whole
  // diagnosis, then audit.
  console.log('\n[designer-agent] pass 1 — diagnose');
  let screenshots = await look();
  let files       = await loadKeyFiles(projectDir);

  const diagnosis = await runSkill('critique', { dna, practice, screenshots, files, referenceAudit });
  const baseline  = groundContrast(diagnosis?.score) || null;
  previousScore   = baseline;
  gate_pass       = passes(baseline);

  console.log(`[designer-agent] baseline score=${baseline?.overall ?? 'n/a'} gate=${gate_pass}`);
  trace.push({
    iteration: 1, phase: 'diagnose',
    scores_before: null,
    scores_after: baseline?.dimensions ? dimScoreMap(baseline.dimensions) : null,
    overall: baseline?.overall, gate_pass, action_taken: 'critique', delta: null,
  });

  if (gate_pass) {
    console.log('[designer-agent] gate already passed — no changes needed.');
    finalScore = baseline;
  } else {
    // Every agent-fixable dimension below the gate, weakest first. Each maps to
    // one skill; a skill is run at most once even if it owns two weak dimensions.
    const weak = AGENT_DIMS
      .map(d => ({ dim: d, score: scoreOf(dimsOf(baseline)[d]) }))
      .filter(d => !baseline || d.score < GATE_SCORE)
      .sort((a, b) => a.score - b.score);

    const planned = [];
    for (const { dim, score } of weak) {
      const skill = DIM_TO_SKILL[dim];
      if (!skill || planned.some(p => p.skill === skill)) continue;
      planned.push({ skill, dim, score });
    }
    // No critique (JSON parse failure) → fall back to the standard sweep.
    if (planned.length === 0) {
      for (const skill of ['typeset', 'colorize', 'layout', 'polish']) planned.push({ skill, dim: null, score: null });
    }

    if (planned.length > maxIterations) {
      console.log(`[designer-agent] plan capped at ${maxIterations} skill(s); dropping ${planned.length - maxIterations}`);
      planned.length = maxIterations;
    }

    console.log(`[designer-agent] plan: ${planned.map(p => `${p.skill}(${p.dim ?? 'default'}${p.score !== null ? ' ' + p.score : ''})`).join(' → ')}`);

    // Snapshot before any edits so the whole pass can be reverted as a unit.
    const touched = new Set();
    let appliedTotal = 0;
    const preAllSnapshot = [];

    for (const { skill, dim } of planned) {
      let result;
      try {
        result = await runSkill(skill, { dna, practice, screenshots, files, referenceAudit });
      } catch (err) {
        console.error(`[designer-agent] skill ${skill} failed: ${err.message}`);
        trace.push({ iteration: trace.length + 1, phase: 'fix', action_taken: `${skill}:failed`, dim });
        continue;
      }
      const changes = result.changes || [];
      preAllSnapshot.push(...await snapshotFiles(projectDir, changes));
      const applied = await applyChanges(projectDir, changes);
      appliedTotal += applied;
      changes.forEach(c => c?.file && touched.add(c.file));
      console.log(`[designer-agent] ${skill}: applied ${applied} change(s)`);
      trace.push({ iteration: trace.length + 1, phase: 'fix', action_taken: `${skill}:${applied}_changes`, dim });
    }

    // ── Pass 2: rebuild once, re-score, standardize ────────────────────────
    console.log(`\n[designer-agent] pass 2 — audit (${appliedTotal} change(s) across ${touched.size} file(s))`);

    let buildFailed = false;
    if (appliedTotal > 0) {
      try { await buildFn(projectDir); }
      catch (err) { buildFailed = true; console.error(`[designer-agent] rebuild failed: ${err.message}`); }
    }

    if (buildFailed) {
      console.warn('[designer-agent] rolling back pass 1 — rebuild failed.');
      await restoreSnapshot(preAllSnapshot);
      try { await buildFn(projectDir); } catch {}
      finalScore = baseline;
      trace.push({ iteration: trace.length + 1, phase: 'audit', action_taken: 'rolled_back:build_failed' });
    } else if (appliedTotal === 0) {
      console.log('[designer-agent] no changes applied — nothing to audit.');
      finalScore = baseline;
    } else {
      screenshots = await look();
      files       = await loadKeyFiles(projectDir);
      const audit = await runSkill('critique', { dna, practice, screenshots, files, referenceAudit });
      let after   = groundContrast(audit?.score) || baseline;

      const regressed = (after?.overall ?? 0) - (baseline?.overall ?? 0) < -0.5;
      if (regressed) {
        console.warn(`[designer-agent] rolling back pass 1 — score dropped ${baseline?.overall} → ${after?.overall}`);
        await restoreSnapshot(preAllSnapshot);
        try { await buildFn(projectDir); } catch {}
        finalScore = baseline;
        gate_pass  = passes(baseline);
        trace.push({ iteration: trace.length + 1, phase: 'audit', action_taken: 'rolled_back:score_dropped',
                     overall: after?.overall, delta: Math.round(((after?.overall ?? 0) - (baseline?.overall ?? 0)) * 10) / 10 });
      } else {
        // Standardize: one polish pass over the combined result. Independent
        // fixes can leave inconsistent spacing or weights at their seams — this
        // is the only place that sees them together.
        if (!passes(after)) {
          try {
            const polish  = await runSkill('polish', { dna, practice, screenshots, files, referenceAudit });
            const changes = polish.changes || [];
            const snap    = await snapshotFiles(projectDir, changes);
            const applied = await applyChanges(projectDir, changes);
            if (applied > 0) {
              try {
                await buildFn(projectDir);
                const finalShots = await look([{ w: 1280, h: 900 }]);
                const recheck = await runSkill('critique', {
                  dna, practice, screenshots: finalShots, files: await loadKeyFiles(projectDir), referenceAudit,
                });
                const rescored = groundContrast(recheck?.score);
                if ((rescored?.overall ?? 0) >= (after?.overall ?? 0)) after = rescored;
                else { await restoreSnapshot(snap); try { await buildFn(projectDir); } catch {} }
              } catch (err) {
                console.warn(`[designer-agent] polish rebuild failed (${err.message}) — reverting polish.`);
                await restoreSnapshot(snap);
                try { await buildFn(projectDir); } catch {}
              }
            }
            console.log(`[designer-agent] standardize: applied ${applied} change(s)`);
          } catch (err) {
            console.warn(`[designer-agent] standardize pass failed: ${err.message}`);
          }
        }

        finalScore = after;
        gate_pass  = passes(after);
        trace.push({
          iteration: trace.length + 1, phase: 'audit',
          scores_before: baseline?.dimensions ? dimScoreMap(baseline.dimensions) : null,
          scores_after:  after?.dimensions ? dimScoreMap(after.dimensions) : null,
          overall: after?.overall, gate_pass, action_taken: 'audit',
          delta: Math.round(((after?.overall ?? 0) - (baseline?.overall ?? 0)) * 10) / 10,
        });
        console.log(`[designer-agent] final score=${after?.overall} gate=${gate_pass} (was ${baseline?.overall})`);
      }
    }
  }

  // If loop exhausted without finalScore, use last score
  if (!finalScore && previousScore) finalScore = previousScore;

  return {
    finalScore,
    gate_pass,
    iterations: trace.length,
    trace,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────


/**
 * Apply an array of file changes to projectDir.
 * Uses upsertManagedFile for managed blocks; falls back to direct replace.
 * Returns count of successfully applied changes.
 */
async function applyChanges(projectDir, changes) {
  let count = 0;
  for (const change of changes) {
    const absPath = resolve(projectDir, change.file);
    try {
      let content = await readFile(absPath, 'utf8').catch(() => '');

      if (change.type === 'replace' && change.old) {
        if (!content.includes(change.old)) {
          console.warn(`[apply] old string not found in ${change.file}, skipping`);
          continue;
        }
        content = content.replace(change.old, change.new);
      } else if (change.type === 'append') {
        content = content + '\n' + change.new;
      } else if (change.type === 'prepend') {
        content = change.new + '\n' + content;
      } else if (change.type === 'managed') {
        await upsertManagedFile(projectDir, change.file, change.new);
        count++;
        continue;
      } else {
        // Full file overwrite (new file)
        content = change.new;
      }

      const reject = validateChange(change.file, content);
      if (reject) {
        console.warn(`[apply] rejected change to ${change.file}: ${reject}`);
        continue;
      }

      // colorize rewrites the palette in tailwind.config.mjs, downstream of both
      // WCAG guards (brand-tokens and the injector). It is dispatched *because*
      // contrast scored low, and it has shipped palettes that still fail AA —
      // one run emitted accent #5a8000 at 4.16:1 on brand-light. Repair rather
      // than reject: rejecting leaves the original failing palette in place.
      const repair = repairPaletteContent(change.file, content);
      if (repair.fixes) {
        console.log(`[apply] WCAG-corrected ${repair.fixes} colour(s) in ${change.file}: ${repair.notes.join(', ')}`);
        content = repair.content;
      }

      await writeFile(absPath, content, 'utf8');
      count++;
    } catch (err) {
      console.warn(`[apply] failed to apply change to ${change.file}:`, err.message);
    }
  }
  return count;
}

/**
 * Enforce AA on a palette a skill just rewrote.
 *
 * Only touches tailwind.config.mjs. Returns the content unchanged when the file
 * isn't a palette or every colour already passes.
 */
export function repairPaletteContent(file, content) {
  if (!/tailwind\.config\.(mjs|js)$/.test(file)) return { content, fixes: 0, notes: [] };

  const block = content.match(/brand:\s*\{([\s\S]*?)\}/);
  if (!block) return { content, fixes: 0, notes: [] };

  const brand = {};
  for (const m of block[1].matchAll(/(\w+):\s*'(#[0-9a-fA-F]{3,8})'/g)) brand[m[1]] = m[2];
  if (!brand.primary) return { content, fixes: 0, notes: [] };

  const result = validatePalette({
    primary:   brand.primary,
    accent:    brand.accent,
    highlight: brand.highlight || brand.accent,
    light:     brand.light,
    dark:      brand.dark,
    muted:     brand.muted,
  });
  if (!result.adjustments?.length) return { content, fixes: 0, notes: [] };

  let out = content;
  const notes = [];
  for (const adj of result.adjustments) {
    if (!brand[adj.key]) continue;
    out = out.replace(
      new RegExp(`(${adj.key}:\\s*')${adj.from}(')`, 'g'),
      `$1${adj.to}$2`
    );
    notes.push(`${adj.key} ${adj.from}→${adj.to}`);
  }
  return { content: out, fixes: notes.length, notes };
}

/**
 * Reject a proposed file state that would break the Astro build.
 *
 * Skills write CSS as often as markup, and in Tailwind 4 an `@apply` inside a
 * component `<style>` block only resolves when the block declares `@reference`
 * to the global stylesheet. Without it the build fails on an "invalid candidate"
 * — which is what `polish` did: the rollback recovered, but only after a wasted
 * rebuild. Catching it here costs nothing.
 *
 * Returns a reason string when the change should be dropped, or null to allow.
 */
export function validateChange(file, content) {
  if (!file.endsWith('.astro')) return null;

  for (const block of content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = block[1];
    if (!/@apply\b/.test(css)) continue;
    if (/@reference\b/.test(css)) continue;
    return '`@apply` in a scoped <style> block without `@reference` — Tailwind 4 fails the build on this';
  }
  return null;
}

/**
 * Snapshot the files that a skill intends to modify.
 * Returns a map of { absPath → originalContent } for restoration.
 */
async function snapshotFiles(projectDir, changes) {
  const snapshot = new Map();
  for (const change of changes) {
    const absPath = resolve(projectDir, change.file);
    try {
      const content = await readFile(absPath, 'utf8');
      snapshot.set(absPath, content);
    } catch {
      // File doesn't exist yet — mark as "new" so rollback can delete it
      snapshot.set(absPath, null);
    }
  }
  return snapshot;
}

/**
 * Restore files from a snapshot taken before a skill ran.
 * Files that didn't exist before (null) are removed.
 */
async function restoreSnapshot(snapshot) {
  for (const [absPath, originalContent] of snapshot.entries()) {
    try {
      if (originalContent === null) {
        // File was created by the skill — delete it on rollback
        const { unlink } = await import('node:fs/promises');
        await unlink(absPath).catch(() => {});
      } else {
        await writeFile(absPath, originalContent, 'utf8');
      }
    } catch (err) {
      console.warn(`[rollback] failed to restore ${absPath}:`, err.message);
    }
  }
  console.log(`[rollback] restored ${snapshot.size} file(s) to pre-skill state`);
}

/**
 * Load the key files the agent needs for skill context.
 */
async function loadKeyFiles(projectDir) {
  const targets = [
    'src/pages/index.astro',
    'tailwind.config.mjs',
    'tailwind.config.js',
    'src/config/design-dna.ts',
    'src/config/site.ts',
    // global.css is injector-owned; skills need it to know which tokens are
    // in use so they don't accidentally rename/remove a referenced class.
    'src/styles/global.css',
  ];

  const files = {};
  for (const rel of targets) {
    try {
      files[rel] = await readFile(join(projectDir, rel), 'utf8');
    } catch {}
  }
  return files;
}

function dimScoreMap(dimensions) {
  return Object.fromEntries(
    Object.entries(dimensions).map(([k, v]) => [k, v.score])
  );
}

/**
 * Default buildFn: runs `npx astro build` in the project directory.
 * Pass a custom buildFn to designer-agent if you need a different build process.
 */
export async function buildAstro(projectDir, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['astro', 'build'], {
      cwd: projectDir,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out = [];
    proc.stdout?.on('data', d => out.push(d.toString()));
    proc.stderr?.on('data', d => out.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`astro build timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ output: out.join('') });
      else reject(new Error(`astro build exited ${code}:\n${out.join('').slice(-1000)}`));
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}
