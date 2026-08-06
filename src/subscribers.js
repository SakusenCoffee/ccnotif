import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from './config.js';
import { query } from './db.js';

export function normalizePhone(raw) {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(String(raw).trim(), config.defaultCountry);
  if (!parsed?.isValid()) return null;
  // Landlines can't receive SMS; reject them here rather than burning a Twilio
  // send and failing opaquely.
  const type = parsed.getType();
  if (type === 'FIXED_LINE') return null;
  return parsed.number;
}

export function token(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function hashCode(phone, code) {
  return createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function findOrCreateSubscriber(phone) {
  const { rows } = await query(
    `insert into subscribers (phone, feed_token) values ($1, $2)
     on conflict (phone) do update set phone = excluded.phone
     returning *`,
    [phone, token()],
  );
  return rows[0];
}

/**
 * Issue a fresh verification code. Returns { code } when one was generated, or
 * { retryAfter } when the caller is still inside the resend cooldown.
 */
export async function startVerification(phone) {
  const subscriber = await findOrCreateSubscriber(phone);

  if (subscriber.code_sent_at) {
    const elapsed = (Date.now() - new Date(subscriber.code_sent_at).getTime()) / 1000;
    const remaining = Math.ceil(config.verification.resendCooldownSeconds - elapsed);
    if (remaining > 0) return { subscriber, retryAfter: remaining };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await query(
    `update subscribers
        set code_hash = $2,
            code_expires_at = now() + ($3 || ' minutes')::interval,
            code_attempts = 0,
            code_sent_at = now(),
            unsubscribed_at = null
      where id = $1`,
    [subscriber.id, hashCode(phone, code), String(config.verification.codeTtlMinutes)],
  );

  return { subscriber, code };
}

/**
 * Undo the resend cooldown after a send that never reached the carrier. The
 * cooldown exists to stop repeat requests for a code that is already in flight;
 * when the send failed there is no such code, and making someone wait a minute
 * between attempts while they fix a Twilio setting is just obstructive.
 */
export async function clearVerificationCooldown(phone) {
  await query(
    'update subscribers set code_sent_at = null, code_hash = null, code_expires_at = null where phone = $1',
    [phone],
  );
}

export async function checkVerification(phone, code) {
  const { rows } = await query('select * from subscribers where phone = $1', [phone]);
  const subscriber = rows[0];
  if (!subscriber?.code_hash) return { error: 'no_code' };

  if (new Date(subscriber.code_expires_at) < new Date()) return { error: 'expired' };
  if (subscriber.code_attempts >= config.verification.maxAttempts) return { error: 'too_many' };

  if (!safeEqual(hashCode(phone, String(code).trim()), subscriber.code_hash)) {
    await query('update subscribers set code_attempts = code_attempts + 1 where id = $1', [
      subscriber.id,
    ]);
    const left = config.verification.maxAttempts - subscriber.code_attempts - 1;
    return { error: 'mismatch', attemptsLeft: Math.max(0, left) };
  }

  const session = token(32);
  const { rows: updated } = await query(
    `update subscribers
        set verified = true, session_token = $2, code_hash = null,
            code_expires_at = null, code_attempts = 0
      where id = $1
      returning *`,
    [subscriber.id, session],
  );

  return { subscriber: updated[0], session };
}

export async function subscriberBySession(sessionToken) {
  if (!sessionToken) return null;
  const { rows } = await query(
    'select * from subscribers where session_token = $1 and verified',
    [sessionToken],
  );
  return rows[0] ?? null;
}

export async function subscriberByFeedToken(feedToken) {
  if (!feedToken) return null;
  const { rows } = await query('select * from subscribers where feed_token = $1', [feedToken]);
  return rows[0] ?? null;
}

export async function getWatchedProductIds(subscriberId) {
  const { rows } = await query('select product_id from watches where subscriber_id = $1', [
    subscriberId,
  ]);
  return rows.map((r) => r.product_id);
}

/** Replace a subscriber's watchlist with exactly `productIds`. */
export async function setWatches(subscriberId, productIds) {
  const unique = [...new Set(productIds.map(Number).filter(Number.isFinite))].slice(
    0,
    config.maxWatchesPerSubscriber,
  );

  // Ignore ids that aren't products we actually track.
  const { rows: valid } = await query('select id from products where id = any($1::bigint[])', [
    unique,
  ]);
  const ids = valid.map((r) => r.id);

  await query('delete from watches where subscriber_id = $1 and not (product_id = any($2::bigint[]))', [
    subscriberId,
    ids,
  ]);

  if (ids.length) {
    await query(
      `insert into watches (subscriber_id, product_id)
         select $1, unnest($2::bigint[])
       on conflict do nothing`,
      [subscriberId, ids],
    );
  }

  return ids;
}

export async function unsubscribe(subscriberId) {
  await query(
    `update subscribers set unsubscribed_at = now(), session_token = null where id = $1`,
    [subscriberId],
  );
  await query('delete from watches where subscriber_id = $1', [subscriberId]);
}
