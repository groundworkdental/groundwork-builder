/**
 * client_events — one timeline per practice, whatever the source.
 *
 * Everything else in D1 records what the pipeline did. This records what
 * happened: an email, a manual fix, a decision on a call, a gate failing, a
 * launch step. Agents and people write to the same table, so neither has to
 * rediscover what the other already knows.
 *
 * The triage fields are the reason this exists rather than a log file.
 * `client-change-workflow.md` already asks the right question — "would this
 * defect exist on the next site we build?" — but asking is optional, so it
 * gets skipped once the client's problem is solved. Here a change with
 * systemic = null is an open item you can list.
 */

import { randomUUID } from 'node:crypto';
import { d1Query, d1Enabled } from './d1.js';

export const EVENT_KINDS = [
  'communication',  // email, call, text — anything said to or from the client
  'change',         // something altered on the client site
  'decision',       // a choice made, with its reasoning
  'run',            // a pipeline run
  'gate',           // a gate result worth remembering
  'launch',         // a go-live step
  'note',           // an observation that is not yet any of the above
];

const TRIAGE = ['yes', 'no'];

/**
 * Append an event. Returns the id.
 *
 * A `change` may be logged untriaged — you often do not know yet — but it
 * stays on the open list until `systemic` is set, and if that is 'yes' it
 * stays until `routed_to` points at where the general fix lives.
 */
export async function logEvent({
  slug,
  kind,
  summary,
  actor = process.env.GROUNDWORK_OPERATOR || 'operator',
  detail = null,
  direction = null,
  sourceRef = null,
  systemic = null,
  routedTo = null,
  occurredAt = null,
} = {}) {
  if (!slug) throw new Error('logEvent: slug is required');
  if (!kind) throw new Error('logEvent: kind is required');
  if (!EVENT_KINDS.includes(kind)) {
    throw new Error(`logEvent: unknown kind "${kind}" — one of ${EVENT_KINDS.join(', ')}`);
  }
  if (!summary) throw new Error('logEvent: summary is required');
  if (systemic !== null && !TRIAGE.includes(systemic)) {
    throw new Error(`logEvent: systemic must be yes or no, got "${systemic}"`);
  }
  if (routedTo && systemic !== 'yes') {
    throw new Error('logEvent: routed_to only means something when systemic is yes');
  }
  if (direction && !['in', 'out'].includes(direction)) {
    throw new Error(`logEvent: direction must be in or out, got "${direction}"`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  await d1Query(
    `INSERT INTO client_events
       (id, slug, occurred_at, kind, direction, actor, summary, detail, source_ref, systemic, routed_to, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, slug, occurredAt || now, kind, direction, actor, summary, detail, sourceRef, systemic, routedTo, now],
  );
  return id;
}

/** Full history for one practice, oldest first. */
export async function timeline(slug, { limit = 200 } = {}) {
  return d1Query(
    `SELECT * FROM client_events WHERE slug = ? ORDER BY occurred_at ASC LIMIT ?`,
    [slug, limit],
  );
}

/**
 * The follow-through list.
 *
 * untriaged — a change nobody has answered the triage question for.
 * unrouted  — answered 'yes', but the generalisable fix has no home.
 */
export async function openTriage({ slug = null } = {}) {
  const where = slug ? 'AND slug = ?' : '';
  const params = slug ? [slug] : [];
  // Proposals are decisions, not changes, and were missing from this query —
  // so a router proposal showed on the dashboard queue and not in `log open`.
  // Two surfaces disagreeing about what needs a human is the one thing this
  // ledger exists to prevent.
  const untriaged = await d1Query(
    `SELECT * FROM client_events
      WHERE ((kind = 'change' AND systemic IS NULL)
          OR (kind = 'decision' AND summary LIKE 'PROPOSAL:%'
              AND (routed_to IS NULL OR routed_to = '')))
        ${where}
      ORDER BY occurred_at ASC`,
    params,
  );
  const unrouted = await d1Query(
    `SELECT * FROM client_events
      WHERE kind = 'change' AND systemic = 'yes'
        AND (routed_to IS NULL OR routed_to = '') ${where}
      ORDER BY occurred_at ASC`,
    params,
  );
  return { untriaged, unrouted };
}

/**
 * Close the triage on an event. This is the one mutation the table allows:
 * the answer to "would this happen on the next site?" arrives later than the
 * event itself, and a row that cannot record it would push the answer back
 * into somebody's memory.
 */
export async function triage(id, { systemic, routedTo = null } = {}) {
  if (!TRIAGE.includes(systemic)) {
    throw new Error(`triage: systemic must be yes or no, got "${systemic}"`);
  }
  if (systemic === 'yes' && !routedTo) {
    throw new Error('triage: a systemic change needs routed_to — a PR, gate or rule');
  }
  // Accept the short id the listings print. Ambiguity is vanishingly unlikely
  // at this scale, but resolving it explicitly beats updating the wrong row.
  const matches = await d1Query(
    `SELECT id FROM client_events WHERE id = ? OR id LIKE ?`,
    [id, `${id}%`],
  );
  if (!matches.length) throw new Error(`triage: no event matching "${id}"`);
  if (matches.length > 1) {
    throw new Error(`triage: "${id}" matches ${matches.length} events — use more characters`);
  }
  await d1Query(
    `UPDATE client_events SET systemic = ?, routed_to = ? WHERE id = ?`,
    [systemic, routedTo, matches[0].id],
  );
  return matches[0].id;
}

export { d1Enabled };
