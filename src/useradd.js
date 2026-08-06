import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { assertConfig } from './config.js';
import { initDb, pool, query } from './db.js';
import { hashPassword, normalizeUsername, passwordProblem, USERNAME_RULES } from './auth.js';
import { token } from './subscribers.js';

/**
 * Create and manage logins from the command line.
 *
 * There is no sign-up page: accounts exist because an administrator made them.
 * That makes this the only way in, so it lives in the repo rather than as a
 * one-off SQL snippet someone has to reconstruct at an awkward moment.
 *
 *   npm run useradd <username> [password]
 *   npm run useradd -- --list
 *   npm run useradd -- --passwd <username> [password]
 *   npm run useradd -- --delete <username>
 *
 * Omit the password and one is generated and printed. It is printed exactly
 * once, here, and stored only as an scrypt hash — nothing can recover it later,
 * which is the point.
 */

function generatePassword() {
  // Unambiguous characters only: this gets read off a screen and typed by hand,
  // and 0/O and 1/l/I are how that goes wrong.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(
    { length: 16 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join('');
}

async function confirm(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function list() {
  const { rows } = await query(
    `select username, phone, created_at,
            (select count(*)::int from watches w where w.subscriber_id = s.id) as watches
       from subscribers s
      where username is not null
      order by username`,
  );

  if (!rows.length) {
    console.log('No accounts yet. Create one:  npm run useradd <username>');
    return;
  }

  console.log(`${rows.length} account${rows.length === 1 ? '' : 's'}:\n`);
  for (const row of rows) {
    const created = new Date(row.created_at).toISOString().slice(0, 10);
    console.log(
      `  ${row.username.padEnd(20)} ${String(row.watches).padStart(4)} watched` +
        `  ${row.phone ? row.phone.padEnd(16) : 'no phone'.padEnd(16)} since ${created}`,
    );
  }
}

async function create(rawUsername, rawPassword) {
  const username = normalizeUsername(rawUsername);
  if (!username) throw new Error(USERNAME_RULES);

  const password = rawPassword ?? generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const { rows: taken } = await query('select id from subscribers where lower(username) = $1', [
    username,
  ]);
  if (taken.length) throw new Error(`"${username}" already exists.`);

  await query(
    `insert into subscribers (username, password_hash, feed_token, phone)
       values ($1, $2, $3, null)`,
    [username, await hashPassword(password), token()],
  );

  console.log(`\nCreated "${username}".`);
  console.log(`Password: ${password}`);
  console.log('\nThis is the only time it is shown — only a hash is stored.');
  console.log('They can change it under Account once signed in.\n');
}

async function passwd(rawUsername, rawPassword) {
  const username = normalizeUsername(rawUsername);
  if (!username) throw new Error(USERNAME_RULES);

  const password = rawPassword ?? generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  // Rotating the session token too, so a password reset actually ends whatever
  // session prompted it. Resetting a password while the other party stays
  // signed in achieves nothing.
  const { rowCount } = await query(
    `update subscribers set password_hash = $2, session_token = null
      where lower(username) = $1`,
    [username, await hashPassword(password)],
  );
  if (!rowCount) throw new Error(`No account called "${username}".`);

  console.log(`\nReset the password for "${username}".`);
  console.log(`Password: ${password}`);
  console.log('\nAny existing session for that account has been signed out.\n');
}

async function remove(rawUsername) {
  const username = normalizeUsername(rawUsername);
  if (!username) throw new Error(USERNAME_RULES);

  const { rows } = await query(
    `select id, (select count(*)::int from watches w where w.subscriber_id = s.id) as watches
       from subscribers s where lower(username) = $1`,
    [username],
  );
  if (!rows.length) throw new Error(`No account called "${username}".`);

  const ok = await confirm(
    `Delete "${username}" and its ${rows[0].watches} watched product(s)?`,
  );
  if (!ok) {
    console.log('Left alone.');
    return;
  }

  await query('delete from subscribers where id = $1', [rows[0].id]);
  console.log(`Deleted "${username}".`);
}

const [command, ...rest] = process.argv.slice(2);

assertConfig();
if (!(await initDb({ retries: 3, delayMs: 2_000 }))) {
  console.error('Could not reach the database. Is DATABASE_URL set?');
  process.exit(1);
}

try {
  if (command === '--list' || command === '-l') {
    await list();
  } else if (command === '--passwd' || command === '-p') {
    await passwd(rest[0], rest[1]);
  } else if (command === '--delete' || command === '-d') {
    await remove(rest[0]);
  } else if (!command || command.startsWith('-')) {
    console.log(
      'Usage:\n' +
        '  npm run useradd <username> [password]     create an account\n' +
        '  npm run useradd -- --list                 list accounts\n' +
        '  npm run useradd -- --passwd <user> [pw]   reset a password\n' +
        '  npm run useradd -- --delete <user>        delete an account\n',
    );
  } else {
    await create(command, rest[0]);
  }
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
