import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatBytes, plural } from '@switchback/core';
import { CONTROL_HEIGHT, nativeTheme } from '@switchback/ui';
import { useTRPCClient } from '@/api/trpc';
import { OFFLINE_PHOTO_LIMIT, startDownload, stopDownload, useDownload } from '@/offline/download';
import { forgetTrail, useOfflineSaved } from '@/offline/store';

/**
 * Take this trail with you.
 *
 * It sits directly under the recorder's start control because the two belong to the same
 * moment: somebody standing at a car park with one bar deciding what they need before they
 * lose it. Above it is "start hiking"; this is "and make sure the page still opens".
 *
 * **The note is the point of the component.** A download that quietly excludes the map
 * would be a feature that fails exactly once, on a col, for somebody who believed it had
 * worked — so the list of what is and is not saved is not fine print here, it is the body
 * copy, and it names the map first. The reason is real and worth stating: the map on this
 * phone is a web view drawing MapLibre, and under Expo Go there is nothing between that web
 * view and its tile requests for us to answer from storage.
 */

const theme = nativeTheme('sheet');

export function DownloadTrail({ slug, stale }: { slug: string; stale: boolean }) {
  const client = useTRPCClient();
  const saved = useOfflineSaved(slug);
  const { progress, error } = useDownload(slug);
  const [confirming, setConfirming] = useState(false);

  if (progress) {
    const frames = progress.phase === 'photos' && progress.total > 0;
    return (
      <View style={styles.panel}>
        <Text style={styles.collar}>On this phone</Text>
        <Text style={styles.prose}>
          {progress.phase === 'data' ? 'Fetching the trail…' : null}
          {progress.phase === 'photos'
            ? frames
              ? `Photos — ${progress.done} of ${progress.total}`
              : 'Fetching the photos…'
            : null}
          {progress.phase === 'saving' ? 'Writing it to the phone…' : null}
        </Text>
        <Pressable
          onPress={() => stopDownload(slug)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.ghost, pressed ? styles.ghostPressed : null]}
        >
          <Text style={styles.ghostLabel}>Stop</Text>
        </Pressable>
      </View>
    );
  }

  if (saved) {
    return (
      <View style={styles.panel}>
        <View style={styles.head}>
          <Text style={styles.collar}>On this phone</Text>
          <Text style={styles.meta}>
            {formatBytes(saved.bytes)} · {stamp(saved.savedAt)}
          </Text>
        </View>

        <Text style={styles.prose}>
          {stale
            ? 'You are reading the copy saved on this phone. It will refresh when there is a signal.'
            : `Saved with ${saved.photos} ${plural(saved.photos, 'photo')}. It opens without a signal.`}
        </Text>

        <Included />

        <View style={styles.row}>
          <Pressable
            onPress={() => startDownload(client, slug)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
          >
            <Text style={styles.chipLabel}>Update</Text>
          </Pressable>
          {confirming ? null : (
            <Pressable
              onPress={() => setConfirming(true)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
            >
              <Text style={styles.chipLabel}>Remove</Text>
            </Pressable>
          )}
        </View>

        {/*
         * Survey, and a confirmation, because this is the one control here that destroys
         * something — and the thing it destroys is most valuable to somebody who is about to
         * be out of range, which is also when a mis-tap is hardest to undo.
         */}
        {confirming ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmProse}>
              {formatBytes(saved.bytes)} comes off the phone. This trail then needs a signal.
            </Text>
            <View style={styles.row}>
              <Pressable
                onPress={() => {
                  setConfirming(false);
                  forgetTrail(saved.trailId);
                }}
                accessibilityRole="button"
                style={({ pressed }) => [styles.destructive, pressed ? styles.chipPressed : null]}
              >
                <Text style={styles.destructiveLabel}>Remove it</Text>
              </Pressable>
              <Pressable
                onPress={() => setConfirming(false)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
              >
                <Text style={styles.chipLabel}>Keep it</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.problem}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.collar}>On this phone</Text>
      <Text style={styles.prose}>Save this trail so it opens where there is no signal.</Text>
      <Pressable
        onPress={() => startDownload(client, slug)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.ghost, pressed ? styles.ghostPressed : null]}
      >
        <Text style={styles.ghostLabel}>Save for offline</Text>
      </Pressable>
      <Included />
      {error ? <Text style={styles.problem}>{error}</Text> : null}
    </View>
  );
}

/**
 * What a download holds and what it does not.
 *
 * Written as two sentences rather than two lists, so that the second one cannot be read as
 * a footnote to the first. The exclusions are the half somebody needs before they set off.
 */
function Included() {
  return (
    <View style={styles.ledger}>
      <Text style={styles.note}>
        Saved: the line, the elevation pass, the waypoints, the description, the access facts, the
        reports, and up to {OFFLINE_PHOTO_LIMIT} photos.
      </Text>
      <Text style={styles.note}>
        Not saved: the map itself, which is drawn by a web view that cannot be handed tiles from
        storage — it needs a connection. Weather and busy times are forecasts and are asked for
        fresh every time.
      </Text>
    </View>
  );
}

/** "24 Jul". Enough to know whether a copy is from before the last storm. */
function stamp(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
    gap: theme.space.md,
  },

  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  meta: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.ink },
  problem: { ...theme.text('caption', { family: 'text' }), color: theme.color.survey },

  // The two halves of the ledger, set tighter to each other than to anything around them.
  ledger: { gap: theme.space.xs },
  note: { ...theme.text('micro', { family: 'text' }), color: theme.color.inkMuted },

  row: { flexDirection: 'row', gap: theme.space.sm },

  ghost: {
    height: CONTROL_HEIGHT.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
  },
  ghostPressed: { backgroundColor: theme.color.canvas },
  ghostLabel: { ...theme.collarLabel, color: theme.color.ink },

  chip: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  chipPressed: { backgroundColor: theme.color.canvas },
  chipLabel: { ...theme.text('caption', { family: 'mono' }), color: theme.color.inkMuted },

  confirm: {
    gap: theme.space.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.survey,
    paddingLeft: theme.space.md,
  },
  confirmProse: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },
  destructive: {
    minHeight: CONTROL_HEIGHT.touch,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
  },
  destructiveLabel: { ...theme.collarLabel, color: theme.color.survey },
});
