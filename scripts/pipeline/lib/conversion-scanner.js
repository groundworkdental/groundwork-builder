/**
 * Conversion Scanner — fetches the homepage HTML and looks for the analytics
 * + conversion-tracking signals Google Ads' Smart Bidding requires.
 *
 * Bronze's `bodyText` is rendered text only (no script content), so these
 * checks can't be derived from existing scrape data. One additional HTTP
 * request per audit; results scoped to the homepage only (the patterns we
 * check are sitewide via base layouts, so the homepage is representative).
 *
 * Export:
 *   runConversionScan(bronze) → Promise<{ findings, summary, meta }>
 */

import { enrichFindings } from './findings.js';

// Pattern detection — generous, false-negative-tolerant. We want to flag
// when these are clearly absent; a missed-detection on a quirky setup is
// preferable to false positives that confuse a real-world site.

// GA4: <script src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>
const GA4_SCRIPT_RE = /googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]+)/i;

// GA4 fallback: explicit gtag('config', 'G-XXXX') (older direct setups)
const GA4_CONFIG_RE = /gtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/i;

// GTM (Google Tag Manager) — used by many sites to load GA4 indirectly.
// If GTM is present, GA4 *may* be configured inside the container; we mark
// the GA4 finding as "likely-configured" rather than failing in that case.
const GTM_RE = /googletagmanager\.com\/(gtm\.js|ns\.html)\?id=(GTM-[A-Z0-9]+)/i;

// phone_click event — what we ship in BaseLayout. Looks for the literal
// event name (most reliable signal for our specific pattern) OR any tel:
// click handler that fires a gtag event.
const PHONE_CLICK_EVENT_RE = /['"]phone_click['"]/;
const TEL_CLICK_GTAG_RE = /tel:[^"'`]*[\s\S]{0,300}?gtag\s*\(/;

async function fetchHomepageHtml(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(baseUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Groundwork-Grader/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function buildFinding({ id, title, detail, benefit, present, severityWhenMissing = 'warning' }) {
  return {
    id,
    category: 'conversion',
    severity: present ? 'passed' : severityWhenMissing,
    title,
    detail,
    benefit,
    affectedPages: [],
    count: present ? 0 : 1,
  };
}

/**
 * @param {object} bronze - BronzeData from scraper
 * @returns {Promise<{ findings: object[], summary: object, meta: object }>}
 */
export async function runConversionScan(bronze) {
  const baseUrl = bronze?.baseUrl || '';
  if (!baseUrl) {
    return {
      findings: [],
      summary: { critical: 0, warnings: 0, passed: 0 },
      meta: { fetched: false, reason: 'no baseUrl' },
    };
  }

  const html = await fetchHomepageHtml(baseUrl);
  if (!html) {
    return {
      findings: [],
      summary: { critical: 0, warnings: 0, passed: 0 },
      meta: { fetched: false, reason: 'fetch failed or empty body' },
    };
  }

  // ── Detect ─────────────────────────────────────────────────────────────
  const ga4ScriptMatch = html.match(GA4_SCRIPT_RE);
  const ga4ConfigMatch = html.match(GA4_CONFIG_RE);
  const gtmMatch       = html.match(GTM_RE);
  const ga4IdRaw = ga4ScriptMatch?.[1] || ga4ConfigMatch?.[1] || null;

  /**
   * A measurement ID shaped like a scaffold placeholder is not a measurement
   * ID. Our own template shipped G-XXXXXXXXXX to a live site, this scanner
   * faithfully reported "GA4 script detected (G-XXXXXXXXXX)", and that line
   * went into a prospect's audit — telling them analytics was working when
   * nothing was being recorded.
   *
   * Treat it as misconfigured, which is what it is: the tag is installed and
   * sending to a property that does not exist. That is arguably worse than no
   * tag at all, because it looks done.
   */
  const isPlaceholderId = (id) => !!id && /^G-(X{4,}|0{4,}|1234)/i.test(id);
  const ga4Placeholder = isPlaceholderId(ga4IdRaw);
  const ga4Id = ga4Placeholder ? null : ga4IdRaw;

  // If GTM is present without a visible GA4 ID, the GA4 setup is likely
  // inside the GTM container — give the benefit of the doubt and pass.
  // A placeholder ID never earns that benefit.
  const hasGa4 = (!!ga4Id || !!gtmMatch) && !ga4Placeholder;

  const hasPhoneClick = PHONE_CLICK_EVENT_RE.test(html) || TEL_CLICK_GTAG_RE.test(html);

  // ── Build findings ─────────────────────────────────────────────────────
  const raw = [];

  raw.push(buildFinding({
    id: 'no-ga4-configured',
    title: 'GA4 measurement script',
    detail: ga4Placeholder
      ? `A GA4 tag is installed but its measurement ID is an unreplaced placeholder (${ga4IdRaw}), so nothing is being recorded.`
      : ga4Id
        ? `GA4 script detected (${ga4Id}).`
        : gtmMatch
          ? `GA4 likely configured via GTM container (${gtmMatch[2]}).`
          : 'No GA4 measurement script or GTM container detected on the homepage.',
    benefit: 'GA4 is the conversion data source Google Ads imports from. Without it, Smart Bidding has no signals to optimize against — every ad dollar is spent blind.',
    present: hasGa4,
    severityWhenMissing: 'critical',
  }));

  raw.push(buildFinding({
    id: 'no-phone-click-tracking',
    title: 'Phone click conversion event',
    detail: hasPhoneClick
      ? 'A tel: click → analytics event handler is wired on the site.'
      : 'No phone-click event tracker detected. Calls happen, but Google Ads sees no signal.',
    benefit: "Calls are the #1 conversion action for dental practices. Without a phone_click event in GA4, Smart Bidding can't prioritize keywords that drive calls — they look identical to keywords that drive nothing.",
    present: hasPhoneClick,
    severityWhenMissing: 'critical',
  }));

  const findings = enrichFindings(raw);
  const summary = {
    critical: findings.filter(f => f.severity === 'critical').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    passed:   findings.filter(f => f.severity === 'passed').length,
  };

  return {
    findings,
    summary,
    meta: {
      fetched: true,
      url: baseUrl,
      ga4Id,
      gtmContainerId: gtmMatch?.[2] || null,
      hasPhoneClick,
    },
  };
}
