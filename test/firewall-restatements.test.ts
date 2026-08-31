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
 *
 * **A prose claim is read as a shape, not as a sentence.** The revision after that listed five
 * whole phrasings, and two `@description` blocks in `main.bicep` — the rationale for the random
 * server suffix and for the least-privilege role — matched none of them, so a complete narrowing
 * left both asserting the whole internet with the suite green. A claim is now any totality word
 * governing one of the two scope nouns that also choose the files, and every failure names a line
 * rather than a file, because being pointed at `main.bicep` for one of three claims fixes one.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/');

/** IPv4 is 2^32 addresses. A rule admitting that many admits everything. */
const ADDRESS_SPACE = 2 ** 32;

/**
 * The two words the repository uses to name the address space. They choose the files below, and
 * they anchor every claim about how much of it the rule admits.
 */
const SCOPE = ['IPv4', 'internet'] as const;

interface TrackedFile {
  path: string;
  text: string;
}

/**
 * Every tracked text file containing an address or one of the scope nouns, as `git grep` decides.
 *
 * The tokens are loose on purpose: they are a superset of what the patterns below need, so a claim
 * wrapped across lines still leaves one of them on some line and the file is still read.
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
      ...SCOPE.flatMap((noun) => ['-e', noun]),
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

interface Sighting {
  path: string;
  line: number;
  text: string;
  captured: string[];
}

/**
 * Every match of `pattern` in a file, at the line it starts on. Each line is read together with
 * the one after it so a claim broken across a line break is still one string, and a match is
 * attributed to the later line only when it begins there — otherwise the wrap reports twice.
 */
function sightings(file: TrackedFile, pattern: RegExp): Sighting[] {
  const lines = file.text.split('\n');
  const found: Sighting[] = [];

  lines.forEach((line, at) => {
    const own = normalize(line);
    const window = `${own} ${normalize(lines[at + 1] ?? '')}`;
    for (const match of window.matchAll(pattern)) {
      if ((match.index ?? 0) > own.length) continue;
      found.push({
        path: file.path,
        line: at + 1,
        text: match[0].trim(),
        captured: match.slice(1).map((group) => group ?? ''),
      });
    }
  });

  return found;
}

const describeSighting = ({ path, line, text }: Sighting): string => `${path}:${line} ${text}`;

interface FirewallRule {
  name: string;
  start: string;
  end: string;
}

const TRACKED = candidateFiles();
const BICEP = TRACKED.filter(({ path }) => /\.bicep(?:param)?$/u.test(path));

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

const ADDRESS = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;

/** A range as any file may punctuate it: a dash of any width, or the word an operator writes. */
const STATED_RANGE = new RegExp(
  String.raw`(${ADDRESS})(?:\s*[-–—]\s*|\s+(?:to|through|until)\s+)(${ADDRESS})`,
  'giu',
);

const isDeclared = (range: FirewallRule): boolean =>
  range.start === only.start && range.end === only.end;

/**
 * Every address range a file states. A range whose ends are equal is one host rather than a
 * perimeter — `0.0.0.0`–`0.0.0.0` is Azure's "Azure services only" sentinel, which the templates
 * name in order to say the deployed rule is deliberately not it.
 */
function statedRanges(file: TrackedFile): (Sighting & { range: FirewallRule })[] {
  return sightings(file, STATED_RANGE)
    .map((sighting) => {
      const [start = '', end = ''] = sighting.captured;
      return { ...sighting, range: { name: '', start, end } };
    })
    .filter(({ range }) => range.start !== range.end);
}

const contradicting = (file: TrackedFile): string[] =>
  statedRanges(file)
    .filter(({ range }) => !isDeclared(range))
    .map(describeSighting);

/**
 * A claim that the rule admits the whole address space: a totality word governing a scope noun.
 *
 * Prose has no compiler, so the totality words are written out — but they are a field rather than
 * a list of sentences, which is what the previous revision got wrong. `open to the internet` and
 * `spanning the whole internet` are two different sentences and one shape, and enumerating
 * sentences missed both. The scope nouns are the ones that chose the files, so a claim can only
 * live in a file this scan is already reading.
 */
const WHOLE_SPACE = new RegExp(
  String.raw`(?:all of|the whole(?: of)?|the entire|any(?:one|thing)?(?: on| from)|open to|reachable from|spann?(?:ing|s)(?: the)?)\s+(?:the\s+)?(?:public\s+)?(?:${SCOPE.join('|')}|address space)` +
    String.raw`|(?:${SCOPE.join('|')})-reachable`,
  'giu',
);

/** Whether a file describes the firewall's reach at all, which is what makes a missing claim a hole. */
const DESCRIBES_FIREWALL = new RegExp(
  String.raw`(?:firewall|perimeter|${only.name})[\s\S]{0,400}?(?:${SCOPE.join('|')})|(?:${SCOPE.join('|')})[\s\S]{0,400}?(?:firewall|perimeter|${only.name})`,
  'iu',
);

