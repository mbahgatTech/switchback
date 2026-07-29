import { cadenceMonths, monthLabel } from '@switchback/core';
import type { UnitSystem, HikeMonth } from '@switchback/core';
import { formatDistance } from '@switchback/core';

/**
 * Thirteen months of hiking, as an almanac column diagram.
 *
 * This is the page's signature graphic and it is drawn the way a field almanac draws a year
 * of rainfall: bare columns rising from a hairline baseline, one per month, ruled once at the
 * top by the figure that sets the scale. Not a sparkline, and not a heat grid — both of those
 * make a year look like a dashboard, and the point of this page is that hiking is seasonal.
 *
 * **Thirteen columns, not twelve.** The first and last are the same month a year apart, at
 * opposite ends where a comparison wants them. Twelve would put this July at one end and
 * last July off the edge, and "am I out more than I was this time last year" is the question
 * a year of hiking is asked.
 *
 * **Distance sets the height, not the number of hikes.** Four evening laps of the same loop
 * and one long day out are both "4 hikes" against "1 hike", which would draw the wrong shape
 * entirely. The count is printed on hover and read out in the summary; the column is
 * kilometres, which is what a month of hiking amounts to.
 *
 * **A zero month is a tick, not nothing.** An empty column that renders as blank space is
 * indistinguishable from the end of the data. A one-pixel mark on the baseline says the month
 * exists and nobody hiked in it, which is the whole information content of a winter.
 *
 * Contour, because this is the plate that carries distance and terrain everywhere else in
 * the product. No JavaScript: percentage heights on divs, so it renders in the first paint
 * and prints correctly.
 */

/** How tall the tallest column stands. Everything else is a fraction of it. */
const PLOT_PX = 96;

/** A month with no hiking still gets a mark, so the gap is visible as a gap. */
const EMPTY_PX = 1;

export function Cadence({
  months,
  units,
  className = '',
}: {
  months: readonly HikeMonth[];
  units: UnitSystem;
  className?: string;
}) {
  const peak = Math.max(...months.map((month) => month.lengthM), 0);
  const hiked = months.reduce((sum, month) => sum + month.hikes, 0);

  // Nothing in the window. Drawing thirteen ticks under a "0 km" rule is a chart of nothing
  // pretending to be a chart of something.
  if (peak === 0) {
    return (
      <p className={`font-text text-body text-ink-muted ${className}`}>
        No hikes recorded in the last year.
      </p>
    );
  }

  return (
    <figure className={className}>
      <div
        role="img"
        aria-label={`Distance hiked each month over the last ${months.length} months: ${months
          .map((month) => `${month.month}, ${formatDistance(month.lengthM, units)}`)
          .join('; ')}.`}
        className="flex items-end gap-xs"
        style={{ height: PLOT_PX }}
      >
        {months.map((month) => (
          <div
            key={month.month}
            className="flex flex-1 items-end justify-center"
            style={{ height: '100%' }}
          >
            <div
              className={month.lengthM > 0 ? 'w-full bg-contour' : 'w-full bg-bezel'}
              style={{
                height:
                  month.lengthM > 0
                    ? `${Math.max((month.lengthM / peak) * 100, 2)}%`
                    : `${EMPTY_PX}px`,
              }}
              title={`${month.month} · ${formatDistance(month.lengthM, units)} · ${month.hikes} out`}
            />
          </div>
        ))}
      </div>

      {/*
       * The baseline is the rule the columns stand on, so it belongs to the plot rather than
       * to the axis below it — hence a border here and not a gap.
       */}
      <div className="border-t border-ink" />

      <div
        aria-hidden
        className="mt-xs flex gap-xs font-mono text-micro tracking-normal text-ink-muted"
      >
        {months.map((month, index) => (
          <span key={month.month} className="flex-1 truncate text-center">
            {monthLabel(month.month, months[index - 1]?.month)}
          </span>
        ))}
      </div>

      <figcaption className="collar mt-sm flex flex-wrap items-baseline gap-x-md">
        <span>
          Peak month <span className="font-mono text-ink">{formatDistance(peak, units)}</span>
        </span>
        <span>
          {hiked} out in {months.length} months
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * The strip a brand-new account gets.
 *
 * Same thirteen columns, all empty, so the graphic is on the page from the first visit and
 * fills in rather than appearing one day. An account with nothing on it should look like a
 * blank form, not like a broken page.
 */
export function emptyCadence(now: Date): HikeMonth[] {
  return cadenceMonths(now).map((month) => ({ month, hikes: 0, lengthM: 0, gainM: 0 }));
}
