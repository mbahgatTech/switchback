// Does Azure Postgres terminate a live session when the Entra token that opened it expires?
// Two connections opened from one token: one polled every minute, one left idle across the
// boundary and queried only afterwards — the pooled-connection case the app actually has.

import pg from 'pg';
import { readFileSync } from 'node:fs';

const [host, user, database, tokenPath, holdMinutesArg] = process.argv.slice(2);
const holdMinutes = Number(holdMinutesArg);
const token = readFileSync(tokenPath, 'utf8').trim();

const expiresAt = JSON.parse(
  Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
).exp;

const startedAt = Date.now();
const minutesIn = () => ((Date.now() - startedAt) / 60_000).toFixed(1);
const minutesPastExpiry = () => ((Date.now() - expiresAt * 1000) / 60_000).toFixed(1);

const log = (...parts) => console.log(parts.join('|'));

function connect(label) {
  const client = new pg.Client({
    host,
    port: 5432,
    user,
    database,
    password: token,
    // verify-full: the CA bundle plus the hostname check `pg` does when `servername` is set.
    ssl: { ca: readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8'), servername: host },
  });
  return client
    .connect()
    .then(() => client.query('SELECT pg_backend_pid() AS pid'))
    .then(({ rows }) => {
      // A backend killed underneath an idle client surfaces as an 'error' event, and an
      // unhandled one takes the process down before the verdict can be printed. Recording it
      // is the point of the run.
      client.on('error', (error) => log('session-error', label, `t=${minutesIn()}min`, error.message));
      log('connected', label, `pid=${rows[0].pid}`, `t=${minutesIn()}min`);
      return client;
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queries every minute for the whole hold, so the minute a busy session dies is visible. */
async function pollUntilDone(client) {
  for (let minute = 1; minute <= holdMinutes; minute += 1) {
    await sleep(60_000);
    try {
      await client.query('SELECT 1');
      log('poll', minute, `past_expiry=${minutesPastExpiry()}min`, 'ok');
    } catch (error) {
      log('poll', minute, `past_expiry=${minutesPastExpiry()}min`, `FAILED: ${error.message}`);
      return { survived: false, lastGoodMinute: minute - 1, error: error.message };
    }
  }
  return { survived: true, lastGoodMinute: holdMinutes };
}

/** Touches nothing until the hold is over — an idle pooled connection, reused after expiry. */
async function queryAfterIdle(client) {
  await sleep(holdMinutes * 60_000 + 5_000);
  try {
    const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
    log('idle-reuse', `past_expiry=${minutesPastExpiry()}min`, `pid=${rows[0].pid}`, 'ok');
    return { survived: true };
  } catch (error) {
    log('idle-reuse', `past_expiry=${minutesPastExpiry()}min`, `FAILED: ${error.message}`);
    return { survived: false, error: error.message };
  }
}

const polled = await connect('polled');
const idle = await connect('idle');
log('token_expires_at', new Date(expiresAt * 1000).toISOString());
log('token_life_remaining_min', ((expiresAt * 1000 - Date.now()) / 60_000).toFixed(1));
log('planned_hold_min', holdMinutes);

const [pollResult, idleResult] = await Promise.all([pollUntilDone(polled), queryAfterIdle(idle)]);

// A run that never outlived the token proves nothing, whatever the two sessions did.
const crossed = Date.now() > expiresAt * 1000;
log('VERDICT', 'crossed_expiry', crossed);
log('VERDICT', 'polled_survived', pollResult.survived, `last_good_minute=${pollResult.lastGoodMinute}`);
log('VERDICT', 'idle_reuse_survived', idleResult.survived);

await polled.end().catch(() => {});
await idle.end().catch(() => {});

if (!crossed) {
  console.error('INCONCLUSIVE: the run ended before the token expired.');
  process.exit(1);
}
