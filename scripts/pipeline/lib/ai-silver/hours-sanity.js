/**
 * Hours sanity — fix obvious CMS am/pm typos when possible; only drop when
 * no plausible correction exists. Does not invent missing days.
 *
 * Common site bugs this recovers:
 *   "10:00 pm - 6:00 pm"  →  "10:00 am - 6:00 pm"  (morning open labeled pm)
 *   "12:00 am - 6:00 pm"  →  "12:00 pm - 6:00 pm"  (noon open labeled am)
 */

function toMinutes(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (h === 12) h = 0;
  if (ap === 'pm') h += 12;
  return h * 60 + min;
}

function flipAmPm(timeStr) {
  return String(timeStr || '').replace(/\b(am|pm)\b/i, (ap) =>
    ap.toLowerCase() === 'am' ? 'pm' : 'am',
  );
}

/**
 * @param {string} range e.g. "10:00 am - 6:00 pm"
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isPlausibleHourRange(range) {
  if (!range || /closed/i.test(range)) return { ok: true };
  const parts = String(range).split(/\s*[–—-]\s*/);
  if (parts.length !== 2) return { ok: false, reason: 'unparseable' };
  const start = toMinutes(parts[0]);
  const end = toMinutes(parts[1]);
  if (start == null || end == null) return { ok: false, reason: 'unparseable' };
  // Midnight / near-midnight opens are almost never real for dental offices
  if (start < 60) return { ok: false, reason: 'midnight_open' };
  // Same-calendar-day range should end after start (no overnight dental hours in footer scrapes)
  if (end <= start) return { ok: false, reason: 'end_before_start' };
  // Unrealistically long (>14h) or tiny (<60m)
  const dur = end - start;
  if (dur < 60 || dur > 14 * 60) return { ok: false, reason: 'duration' };
  // Opens after 8pm are almost certainly am/pm typos for dental practices
  if (start >= 20 * 60) return { ok: false, reason: 'late_night_open' };
  return { ok: true };
}

/**
 * Try flipping am/pm on start and/or end to recover an obvious CMS typo.
 * Prefers flipping the start (the usual bug: "10:00 pm - 6:00 pm").
 * @returns {{ time: string, fix: string } | null}
 */
export function correctHourRange(range) {
  if (!range || /closed/i.test(range)) return null;
  const parts = String(range).split(/\s*[–—-]\s*/);
  if (parts.length !== 2) return null;
  const [startRaw, endRaw] = parts.map((p) => p.trim());
  if (!startRaw || !endRaw) return null;

  const candidates = [
    { time: `${flipAmPm(startRaw)} - ${endRaw}`, fix: 'flipped_start_ampm' },
    { time: `${startRaw} - ${flipAmPm(endRaw)}`, fix: 'flipped_end_ampm' },
    { time: `${flipAmPm(startRaw)} - ${flipAmPm(endRaw)}`, fix: 'flipped_both_ampm' },
  ];

  for (const c of candidates) {
    if (isPlausibleHourRange(c.time).ok) return c;
  }
  return null;
}

/**
 * Sanitize silver.hours in place. Corrects am/pm typos when possible.
 * Returns { kept, corrected, rejected }.
 */
export function sanitizeHours(hours) {
  if (!hours || typeof hours !== 'object') {
    return { kept: 0, corrected: [], rejected: [], hours: null };
  }

  const rejected = [];
  const corrected = [];
  let kept = 0;

  const resolve = (day, time) => {
    const check = isPlausibleHourRange(time);
    if (check.ok) return { time, status: 'ok' };
    const fix = correctHourRange(time);
    if (fix) {
      corrected.push({ day, from: time, to: fix.time, fix: fix.fix });
      return { time: fix.time, status: 'corrected' };
    }
    rejected.push({ day, time, reason: check.reason });
    return { time: null, status: 'rejected', reason: check.reason };
  };

  if (Array.isArray(hours.display)) {
    const next = [];
    for (const row of hours.display) {
      const r = resolve(row?.day, row?.time);
      if (r.time != null) {
        next.push({ ...row, time: r.time });
        kept++;
      }
    }
    hours.display = next;

    // Keep byDay in sync from corrected display (avoid double-correcting)
    if (hours.byDay && typeof hours.byDay === 'object') {
      const key = (d) => String(d || '').slice(0, 3).toLowerCase();
      for (const k of Object.keys(hours.byDay)) hours.byDay[k] = null;
      for (const row of next) {
        const k = key(row.day);
        if (k in hours.byDay) hours.byDay[k] = row.time;
      }
    }
  } else if (hours.byDay && typeof hours.byDay === 'object') {
    for (const [day, time] of Object.entries(hours.byDay)) {
      if (time == null) continue;
      const r = resolve(day, time);
      hours.byDay[day] = r.time;
      if (r.time != null) kept++;
    }
  }

  if (corrected.length) {
    const note = `hours_ampm_corrected:${corrected.map((c) => `${c.day}(${c.fix})`).join(',')}`;
    hours.notes = [hours.notes, note].filter(Boolean).join('; ');
  }

  if (rejected.length) {
    hours.notes = [hours.notes, 'hours_rows_rejected_implausible'].filter(Boolean).join('; ');
  }

  // Rebuild raw from the cleaned display when we touched anything
  if ((corrected.length || rejected.length) && Array.isArray(hours.display) && hours.display.length) {
    hours.raw = hours.display.map((r) => `${r.day} ${r.time}`).join(' / ');
  }

  return { kept, corrected, rejected, hours };
}
