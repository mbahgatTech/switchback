/**
 * The seam a paid data source (or our own recorded activities, once they outgrow the prior)
 * would slot into, so the swap is one binding rather than a rewrite of every caller.
 *
 * Async even though the model is synchronous: anything worth swapping in is a network call, and
 * a seam that had to change every call site from a value to a promise would not be one.
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
  // Synchronous underneath; there is no work here that could be deferred.
  forecast: (input) => Promise.resolve(busynessForecast(input)),
};

/**
 * First provider that returns an answer, model last. A failure falls through rather than
 * propagating — a 502 from a third party must not be what the page shows instead of a curve.
 * The result's `provider` field records which one answered.
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
