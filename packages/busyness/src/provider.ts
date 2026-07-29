/**
 * The seam a paid data source would slot into.
 *
 * The model in this package is an estimate and says so. If ground truth ever becomes
 * available — BestTime.app sells it, and our own recorded activities will eventually
 * outgrow the prior on popular trails — the swap should be one binding, not a rewrite of
 * every caller. Hence an interface with exactly one method, and a `provider` string on the
 * result so the UI can attribute whatever answered.
 *
 * The interface is async even though the model is synchronous. Anything worth swapping in
 * is a network call, and a provider that had to be introduced by changing every call site
 * from a value to a promise would not be much of a seam.
 */

import type { BusynessForecast } from '@switchback/core';
import { MODEL_PROVIDER, busynessForecast, type BusynessInput } from './forecast';

export interface BusynessProvider {
  readonly name: string;
  forecast(input: BusynessInput): Promise<BusynessForecast>;
}

/** The default: our own model, from OSM tags and whatever our users have recorded. */
export const modelProvider: BusynessProvider = {
  name: MODEL_PROVIDER,
  // Synchronous underneath, and `Promise.resolve` says so more honestly than an `async`
  // wrapper with nothing to await: there is no work here that could ever be deferred.
  forecast: (input) => Promise.resolve(busynessForecast(input)),
};

/**
 * First provider that returns an answer, model last.
 *
 * A paid source is worth asking first and worth nothing when it is down, so a failure
 * falls through rather than propagating: busy times are a nice-to-have on a trail page,
 * and a 502 from a third party must not be what the page shows instead of a curve. The
 * `provider` field records which one actually answered.
 */
export function firstAvailable(...providers: readonly BusynessProvider[]): BusynessProvider {
  const chain = providers.length > 0 ? providers : [modelProvider];
  return {
    name: chain.map((p) => p.name).join('→'),
    forecast: async (input) => {
      let lastError: unknown;
      for (const provider of chain) {
        try {
          return await provider.forecast(input);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('No busyness provider answered');
    },
  };
}
