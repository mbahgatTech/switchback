'use client';

import { HEATMAP_CLIP_M, heatmapCellMetres, plural } from '@switchback/core';
import type { AirQualityGrid, Heatmap } from '@switchback/core';
import { HEIGHT } from '../controls';
import { AIR_QUALITY_LEGEND } from './air-quality';
import { type BasemapId, GROUND_TINT, availableBasemaps } from './basemap';
import { HEATMAP_LEGEND } from './heatmap';
import { SLOPE_BANDS, SLOPE_BASELINE_M, SLOPE_MAP_MIN_ZOOM } from './slope';

/**
 * The sheet selector.
 *
 * A `<details>` rather than a popover: it is one element, it opens on Enter, it closes on
 * Escape, and it needs no state, no portal and no outside-click handler. The summary shows
 * the sheet you are on, so the control still says something useful while closed — which is
 * most of the time.
 *
 * The keys sit *outside* the disclosure, and that is deliberate. A legend folded away inside
 * the control that switched the layer on is a legend nobody reads, and a wash of red over a
 * mountainside with no key is worse than no overlay at all.
 *
 * **Opaque, not tinted.** This and the three keys below were `bg-surface/95` with a backdrop
 * blur, which looked like the right amount of restraint for a control sitting on a map and
 * was in fact the bug: a translucent panel has no fixed backdrop, so the contrast of the
 * muted text on it is set by whatever basemap the reader chose. `ink-muted` here measured
 * 4.19:1 over the dark canvas and would have been worse over satellite. Opaque it is 4.83:1
 * on every sheet, and the blur went with the alpha because nothing shows through to blur.
 * See the note on `SCHEMES` in `packages/ui` for the arithmetic.
 */

export interface LayerSwitchProps {
  basemap: BasemapId;
  onBasemapChange: (basemap: BasemapId) => void;
  hillshade: boolean;
  onHillshadeChange: (hillshade: boolean) => void;
  /**
   * The ground as a mesh rather than a picture of one. Offered only where the map has room to
   * be tilted — a 200-pixel-tall thumbnail pitched to 66° is a strip of sky.
   */
  terrain?: boolean;
  onTerrainChange?: (terrain: boolean) => void;
  /**
   * Omitted by any map that spends the survey plate on something else — the recorder and
   * the Lifeline sheet both mark the reader's own position in it.
   */
  slope?: boolean;
  onSlopeChange?: (slope: boolean) => void;
  /** Air quality over the viewport. Same rule as slope: omitted where red means the reader. */
  airQuality?: boolean;
  onAirQualityChange?: (airQuality: boolean) => void;
  /**
   * The grid currently painted, so the key can name the model that produced it and the hour
   * it is for. A legend that cannot say whose numbers these are is decoration.
   */
  airQualityGrid?: AirQualityGrid | null;
  /** Recorded activity over the viewport. Same omission rule as slope and air quality. */
  heatmap?: boolean;
  onHeatmapChange?: (heatmap: boolean) => void;
  /**
   * The grid currently painted, so the key can print the k that was applied and how many
   * cells it withheld. Both numbers are the point of the key, not a footnote to it.
   */
  heatmapGrid?: Heatmap | null;
  /**
   * The map's current zoom, when the caller tracks it. Slope is computed at one fixed zoom
   * (see `SLOPE_TILE_ZOOM`), so below a floor there is nothing on the map to read — and a key
   * at full strength over an unpainted mountainside reads as *this slope is gentle*. Passing
   * the zoom lets the key say *zoom in* instead of lying by omission.
   */
  zoom?: number;
}

/**
 * The width of the switcher's column, in px.
 *
 * Exported because it is not only this component's business: anything else pinned to the
 * top of the same map has to stop short of it, and the one place that does was carrying a
 * hand-converted `right-[16.5rem]` — 232 plus two gutters, worked out once by a person and
 * then frozen. Two numbers describing one edge is one number that will be wrong after the
 * next change here.
 *
 * 232 rather than a round 240 because the widest label the summary row has to hold on one
 * line is "Relief with contours", and 232 is where that stops wrapping at `text-caption`.
 */
export const LAYER_COLUMN_PX = 232;

