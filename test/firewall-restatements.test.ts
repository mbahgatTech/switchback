import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Postgres firewall is the estate's absent network boundary, and the repository restates it in
 * prose, in a diagram, in two runtime comments and in the templates that declare it. Narrowing the
 * rule has to move every one of those, so the subject is every tracked file that names the boundary,
 * measured against the rules the templates put in front of ARM.
 *
 * Three readers decide whether that measurement is real, and each carries its own constraint:
 * `SUBJECT` chooses the files, `WHOLE_SPACE` decides what counts as a claim about the reach, and
 * `declaredFirewallRules` decides what counts as a rule.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/');

/** IPv4 is 2^32 addresses. A rule admitting that many admits everything. */
const ADDRESS_SPACE = 2 ** 32;

/**
 * The words the repository uses to name the address space. `WHOLE_SPACE` is built from these alone,
 * so the vocabulary a claim may use cannot drift from the vocabulary the file scan greps for.
 */
const SCOPE = ['IPv4', 'internet', 'address space'] as const;

/**
 * The words that name the boundary. They choose the files, so a file's place in the scan turns on
 * whether it names the firewall and not on how its claim happens to be worded — the same sentence
 * rewritten from `the whole IPv4 internet` to `the whole address space` must not take its file out
 * of the scan. They also put every file declaring a `firewallRules` resource in front of the reader.
 */
const SUBJECT = ['firewall', 'perimeter'] as const;

interface TrackedFile {
  path: string;
  text: string;
}

/**
 * Every tracked text file naming the boundary or carrying an address, as `git grep` decides.
 *
 * The tokens are loose on purpose: they are a superset of what the patterns below need, so a claim
 * wrapped across lines still leaves one of them on some line and the file is still read.
 */
function candidateFiles(): TrackedFile[] {
  const tokens = [String.raw`[0-9]{1,3}(\.[0-9]{1,3}){3}`, ...SCOPE, ...SUBJECT];
  const listed = execFileSync(
    'git',
    ['grep', '-I', '-l', '-i', '-E', '-z', ...tokens.flatMap((token) => ['-e', token]), '--', '.'],
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

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

interface FirewallRule {
  name: string;
  start: string;
  end: string;
  /** The file whose resource puts this range in front of ARM, which is not always where it is written. */
  declaredIn: string;
}

/** A bicep source with its comment text blanked; indexes still line up with the file. */
interface BicepSource {
  path: string;
  code: string;
}

const upTo = (source: string, token: string, from: number): number => {
  const at = source.indexOf(token, from);
  return at === -1 ? source.length : at;
};

const past = (source: string, token: string, from: number): number => {
  const at = source.indexOf(token, from);
  return at === -1 ? source.length : at + token.length;
};

/** The index just past a single-quoted string opened before `from`. Bicep strings do not wrap. */
function endOfQuoted(source: string, from: number): number {
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === '\\') {
      at += 1;
      continue;
    }
    if (source[at] === "'") return at + 1;
    if (source[at] === '\n') return at;
  }
  return source.length;
}

/**
 * The source with comment text replaced by spaces and its length unchanged. A `//` inside a string
 * is not a comment — these templates document themselves with URLs — so quoting is tracked as the
 * pass goes, and a `'''` block is skipped whole because its prose is not bicep.
 */
function blankComments(source: string): string {
  const out = [...source];
  let at = 0;

  while (at < source.length) {
    if (source.startsWith("'''", at)) {
      at = past(source, "'''", at + 3);
      continue;
    }
    if (source[at] === "'") {
      at = endOfQuoted(source, at + 1);
      continue;
    }
    const comment = source.startsWith('//', at)
      ? upTo(source, '\n', at)
      : source.startsWith('/*', at)
        ? past(source, '*/', at + 2)
        : -1;
    if (comment === -1) {
      at += 1;
      continue;
    }
    for (; at < comment; at += 1) if (source[at] !== '\n') out[at] = ' ';
  }

  return out.join('');
}

/** The index just past the bracket opened at `from`, counting only brackets that are not text. */
function blockEnd(code: string, from: number): number {
  let depth = 0;

  for (let at = from; at < code.length; at += 1) {
    if (code[at] === "'") {
      at = (code.startsWith("'''", at) ? past(code, "'''", at + 3) : endOfQuoted(code, at + 1)) - 1;
      continue;
    }
    if (code[at] === '{' || code[at] === '[') depth += 1;
    else if (code[at] === '}' || code[at] === ']') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }

  throw new Error('a bicep block is opened and never closed');
}

