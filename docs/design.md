# Design

Switchback is for the person who checks the freezing level before a summit day. Its job is to
say what the trail will be like _at the hour you will be standing there_, so the design reads as
instrument, not as content: topographic sheets and baseplate compasses, not map SaaS.

## The five plates

A USGS quadrangle prints from five colour separations. We borrow the separation whole and give
each plate one job, so colour is a legend rather than decoration.

| Plate        | On the sheet          | In Switchback                                        |
| ------------ | --------------------- | ---------------------------------------------------- |
| **contour**  | contours, relief      | elevation — profile, gain, grade, distance           |
| **water**    | hydrography, glaciers | conditions — forecast, precipitation, freezing level |
| **woodland** | vegetation            | the trail itself — route lines, surface, "easy"      |
| **survey**   | grid, primary roads   | you, now — live position, off-route, safety          |
| **culture**  | labels, culture       | structure — type, rules, everything set in ink       |

Rules that follow from the legend, and that break it if broken:

- **Red (`survey`) means you or your safety and nothing else.** No red "new" badges, no red
  buttons, no red for a harmless delete. Decorative red stops working on the ridge.
- **Difficulty reuses three plates rather than adding a scale.** Easy is woodland, moderate is
  contour, hard is survey — hard genuinely is a safety statement.
- **Every ink clears 4.5:1 on every surface it is allowed on**, and the five land deliberately
  flat (5.18–5.42 on the light sheet) so no plate outshouts another.
  `packages/ui/test/tokens.test.ts` asserts the ratios; changing an ink fails the build.

## Two surfaces

Not a preference toggle — two surfaces with different jobs. **field** (dark) is anywhere the map
is: it sits with the terrain and does not wreck night vision at 5 a.m. **sheet** (light, a
woodland-tinted paper rather than cream) is anywhere you are reading.

![Switchback explore map at desktop width on the dark field surface: a left index rail listing four
trails with distance, ascent and difficulty, beside a full-height shaded-relief map of the Vesper
Peak area with the trail drawn as a pale green line.](screenshots/product/explore-1400.png)

![The same explore screen on the light sheet surface: the index rail is now woodland-tinted paper
with dark ink, while the map keeps its own terrain colours
unchanged.](screenshots/product/explore-light-1400.png)

The map keeps its terrain palette in both. Only the chrome around it changes surface.

![Explore at phone width: the map occupies the top half of the screen and the trail index scrolls
beneath it, with search, filters and sort between the
two.](screenshots/product/explore-390.png)

## A trail

![Vesper Peak summit trail at desktop width: collar labels reading Snohomish County, Out and back,
Hiking and Scrambling above the title; a red Hard dot with the note "raised by a sustained steep
pitch"; rows of outlined actions; then the route map with the trail in woodland green, its
trailhead and summit marked.](screenshots/product/trail-1400.png)

![The same trail page at phone width: title wrapping to two lines, actions reflowing to three rows,
and the route map below them.](screenshots/product/trail-390.png)

## The section

Not a chart — a **section**, the cross-section panel drawn in the margin of a printed trail guide.
It is the one picture that carries the flagship feature whole.

![The section for Vesper Peak on the light sheet: a contour-brown profile line over diagonal
hatching, leader-line callouts reading TRAILHEAD 07:00 4°C gusts 17 km/h and HIGH POINT 08:05 2°C
gusts 18 km/h, a metre axis at the left, and two axes under the plot — distance in kilometres and
elapsed moving time.](screenshots/product/section-1400.png)

Three things make it ours:

1. **Hatched terrain fill**, with hatch density encoding gradient — so grade survives any colour
   vision deficiency, without a second hue or a second legend.
2. **Two axes of time.** Distance along the bottom and the arrival clock beneath it, from the
   Tobler pace model.
3. **Leader-line callouts** in collar type, pointing at the point they describe. A hover tooltip
   would make it a chart; a callout drawn on the sheet keeps it a guide.

![The same section on the dark field surface: the profile line and hatching shift to the field
scheme's lighter contour orange and the callouts to its paler water blue, with the plate roles and
layout unchanged.](screenshots/product/section-dark-1400.png)

![The section at phone width, keeping its hatching, both callouts, the metre axis and both distance
and elapsed-time axes in a third of the width.](screenshots/product/section-390.png)

## Conditions along the route

![The along-trail forecast table: eight points sampled by distance down the left in mono, each with
an arrival time, altitude, temperature, wind, rain chance and sky, with the high-point row picked
out by a water-blue rule and wash.](screenshots/product/weather-1400.png)

