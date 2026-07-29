/**
 * Places — "where is that?", as distinct from "what is here?".
 *
 * `trails.browse` answers the second question and is viewport-scoped, which is right: it
 * searches the tiles we hold. But it makes the first question unanswerable, and the first
 * question is the one people actually open the app with. Someone who types "Vesper Peak"
 * while the map sits over Snowdonia gets "no trails" from a viewport search — a true
 * statement that reads as *we have never heard of this place*.
 *
 * This router is the other half. A name resolves to a coordinate here, the client moves
 * the map there, and the ordinary on-demand ingest that fires on any viewport change picks
 * up the trails. Nothing about the lazy pipeline changes; it just becomes reachable by
 * name instead of only by dragging.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bboxSchema } from '@switchback/core';
import { getGeocoder } from '@switchback/ingest';
import type { GeocodedPlace } from '@switchback/ingest';
import { publicProcedure, router } from '../trpc';

/**
 * OSM place classes worth showing, mapped to the plate that draws them.
 *
 * Not a filter — anything unlisted still appears, because a gazetteer of the whole planet
 * will always know a category we did not think of, and dropping results to keep an icon
 * table tidy is the wrong trade. It is a hint the UI uses to distinguish a summit from a
 * city at a glance, in the same five-plate vocabulary the rest of the product uses:
 * terrain is `contour`, water is `water`, protected land is `woodland`, settlements are
 * structure and so stay `ink`.
 */
const PLACE_PLATE: Record<string, 'contour' | 'water' | 'woodland' | 'ink'> = {
  peak: 'contour',
  volcano: 'contour',
  ridge: 'contour',
  saddle: 'contour',
  cliff: 'contour',
  glacier: 'contour',
  valley: 'contour',
  water: 'water',
  lake: 'water',
  reservoir: 'water',
  bay: 'water',
  river: 'water',
  stream: 'water',
  waterfall: 'water',
  beach: 'water',
  national_park: 'woodland',
  protected_area: 'woodland',
  nature_reserve: 'woodland',
  park: 'woodland',
  forest: 'woodland',
  wood: 'woodland',
  wilderness: 'woodland',
};

/**
 * How places sort when several match.
 *
 * Nominatim ranks by its own notion of importance, which is Wikipedia-weighted and puts
 * cities above summits. For a trail product that ordering is backwards: someone typing a
 * name into a hiking app means the mountain more often than the suburb named after it.
 * Terrain and protected land float; everything else keeps Nominatim's order beneath.
 */
const PLATE_RANK: Record<string, number> = { contour: 0, woodland: 1, water: 2, ink: 3 };

export interface PlaceResult extends GeocodedPlace {
  plate: 'contour' | 'water' | 'woodland' | 'ink';
  /** `Peak`, `National park` — the kind, said the way a person would say it. */
  label: string;
}

function decorate(place: GeocodedPlace): PlaceResult {
  const plate = PLACE_PLATE[place.kind] ?? 'ink';
  const label = place.kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { ...place, plate, label };
}

export const placesRouter = router({
  /**
   * Resolve a typed name to somewhere on the map.
   *
   * `near` biases without bounding, so the viewport decides which "Bear Lake" comes first
   * and never decides which ones exist. Debouncing is the client's job and it matters:
   * this reaches a shared public gazetteer that allows one request per second, and the
   * client-side cache in `NominatimClient` only helps for repeats.
   */
  search: publicProcedure
    .input(
      z.object({
        q: z.string().trim().min(2).max(120),
        near: bboxSchema.optional(),
        limit: z.number().int().min(1).max(10).default(6),
      }),
    )
    .query(async ({ input }) => {
      let places: GeocodedPlace[];
      try {
        places = await getGeocoder().search(input.q, {
          limit: input.limit,
          ...(input.near ? { near: input.near } : {}),
        });
      } catch (error) {
        // A typeahead that throws is a typeahead that flashes an error under the cursor on
        // every third keystroke. The gazetteer being briefly unreachable should degrade to
        // "no place suggestions" — trail results for the current view are unaffected and
        // still render.
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[places.search]', error instanceof Error ? error.message : error);
        }
        return { places: [] as PlaceResult[], unavailable: true };
      }

      const decorated = places.map(decorate);
      decorated.sort((a, b) => (PLATE_RANK[a.plate] ?? 9) - (PLATE_RANK[b.plate] ?? 9));
      return { places: decorated, unavailable: false };
    }),

  /**
   * The same lookup, but for a caller that wants one answer and no list — a shared link
   * carrying `?place=vesper+peak`, or the mobile app resolving a name it was handed.
   */
  resolve: publicProcedure
    .input(z.object({ q: z.string().trim().min(2).max(120), near: bboxSchema.optional() }))
    .query(async ({ input }) => {
      const places = await getGeocoder().search(input.q, {
        limit: 3,
        ...(input.near ? { near: input.near } : {}),
      });
      const [first] = places
        .map(decorate)
        .sort((a, b) => (PLATE_RANK[a.plate] ?? 9) - (PLATE_RANK[b.plate] ?? 9));
      if (!first) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `No place called “${input.q}”.` });
      }
      return first;
    }),
});
