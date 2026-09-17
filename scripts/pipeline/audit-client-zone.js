#!/usr/bin/env node
/**
 * audit-client-zone.js — Cloudflare zone audit for a client domain.
 *
 * Every check here is something found by hand on a live client zone, where
 * nothing in the site build could have caught it: the defect lives in DNS and
 * zone configuration, not in the repo.
 *
 *   proxied mail records  every record in the zone had been orange-clouded at
 *                         once, including the Microsoft 365 DKIM selectors.
 *                         Cloudflare's proxy answers a DKIM lookup with its
 *                         own IPs instead of the TXT record a verifier needs,
 *                         so outbound mail could not be signed. Combined with
 *                         SPF -all and DMARC p=quarantine, the practice's mail
 *                         was liable to be quarantined — invisibly, because
 *                         sending still "works" from the sender's side.
 *   min TLS 1.0           deprecated, and a compliance flag for a healthcare
 *                         site
 *   Always Use HTTPS off  http worked only because a redirect rule happened
 *                         to catch it
 *
 * Needs a token with Zone:Read, Zone Settings:Read and (for the Pages check)
 * Account → Cloudflare Pages:Read. A USER token, not an account token — see
 * docs/engineering/platform-gotchas.md for why that distinction matters when
 * the zone lives in a client's or their MSP's account.
 *
 *   CLOUDFLARE_API_TOKEN=… node scripts/pipeline/audit-client-zone.js <domain>
 */

const API = 'https://api.cloudflare.com/client/v4';
const DOH = 'https://dns.google/resolve';

const results = [];
const pass = (name, detail = '') => results.push({ level: 'PASS', name, detail });
const warn = (name, detail) => results.push({ level: 'WARN', name, detail });
const fail = (name, detail) => results.push({ level: 'FAIL', name, detail });

const token = process.env.CLOUDFLARE_API_TOKEN;

async function cf(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.success) {
    const msg = (body.errors || []).map((e) => `${e.code} ${e.message}`).join('; ');
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return body.result;
}

/**
 * Resolve through a public resolver rather than the local one.
 *
 * A local resolver can answer from cache with the pre-change value, which
 * makes a broken record look fixed (and a fixed one look broken) for as long
 * as the TTL runs. Asking Google is the closest cheap proxy for "what does
 * the rest of the internet see".
 */
async function resolve(name, type) {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
  });
  const body = await res.json().catch(() => ({}));
  return (body.Answer || []).map((a) => String(a.data || ''));
}

/**
 * Hostnames that must never be proxied.
 *
 * The proxy terminates HTTP(S). Pointing it at anything else — mail, device
 * enrollment, service discovery — replaces the answer the client needs with
 * Cloudflare's own addresses. Matching is on the record's own shape rather
 * than a fixed vendor list, so this holds for Google Workspace and Microsoft
 * 365 alike.
 */
const MUST_BE_DNS_ONLY = [
  [/^_domainkey\.|\._domainkey\./i, 'DKIM selector — a proxied CNAME breaks mail signing'],
  [/^autodiscover\./i, 'Outlook autodiscover'],
  [/^enterpriseenrollment\./i, 'Intune device enrollment'],
  [/^enterpriseregistration\./i, 'Entra device registration'],
  [/^_dmarc\./i, 'DMARC policy record'],
  [/^(mail|smtp|imap|pop|mx\d*)\./i, 'mail service host'],
  [/^_sip\.|^sip\.|^lyncdiscover\./i, 'SIP / Teams discovery'],
];

async function checkDnsHygiene(zoneId, domain) {
  const records = await cf(`/zones/${zoneId}/dns_records?per_page=200`);

  const offenders = [];
  for (const r of records) {
    if (!r.proxied) continue;
    for (const [re, why] of MUST_BE_DNS_ONLY) {
      if (re.test(r.name)) {
        offenders.push(`${r.name} (${why})`);
        break;
      }
    }
  }

  offenders.length
    ? fail(
        'proxied service records',
        `${offenders.length} record(s) proxied that must be DNS-only — ` +
          `the proxy answers with Cloudflare's IPs instead of the real target: ` +
          offenders.join('; '),
      )
    : pass('proxied service records', 'no mail or service records behind the proxy');

  // An MX pointing at a proxied host is the same bug in a different shape.
  const mx = records.filter((r) => r.type === 'MX');
  if (!mx.length) {
    warn('MX', 'no MX records — the domain receives no mail');
  } else {
    const proxiedTargets = mx
      .map((m) => m.content.replace(/\.$/, ''))
      .filter((target) => records.some((r) => r.name === target && r.proxied));
    proxiedTargets.length
      ? fail('MX target', `MX points at proxied host(s): ${proxiedTargets.join(', ')}`)
      : pass('MX', `${mx.length} record(s), targets not proxied`);
  }

  return records;
}

