// Run a single poll of every site and exit. Useful for a Railway cron service,
// or for checking the diff logic by hand.
import { assertConfig } from './config.js';
import { initDb, pool } from './db.js';
import { runPoll } from './poller.js';

assertConfig();
const ok = await initDb({ retries: 3, delayMs: 2_000 });
if (!ok) {
  await pool?.end();
  process.exit(1);
}
await runPoll();
await pool.end();
