import { createHmac, createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  amzDate,
  isSafeKey,
  localPathFor,
  localUploadSignature,
  photoKeys,
  presignV4,
  timingSafeEqual,
  uriEncode,
  type R2Config,
} from '../src/storage';

/**
 * The signer.
 *
 * A hand-rolled SigV4 either produces a byte-identical signature or produces a 403 with no
 * explanation, so this suite is written as a specification rather than as a smoke test: the
 * canonical request is spelled out as a **literal string** and signed by an independent
 * implementation built on `node:crypto`, which shares no code with the one under test.
 *
 * The oracle is itself checked first, against AWS's published signing-key derivation vector.
 * A test whose expected value comes from the same author as the code proves only that the
 * author was consistent — anchoring it to a number AWS published makes it prove something.
 */

// ---------------------------------------------------------------------------
// An independent implementation, used as the oracle
// ---------------------------------------------------------------------------

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  // Annotated rather than inferred. `Buffer.from` narrows to `Buffer<ArrayBuffer>` while
  // `createHmac(...).digest()` returns the wider `Buffer<ArrayBufferLike>`, so an inferred
  // `let` here cannot be reassigned from the loop below.
  let key: Buffer = Buffer.from(`AWS4${secret}`, 'utf8');
  for (const part of [dateStamp, region, service, 'aws4_request']) key = hmac(key, part);
  return key;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const CONFIG: R2Config = {
  accountId: 'abc123',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  bucket: 'switchback',
  publicUrl: 'https://photos.example.test',
};

const NOW = new Date('2026-07-27T11:30:45Z');
const HOST = 'abc123.r2.cloudflarestorage.com';

