import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `SKIP_ENV_VALIDATION` is an escape hatch for builds with no secrets. The failure it caused
 * once, and must not cause again: it returned `process.env` verbatim, so `AUTH_APPLE_ENABLED`
 * arrived as the string `"false"` — truthy — and every request built an Apple provider whose
 * client secret cannot be signed without a `.p8`. A production build threw on first render.
 *
 * This is read as source rather than imported because `env.ts` parses at module load and is
 * `@/`-aliased into the Next app; asserting on the text is what keeps the guard visible at
 * the place a future boolean would be added.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../src/env.ts', import.meta.url)), 'utf8');

describe('environment escape hatch', () => {
  it('coerces booleans even when validation is skipped', () => {
    expect(SOURCE).toMatch(/AUTH_APPLE_ENABLED:\s*process\.env\.AUTH_APPLE_ENABLED === 'true'/u);
  });

  it('has exactly one boolean field, so the coercion above is complete', () => {
    // The moment a second `bool` is added, this fails and points at the branch that needs it.
    const declared = SOURCE.match(/^\s+[A-Z0-9_]+: bool,$/gmu) ?? [];
    expect(declared).toHaveLength(1);
    expect(declared[0]).toContain('AUTH_APPLE_ENABLED');
  });

  it('parses "false" as false and only "true" as true', () => {
    const bool =
      /z\s*\n?\s*\.enum\(\['true', 'false'\]\)[\s\S]{0,120}?\.transform\(\(v\) => v === 'true'\)/u;
    expect(SOURCE).toMatch(bool);
  });
});
