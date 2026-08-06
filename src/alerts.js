import { query } from './db.js';
import { compileAlert, fold, parseTerms } from './match.js';

/**
 * Standing alerts: terms someone wants to hear about, one per row.
 *
 * Each carries two independent switches. `notify` sends a push or a text.
 * `autobuy` offers the match to the buyer userscript, which opens the product
 * and drives checkout. They are separate because the useful combinations
 * genuinely differ: a broad term like "pokemon" is worth being told about but
 * not worth arming a buyer for, while an exact set code like "OP-17" is the
 * opposite — you know you want it, and the seconds matter more than the text.
 */

const MAX_ALERTS = 40;

export async function listAlerts(subscriberId) {
  const { rows } = await query(
    `select id, term, notify, autobuy, created_at
       from alerts where subscriber_id = $1
      order by lower(term)`,
    [subscriberId],
  );
  return rows;
}

/**
 * Add one term. Deliberately one at a time: a comma-separated field could not
 * say which of its terms should buy and which should only tell you, and a term
 * you can no longer see individually is a term you cannot switch off.
 */
export async function addAlert(subscriberId, rawTerm, { notify = true, autobuy = false } = {}) {
  // parseTerms folds accents, lowercases and trims. Taking only the first means
  // pasting "one piece, gundam" adds one alert rather than silently splitting
  // into two with settings the caller never chose.
  const [term] = parseTerms(rawTerm);
  if (!term) return { error: 'empty' };

  // A term that compiles to nothing would sit in the list matching nothing.
  if (!compileAlert(term)) return { error: 'unusable' };

  const { rows: existing } = await query(
    'select id from alerts where subscriber_id = $1 and lower(term) = $2',
    [subscriberId, fold(term)],
  );
  if (existing.length) return { error: 'duplicate' };

  const { rows: count } = await query(
    'select count(*)::int as n from alerts where subscriber_id = $1',
    [subscriberId],
  );
  if (count[0].n >= MAX_ALERTS) return { error: 'too_many', max: MAX_ALERTS };

  const { rows } = await query(
    `insert into alerts (subscriber_id, term, notify, autobuy)
       values ($1,$2,$3,$4)
     returning id, term, notify, autobuy, created_at`,
    [subscriberId, term, Boolean(notify), Boolean(autobuy)],
  );
  return { alert: rows[0] };
}

/** Flip one of the two switches. Only the fields given are touched. */
export async function updateAlert(subscriberId, id, { notify, autobuy }) {
  const { rows } = await query(
    `update alerts
        set notify  = coalesce($3, notify),
            autobuy = coalesce($4, autobuy)
      where subscriber_id = $1 and id = $2
      returning id, term, notify, autobuy, created_at`,
    [
      subscriberId,
      id,
      typeof notify === 'boolean' ? notify : null,
      typeof autobuy === 'boolean' ? autobuy : null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteAlert(subscriberId, id) {
  const { rowCount } = await query('delete from alerts where subscriber_id = $1 and id = $2', [
    subscriberId,
    id,
  ]);
  return rowCount > 0;
}

/**
 * Everyone with at least one alert, with their terms compiled ready to test.
 *
 * A poll compares every event against every alert, so the regexes are built
 * once per poll here rather than once per comparison.
 */
export async function compiledAlertsBySubscriber() {
  const { rows } = await query(
    `select a.subscriber_id, a.id, a.term, a.notify, a.autobuy,
            s.phone, s.verified, s.feed_token, s.ntfy_topic, s.ntfy_enabled
       from alerts a
       join subscribers s on s.id = a.subscriber_id
      where s.unsubscribed_at is null
        and (a.notify or a.autobuy)`,
  );

  const bySubscriber = new Map();
  for (const row of rows) {
    let entry = bySubscriber.get(row.subscriber_id);
    if (!entry) {
      entry = {
        subscriber: {
          id: row.subscriber_id,
          phone: row.phone,
          verified: row.verified,
          feed_token: row.feed_token,
          ntfy_topic: row.ntfy_topic,
          ntfy_enabled: row.ntfy_enabled,
        },
        alerts: [],
      };
      bySubscriber.set(row.subscriber_id, entry);
    }
    entry.alerts.push({
      id: row.id,
      term: row.term,
      notify: row.notify,
      autobuy: row.autobuy,
      matcher: compileAlert(row.term),
    });
  }
  return [...bySubscriber.values()];
}

/** The alerts of one person that a given title matches. */
export function matchingAlerts(alerts, title) {
  return alerts.filter((a) => a.matcher?.test(title));
}
