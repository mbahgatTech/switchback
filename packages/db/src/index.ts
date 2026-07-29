export { BACKGROUND_POOL_SIZE, backgroundPrisma, prisma } from './client';
export type { PrismaClient } from './client';
export * from './spatial';

// Re-exported so consumers get the generated enums and row types without adding a direct
// dependency on @prisma/client — which matters because the generated client lives in
// node_modules and importing it from two places is how version skew starts.
export { Prisma } from '@prisma/client';
export type {
  Account,
  Activity,
  ActivitySample,
  BusynessBucket,
  Completion,
  ElevationProfile,
  IngestJob,
  IngestTile,
  LifelineSession,
  MobileRefreshToken,
  Photo,
  Review,
  Session,
  Trail,
  TrailList,
  TrailListItem,
  User,
  VerificationToken,
  Waypoint,
} from '@prisma/client';
export {
  ActivityType,
  Difficulty,
  JobKind,
  JobStatus,
  ListKind,
  OsmElementType,
  PhotoSource,
  RouteType,
  SacScale,
  TileStatus,
  TrailCondition,
  UnitSystem,
  Visibility,
  WaypointKind,
  LifelineStatus,
} from '@prisma/client';
