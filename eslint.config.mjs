import js from '@eslint/js';
import next from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the whole monorepo. Type-aware linting is on: the rules worth having here
 * need type information, and ingest code that silently drops a promise loses data.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // Alternate build dirs a production smoke test writes to while `next dev` keeps
      // `.next`. Globbed because the name is chosen at the command line. Without this,
      // ESLint parse-errors on minified chunks no tsconfig covers.
      '**/.next-*/**',
      '**/.expo/**',
      '**/coverage/**',
      // Playwright output. ESLint reads the working tree, not the index, so without this one
      // failing e2e test makes `npm run lint` fail on the reporter's own bundled JS.
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      // Vendored third-party code served verbatim from `public/`: no tsconfig covers it, and
      // the point of a vendored file is that it is byte-identical to the published one.
      // `components/map/rtl.ts` records the version and digest, which is the review it gets.
      'apps/web/public/vendor/**',
      // Agent worktrees, which git puts inside the repo root. Each is a whole extra copy of the
      // monorepo, so without this `npm run lint` reports failures from files CI never sees.
      '.claude/**',
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
    // These are fatal at `--max-warnings=0`. Each is here for a reason; turning one off
    // silently is a real hazard, so the reason is recorded beside it.
    rules: {
      // `_`-prefixed arguments are a deliberate signal, not an oversight.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The geo code indexes hot loops under noUncheckedIndexedAccess, where `!` after a
      // bounds check is the readable choice; the alternative is a `?? throw` on every access.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Inline `type` markers: a value import of a type-only symbol survives compilation and
      // can pull a server module into a client bundle.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // An unawaited promise in ingest or geo loses data instead of throwing.
      '@typescript-eslint/no-floating-promises': 'error',
      // `async` with nothing to await misleads callers about when work finishes; the two
      // places where the shape is forced are exempted below.
      '@typescript-eslint/require-await': 'error',
      // `null` is exempt so `== null` can cover both null and undefined in one check.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // `warn`/`error` reach the operator; a stray `log` is debug output left behind.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    /*
     * `exhaustive-deps` is fatal here: the map components register listeners against a
     * MapLibre instance that outlives the render, and a stale closure shows up as a map that
     * quietly stopped reporting its viewport rather than as an exception.
     * `configs.recommended` is a flat-config *array* in v6, so its rules are lifted out —
     * spreading the array into an object yields a `"0"` key and ESLint rejects the config.
     */
    files: ['apps/web/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: Object.assign({}, ...reactHooks.configs.recommended.map((entry) => entry.rules ?? {})),
  },
  {
    // Next's own rules — the client/server mistakes the type system cannot see.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': next },
    // Without this the app-directory rules look for `pages/` at the repo root and warn on
    // every file that it is missing.
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
    },
  },
  {
    // Config files are plain scripts run by tooling, not part of a tsconfig project —
    // including the per-app ones, which is why this is `**/` and not the repo root. Type-aware
    // rules would be wrong anyway: Next types `headers()` as returning a promise, so an
    // `async` function with nothing to await is the required shape.
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
     * The service worker lives under `public/` — the only way to serve it from the origin
     * root, which is what gives it scope over the whole site. So it is outside every tsconfig
     * project, and its global scope is neither browser nor node.
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
    // stdout is a CLI script's entire interface, not a stray debug statement.
    files: ['scripts/**/*.ts', 'packages/*/scripts/**/*.ts', 'apps/*/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // A test double's shape is dictated by the interface it stands in for: every injected
    // seam here is typed as returning a promise, so the stub must be `async` with nothing
    // to await. Rewriting each as `Promise.resolve(...)` satisfies the rule and reads worse.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  prettier,
);
