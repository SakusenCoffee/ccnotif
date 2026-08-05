// Run a single poll and exit. Useful for a Railway cron service, or for
// checking the diff logic by hand.
import { assertConfig } from './config.js';
import { migrate, pool } from './db.js';
import { runPoll } from './poller.js';

assertConfig();
await migrate();
await runPoll();
await pool.end();
