/** Handing a generated file to the browser. Shared by every "download this" button in the app. */

/**
 * Save a blob under a filename, the only way a browser allows: an anchor with `download`, pointed
 * at an object URL, clicked programmatically. **The revoke is deferred a second on purpose** —
 * Safari has not finished reading the URL when `click()` returns, and revoking on the next line
 * hands the user a zero-byte file with no error anywhere.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Base64 text to the bytes it stands for — binary reaches the client over tRPC, which is JSON.
 * The copy is required, not ceremony: `atob` returns a string whose char codes are the bytes, and
 * handing that to `Blob` encodes it as UTF-8, corrupting everything above 0x7F.
 *
 * The return type names its backing buffer because bare `Uint8Array` now means
 * `Uint8Array<ArrayBufferLike>`, and `Blob` will not take a possible `SharedArrayBuffer`.
 */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * The media type Garmin registered for FIT. Worth using over `application/octet-stream`: a phone
 * that recognises it offers to open the file in Garmin Connect.
 */
export const FIT_MIME = 'application/vnd.ant.fit';

/** The media type for GPX, which every mapping app on both platforms recognises. */
export const GPX_MIME = 'application/gpx+xml;charset=utf-8';