async function checkMailAuth(domain, records) {
  // SPF
  const spf = (await resolve(domain, 'TXT'))
    .map((t) => t.replace(/^"|"$/g, '').replace(/" "/g, ''))
    .find((t) => t.toLowerCase().startsWith('v=spf1'));

  if (!spf) {
    fail('SPF', 'no v=spf1 record — mail from this domain has no sender policy');
  } else {
    const strict = /[-~]all\s*$/.test(spf.trim());
    const includes = (spf.match(/include:/g) || []).length;
    if (/-all\s*$/.test(spf.trim())) {
      warn(
        'SPF',
        `hard fail (-all) with ${includes} include(s): ${spf.slice(0, 90)}. ` +
          `Anything sending as this domain that is not listed will fail. ` +
          `Confirm before adding a booking, review or reminder tool.`,
      );
    } else if (strict) {
      pass('SPF', spf.slice(0, 90));
    } else {
      warn('SPF', `no all-mechanism — policy is open ended: ${spf.slice(0, 90)}`);
    }
  }

  // DMARC
  const dmarc = (await resolve(`_dmarc.${domain}`, 'TXT'))
    .map((t) => t.replace(/^"|"$/g, '').replace(/" "/g, ''))
    .find((t) => t.toLowerCase().startsWith('v=dmarc1'));

  if (!dmarc) {
    warn('DMARC', 'no _dmarc record — nothing tells receivers what to do with failures');
  } else {
    const policy = (/p=(\w+)/.exec(dmarc) || [])[1] || 'unknown';
    policy === 'none'
      ? warn('DMARC', `p=none — monitoring only, failures are still delivered`)
      : pass('DMARC', `p=${policy}`);
  }

  // DKIM — resolve the selectors that exist in the zone, whoever the provider is.
  const selectors = records
    .filter((r) => /_domainkey/i.test(r.name) && (r.type === 'CNAME' || r.type === 'TXT'))
    .map((r) => r.name);

  if (!selectors.length) {
    warn('DKIM', 'no _domainkey records — outbound mail is unsigned');
    return;
  }

  const broken = [];
  for (const sel of selectors) {
    const txt = (await resolve(sel, 'TXT')).join(' ');
    if (!/v=DKIM1/i.test(txt)) broken.push(sel);
  }
  broken.length
    ? fail(
        'DKIM',
        `${broken.length}/${selectors.length} selector(s) do not resolve to a v=DKIM1 key: ` +
          `${broken.join(', ')}. Mail cannot be signed.`,
      )
    : pass('DKIM', `${selectors.length} selector(s) resolve to a key`);
}

async function checkZoneSettings(zoneId) {
  const want = {
    ssl: { good: ['full', 'strict'], bad: ['flexible', 'off'] },
    min_tls_version: { good: ['1.2', '1.3'] },
    always_use_https: { good: ['on'] },
  };

  for (const [setting, rule] of Object.entries(want)) {
    let value;
    try {
      ({ value } = await cf(`/zones/${zoneId}/settings/${setting}`));
    } catch (err) {
      warn(setting, `could not read (${err.message})`);
      continue;
    }
    if (rule.bad?.includes(value)) {
      fail(setting, `${value} — Flexible/off sends unencrypted traffic to the origin`);
    } else if (rule.good.includes(value)) {
      pass(setting, String(value));
    } else {
      warn(setting, `${value} — expected one of ${rule.good.join(', ')}`);
    }
  }

  // HSTS is reported, never prescribed: browsers cache the policy for its full
  // max-age, so enabling it wrongly is not something a later fix undoes.
  try {
    const { value } = await cf(`/zones/${zoneId}/settings/security_header`);
    const sts = value?.strict_transport_security || {};
    sts.enabled
      ? pass('HSTS', `max-age=${sts.max_age}${sts.include_subdomains ? ', includeSubDomains' : ''}`)
      : warn('HSTS', 'disabled — enable deliberately, and check subdomains first');
  } catch (err) {
    warn('HSTS', `could not read (${err.message})`);
  }
}

async function checkPagesProject(accountId, domain) {
  let projects;
  try {
    projects = await cf(`/accounts/${accountId}/pages/projects`);
  } catch (err) {
    warn('pages project', `could not read (${err.message})`);
    return;
  }

  const serving = projects.filter((p) => (p.domains || []).includes(domain));
  if (!serving.length) {
    warn('pages project', `no Pages project in this account serves ${domain}`);
    return;
  }
  for (const p of serving) {
    const src = p.source?.config || {};
    const auto = src.deployments_enabled;
    const detail =
      `${p.name} — ${src.owner || '?'}/${src.repo_name || '?'}@${src.production_branch || '?'}, ` +
      `auto-deploy ${auto ? 'on' : 'OFF'}`;
    auto
      ? pass('pages project', detail)
      : warn('pages project', `${detail} — deploys depend on someone running wrangler locally`);
  }
}

async function main() {
  const domain = process.argv[2];
  if (!domain || !token) {
    console.error('usage: CLOUDFLARE_API_TOKEN=… node scripts/pipeline/audit-client-zone.js <domain>');
    process.exit(2);
  }

  let zone;
  try {
    [zone] = await cf(`/zones?name=${encodeURIComponent(domain)}`);
  } catch (err) {
    console.error(`could not look up ${domain}: ${err.message}`);
    process.exit(2);
  }
  if (!zone) {
    console.error(`${domain} not found — is it in an account this token can see?`);
    process.exit(2);
  }

  console.log(`\n${domain}  ·  account: ${zone.account.name}\n`);

  const records = await checkDnsHygiene(zone.id, domain);
  await checkMailAuth(domain, records);
  await checkZoneSettings(zone.id);
  await checkPagesProject(zone.account.id, domain);

  for (const r of results) {
    console.log(`${r.level}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => r.level === 'FAIL').length;
  const warned = results.filter((r) => r.level === 'WARN').length;
  console.log(
    `\n${results.length - failed - warned}/${results.length - warned} checks passed` +
      (warned ? `, ${warned} advisory` : ''),
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
