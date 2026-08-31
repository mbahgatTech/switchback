import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Postgres firewall is the estate's absent network boundary, and the repository restates it in
 * prose, in a diagram, in two runtime comments and in the templates that declare it. Narrowing the
 * rule has to move every one of those, so the subject here is every tracked file that mentions an
 * address or a boundary, measured against the declared rule.
 *
 * **Git chooses the files, not a list.** An earlier revision named two documents and counted the
 * *new* range in each. Narrowing the parameter and updating those two left five statements of the
 * old perimeter standing across four files — `postgres.bicep` and `env.ts` among them — with the
 * suite green, because a range nobody listed was a range nobody counted.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/');

/** IPv4 is 2^32 addresses. A rule admitting that many admits everything. */
const ADDRESS_SPACE = 2 ** 32;

interface TrackedFile {
  path: string;
  text: string;
}

/**
 * Every tracked text file containing an address, `IPv4` or `internet`, as `git grep` decides it.
 *
 * The tokens are loose on purpose: they are a superset of what the patterns below need, so a claim
 * wrapped across lines still leaves one of them on some line and the file is still read. A phrasing
 * built from neither token would escape this, which is what the vocabulary check guards — it fails
 * when a phrasing stops matching anywhere.
 */
function candidateFiles(): TrackedFile[] {
  const listed = execFileSync(
    'git',
    [
      'grep',
      '-I',
      '-l',
      '-i',
      '-E',
      '-z',
      '-e',
      String.raw`[0-9]{1,3}(\.[0-9]{1,3}){3}`,
      '-e',
      'IPv4',
      '-e',
      'internet',
      '--',
      '.',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  const paths = listed.split('\0').filter((path) => path !== '');
  if (paths.length === 0) throw new Error('git grep matched no file: the scan would be vacuous');
  return paths.map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }));
}

/**
 * Comment markers and line wrapping are typography. Stripping them lets a claim split across two
 * `//` lines read as the one sentence it is, and a range split by a line break read as the range.
 */
function normalize(document: string): string {
  return document
    .replaceAll('`', '')
    .replace(/^[ \t]*(?:\/{2,}|\*)[ \t]?/gmu, ' ')
    .replace(/\s+/gu, ' ');
}

interface FirewallRule {
  name: string;
  start: string;
  end: string;
}

const TRACKED = candidateFiles();
const BICEP = TRACKED.filter(({ path }) => /\.bicepparam?$/u.test(path));

/**
 * Every firewall rule the tracked bicep sources declare, wherever they declare it — a literal
 * resource and a parameter value spell the same three keys, and what the documents have to agree
 * with is the range that reaches ARM rather than the syntax that carried it.
 */
function declaredFirewallRules(sources: readonly string[]): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (const source of sources) {
    const range = /startIpAddress: '([\d.]+)'\s*\n\s*endIpAddress: '([\d.]+)'/gu;
    for (const match of source.matchAll(range)) {
      const preceding = source.slice(0, match.index);
      const name = /name: '([^']+)'(?![\s\S]*?name: ')/u.exec(preceding)?.[1];
      if (name === undefined) throw new Error('a firewall rule is declared with no name above it');
      rules.push({ name, start: match[1] ?? '', end: match[2] ?? '' });
    }
  }
  if (rules.length === 0) throw new Error('the tracked bicep sources declare no firewall rule');
  return rules;
}

const RULES = declaredFirewallRules(BICEP.map(({ text }) => text));
const only = RULES[0] as FirewallRule;

const toInt = (address: string): number =>
  address.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);

const toAddress = (value: number): string =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');

const spansEverything =
  RULES.length === 1 && toInt(only.end) - toInt(only.start) + 1 === ADDRESS_SPACE;

/** A range as any file may punctuate it, once backticks and line breaks are normalized away. */
const STATED_RANGE = /(\d{1,3}(?:\.\d{1,3}){3})\s*[-–—]\s*(\d{1,3}(?:\.\d{1,3}){3})/gu;

const isDeclared = (range: FirewallRule): boolean =>
  range.start === only.start && range.end === only.end;

