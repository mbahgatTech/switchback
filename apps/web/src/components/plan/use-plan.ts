'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { MAX_ROUTE_ANCHORS, type RouteAnchor, type RoutePlan } from '@switchback/core';
import { useTRPC } from '@/trpc/react';

/**
 * The planner's state machine, lifted out of the component because the interesting part is what
 * happens between "the user moved a point" and "the line is right again".
 *
 * Four problems live here. Edits are debounced, so a burst of clicks is one plan. Every request
 * carries a sequence number and anything but the newest is dropped, because a two-anchor plan
 * issued first can land after a five-anchor plan issued third. A plan that comes back with
 * `pendingTiles` is retried on a timer, since the walkable network for that ground is still
 * being fetched. And every edit pushes the previous anchors onto an undo stack, which is what
 * makes click-to-remove safe to offer on a map.
 */

/** How long the planner waits after the last edit before asking the server. */
const EDIT_SETTLE_MS = 250;

/**
 * How often to replan while the walkable network is still downloading. The same interval
 * `/explore` polls its tiles on: an Overpass round trip is measured in seconds.
 */
const PENDING_POLL_MS = 2_500;

/** How many edits back you can go. Deep enough to undo a mistake, not a whole session. */
const UNDO_DEPTH = 50;

export interface PlanState {
  anchors: RouteAnchor[];
  plan: RoutePlan | null;
  planning: boolean;
  error: string | null;
  canUndo: boolean;
  full: boolean;
  preferPaths: boolean;
  setPreferPaths: (value: boolean) => void;
  addAnchor: (lng: number, lat: number, freehand: boolean) => void;
  moveAnchor: (index: number, lng: number, lat: number) => void;
  removeAnchor: (index: number) => void;
  setLegFreehand: (index: number, freehand: boolean) => void;
  /** Hike back the way you came — mirrors every anchor but the last. */
  outAndBack: () => void;
  /** Return to the start, by path where there is one. */
  closeLoop: () => void;
  undo: () => void;
  clear: () => void;
  /** Replace the whole set, for opening a saved route in the planner. */
  replace: (anchors: readonly RouteAnchor[]) => void;
}

