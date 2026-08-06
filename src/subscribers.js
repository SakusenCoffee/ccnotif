import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from './config.js';
import { query } from './db.js';
import { parseTerms } from './match.js';
import { hashPassword, normalizeUsername, verifyPassword } from './auth.js';

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
 * Give an anonymous watcher a phone number without losing what they watch.
 *
 * Someone ticks a dozen products, then decides they want texts. The list they
 * built belongs to their anonymous row; the number may already belong to
 * another. Dropping either would silently discard work they can see on screen,
 * so the two are merged: watches move across, keeping whichever notify setting
 * was already deliberate, and the empty row is removed.
 */
export async function absorbAnonymous(anonymousId, targetId) {
  if (!anonymousId || anonymousId === targetId) return;

  await query(
    `insert into watches (subscriber_id, product_id, notify, created_at)
       select $2, w.product_id, w.notify, w.created_at
         from watches w
        where w.subscriber_id = $1
     on conflict (subscriber_id, product_id) do update
       set notify = watches.notify or excluded.notify`,
    [anonymousId, targetId],
  );

  // Only ever removes a row that never had a phone, so this cannot delete a
  // real account even if it is handed the wrong id.
  await query('delete from subscribers where id = $1 and phone is null', [anonymousId]);
}

/**
 * Issue a fresh verification code. Returns { code } when one was generated, or
 * { retryAfter } when the caller is still inside the resend cooldown.
 */
export async function startVerification(phone) {
  const subscriber = await findOrCreateSubscriber(phone);

  if (config.verification.resendCooldownSeconds > 0 && subscriber.code_sent_at) {
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

/**
 * Resolve a session, verified or not. Watching is open to anyone, so a session
 * has to mean "this browser" rather than "this confirmed phone number" — the
 * checks that actually matter (can we text this person?) are made where the
 * texting happens, not here.
 */
export async function subscriberBySession(sessionToken) {
  if (!sessionToken) return null;
  const { rows } = await query('select * from subscribers where session_token = $1', [
    sessionToken,
  ]);
  return rows[0] ?? null;
}

/** A watcher with no phone yet. Identified only by the session cookie. */
export async function createAnonymousSubscriber() {
  const { rows } = await query(
    `insert into subscribers (phone, feed_token, session_token)
       values (null, $1, $2)
     returning *`,
    [token(), token(32)],
  );
  return rows[0];
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
    // notify defaults off: watching something and wanting to be woken by it are
    // now separate choices, and the second one has to be asked for. `do
    // nothing` on conflict is what preserves a toggle already set.
    await query(
      `insert into watches (subscriber_id, product_id, notify)
         select $1, unnest($2::bigint[]), false
       on conflict do nothing`,
      [subscriberId, ids],
    );
  }

  return ids;
}

/** Which of a subscriber's watches are set to text them. */
export async function getWatchNotifyMap(subscriberId) {
  const { rows } = await query(
    'select product_id, notify from watches where subscriber_id = $1',
    [subscriberId],
  );
  return Object.fromEntries(rows.map((r) => [r.product_id, r.notify]));
}

/** Turn texting on or off for one watched product. */
export async function setWatchNotify(subscriberId, productId, notify) {
  const { rowCount } = await query(
    'update watches set notify = $3 where subscriber_id = $1 and product_id = $2',
    [subscriberId, productId, Boolean(notify)],
  );
  return rowCount > 0;
}

/**
 * Set (or clear) someone's standing alert. Stored as typed so it can be shown
 * back to them unchanged; the fuzzy expansion happens at match time.
 */
export async function setKeyword(subscriberId, keyword) {
  const raw = String(keyword ?? '').trim().slice(0, 200);
  // Terms that survive parsing are what will actually fire. Storing text that
  // matches nothing would leave someone believing an alert is set when it is
  // not, so an entry with no usable term clears the field instead.
  const value = raw && parseTerms(raw).length ? raw : null;

  const { rows } = await query(
    'update subscribers set keyword = $2 where id = $1 returning keyword',
    [subscriberId, value],
  );
  return { keyword: rows[0]?.keyword ?? null, terms: parseTerms(value ?? '') };
}

/**
 * Attach an account to whoever is here. An anonymous watcher registering keeps
 * the row and the list they already built, rather than starting again.
 */
export async function registerAccount(subscriber, rawUsername, rawPassword) {
  const username = normalizeUsername(rawUsername);
  if (!username) return { error: 'bad_username' };

  const { rows: taken } = await query(
    'select id from subscribers where lower(username) = $1',
    [username],
  );
  if (taken.length) return { error: 'username_taken' };

  const passwordHash = await hashPassword(rawPassword);
  const { rows } = await query(
    `update subscribers set username = $2, password_hash = $3
      where id = $1
      returning *`,
    [subscriber.id, username, passwordHash],
  );
  return { subscriber: rows[0] };
}

/**
 * Check a username and password. Both failures answer the same way: saying
 * which of the two was wrong tells someone guessing that a username exists.
 */
export async function authenticate(rawUsername, rawPassword) {
  const username = normalizeUsername(rawUsername);
  if (!username) return null;

  const { rows } = await query(
    'select * from subscribers where lower(username) = $1',
    [username],
  );
  const subscriber = rows[0];
  // Verify against a dummy hash when the account does not exist, so a missing
  // username does not answer measurably faster than a wrong password.
  const ok = await verifyPassword(
    rawPassword,
    subscriber?.password_hash ??
      'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==',
  );
  if (!subscriber || !ok) return null;

  const session = token(32);
  await query('update subscribers set session_token = $2, unsubscribed_at = null where id = $1', [
    subscriber.id,
    session,
  ]);
  return { subscriber, session };
}

/** Change a password, having first proved you know the current one. */
export async function changePassword(subscriber, currentPassword, newPassword) {
  if (!subscriber.password_hash) return { error: 'no_account' };
  if (!(await verifyPassword(currentPassword, subscriber.password_hash))) {
    return { error: 'wrong_password' };
  }

  const passwordHash = await hashPassword(newPassword);
  // A new session token as well: changing a password is how you lock out
  // somebody else who has yours, which does nothing if their session survives.
  const session = token(32);
  await query('update subscribers set password_hash = $2, session_token = $3 where id = $1', [
    subscriber.id,
    passwordHash,
    session,
  ]);
  return { session };
}

export async function unsubscribe(subscriberId) {
  await query(
    `update subscribers set unsubscribed_at = now(), session_token = null where id = $1`,
    [subscriberId],
  );
  await query('delete from watches where subscriber_id = $1', [subscriberId]);
  await query('delete from keyword_alerts where subscriber_id = $1', [subscriberId]);
}