## Recording against a trail

![The recording screen: a map filling the left with the trail drawn as a wide pale-green ribbon
cased in near-black, the recorded track a narrow orange thread down the centre of it and a red
survey dot at its head, and a readout column at the right carrying distance, elapsed and moving
time, ascent, pace, distance to finish, and an AHEAD strip whose silhouette of the trail is filled
woodland behind the hiker and a hairline in front, with a green marker on the
join.](screenshots/product/record-1400.png)

The two lines part on weight, not on hue. A finished hike draws no trail line at all — afterwards
two coincident lines read as one thick one — but recording, they are the plan and the doing, and
the reader needs to tell which is which everywhere they overlap.

## Near you, and offline

![Hikes near your location on the sheet surface: a mono distance-and-bearing column at the left,
then each trail's name, region, length, ascent, moving time, route type and a coloured difficulty
dot, ruled off by hairlines.](screenshots/product/nearby-1400.png)

![The same nearby list at phone width, the distance column and hairline rules
intact.](screenshots/product/nearby-390.png)

![The downloads screen with nothing downloaded yet: a collar label reading ON THIS DEVICE, the
heading Downloads, two paragraphs of serif prose explaining what a downloaded trail keeps, and a
single outlined FIND A TRAIL action.](screenshots/product/downloads-390.png)

## Type

Inverted from the usual, because field guides invert it: gothic plate headers, serif descriptive
text.

| Role        | Face           | Where                                                      |
| ----------- | -------------- | ---------------------------------------------------------- |
| **display** | Archivo (var)  | wordmark, headings, all UI labels and numbers              |
| **text**    | Source Serif 4 | prose — descriptions, reviews, anything read in paragraphs |
| **mono**    | IBM Plex Mono  | coordinates, grid references, axis ticks. Nothing else.    |

- **The collar label** is Archivo condensed (width 78) with +0.14em tracking, uppercase, at 11px,
  and it appears only where a map sheet puts collar text: section eyebrows, stat labels, legend
  keys. Used anywhere else it becomes wallpaper.
- **Weather and conditions narrative is italic serif**, following the hydrography convention that
  water features are always italic.
- **iOS gets Archivo Narrow for the collar label**, registered as its own face: React Native
  cannot drive an OpenType width axis. RN styles carry `fontFamily: 'Archivo_600SemiBold'` and
  never a `fontWeight` — asking for both makes iOS synthesise a fake bold over a real one.
- Scale is graduated like an altimeter, not a modular ratio: 11 · 13 · 16 · 18 · 21 · 26 · 33 ·
  44 · 60 · 80.

## The mark

A painted blaze is a 2:3 vertical rectangle; two stacked with the top one offset is the universal
waymark for _the trail turns here_, which is what a switchback is. One shape, three jobs: app icon
and wordmark, the "you are here" marker (offset toward the next turn, so the mark is also
instrumentation), and the turn annotation on the section.

## Standing rules

- **The design has no z-axis.** Depth is plate colour and hairline rules — never a shadow. On the
  field scheme `surface` sits only 1.27:1 above `canvas`, and the 1px `bezel` rule is what makes
  the edge. Soft shadows over a map read as a dialog left open.
- **Anything floating over the map is opaque.** No glassmorphism: it costs GPU on a phone that is
  also holding a GPS lock.
- **`ink-muted` is never faded further.** It is already the quietest text either scheme has, and
  `ink` → `ink-muted` is a drop from roughly 14:1 to 5:1.
- **No gradients.** A hypsometric ramp is a stepped legend, not a blur.
- **No numbered `01 / 02 / 03` section markers.** A trail's stats are a set, not a sequence. The
  section's distance stations are numbered because those are ordered measurements.
- **No stock photography** of people with backpacks looking at valleys.

## Motion

- The section draws once on first paint, left to right, 640ms — the profile being plotted.
- Everything else is 120–200ms on `cubic-bezier(0.2, 0, 0, 1)`.
- No ambient drift, no parallax, no scroll-jacked reveals.
- `prefers-reduced-motion` collapses every duration to 0 and the section renders complete. Off,
  not toned down.

## Where the tokens live

`packages/ui` is the single source: `src/tokens/*.ts` are the values, `theme.css` is the Tailwind
v4 `@theme` block, `src/native.ts` is the React Native shape. The CSS is hand-written because this
repo has no build step for packages, so `test/tokens.test.ts` parses `theme.css` and asserts every
custom property equals its TypeScript counterpart.

---

Screenshots are captured at 1400px and 390px against a live dev server; see
`docs/screenshots/product/`.
