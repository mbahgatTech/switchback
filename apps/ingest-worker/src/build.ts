/**
 * The commit this bundle was built from.
 *
 * `scripts/bundle.ts` substitutes it at build time, so the value travels *inside* the zip. An
 * application setting would have been easier and would have proved nothing: it survives a package
 * that fails to mount, so a host still serving the previous build would report the new SHA.
 */
export const BUILD_COMMIT = process.env.INGEST_BUILD_COMMIT || 'unknown';
