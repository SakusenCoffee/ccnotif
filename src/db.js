import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

// Row ids are bigserial and stay well inside Number.MAX_SAFE_INTEGER, so parse
// int8 as a number rather than the string node-postgres defaults to — the API
// and the client both treat them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

/**
 * Whether to negotiate TLS for this connection string.
 *
 * Railway's managed Postgres is reached over the private network as
 * `postgres.railway.internal`, which does NOT speak TLS — forcing SSL there
 * fails with "The server does not support SSL connections". Its public proxy
 * host does. So decide per host rather than always enabling it.
 */
export function sslConfigFor(connectionString) {
  if (!connectionString) return false;

  const explicit = (process.env.DATABASE_SSL || '').toLowerCase();
  if (explicit === 'true' || explicit === 'require') return { rejectUnauthorized: false };
  if (explicit === 'false' || explicit === 'disable') return false;

  let host = '';
  let sslmode = '';
  try {
    const url = new URL(connectionString);
    host = url.hostname;
    sslmode = (url.searchParams.get('sslmode') || '').toLowerCase();
  } catch {
    return { rejectUnauthorized: false };
  }

  if (sslmode === 'disable') return false;
  if (sslmode && sslmode !== 'disable') return { rejectUnauthorized: false };

  // Private/loopback networks terminate no TLS.
  if (
    host.endsWith('.railway.internal') ||
    host.endsWith('.internal') ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local')
  ) {
    return false;
  }

  // Anything reached over the public internet should be encrypted. Managed
  // providers commonly present certs the default CA bundle won't validate.
  return { rejectUnauthorized: false };
}

export const dbState = {
  ready: false,
  error: config.databaseUrl ? null : 'DATABASE_URL is not set.',
  attempts: 0,
};

export const pool = config.databaseUrl
  ? new pg.Pool({
      connectionString: config.databaseUrl,
      max: 8,
      connectionTimeoutMillis: 10_000,
      ssl: sslConfigFor(config.databaseUrl),
    })
  : null;

pool?.on('error', (err) => {
  console.error('[db] idle client error', err.message);
  dbState.ready = false;
  dbState.error = err.message;
});

class DatabaseUnavailable extends Error {
  constructor(reason) {
    super(reason ?? 'The database is not configured.');
    this.name = 'DatabaseUnavailable';
    this.code = 'db_unavailable';
  }
}

export function query(text, params) {
  if (!pool) throw new DatabaseUnavailable(dbState.error);
  return pool.query(text, params);
}

export async function transaction(fn) {
  if (!pool) throw new DatabaseUnavailable(dbState.error);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate() {
  if (!pool) throw new DatabaseUnavailable(dbState.error);
  const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
  const sql = await readFile(schemaPath, 'utf8');
  await pool.query(sql);
}

/**
 * Connect and apply the schema, retrying in the background. A fresh Railway
 * deploy can start before its Postgres accepts connections, and the app must
 * not die in that window — it stays up, reports the problem on /healthz, and
 * starts working as soon as the database appears.
 */
export async function initDb({ retries = Infinity, delayMs = 5_000, onReady } = {}) {
  if (!config.databaseUrl) {
    console.error(
      '[db] DATABASE_URL is not set. On Railway, add a variable to THIS service ' +
        'referencing the database, e.g. DATABASE_URL=${{Postgres.DATABASE_URL}}.',
    );
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    dbState.attempts = attempt;
    try {
      await migrate();
      dbState.ready = true;
      dbState.error = null;
      console.log(`[db] connected, schema is up to date (attempt ${attempt})`);
      await onReady?.();
      return true;
    } catch (err) {
      dbState.ready = false;
      dbState.error = err.message;
      console.error(`[db] not ready (attempt ${attempt}): ${err.message}`);
      if (attempt >= retries) return false;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}