export function LayerSwitch({
  basemap,
  onBasemapChange,
  hillshade,
  onHillshadeChange,
  terrain,
  onTerrainChange,
  slope,
  onSlopeChange,
  airQuality,
  onAirQualityChange,
  airQualityGrid,
  heatmap,
  onHeatmapChange,
  heatmapGrid,
  zoom,
}: LayerSwitchProps) {
  const bases = availableBasemaps();
  const current = bases.find((base) => base.id === basemap) ?? bases[0]!;

  return (
    <div style={{ width: LAYER_COLUMN_PX }}>
      <details className="group overflow-hidden rounded-panel border border-bezel bg-surface">
        <summary
          className={`flex cursor-pointer list-none items-center justify-between gap-sm px-md py-sm marker:hidden ${HEIGHT.panel} [&::-webkit-details-marker]:hidden`}
        >
          <span className="collar">Sheet</span>
          <span className="text-caption text-ink">{current.label}</span>
        </summary>

        <div className="border-t border-bezel p-md">
          <fieldset className="border-0 p-0">
            <legend className="sr-only">Base map</legend>
            <div className="flex flex-col gap-xs">
              {bases.map((base) => (
                <label
                  key={base.id}
                  className="flex cursor-pointer items-start gap-sm rounded-hair px-xs py-xs transition-colors duration-quick ease-standard hover:bg-bezel/40"
                >
                  <input
                    type="radio"
                    name="basemap"
                    checked={base.id === basemap}
                    onChange={() => onBasemapChange(base.id)}
                    className="mt-hair accent-ink"
                  />
                  <span className="min-w-0">
                    <span className="block text-caption text-ink">{base.label}</span>
                    <span className="block text-micro tracking-normal text-ink-muted">
                      {base.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="mt-md flex cursor-pointer items-start gap-sm border-t border-bezel px-xs pt-md">
            <input
              type="checkbox"
              checked={hillshade}
              onChange={(event) => onHillshadeChange(event.target.checked)}
              className="mt-hair accent-ink"
            />
            <span className="min-w-0">
              <span className="block text-caption text-ink">Hillshade</span>
              <span className="block text-micro tracking-normal text-ink-muted">
                Light from the northwest, as a sheet is drawn
              </span>
            </span>
          </label>

          {onTerrainChange ? (
            <label className="mt-sm flex cursor-pointer items-start gap-sm px-xs">
              <input
                type="checkbox"
                checked={terrain ?? false}
                onChange={(event) => onTerrainChange(event.target.checked)}
                className="mt-hair accent-ink"
              />
              <span className="min-w-0">
                <span className="block text-caption text-ink">3D terrain</span>
                <span className="block text-micro tracking-normal text-ink-muted">
                  Drag with the right button to tilt and turn
                </span>
              </span>
            </label>
          ) : null}

          {onSlopeChange ? (
            <label className="mt-sm flex cursor-pointer items-start gap-sm px-xs">
              <input
                type="checkbox"
                checked={slope ?? false}
                onChange={(event) => onSlopeChange(event.target.checked)}
                className="mt-hair accent-ink"
              />
              <span className="min-w-0">
                <span className="block text-caption text-ink">Slope angle</span>
                <span className="block text-micro tracking-normal text-ink-muted">
                  Shading from 27°, where slabs start to release
                </span>
              </span>
            </label>
          ) : null}

          {onAirQualityChange ? (
            <label className="mt-sm flex cursor-pointer items-start gap-sm px-xs">
              <input
                type="checkbox"
                checked={airQuality ?? false}
                onChange={(event) => onAirQualityChange(event.target.checked)}
                className="mt-hair accent-ink"
              />
              <span className="min-w-0">
                <span className="block text-caption text-ink">Air quality</span>
                <span className="block text-micro tracking-normal text-ink-muted">
                  European AQI this hour, one cell per model reading
                </span>
              </span>
            </label>
          ) : null}

          {onHeatmapChange ? (
            <label className="mt-sm flex cursor-pointer items-start gap-sm px-xs">
              <input
                type="checkbox"
                checked={heatmap ?? false}
                onChange={(event) => onHeatmapChange(event.target.checked)}
                className="mt-hair accent-ink"
              />
              <span className="min-w-0">
                <span className="block text-caption text-ink">Activity heatmap</span>
                <span className="block text-micro tracking-normal text-ink-muted">
                  Ground people have actually recorded hiking
                </span>
              </span>
            </label>
          ) : null}
        </div>
      </details>

      {slope ? <SlopeKey tooFarOut={zoom !== undefined && zoom < SLOPE_MAP_MIN_ZOOM} /> : null}
      {airQuality ? <AirQualityKey grid={airQualityGrid ?? null} /> : null}
      {heatmap ? <HeatmapKey grid={heatmapGrid ?? null} /> : null}
    </div>
  );
}

/**
 * The key, as an instrument reads: a continuous ramp with the thresholds marked beneath it,
 * and the unit in the corner rather than repeated on every mark.
 *
 * The swatches are painted with the identical `rgba` the map paints, so the key is a sample
 * of the layer and not an illustration of it. Five equal segments do not stand for equal
 * spans of angle — 35–45 is ten degrees where 27–30 is three — and the marks say so, since
 * each one sits at the left edge of the band it opens.
 *
 * Zoomed out past the floor the ramp is dimmed rather than hidden. Hiding it would leave the
 * reader who has just ticked the box with no evidence the tick did anything; dimming it says
 * *this exists, it is not drawn yet*, and the note says what to do about it.
 */
function SlopeKey({ tooFarOut }: { tooFarOut: boolean }) {
  return (
    <div className="mt-sm rounded-panel border border-bezel bg-surface p-md">
      <div className="flex items-baseline justify-between gap-sm">
        <span className="collar">Slope angle</span>
        <span className="font-mono text-micro text-ink-muted">deg</span>
      </div>

      <div
        className={`mt-sm flex h-[10px] overflow-hidden rounded-hair border border-bezel transition-opacity duration-quick ease-standard ${
          tooFarOut ? 'opacity-30' : ''
        }`}
        aria-hidden
      >
        {SLOPE_BANDS.map((band) => (
          <span key={band.fromDeg} className="flex-1" style={{ backgroundColor: band.css }} />
        ))}
      </div>

      <div className="mt-hair flex font-mono text-micro text-ink-muted" aria-hidden>
        {SLOPE_BANDS.map((band) => (
          <span key={band.fromDeg} className="flex-1">
            {band.fromDeg}
          </span>
        ))}
      </div>

      <p className="sr-only">
        Steeper ground is shaded more strongly, in bands of{' '}
        {SLOPE_BANDS.map((band) => band.range).join(', ')} degrees. Ground below 27 degrees is not
        shaded.
      </p>

      <p className="mt-sm text-micro tracking-normal text-ink-muted">
        {tooFarOut ? (
          <>
            Zoom in to read slope angle. The measurement is fixed at {SLOPE_BASELINE_M} m of ground
            so that an angle means the same thing at every scale, and from out here a single reading
            would cover most of a hillside.
          </>
        ) : (
          <>
            Measured over {SLOPE_BASELINE_M} m of ground, from a global elevation model. Enough to
            choose a line by, not to commit to one.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The air-quality key.
 *
 * Six bands, and the important thing about them is that the hue changes between the third
 * and the fourth. That break is not styling: 60 is where the European index enters "poor"
 * and where this product's own safety flags start firing, so the key, the map and the
 * warnings under a trail all step at the same number. Alpha still climbs across the break,
 * so the ramp reads as *worse* without relying on the hue.
 *
 * The footnote is the part that keeps this honest. A coloured square over a valley invites
 * the reader to believe it is about that valley; naming the model and the size of one cell
 * tells them how much ground the square is really claiming, which is often most of a county.
 */
function AirQualityKey({ grid }: { grid: AirQualityGrid | null }) {
  const empty = grid !== null && grid.cells.length === 0;

  return (
    <div className="mt-sm rounded-panel border border-bezel bg-surface p-md">
      <div className="flex items-baseline justify-between gap-sm">
        <span className="collar">Air quality</span>
        <span className="font-mono text-micro text-ink-muted">EU AQI</span>
      </div>

      <div
        className={`mt-sm flex h-[10px] overflow-hidden rounded-hair border border-bezel transition-opacity duration-quick ease-standard ${
          empty ? 'opacity-30' : ''
        }`}
        aria-hidden
      >
        {AIR_QUALITY_LEGEND.map((band) => (
          <span key={band.from} className="flex-1" style={{ backgroundColor: band.fill }} />
        ))}
      </div>

      <div className="mt-hair flex font-mono text-micro text-ink-muted" aria-hidden>
        {AIR_QUALITY_LEGEND.map((band) => (
          <span key={band.from} className="flex-1">
            {band.from}
          </span>
        ))}
      </div>

      <p className="sr-only">
        Bands of the European Air Quality Index:{' '}
        {AIR_QUALITY_LEGEND.map((band) => `${band.label} ${band.range}`).join(', ')}. Readings of 60
        and above are shaded red, which is where the index reads poor.
      </p>

      <p className="mt-sm text-micro tracking-normal text-ink-muted">
        {empty ? (
          <>
            Zoom in to read air quality. From out here one cell would cover several hundred
            kilometres, which is a weather system rather than an answer about a hike.
          </>
        ) : grid ? (
          <>
            {grid.model}, {grid.stepDeg}° cells — about {cellKm(grid.stepDeg)} km north to south.
            {grid.coarsened
              ? ' Coarsened for this view; zoom in for the model’s full grid.'
              : ''}{' '}
            Read at {readHour(grid.observedAt)}.
          </>
        ) : (
          <>Reading the current hour…</>
        )}
      </p>
    </div>
  );
}

/** A cell's height on the ground. North–south, because that figure holds at every latitude. */
function cellKm(stepDeg: number): number {
  return Math.round(stepDeg * 111);
}

/**
 * The heatmap key, and the one place the privacy floor is stated in words.
 *
 * A discrete ladder rather than the continuous ramp the other two keys use, because the
 * scale is discrete: 3, 10, 30, 100, 300 is roughly logarithmic, and stretching it into an
 * even ramp would put the same width on "3 to 10" as on "300 and up" and quietly claim the
 * layer resolves differences it does not.
 *
 * **The suppression line is not a disclaimer.** An empty overlay over a mountain range reads
 * as *nobody hikes here*, which is usually false and always unearned — what it really means
 * is that the corpus is young. Printing how many cells were withheld turns a broken-looking
 * map into an accurate one, and it leaks nothing: a count across a whole viewport says how
 * much is hidden without saying where any of it is. The floor itself comes off the response
 * rather than out of a constant here, so the key can never disagree with the query that
 * produced the cells.
 */
function HeatmapKey({ grid }: { grid: Heatmap | null }) {
  const nothing = grid !== null && grid.cells.length === 0;

  return (
    <div className="mt-sm rounded-panel border border-bezel bg-surface p-md">
      <div className="flex items-baseline justify-between gap-sm">
        <span className="collar">Recorded hiking</span>
        <span className="font-mono text-micro text-ink-muted">visits</span>
      </div>

      <div
        className={`mt-sm flex h-[10px] overflow-hidden rounded-hair border border-bezel transition-opacity duration-quick ease-standard ${
          nothing ? 'opacity-30' : ''
        }`}
        aria-hidden
      >
        {HEATMAP_LEGEND.map((band) => (
          // Each swatch is the band's fill over the ground tint the map settles to, which is
          // the only backdrop that makes the key predictive. Painted on the panel instead —
          // or on the app canvas, which is near-black — the two lowest bands of a near-white
          // wash are indistinguishable from each other and from the panel behind them, and a
          // reader would conclude the scale starts at "well hiked".
          <span key={band.from} className="flex-1" style={{ backgroundColor: GROUND_TINT }}>
            <span className="block h-full w-full" style={{ backgroundColor: band.fill }} />
          </span>
        ))}
      </div>

      <div className="mt-hair flex font-mono text-micro text-ink-muted" aria-hidden>
        {HEATMAP_LEGEND.map((band) => (
          <span key={band.from} className="flex-1">
            {band.from}
          </span>
        ))}
      </div>

      <p className="sr-only">
        Darker ground has been recorded more often, in bands of{' '}
        {HEATMAP_LEGEND.map((band) => `${band.label} ${band.range} visits`).join(', ')}.
      </p>

      <p className="mt-sm text-micro tracking-normal text-ink-muted">
        {grid ? (
          <>
            From {grid.tracks} public {plural(grid.tracks, 'recording')} over this view, in cells
            about {heatCellSize(grid.stepDeg)} across. The first and last {HEATMAP_CLIP_M} m of
            every track are dropped, and ground fewer than {grid.minHikers} separate people have
            hiked is never drawn.
            {grid.suppressed > 0 ? (
              <>
                {' '}
                {grid.suppressed} {plural(grid.suppressed, 'cell')} hidden here for that reason.
              </>
            ) : null}
            {grid.truncated ? ' Only the busiest cells are shown at this scale.' : ''}
          </>
        ) : (
          <>Reading recorded activity…</>
        )}
      </p>
    </div>
  );
}

/**
 * A cell's size for the key, in whichever unit reads as a size rather than as a number.
 *
 * Metres up to a kilometre and kilometres above it. The figure is at the equator and shrinks
 * with latitude, which is why it is hedged as "about" — a second number for the true width at
 * this latitude would be more precise and less useful, since the reader is being told roughly
 * how much ground one square claims, not measuring with it.
 */
function heatCellSize(stepDeg: number): string {
  const m = heatmapCellMetres(stepDeg);
  return m < 1_000 ? `${Math.round(m)} m` : `${Math.round(m / 100) / 10} km`;
}

/** The hour the model published, in the reader's own clock. */
function readHour(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'an unknown hour';
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
