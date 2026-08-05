import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

// Shopify product ids exceed 2^31 but stay well inside Number.MAX_SAFE_INTEGER,
// so parse int8 as a number rather than the string node-postgres defaults to.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 8,
  // Railway's managed Postgres presents a certificate the default CA bundle
  // won't validate. The connection is still encrypted.
  ssl: /\bsslmode=disable\b/.test(config.databaseUrl ?? '')
    ? false
    : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function transaction(fn) {
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
  const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
  const sql = await readFile(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('[db] schema is up to date');
}
