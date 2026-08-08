import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `id-switchback-infra-deploy`'s Contributor grant is subscription-scoped, and two workflow
 * comments described it as resource-group-scoped — understating the blast radius of the one
 * decision `grantInfraIdentityContributor` exists to hold back. The scope is derived from
 * `main.bicep` here rather than asserted, so adding a `scope:` to `infraContributor` moves the
 * expectation instead of quietly leaving the prose wrong.
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
}

const MAIN = read('infra/azure/main.bicep');

/**
 * Where an ARM role assignment declared in `main.bicep` actually lands. A `roleAssignments`
 * resource with no `scope:` inherits the file's `targetScope`; one with a `scope:` lands on
 * whatever that names.
 */
function grantScope(resourceName: string): string {
  const targetScope = /^targetScope\s*=\s*'([a-zA-Z]+)'/m.exec(MAIN)?.[1];
  const body = new RegExp(
    `resource ${resourceName} 'Microsoft\\.Authorization/roleAssignments@[^']+' = [^{]*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(MAIN)?.[1];
  if (targetScope === undefined || body === undefined) {
    throw new Error(`main.bicep declares no targetScope or no ${resourceName} role assignment`);
  }
  return /^\s{2}scope:/m.test(body) ? 'resource' : targetScope;
}

/** Contiguous runs of `#` comment lines, joined into one string each. */
function commentBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of source.split('\n')) {
    const comment = /^\s*#\s?(.*)$/.exec(line);
    if (comment) {
      current.push((comment[1] ?? '').trim());
      continue;
    }
    if (current.length > 0) blocks.push(current.join(' '));
    current = [];
  }
  if (current.length > 0) blocks.push(current.join(' '));
  return blocks;
}

function claimAbout(path: string, anchor: string): string {
  const found = commentBlocks(read(path)).filter((block) => block.includes(anchor));
  expect(found, `${path} has exactly one comment block mentioning "${anchor}"`).toHaveLength(1);
  return found[0] ?? '';
}

/** Every workflow comment that describes the infrastructure identity's Contributor grant. */
const CLAIMS = [
  { path: '.github/workflows/ci.yml', anchor: 'the infrastructure identity' },
  { path: '.github/workflows/infrastructure.yml', anchor: 'needs Contributor' },
];

describe("the infra-deploy identity's Contributor grant", () => {
  it('is declared at subscription scope in main.bicep', () => {
    expect(grantScope('infraContributor')).toBe('subscription');
  });

  it.each(CLAIMS)('is described as subscription-scoped in $path', ({ path, anchor }) => {
    const claim = claimAbout(path, anchor);
    expect(claim, path).toContain(grantScope('infraContributor'));
    expect(claim, path).not.toMatch(/Contributor on the (?:whole )?resource group/);
  });
});
