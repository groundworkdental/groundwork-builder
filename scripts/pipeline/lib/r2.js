/**
 * R2 — object storage on the account everything else already lives on.
 *
 * This replaced Google Cloud Storage. The bucket was the last Groundwork asset
 * sitting in a personal-account GCP project, and moving it to Cloudflare
 * removed a billing relationship rather than merely re-parenting one: R2 gives
 * 10 GB free against GCS's 5, charges nothing for egress, and sits beside the
 * D1, Pages, Workers and DNS this system already depends on.
 *
 * R2 speaks S3, so this is SigV4 request signing and nothing more — about
 * seventy lines of node:crypto against a ~20 MB SDK whose S3 client would be
 * the heaviest dependency in the repo. Same trade as the service-account JWT
 * in google-jwt.js.
 */

import { createHash, createHmac } from 'node:crypto';

const REGION = 'auto';          // R2 ignores region but SigV4 requires one
const SERVICE = 's3';

/**
 * S3 credentials, derived from the Cloudflare API token rather than minted
 * separately.
 *
 * R2 does not issue its own identity: an R2 "API token" is an ordinary
 * Cloudflare token, and the S3 pair is computed from it — the access key id is
 * the token's id, and the secret is the SHA-256 of the token value. So a token
 * that already carries Workers R2 Storage:Edit needs no companion credential.
 *
 * That is worth doing rather than pasting two more strings into .env. Every
 * credential is a thing to rotate, leak, and forget the purpose of, and this
 * one would have been a second copy of an authority we already hold.
 *
 * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY still override, for a token scoped
 * to one bucket when this one is scoped to the account.
 */
function settings() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET || 'groundwork-builder-data';

  let accessKeyId = process.env.R2_ACCESS_KEY_ID;
  let secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if ((!accessKeyId || !secretAccessKey) && process.env.CLOUDFLARE_API_TOKEN_ID && process.env.CLOUDFLARE_API_TOKEN) {
    accessKeyId = process.env.CLOUDFLARE_API_TOKEN_ID;
    secretAccessKey = createHash('sha256').update(process.env.CLOUDFLARE_API_TOKEN).digest('hex');
  }

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 is not configured. Either:\n' +
      '  CLOUDFLARE_API_TOKEN_ID  — the id of a token with Workers R2 Storage:Edit\n' +
      '                             (curl .../user/tokens/verify returns it), or\n' +
      '  R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY — a dedicated R2 token',
    );
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function r2Configured() {
  try { settings(); return true; } catch { return false; }
}

const sha256hex = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** Each path segment is encoded, but the separators are not. */
function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

/**
 * Sign and send one S3 request.
 *
 * Only the pieces R2 actually needs: no chunked uploads, no multipart. A
 * screenshot or an HTML capture is a single PUT, and anything large enough to
 * need multipart does not belong in this bucket.
 */
async function signedFetch({ method, key, body = null, contentType = null }) {
  const { accountId, accessKeyId, secretAccessKey, bucket } = settings();
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${encodeKey(key)}`;

  const payload = body == null ? '' : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const payloadHash = sha256hex(payload);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260919T053000Z
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(contentType ? { 'content-type': contentType } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');

  const canonicalRequest = [
    method, path, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');

  let k = hmac(`AWS4${secretAccessKey}`, dateStamp);
  k = hmac(k, REGION);
  k = hmac(k, SERVICE);
  k = hmac(k, 'aws4_request');
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex');

  const res = await fetch(`https://${host}${path}`, {
    method,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    ...(method === 'PUT' || method === 'POST' ? { body: payload } : {}),
  });
  return res;
}

/** Upload a buffer or string. Returns the r2:// locator. */
export async function r2Put(key, content, contentType = 'application/octet-stream') {
  const res = await signedFetch({ method: 'PUT', key, body: content, contentType });
  if (!res.ok) {
    throw new Error(`r2 PUT ${key} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  const { bucket } = settings();
  return `r2://${bucket}/${key}`;
}

/** Fetch an object. Returns null when absent, rather than throwing. */
export async function r2Get(key) {
  const res = await signedFetch({ method: 'GET', key });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`r2 GET ${key} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Does the bucket answer? Used by storageStatus and the setup check. */
export async function r2Check() {
  const probe = `_healthcheck/${Date.now()}.txt`;
  await r2Put(probe, 'ok', 'text/plain');
  const got = await r2Get(probe);
  await signedFetch({ method: 'DELETE', key: probe }).catch(() => {});
  return got?.toString() === 'ok';
}
