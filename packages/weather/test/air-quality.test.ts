import { describe, expect, it } from 'vitest';
import type { BBox } from '@switchback/core';
import {
  AQI_GRID_MAX_CELLS,
  AQI_MAX_STEP_DEG,
  AQI_MODEL_EUROPE,
  AQI_MODEL_EUROPE_DEG,
  AQI_MODEL_GLOBAL,
  AQI_MODEL_GLOBAL_DEG,
  airQualityAt,
  airQualityGrid,
  airQualityGridKey,
  airQualityPointKey,
  dominantPollutant,
  modelFor,
  planGrid,
} from '../src/air-quality';
import type { AirQualityNow, OpenMeteoClient } from '../src/open-meteo';

/**
 * The lattice, tested for the two things that can quietly go wrong with it.
 *
 * One is *overclaiming*: drawing cells finer than the model that produced them, which turns
 * sixteen copies of one number into sixteen apparent readings. The other is *drift*: a
 * lattice whose cell boundaries depend on where the viewport happened to start, so the same
 * ground changes colour when the reader pans past it and back.
 */

/** A reading with everything null but the fields a test names. */
function reading(over: Partial<AirQualityNow> = {}): AirQualityNow {
  return {
    lat: 0,
    lng: 0,
    timeS: 0,
    europeanAqi: null,
    pm25Index: null,
    pm10Index: null,
    no2Index: null,
    ozoneIndex: null,
    so2Index: null,
    pm25: null,
    ...over,
  };
}

interface Asked {
  lat: number;
  lng: number;
}

/** A client that records what it was asked and answers point-for-point. */
function stubClient(answer: (point: Asked, index: number) => AirQualityNow) {
  const asked: Asked[] = [];
  let calls = 0;
  const client = {
    airQualityNow: (points: readonly Asked[]) => {
      calls += 1;
      asked.push(...points);
      return Promise.resolve(points.map(answer));
    },
  };
  return { asked, calls: () => calls, client: client as unknown as OpenMeteoClient };
}

describe('modelFor', () => {
  it('claims the European model only when the whole box is inside its domain', () => {
    expect(modelFor([-4.2, 53, -4, 53.2])).toEqual({
      label: AQI_MODEL_EUROPE,
      resolutionDeg: AQI_MODEL_EUROPE_DEG,
    });
  });

  it('falls back to the global model for a box straddling the domain edge', () => {
    // The overclaim this guards against: half of this box is answered by CAMS global at
    // 0.4°, so the whole of it has to be drawn at 0.4°.
    expect(modelFor([-26, 40, -24, 42]).resolutionDeg).toBe(AQI_MODEL_GLOBAL_DEG);
    expect(modelFor([44, 71, 46, 73]).label).toBe(AQI_MODEL_GLOBAL);
  });

  it('uses the global model outside Europe entirely', () => {
    expect(modelFor([-122, 47.9, -121, 48.3]).label).toBe(AQI_MODEL_GLOBAL);
  });
});

