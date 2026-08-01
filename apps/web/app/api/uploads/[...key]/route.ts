/**
 * The local development object store: with no Cloudflare account there are no R2 credentials, so
 * the presigned URL points back here and this route plays the bucket.
 *
 * A genuine stand-in, not a shortcut — signature, expiry, pinned content type and size cap are the
 * same four things R2 enforces, so a client written against this meets no surprises in production.
 * It disables itself the moment R2 is configured.
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

  // The header must match what was signed, exactly as against S3. This is what stops a ticket
  // for a JPEG parking an HTML document at a URL our own origin serves.
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
 * Serve a stored object, unsigned — these are photographs on public trail pages. The type is
 * pinned from the extension and never inferred from the bytes, so a file holding something other
 * than what it claims is still rendered as an image rather than as a document.
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
        // Keys carry a random id and objects are never overwritten, so the content at a given
        // URL is immutable by construction.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