describe('the SigV4 oracle', () => {
  it('reproduces AWS’s published signing-key derivation', () => {
    // From AWS's "deriving a signing key" example: wJalrXUtnFEMI… / 20120215 / us-east-1 / iam.
    expect(signingKey(CONFIG.secretAccessKey, '20120215', 'us-east-1', 'iam').toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });
});

describe('presignV4', () => {
  it('signs the canonical request AWS specifies, byte for byte', async () => {
    const signed = await presignV4(CONFIG, 'PUT', 'photos/user_1/abcd.jpg', {
      contentType: 'image/jpeg',
      expiresInS: 300,
      now: NOW,
    });

    // Written out rather than rebuilt from the code under test. If a line moves, a header
    // stops being signed, or the payload marker changes, this literal stops matching.
    const canonicalQuery = [
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=AKIDEXAMPLE%2F20260727%2Fauto%2Fs3%2Faws4_request',
      'X-Amz-Date=20260727T113045Z',
      'X-Amz-Expires=300',
      'X-Amz-SignedHeaders=content-type%3Bhost',
    ].join('&');

    const canonicalRequest = [
      'PUT',
      '/switchback/photos/user_1/abcd.jpg',
      canonicalQuery,
      'content-type:image/jpeg',
      `host:${HOST}`,
      '',
      'content-type;host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20260727T113045Z',
      '20260727/auto/s3/aws4_request',
      sha256Hex(canonicalRequest),
    ].join('\n');

    const expected = hmac(
      signingKey(CONFIG.secretAccessKey, '20260727', 'auto', 's3'),
      stringToSign,
    ).toString('hex');

    expect(signed.url).toBe(
      `https://${HOST}/switchback/photos/user_1/abcd.jpg?${canonicalQuery}&X-Amz-Signature=${expected}`,
    );
  });

  it('sends back the exact content type it signed', async () => {
    const signed = await presignV4(CONFIG, 'PUT', 'photos/u/a.webp', {
      contentType: 'image/webp',
      expiresInS: 60,
      now: NOW,
    });
    expect(signed.headers).toEqual({ 'Content-Type': 'image/webp' });
    expect(signed.url).toContain('X-Amz-SignedHeaders=content-type%3Bhost');
  });

  it('signs host alone when there is no body to type', async () => {
    // HEAD and DELETE go out with no content type, and signing one anyway would produce a
    // signature the store cannot reproduce.
    const signed = await presignV4(CONFIG, 'DELETE', 'photos/u/a.jpg', {
      expiresInS: 60,
      now: NOW,
    });
    expect(signed.headers).toEqual({});
    expect(signed.url).toContain('X-Amz-SignedHeaders=host');
  });

  it('binds the signature to the content type, so a ticket cannot be reused for HTML', async () => {
    const [jpeg, html] = await Promise.all([
      presignV4(CONFIG, 'PUT', 'photos/u/a.jpg', {
        contentType: 'image/jpeg',
        expiresInS: 300,
        now: NOW,
      }),
      presignV4(CONFIG, 'PUT', 'photos/u/a.jpg', {
        contentType: 'text/html',
        expiresInS: 300,
        now: NOW,
      }),
    ]);
    expect(jpeg.url).not.toBe(html.url);
  });

  it('binds the signature to the key, the expiry and the secret', async () => {
    const base = { contentType: 'image/jpeg', expiresInS: 300, now: NOW } as const;
    const [a, b, c, d] = await Promise.all([
      presignV4(CONFIG, 'PUT', 'photos/u/a.jpg', base),
      presignV4(CONFIG, 'PUT', 'photos/u/b.jpg', base),
      presignV4(CONFIG, 'PUT', 'photos/u/a.jpg', { ...base, expiresInS: 301 }),
      presignV4({ ...CONFIG, secretAccessKey: 'another-secret' }, 'PUT', 'photos/u/a.jpg', base),
    ]);
    expect(new Set([a?.url, b?.url, c?.url, d?.url]).size).toBe(4);
  });

  it('is stable for a fixed instant', async () => {
    const options = { contentType: 'image/jpeg', expiresInS: 300, now: NOW } as const;
    const [first, second] = await Promise.all([
      presignV4(CONFIG, 'PUT', 'photos/u/a.jpg', options),
      presignV4(CONFIG, 'PUT', 'photos/u/a.jpg', options),
    ]);
    expect(first.url).toBe(second.url);
  });

  it('leaves the slashes in a key alone but encodes what S3 needs encoded', async () => {
    const signed = await presignV4(CONFIG, 'PUT', 'photos/u 1/a+b.jpg', {
      expiresInS: 60,
      now: NOW,
    });
    // The path keeps its structure; the space becomes %20 and the plus is left as an
    // unreserved-adjacent literal only if AWS says so — it does not, so it is encoded.
    expect(signed.url).toContain(`https://${HOST}/switchback/photos/u%201/a%2Bb.jpg?`);
  });
});

describe('uriEncode', () => {
  it('leaves the unreserved set alone', () => {
    expect(uriEncode('AZaz09-_.~')).toBe('AZaz09-_.~');
  });

  it('encodes the four characters encodeURIComponent does not', () => {
    // `!*'()`. These are the reason a hand-rolled signer works on every key you test with
    // and then fails on the one photograph whose name has an apostrophe in it.
    expect(uriEncode("!*'()")).toBe('%21%2A%27%28%29');
    expect(encodeURIComponent("!*'()")).toBe("!*'()");
  });

  it('uses uppercase hex', () => {
    expect(uriEncode(' ')).toBe('%20');
    expect(uriEncode('~a/b')).toBe('~a%2Fb');
  });

  it('encodes multi-byte characters one UTF-8 byte at a time', () => {
    expect(uriEncode('é')).toBe('%C3%A9');
    expect(uriEncode('日')).toBe('%E6%97%A5');
    // Astral plane — a two-unit surrogate pair must not be encoded as two lone surrogates.
    expect(uriEncode('🥾')).toBe('%F0%9F%A5%BE');
  });

  it('can be told to keep path separators', () => {
    expect(uriEncode('a/b/c', false)).toBe('a/b/c');
    expect(uriEncode('a/b/c')).toBe('a%2Fb%2Fc');
  });
});

describe('amzDate', () => {
  it('is ISO-8601 with the punctuation removed', () => {
    expect(amzDate(new Date('2026-07-27T11:30:45.123Z'))).toBe('20260727T113045Z');
  });

  it('pads single digits', () => {
    expect(amzDate(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });
});

describe('isSafeKey', () => {
  it('accepts the keys we generate', () => {
    expect(isSafeKey('photos/cms2q3ibs00017nuwcrwpmfkb/abcd1234.jpg')).toBe(true);
    expect(isSafeKey('photos/cms2q3ibs00017nuwcrwpmfkb/abcd1234_t.jpg')).toBe(true);
  });

  it('rejects traversal, absolutes and anything exotic', () => {
    for (const key of [
      '../etc/passwd',
      'photos/../../etc/passwd',
      '/photos/a.jpg',
      'photos/a.jpg .png',
      'photos/a b.jpg',
      'photos/a?b.jpg',
      '',
      `photos/${'a'.repeat(300)}.jpg`,
    ]) {
      expect(isSafeKey(key), key).toBe(false);
    }
  });
});

describe('localPathFor', () => {
  it('resolves inside the upload directory', async () => {
    const resolved = await localPathFor('photos/u/a.jpg');
    expect(resolved.startsWith(path.resolve('.uploads') + path.sep)).toBe(true);
  });

  it('refuses to escape it', async () => {
    await expect(localPathFor('../../secrets.env')).rejects.toThrow(/unsafe object key/u);
  });
});

describe('localUploadSignature', () => {
  const SECRET = 'a'.repeat(48);

  it('changes with every part of the promise it makes', async () => {
    process.env.AUTH_SECRET = SECRET;
    const base = await localUploadSignature('PUT', 'photos/u/a.jpg', 'image/jpeg', 1);
    const variants = await Promise.all([
      localUploadSignature('DELETE', 'photos/u/a.jpg', 'image/jpeg', 1),
      localUploadSignature('PUT', 'photos/u/b.jpg', 'image/jpeg', 1),
      localUploadSignature('PUT', 'photos/u/a.jpg', 'text/html', 1),
      localUploadSignature('PUT', 'photos/u/a.jpg', 'image/jpeg', 2),
    ]);
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('will not sign with a weak secret', async () => {
    process.env.AUTH_SECRET = 'short';
    await expect(localUploadSignature('PUT', 'k', 'image/jpeg', 1)).rejects.toThrow(/AUTH_SECRET/u);
    process.env.AUTH_SECRET = SECRET;
  });
});

describe('timingSafeEqual', () => {
  it('matches identical strings and nothing else', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('photoKeys', () => {
  it('puts the owner in the path and the thumbnail beside the original', () => {
    const keys = photoKeys('cms2q3ibs00017nuwcrwpmfkb', 'abcd1234', 'image/webp');
    expect(keys.full).toBe('photos/cms2q3ibs00017nuwcrwpmfkb/abcd1234.webp');
    // Always JPEG regardless of the original's type — every browser can encode one.
    expect(keys.thumb).toBe('photos/cms2q3ibs00017nuwcrwpmfkb/abcd1234_t.jpg');
    expect(isSafeKey(keys.full) && isSafeKey(keys.thumb)).toBe(true);
  });

  it('gives each accepted type its own extension', () => {
    expect(photoKeys('u', 'i', 'image/jpeg').full.endsWith('.jpg')).toBe(true);
    expect(photoKeys('u', 'i', 'image/png').full.endsWith('.png')).toBe(true);
    expect(photoKeys('u', 'i', 'image/avif').full.endsWith('.avif')).toBe(true);
  });
});