describe('planGrid', () => {
  it('puts cell centres on multiples of the step, which is where the model computes', () => {
    const plan = planGrid([-4.05, 53.02, -3.95, 53.08]);

    expect(plan.stepDeg).toBe(AQI_MODEL_EUROPE_DEG);
    expect(plan.cells.length).toBeGreaterThan(0);
    for (const cell of plan.cells) {
      expect(cell.lng / AQI_MODEL_EUROPE_DEG).toBeCloseTo(
        Math.round(cell.lng / AQI_MODEL_EUROPE_DEG),
        6,
      );
      expect(cell.lat / AQI_MODEL_EUROPE_DEG).toBeCloseTo(
        Math.round(cell.lat / AQI_MODEL_EUROPE_DEG),
        6,
      );
    }
  });

  it('gives each cell the model footprint, half a step either side of its centre', () => {
    const cells = planGrid([-4.02, 53.02, -3.98, 53.04]).cells;
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    const [w, s, e, n] = cell.bbox;
    expect(e - w).toBeCloseTo(AQI_MODEL_EUROPE_DEG, 6);
    expect(n - s).toBeCloseTo(AQI_MODEL_EUROPE_DEG, 6);
    expect((w + e) / 2).toBeCloseTo(cell.lng, 6);
    expect((s + n) / 2).toBeCloseTo(cell.lat, 6);
  });

  it('lands the same ground in the same cell however the viewport was framed', () => {
    // The anti-drift property. Two viewports sharing a point must agree about which cell
    // that point is in, or the overlay shimmers under a pan and the cache never warms.
    const wide = planGrid([-4.3, 52.9, -3.9, 53.2]);
    const narrow = planGrid([-4.1, 53, -4, 53.1]);
    expect(wide.stepDeg).toBe(narrow.stepDeg);

    const holds = (plan: ReturnType<typeof planGrid>) =>
      plan.cells.find(
        (cell) =>
          -4.05 >= cell.bbox[0] &&
          -4.05 < cell.bbox[2] &&
          53.07 >= cell.bbox[1] &&
          53.07 < cell.bbox[3],
      );

    const a = holds(wide);
    const b = holds(narrow);
    expect(a).toBeDefined();
    expect(a!.bbox).toEqual(b?.bbox);
  });

  it('coarsens by doubling until the cell count fits, and says that it did', () => {
    const plan = planGrid([-4, 50, -2, 52]);

    expect(plan.cells.length).toBeGreaterThan(0);
    expect(plan.cells.length).toBeLessThanOrEqual(AQI_GRID_MAX_CELLS);
    expect(plan.coarsened).toBe(true);
    // Every rung of the ladder is a whole number of model cells, which is what keeps the
    // coarse lattice aligned with the fine one underneath it.
    expect(plan.stepDeg / AQI_MODEL_EUROPE_DEG).toBeCloseTo(
      Math.round(plan.stepDeg / AQI_MODEL_EUROPE_DEG),
      6,
    );
  });

  it('never draws finer than the model, however small the viewport', () => {
    // A hundred metres of valley gets one cell at the model's size — not one tiny cell
    // implying the model knows anything about that valley in particular.
    const plan = planGrid([-4.001, 53.001, -4, 53.002]);
    expect(plan.stepDeg).toBe(AQI_MODEL_EUROPE_DEG);
    expect(plan.coarsened).toBe(false);
    expect(plan.cells).toHaveLength(1);
  });

  it('gives up rather than paint six colours over a continent', () => {
    const plan = planGrid([-180, -85, 180, 85]);
    expect(plan.cells).toHaveLength(0);
    expect(plan.stepDeg).toBeGreaterThan(AQI_MAX_STEP_DEG);
    expect(plan.coarsened).toBe(true);
  });

  it('clamps to the latitudes Web Mercator can actually show', () => {
    // `getBounds` will report ±90 on a zoomed-out map. Asking a weather model about 89°N
    // over ground the reader cannot see spends the cell budget on nothing.
    const plan = planGrid([-2, -90, -1, -60]);
    expect(plan.cells.length).toBeGreaterThan(0);
    for (const cell of plan.cells) expect(cell.lat).toBeGreaterThanOrEqual(-85);
  });
});

describe('airQualityGrid', () => {
  it('asks once for every cell and answers in the same order', async () => {
    const stub = stubClient((point, i) => reading({ ...point, europeanAqi: 20 + i, timeS: 1_000 }));

    const grid = await airQualityGrid([-4.05, 53.02, -3.95, 53.08], {
      client: stub.client,
      now: () => 0,
    });

    expect(stub.calls()).toBe(1);
    expect(stub.asked).toHaveLength(grid.cells.length);
    expect(grid.model).toBe(AQI_MODEL_EUROPE);
    expect(grid.stepDeg).toBe(AQI_MODEL_EUROPE_DEG);
    expect(grid.coarsened).toBe(false);
    expect(grid.cells.map((cell) => cell.europeanAqi)).toEqual(grid.cells.map((_, i) => 20 + i));
  });

  it('stamps the grid with the hour upstream computed, not with our own clock', async () => {
    const stub = stubClient((point) => reading({ ...point, europeanAqi: 30, timeS: 1_000 }));

    const grid = await airQualityGrid([-4.02, 53.02, -3.98, 53.04], {
      client: stub.client,
      // An hour ahead of the reading, which is what a late-publishing model looks like.
      now: () => 7_200_000,
    });

    expect(grid.observedAt).toBe(new Date(1_000_000).toISOString());
  });

  it('keeps a cell the model had no answer for, as a null rather than a zero', async () => {
    const stub = stubClient((point, i) =>
      reading({ ...point, europeanAqi: i === 0 ? null : 30, timeS: 1_000 }),
    );

    const grid = await airQualityGrid([-4.05, 53.02, -3.95, 53.04], {
      client: stub.client,
      now: () => 0,
    });

    expect(grid.cells.length).toBeGreaterThan(1);
    expect(grid.cells[0]?.europeanAqi).toBeNull();
  });

  it('makes no upstream call at all when the viewport is past the coarsening floor', async () => {
    const stub = stubClient((point) => reading(point));

    const grid = await airQualityGrid([-180, -85, 180, 85], {
      client: stub.client,
      now: () => 3_600_000,
    });

    expect(stub.calls()).toBe(0);
    expect(grid.cells).toHaveLength(0);
    expect(grid.coarsened).toBe(true);
    // Still stamped, so the key can say which hour it has nothing for.
    expect(grid.observedAt).toBe(new Date(3_600_000).toISOString());
  });

  it('wraps longitudes for the request while the footprint stays continuous', async () => {
    const stub = stubClient((point) => reading({ ...point, europeanAqi: 10, timeS: 1_000 }));

    const grid = await airQualityGrid([179.5, 40, 180.5, 40.5], {
      client: stub.client,
      now: () => 0,
    });

    for (const point of stub.asked) {
      expect(point.lng).toBeGreaterThanOrEqual(-180);
      expect(point.lng).toBeLessThanOrEqual(180);
    }
    // Drawn beside its neighbour rather than jumped the width of the world.
    expect(grid.cells.length).toBeGreaterThan(0);
    for (const cell of grid.cells) {
      expect(cell.bbox[2] - cell.bbox[0]).toBeCloseTo(AQI_MODEL_GLOBAL_DEG, 6);
    }
  });
});

