import js from '@eslint/js';
import next from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the whole monorepo.
 *
 * Type-aware linting is on: the rules worth having here (floating promises, unsafe
 * member access on `any` from an untyped upstream response) all need type information,
 * and a geo/ingest codebase that silently drops a promise loses data rather than
 * throwing. `projectService` picks up each package's tsconfig without listing them.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // The alternate build directories a production smoke test writes to while `next dev`
      // keeps `.next` — see `distDir` in apps/web/next.config.ts. Globbed, not named, for
      // the reason the same glob is in `.gitignore`: the directory name is chosen at the
      // command line, so the next one invented would otherwise arrive unignored. Prettier
      // gets this free — v3 reads `.gitignore` — but ESLint's flat config does not, and the
      // failure is loud and confusing: three hundred parse errors against minified chunks
      // no tsconfig covers, on files nobody wrote.
      '**/.next-*/**',
      '**/.expo/**',
      '**/coverage/**',
      // What a Playwright run leaves on disk: the HTML reporter's bundled viewer, and the
      // traces and screenshots kept from failures. Both are gitignored build output, but
      // ESLint reads the working tree rather than the index — and the viewer ships its own
      // compiled JS, which the type-aware parser refuses because no tsconfig covers it. So
      // without this, one failing e2e test makes `npm run lint` fail too, on a file nobody
      // in this repository wrote.
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      // Vendored third-party code, served verbatim from `public/`. It is minified output from
      // somebody else's build — no tsconfig covers it, so the type-aware parser fails on it,
      // and there would be nothing to act on if it did not: the point of a vendored file is
      // that it is byte-identical to the published one. `components/map/rtl.ts` records the
      // version and its digest, which is the review this gets.
      'apps/web/public/vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_`-prefixed arguments are a deliberate signal, not an oversight.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The geo code indexes hot loops under noUncheckedIndexedAccess, where `!` after a
      // bounds check is the readable choice; the alternative is a `?? throw` on every
      // access. Non-null assertions elsewhere are still worth a second look, so: warn.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    /*
     * React, in the two apps that have any.
     *
     * `exhaustive-deps` earns its place on the map components in particular: every one of
     * them registers listeners against a MapLibre instance that outlives the render, and a
     * stale closure there shows up as a map that has quietly stopped reporting its viewport
     * rather than as an exception. Where an effect is deliberately once-only, the disable
     * comment beside it is the record of that decision.
     *
     * `configs.recommended` is a flat-config *array* in v6, so its rules are lifted out
     * rather than spread — spreading the array into an object yields a `"0"` key and
     * ESLint rejects the config outright.
     */
    files: ['apps/web/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: Object.assign({}, ...reactHooks.configs.recommended.map((entry) => entry.rules ?? {})),
  },
  {
    // Next's own rules — the ones that catch a client/server mistake the type system
    // cannot see, like an `<a>` where a `<Link>` belongs or a synchronous script tag.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': next },
    // Without this the app-directory rules look for `pages/` at the repo root and warn on
    // every file that it is missing. The app is not at the root; it is a workspace.
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
    },
  },
  {
    // Config files are plain scripts run by tooling, not part of a tsconfig project —
    // including the per-app ones (apps/web/next.config.ts, postcss.config.mjs), which is
    // why this is `**/` and not just the repo root. Type-aware rules would be wrong here
    // anyway: Next types `headers()` as returning a promise, so an `async` function with
    // nothing to await is the required shape, not a mistake.
    files: ['**/*.config.{js,cjs,mjs,ts,mts,cts}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Metro and Babel load their config synchronously with `require`, so these two are the
    // repo's only CommonJS files. Without the globals, `js.configs.recommended`'s `no-undef`
    // flags `require`, `module`, and `__dirname` as undeclared.
    files: ['**/babel.config.js', '**/metro.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      // These two files are CommonJS by requirement, not by preference — see above.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    /*
     * The service worker.
     *
     * It lives under `public/` because that is the only way to serve it from the origin
     * root, which is what gives it scope over the whole site — so it is outside every
     * tsconfig project, and the type-aware rules have nothing to work from. It also runs in
     * a global scope that is neither browser nor node: no `window`, no `document`, and a
     * `self` that is a `ServiceWorkerGlobalScope`.
     */
    files: ['apps/web/public/sw.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // CLI scripts talk to the operator through stdout — that is their entire interface,
    // not a stray debug statement someone forgot to remove.
    files: ['scripts/**/*.ts', 'packages/*/scripts/**/*.ts', 'apps/*/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // A test double's shape is dictated by the interface it stands in for, not by what it
    // does inside. Every injected seam in this repo — `fetchImpl`, `sleepImpl`, the Prisma
    // stubs — is typed as returning a promise, so the stub must be `async` even when it
    // has nothing to await. Rewriting each one as a non-async function returning
    // `Promise.resolve(...)` satisfies the rule while making the tests harder to read,
    // which is the wrong trade.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  prettier,
);
