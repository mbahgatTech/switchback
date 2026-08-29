import { describe, expect, it } from 'vitest';
import type { AddLayerObject, Map as MapLibreMap } from 'maplibre-gl';
import { SCHEMES } from '@switchback/ui';
import { CASING } from '../src/components/map/basemap';
import { addRecordLayers } from '../src/components/record/record-map';

/**
 * The recording map's line hierarchy, which is the whole of the fix for a trail that vanished
 * under the track recorded along it.
 *
 * Assertions about the style object rather than about pixels, for the reason `basemap.test.ts`
 * gives: rendering is MapLibre's and is tested upstream, while which line is wider than which
 * is ours and is decidable by walking the layers.
 */

/** Enough of a map to record what a style asks it to draw. */
function styleRecorder() {
  const sources: string[] = [];
  const layers: AddLayerObject[] = [];
  const instance = {
    getSource: (id: string) => (sources.includes(id) ? {} : undefined),
    addSource: (id: string) => void sources.push(id),
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    addLayer: (layer: AddLayerObject) => void layers.push(layer),
  } as unknown as MapLibreMap;

  return { instance, sources, layers };
}

function widthOf(layers: readonly AddLayerObject[], id: string): number {
  const layer = layers.find((candidate) => candidate.id === id);
  const paint = (layer as { paint?: Record<string, unknown> } | undefined)?.paint;
  return paint?.['line-width'] as number;
}

function drawnAt(layers: readonly AddLayerObject[], id: string): number {
  return layers.findIndex((layer) => layer.id === id);
}

describe('the trail and the track where they lie on top of one another', () => {
  const { instance, layers } = styleRecorder();
  addRecordLayers(instance);

  it('leaves the trail reading either side of the track that covers it', () => {
    // The track's casing, not its line, is what has to clear the trail: the casing is the
    // wider of the two and is what erased the green before.
    const trail = widthOf(layers, 'rec-route-line');
    const trackCasing = widthOf(layers, 'rec-track-casing');
    expect(trackCasing).toBeLessThan(trail);
    expect(widthOf(layers, 'rec-track-line')).toBeLessThan(trackCasing);
    // Three pixels a side is a line; one is a fringe.
    expect((trail - trackCasing) / 2).toBeGreaterThanOrEqual(2.5);
  });

  it('draws the trail first, so the track is the thread and not the ribbon', () => {
    expect(drawnAt(layers, 'rec-route-casing')).toBeLessThan(drawnAt(layers, 'rec-route-line'));
    expect(drawnAt(layers, 'rec-route-line')).toBeLessThan(drawnAt(layers, 'rec-track-casing'));
    expect(drawnAt(layers, 'rec-track-line')).toBeLessThan(drawnAt(layers, 'rec-position'));
  });

  it('sets the green against a casing, since the basemap it crosses is itself green', () => {
    const trail = layers.find((layer) => layer.id === 'rec-route-line');
    expect((trail as { paint: Record<string, unknown> }).paint['line-color']).toBe(
      SCHEMES.field.woodland,
    );
    const casing = layers.find((layer) => layer.id === 'rec-route-casing');
    expect((casing as { paint: Record<string, unknown> }).paint['line-color']).toBe(CASING);
    expect(widthOf(layers, 'rec-route-casing')).toBeGreaterThan(widthOf(layers, 'rec-route-line'));
  });

  it('adds each layer once when a base-map change replays it', () => {
    const replayed = styleRecorder();
    addRecordLayers(replayed.instance);
    addRecordLayers(replayed.instance);
    const ids = replayed.layers.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(replayed.sources).size).toBe(replayed.sources.length);
  });
});
