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
 * The map, on the phone.
 *
 * MapLibre GL JS inside a `WebView`, loading `/embed/map` from our own server. The native
 * binding — `@maplibre/maplibre-react-native` — needs a development build, which needs a
 * Mac, and would have meant a second copy of the cartography written in a second language
 * and kept in step by hand. This way `buildStyle` and the trail layers are one module and
 * the two clients cannot drift. See `map-bridge` in `@switchback/core` for the protocol.
 *
 * This component is only the wire. It holds no map state: the page inside owns the viewport,
 * runs the `trails.browse` query for itself, and reports what it found. Everything the screen
 * needs arrives through `onMessage`; everything the screen decides goes back through `send`.
 *
 * **Messages are queued until the page says `ready`.** A `WebView` reports "loaded" well
 * before MapLibre has a style, and a `select` posted into a page with no source in it is
 * silently dropped. The queue means a caller never has to know which of those two moments it
 * is in — and it matters on the very first frame, where the screen restores a camera before
 * the map has finished creating one.
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
   * Which system to label summit heights in.
   *
   * The page inside the `WebView` is outside the app's React tree and carries no session, so
   * it cannot read this preference for itself. It travels twice: in the URL, which is what
   * the first frame is drawn from, and thereafter as a message — because Settings is a
   * different tab and changing it there leaves this map mounted behind it.
   */
  units: UnitSystem;
  /**
   * Whether the page should search the viewport for trails.
   *
   * False on a finished hike, which is one line handed over the bridge and nothing else. The
   * flag has to be in the URL rather than in a message because it decides whether a query
   * fires on the very first settle, which happens before any host message can arrive.
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

  /*
   * The prop as a ref, so the message handler below never goes stale and the `source`
   * object never has to be rebuilt to keep up with it.
   */
  const listener = useRef(onMessage);
  listener.current = onMessage;

  /*
   * Built once. The URL carries only what has to be true before the first frame is drawn —
   * everything after that is a message — and changing it would reload the page, which on a
   * map means throwing away the tiles the user is looking at.
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
   * Units, after the first frame.
   *
   * Skipped on mount because the URL already carried them — re-sending would restyle a map
   * that was built with the right answer, throwing away every tile it just fetched. From then
   * on it fires on every change, which is what makes a Settings edit land on a tab that was
   * never unmounted.
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
         * The `WebView`'s own scroll view has to be off. MapLibre handles touch itself, and
         * with scrolling enabled a slow drag is claimed by WKWebView's pan recogniser first —
         * the map jumps a few pixels and then stops following the finger.
         */
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
        // Nothing in this page plays media, and the default here suppresses the tap that
        // would otherwise be needed before any inline element becomes interactive.
        allowsInlineMediaPlayback
        // Canvas, not white. A white flash between load and first paint reads as a broken
        // screen on a dark app.
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
 * The JSON, as a JavaScript string literal.
 *
 * `JSON.stringify` escapes every quote, backslash and control character, which is everything
 * that could close the literal early. The two Unicode line separators it leaves alone were
 * illegal inside a JS string until ES2019 and are legal now — but a trail name genuinely can
 * contain one, and it is cheaper to escape them than to depend on which JavaScriptCore this
 * phone shipped with.
 */
function literal(json: string): string {
  return JSON.stringify(json).replace(
    /[\u2028\u2029]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
}

/**
 * Every edge pinned.
 *
 * Spelled out rather than `StyleSheet.absoluteFillObject`, which React Native 0.86 removed —
 * `absoluteFill` survives but is a registered style id, so it cannot be spread into a style
 * that adds anything of its own.
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