export function usePlan(initialAnchors: readonly RouteAnchor[] = []): PlanState {
  const trpc = useTRPC();

  const [anchors, setAnchors] = useState<RouteAnchor[]>(() => [...initialAnchors]);
  const [history, setHistory] = useState<RouteAnchor[][]>([]);
  const [preferPaths, setPreferPaths] = useState(true);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const planner = useMutation(trpc.routes.plan.mutationOptions());
  const { mutateAsync } = planner;

  /**
   * The sequence guard. `issued` counts every request sent; `settled` remembers the newest one
   * whose answer was accepted. A response may only touch state when its number is the highest
   * seen, which is the whole of the fix for a stale plan overwriting a fresh one.
   */
  const issued = useRef(0);
  const settled = useRef(0);

  const edit = useCallback((next: (previous: RouteAnchor[]) => RouteAnchor[]) => {
    setAnchors((previous) => {
      const result = next(previous);
      if (result === previous) return previous;
      setHistory((stack) => [...stack, previous].slice(-UNDO_DEPTH));
      return result;
    });
  }, []);

  const addAnchor = useCallback(
    (lng: number, lat: number, freehand: boolean) => {
      edit((previous) =>
        previous.length >= MAX_ROUTE_ANCHORS ? previous : [...previous, { lng, lat, freehand }],
      );
    },
    [edit],
  );

  const moveAnchor = useCallback(
    (index: number, lng: number, lat: number) => {
      edit((previous) => {
        const at = previous[index];
        if (!at) return previous;
        const next = [...previous];
        next[index] = { ...at, lng, lat };
        return next;
      });
    },
    [edit],
  );

  const removeAnchor = useCallback(
    (index: number) => {
      edit((previous) => {
        if (index < 0 || index >= previous.length) return previous;
        const next = previous.filter((_, at) => at !== index);
        /*
         * Removing the first point promotes the second, whose flag described the leg that no
         * longer exists — left alone, deleting a snapped start makes the new start freehand.
         */
        const first = next[0];
        if (index === 0 && first) next[0] = { ...first, freehand: false };
        return next;
      });
    },
    [edit],
  );

  const setLegFreehand = useCallback(
    (index: number, freehand: boolean) => {
      edit((previous) => {
        const at = previous[index];
        if (!at || index === 0) return previous;
        const next = [...previous];
        next[index] = { ...at, freehand };
        return next;
      });
    },
    [edit],
  );

  const outAndBack = useCallback(() => {
    edit((previous) => {
      if (previous.length < 2) return previous;
      /*
       * The return leg's flag comes from the outward leg it retraces, shifted by one: a flag
       * describes the leg *arriving* at its anchor, so the mirrored point at i takes its flag
       * from the point one further out. Off by one and every return leg inherits the wrong mode.
       */
      const back: RouteAnchor[] = [];
      for (let i = previous.length - 2; i >= 0; i -= 1) {
        const point = previous[i]!;
        back.push({ lng: point.lng, lat: point.lat, freehand: previous[i + 1]!.freehand });
      }
      const combined = [...previous, ...back];
      return combined.length > MAX_ROUTE_ANCHORS ? previous : combined;
    });
  }, [edit]);

  const closeLoop = useCallback(() => {
    edit((previous) => {
      const start = previous[0];
      if (!start || previous.length < 3 || previous.length >= MAX_ROUTE_ANCHORS) return previous;
      // By path, not by straight line — closing a loop is the case where the router earns its
      // keep, because the way home is rarely the way you came.
      return [...previous, { lng: start.lng, lat: start.lat, freehand: false }];
    });
  }, [edit]);

  const undo = useCallback(() => {
    setHistory((stack) => {
      const last = stack[stack.length - 1];
      if (!last) return stack;
      setAnchors(last);
      return stack.slice(0, -1);
    });
  }, []);

  const clear = useCallback(() => {
    edit((previous) => (previous.length === 0 ? previous : []));
  }, [edit]);

  const replace = useCallback(
    (next: readonly RouteAnchor[]) => {
      edit(() => [...next]);
    },
    [edit],
  );

  /**
   * Ask the server, once the edits stop. `mutateAsync` rather than the mutation's own state,
   * because a mutation's `data` is whichever call resolved last — precisely what the sequence
   * guard exists to override.
   */
  useEffect(() => {
    if (anchors.length < 2) {
      // Not an error and not a stale line: one point is a perfectly good half-drawn route.
      issued.current += 1;
      settled.current = issued.current;
      setPlan(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      issued.current += 1;
      const seq = issued.current;

      void mutateAsync({ anchors, preferPaths })
        .then((result) => {
          if (cancelled || seq < settled.current) return;
          settled.current = seq;
          setPlan(result);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled || seq < settled.current) return;
          settled.current = seq;
          setError(cause instanceof Error ? cause.message : 'That route could not be worked out.');
        });
    }, EDIT_SETTLE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [anchors, preferPaths, mutateAsync]);

  /**
   * Try again while the ground is still arriving. Scheduled off the plan rather than off a
   * flag, so the chain stops on its own: a plan with no pending tiles schedules nothing.
   * Anchors are read from a ref so a tile landing does not race the edit effect above.
   */
  const pending = plan?.pendingTiles ?? 0;
  /*
   * A refused fetch is not a slow one: `busy` means the server declined to queue the network
   * under these anchors, so no tile will land and a timer would be a poll loop against a
   * server already saying it is under pressure. The chain resumes on the next edit.
   */
  const busy = plan?.busy ?? false;
  const latest = useRef({ anchors, preferPaths });
  latest.current = { anchors, preferPaths };

  useEffect(() => {
    if (busy || pending === 0) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      const { anchors: now, preferPaths: prefer } = latest.current;
      if (now.length < 2) return;

      issued.current += 1;
      const seq = issued.current;
      void mutateAsync({ anchors: now, preferPaths: prefer })
        .then((result) => {
          if (cancelled || seq < settled.current) return;
          settled.current = seq;
          setPlan(result);
        })
        .catch(() => {
          // A failed retry is not worth a message — the previous plan is still on screen and
          // the next tick will try again.
        });
    }, PENDING_POLL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [busy, pending, plan, mutateAsync]);

  return {
    anchors,
    plan,
    planning: planner.isPending,
    error,
    canUndo: history.length > 0,
    full: anchors.length >= MAX_ROUTE_ANCHORS,
    preferPaths,
    setPreferPaths,
    addAnchor,
    moveAnchor,
    removeAnchor,
    setLegFreehand,
    outAndBack,
    closeLoop,
    undo,
    clear,
    replace,
  };
}
