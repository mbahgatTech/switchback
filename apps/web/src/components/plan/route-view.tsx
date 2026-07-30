'use client';

import { useMemo, useState } from 'react';
import type { PlannedRouteDetail, UnitSystem } from '@switchback/core';
import { planFlyover, positionAt } from '@switchback/geo';
import { type BasemapId } from '../map/basemap';
import { LayerSwitch } from '../map/layer-switch';
import { FlyoverControl } from '../trail/flyover-control';
import { TrailProfile } from '../trail/profile';
import { RouteMap } from '../trail/route-map';

/**
 * A saved route, read rather than drawn.
 *
 * The same instrument as a trail page — map above, section below, one cursor shared between
 * them — and that repetition is the argument for this component existing at all. A route you
 * drew last Tuesday and a trail somebody else hiked in 2011 are read for exactly the same
 * reasons, in exactly the same order: where does it go, how much climbing, how long. Giving
 * the one you made a different layout would say it is a lesser kind of thing.
 *
 * What is absent is everything the planner has and reading does not need. No pins, no undo,
 * no coverage warming, no clicking to add a point. The route is finished; the way back to
 * changing it is a link, not a mode.
 *
 * **No waypoints and no terrain factor.** A planned route has neither — waypoints come from
 * OSM nodes along a real trail, and the terrain multiplier comes from a trail's `sac_scale`
 * and surface tags. A drawn line has no tags, so its elapsed axis runs at Tobler's own pace,
 * unmodified. That is the honest reading: we know the ground's shape and nothing about what
 * it is made of.
 */

export interface RouteViewProps {
  route: PlannedRouteDetail;
  units: UnitSystem;
}

export function RouteView({ route, units }: RouteViewProps) {
  const [cursorDistanceM, setCursorDistanceM] = useState<number | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>('relief');
  const [hillshade, setHillshade] = useState(true);
  const [slope, setSlope] = useState(false);
  const [terrain, setTerrain] = useState(false);
  const [flying, setFlying] = useState(false);
  const [mapZoom, setMapZoom] = useState<number | undefined>(undefined);

  const cursor = useMemo(
    () => (cursorDistanceM === null ? null : positionAt(route.profile, cursorDistanceM)),
    [route.profile, cursorDistanceM],
  );

  const plan = useMemo(() => planFlyover(route.profile), [route.profile]);

  const hasProfile = route.profile.length >= 2;

  // Playing implies terrain; stopping does not un-imply it. Same reasoning as the trail page.
  const toggleFlight = (next: boolean) => {
    if (next) setTerrain(true);
    setFlying(next);
  };

  return (
    <div className="flex flex-col gap-lg">
      <div
        data-scheme="field"
        className="relative h-[clamp(280px,46vh,520px)] w-full overflow-hidden rounded-panel border border-bezel"
      >
        <RouteMap
          geometry={route.geometry}
          bbox={route.bbox}
          waypoints={[]}
          cursor={cursor}
          basemap={basemap}
          hillshade={hillshade}
          slope={slope}
          terrain={terrain}
          flyover={flying ? plan : null}
          onFlyoverTick={setCursorDistanceM}
          onFlyoverEnd={() => {
            setFlying(false);
          }}
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
          profile={route.profile}
          stats={route.stats}
          units={units}
          cursorDistanceM={cursorDistanceM}
          onCursorChange={setCursorDistanceM}
        />
      ) : null}
    </div>
  );
}
