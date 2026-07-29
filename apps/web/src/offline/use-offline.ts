'use client';

/**
 * The offline state a component can actually use.
 *
 * Three separate hooks rather than one context, because they have three different lifetimes.
 * Connectivity changes constantly and everything wants it; the download list changes when the
 * user acts on it and only two pages care; a single trail's download state belongs to the
 * button that started it and dies with the page. A provider holding all three would re-render
 * a map on every flicker of the network.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TrailDetail } from '@switchback/core';
import { downloadTrail, planDownload, type DownloadProgress } from './download';
import { evictTrails, requestPersistence, storageEstimate } from './evict';
import { getOfflineTrail, listOfflineTrails, type OfflineTrail } from './store';

function subscribeToConnectivity(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * Whether the browser thinks it has a connection.
 *
 * `navigator.onLine` is famously weak — it reports the link, not the internet, so a phone
 * attached to a café's captive portal reads as online. It is still worth having, because the
 * case this product cares about is the honest one: airplane mode, or no bars on a ridge.
 * Everything downstream treats it as a hint and still handles a failed fetch.
 *
 * `useSyncExternalStore` rather than state in an effect, so the server render and the first
 * client render agree — the server snapshot is `true`, which is the assumption every page is
 * already written under.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine,
    () => true,
  );
}

export interface DownloadsState {
  trails: OfflineTrail[];
  /** Bytes we measured across every download. Sums shared tiles once per download, so it over-reports slightly. */
  bytes: number;
  /** What the browser reports for the whole origin, and the ceiling it will allow. */
  storage: { usage: number; quota: number } | null;
  loading: boolean;
  refresh: () => Promise<void>;
  remove: (trailIds: readonly string[]) => Promise<void>;
}

/** Everything taken offline, for the storage manager. */
export function useDownloads(): DownloadsState {
  const [trails, setTrails] = useState<OfflineTrail[]>([]);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [rows, estimate] = await Promise.all([listOfflineTrails(), storageEstimate()]);
    setTrails(rows);
    setStorage(estimate);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    async (trailIds: readonly string[]) => {
      await evictTrails(trailIds);
      await refresh();
    },
    [refresh],
  );

  return {
    trails,
    bytes: trails.reduce((sum, row) => sum + row.bytes, 0),
    storage,
    loading,
    refresh,
    remove,
  };
}

export type TrailDownloadState =
  | { status: 'checking' }
  | { status: 'absent'; tiles: number; estimatedBytes: number }
  | { status: 'downloading'; progress: DownloadProgress }
  | { status: 'ready'; row: OfflineTrail }
  | { status: 'failed'; message: string };

export interface TrailDownloadApi {
  state: TrailDownloadState;
  start: () => void;
  cancel: () => void;
  remove: () => void;
}

/**
 * One trail's download, driving one button.
 *
 * Deliberately does not use react-query. The work is neither a server read nor a server
 * mutation — it is a long local job that reports progress and can be cancelled, and modelling
 * it as a query means either a cache key that lies or a mutation that cannot report progress.
 */
export function useTrailDownload(trail: TrailDetail): TrailDownloadApi {
  const [state, setState] = useState<TrailDownloadState>({ status: 'checking' });
  const abort = useRef<AbortController | null>(null);

  // Cheap and pure — the corridor maths, without touching the network.
  const plan = useCallback((): TrailDownloadState => {
    const { tiles, estimatedBytes } = planDownload(trail);
    return { status: 'absent', tiles, estimatedBytes };
  }, [trail]);

  useEffect(() => {
    let live = true;
    void getOfflineTrail(trail.id)
      .then((row) => {
        if (!live) return;
        setState(row ? { status: 'ready', row } : plan());
      })
      .catch(() => {
        // A browser with IndexedDB blocked (private mode, some enterprise policies) is not a
        // broken page — it is a page where downloading is not on offer.
        if (live)
          setState({
            status: 'failed',
            message: 'Offline storage is unavailable in this browser.',
          });
      });
    return () => {
      live = false;
    };
  }, [trail.id, plan]);

  useEffect(
    () => () => {
      // Leaving the page stops the download rather than letting it run against a component
      // that can no longer report on it.
      abort.current?.abort();
    },
    [],
  );

  const start = useCallback(() => {
    const controller = new AbortController();
    abort.current = controller;
    setState({
      status: 'downloading',
      progress: { phase: 'planning', done: 0, total: 1, bytes: 0 },
    });

    void requestPersistence()
      .then(() =>
        downloadTrail(trail, {
          signal: controller.signal,
          onProgress: (progress) => setState({ status: 'downloading', progress }),
        }),
      )
      .then((row) => setState({ status: 'ready', row }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setState(plan());
          return;
        }
        setState({
          status: 'failed',
          message: error instanceof Error ? error.message : 'The download did not finish.',
        });
      });
  }, [trail, plan]);

  const cancel = useCallback(() => {
    abort.current?.abort();
  }, []);

  const remove = useCallback(() => {
    void evictTrails([trail.id]).then(() => setState(plan()));
  }, [trail.id, plan]);

  return { state, start, cancel, remove };
}
