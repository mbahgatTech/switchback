export { BACKGROUND_POOL_SIZE, backgroundPrisma, prisma } from './client';
export type { PrismaClient } from './client';
export { createEntraAdapter, createEntraPool, resetTokenProviderForTests } from './entra-client';
export type { EntraPoolSizing } from './entra-client';
export { entraPoolConfig } from './entra-pool';
export type { EntraPoolOptions } from './entra-pool';
export { createEntraTokenSource, databaseAuthMode, POSTGRES_SCOPE } from './entra-source';
export type { DatabaseAuthMode } from './entra-source';
export { CONNECTION_LIFETIME_S, RENEW_MARGIN_MS, createTokenProvider } from './entra-token';
export type { AccessToken, TokenProviderOptions, TokenSource } from './entra-token';
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
  ContentReport,
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
  ReportReason,
  ReportStatus,
  ReportSubject,
  UserRole,
} from '@prisma/client';
