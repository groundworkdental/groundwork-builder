/**
 * Google access tokens from a service account, with domain-wide delegation.
 *
 * Gmail has no service-account path of its own: mail belongs to a person, so
 * something must act AS that person. The usual answer is an OAuth dance with
 * a refresh token to store, rotate and eventually lose.
 *
 * Workspace offers a better one. Domain-wide delegation lets an admin grant a
 * service account permission to impersonate users in the domain, so the
 * existing key becomes the only credential — no browser step, no refresh
 * token, nothing new to keep secret. That matters here specifically because
 * every path has to be callable from a terminal with no human at it.
 *
 * Self-signed JWT rather than a client library: this is one POST and forty
 * lines, and the repo has no Google SDK installed.
 */

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const cache = new Map();

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {object} args
 * @param {string} args.keyPath  service account JSON
 * @param {string[]} args.scopes
 * @param {string} args.subject  the user to impersonate — the delegation target
 * @returns {Promise<string>} access token
 */
export async function accessToken({ keyPath, scopes, subject }) {
  const cacheKey = `${keyPath}|${subject}|${scopes.join(' ')}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;

  let key;
  try {
    key = JSON.parse(await readFile(keyPath, 'utf8'));
  } catch (err) {
    throw new Error(`could not read service account key at ${keyPath}: ${err.message}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(`${keyPath} is not a service account key (no client_email/private_key)`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    sub: subject,                 // impersonation — the delegation itself
    scope: scopes.join(' '),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const data = await res.json();

  if (!res.ok || !data.access_token) {
    // The two failures that actually happen, named so nobody has to guess.
    const hint = data.error === 'unauthorized_client'
      ? `\n\nThe service account is not authorised for these scopes. In the Workspace admin console:` +
        `\n  Security → Access and data control → API controls → Domain-wide delegation` +
        `\n  Add client ID ${key.client_id} with scopes:\n    ${scopes.join('\n    ')}`
      : data.error === 'invalid_grant'
        ? `\n\ninvalid_grant usually means "${subject}" is not a user in this Workspace domain,` +
          `\nor the key has been rotated. Check GMAIL_USER.`
        : '';
    throw new Error(`token request failed: ${data.error || res.status} ${data.error_description || ''}${hint}`);
  }

  cache.set(cacheKey, { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}
