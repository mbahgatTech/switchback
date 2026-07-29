/**
 * The trail card, as one select and one mapper.
 *
 * It lives outside `routers/trails.ts` because it is no longer only the trails router's
 * business: a list, a profile's completions, and later an activity feed all render the exact
 * same card, and every one of them wants the same columns. Copying the select into each
 * router is how a photo starts appearing on a search result and not on a saved one.
 *
 * The map, detail and search shapes are still built from this in `routers/trails.ts` — they
 * extend it rather than repeat it, so a column added here reaches all of them.
 */

import type { Prisma } from '@switchback/db';
import type { TrailSummary } from '@switchback/core';

/**
 * Exactly the columns a card needs.
 *
 * Spelled out rather than defaulting to the whole row because the omissions are the point:
 * no `geom`, which Prisma cannot read anyway; no `searchVector`; and no `description`,
 * which is the largest column on the table and is never shown on a card.
 */
export const summarySelect = {
  id: true,
  slug: true,
  name: true,
  difficulty: true,
  routeType: true,
  activityTypes: true,
  lengthM: true,
  gainM: true,
  lossM: true,
  minEleM: true,
  maxEleM: true,
  maxSustainedGrade: true,
  estimatedTimeS: true,
  centroidLng: true,
  centroidLat: true,
  bboxW: true,
  bboxS: true,
  bboxE: true,
  bboxN: true,
  rating: true,
  reviewCount: true,
  photoCount: true,
  regionName: true,
  primaryPhoto: { select: { url: true, thumbUrl: true } },
} satisfies Prisma.TrailSelect;

export type SummaryRow = Prisma.TrailGetPayload<{ select: typeof summarySelect }>;

export function toSummary(row: SummaryRow): TrailSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    difficulty: row.difficulty,
    routeType: row.routeType,
    activityTypes: row.activityTypes,
    stats: {
      lengthM: row.lengthM,
      gainM: row.gainM,
      lossM: row.lossM,
      minEleM: row.minEleM,
      maxEleM: row.maxEleM,
      maxSustainedGrade: row.maxSustainedGrade,
      estimatedTimeS: row.estimatedTimeS,
    },
    centroid: [row.centroidLng, row.centroidLat],
    bbox: [row.bboxW, row.bboxS, row.bboxE, row.bboxN],
    rating: row.rating,
    reviewCount: row.reviewCount,
    photoCount: row.photoCount,
    // The card wants the thumbnail; the full image is loaded on the detail page.
    primaryPhotoUrl: row.primaryPhoto?.thumbUrl ?? row.primaryPhoto?.url ?? null,
    regionName: row.regionName,
  };
}
