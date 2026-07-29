# Design direction

Switchback is for the person who checks the freezing level before a summit day. Not the
person looking for a pretty Sunday hike — that person is served well enough already. The
product's single job is to tell you what the trail will actually be like _at the hour you
will be standing there_, and the design has to make that job look like what it is:
instrument reading, not content browsing.

The reference points are topographic sheets, field guides, and baseplate compasses. Not
map SaaS. If a screen could carry any other company's logo without anyone noticing, it is
wrong.

---

## The system: five-plate

A USGS quadrangle is printed from five colour separations, and every hiker who reads maps
already knows the code without having been taught it. We borrow the separation wholesale
and give each plate one job in the product. **Colour is a legend here, not decoration** —
there is no fifth "brand blue" and no accent used because a section looked empty.

| Plate        | On the sheet          | In Switchback                                              |
| ------------ | --------------------- | ---------------------------------------------------------- |
| **contour**  | contours, relief      | elevation — the profile, gain/loss, grade, difficulty      |
| **water**    | hydrography, glaciers | weather and conditions — forecast, precip, freezing level  |
| **woodland** | vegetation            | the trail itself — surface, route lines, "easy", confirmed |
| **survey**   | grid, primary roads   | **you, now** — live position, off-route, safety flags      |
| **culture**  | labels, culture       | type, rules, structure                                     |

The survey plate is the load-bearing rule. **Red means you or your safety and nothing
else.** No red buttons, no red badges for "new", no red for a delete confirmation that
isn't dangerous. The moment red appears somewhere decorative, it stops working on the
ridge, which is the only place it has to work.

Consequence worth stating: difficulty is not a new colour scale. Easy is woodland, moderate
is contour, hard is survey — because hard genuinely is a safety statement. Three fewer
tokens and one fewer thing to learn.

### Measured, not eyeballed

Every ink clears 4.5:1 against every surface it is allowed on. On the light sheet the five
land between 5.18 and 5.42 — deliberately flat, so no plate outshouts another. A legend
where one entry is louder is a hierarchy pretending to be a legend.
`packages/ui/test/tokens.test.ts` asserts the ratios; changing an ink without changing the
test fails the build.

---

## Two schemes, one product

Not light-mode/dark-mode as a preference toggle. Two surfaces with different jobs:

- **field** (dark, `basalt`) — anywhere the map is. Chrome sits _with_ the terrain instead
  of glaring next to it, and it is the readable one at 5 a.m. in a car park and the one
  that does not wreck night vision.
- **sheet** (light, `#EDF0EA`) — anywhere you are reading. Trail descriptions, reviews,
  settings, the website's prose.

`sheet` is a woodland-tinted paper, the green-grey overprint of an Ordnance Survey sheet —
not the cream every AI-designed site has converged on. Cream is a bakery. This is a map.

Separation on the field scheme comes from a **bezel hairline**, not a drop shadow: `slate`
sits only 1.27:1 above `basalt`, and the 1px `bezel` rule is what makes the edge. That is
how an instrument reads, and soft shadows over a map look like a dialog left open.

---

## Type

Inverted from the usual, because field guides invert it: **gothic plate headers, serif
descriptive text.**

| Role        | Face           | Where                                                      |
| ----------- | -------------- | ---------------------------------------------------------- |
| **display** | Archivo (var)  | wordmark, headings, all UI labels and numbers              |
| **text**    | Source Serif 4 | prose — descriptions, reviews, anything read in paragraphs |
| **mono**    | IBM Plex Mono  | coordinates, grid references, axis ticks. Nothing else.    |

Archivo is variable on both weight and **width**, and the width axis is the restraint
valve. Normal width (100) does all the ordinary work. Condensed (78) with +0.14em tracking,
uppercase, at 11px is the **collar label** — the marginalia voice of a map sheet — and it
appears only where a map sheet would put collar text: section eyebrows, stat labels, legend
keys. Used everywhere it becomes wallpaper; that is the whole discipline.