/**
 * Every address range a file states. A range whose ends are equal is one host rather than a
 * perimeter — `0.0.0.0`–`0.0.0.0` is Azure's "Azure services only" sentinel, which the templates
 * name in order to say the deployed rule is deliberately not it.
 */
function statedRanges(text: string): FirewallRule[] {
  const ranges: FirewallRule[] = [];
  for (const [, start = '', end = ''] of normalize(text).matchAll(STATED_RANGE)) {
    if (start !== end) ranges.push({ name: '', start, end });
  }
  return ranges;
}

const contradicting = (file: TrackedFile): string[] =>
  statedRanges(file.text)
    .filter((range) => !isDeclared(range))
    .map((range) => `${file.path}: ${range.start}–${range.end}`);

/**
 * Phrasings that assert the rule admits the whole address space. Prose has no compiler, so this
 * vocabulary is written out — but it is held to the tree below rather than trusted: a phrasing that
 * matches nothing has been reworded out of the repository and no longer guards anything.
 */
const WHOLE_SPACE: readonly RegExp[] = [
  /all of IPv4/iu,
  /the whole of IPv4/iu,
  /the whole IPv4 (?:internet|range)/iu,
  /spans the entire internet/iu,
  /rule spanning the internet/iu,
];

/**
 * Files carrying a phrasing — this one excluded, because it is where the phrasings are written and
 * a vocabulary that matched only itself would report coverage it does not have.
 */
const carrying = (claim: RegExp): string[] =>
  TRACKED.filter(({ path, text }) => path !== SELF && claim.test(normalize(text))).map(
    ({ path }) => path,
  );

describe('the documents that describe the Postgres firewall', () => {
  it('are enumerated by git, this file included', () => {
    // A `git grep` that matched nothing would make every assertion below vacuously true.
    expect(TRACKED.map(({ path }) => path)).toContain(SELF);
    expect(BICEP).not.toEqual([]);
  });

  it('state no range but the one the templates declare', () => {
    expect(TRACKED.flatMap(contradicting)).toEqual([]);
  });

  it('state that range somewhere other than the declaration', () => {
    const restating = TRACKED.filter(
      (file) => !BICEP.includes(file) && statedRanges(file.text).some(isDeclared),
    );
    expect(restating.map(({ path }) => path)).not.toEqual([]);
  });

  it('claim the whole address space only while the rule admits it', () => {
    if (!spansEverything) {
      expect(WHOLE_SPACE.flatMap(carrying)).toEqual([]);
      return;
    }

    // Each phrasing still matches, so a reword that orphans one fails here rather than silently
    // narrowing what this test can see.
    for (const claim of WHOLE_SPACE) expect(carrying(claim), String(claim)).not.toEqual([]);
  });

  it('describe one rule, and not the Azure-services special case that looks like it', () => {
    // 0.0.0.0-0.0.0.0 means "Azure services only" and would cut Vercel off while reading, at a
    // glance, as the same rule. Every document says "one" or "a single"; narrowing changes both.
    expect(RULES).toHaveLength(1);
    expect(only.end).not.toBe(only.start);
    expect(only.name).toBe('AllowVercelServerlessNoStaticEgress');
    expect(carrying(/(?:one|a single) firewall rule|a single rule spanning/iu)).not.toEqual([]);
  });

  it('are checked against readers that fail loudly rather than matching nothing', () => {
    // The failure mode that kills a guard like this one: the declaration is rewritten, nothing
    // matches, and an empty rule set agrees with every document.
    expect(() => declaredFirewallRules(['param x string'])).toThrow(/declare no firewall rule/u);
    expect(() => declaredFirewallRules(BICEP.map(({ text }) => text))).not.toThrow();

    // The range reader sees a range wherever a document may put one, and rejects a wrong one.
    const wrapped = `// spanning ${only.start}–\n// ${only.end} today`;
    expect(contradicting({ path: 'probe', text: wrapped })).toEqual([]);

    const stale = `the rule is \`${only.start}\`–\`${toAddress(toInt(only.end) - 1)}\``;
    expect(contradicting({ path: 'probe', text: stale })).toHaveLength(1);
  });
});
