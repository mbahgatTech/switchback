import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Postgres firewall is the estate's absent network boundary, and four documents describe it
 * — two prose sections, the diagram conventions and the committed estate SVG. Each is derived
 * from the template here rather than asserted, so narrowing the rule moves the expectation onto
 * the documents instead of quietly leaving them describing a perimeter that no longer exists.
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
}

/** Files that may declare a firewall rule: the template that shapes it, the file that binds it. */
const DECLARING = ['infra/azure/postgres.bicep', 'infra/azure/main.bicepparam'];

interface FirewallRule {
  name: string;
  start: string;
  end: string;
}

/**
 * Every firewall rule `infra/azure` declares, whether written as a literal resource or as the
 * value of a parameter — both spell the same three keys, and what the documents have to agree
 * with is the range that reaches ARM, not the syntax that carried it.
 */
function declaredFirewallRules(sources: readonly string[]): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (const source of sources) {
    const range = /startIpAddress: '([\d.]+)'\s*\n\s*endIpAddress: '([\d.]+)'/g;
    for (const match of source.matchAll(range)) {
      const preceding = source.slice(0, match.index);
      const name = /name: '([^']+)'(?![\s\S]*?name: ')/.exec(preceding)?.[1];
      if (name === undefined) throw new Error('a firewall rule is declared with no name above it');
      rules.push({ name, start: match[1] ?? '', end: match[2] ?? '' });
    }
  }
  if (rules.length === 0) throw new Error(`${DECLARING.join(' and ')} declare no firewall rule`);
  return rules;
}

/** Backticks and line wrapping are typography; a range split over two lines is still the range. */
function normalize(document: string): string {
  return document.replaceAll('`', '').replace(/\s+/gu, ' ');
}

const RULES = declaredFirewallRules(DECLARING.map(read));
const only = RULES[0] as FirewallRule;

/** The declared range as any document may punctuate it. */
const span = new RegExp(
  `${only.start.replaceAll('.', '\\.')}\\s*.\\s*${only.end.replaceAll('.', '\\.')}`,
  'gu',
);

/** How many times a document states the declared range, however it punctuates or wraps it. */
function statesRange(path: string): number {
  return (normalize(read(path)).match(span) ?? []).length;
}

describe('the documents that describe the Postgres firewall', () => {
  it('name the range the template declares, wherever they name a range', () => {
    expect(statesRange('infra/azure/README.md')).toBe(2);
    expect(statesRange('docs/diagrams/estate.svg')).toBe(1);
  });

  it('describe one rule, and not the Azure-services special case that looks like it', () => {
    // 0.0.0.0-0.0.0.0 means "Azure services only" and would cut Vercel off while reading, at a
    // glance, as the same rule. Every document says "one" or "a single"; narrowing changes both.
    expect(RULES).toHaveLength(1);
    expect(only.end).not.toBe(only.start);
    expect(only.name).toBe('AllowVercelServerlessNoStaticEgress');

    for (const path of [
      'infra/azure/README.md',
      'docs/architecture.md',
      'docs/diagrams/README.md',
    ]) {
      expect(normalize(read(path)), path).toMatch(
        /(?:one|a single) firewall rule|a single rule spanning/u,
      );
    }
  });

  it('are checked against a declaration that fails loudly when it moves again', () => {
    // The failure mode that kills a guard like this one: the declaration is rewritten, nothing
    // matches, and an empty rule set agrees with every document.
    expect(() => declaredFirewallRules(['param x string'])).toThrow(/declare no firewall rule/u);
    expect(() => declaredFirewallRules(DECLARING.map(read))).not.toThrow();
  });
});
