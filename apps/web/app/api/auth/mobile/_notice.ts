import { BRAND } from '@switchback/core';

/**
 * A plain HTML page for the two mobile sign-in endpoints that a person can actually end up
 * looking at.
 *
 * Route handlers return `Response`, so there is no React and no Tailwind here — which is the
 * argument for keeping this page to a heading, a sentence, and nothing else rather than
 * hand-inlining the design system into a string. The colours are the `sheet` scheme's canvas
 * and ink, because this is a page to be read, and they are written as literals with the token
 * named beside them so a later divergence is at least visible.
 *
 * Nothing here links anywhere. It renders inside a system browser sheet the app opened, and
 * the only useful action is closing it and trying again in the app — a link would strand
 * someone in a browser they did not choose to be in.
 */
export function notice(status: number, heading: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(heading)} — ${escape(BRAND.name)}</title>
<style>
  :root { color-scheme: light }
  body {
    margin: 0; padding: 3rem 1.5rem;
    background: #EDF0EA;                                    /* sheet canvas */
    color: #161C1D;                                         /* sheet ink */
    font: 400 1rem/1.5 ui-serif, Georgia, 'Times New Roman', serif;
  }
  main { max-width: 34rem; margin: 0 auto }
  p.collar {
    margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .6875rem; letter-spacing: .14em; text-transform: uppercase;
    color: #5C6660;                                         /* sheet ink-muted */
  }
  h1 { margin: 1rem 0 0; font-size: 1.625rem; line-height: 1.25; letter-spacing: -.015em }
  p.body { margin: 1rem 0 0; max-width: 54ch; color: #5C6660 }
</style>
</head>
<body>
  <main>
    <p class="collar">${escape(BRAND.name)}</p>
    <h1>${escape(heading)}</h1>
    <p class="body">${escape(body)}</p>
  </main>
</body>
</html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function escape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}
