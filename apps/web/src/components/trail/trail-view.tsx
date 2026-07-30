'use client';

import { useMemo, useState } from 'react';
import type { AlongRouteForecast, TrailDetail, UnitSystem, WeatherSample } from '@switchback/core';
import { clockOf, formatSpeed, formatTemperature } from '@switchback/core';
import { hikedProfile, planFlyover, positionAt, terrainFactorFor } from '@switchback/geo';
import type { SectionCallout } from '../section';
import { useUnitsOr } from '../units';
import { type BasemapId } from '../map/basemap';
import { LayerSwitch } from '../map/layer-switch';
import { FlyoverControl } from './flyover-control';
import { TrailProfile } from './profile';
import { RouteMap } from './route-map';

/**
 * The route and its section, reading as one instrument.
 *
 * Stacked rather than side by side, and that is the whole layout decision. The section's
 * cursor is a full-height rule; with the map directly above it the rule points at the
 * ground it describes, and the eye travels a few centimetres straight up rather than across
 * a gutter and back. Side by side the two would be a chart and a map that happen to be
 * about the same trail.
 *
 * State lives here because both children need it and neither owns it. It is one number.
 *
 * The forecast arrives from the planner above and is turned into two collar annotations
 * before it reaches the graphic. That is the whole point of the 76px of headroom the
 * section reserves: the flagship feature — the weather at the hour you get there — has to
 * be legible as one picture, on the profile, not only as a table below it.
 */

export interface TrailViewProps {
  trail: TrailDetail;
  /** Along-route weather, once it has loaded. Drives the section's collar annotations. */
  forecast?: AlongRouteForecast | null;
  units?: UnitSystem;
}

export function TrailView({ trail, forecast = null, units: given }: TrailViewProps) {
  const units = useUnitsOr(given);
  const [cursorDistanceM, setCursorDistanceM] = useState<number | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>('relief');
  const [hillshade, setHillshade] = useState(true);
  const [slope, setSlope] = useState(false);
  const [terrain, setTerrain] = useState(false);
  const [flying, setFlying] = useState(false);
  // Undefined until the map has opened and told us. A long route frames out well below the
  // zoom the slope layer can draw at, so the key has to be able to say so.
  const [mapZoom, setMapZoom] = useState<number | undefined>(undefined);

  // The same multiplier the ingest pipeline used for `estimatedTimeS`, so the elapsed axis
  // on the section and the headline time in the stat block cannot disagree.
  const terrainFactor = useMemo(
    () => terrainFactorFor({ sacScale: trail.sacScale, surface: trail.surface }),
    [trail.sacScale, trail.surface],
  );

  /**
   * The hike, which on an out-and-back is not the line OSM drew.
   *
   * A spur is mapped once, uphill, and stored that way; every published figure for it —
   * including the stat block a few centimetres above this graphic — describes the round trip.
   * Drawn from the stored line the section would run to 6.0 km under a table that says 12.0,
   * and the cursor would reach the right-hand edge at the summit. `hikedProfile` decides
   * which of the two the geometry is, and the section, the readout and the map marker all
   * read the same answer.
   */
  const hiked = useMemo(
    () => hikedProfile(trail.profile, { routeType: trail.routeType, lengthM: trail.stats.lengthM }),
    [trail.profile, trail.routeType, trail.stats.lengthM],
  );

  const cursor = useMemo(
    () => (cursorDistanceM === null ? null : positionAt(hiked, cursorDistanceM)),
    [hiked, cursorDistanceM],
  );

  /*
   * The camera path, computed once per trail and per pace rather than per frame.
   *
   * Given the same `terrainFactor` as the section's elapsed axis, which is what makes the two
   * agree by construction: the moment the camera reaches the summit is the moment the
   * section's cursor does, because both are readings of the same cumulative-time integral.
   *
   * Deliberately flown over the *stored* line rather than `hiked`. The section is about the
   * day and is captioned by figures for the whole day; the flyover is about the ground, and
   * the return leg of an out-and-back is ground the film has just shown. Retracing it would
   * spend half the running time on repeat footage of the same hillside. The two stay in step
   * regardless, because the camera's ticks are distances into the same profile the section
   * starts from — during a flight the cursor sweeps the outward half and stops at the
   * turnaround, which is exactly where the camera is.
   */
  const plan = useMemo(
    () => planFlyover(trail.profile, { terrainFactor }),
    [trail.profile, terrainFactor],
  );

  const callouts = useMemo(() => calloutsFor(forecast, units), [forecast, units]);
  const freezingLevelM = useMemo(
    () => freezingRuleFor(forecast, trail.stats.maxEleM),
    [forecast, trail.stats.maxEleM],
  );

  const hasProfile = hiked.length >= 2;

  /*
   * Playing implies terrain, and stopping does not un-imply it.
   *
   * Asking someone to tick a box before the button does anything interesting is the kind of
   * thing that leaves a feature undiscovered; leaving the mesh up afterwards is the opposite
   * — the film ends with the reader holding a map they can now tilt and spin, which is the
   * natural next question after watching the route go past.
   */
  const toggleFlight = (next: boolean) => {
    if (next) setTerrain(true);
    setFlying(next);
  };

  return (
    <div className="flex flex-col gap-lg">
      {/*
       * The map is `field` inside an otherwise light page. Not a preference — the basemap
       * is drawn dark, and light chrome over dark ground is the one combination that is
       * illegible from either side.
       */}
      <div
        data-scheme="field"
        className="relative h-[clamp(280px,46vh,520px)] w-full overflow-hidden rounded-panel border border-bezel"
      >
        <RouteMap
          geometry={trail.geometry}
          bbox={trail.bbox}
          waypoints={trail.waypoints}
          cursor={cursor}
          basemap={basemap}
          hillshade={hillshade}
          slope={slope}
          terrain={terrain}
          flyover={flying ? plan : null}
          onFlyoverTick={setCursorDistanceM}
          onFlyoverEnd={() => setFlying(false)}
          onZoomChange={setMapZoom}
          className="h-full w-full"
        />
        <div className="absolute left-md top-md z-10">
          <LayerSwitch
            basemap={basemap}
            onBasemapChange={setBasemap}
            hillshade={hillshade}
            onHillshadeChange={setHillshade}
            terrain={terrain}
            onTerrainChange={setTerrain}
            slope={slope}
            onSlopeChange={setSlope}
            zoom={mapZoom}
          />
        </div>
        {hasProfile ? (
          <div className="clear-home-indicator absolute bottom-md right-md z-10">
            <FlyoverControl
              plan={plan}
              playing={flying}
              onToggle={toggleFlight}
              distanceM={flying ? cursorDistanceM : null}
              units={units}
            />
          </div>
        ) : null}
      </div>

      {hasProfile ? (
        <TrailProfile
          profile={hiked}
          stats={trail.stats}
          terrainFactor={terrainFactor}
          cursorDistanceM={cursorDistanceM}
          onCursorChange={setCursorDistanceM}
          callouts={callouts}
          {...(freezingLevelM === null ? {} : { freezingLevelM })}
        />
      ) : (
        // A trail can exist before its elevation pass has run — the tile commits geometry
        // first. Saying which is missing beats an empty frame that looks like a bug.
        <p className="rounded-hair border border-dashed border-bezel px-md py-lg text-center text-caption text-ink-muted">
          The elevation pass for this trail has not finished yet. Distances and the route are final;
          the section and the climb figures arrive with it.
        </p>
      )}
    </div>
  );
}

