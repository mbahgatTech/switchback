'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TrailDetail } from '@switchback/core';
import { addDays, localDateAt, localIso, nextDateOn, splitLocalIso } from '@switchback/core';
import { useTRPC } from '../../trpc/react';
import { BusyTimes } from './busy-times';
import { Conditions } from './conditions';
import { TrailView } from './trail-view';

/**
 * The planning half of a trail page, and the one piece of state the two features share.
 *
 * Weather and busyness look like two independent widgets and are not. Busy times answers
 * *when should I go*; conditions answers *what will it be like when I do*. Left apart, a
 * reader has to carry an answer from one to the other by hand — read "quietest Tuesday
 * around six", scroll back up, re-select Tuesday, re-select 06:00. Holding the start time
 * here makes that one button, which is the whole reason both features live on this page.
 *
 * **Why the stat rail comes through as `children`.** It is server-rendered markup that
 * needs no interactivity, and passing it as a slot keeps it that way — this component
 * being a client component does not drag the rail's rendering into the bundle. It also
 * keeps the page's reading order intact: map, section, figures, then the two blocks that
 * turn the figures into a decision, then the prose.
 *
 * **The offset comes from the server and is never computed here.** `forecast.startAt`
 * carries the trail's real UTC offset, so a new start time is that string with the date
 * and hour swapped. No timezone database, on either client. See `@switchback/core`'s
 * `localtime`.
 */

export interface TrailPlannerProps {
  trail: TrailDetail;
  /** The server-rendered stat rail, slotted between the section and the planning blocks. */
  children: React.ReactNode;
}

/** How many start days the dial offers. Six always fits inside the upstream horizon. */
const DAYS_OFFERED = 6;

export function TrailPlanner({ trail, children }: TrailPlannerProps) {
  const trpc = useTRPC();
  const [start, setStart] = useState<{ date: string; hour: number } | null>(null);

  const hasProfile = trail.profile.length >= 2;

  /**
   * The first forecast's offset, remembered so a start time can be rebuilt from it.
   *
   * A ref rather than state because writing it must not cause a render — it is derived
   * from data we already have, and its only reader is the next event handler.
   */
  const anchor = useRef<{ date: string; offset: string } | null>(null);

  const startAt =
    start === null || anchor.current === null
      ? undefined
      : localIso(start.date, start.hour, anchor.current.offset);

  const weather = useQuery(
    trpc.weather.alongRoute.queryOptions(
      { trailId: trail.id, ...(startAt === undefined ? {} : { startAt }) },
      {
        enabled: hasProfile,
        // The upstream model publishes hourly; asking again inside that window buys nothing.
        staleTime: 10 * 60_000,
        // Keeps the timetable on screen, dimmed, while a new start is fetched. Blanking a
        // table someone is reading is worse than showing it a beat stale.
        placeholderData: keepPreviousData,
        retry: 1,
      },
    ),
  );

  const busyness = useQuery(
    trpc.busyness.forWeek.queryOptions({ trailId: trail.id }, { staleTime: 30 * 60_000, retry: 1 }),
  );

  /**
   * The air over the trail, read at its centroid.
   *
   * The centroid rather than the trailhead because the model's cell is tens of kilometres
   * across and the centre of the route is the point most likely to sit in the cell the hike
   * spends most of its time in. A separate query from the forecast on purpose: it is keyed
   * on a snapped coordinate rather than on a trail, so every trail in the same model cell
   * shares one upstream call and one cache entry, however many of them there are.
   */
  const airQuality = useQuery(
    trpc.weather.airQualityAt.queryOptions(
      { lng: trail.centroid[0], lat: trail.centroid[1] },
      { staleTime: 30 * 60_000, retry: 1 },
    ),
  );

  const forecast = weather.data ?? null;
  if (anchor.current === null && forecast) {
    const parts = splitLocalIso(forecast.startAt);
    if (parts) anchor.current = { date: parts.date, offset: parts.offset };
  }

  // What the dials show: the reader's own choice once they have made one, and the server's
  // default until then.
  const shown = useMemo(() => {
    if (start !== null) return start;
    if (!forecast) return null;
    const parts = splitLocalIso(forecast.startAt);
    return parts === null ? null : { date: parts.date, hour: parts.hour };
  }, [start, forecast]);

  const dateOptions = useMemo(() => {
    const from = anchor.current?.date;
    if (from === undefined) return [];
    const days = Array.from({ length: DAYS_OFFERED }, (_, i) => addDays(from, i));
    // A recommendation can point a day past the end of the list. Rather than clamp it —
    // which would silently answer a different question — the list grows to hold it.
    return shown && !days.includes(shown.date) ? [...days, shown.date].sort() : days;
  }, [shown]);

  const onStartChange = useCallback((date: string, hour: number) => {
    if (date === '') return;
    setStart({ date, hour });
  }, []);

  /** A weekday from the busyness grid, resolved to the next date that is still ahead. */
  const onPickStart = useCallback((dayOfWeek: number, hour: number) => {
    const from = anchor.current?.date;
    if (from === undefined) return;
    setStart({ date: nextDateOn(from, dayOfWeek), hour });
  }, []);

  const todayDayOfWeek = useMemo(() => {
    if (!forecast) return null;
    const parts = splitLocalIso(forecast.startAt);
    if (parts === null) return null;
    const today = localDateAt(forecast.fetchedAt, parts.offset);
    return today === null ? null : new Date(`${today}T00:00:00Z`).getUTCDay();
  }, [forecast]);

  return (
    <>
      <div className="mt-2xl">
        <TrailView trail={trail} forecast={forecast} />
      </div>

      {children}

      <div className="mt-2xl flex flex-col gap-2xl">
        {hasProfile ? (
          <Conditions
            forecast={forecast}
            isPending={weather.isPending}
            isFetching={weather.isFetching}
            error={weather.isError ? weatherMessage(weather.error) : null}
            date={shown?.date ?? null}
            hour={shown?.hour ?? null}
            dateOptions={dateOptions}
            onStartChange={onStartChange}
            airQuality={airQuality.data ?? null}
          />
        ) : null}

        <BusyTimes
          forecast={busyness.data ?? null}
          isPending={busyness.isPending}
          error={busyness.isError ? BUSYNESS_MESSAGE : null}
          todayDayOfWeek={todayDayOfWeek}
          onPickStart={anchor.current === null ? undefined : onPickStart}
        />
      </div>
    </>
  );
}

const BUSYNESS_MESSAGE =
  'Busy times could not be worked out just now. Everything else on this page is unaffected.';

/**
 * What went wrong, in terms of what the reader can do about it.
 *
 * The two failures worth distinguishing are ours and theirs: a trail whose elevation pass
 * has not run cannot have a route forecast at all and never will until it does, whereas an
 * upstream outage is worth waiting out. Anything else is a generic apology, which is the
 * right answer when we genuinely do not know.
 */
function weatherMessage(error: unknown): string {
  switch (codeOf(error)) {
    case 'NOT_FOUND':
      return 'This trail has no elevation profile yet, so there is nothing to forecast along. It arrives with the elevation pass.';
    case 'TIMEOUT':
    case 'SERVICE_UNAVAILABLE':
      return 'The forecast service did not answer in time. Reload in a minute — the rest of this page is unaffected.';
    default:
      return 'The forecast for this route could not be read. The rest of this page is unaffected.';
  }
}

/** tRPC hangs the error code off `data`, which arrives as JSON and is typed as unknown. */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const data: unknown = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const code: unknown = (data as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