The one place the two platforms genuinely diverge. React Native cannot drive an OpenType
width axis — `expo-font` registers one file under one family name, so the weight _is_ the
family and there is no axis to move. iOS therefore gets **Archivo Narrow**, Archivo's own
companion cut from the same foundry at very nearly `wdth: 78`, as a separate registered
face for the collar label alone. Same reason RN styles carry `fontFamily:
'Archivo_600SemiBold'` and never a `fontWeight`: asking for both makes iOS synthesise a
fake bold over a real one, which is the slightly-smeared text that gives a React Native app
away. `src/native.ts` holds the family table and `apps/mobile/app/_layout.tsx` registers
exactly its keys.

Source Serif's italic carries the hydrography convention: on a topo sheet water features
are always italic, so weather and conditions narrative is set in italic serif. Small thing,
free, and correct to anyone who reads sheets.

Scale is graduated like an altimeter, not a modular ratio pulled off a website: 11 · 13 ·
16 · 18 · 21 · 26 · 33 · 44 · 60 · 80. Tracking tightens as size grows because Archivo's
wide sizes need it.

---

## The signature: the section

Not a chart. A **section** — the cross-section panel drawn in the margin of a printed
trail guide.

```
   1 940 m ┤                                    ╭─────╮  ← 11:20 · 1 °C · gusts 61
           │                             ╭──────╯     ╰──╮
   1 400 m ┤                      ╭──────╯   ▓▓▓▓▓▓▓▓▓   ╰────╮
           │        ╭─────────────╯   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒    ╰──
     820 m ┤────────╯  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
           └────┬────────┬────────┬────────┬────────┬────────┬───
              0 km     2.4      4.8      7.2      9.6     12.0
              07:00                                        14:05
```

Three things make it ours rather than a stock area chart:

1. **Hatched terrain fill.** The mass below the profile line is filled with real hatching,
   and hatch _density_ encodes gradient severity. This is the one aesthetic risk in the
   direction and it earns its place functionally: a reader with any colour vision
   deficiency gets grade information from texture, without a second hue and without a
   second legend.
2. **Two axes of time.** Distance along the bottom, and the **arrival clock** under it,
   derived from the Tobler pace model. The section is the only place in the product where
   the flagship feature — weather at the hour you get there — is visible as one picture.
3. **Leader-line callouts**, set in collar type, pointing at the point they describe. A
   tooltip that appears on hover is a chart. A callout drawn on the sheet is a guide.

The same component ships on web (SVG) and iOS (react-native-svg). It is the thing someone
screenshots.

## The mark: a double blaze

A painted trail blaze is a 2:3 vertical rectangle. Two of them stacked, with the **top one
offset**, is the universal waymark for _the trail turns here_ — which is what a switchback
is. The product's name is already a graphic; we just draw it.

One shape, three jobs: app icon and wordmark; the "you are here" marker on the map (offset
in the direction of the next turn, so the mark is also instrumentation); and the turn
annotation on the section. No illustrated logo, no mountain-in-a-circle.

---

## Motion

Instrument motion: decisive, short, and only where it means something.

- The section **draws** on first paint, left to right, 640ms — the profile being plotted.
  It happens once per trail, not on every scroll.
- Everything else is 120–200ms on `cubic-bezier(0.2, 0, 0, 1)`.
- No ambient drift, no parallax, no scroll-jacked reveals.
- `prefers-reduced-motion` collapses every duration to 0 and the section renders complete.
  Not a toned-down variant — off.

---

## What we do not do

Cut, in the spirit of removing one accessory before leaving the house:

- No gradients. A hypsometric ramp is a stepped legend, not a blur.
- No glassmorphism over the map. It costs GPU on a phone that is also holding a GPS lock.
- No numbered `01 / 02 / 03` section markers. Nothing on a trail page is a sequence — a
  trail's stats are a set. The section's distance stations _are_ numbered, because those
  are real ordered measurements.
- No stock photography of people with backpacks looking at valleys.

---

## Where the tokens live

`packages/ui` is the single source. `src/tokens/*.ts` are the values; `theme.css` is the
Tailwind v4 `@theme` block for the web; `src/native.ts` is the React Native shape. The CSS
is hand-written rather than generated, because this repo has no build step for packages —
so `test/tokens.test.ts` parses `theme.css` and asserts every custom property equals its
TypeScript counterpart. Drift is a test failure, not a discovery six weeks later.
