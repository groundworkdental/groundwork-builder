/**
 * Pass: providers — doctors and non-doctor staff, unified, no "primary"
 * distinction. Captures verbatim bios/education/certifications/status notes.
 */

import { loadPrompt, fillTemplate, runPassCall, renderPagesAsContext, pagesMatching, MODELS } from '../shared.js';

export const name = 'providers';

const PATTERNS = [
  /\/(meet[-_]?(our[-_]?)?)?(team|staff|providers|doctors)/i,
  /\/(meet[-_]?)?dr[-_]/i,
  /\/(meet[-_]?)?doctor/i,
  /\/about[-_]?(us|the[-_]?(doctor|team))?/i,
  /\/bio/i,
];

export function selectPages(bronze) {
  const softDupPaths = new Set((bronze.softDups || []).map((s) => s.path));
  const matched = pagesMatching(bronze.pages, PATTERNS).filter((p) => !softDupPaths.has(p.path));
  const home = bronze.pages.find(p => p.path === '/' || p.path === '');
  const set = new Set(matched);
  if (home) set.add(home);
  // Also include any page whose body text mentions "Dr." multiple times — likely a provider page
  for (const p of bronze.pages) {
    if (set.has(p) || softDupPaths.has(p.path)) continue;
    const drCount = (p.bodyText || '').match(/\bDr\.\s+[A-Z]/g)?.length || 0;
    if (drCount >= 3) set.add(p);
  }
  return Array.from(set);
}

export async function run({ bronze, pages }) {
  if (pages.length === 0) return { doctors: [], staff: [] };

  // Collect ALL Person/Dentist JSON-LD across the site
  const personLd = [];
  for (const p of bronze.pages) {
    for (const item of (p.structuredData || [])) {
      const t = item['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.some(x => /Person|Dentist|Physician/i.test(String(x)))) {
        personLd.push({ ...item, _sourcePath: p.path });
      }
    }
  }

  // Provider photo candidates: any image whose alt OR src references a name/title
  const photoCandidates = [];
  for (const p of bronze.pages) {
    for (const img of (p.images || [])) {
      const altLower = (img.alt || '').toLowerCase();
      const srcLower = (img.src || '').toLowerCase();
      const looksLikePerson =
        /dr\.?\s|doctor|dentist|orthodont/i.test(altLower) ||
        /\/dr[-_]/i.test(srcLower) ||
        /\/img[-_]?dr/i.test(srcLower) ||
        /headshot|portrait/i.test(altLower + srcLower) ||
        /staff member:/i.test(altLower);
      if (looksLikePerson) photoCandidates.push({ src: img.src, alt: img.alt, page: p.path });
    }
  }

  const tmpl = await loadPrompt('providers');
  const prompt = fillTemplate(tmpl, {
    baseUrl: bronze.baseUrl,
    pageContext: renderPagesAsContext(pages, { bodyChars: 12000, paragraphs: 40, images: 50 }),
    personLdJson: JSON.stringify(personLd, null, 2),
    photoCandidates: JSON.stringify(photoCandidates.slice(0, 80), null, 2),
  });

  const { slice } = await runPassCall({
    name, model: MODELS.default, prompt, maxTokens: 16000,
  });
  // Programmatic gate (silver judgment) — do not trust marketing name-drops
  const { filterDoctors } = await import('../provider-filter.js');
  const { doctors, dropped } = filterDoctors(slice.doctors || [], bronze);
  if (dropped.length) {
    console.log(`[ai-silver:providers] filtered ${dropped.length} weak doctor(s): ${dropped.map(d => d.name).join(', ')}`);
  }
  slice.doctors = doctors;
  return slice;
}
