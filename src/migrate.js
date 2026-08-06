import { assertConfig } from './config.js';
import { initDb, pool } from './db.js';

assertConfig();
const ok = await initDb({ retries: 3, delayMs: 2_000 });
await pool?.end();
if (!ok) process.exit(1);
