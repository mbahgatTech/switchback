import { activitiesRouter } from './routers/activities';
import { busynessRouter } from './routers/busyness';
import { healthRouter } from './routers/health';
import { lifelineRouter } from './routers/lifeline';
import { listsRouter } from './routers/lists';
import { meRouter } from './routers/me';
import { photosRouter } from './routers/photos';
import { placesRouter } from './routers/places';
import { reviewsRouter } from './routers/reviews';
import { routesRouter } from './routers/routes';
import { trailsRouter } from './routers/trails';
import { usersRouter } from './routers/users';
import { weatherRouter } from './routers/weather';
import { router } from './trpc';

/**
 * The API surface, shared verbatim by the website and the iOS app.
 *
 * Routers are added here as each phase lands.
 */
export const appRouter = router({
  activities: activitiesRouter,
  busyness: busynessRouter,
  health: healthRouter,
  lifeline: lifelineRouter,
  lists: listsRouter,
  me: meRouter,
  photos: photosRouter,
  places: placesRouter,
  reviews: reviewsRouter,
  routes: routesRouter,
  trails: trailsRouter,
  users: usersRouter,
  weather: weatherRouter,
});

export type AppRouter = typeof appRouter;
