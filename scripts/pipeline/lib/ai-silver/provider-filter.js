/**
 * Provider quality gates — silver judgment on bronze-extracted doctor lists.
 * Drops first-name-only / bio-less marketing mentions and soft-dup sources.
 */

const DEDICATED_BIO_PATH = /\/(meet[-_]?dr[-_]|dr[-_][a-z]|doctors?\/)/i;

function hasFullName(doctor) {
  const last = String(doctor.lastName || '').trim();
  const first = String(doctor.firstName || '').trim();
  const name = String(doctor.name || '').trim();
  const parts = name.replace(/^dra?\.?\s+/i, '').split(/\s+/).filter(Boolean);

  // "Dr. Zach" / "Dra. Sara" style — single token with no dedicated evidence → reject
  if (parts.length === 1) {
    return hasDedicatedPage(doctor) || hasSubstantialBio(doctor);
  }
  if (last.length >= 2 && first.length >= 1) return true;
  return parts.length >= 2 && parts[parts.length - 1].length >= 2;
}

function hasSubstantialBio(doctor) {
  return String(doctor.bio || '').trim().length >= 80;
}

function hasDedicatedPage(doctor) {
  return DEDICATED_BIO_PATH.test(String(doctor.sourcePath || ''));
}

/**
 * @param {object[]} doctors
 * @param {object} bronze
 * @returns {{ doctors: object[], dropped: object[] }}
 */
export function filterDoctors(doctors, bronze = {}) {
  const softDupPaths = new Set((bronze.softDups || []).map((s) => s.path));
  // Also treat paths whose body fingerprint matched home as soft if still present in pages
  const dropped = [];
  const kept = [];

  for (const d of doctors || []) {
    const reasons = [];
    if (softDupPaths.has(d.sourcePath)) reasons.push('soft_dup_source');
    if (!hasFullName(d)) reasons.push('incomplete_name');
    const bioOk = hasSubstantialBio(d);
    const pageOk = hasDedicatedPage(d);
    if (!bioOk && !pageOk) reasons.push('no_bio_or_dedicated_page');
    // Dedicated path but empty bio AND path looks like meet-dr-X that was soft-dup of home:
    // already covered by soft_dup_source when path listed.
    // Marketing-only: first name on Spanish page → incomplete_name

    if (reasons.length) {
      dropped.push({ name: d.name, sourcePath: d.sourcePath, reasons });
      continue;
    }
    kept.push(d);
  }

  // Re-rank
  kept.forEach((d, i) => { d.rank = i + 1; });
  return { doctors: kept, dropped };
}
