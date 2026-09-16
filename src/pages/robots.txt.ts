import type { APIRoute } from 'astro';

/**
 * robots.txt is generated, not shipped as a static file.
 *
 * The static `public/robots.txt` this replaces carried a scaffold
 * placeholder (`https://example.com/sitemap-index.xml`). It reached
 * production on at least one client site, pointing Google's crawler at a
 * domain we don't own and blocking sitemap submission until someone
 * noticed. A generated file cannot drift from `site` in astro.config.mjs
 * because it reads the same value.
 *
 * Disallowed paths are conversion endpoints and private landing pages:
 * useful to patients arriving from a link, worthless in an index, and a
 * thin-content signal if crawled.
 */
const DISALLOW = ['/thank-you/', '/referral/'];

export const GET: APIRoute = ({ site }) => {
  if (!site) {
    throw new Error(
      "robots.txt needs `site` set in astro.config.mjs — without it the " +
        'Sitemap line cannot be absolute, which is the one thing it must be.',
    );
  }

  const origin = site.href.replace(/\/$/, '');
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    ...DISALLOW.map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${origin}/sitemap-index.xml`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
