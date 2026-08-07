// Does `pg` call a password *function* once per physical connection, does the value reach the
// server as that connection's password, and does `maxLifetimeSeconds` bound a connection that
// is currently checked out? Answered by being the server.
//
// The whole Entra design rests on the first: an access token is passed as the password, so if
// the callback fired once per process the pool would carry one token for its lifetime and
// expiry would be unavoidable. The third decides how much slack `RENEW_MARGIN_MS` must carry.
//
//   node infra/postgres-identity/pg-password-callback-probe.mjs
//
// A real Postgres would prove the same thing less sharply. Here the exact bytes each
// connection presents are recorded, so "the second connection used a different token" is an
// observation rather than an inference.

import net from 'node:net';
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const pgVersion = require('pg/package.json').version;

const seen = [];
let socketsAccepted = 0;

function serverMsg(type, payload = Buffer.alloc(0)) {
  const buf = Buffer.alloc(5 + payload.length);
  buf.write(type, 0, 'latin1');
  buf.writeInt32BE(4 + payload.length, 1);
  payload.copy(buf, 5);
  return buf;
}

const int32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

const AUTH_CLEARTEXT = serverMsg('R', int32(3));
const AUTH_OK = serverMsg('R', int32(0));
const BACKEND_KEY = serverMsg('K', Buffer.concat([int32(4242), int32(1)]));
const READY = serverMsg('Z', Buffer.from('I', 'latin1'));

const server = net.createServer((sock) => {
  socketsAccepted += 1;
  let buf = Buffer.alloc(0);
  let started = false;
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!started) {
      if (buf.length < 4) return;
      const len = buf.readInt32BE(0);
      if (buf.length < len) return;
      buf = buf.subarray(len);
      started = true;
      sock.write(AUTH_CLEARTEXT); // demand a password, so we get to see it
      return;
    }
    while (buf.length >= 5) {
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) return;
      const payload = buf.subarray(5, 1 + len);
      buf = buf.subarray(1 + len);
      if (type === 'p') {
        seen.push(payload.toString('latin1').replace(/\0$/, ''));
        sock.write(Buffer.concat([AUTH_OK, BACKEND_KEY, READY]));
      } else if (type === 'X') {
        sock.end();
      }
    }
  });
  sock.on('error', () => {});
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const base = { host: '127.0.0.1', port, user: 'probe', database: 'probe' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`pg version under test                              : ${pgVersion}`);

let calls = 0;
const pool = new pg.Pool({
  ...base,
  password: async () => `token-${++calls}`,
  max: 3,
  idleTimeoutMillis: 60_000,
});

const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
console.log(`callback invocations after 3 concurrent connections : ${calls}`);
console.log(`passwords the server received                       : ${JSON.stringify(seen)}`);
const distinct = new Set(seen).size;

const before = calls;
clients.forEach((c) => c.release());
(await pool.connect()).release();
console.log(`callback invocations after release + re-acquire     : ${calls} (was ${before})`);
await pool.end();

// The mechanism that keeps a pooled connection from outliving the token that opened it, on
// the idle path: the connection ages out between checkouts and its replacement re-authenticates.
let rotations = 0;
const shortLived = new pg.Pool({
  ...base,
  password: async () => `rotated-${++rotations}`,
  max: 1,
  maxLifetimeSeconds: 1,
  idleTimeoutMillis: 60_000,
});
(await shortLived.connect()).release();
await sleep(1_800);
(await shortLived.connect()).release();
console.log(`token mints across a maxLifetimeSeconds boundary    : ${rotations}`);
await shortLived.end();

// The path that decides the renewal margin, and the one the earlier version of this probe did
// not measure: a connection that is *checked out* when its lifetime elapses. pg-pool's timer
// adds the client to `_expired` and can only act on it in `release()`, so the connection keeps
// serving for the rest of the checkout however long that is.
let inUseMints = 0;
const socketsBeforeHold = socketsAccepted;
const held = new pg.Pool({
  ...base,
  password: async () => `held-${++inUseMints}`,
  max: 1,
  maxLifetimeSeconds: 1,
  idleTimeoutMillis: 60_000,
});
const holdClient = await held.connect();
await sleep(2_500); // 2.5x the lifetime, still checked out
const socketsDuringHold = socketsAccepted - socketsBeforeHold;
const survivedInUse = !holdClient.connection.stream.destroyed;
holdClient.release();
const replaced = await held.connect();
const socketsAfterRelease = socketsAccepted - socketsBeforeHold;
replaced.release();
await held.end();

console.log(
  `connection held 2.5x past its lifetime, still open   : ${survivedInUse} ` +
    `(sockets during hold ${socketsDuringHold}, after release ${socketsAfterRelease})`,
);
console.log(`token mints on the in-use path                      : ${inUseMints}`);

server.close();

const verdicts = [
  ['password function is invoked per physical connection', calls === 3],
  ['each invocation reaches the server as that connection password', distinct === 3],
  ['a reused pooled connection does not re-invoke it', calls === before],
  ['an aged-out idle connection is replaced with a freshly minted token', rotations === 2],
  // Not a defect to fix, a bound to design against: a connection already checked out keeps
  // serving past its retirement age, so `maxLifetimeSeconds` bounds when authority is dropped
  // rather than guaranteeing it by any deadline.
  ['maxLifetimeSeconds does NOT evict a checked-out connection', survivedInUse === true],
  ['the retirement happens on release, not during the checkout', socketsAfterRelease === 2],
];
console.log('');
for (const [claim, ok] of verdicts) console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}`);
process.exit(verdicts.every(([, ok]) => ok) ? 0 : 1);
