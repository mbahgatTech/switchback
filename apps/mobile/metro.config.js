const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro, taught about the monorepo.
 *
 * Two changes are required and neither is optional:
 *
 * 1. **`watchFolders`** — the app imports `@switchback/core` and the *type* of
 *    `@switchback/api` from `../../packages`, which is outside the project root. Metro
 *    only watches and transforms files under folders it is told about, so without this a
 *    shared file edit either fails to resolve or silently serves a stale bundle.
 * 2. **`nodeModulesPaths`** — npm workspaces hoist almost everything to the root
 *    `node_modules`, but a package with a version conflict stays nested under
 *    `apps/mobile/node_modules`. Listing both, project-local first, matches Node's own
 *    resolution order.
 *
 * The shared packages ship TypeScript sources with no build step. That works because Metro
 * transforms everything it watches with `babel-preset-expo`, which handles `.ts` — the
 * same reason `packages/*` needs no `dist/`.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
