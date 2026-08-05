import { assertConfig } from './config.js';
import { migrate, pool } from './db.js';

assertConfig();
await migrate();
await pool.end();
