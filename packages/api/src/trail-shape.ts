/**
 * The trail card, as one select and one mapper. Outside `routers/trails.ts` because lists,
 * profile completions and search all render the same card from the same columns; the map,
 * detail and search shapes extend this rather than repeat it.
 */

import type { Prisma } from '@switchback/db';
import type { TrailSummary } from '@switchback/core';

/**
 * Exactly the columns a card needs. Spelled out because the omissions are the point: no `geom`
 * (Prisma cannot read it), no `searchVector`, and no `description`, the largest column on the
 * table and never shown on a card.
 */
export const summarySelect = {
  id: true,
  slug: true,
  name: true,
  displayName: true,
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
    displayName: row.displayName,
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