/**
 * Two annotations, at the two ends of the story.
 *
 * The trailhead and the high point, because the pitch of this feature is the *difference*
 * between them — 11 °C and calm at the car, 1 °C and gusting 61 on top — and one reading
 * cannot show a difference. A third would start colliding with the second on a narrow
 * viewport, and the timetable below already carries every sample.
 *
 * The high point takes the survey plate when a warning points at it, and only then. Red on
 * this page means the reader's safety; a cold summit is not a warning, and a summit the
 * model has flagged is.
 */
function calloutsFor(
  forecast: AlongRouteForecast | null,
  units: UnitSystem,
): readonly SectionCallout[] {
  if (!forecast || forecast.samples.length === 0) return [];

  const samples = forecast.samples;
  const highIndex = samples.reduce(
    (best, sample, index) => (sample.eleM > (samples[best]?.eleM ?? -Infinity) ? index : best),
    0,
  );
  const warned = new Set(
    forecast.flags.filter((flag) => flag.severity === 'warning').map((flag) => flag.sampleIndex),
  );

  const at = (index: number, plate: SectionCallout['plate']): SectionCallout | null => {
    const sample = samples[index];
    if (!sample) return null;
    const clock = clockOf(sample.arrivalAt);
    return {
      distanceM: sample.distM,
      label: clock === null ? sample.label : `${sample.label} ${clock}`,
      detail: detailFor(sample, units),
      ...(plate === undefined ? {} : { plate }),
    };
  };

  const head = at(0, 'water');
  const high = highIndex === 0 ? null : at(highIndex, warned.has(highIndex) ? 'survey' : 'water');
  return [head, high].filter((callout): callout is SectionCallout => callout !== null);
}

/** Temperature and whichever wind figure is the one worth knowing, in that order. */
function detailFor(sample: WeatherSample, units: UnitSystem): string {
  const temperature =
    sample.temperatureC === null ? null : formatTemperature(sample.temperatureC, units);
  const wind = sample.windGustsKmh ?? sample.windSpeedKmh;
  const gusts =
    wind === null
      ? null
      : sample.windGustsKmh === null
        ? formatSpeed(wind, units)
        : `gusts ${formatSpeed(wind, units)}`;
  return [temperature, gusts].filter((part) => part !== null).join(' · ') || '—';
}

/**
 * The freezing level, drawn only when it is somewhere the hike actually goes.
 *
 * Above the summit it is a true fact about the atmosphere and a meaningless line on this
 * graphic — it would sit above the profile with nothing beneath it, and a reader would
 * reasonably wonder what it was warning them about. The same test the safety flag uses.
 */
function freezingRuleFor(forecast: AlongRouteForecast | null, maxEleM: number): number | null {
  if (!forecast) return null;
  const levels = forecast.samples
    .map((sample) => sample.freezingLevelM)
    .filter((level): level is number => level !== null);
  if (levels.length === 0) return null;
  const lowest = Math.min(...levels);
  return lowest <= maxEleM ? lowest : null;
}
