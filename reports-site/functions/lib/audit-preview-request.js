/**
 * Preview request — warm lead from audit one-pager.
 * Upserts CRM (Airtable), queues a build, optionally triggers CI.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  upsertAccount,
  findLatestAuditBySlug,
  createBuild,
  updateAudit,
} from './d1.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {object} body
 * @param {string} body.slug
 * @param {string} body.name
 * @param {string} body.email
 * @param {string} [body.phone]
 * @param {string} [body.role]
 * @param {string} [body.message]
 * @param {string} [body.practiceName]
 * @param {string} [body.practiceUrl]
 * @param {string} [body.auditPageUrl]
 * @param {string} [body.company_website] - honeypot; must be empty
 */
export async function submitAuditPreviewRequest(body, opts = {}) {
  const errors = validatePreviewRequest(body);
  if (errors.length) {
    return { ok: false, status: 400, errors };
  }

  const slug = String(body.slug).trim().toLowerCase();
  const name = String(body.name).trim();
  const email = String(body.email).trim().toLowerCase();
  const phone = body.phone ? String(body.phone).trim() : null;
  const role = body.role ? String(body.role).trim() : null;
  const message = body.message ? String(body.message).trim() : null;
  const practiceName = body.practiceName ? String(body.practiceName).trim() : null;
  const practiceUrl = body.practiceUrl ? String(body.practiceUrl).trim() : null;
  const auditPageUrl = body.auditPageUrl ? String(body.auditPageUrl).trim() : null;

  const notes = formatRequestNotes({ name, email, phone, role, message, auditPageUrl });

  let accountId = null;
  let auditId = null;
  let buildId = null;

  try {
    accountId = await upsertAccount({
      slug,
      practiceUrl,
      practiceName,
      contactName: name,
      contactEmail: email,
      phone,
      source: 'self-serve',
      lifecycleStage: 'Preview Requested',
    });
    auditId = await findLatestAuditBySlug(slug);
    if (auditId) {
      await updateAudit(auditId, {
        contactEmail: email,
        status: 'Preview Requested',
      });
    }
    if (accountId) {
      buildId = await createBuild({
        accountId,
        buildSlug: slug,
        status: 'Queued',
        websiteUrl: practiceUrl,
        sourceAuditId: auditId,
        requestNotes: notes,
        contactName: name,
        contactEmail: email,
        contactPhone: phone,
        contactRole: role,
      });
    }
  } catch (err) {
    console.error('[preview-request] Airtable error:', err.message);
    return {
      ok: false,
      status: 502,
      errors: ['Could not save your request. Please email hello@groundworkdental.com.'],
    };
  }

  const buildTrigger = await triggerPreviewBuild({
    slug,
    practiceUrl,
    contactEmail: email,
    contactName: name,
  });

  if (opts.auditDir) {
    await persistPreviewRequest(opts.auditDir, {
      slug,
      name,
      email,
      phone,
      role,
      message,
      practiceUrl,
      auditPageUrl,
      submittedAt: new Date().toISOString(),
      accountId,
      auditId,
      buildId,
      buildTrigger,
    });
  }

  return {
    ok: true,
    status: 200,
    slug,
    accountId,
    auditId,
    buildId,
    buildTrigger,
    message: 'Thanks — we\'ll email your full audit and a live preview of your redesigned site within 24 hours.',
  };
}

export function validatePreviewRequest(body) {
  const errors = [];
  if (body?.company_website) errors.push('Invalid submission.');
  if (!body?.slug?.trim()) errors.push('Missing practice identifier.');
  if (!body?.name?.trim()) errors.push('Please enter your name.');
  if (!body?.email?.trim() || !EMAIL_RE.test(body.email.trim())) {
    errors.push('Please enter a valid email address.');
  }
  return errors;
}

function formatRequestNotes({ name, email, phone, role, message, auditPageUrl }) {
  const lines = [
    `Contact: ${name} <${email}>`,
    phone ? `Phone: ${phone}` : null,
    role ? `Role: ${role}` : null,
    auditPageUrl ? `Audit page: ${auditPageUrl}` : null,
    message ? `Message: ${message}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

async function persistPreviewRequest(auditDir, payload) {
  const dataDir = join(resolve(auditDir), '_data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, 'preview-request.json'),
    JSON.stringify(payload, null, 2),
    'utf-8',
  );
}

async function triggerPreviewBuild({ slug, practiceUrl, contactEmail, contactName }) {
  if (process.env.AUDIT_PREVIEW_AUTORUN === 'false') {
    return { triggered: false, reason: 'autorun_disabled' };
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_PAT;
  const owner = process.env.GITHUB_REPO_OWNER || process.env.GITHUB_REPOSITORY_OWNER;
  const repo = process.env.GITHUB_REPO_NAME || process.env.GITHUB_REPOSITORY?.split('/')[1];

  if (!token || !owner || !repo || !practiceUrl) {
    return { triggered: false, reason: 'missing_github_config_or_url' };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/audit-preview-build.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: process.env.GITHUB_BUILD_REF || 'main',
          inputs: {
            slug,
            practice_url: practiceUrl,
            contact_email: contactEmail || '',
            contact_name: contactName || '',
          },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { triggered: false, reason: `github_http_${res.status}`, detail: text.slice(0, 200) };
    }
    return { triggered: true, reason: 'github_dispatch' };
  } catch (err) {
    return { triggered: false, reason: 'github_error', detail: err.message };
  }
}

/** HTTP handler for Studio / Cloudflare Pages Functions. */
export async function handleAuditPreviewRequestHttp(request) {
  if (request.method === 'OPTIONS') {
    return corsJson({ ok: true }, 204);
  }
  if (request.method !== 'POST') {
    return corsJson({ ok: false, errors: ['Method not allowed'] }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ ok: false, errors: ['Invalid JSON body'] }, 400);
  }

  const result = await submitAuditPreviewRequest(body);
  return corsJson(
    result.ok
      ? { ok: true, message: result.message }
      : { ok: false, errors: result.errors },
    result.status,
  );
}

function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
