import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A misspelt diagram directive is the one construct measured to break a block on GitHub, and it
 * reads like a diagram in review. The icon-pack rule sits here rather than in the GitHub check
 * because a block whose icons all resolve to `?` still renders, so counting `<svg>` cannot see it.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.claude',
  'dist',
  'build',
  'coverage',
]);

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : markdownFiles(join(dir, entry.name));
    }
    return entry.name.endsWith('.md') ? [join(dir, entry.name)] : [];
  });
}

interface Block {
  file: string;
  /** 1-indexed line of the opening fence, so a failure names somewhere to go. */
  line: number;
  body: string;
}

function mermaidBlocks(file: string): Block[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() !== '```mermaid') continue;
    const start = i;
    let end = i + 1;
    while (end < lines.length && lines[end]?.trim() !== '```') end += 1;
    blocks.push({
      file: file.slice(REPO_ROOT.length).replace(/\\/g, '/'),
      line: start + 1,
      body: lines.slice(start + 1, end).join('\n'),
    });
    i = end;
  }
  return blocks;
}

const BLOCKS = markdownFiles(REPO_ROOT).flatMap(mermaidBlocks);

/**
 * Directives GitHub's Mermaid build accepts. A diagram type it has gained since is added here the
 * first time one is used, which is the same failure that catches a typo — deliberately, because
 * from outside the renderer the two are the same mistake.
 */
const DIAGRAM_TYPES = new Set([
  'architecture-beta',
  'block-beta',
  'C4Component',
  'C4Container',
  'C4Context',
  'C4Deployment',
  'C4Dynamic',
  'classDiagram',
  'classDiagram-v2',
  'erDiagram',
  'flowchart',
  'flowchart-elk',
  'gantt',
  'gitGraph',
  'graph',
  'journey',
  'kanban',
  'mindmap',
  'packet-beta',
  'pie',
  'quadrantChart',
  'radar-beta',
  'requirementDiagram',
  'sankey-beta',
  'sequenceDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'timeline',
  'treemap-beta',
  'xychart-beta',
  'zenuml',
]);

/**
 * The directive a block opens with, past YAML frontmatter, an `%%{init}%%` block and comments.
 * `null` when nothing follows the preamble.
 */
function openingDirective(body: string): string | null {
  const lines = body.split('\n').map((line) => line.trim());
  let i = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close === -1) return null;
    i = close + 1;
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line === '' || line.startsWith('%%')) continue;
    return line.split(/[\s:]/u)[0] || null;
  }
  return null;
}

/**
 * `architecture-beta` resolves Iconify names from a CDN at render time and a fenced block cannot
 * call `registerIconPacks`, so GitHub draws every icon as `?` — around a diagram that otherwise
 * renders, which is why the GitHub check counts such a block as a success.
 */
const ICON_PACK = /architecture-beta|registerIconPacks/;

describe('the Mermaid blocks in the documentation', () => {
  it('finds the blocks it is meant to be guarding', () => {
    expect(BLOCKS.length).toBeGreaterThanOrEqual(12);
    expect([...new Set(BLOCKS.map((block) => block.file))]).toEqual(
      expect.arrayContaining(['docs/architecture.md', 'docs/auth-apple.md']),
    );
  });

  it('opens every block with a directive GitHub can parse', () => {
    const offenders = BLOCKS.filter(
      (block) => !DIAGRAM_TYPES.has(openingDirective(block.body) ?? ''),
    ).map((block) => `${block.file}:${block.line} ${openingDirective(block.body) ?? '(empty)'}`);
    expect(offenders).toEqual([]);
  });

  it('names no icon pack, which GitHub draws as a wall of `?`', () => {
    const offenders = BLOCKS.filter((block) => ICON_PACK.test(block.body)).map(
      (block) => `${block.file}:${block.line}`,
    );
    expect(offenders).toEqual([]);
  });
});

describe('the directive a block opens with', () => {
  it.each([
    ['stateDiagram-v2\n  [*] --> running', 'stateDiagram-v2'],
    ['flowchart LR\n  a --> b', 'flowchart'],
    ['---\ntitle: Estate\n---\nsequenceDiagram\n  a ->> b: x', 'sequenceDiagram'],
    ['%%{init: {"theme": "dark"} }%%\ngraph LR\n  a --> b', 'graph'],
    ['\n\n%% a note\npie title Share', 'pie'],
  ])('reads past any preamble to %j', (body, expected) => {
    expect(openingDirective(body)).toBe(expected);
  });

  it('reports a misspelling rather than repairing it', () => {
    expect(openingDirective('stateDiagramm-v2\n  [*] --> running')).toBe('stateDiagramm-v2');
    expect(DIAGRAM_TYPES.has('stateDiagramm-v2')).toBe(false);
  });

  it('is null when the block is preamble and nothing else', () => {
    expect(openingDirective('%% nothing follows\n\n')).toBeNull();
    expect(openingDirective('---\ntitle: unterminated')).toBeNull();
  });
});
