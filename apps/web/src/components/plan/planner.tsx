'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ActivityType,
  BBox,
  RouteAnchor,
  RouteLeg,
  UnitSystem,
  Visibility,
} from '@switchback/core';
import { MAX_ROUTE_ANCHORS } from '@switchback/core';
import { positionAt } from '@switchback/geo';
import { useTRPC } from '@/trpc/react';
import { type BasemapId } from '../map/basemap';
import { LayerSwitch } from '../map/layer-switch';
import { BUTTON, DANGER, HEIGHT, PRIMARY, SECONDARY, toggle } from '../controls';
import { PlanReadout } from './plan-readout';
import { SaveRoute } from './save-route';
import { usePlan } from './use-plan';

/**
 * The planner.
 *
 * Explore answers "where has somebody already hiked". This answers the other half — "I want
 * to hike *here*", when the line you want has never been anybody's trail. The layout is
 * Explore's, deliberately: the sheet on the right, the collar down the left, because the two
 * screens are the same screen asked in two directions and a reader who has learnt one should
 * not have to learn the other.
 *
 * **The collar is the honest half.** A drawn line always looks like a route. Whether it *is*
 * one — whether there is a path under every stretch of it, whether the network for that ground
 * has finished downloading, whether the thing measures nine kilometres or forty-one — is what
 * the panel is for, and it is why the panel is not collapsible.
 *
 * Saving is the one action that needs an account, and the one that is offered as a plain link
 * to sign in rather than a button that fails. Everything else here works signed out: a hiker
 * planning a route on a borrowed laptop can still draw it, read it, and take the numbers away.
 */

const PlanMap = dynamic(() => import('./plan-map').then((mod) => mod.PlanMap), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-canvas" />,
});

/**
 * How long a viewport's coverage answer stays fresh.
 *
 * Long, because the question is "which routing tiles do we hold here", and a tile that landed
 * a minute ago has not gone anywhere. The only thing that changes the answer is a tile
 * finishing, and the planner learns about that from its own replan loop, not from here.
 */
const COVERAGE_STALE_MS = 60_000;

/** The box holding a set of anchors, for framing a route that arrives already drawn. */
function anchorBounds(anchors: readonly RouteAnchor[]): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const anchor of anchors) {
    west = Math.min(west, anchor.lng);
    south = Math.min(south, anchor.lat);
    east = Math.max(east, anchor.lng);
    north = Math.max(north, anchor.lat);
  }
  return [west, south, east, north];
}

export interface PlannerProps {
  units: UnitSystem;
  defaultVisibility: Visibility;
  /** Null when nobody is signed in. Saving is the only thing that needs one. */
  viewerId: string | null;
  initialCenter: readonly [number, number];
  initialZoom: number;
  /** Opening a saved route for editing rather than starting from nothing. */
  initialAnchors?: readonly RouteAnchor[];
  /** Set when the anchors above came from a route the viewer owns, so saving updates it. */
  editing?: {
    id: string;
    name: string;
    description: string;
    activityType: ActivityType;
    visibility: Visibility;
  } | null;
}

