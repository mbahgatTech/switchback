/**
 * Liveness and capability reporting.
 *
 * `ping` is what the mobile app calls to decide whether it is online — a HEAD request to
 * the origin is not enough, because a captive portal answers those cheerfully.
 *
 * `config` is what lets the app adapt to a server it did not ship with. The iOS binary in
 * someone's pocket can be months behind the deploy; asking which auth providers exist
 * rather than hardcoding them means enabling Apple sign-in is a server flag flip, not an
 * App Store release.
 */
import { publicProcedure, router } from '../trpc';

export const healthRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const, at: new Date() })),

  config: publicProcedure.query(({ ctx }) => ({
    providers: {
      microsoft: Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID),
      apple: process.env.AUTH_APPLE_ENABLED === 'true',
    },
    /** Echoed back so a client can tell "signed out" from "my token stopped working". */
    authenticated: ctx.user !== null,
    attribution: {
      map: '© OpenStreetMap contributors (ODbL)',
      weather: 'Weather by Open-Meteo (CC BY 4.0)',
    },
  })),
});
