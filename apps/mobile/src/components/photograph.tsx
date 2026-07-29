import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ImageStyle, StyleProp, ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { nativeTheme } from '@switchback/ui';

/**
 * A photograph, and what stands in its place when there isn't one.
 *
 * **A photograph we never had and a photograph that failed to arrive are the same thing to a
 * reader**, so this treats them as one state — the same component and the same reasoning as
 * the website's `photograph.tsx`, which is not a coincidence: both clients draw from the same
 * rows and inherit the same problem from them.
 *
 * Almost none of these URLs are ours and none are permanent. Commons files are deleted while
 * our cache still holds the link for up to thirty days, Mapillary serves from a CDN that
 * rotates, an R2 object can outlive or predecease its row when an upload is interrupted, and
 * an avatar belongs to whichever identity provider signed the hiker in.
 *
 * A failed `<Image>` on iOS is quieter than a browser's torn-page glyph — it draws nothing at
 * all — but quieter is not better here. It leaves a hole the exact size and shape of a
 * photograph, indistinguishable from one still loading on trailhead signal, so the reader
 * waits for something that is never coming. The plate below says the wait is over.
 */

const theme = nativeTheme('field');

interface PhotographProps {
  /** `null` when there is no photograph — the fallback renders, same as a failed load. */
  uri: string | null | undefined;
  style?: StyleProp<ImageStyle>;
  resizeMode?: 'cover' | 'contain';
  accessibilityLabel?: string;
  /**
   * What the slot holds instead. Nothing by default, which is right where the photograph is
   * an ornament to something else; where it *is* the content, pass a real one.
   */
  fallback?: ReactNode;
}

export function Photograph({
  uri,
  style,
  resizeMode = 'cover',
  accessibilityLabel,
  fallback = null,
}: PhotographProps) {
  /*
   * Which URI failed, rather than whether one did. The viewer steps through a set of
   * photographs on a single element and a boolean would strand every later frame behind one
   * dead file. Storing the URI means the state answers for that URI alone and clears itself
   * when a different one arrives — no effect, no reset, no `key` to remember.
   */
  const [failedUri, setFailedUri] = useState<string | null>(null);

  if (!uri || failedUri === uri) return <>{fallback}</>;

  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      accessibilityLabel={accessibilityLabel}
      accessibilityIgnoresInvertColors
      onError={() => setFailedUri(uri)}
    />
  );
}

/**
 * The slot a photograph was going to fill, still holding its place.
 *
 * For strips and rows, where the picture is an ornament to something else and the something
 * else is still there. Rendering nothing would pull the credit and the licence up under a
 * void and close the gap the eye uses to tell one frame from the next, so the plate keeps the
 * measure. Dashed rather than solid: a ruled space on the sheet, which is what this is.
 */
export function PhotographMissing({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={[plate.plate, style]} />
  );
}

/**
 * A photograph that failed where the photograph was the point.
 *
 * Only for the full-screen viewer. Somebody opened it to look at one specific picture, and a
 * silent plate there is a dead end with no explanation. This says which of the two things went
 * wrong — the file, not their signal — without claiming more certainty than we have, and
 * without apologising for a Commons deletion we do not control.
 */
export function PhotographUnavailable() {
  return (
    <View style={plate.panel}>
      <Text style={plate.panelCollar}>No photograph</Text>
      <Text style={plate.panelBody}>
        This one didn’t load. It may have been removed where it was published.
      </Text>
    </View>
  );
}

const plate = StyleSheet.create({
  plate: {
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    backgroundColor: theme.color.surface,
  },
  panel: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space['4xl'],
  },
  panelCollar: { ...theme.collarLabel, color: theme.color.inkMuted },
  panelBody: {
    ...theme.text('body', { family: 'text' }),
    color: theme.color.inkMuted,
    textAlign: 'center',
    maxWidth: 320,
  },
});