/**
 * Every `key: value` a block spells, at any depth, first spelling winning. Bicep separates
 * properties by line break, so the value is the rest of the line — which is why key order and an
 * interleaved comment change nothing here.
 */
function propertiesOf(block: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const line of block.split('\n')) {
    const property = /^\s*([A-Za-z_]\w*)\s*:\s*(\S.*?)\s*$/u.exec(line);
    const key = property?.[1];
    if (key !== undefined && !found.has(key)) found.set(key, property?.[2] ?? '');
  }

  return found;
}

const literalOf = (expression: string | undefined): string | undefined =>
  /^'([^']*)'$/u.exec(expression ?? '')?.[1];

/** Where a `param` or `var` of this name is bound to a value, across every source given. */
function bindingsOf(name: string, sources: readonly BicepSource[]): { code: string; at: number }[] {
  const binding = new RegExp(String.raw`(?:^|\n)(?:param|var)\s+${name}\b[^\n=]*=\s*`, 'gu');
  return sources.flatMap(({ code }) =>
    [...code.matchAll(binding)].map((match) => ({
      code,
      at: (match.index ?? 0) + match[0].length,
    })),
  );
}

/** The objects a bracket at `from` holds directly, skipping anything nested deeper. */
function objectsIn(code: string, from: number): Map<string, string>[] {
  const end = blockEnd(code, from);
  const found: Map<string, string>[] = [];

  for (let at = from + 1; at < end - 1; at += 1) {
    if (code[at] === "'") {
      at = (code.startsWith("'''", at) ? past(code, "'''", at + 3) : endOfQuoted(code, at + 1)) - 1;
      continue;
    }
    if (code[at] === '{' || code[at] === '[') {
      const close = blockEnd(code, at);
      if (code[at] === '{') found.push(propertiesOf(code.slice(at, close)));
      at = close - 1;
    }
  }

  return found;
}

/**
 * The objects a named `param` or `var` holds — one for an object, one per entry for a list, none
 * when nothing in these sources binds the name. Two bindings are ambiguous rather than empty, and
 * every caller turns an empty result into a failure that names the expression it could not read.
 */
function boundObjects(name: string, sources: readonly BicepSource[]): Map<string, string>[] {
  const bound = bindingsOf(name, sources);
  if (bound.length > 1)
    throw new Error(`${name} is bound ${bound.length} times, so its value cannot be read`);
  if (bound[0] === undefined) return [];

  const { code, at } = bound[0];
  if (code[at] === '[') return objectsIn(code, at);
  if (code[at] === '{') return [propertiesOf(code.slice(at, blockEnd(code, at)))];
  throw new Error(`${name} is bound to an expression this reader cannot evaluate`);
}

/**
 * A property's value as the literal address it carries, following one `identifier.field` step into
 * a loop variable or a bound object. `undefined` means the caller must fail rather than skip.
 */
function literalValue(
  expression: string | undefined,
  scope: Map<string, Map<string, string>>,
  sources: readonly BicepSource[],
): string | undefined {
  const direct = literalOf(expression);
  if (direct !== undefined) return direct;

  const path = /^(\w+)\.(\w+)$/u.exec(expression ?? '');
  if (path === null) return undefined;

  const holder = scope.get(path[1] ?? '') ?? boundObjects(path[1] ?? '', sources)[0];
  return holder === undefined ? undefined : literalOf(holder.get(path[2] ?? ''));
}

const FIREWALL_RESOURCE =
  /resource\s+\w+\s+'Microsoft\.DBforPostgreSQL\/flexibleServers\/firewallRules@[^']*'\s*=\s*/gu;

