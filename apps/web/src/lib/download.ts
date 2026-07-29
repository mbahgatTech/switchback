/**
 * Handing a generated file to the browser.
 *
 * Two exports and a constant, shared by every "download this" button in the app, because the
 * sequence below is fussier than it looks and getting it subtly wrong produces a zero-byte
 * file rather than an error anybody sees.
 */

/**
 * Save a blob under a filename, the only way a browser lets you.
 *
 * There is no API for "write these bytes to the downloads folder". The supported route is an
 * anchor with a `download` attribute pointed at an object URL, clicked programmatically —
 * which is why this reads like a trick rather than like a function call.
 *
 * **The revoke is deferred a second on purpose.** Safari has not finished reading the object
 * URL when `click()` returns, so revoking on the next line hands the user a zero-byte file
 * with no error anywhere. A second is far longer than the read needs and costs one object
 * URL's worth of memory until it fires.
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
 * Base64 text to the bytes it stands for.
 *
 * Binary files reach the client as base64 because they come over tRPC, which is JSON. `atob`
 * returns a string whose char codes are the bytes — not the bytes — so the copy below is
 * required, not ceremony: handing that string to `Blob` would encode it as UTF-8 and roughly
 * double the size of anything above 0x7F, corrupting every binary format there is.
 *
 * The return type names its backing buffer because the bare `Uint8Array` alias now means
 * `Uint8Array<ArrayBufferLike>`, which `Blob` will not take — a `SharedArrayBuffer` cannot be
 * transferred into one, and the compiler cannot tell from the alias that this never is.
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
 * The media type Garmin registered for FIT.
 *
 * Worth using over `application/octet-stream` even though nothing on the web dispatches on
 * it: a phone that recognises the type offers to open the file in Garmin Connect instead of
 * filing it away somewhere the user then has to go and find.
 */
export const FIT_MIME = 'application/vnd.ant.fit';

/** The media type for GPX, which every mapping app on both platforms recognises. */
export const GPX_MIME = 'application/gpx+xml;charset=utf-8';