describe('airQualityAt', () => {
  it('snaps the request to the model lattice and reports the model resolution', async () => {
    const stub = stubClient((point) =>
      reading({ ...point, europeanAqi: 47, ozoneIndex: 47, pm25: 8.4, timeS: 7_200 }),
    );

    const at = await airQualityAt(-4.0512, 53.0688, { client: stub.client, now: () => 0 });

    expect(stub.asked[0]).toEqual({ lat: 53.1, lng: -4.1 });
    expect(at.europeanAqi).toBe(47);
    expect(at.dominant).toBe('o3');
    expect(at.pm25).toBe(8.4);
    expect(at.model).toBe(AQI_MODEL_EUROPE);
    expect(at.stepDeg).toBe(AQI_MODEL_EUROPE_DEG);
    expect(at.observedAt).toBe(new Date(7_200_000).toISOString());
  });

  it('answers with a null reading rather than throwing when upstream returns nothing', async () => {
    const empty = { airQualityNow: () => Promise.resolve([]) } as unknown as OpenMeteoClient;

    const at = await airQualityAt(-121.49, 48.03, { client: empty, now: () => 3_600_000 });

    expect(at.europeanAqi).toBeNull();
    expect(at.dominant).toBeNull();
    expect(at.pm25).toBeNull();
    expect(at.model).toBe(AQI_MODEL_GLOBAL);
    expect(at.stepDeg).toBe(AQI_MODEL_GLOBAL_DEG);
    expect(at.observedAt).toBe(new Date(3_600_000).toISOString());
  });
});

describe('dominantPollutant', () => {
  it('names the sub-index that equals the headline, because the index is their maximum', () => {
    expect(
      dominantPollutant(
        reading({ europeanAqi: 62, pm25Index: 30, pm10Index: 41, no2Index: 12, ozoneIndex: 62 }),
      ),
    ).toBe('o3');
  });

  it('tolerates a point of rounding between the headline and its sub-index', () => {
    expect(dominantPollutant(reading({ europeanAqi: 62, pm10Index: 61 }))).toBe('pm10');
  });

  it('says nothing when the sub-indices cannot account for the headline', () => {
    // Upstream inconsistency. Blaming the largest of five numbers that do not add up would
    // be a guess dressed as a finding.
    expect(
      dominantPollutant(reading({ europeanAqi: 90, pm25Index: 30, ozoneIndex: 40 })),
    ).toBeNull();
  });

  it('breaks a tie the same way every time', () => {
    // A strict `>` keeps the earlier pollutant, and the list is a constant, so two equal
    // sub-indices never make the sentence under the number flicker between refreshes.
    expect(dominantPollutant(reading({ europeanAqi: 55, pm25Index: 55, ozoneIndex: 55 }))).toBe(
      'pm2_5',
    );
  });

  it('returns null when nothing was reported', () => {
    expect(dominantPollutant(reading({ europeanAqi: 40 }))).toBeNull();
  });

  it('still names one when the headline itself is missing', () => {
    expect(dominantPollutant(reading({ europeanAqi: null, no2Index: 12 }))).toBe('no2');
  });
});

describe('cache keys', () => {
  it('gives two viewports over the same cells the same key', () => {
    // Half a pan of drag between them, and not one pixel of difference in the answer.
    expect(airQualityGridKey([-4.04, 53.03, -3.96, 53.07], 0)).toBe(
      airQualityGridKey([-4.049, 53.021, -3.951, 53.079], 0),
    );
  });

  it('separates viewports whose lattices differ', () => {
    expect(airQualityGridKey([-4.05, 53, -3.95, 53.1], 0)).not.toBe(
      airQualityGridKey([-5.05, 53, -4.95, 53.1], 0),
    );
  });

  it('retires a key when the hour turns, and not a moment before', () => {
    const bbox: BBox = [-4.05, 53, -3.95, 53.1];
    expect(airQualityGridKey(bbox, 0)).toBe(airQualityGridKey(bbox, 3_599_999));
    expect(airQualityGridKey(bbox, 0)).not.toBe(airQualityGridKey(bbox, 3_600_000));
  });

  it('shares one point key across every coordinate in the same model cell', () => {
    // Every trail in one 0.1° cell breathes the same air and should cost one call between
    // them, however many of them there are.
    expect(airQualityPointKey(-4.03, 53.07, 0)).toBe(airQualityPointKey(-4.02, 53.12, 0));
    expect(airQualityPointKey(-4.03, 53.07, 0)).not.toBe(airQualityPointKey(-4.03, 53.27, 0));
  });
});
