import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@switchback/db';
import { ingestPrincipalFor, resetIngestPrincipalWarnings } from '../src/ingest-principal';

/**
 * Who an ingest request is charged to.
 *
 * This is abuse control, so the interesting cases are the adversarial ones: a caller who wants
 * somebody else's bucket, a caller who wants no bucket at all, and a caller who can change
 * addresses for free.
 */

const SECRET = 'test-secret-at-least-thirty-two-characters-long';

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

const signedIn = { id: 'user_abc' } as User;

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  resetIngestPrincipalWarnings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ingestPrincipalFor', () => {
  it('charges a signed-in caller to their account, wherever they connect from', () => {
    const home = ingestPrincipalFor(headers({ 'x-forwarded-for': '203.0.113.4' }), signedIn);
    const away = ingestPrincipalFor(headers({ 'x-forwarded-for': '198.51.100.9' }), signedIn);

    expect(home).toEqual({ key: 'u:user_abc', kind: 'user' });
    expect(away).toEqual(home);
  });

  it('charges an anonymous caller to their address, without ever storing the address', () => {
    const principal = ingestPrincipalFor(headers({ 'x-forwarded-for': '203.0.113.4' }), null);

    expect(principal.kind).toBe('address');
    expect(principal.key).toMatch(/^a:[0-9a-f]{32}$/u);
    expect(principal.key).not.toContain('203.0.113.4');
  });

  it('gives two different addresses two different buckets', () => {
    const one = ingestPrincipalFor(headers({ 'x-forwarded-for': '203.0.113.4' }), null);
    const two = ingestPrincipalFor(headers({ 'x-forwarded-for': '203.0.113.5' }), null);

    expect(one.key).not.toBe(two.key);
  });

  it("prefers the platform's own header to the one a proxy in front of it can overwrite", () => {
    // `x-vercel-forwarded-for` is the value Vercel wrote; `x-forwarded-for` is documented as
    // overwritable by a proxy on top of the deployment. When they disagree, the first wins.
    const platform = ingestPrincipalFor(headers({ 'x-vercel-forwarded-for': '203.0.113.4' }), null);
    const shadowed = ingestPrincipalFor(
      headers({ 'x-vercel-forwarded-for': '203.0.113.4', 'x-forwarded-for': '198.51.100.9' }),
      null,
    );

    expect(shadowed.key).toBe(platform.key);
  });

  it('takes the leftmost entry when the header carries a list', () => {
    const single = ingestPrincipalFor(headers({ 'x-forwarded-for': '203.0.113.4' }), null);
    const listed = ingestPrincipalFor(
      headers({ 'x-forwarded-for': '203.0.113.4, 70.41.3.18, 150.172.238.178' }),
      null,
    );

    expect(listed.key).toBe(single.key);
  });

  it('puts one IPv6 /64 in one bucket, so rotating inside it buys nothing', () => {
    const first = ingestPrincipalFor(headers({ 'x-forwarded-for': '2001:db8:1:2::1' }), null);
    const rotated = ingestPrincipalFor(
      headers({ 'x-forwarded-for': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }),
      null,
    );
    const neighbour = ingestPrincipalFor(headers({ 'x-forwarded-for': '2001:db8:1:3::1' }), null);

    expect(rotated.key).toBe(first.key);
    expect(neighbour.key).not.toBe(first.key);
  });

  it('reads an IPv4-mapped address as the one host it is, not as a /64', () => {
    const mapped = ingestPrincipalFor(headers({ 'x-forwarded-for': '::ffff:203.0.113.4' }), null);
    const plain = ingestPrincipalFor(headers({ 'x-forwarded-for': '203.0.113.4' }), null);

    expect(mapped.key).toBe(plain.key);
  });

  it('refuses to key on something that is not an address', () => {
    // The header is the platform's on this deployment, but a value that is not an address is a
    // sign the deployment moved — and an arbitrary string must never become a bucket of its own.
    for (const value of ['not-an-address', '', '   ', '999.1.1.1', 'u:someone-else']) {
      expect(ingestPrincipalFor(headers({ 'x-forwarded-for': value }), null).kind).toBe(
        'unidentified',
      );
    }
  });

  it('shares one bucket when the platform recorded no address at all', () => {
    const principal = ingestPrincipalFor(headers({}), null);

    // Not an exemption: a limit a missing header switches off is a limit whose bypass is a
    // missing header.
    expect(principal).toEqual({ key: 'x:shared', kind: 'unidentified' });
  });

  it('falls back to the shared bucket, loudly, when there is no secret to key with', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('AUTH_SECRET', '');

    const principal = ingestPrincipalFor(headers({ 'x-forwarded-for': '203.0.113.4' }), null);

    expect(principal.kind).toBe('unidentified');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('cannot be pushed into another caller’s bucket by a header the caller chose', () => {
    // The only headers read are ones Vercel overwrites, so an `x-real-ip` a client sends is
    // only ever consulted when the platform wrote nothing above it — and a signed-in caller's
    // bucket is their account id, which no header reaches at all.
    const forged = ingestPrincipalFor(
      headers({ 'x-vercel-forwarded-for': '203.0.113.4', 'x-real-ip': '198.51.100.9' }),
      null,
    );
    const honest = ingestPrincipalFor(headers({ 'x-vercel-forwarded-for': '203.0.113.4' }), null);
    const victim = ingestPrincipalFor(headers({ 'x-vercel-forwarded-for': '198.51.100.9' }), null);

    expect(forged.key).toBe(honest.key);
    expect(forged.key).not.toBe(victim.key);
  });
});