export function Planner({
  units,
  defaultVisibility,
  viewerId,
  initialCenter,
  initialZoom,
  initialAnchors = [],
  editing = null,
}: PlannerProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const plan = usePlan(initialAnchors);

  const [basemap, setBasemap] = useState<BasemapId>('relief');
  const [hillshade, setHillshade] = useState(true);
  const [cursorDistanceM, setCursorDistanceM] = useState<number | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  /*
   * A route opened for editing is framed on arrival; one started from scratch is not.
   *
   * There is nothing to frame in the second case, and moving the camera off the view the
   * reader arrived at — usually the ground they were just looking at on Explore — would be
   * taking the map away from them to show them nothing.
   */
  const nonce = useRef(initialAnchors.length >= 2 ? 1 : 0);
  const [frame, setFrame] = useState<{ bbox: BBox; nonce: number } | null>(() =>
    initialAnchors.length >= 2 ? { bbox: anchorBounds(initialAnchors), nonce: 1 } : null,
  );

  /*
   * Warm the routing tiles under the view.
   *
   * A query whose result is never rendered, which looks odd until you see what it does: asking
   * for coverage is what queues the missing tiles and kicks the drain, so the ground under the
   * map starts downloading while the reader is still deciding where to click. Without it the
   * first leg over cold country comes back straight with "still downloading paths here" under
   * it; with it, the fetch has a few seconds' head start and the first leg usually snaps.
   *
   * The bbox is rounded to two decimals — a little over a kilometre — before it becomes a
   * query key. A map nudged by ten pixels is the same ground, and giving it its own key would
   * put a request behind every frame of a drag.
   */
  const [viewBBox, setViewBBox] = useState<BBox | null>(null);
  useQuery(
    trpc.routes.coverage.queryOptions(
      { bbox: viewBBox ?? ([0, 0, 0, 0] as BBox) },
      { enabled: viewBBox !== null, staleTime: COVERAGE_STALE_MS, retry: 1 },
    ),
  );

  const onViewportChange = useCallback((bbox: BBox) => {
    const rounded = bbox.map((n) => Math.round(n * 100) / 100) as BBox;
    setViewBBox((previous) =>
      previous && previous.every((n, i) => n === rounded[i]) ? previous : rounded,
    );
  }, []);

  const cursor = useMemo(
    () =>
      cursorDistanceM === null || !plan.plan
        ? null
        : positionAt(plan.plan.profile, cursorDistanceM),
    [plan.plan, cursorDistanceM],
  );

  const frameLeg = useCallback((leg: RouteLeg) => {
    nonce.current += 1;
    setFrame({
      bbox: [
        Math.min(leg.start[0], leg.end[0]),
        Math.min(leg.start[1], leg.end[1]),
        Math.max(leg.start[0], leg.end[0]),
        Math.max(leg.start[1], leg.end[1]),
      ],
      nonce: nonce.current,
    });
  }, []);

  const save = useMutation(trpc.routes.save.mutationOptions());
  const update = useMutation(trpc.routes.update.mutationOptions());
  const saving = save.isPending || update.isPending;
  const saveError =
    save.error instanceof Error
      ? save.error.message
      : update.error instanceof Error
        ? update.error.message
        : null;

  const onConfirmSave = useCallback(
    (input: {
      name: string;
      description: string;
      activityType: ActivityType;
      visibility: Visibility;
    }) => {
      const body = {
        anchors: plan.anchors,
        preferPaths: plan.preferPaths,
        name: input.name,
        description: input.description.trim() || null,
        activityType: input.activityType,
        visibility: input.visibility,
      };
      const request = editing
        ? update.mutateAsync({ id: editing.id, ...body })
        : save.mutateAsync(body);

      void request
        .then((saved) => {
          setSaveOpen(false);
          router.push(`/routes/${saved.id}`);
        })
        .catch(() => {
          /* Shown in the dialog, which stays open so the typing is not lost. */
        });
    },
    [plan.anchors, plan.preferPaths, editing, update, save, router],
  );

  const canSave = plan.plan !== null && plan.plan.geometry !== null && !plan.plan.tooLarge;

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[45dvh_1fr] md:grid-cols-[minmax(340px,26rem)_1fr] md:grid-rows-1">
      {/* The sheet. First in the DOM on mobile, where the map is the point of arrival. */}
      <div data-scheme="field" className="relative order-first md:order-last">
        <PlanMap
          anchors={plan.anchors}
          plan={plan.plan}
          basemap={basemap}
          hillshade={hillshade}
          onAddAnchor={(lng, lat) => {
            // A new point continues in whatever mode the last leg used, so a reader who has
            // switched to straight lines does not have to switch again for every click.
            plan.addAnchor(lng, lat, plan.anchors[plan.anchors.length - 1]?.freehand ?? false);
          }}
          onMoveAnchor={plan.moveAnchor}
          onRemoveAnchor={plan.removeAnchor}
          onViewportChange={onViewportChange}
          cursor={cursor}
          initialCenter={initialCenter}
          initialZoom={initialZoom}
          frame={frame}
        />

        <div className="pointer-events-none absolute left-md top-md z-10">
          <div className="pointer-events-auto">
            <LayerSwitch
              basemap={basemap}
              onBasemapChange={setBasemap}
              hillshade={hillshade}
              onHillshadeChange={setHillshade}
            />
          </div>
        </div>
      </div>

      {/* The collar. */}
      <div className="flex min-h-0 flex-col overflow-y-auto border-t border-bezel px-lg py-lg md:border-r md:border-t-0 md:px-xl">
        <div className="mb-lg flex flex-wrap items-center gap-sm">
          <button
            type="button"
            onClick={plan.outAndBack}
            disabled={plan.anchors.length < 2 || plan.full}
            className={`${BUTTON} ${SECONDARY} ${HEIGHT.panel} px-md`}
            title="Add the way back, retracing every point in reverse"
          >
            Out and back
          </button>
          <button
            type="button"
            onClick={plan.closeLoop}
            disabled={plan.anchors.length < 3 || plan.full}
            className={`${BUTTON} ${SECONDARY} ${HEIGHT.panel} px-md`}
            title="Return to the start by whatever path exists"
          >
            Close loop
          </button>
          <button
            type="button"
            onClick={plan.undo}
            disabled={!plan.canUndo}
            className={`${BUTTON} ${SECONDARY} ${HEIGHT.panel} px-md`}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={plan.clear}
            disabled={plan.anchors.length === 0}
            className={`${BUTTON} ${DANGER} ${HEIGHT.panel} px-md`}
          >
            Clear
          </button>
        </div>

        <div className="mb-lg flex flex-wrap items-center gap-sm">
          <button
            type="button"
            onClick={() => {
              plan.setPreferPaths(!plan.preferPaths);
            }}
            aria-pressed={plan.preferPaths}
            className={`${BUTTON} ${toggle(plan.preferPaths)} ${HEIGHT.panel} px-md`}
            title="Favour trails and footpaths over roads, even when the road is shorter"
          >
            Prefer paths
          </button>

          {viewerId ? (
            <button
              type="button"
              onClick={() => {
                setSaveOpen(true);
              }}
              disabled={!canSave}
              className={`${BUTTON} ${PRIMARY} ml-auto ${HEIGHT.panel} px-lg`}
            >
              {editing ? 'Save changes' : 'Save route'}
            </button>
          ) : (
            <Link
              href="/signin?callbackUrl=%2Fplan"
              className={`${BUTTON} ${SECONDARY} ml-auto ${HEIGHT.panel} px-lg`}
            >
              Sign in to save
            </Link>
          )}
        </div>

        {plan.full ? (
          <p className="mb-lg text-caption text-ink-muted">
            {MAX_ROUTE_ANCHORS} points is the most one route holds. Past that it is a traced line
            rather than a route — split the hike in two.
          </p>
        ) : null}

        <PlanReadout
          anchors={plan.anchors}
          plan={plan.plan}
          planning={plan.planning}
          error={plan.error}
          units={units}
          cursorDistanceM={cursorDistanceM}
          onCursorChange={setCursorDistanceM}
          onRemoveAnchor={plan.removeAnchor}
          onSetLegFreehand={plan.setLegFreehand}
          onFrameLeg={frameLeg}
        />
      </div>

      {saveOpen && plan.plan ? (
        <SaveRoute
          plan={plan.plan}
          units={units}
          saving={saving}
          error={saveError}
          editing={editing !== null}
          initial={
            editing
              ? {
                  name: editing.name,
                  description: editing.description,
                  activityType: editing.activityType,
                  visibility: editing.visibility,
                }
              : {
                  name: '',
                  description: '',
                  activityType: 'hiking',
                  visibility: defaultVisibility,
                }
          }
          onCancel={() => {
            setSaveOpen(false);
          }}
          onConfirm={onConfirmSave}
        />
      ) : null}
    </div>
  );
}
