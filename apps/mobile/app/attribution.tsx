import { Stack, router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttributionKey } from '@switchback/core';
import { ATTRIBUTION, ATTRIBUTION_CORRECTIONS, ATTRIBUTION_SOURCES, BRAND } from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';

/**
 * Sources and licences, on the phone.
 *
 * The obligation is the reason this screen exists rather than the reason it looks like this.
 * OpenStreetMap is ODbL — attribution *and* share-alike on anything derived from it — and the
 * DEMs and the weather are CC-BY. Those are conditions on using the data at all, not credits
 * offered out of politeness, and an app that only prints "© OpenStreetMap contributors" in six
 * point type under a map has discharged the first half of one of them.
 *
 * **The list is not written here.** It comes from `@switchback/core`, the same array the
 * website renders. Two clients publishing licence statements that have drifted apart is not a
 * cosmetic inconsistency: one of them is then wrong, and it would be whichever was edited
 * second.
 *
 * **The rail beside each credit is the plate that source draws.** Woodland for the trails,
 * contour for the ground under them, water for the weather over them, ink for the lettering —
 * the product's own colour separation, used here for the one thing it is literally about. It
 * answers the question somebody opens this screen with, which is not "who is credited" but
 * "which part of what I am looking at came from where". Nothing else on the screen is
 * coloured.
 *
 * `sheet` rather than the app's `field`: this is the one screen in the product that is all
 * prose, and prose is what a map-dark instrument scheme is worst at.
 */

const theme = nativeTheme('sheet');

/**
 * Which plate each source is responsible for.
 *
 * A rendering decision, so it lives here rather than beside the credits in `core` — the
 * website sets the same list as a definition list and has no rail to tint. Satellite takes
 * bezel deliberately: a photograph is not a plate, and giving it a colour it does not draw
 * would be the decorative version of this idea rather than the true one.
 */
const PLATE: Readonly<Record<AttributionKey, string>> = {
  osm: theme.color.woodland,
  terrain: theme.color.contour,
  esriImagery: theme.color.bezel,
  openFreeMap: theme.color.ink,
  protomaps: theme.color.ink,
  openMeteo: theme.color.water,
};

/**
 * Open a credit, without letting a tap on one take the app down.
 *
 * Licence links go to the in-app browser, which keeps somebody reading a credits page inside
 * the app they were reading it in. `mailto:` cannot: `openBrowserAsync` has no mail client to
 * hand off to, so that one goes out through `Linking`. Both rejections are swallowed — a
 * device with no mail app configured is a common, unremarkable state, and this screen has
 * already published the address as text either way.
 */
function open(href: string): void {
  const task: Promise<unknown> = href.startsWith('mailto:')
    ? Linking.openURL(href)
    : WebBrowser.openBrowserAsync(href);
  void task.catch(() => undefined);
}

export default function AttributionScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      {/* Overrides the root's dark canvas, or the push transition flashes field over sheet. */}
      <Stack.Screen options={{ contentStyle: { backgroundColor: theme.color.canvas } }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + theme.space.md,
            paddingBottom: insets.bottom + theme.space['4xl'],
          },
        ]}
      >
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={theme.space.md}
          style={styles.back}
        >
          <Text style={styles.backLabel}>← Back</Text>
        </Pressable>

        <View style={styles.head}>
          <Text style={styles.collar}>Sources</Text>
          <Text style={styles.title}>Everything on the map came from somewhere.</Text>
          <Text style={styles.lede}>
            {BRAND.name} holds no proprietary trail data. The routes, the ground under them and the
            weather over them are open data, used under the licences below.
          </Text>
        </View>

        <View style={styles.sources}>
          {ATTRIBUTION_SOURCES.map((source) => (
            <Source key={source.key} source={source} />
          ))}
        </View>

        <View style={styles.corrections}>
          <Text style={styles.collar}>Corrections</Text>
          <Text style={styles.prose}>{ATTRIBUTION_CORRECTIONS.upstream}</Text>
          <Pressable
            onPress={() => open(ATTRIBUTION_CORRECTIONS.osmHref)}
            accessibilityRole="link"
            style={({ pressed }) => [styles.action, pressed ? styles.actionDim : null]}
          >
            <Text style={styles.actionLabel}>Fix it on OpenStreetMap</Text>
          </Pressable>
          <Pressable
            onPress={() => open(`mailto:${BRAND.supportEmail}`)}
            accessibilityRole="link"
            accessibilityLabel={`Email ${BRAND.supportEmail}`}
            hitSlop={theme.space.sm}
            style={styles.quiet}
          >
            <Text style={styles.quietLabel}>Anything else: {BRAND.supportEmail}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </>
  );
}

/**
 * One source: what it draws, who to credit, how it is used, and under what.
 *
 * The credit itself is the tap target and carries the arrow, because it is the only part of
 * the block that goes anywhere. The licence sits underneath in mono rather than beside the
 * heading — two of the six are a full line long ("CC BY 4.0 / public domain (varies by source
 * tile)"), and a reading that has to be truncated to fit a heading line is a licence stated
 * incompletely.
 */
function Source({ source }: { source: (typeof ATTRIBUTION_SOURCES)[number] }) {
  const credit = ATTRIBUTION[source.key];

  return (
    <View style={styles.source}>
      <View style={[styles.rail, { backgroundColor: PLATE[source.key] }]} />
      <View style={styles.sourceBody}>
        <Text style={styles.collar}>{source.what}</Text>
        <Pressable
          onPress={() => open(credit.href)}
          accessibilityRole="link"
          accessibilityLabel={`${credit.label} — opens the licence`}
          style={({ pressed }) => [styles.credit, pressed ? styles.creditPressed : null]}
        >
          <Text style={styles.creditLabel}>{credit.label}</Text>
          <Text style={styles.creditArrow}>↗</Text>
        </Pressable>
        <Text style={styles.detail}>{source.detail}</Text>
        <Text style={styles.licence}>{credit.licence}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: { paddingHorizontal: theme.space.xl, gap: theme.space.lg },

  back: { alignSelf: 'flex-start', paddingVertical: theme.space.xs },
  backLabel: { ...theme.collarLabel, color: theme.color.inkMuted },

  head: { gap: theme.space.md },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  title: { ...theme.text('h4', { weight: 'bold' }), color: theme.color.ink },
  lede: { ...theme.text('bodyLg', { family: 'text' }), color: theme.color.inkMuted },

  // ── The credits ──
  sources: { marginTop: theme.space.lg },
  source: {
    flexDirection: 'row',
    gap: theme.space.md,
    paddingVertical: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  // Full height of its block, the same device the conditions table and the sign-out warning
  // use. Two points: a rule, not a swatch.
  rail: { width: 2, borderRadius: theme.radius.hair },
  sourceBody: { flex: 1, gap: theme.space.xs },

  credit: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.sm,
    minHeight: CONTROL_HEIGHT.touch,
    paddingRight: theme.space.sm,
  },
  creditPressed: { opacity: 0.55 },
  creditLabel: {
    ...theme.text('body', { weight: 'medium' }),
    color: theme.color.ink,
    flexShrink: 1,
  },
  creditArrow: { ...theme.text('caption'), color: theme.color.inkMuted },

  detail: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  licence: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  // ── Corrections ──
  corrections: {
    gap: theme.space.md,
    marginTop: theme.space.lg,
    paddingTop: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
  },
  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },

  action: {
    alignSelf: 'flex-start',
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
  },
  actionDim: { opacity: 0.55 },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },

  quiet: { minHeight: CONTROL_HEIGHT.touch, justifyContent: 'center', alignSelf: 'flex-start' },
  quietLabel: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
});