const DOCUMENTS = TRACKED.filter(({ path }) => path !== SELF);

const claims = (file: TrackedFile): Sighting[] => sightings(file, WHOLE_SPACE);

describe('the documents that describe the Postgres firewall', () => {
  it('are enumerated by git, this file included', () => {
    // A `git grep` that matched nothing would make every assertion below vacuously true.
    expect(TRACKED.map(({ path }) => path)).toContain(SELF);
    expect(BICEP).not.toEqual([]);
  });

  it('are read for a declaration wherever bicep spells one, not only in the parameter file', () => {
    // A break-glass rule added as a literal `firewallRules` resource is a second rule in the
    // estate. An extension test that excluded every `.bicep` file could not see one.
    const declaring = DOCUMENTS.filter(({ text }) => /startIpAddress|firewallRules@/u.test(text));
    expect(declaring).not.toEqual([]);
    expect(declaring.filter((file) => !BICEP.includes(file)).map(({ path }) => path)).toEqual([]);
  });

  it('state no range but the one the templates declare', () => {
    expect(DOCUMENTS.flatMap(contradicting)).toEqual([]);
  });

  it('state that range somewhere other than the declaration', () => {
    const restating = DOCUMENTS.filter(
      (file) => !BICEP.includes(file) && statedRanges(file).some(({ range }) => isDeclared(range)),
    );
    expect(restating.map(({ path }) => path)).not.toEqual([]);
  });

  it('claim the whole address space only while the rule admits it', () => {
    const stated = DOCUMENTS.flatMap(claims);

    if (!spansEverything) {
      expect(stated.map(describeSighting)).toEqual([]);
      return;
    }

    expect(stated).not.toEqual([]);

    // Every file that describes the firewall's reach carries at least one claim this reader can
    // see. A file that describes it in words the reader does not know is a file narrowing would
    // leave behind, and this is the moment — while the rule is still wide — to find out.
    const blind = DOCUMENTS.filter(
      (file) => DESCRIBES_FIREWALL.test(normalize(file.text)) && claims(file).length === 0,
    );
    expect(blind.map(({ path }) => path)).toEqual([]);
  });

  it('describe one rule, and not the Azure-services special case that looks like it', () => {
    // 0.0.0.0-0.0.0.0 means "Azure services only" and would cut Vercel off while reading, at a
    // glance, as the same rule. Every document says "one" or "a single"; narrowing changes both.
    expect(RULES).toHaveLength(1);
    expect(only.end).not.toBe(only.start);
    expect(only.name).toBe('AllowVercelServerlessNoStaticEgress');
    expect(
      DOCUMENTS.flatMap((file) =>
        sightings(file, /(?:one|a single) firewall rule|a single rule spanning/giu),
      ),
    ).not.toEqual([]);
  });

  it('are checked against readers that fail loudly rather than matching nothing', () => {
    // The failure mode that kills a guard like this one: the declaration is rewritten, nothing
    // matches, and an empty rule set agrees with every document.
    expect(() => declaredFirewallRules(['param x string'])).toThrow(/declare no firewall rule/u);
    expect(() => declaredFirewallRules(BICEP.map(({ text }) => text))).not.toThrow();

    // A literal resource declares the same rule as a parameter value, in different syntax.
    const literal = `resource breakGlass 'x' = {\n  name: 'AllowRunners'\n  properties: {\n    startIpAddress: '20.0.0.0'\n    endIpAddress: '20.255.255.255'\n  }\n}`;
    expect(declaredFirewallRules([literal])).toEqual([
      { name: 'AllowRunners', start: '20.0.0.0', end: '20.255.255.255' },
    ]);

    // The range reader sees a range wherever a document may put one, in either punctuation, and
    // rejects a wrong one. Prose says "to" as readily as it says a dash.
    const wrapped = `// spanning ${only.start}–\n// ${only.end} today`;
    expect(contradicting({ path: 'probe', text: wrapped })).toEqual([]);

    const near = toAddress(toInt(only.end) - 1);
    expect(
      contradicting({ path: 'probe', text: `the rule is \`${only.start}\`–\`${near}\`` }),
    ).toEqual([`probe:1 ${only.start}–${near}`]);
    expect(contradicting({ path: 'probe', text: `spanning ${only.start} to ${near}` })).toEqual([
      `probe:1 ${only.start} to ${near}`,
    ]);

    // And the claim reader sees a totality word governing a scope noun, not a memorized sentence.
    for (const sentence of [
      'The firewall below is open to the internet',
      'a firewall spanning the whole internet',
      'one firewall rule spans all of IPv4',
      'an internet-reachable endpoint',
    ])
      expect(claims({ path: 'probe', text: sentence }), sentence).toHaveLength(1);

    expect(claims({ path: 'probe', text: 'the inclusive IPv4 range it admits' })).toEqual([]);
  });
});
