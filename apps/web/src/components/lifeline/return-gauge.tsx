import { formatSpan } from '@switchback/core';

/**
 * The return gauge.
 *
 * The follow page's signature graphic, and its whole argument. A worried person has exactly
 * one question — *how late is this* — and the honest answer is a proportion, not a
 * timestamp: twenty minutes over on a two-hour hike is nothing, and twenty minutes over on a
 * forty-minute stroll is something. A pair of clock times makes the reader do that division
 * in their head, at the worst possible moment to be doing arithmetic.
 *
 * So it is drawn as an instrument face rather than written as a sentence. The planned window
 * runs from setting off to due back; the contour bar is time already spent, the same plate
 * this product uses everywhere for ground covered; the caret is now. Past the due mark the
 * bar continues in survey — the plate reserved for safety — and the reader sees the overrun
 * against the whole hike without being told a number.
 *
 * Server-rendered SVG with no client bundle, like the section. It is a snapshot, which is
 * correct: the page states the minute it was drawn and refreshes itself. A gauge that ticked
 * every second would turn somebody's afternoon into a countdown.
 */

const VIEW = { w: 1000, h: 128 } as const;
const PAD = { left: 12, right: 12 } as const;
const BASE_Y = 62;
const X0 = PAD.left;
const X1 = VIEW.w - PAD.right;

export interface ReturnGaugeProps {
  startedAt: Date;
  expectedReturnAt: Date;
  /** When the gauge was drawn. Passed in rather than read here so the page and the graphic agree. */
  now: Date;
  /** A finished hike freezes the caret at the moment it ended. */
  endedAt?: Date | null;
  className?: string;
}

export function ReturnGauge({
  startedAt,
  expectedReturnAt,
  now,
  endedAt = null,
  className,
}: ReturnGaugeProps) {
  const start = startedAt.getTime();
  const due = expectedReturnAt.getTime();
  const mark = (endedAt ?? now).getTime();

  /*
   * The scale runs to whichever came last, so an overrun always has somewhere to be drawn.
   * A quarter of the planned window is held in reserve beyond the due mark even when nobody
   * is late, so the tick is never welded to the right edge — a gauge whose needle can only
   * ever sit at the end is not a gauge.
   */
  const planned = Math.max(due - start, 60_000);
  const span = Math.max(planned * 1.25, mark - start);
  const at = (t: number): number =>
    X0 + ((X1 - X0) * Math.min(Math.max(t - start, 0), span)) / span;

  const xDue = at(due);
  const xNow = at(mark);
  const late = mark > due;
  const overrunS = Math.max(0, Math.round((mark - due) / 1000));
  const remainingS = Math.max(0, Math.round((due - mark) / 1000));

  const summary = late
    ? `Set off at ${clock(startedAt)}, due back at ${clock(expectedReturnAt)}, ${formatSpan(overrunS)} past that.`
    : `Set off at ${clock(startedAt)}, due back at ${clock(expectedReturnAt)} — ${formatSpan(remainingS)} from now.`;

  return (
    <svg
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      className={className}
      role="img"
      aria-label={summary}
      preserveAspectRatio="none"
    >
      {/* The whole scale, as a hairline. What has not happened yet. */}
      <line x1={X0} y1={BASE_Y} x2={X1} y2={BASE_Y} stroke="var(--color-bezel)" strokeWidth="2" />

      {/* Time spent inside the plan. Contour: the plate for ground covered. */}
      <line
        x1={X0}
        y1={BASE_Y}
        x2={Math.min(xNow, xDue)}
        y2={BASE_Y}
        stroke="var(--color-contour)"
        strokeWidth="6"
        strokeLinecap="butt"
      />

      {/* Time spent past it. Survey, and only ever this. */}
      {late ? (
        <line
          x1={xDue}
          y1={BASE_Y}
          x2={xNow}
          y2={BASE_Y}
          stroke="var(--color-survey)"
          strokeWidth="6"
          strokeLinecap="butt"
        />
      ) : null}

      {/* Setting off. A plain tick — it is a fact, not a decision. */}
      <line
        x1={X0}
        y1={BASE_Y - 14}
        x2={X0}
        y2={BASE_Y + 14}
        stroke="var(--color-ink)"
        strokeWidth="2"
      />
      <text
        x={X0}
        y={BASE_Y + 34}
        fill="var(--color-ink-muted)"
        className="collar"
        style={{ fontSize: 13 }}
      >
        Set off {clock(startedAt)}
      </text>

      {/* Due back. The one mark on the page that everything else is measured against. */}
      <line
        x1={xDue}
        y1={BASE_Y - 20}
        x2={xDue}
        y2={BASE_Y + 20}
        stroke={late ? 'var(--color-survey)' : 'var(--color-ink)'}
        strokeWidth="2"
      />
      <text
        x={xDue}
        y={BASE_Y + 40}
        textAnchor="middle"
        fill={late ? 'var(--color-survey)' : 'var(--color-ink-muted)'}
        className="collar"
        style={{ fontSize: 13 }}
      >
        Due {clock(expectedReturnAt)}
      </text>

      {/*
       * Now. A caret above the line rather than a third vertical rule, so it never reads as
       * another scheduled moment — it is where the reader is standing, not part of the plan.
       */}
      <polygon
        points={`${xNow - 7},${BASE_Y - 26} ${xNow + 7},${BASE_Y - 26} ${xNow},${BASE_Y - 12}`}
        fill={late ? 'var(--color-survey)' : 'var(--color-ink)'}
      />
      <text
        x={caretLabelX(xNow)}
        y={BASE_Y - 34}
        textAnchor={caretAnchor(xNow)}
        fill={late ? 'var(--color-survey)' : 'var(--color-ink)'}
        className="collar"
        style={{ fontSize: 13 }}
      >
        {endedAt
          ? `Back ${clock(endedAt)}`
          : late
            ? `${formatSpan(overrunS)} over`
            : `${formatSpan(remainingS)} left`}
      </text>
    </svg>
  );
}

/** Keep the caret's label inside the frame when now sits against either end. */
function caretLabelX(x: number): number {
  if (x < X0 + 90) return X0;
  if (x > X1 - 90) return X1;
  return x;
}

function caretAnchor(x: number): 'start' | 'middle' | 'end' {
  if (x < X0 + 90) return 'start';
  if (x > X1 - 90) return 'end';
  return 'middle';
}

/** `14:05`. Rendered on the server, so the timezone is the deployment's, not the reader's. */
function clock(at: Date): string {
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
