# Diagrams

Two formats, chosen by what a diagram has to survive.

| Format                                  | Use for                                                                                                                     | Why                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Mermaid, fenced in the markdown**     | flow, sequence, state, and any structure diagram that needs no iconography                                                  | renders natively on GitHub, diffs as text, cannot go stale against a build step             |
| **Hand-authored SVG in this directory** | the estate diagram — anything needing service iconography, human figures, or a callout that has to be read before the prose | GitHub renders no icon pack (below), so an icon-bearing diagram must carry its own geometry |

## Why the estate diagram is not `architecture-beta`

Mermaid 11.16 supports `architecture-beta` with Iconify packs, and the packs are fetched from a CDN
at render time. That works in a controlled renderer and does not work on GitHub, so it fails the
only test that matters: **the diagram has to be right in both places.** Measured 2026-08-08.

| Renderer                                                             | `architecture-beta` layout | `logos:` icons                                   | `fa:fa-*` icons                          |
| -------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ | ---------------------------------------- |
| `@mermaid-js/mermaid-cli` 11.16.0, `--iconPacks @iconify-json/logos` | renders                    | **resolve** — 13 `<path>` elements, 14,625 bytes | n/a                                      |
| `@mermaid-js/mermaid-cli` 11.16.0, no `--iconPacks`                  | renders                    | placeholder — 1 `<path>`, 5,564 bytes            | n/a                                      |
| GitHub blob view (`viewscreen.githubusercontent.com`)                | renders                    | **every icon is a `?` placeholder**              | dropped silently, no icon element at all |

GitHub renders each Mermaid block inside a sandboxed iframe it controls. A fenced block cannot call
`mermaid.registerIconPacks(...)`, so no Iconify name can ever resolve there, CDN reachability
notwithstanding. The failure is silent and it is worse than no icon: a wall of `?` glyphs reads as a
broken document.

Hence `estate.svg`, hand-authored, no external reference of any kind.

## Conventions

- **Actors are human figures**, services are service marks. A box labelled "Reader" is a diagram
  that has not decided whether a person or a process is meant.
- **Deployment boundaries are drawn and named**: client, Vercel, Azure resource group, third party,
  GitHub Actions. A reader's first question is what can reach what.
- **Edges are labelled with the mechanism**, not the direction — the role name, the credential, the
  token audience. Blue is an Entra token, dashed amber is a password, grey is an unauthenticated
  public call.
- **An edge that does not exist is not drawn.** An aspirational one is dashed and labelled with what
  is missing.
- **A boundary that does not exist is named, not implied.** The estate has no virtual network:
  `publicNetworkAccess` is Enabled and one firewall rule spans all of IPv4, because Vercel
  serverless has no static egress address. Drawing a tidy perimeter around Azure would be the single
  most misleading thing the diagram could do, so the absence is a callout inside the Azure boundary.
- **Every value is the deployed one**, and the diagram carries the date it was measured.
- No external fonts, no CDN, no `<image href>`: the SVG must render offline and inside GitHub's
  sanitiser.

## Editing

`estate.svg` is plain SVG with a `<defs>` block of `<symbol>` icons and a `<style>` block of classes
— edit it as text. Then render it before committing, because a diagram that does not render is
worse than none:

```bash
npx --yes http-server . -p 8823 &
# open http://127.0.0.1:8823/estate.svg, or screenshot it headless
```

For Mermaid blocks, `mmdc` renders one at a time and exits non-zero on a parse error:

```bash
npx --yes @mermaid-js/mermaid-cli@11 -i diagram.mmd -o /tmp/out.svg
```

## A local Mermaid render is not evidence that GitHub renders

`mmdc` and GitHub are different renderers on different builds behind different configuration, so a
green `mmdc` run says a block parses somewhere and nothing about the only place readers see it.
What GitHub does with three constructs, measured by loading a pushed commit and reading
`svg#diagram` inside the iframe:

| In the block                            | `aria-roledescription` | What a reader gets                                                             |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `&lt;` in a label                       | `stateDiagram`         | The diagram, label reading `z < 11` — the markdown pipeline decodes the entity |
| `stateDiagramm-v2`                      | `error`                | "Syntax error in text", and the raw source                                     |
| `architecture-beta` with `logos:` names | `architecture`         | The diagram, every icon a `?` — a fenced block cannot call `registerIconPacks` |

Only the middle row is a rendering failure. An entity is a legibility problem in the source and
nothing more; icon names cost the diagram its icons but not its render, which is why no check that
counts `<svg>` can see them.

So, two checks answering different questions:

```bash
npm test -- test/mermaid-blocks.test.ts     # static: directive GitHub parses, no icon pack
npx tsx scripts/check-mermaid-github.ts     # real: loads the pushed ref on github.com
```

The first runs in the gates on every push. It reads the directive each block opens with and rejects
one Mermaid does not know, which is what a typo looks like from outside the renderer; it proves
nothing about rendering. The second drives a browser against
`https://github.com/<owner>/<repo>/blob/<ref>/<path>` and counts, per file, how many blocks became a
non-error `svg#diagram` inside the `viewscreen.githubusercontent.com` iframe GitHub mounts them in.
It runs in CI as `mermaid renders on github`, and needs the commit pushed, because it reads the site.

Changing a Mermaid block means running the second one and quoting its output. Nothing else counts.
