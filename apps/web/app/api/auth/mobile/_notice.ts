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
const STYLE = `
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
  /*
   * The confirmation control. Hairline outline filled with ink, on the 44px touch rung
   * rather than the 34px instrument one: this renders on a phone, inside a browser sheet,
   * and it is the only thing on the page to press.
   */
  form { margin: 2rem 0 0 }
  button {
    font: 700 .6875rem/1 system-ui, sans-serif;
    letter-spacing: .14em; text-transform: uppercase;
    min-height: 44px; padding: 0 1.25rem;
    border: 1px solid #161C1D; border-radius: 2px;
    background: #161C1D; color: #EDF0EA; cursor: pointer;
  }
`;

export function notice(status: number, heading: string, body: string): Response {
  return new Response(page(heading, `<p class="body">${escape(body)}</p>`), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * The interstitial that turns a navigation into a decision.
 *
 * `/complete` used to mint a token pair on a GET, which meant any page on the internet could
 * navigate a signed-in browser to it and collect a sixty-day credential — `SameSite=Lax`
 * sends the session cookie on a top-level cross-site GET, because that is what Lax is for.
 * The answer is a POST that a reader has to press, carrying a token an attacker's page cannot
 * read. Both halves matter: the POST is what `SameSite=Lax` will not send cross-site, and the
 * token is what a same-site subdomain cannot forge.
 *
 * The device name is the app's own, trimmed and escaped and never trusted — it decorates the
 * question, it does not answer it.
 */
export function confirmation(options: {
  requestId: string;
  csrfToken: string;
  deviceName: string | null;
  setCookies: string[];
}): Response {
  const device = options.deviceName?.trim();
  const heading = device
    ? `Sign in to Switchback on ${device}?`
    : 'Sign in to Switchback on your app?';

  const html = page(
    heading,
    `<p class="body">The app asked this browser to finish signing it in. Press the button and the app takes over from here. If you did not start this on ${
      device ? escape(device) : 'a device of yours'
    }, close this page instead — nothing is signed in until you press it.</p>
  <form method="post">
    <input type="hidden" name="request" value="${escape(options.requestId)}">
    <input type="hidden" name="csrfToken" value="${escape(options.csrfToken)}">
    <button type="submit">Sign the app in</button>
  </form>`,
  );

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    // Never a cached decision: this page carries a one-time token and asks a question whose
    // answer mints a credential.
    'cache-control': 'private, no-store, max-age=0',
  });
  for (const cookie of options.setCookies) headers.append('set-cookie', cookie);
  return new Response(html, { status: 200, headers });
}

function page(heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(heading)} — ${escape(BRAND.name)}</title>
<style>${STYLE}</style>
</head>
<body>
  <main>
    <p class="collar">${escape(BRAND.name)}</p>
    <h1>${escape(heading)}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function escape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}