/** A copy loop over a named collection. Any other loop header is unreadable rather than empty. */
const LOOP = /^\[\s*for\s+(\w+)\s+in\s+(\w+)\s*:\s*/u;

/**
 * Every firewall rule the tracked bicep puts in front of ARM: one per literal resource, one per
 * entry of the collection a resource loops over. What the documents have to agree with is the range
 * that reaches ARM rather than the syntax that carried it, so a declaration this cannot reduce to a
 * literal range throws — an unreadable rule has to fail the suite, not leave the count short.
 */
function declaredFirewallRules(sources: readonly BicepSource[]): FirewallRule[] {
  const rules: FirewallRule[] = [];

  for (const { path, code } of sources)
    for (const declaration of code.matchAll(FIREWALL_RESOURCE)) {
      const at = (declaration.index ?? 0) + declaration[0].length;
      if (code[at] !== '{' && code[at] !== '[')
        throw new Error(`${path}: a firewall rule is declared in a form this reader cannot read`);

      const body = code.slice(at, blockEnd(code, at));
      const loop = code[at] === '[' ? LOOP.exec(body) : null;
      if (code[at] === '[' && loop === null)
        throw new Error(`${path}: a firewall rule list this reader cannot read`);

      const itemAt = loop === null ? 0 : loop[0].length;
      if (body[itemAt] !== '{') throw new Error(`${path}: a firewall rule with no properties`);
      const item = propertiesOf(body.slice(itemAt, blockEnd(body, itemAt)));

      const over = loop === null ? [undefined] : boundObjects(loop[2] ?? '', sources);
      if (over.length === 0)
        throw new Error(
          `${path}: a firewall rule loops over \`${loop?.[2] ?? ''}\`, which holds no rule ` +
            `this reader can read`,
        );

      for (const entry of over) {
        const scope = new Map(entry === undefined ? [] : [[loop?.[1] ?? '', entry]]);
        const read = (key: string): string => {
          const value = literalValue(item.get(key), scope, sources);
          if (value === undefined)
            throw new Error(
              `${path}: ${key} is \`${item.get(key) ?? 'absent'}\`, which this reader cannot ` +
                `reduce to a literal address`,
            );
          return value;
        };

        rules.push({
          name: read('name'),
          start: read('startIpAddress'),
          end: read('endIpAddress'),
          declaredIn: path,
        });
      }
    }

  if (rules.length === 0) throw new Error('the tracked bicep sources declare no firewall rule');
  return rules;
}

const TRACKED = candidateFiles();
const BICEP = TRACKED.filter(({ path }) => /\.bicep(?:param)?$/u.test(path)).map(
  ({ path, text }) => ({ path, code: blankComments(text) }),
);
const BICEP_PATHS = new Set(BICEP.map(({ path }) => path));

const RULES = declaredFirewallRules(BICEP);
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

const isDeclared = (range: { start: string; end: string }): boolean =>
  RULES.some((rule) => rule.start === range.start && rule.end === range.end);

/**
 * Every address range a file states. A range whose ends are equal is one host rather than a
 * perimeter — `0.0.0.0`–`0.0.0.0` is Azure's "Azure services only" sentinel, which the templates
 * name in order to say the deployed rule is deliberately not it.
 */
function statedRanges(file: TrackedFile): (Sighting & { range: { start: string; end: string } })[] {
  return sightings(file, STATED_RANGE)
    .map((sighting) => {
      const [start = '', end = ''] = sighting.captured;
      return { ...sighting, range: { start, end } };
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
 * Prose has no compiler, so the totality words are written out — but they are a field rather than a
 * list of sentences. `open to the internet` and `spanning the whole internet` are two different
 * sentences and one shape, and enumerating sentences catches neither. The nouns come from `SCOPE`
 * alone, so the vocabulary a claim may use cannot drift from the vocabulary this file greps for.
 */
const WHOLE_SPACE = new RegExp(
  String.raw`(?:all of|the whole(?: of)?|the entire|any(?:one|thing)?(?: on| from)|open to|reachable from|spann?(?:ing|s)(?: the)?)\s+(?:the\s+)?(?:public\s+)?(?:${SCOPE.join('|')})` +
    String.raw`|(?:${SCOPE.join('|')})-reachable`,
  'giu',
);

/** Whether a file names this boundary at all, which is what puts it under the coverage check. */
const MENTIONS_FIREWALL = new RegExp(`${SUBJECT.join('|')}|${only.name}`, 'iu');

/**
 * The files that name the boundary and say nothing measurable about how far it reaches: no claim in
 * totality words, no address range. Narrowing does not touch them.
 *
 * This is the complement of a derived set rather than a roster of what to check, and the assertion
 * is an equality, so a file joining it — a claim reworded into words the reader does not know, most
 * of all — fails the suite instead of quietly leaving the narrowing to-do list one item short.
 */
const SILENT_ON_REACH = [
  // Says the queue template declares no firewall rule of its own, which is true at any width.
  'infra/azure/ingest.bicep',
  // The American Perimeter Trail is a route, not a boundary.
  'packages/geo/src/section.ts',
  'packages/geo/test/section.test.ts',
];

const DOCUMENTS = TRACKED.filter(({ path }) => path !== SELF);

const claims = (file: TrackedFile): Sighting[] => sightings(file, WHOLE_SPACE);

const RUNBOOK = 'infra/azure/README.md';
const NARROWING = 'Narrowing the firewall';

/**
 * How many options the runbook tabulates for making the rule smaller, counted off the table itself.
 * Every sentence about them is a restatement — splitting one row in two is exactly what left
 * `main.bicep` telling an operator the section carries four of them.
 */
function tabulatedOptions(runbook: TrackedFile): number {
  const heading = runbook.text.indexOf(`### ${NARROWING}`);
  if (heading === -1) throw new Error(`${RUNBOOK} no longer has a "${NARROWING}" section`);

  const body = runbook.text.slice(upTo(runbook.text, '\n', heading) + 1);
  const ends = body.search(/^#{1,6} /mu);
  const rows = (ends === -1 ? body : body.slice(0, ends))
    .split('\n')
    .filter((line) => line.startsWith('|'));

  if (rows.length < 3) throw new Error(`"${NARROWING}" tabulates no options`);
  return rows.length - 2; // The header and the delimiter under it are not options.
}

const OPTIONS = tabulatedOptions(
  TRACKED.find(({ path }) => path === RUNBOOK) ?? { path: RUNBOOK, text: '' },
);

/** The words a document of this size would count in. Anything else is not a count. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

const countedAs = (word: string): number =>
  /^\d+$/u.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase());

/**
 * Every count of the narrowing options a file states, taken near the section's name because naming
 * the section is what tells a reader which options are being counted.
 */
function statedOptionCounts(file: TrackedFile): Sighting[] {
  const found = new Map<string, Sighting>();

  for (const mention of file.text.matchAll(new RegExp(NARROWING, 'giu'))) {
    const from = mention.index ?? 0;
    for (const stated of file.text.slice(from, from + 400).matchAll(/\b(\w+)\s+options?\b/giu)) {
      const at = from + (stated.index ?? 0);
      const sighting = {
        path: file.path,
        line: lineOf(file.text, at),
        text: stated[0],
        captured: [stated[1] ?? ''],
      };
      found.set(describeSighting(sighting), sighting);
    }
  }

  return [...found.values()];
}

describe('the documents that describe the Postgres firewall', () => {
  it('are enumerated by git, this file included', () => {
    // A `git grep` that matched nothing would make every assertion below vacuously true.
    expect(TRACKED.map(({ path }) => path)).toContain(SELF);
    expect(BICEP).not.toEqual([]);
  });

  it('yield a rule from every file whose resource declares one', () => {
    // Not "the parameter file parses": the file that spells the `firewallRules` resource is the one
    // whose syntax the reader has to survive, and this repository spells it as a loop.
    const declaring = DOCUMENTS.filter(({ text }) =>
      text.includes('flexibleServers/firewallRules@'),
    ).map(({ path }) => path);

    expect(declaring).not.toEqual([]);
    expect(declaring.filter((path) => !BICEP_PATHS.has(path))).toEqual([]);
    expect(declaring.filter((path) => !RULES.some((rule) => rule.declaredIn === path))).toEqual([]);
  });

  it('account for every address the templates spell in a rule property', () => {
    // The other side of the same hole: a declaration the reader walked past would leave its
    // addresses written here and in no rule.
    const spelled = BICEP.flatMap(({ path, code }) =>
      [...code.matchAll(/(?:start|end)IpAddress:\s*'([\d.]+)'/gu)].map((match) => ({
        path,
        address: match[1] ?? '',
      })),
    );
    const admitted = new Set(RULES.flatMap(({ start, end }) => [start, end]));

    expect(spelled).not.toEqual([]);
    expect(
      spelled.filter(({ address }) => !admitted.has(address)).map((seen) => JSON.stringify(seen)),
    ).toEqual([]);
  });

  it('state no range but the ones the templates declare', () => {
    expect(DOCUMENTS.flatMap(contradicting)).toEqual([]);
  });

  it('state that range somewhere other than the declaration', () => {
    const restating = DOCUMENTS.filter(
      (file) =>
        !BICEP_PATHS.has(file.path) && statedRanges(file).some(({ range }) => isDeclared(range)),
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
  });

  it('leave no file naming the firewall with nothing this reader can measure', () => {
    // A claim reworded during a tidy — the same sentence, in a phrasing the reader does not parse —
    // is the drift this catches. A file's place here turns only on whether it names the boundary,
    // so the rewording lands it in this list rather than in nothing.
    const silent = DOCUMENTS.filter(
      (file) =>
        MENTIONS_FIREWALL.test(normalize(file.text)) &&
        claims(file).length === 0 &&
        statedRanges(file).length === 0,
    ).map(({ path }) => path);

    expect(silent).toEqual(SILENT_ON_REACH);
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

  it('count the narrowing options as the runbook tabulates them', () => {
    const counted = DOCUMENTS.flatMap(statedOptionCounts).filter(
      ({ captured }) => countedAs(captured[0] ?? '') !== -1,
    );

    expect(counted).not.toEqual([]);
    expect(counted.filter(({ captured }) => countedAs(captured[0] ?? '') !== OPTIONS)).toEqual([]);
  });

  it('are checked against readers that fail loudly rather than matching nothing', () => {
    // The failure mode that kills a guard like this one: the declaration is rewritten, nothing
    // matches, and an empty rule set agrees with every document.
    expect(() => declaredFirewallRules([{ path: 'probe', code: 'param x string' }])).toThrow(
      /declare no firewall rule/u,
    );
    expect(() => declaredFirewallRules(BICEP)).not.toThrow();

    const probe = (bicep: string) => [{ path: 'probe', code: blankComments(bicep) }];
    const rule = (properties: string) =>
      `resource breakGlass 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = {\n  name: 'AllowRunners'\n  properties: {\n${properties}\n  }\n}`;
    const runners = [
      { name: 'AllowRunners', start: '20.0.0.0', end: '20.255.255.255', declaredIn: 'probe' },
    ];

    // One rule, one range, spelled every way bicep accepts. Key order and an interleaved comment
    // are punctuation, and none of these is a second rule.
    for (const properties of [
      "    startIpAddress: '20.0.0.0'\n    endIpAddress: '20.255.255.255'",
      "    endIpAddress: '20.255.255.255'\n    startIpAddress: '20.0.0.0'",
      "    startIpAddress: '20.0.0.0'\n    // Break-glass for the migration window.\n    endIpAddress: '20.255.255.255'",
      "    startIpAddress: '20.0.0.0'\n\n    endIpAddress: '20.255.255.255'",
    ])
      expect(declaredFirewallRules(probe(rule(properties))), properties).toEqual(runners);

    // An address reached through an identifier is the same rule as one written at the property.
    // The deployed rule arrives that way, through a loop variable rather than a `var`.
    const held = "var reserve = {\n  start: '20.0.0.0'\n  end: '20.255.255.255'\n}\n";
    const indirect = '    startIpAddress: reserve.start\n    endIpAddress: reserve.end';
    expect(declaredFirewallRules(probe(held + rule(indirect)))).toEqual(runners);

    // And with the variable gone the rule does not quietly disappear — it stops the suite.
    expect(() => declaredFirewallRules(probe(rule(indirect)))).toThrow(
      /cannot reduce to a literal address/u,
    );

    // A loop admits one rule per entry, which is how the deployed rule reaches ARM.
    const list =
      "param rules = [\n  {\n    name: 'A'\n    startIpAddress: '10.0.0.0'\n    endIpAddress: '10.0.0.255'\n  }\n  {\n    name: 'B'\n    endIpAddress: '20.255.255.255'\n    startIpAddress: '20.0.0.0'\n  }\n]\n";
    const looped = `resource many 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = [\n  for rule in rules: {\n    name: rule.name\n    properties: {\n      startIpAddress: rule.startIpAddress\n      endIpAddress: rule.endIpAddress\n    }\n  }\n]`;
    expect(declaredFirewallRules(probe(list + looped)).map(({ name }) => name)).toEqual(['A', 'B']);

    // And a loop over a collection these sources do not bind stops the suite rather than reporting
    // an estate with no rules in it.
    expect(() => declaredFirewallRules(probe(looped))).toThrow(
      /holds no rule this reader can read/u,
    );

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
      'the firewall spanning the whole address space',
    ])
      expect(claims({ path: 'probe', text: sentence }), sentence).toHaveLength(1);

    expect(claims({ path: 'probe', text: 'the inclusive IPv4 range it admits' })).toEqual([]);
  });
});
