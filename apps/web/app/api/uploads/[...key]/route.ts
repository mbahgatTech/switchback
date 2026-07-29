/**
 * The local development object store.
 *
 * There is no way to obtain R2 credentials without a Cloudflare account, and the photograph
 * upload has to be buildable, testable and demonstrable before anyone has one. So in
 * development the presigned URL points back here, and this route plays the part of the
 * bucket: it honours a signed, expiring, single-object `PUT`, and serves what it stored.
 *
 * It is a genuine stand-in rather than a shortcut. The signature is checked, the expiry is
 * checked, the content type is pinned to what was signed, and the size is capped — the same
 * four things R2 enforces, so an upload that works here works there. That matters more than
 * it might seem: the failure this prevents is the one where the client is written against a
 * permissive dev endpoint and then meets a real signature for the first time in production.
 *
 * The route disables itself the moment R2 is configured. Two live write paths to the same
 * keys is one more than anybody needs, and a filesystem write on a serverless host writes to
 * a container that is about to disappear.
 */
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { MAX_PHOTO_BYTES } from '@switchback/core';
import {
  isSafeKey,
  localPathFor,
  localUploadSignature,
  storage,
  timingSafeEqual,
} from '@switchback/api/storage';

export const runtime = 'nodejs';
/** Uploads are writes to disk and reads are of files that were just written — never prerender. */
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ key: string[] }>;
}

/** Served back on `GET`, so a browser renders the image rather than downloading it. */
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

function disabled(): NextResponse {
  return NextResponse.json({ error: 'Local uploads are disabled.' }, { status: 404 });
}

export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  if (storage().kind !== 'local') return disabled();

  const { key: segments } = await context.params;
  const key = segments.join('/');
  if (!isSafeKey(key)) {
    return NextResponse.json({ error: 'Bad key.' }, { status: 400 });
  }

  const url = new URL(request.url);
  const contentType = url.searchParams.get('ct') ?? '';
  const expiresAt = Number(url.searchParams.get('exp') ?? '0');
  const signature = url.searchParams.get('sig') ?? '';

  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return NextResponse.json({ error: 'That upload URL has expired.' }, { status: 403 });
  }

  const expected = await localUploadSignature('PUT', key, contentType, expiresAt);
  if (!timingSafeEqual(expected, signature)) {
    return NextResponse.json({ error: 'Bad signature.' }, { status: 403 });
  }

  /*
   * The header must match what was signed, exactly as it must against S3. This is the check
   * that stops a ticket for a JPEG being used to park an HTML document at a URL our own
   * origin serves — the stored-XSS hole that signing the content type exists to close.
   */
  const sent = request.headers.get('content-type')?.split(';')[0]?.trim();
  if (sent !== contentType) {
    return NextResponse.json({ error: `Content-Type must be ${contentType}.` }, { status: 400 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) {
    return NextResponse.json({ error: 'Empty body.' }, { status: 400 });
  }
  if (body.byteLength > MAX_PHOTO_BYTES) {
    return NextResponse.json({ error: 'Too large.' }, { status: 413 });
  }

  const destination = await localPathFor(key);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, body);

  return new NextResponse(null, { status: 200 });
}

export async function HEAD(_request: Request, context: RouteContext): Promise<NextResponse> {
  if (storage().kind !== 'local') return disabled();
  const { key: segments } = await context.params;
  try {
    const stats = await stat(await localPathFor(segments.join('/')));
    return new NextResponse(null, {
      status: 200,
      headers: { 'Content-Length': String(stats.size) },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

/**
 * Serve a stored object.
 *
 * Unsigned, because these are photographs on public trail pages — the same as they would be
 * from a public bucket. `Content-Disposition: inline` with a pinned type, never a type
 * inferred from the bytes, so a file that somehow got here holding something other than what
 * its extension claims is still rendered as an image and not as a document.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  if (storage().kind !== 'local') return disabled();

  const { key: segments } = await context.params;
  const key = segments.join('/');
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) return new NextResponse(null, { status: 404 });

  try {
    const body = await readFile(await localPathFor(key));
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        // Keys contain a random id and objects are never overwritten, so the content at a
        // given URL is immutable by construction.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
