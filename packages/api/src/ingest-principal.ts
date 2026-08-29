/**
 * Who an ingest request is charged to. Resolved once per request from the session and, failing
 * that, from the address the platform observed — never from anything a client chose to send.
 */

import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { User } from '@switchback/db';
import type { IngestPrincipal } from '@switchback/ingest';

/**
 * Vercel writes the caller's address into all three of these and refuses to forward an external
 * one — "we currently overwrite the X-Forwarded-For header and do not forward external IPs.
 * This restriction is in place to prevent IP spoofing" — so on this deployment they are the
 * platform's word rather than the client's. Ordered by how hard each is to displace:
 * `x-vercel-forwarded-for` is Vercel's own and survives a proxy in front of the deployment,
 * which is the one thing documented to overwrite `x-forwarded-for`.
 *
 * https://vercel.com/docs/headers/request-headers
 */
const ADDRESS_HEADERS = ['x-vercel-forwarded-for', 'x-forwarded-for', 'x-real-ip'] as const;

/** How many hex characters of the address digest to keep. 128 bits, so collisions are not a risk. */
const KEY_LENGTH = 32;

/**
 * Domain separation for the HMAC. `AUTH_SECRET` also signs sessions, so tagging what this digest
 * is *for* keeps a bucket key from ever colliding with another use of the same secret.
 */
const KEY_DOMAIN = 'ingest-principal|';

/**
 * Every caller the platform did not identify, in one bucket. Not an exemption: a limit that a
 * missing header switches off is a limit whose bypass is a missing header.
 */
const SHARED_KEY = 'x:shared';

let warnedUnkeyed = false;

/**
 * The bucket key for a network address: HMAC rather than a bare digest, because the IPv4 space
 * is small enough to enumerate and an unkeyed hash of it is the address in a costume.
 * `AUTH_SECRET` is the estate's existing server-side secret and is present wherever sessions work.
 */
function addressKey(address: string): string | null {
  const secret = process.env.AUTH_SECRET;
  if (secret === undefined || secret === '') {
    if (!warnedUnkeyed) {
      warnedUnkeyed = true;
      console.warn(
        'ingest rate limiting cannot key on an address: AUTH_SECRET is unset, so every unidentified caller shares one allowance',
      );
    }
    return null;
  }
  const digest = createHmac('sha256', secret).update(`${KEY_DOMAIN}${address}`).digest('hex');
  return `a:${digest.slice(0, KEY_LENGTH)}`;
}

/**
 * The leading four hextets of an IPv6 address, zero-filled — the `/64` a residential or mobile
 * client is usually delegated whole. Keying on the full address instead would let such a client
 * rotate out of its bucket between requests for nothing.
 */
function prefix64(address: string): string | null {
  const [head, tail, extra] = address.split('::');
  if (extra !== undefined || head === undefined) return null;

  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  if (gap < 0) return null;

  const hextets = [...left, ...Array<string>(gap).fill('0'), ...right];
  if (hextets.length !== 8) return null;

  const prefix = hextets.slice(0, 4).map((hextet) => Number.parseInt(hextet, 16));
  if (prefix.some((part) => !Number.isInteger(part))) return null;
  return prefix.map((part) => part.toString(16)).join(':');
}

/** The address, reduced to what one customer plausibly controls, or null if it is not an address. */
function addressBucket(raw: string): string | null {
  if (isIPv4(raw)) return raw;
  if (!isIPv6(raw)) return null;

  // An IPv4-mapped address (`::ffff:203.0.113.4`) is one v4 host, not a v6 allocation.
  const mapped = raw.slice(raw.lastIndexOf(':') + 1);
  if (isIPv4(mapped)) return mapped;

  return prefix64(raw);
}

/** The first address the platform recorded, or null when it recorded none we can read. */
function observedAddress(headers: Headers): string | null {
  for (const name of ADDRESS_HEADERS) {
    const value = headers.get(name);
    // Vercel writes a single address, but the header is a list by definition and the leftmost
    // entry is the client end of it.
    const first = value?.split(',')[0]?.trim();
    if (first !== undefined && first !== '') {
      const bucket = addressBucket(first);
      if (bucket !== null) return bucket;
    }
  }
  return null;
}

/**
 * A signed-in caller is their account, wherever they connect from; everyone else is their
 * address; anyone the platform did not place shares one bucket with the rest.
 */
export function ingestPrincipalFor(headers: Headers, user: User | null): IngestPrincipal {
  if (user !== null) return { key: `u:${user.id}`, kind: 'user' };

  const address = observedAddress(headers);
  const key = address === null ? null : addressKey(address);
  return key === null ? { key: SHARED_KEY, kind: 'unidentified' } : { key, kind: 'address' };
}

/** Test seam: forget the once-only warning about a missing `AUTH_SECRET`. */
export function resetIngestPrincipalWarnings(): void {
  warnedUnkeyed = false;
}
