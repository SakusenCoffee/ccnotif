import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Username and password handling.
 *
 * scrypt rather than a plain hash, and rather than a new dependency: it is in
 * Node's standard library, it is memory-hard, and it is what makes a stolen
 * `subscribers` table useless on its own. A SHA of a password is not storage,
 * it is a slightly inconvenient plaintext.
 *
 * Nothing here ever holds a password beyond the call that verifies it, and the
 * hash format records its own parameters so the cost can be raised later
 * without invalidating everyone's existing password.
 */

const scryptAsync = promisify(scrypt);

// Node's defaults, named explicitly so a stored hash stays readable when they
// change. N=16384 is roughly 16MB and a few tens of milliseconds per attempt —
// slow enough to make guessing expensive, fast enough to log in with.
const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

export const USERNAME_RULES =
  'Usernames are 3 to 32 characters: letters, numbers, dots, dashes and underscores.';
export const PASSWORD_RULES = 'Passwords must be at least 8 characters.';

/**
 * Canonical form of a username. Case and surrounding space are not meaningful —
 * someone who registers "Jack" must not be locked out by typing "jack".
 */
export function normalizeUsername(raw) {
  const trimmed = String(raw ?? '').trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(trimmed) ? trimmed : null;
}

export function passwordProblem(raw) {
  const password = String(raw ?? '');
  if (password.length < 8) return PASSWORD_RULES;
  // Long inputs are a cheap denial of service against a deliberately slow KDF.
  if (password.length > 200) return 'That password is too long.';
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, PARAMS.keylen, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Check a password against a stored hash. Returns false rather than throwing on
 * anything malformed, so a corrupt row is a failed login and not a 500.
 */
export async function verifyPassword(password, stored) {
  if (!stored) return false;

  const [scheme, N, r, p, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;

  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Object.values(params).every((v) => Number.isInteger(v) && v > 0)) return false;

  let expectedBuf;
  let saltBuf;
  try {
    expectedBuf = Buffer.from(expected, 'base64');
    saltBuf = Buffer.from(salt, 'base64');
  } catch {
    return false;
  }
  if (!expectedBuf.length || !saltBuf.length) return false;

  let derived;
  try {
    derived = await scryptAsync(password, saltBuf, expectedBuf.length, params);
  } catch {
    return false;
  }

  // Constant time: a comparison that returns early leaks how much of the hash
  // matched, one byte at a time.
  return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf);
}
