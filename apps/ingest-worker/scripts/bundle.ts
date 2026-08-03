/**
 * Builds the deployable: `dist/` is the zip root the Function App runs from.
 *
 * A bundler rather than `tsc`, because the workspace packages are source-only — `main` points
 * at `src/index.ts` and nothing emits `dist/` — so a compiled entry point would have nothing
 * to require at runtime.
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = path.join(root, 'dist');

/**
 * Left out of the bundle. The Azure SDKs because they resolve their own transport and crypto
 * providers at runtime; the Prisma client because it loads a platform-specific query engine by
 * path, which a bundle rewrites away from.
 */
const EXTERNAL = ['@azure/functions', '@azure/identity', '@azure/service-bus'];
const PRISMA_EXTERNAL = ['@prisma/client', '.prisma/client'];

interface Manifest {
  version: string;
  dependencies: Record<string, string>;
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Manifest;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: path.join(dist, 'index.js'),
  bundle: true,
  platform: 'node',
  // Matches the Function App's runtime, not this machine's.
  target: 'node22',
  // CommonJS: `dist/package.json` below declares no `type`, and the Functions Node worker
  // loads the entry point with `require` unless told otherwise.
  format: 'cjs',
  sourcemap: true,
  external: [...EXTERNAL, ...PRISMA_EXTERNAL],
  logLevel: 'info',
});

await cp(path.join(root, 'host.json'), path.join(dist, 'host.json'));

/*
 * `npm install` runs **here**, inside this script, and **before** the Prisma client is copied
 * in. Both halves of that are load-bearing and the artefact silently fails to load without them.
 *
 * Inside the script, because the zip root is only a valid Node package once its dependencies
 * are beside the entry point, and a build step that leaves that to its caller is a build step
 * whose output cannot be checked.
 *
 * Before the copy, because `--omit=dev` prunes anything `dist/package.json` does not declare.
 * `@prisma/client` cannot be declared — npm would fetch the published package over the
 * generated one, which is the whole reason it is copied — so if it is already on disk when npm
 * runs, npm deletes it. It did: the deployed zip carried an empty `node_modules/@prisma/`
 * (`.prisma/` survived only because npm leaves dot-directories alone) and every start logged
 * `Cannot find module '@prisma/client'` followed by `0 functions found`.
 */
await writeFile(
  path.join(dist, 'package.json'),
  `${JSON.stringify(
    {
      name: 'switchback-ingest-worker',
      version: manifest.version,
      private: true,
      main: 'index.js',
      dependencies: Object.fromEntries(
        EXTERNAL.map((name) => [name, manifest.dependencies[name] ?? '*']),
      ),
    },
    null,
    2,
  )}\n`,
);

execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund'],
  { cwd: dist, stdio: 'inherit' },
);

/*
 * The generated Prisma client, copied rather than reinstalled: `npm install @prisma/client`
 * inside `dist/` would fetch the package and none of the generated code, and `prisma generate`
 * there would need the schema and the CLI. This is the artefact `npm run db:generate` already
 * produced, moved.
 */
for (const name of ['.prisma', '@prisma/client']) {
  const from = await resolveInstalled(name);
  await cp(from, path.join(dist, 'node_modules', name), { recursive: true });
}

console.log(`bundled to ${dist}`);

/**
 * Walk up for an installed package the way Node resolves one, rather than assuming it sits at
 * the repository root — inside a git worktree, `node_modules` belongs to the parent checkout.
 */
async function resolveInstalled(name: string): Promise<string> {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (await exists(candidate)) return candidate;
    if (path.dirname(dir) === dir) {
      throw new Error(`${name} is not installed — run \`npm run db:generate\` first`);
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
