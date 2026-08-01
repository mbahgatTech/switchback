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
 * The route and its section, reading as one instrument. Stacked rather than side by side, so
 * the section's full-height cursor points at the ground it describes. The forecast becomes two
 * collar annotations before it reaches the graphic, which is what the section's headroom is for.
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
   * The hike, which on an out-and-back is not the line OSM drew: a spur is mapped once,
   * uphill, while every published figure describes the round trip. `hikedProfile` decides
   * which of the two the geometry is, and the section, readout and map marker read one answer.
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
   * The camera path, computed once per trail and per pace rather than per frame. Given the
   * same `terrainFactor` as the section's elapsed axis, so the two agree by construction.
   *
   * Deliberately flown over the *stored* line rather than `hiked`: the return leg of an
   * out-and-back is ground the film has just shown. During a flight the cursor sweeps the
   * outward half and stops at the turnaround, which is where the camera is.
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

  /* Playing implies terrain, and stopping does not un-imply it: the film ends with the reader
   * holding a map they can now tilt and spin. */
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
 * Two annotations, at the two ends of the story: the trailhead and the high point, because the
 * pitch of this feature is the *difference* between them and one reading cannot show a
 * difference. The high point takes the survey plate only when a warning points at it.
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
 * The freezing level, drawn only when it is somewhere the hike actually goes — above the summit
 * it is a true fact about the atmosphere and a meaningless line on this graphic.
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
