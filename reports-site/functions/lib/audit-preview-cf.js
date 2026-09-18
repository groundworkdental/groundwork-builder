/**
 * Cloudflare Pages Functions entry — copies to groundwork-dental/functions/
 */

import { handleAuditPreviewRequestHttp } from './audit-preview-request.js';

export function applyRuntimeEnv(env = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (value != null && value !== '') process.env[key] = String(value);
  }
}

export async function onRequestPost(context) {
  applyRuntimeEnv(context.env);
  return handleAuditPreviewRequestHttp(context.request);
}

export async function onRequestOptions(context) {
  applyRuntimeEnv(context.env);
  return handleAuditPreviewRequestHttp(context.request);
}
