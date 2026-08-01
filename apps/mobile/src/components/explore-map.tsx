import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { MapIn, MapOut, UnitSystem } from '@switchback/core';
import { encodeMapIn, parseMapOut } from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { apiBaseUrl } from '@/config';

/**
 * The map: MapLibre GL JS inside a `WebView` loading `/embed/map` from our own server, so the
 * cartography is one module shared with the website. Read `docs/mobile.md` and the `map-bridge`
 * protocol in `@switchback/core` before changing either side of it.
 *
 * This component is only the wire — the page owns the viewport and runs its own `trails.browse`.
 * Messages are queued until the page says `ready`: a `WebView` reports "loaded" long before
 * MapLibre has a style, and a `select` posted into a page with no source is silently dropped.
 */

const theme = nativeTheme('field');

export interface ExploreMapHandle {
  /** Post a message to the map, or hold it until the map is ready to receive one. */
  send: (message: MapIn) => void;
  /** Reload the page. The only recovery from a load failure, and the screen offers it. */
  reload: () => void;
}

export interface ExploreMapProps {
  initialCenter: readonly [number, number];
  initialZoom: number;
  onMessage: (message: MapOut) => void;
  /**
   * Which system to label summit heights in. The page is outside the app's React tree and
   * carries no session, so this travels twice: in the URL for the first frame, and thereafter
   * as a message, because Settings is a different tab and leaves this map mounted behind it.
   */
  units: UnitSystem;
  /**
   * Whether the page should search the viewport for trails. False on a finished hike. It has to
   * be in the URL rather than a message: it decides whether a query fires on the first settle,
   * which happens before any host message can arrive.
   */
  browse?: boolean;
}

export const ExploreMap = forwardRef<ExploreMapHandle, ExploreMapProps>(function ExploreMap(
  { initialCenter, initialZoom, onMessage, units, browse = true },
  ref,
) {
  const webview = useRef<WebView | null>(null);
  const ready = useRef(false);
  const queue = useRef<string[]>([]);
  const [showing, setShowing] = useState(false);

  // The prop as a ref, so the message handler never goes stale and `source` never rebuilds.
  const listener = useRef(onMessage);
  listener.current = onMessage;

  /*
   * Built once. The URL carries only what has to be true before the first frame — everything
   * after that is a message — and changing it would reload the page, throwing away the tiles.
   */
  const source = useMemo(() => {
    const params = new URLSearchParams({
      lng: String(initialCenter[0]),
      lat: String(initialCenter[1]),
      zoom: String(initialZoom),
      units,
      ...(browse ? {} : { trails: '0' }),
    });
    return { uri: `${apiBaseUrl()}/embed/map?${params.toString()}` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = useCallback((raw: string) => {
    webview.current?.injectJavaScript(
      `window.__switchbackMapIn && window.__switchbackMapIn(${literal(raw)}); true;`,
    );
  }, []);

  const send = useCallback(
    (message: MapIn) => {
      const raw = encodeMapIn(message);
      if (ready.current) post(raw);
      else queue.current.push(raw);
    },
    [post],
  );

  useImperativeHandle(
    ref,
    () => ({
      send,
      reload: () => {
        ready.current = false;
        setShowing(false);
        webview.current?.reload();
      },
    }),
    [send],
  );

  /*
   * Units, after the first frame only. The URL already carried them on mount, and re-sending
   * would restyle a map built with the right answer, discarding every tile it just fetched.
   */
  const firstUnits = useRef(true);
  useEffect(() => {
    if (firstUnits.current) {
      firstUnits.current = false;
      return;
    }
    send({ type: 'units', units });
  }, [send, units]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseMapOut(event.nativeEvent.data);
      // A message this build does not understand is a message from a newer page, and the
      // right response to it is nothing at all. See `map-bridge`.
      if (!message) return;
      if (message.type === 'ready') {
        ready.current = true;
        setShowing(true);
        const held = queue.current;
        queue.current = [];
        for (const raw of held) post(raw);
      }
      listener.current(message);
    },
    [post],
  );

  const fail = useCallback((message: string) => {
    listener.current({ type: 'error', message });
  }, []);

  return (
    <View style={styles.frame}>
      <WebView
        ref={webview}
        source={source}
        onMessage={handleMessage}
        onLoadStart={() => {
          ready.current = false;
        }}
        onError={(event) => fail(event.nativeEvent.description)}
        onHttpError={(event) =>
          fail(`The map server answered ${String(event.nativeEvent.statusCode)}.`)
        }
        /*
         * The `WebView`'s own scroll view has to be off: MapLibre handles touch itself, and
         * with scrolling on, a slow drag is claimed by WKWebView's pan recogniser first.
         */
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
        // Suppresses the tap iOS would otherwise need before an inline element is interactive.
        allowsInlineMediaPlayback
        // Canvas, not white: a white flash before first paint reads as a broken screen.
        style={styles.web}
        containerStyle={styles.web}
      />
      {showing ? null : (
        <View style={styles.veil} pointerEvents="none">
          <ActivityIndicator color={theme.color.inkMuted} />
        </View>
      )}
    </View>
  );
});

/**
 * The JSON, as a JavaScript string literal. The two Unicode line separators `JSON.stringify`
 * leaves alone are legal in a JS string only since ES2019, and a trail name genuinely can hold
 * one — cheaper to escape them than to depend on which JavaScriptCore this phone shipped with.
 */
function literal(json: string): string {
  return JSON.stringify(json).replace(
    /[\u2028\u2029]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
}

/**
 * Every edge pinned. Spelled out because React Native 0.86 removed `absoluteFillObject`, and
 * `absoluteFill` is a registered style id, so it cannot be spread into a style of its own.
 */
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  frame: { ...fill, backgroundColor: theme.color.canvas },
  web: { flex: 1, backgroundColor: theme.color.canvas },
  veil: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.canvas,
  },
});
