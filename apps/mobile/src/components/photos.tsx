import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// The enum, not the `File` class — `put` below names the transfer mode, and multipart is the
// one mode where the native side overwrites the `content-type` our signature covers.
import { UploadType } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as WebBrowser from 'expo-web-browser';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { RouterOutputs } from '@switchback/api';
import type { UnitSystem, UploadTicket } from '@switchback/core';
import {
  MAX_CAPTION_LENGTH,
  MAX_PHOTOS_PER_TRAIL_PER_USER,
  blurhashAverageColor,
  formatBytes,
  formatDistance,
  licenceUri,
} from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { GALLERY_LIMIT } from '@/api/pages';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { apiBaseUrl } from '@/config';
import { Photograph, PhotographMissing, PhotographUnavailable } from '@/components/photograph';
import { ReportSheet } from '@/components/report-control';
import { discard, preparePhoto } from '@/photos/prepare';
import type { PreparedPhoto } from '@/photos/prepare';

/**
 * The photographs on a trail, and the way to add one — a contact strip, as on the website,
 * because the set is heterogeneous and a grid makes a thin one look like a gap.
 *
 * Each frame states where along the trail it was taken, from the file's own EXIF, kept only
 * when it falls near this trail. The credit is not garnish: Commons and Mapillary frames
 * arrive under CC variants that require attribution by name, so it prints on every frame.
 *
 * The viewer is `field` while the rest of the screen is `sheet` — the only place in the app
 * where the scheme flips mid-screen, because a photograph is not a document.
 */

const theme = nativeTheme('sheet');
const dark = nativeTheme('field');

type TrailPhoto = RouterOutputs['trails']['photos'][number];

const THUMB_WIDTH = 220;
const THUMB_HEIGHT = 144;

type Stage = 'preparing' | 'sending' | 'saving' | 'failed';

/** What each stage says while it is happening. Verbs, because something is happening. */
const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  preparing: 'Resizing',
  sending: 'Sending',
  saving: 'Filing',
  failed: 'Failed',
};

interface QueueItem {
  id: string;
  previewUri: string | null;
  stage: Stage;
  error: string | null;
}

export interface PhotosProps {
  trailId: string;
  trailName: string;
  units?: UnitSystem;
}

export function Photos({ trailId, trailName, units = 'metric' }: PhotosProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const key = useMemo(
    () => trpc.trails.photos.queryKey({ trailId, limit: GALLERY_LIMIT }),
    [trpc, trailId],
  );
  const list = useQuery(trpc.trails.photos.queryOptions({ trailId, limit: GALLERY_LIMIT }));

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [picking, setPicking] = useState(false);

  const photos = list.data ?? [];
  const open = openIndex === null ? null : (photos[openIndex] ?? null);

  const presign = useMutation(trpc.photos.presign.mutationOptions());
  const commit = useMutation(trpc.photos.commit.mutationOptions());

  /**
   * Patch the cached list rather than refetch it: six uploads would be six round trips for a
   * list the client already knows. Prepended, so the new frame appearing confirms the upload.
   */
  const received = useCallback(
    (photo: TrailPhoto): void => {
      queryClient.setQueryData(key, (current: TrailPhoto[] | undefined) => [
        photo,
        ...(current ?? []),
      ]);
    },
    [key, queryClient],
  );

  const dropped = useCallback(
    (photoId: string): void => {
      queryClient.setQueryData(key, (current: TrailPhoto[] | undefined) =>
        (current ?? []).filter((photo) => photo.id !== photoId),
      );
    },
    [key, queryClient],
  );

  const captioned = useCallback(
    (photoId: string, caption: string | null): void => {
      queryClient.setQueryData(key, (current: TrailPhoto[] | undefined) =>
        (current ?? []).map((photo) => (photo.id === photoId ? { ...photo, caption } : photo)),
      );
    },
    [key, queryClient],
  );

  /**
   * Pick, then upload one at a time. Sequential on purpose: six in parallel share the same
   * uplink and finish together, so nothing moves until everything lands at once.
   *
   * A failure is per photograph, never per batch — re-picking six files to retry one is a
   * punishment for the wrong mistake.
   */
  const add = useCallback(async (): Promise<void> => {
    setPicking(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setQueue((current) => [
          ...current,
          {
            id: `denied-${String(current.length)}`,
            previewUri: null,
            stage: 'failed',
            error: 'Photo access is off for Switchback. Turn it on in Settings to add pictures.',
          },
        ]);
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        // Trimmed here as well as enforced at commit, so somebody who picks forty is told now
        // rather than after twelve successes and twenty-eight refusals.
        selectionLimit: MAX_PHOTOS_PER_TRAIL_PER_USER,
        // Unmodified. The manipulator does the downscale, and letting the picker compress
        // first would throw away detail before the resize that actually needs it.
        quality: 1,
        exif: true,
      });
      if (picked.canceled) return;

      const queued: QueueItem[] = picked.assets.map((asset, index) => ({
        id: `${asset.assetId ?? asset.uri}-${String(index)}`,
        previewUri: asset.uri,
        stage: 'preparing',
        error: null,
      }));
      setQueue((current) => [...current, ...queued]);

      for (const [index, asset] of picked.assets.entries()) {
        const item = queued[index];
        if (!item) continue;
        let prepared: PreparedPhoto | null = null;
        try {
          prepared = await preparePhoto(asset);
          const bytes = prepared.full.size ?? 0;
          setQueue((current) =>
            current.map((row) =>
              row.id === item.id
                ? { ...row, stage: 'sending', previewUri: prepared?.previewUri ?? row.previewUri }
                : row,
            ),
          );

          const grant = await presign.mutateAsync({
            contentType: prepared.contentType,
            bytes,
            trailId,
          });

          await put(grant.full, prepared.full);
          if (prepared.thumb) {
            // Best effort. A missing thumbnail costs a larger image in the strip; a failed
            // upload over one costs the photograph.
            await put(grant.thumb, prepared.thumb).catch(() => undefined);
          }

          setQueue((current) =>
            current.map((row) => (row.id === item.id ? { ...row, stage: 'saving' } : row)),
          );

          const photo = await commit.mutateAsync({
            token: grant.token,
            trailId,
            width: prepared.width,
            height: prepared.height,
            blurhash: prepared.blurhash,
            caption: null,
            lng: prepared.lng,
            lat: prepared.lat,
            capturedAt: prepared.capturedAt,
          });

          received(photo);
          setQueue((current) => current.filter((row) => row.id !== item.id));
        } catch (error) {
          setQueue((current) =>
            current.map((row) =>
              row.id === item.id ? { ...row, stage: 'failed', error: messageOf(error) } : row,
            ),
          );
        } finally {
          // The renditions are on disk either way; keeping them past the attempt is a few
          // hundred megabytes of duplicates in the way of an offline map by the season's end.
          if (prepared) discard(prepared);
        }
      }
    } finally {
      setPicking(false);
    }
  }, [commit, presign, received, trailId]);

  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Text style={styles.collar}>Photographs</Text>
        {photos.length > 0 ? (
          <Text style={styles.count}>
            {`${photos.length} ${photos.length === 1 ? 'frame' : 'frames'}`}
          </Text>
        ) : null}
      </View>

      {list.isPending ? (
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      ) : list.isError ? (
        <Text style={styles.absent}>
          The photographs could not be loaded. Everything else on this screen is unaffected.
        </Text>
      ) : photos.length === 0 ? (
        <Text style={styles.empty}>
          No photographs of this one yet. What it actually looks like — the ground, the crossing,
          the view from the top — is the thing a map cannot say.
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}
          // Snapped to the frame pitch, so a flick lands a picture squarely rather than
          // halfway off the edge. The gap is part of the pitch or the drift accumulates.
          snapToInterval={THUMB_WIDTH + theme.space.md}
          decelerationRate="fast"
        >
          {photos.map((photo, index) => (
            <Frame
              key={photo.id}
              photo={photo}
              trailName={trailName}
              units={units}
              onPress={() => setOpenIndex(index)}
            />
          ))}
        </ScrollView>
      )}

      {signedIn ? (
        <Pressable
          onPress={() => void add()}
          disabled={picking}
          accessibilityRole="button"
          accessibilityState={{ disabled: picking }}
          style={({ pressed }) => [styles.add, pressed ? styles.addPressed : null]}
        >
          <Text style={styles.addLabel}>{picking ? 'Choosing…' : 'Add photographs'}</Text>
          <Text style={styles.addHint}>
            They are resized on this phone before they are sent, and the camera data — including
            where the picture was taken — is stripped unless the spot falls on this trail.
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.note}>Sign in on the Profile tab to add your own.</Text>
      )}

      {queue.length > 0 ? (
        <View style={styles.queue}>
          {queue.map((item) => (
            <View key={item.id} style={styles.queueRow}>
              {/*
               * A plain `Image`, deliberately. `previewUri` is a file the picker copied into
               * this app's own cache a moment ago and nothing on the network can take it
               * away; a row whose upload fails already carries `item.error` and a Dismiss.
               */}
              {item.previewUri ? (
                <Image source={{ uri: item.previewUri }} style={styles.queueThumb} />
              ) : (
                <View style={[styles.queueThumb, styles.queueThumbEmpty]} />
              )}
              {item.stage === 'failed' ? (
                <>
                  <Text style={styles.queueError}>{item.error}</Text>
                  <Pressable
                    onPress={() => setQueue((current) => current.filter((r) => r.id !== item.id))}
                    accessibilityRole="button"
                    hitSlop={theme.space.md}
                  >
                    <Text style={styles.queueDismiss}>Dismiss</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.queueStage}>{STAGE_LABEL[item.stage]}</Text>
                  <ActivityIndicator color={theme.color.inkMuted} />
                </>
              )}
            </View>
          ))}
        </View>
      ) : null}

      <Viewer
        photo={open}
        trailName={trailName}
        units={units}
        position={openIndex === null ? null : { index: openIndex, total: photos.length }}
        onClose={() => setOpenIndex(null)}
        onStep={(delta) =>
          setOpenIndex((current) =>
            current === null || photos.length === 0
              ? current
              : (current + delta + photos.length) % photos.length,
          )
        }
        onCaptioned={captioned}
        onRemoved={(photoId) => {
          dropped(photoId);
          setOpenIndex(null);
        }}
      />
    </View>
  );
}

/** One frame in the strip, with its credit and where along the trail it was taken. */
function Frame({
  photo,
  trailName,
  units,
  onPress,
}: {
  photo: TrailPhoto;
  trailName: string;
  units: UnitSystem;
  onPress: () => void;
}) {
  const wash = blurhashAverageColor(photo.blurhash);

  return (
    <View style={styles.frame}>
      <Pressable
        onPress={onPress}
        accessibilityRole="imagebutton"
        accessibilityLabel={photo.caption ?? `${trailName}, photographed by ${creditOf(photo)}`}
        style={({ pressed }) => [styles.shot, pressed ? styles.shotPressed : null]}
      >
        {/*
         * The average colour of the photograph, painted under it from four bytes of BlurHash.
         * On a trailhead's worth of signal a frame arrives as a plausible green or grey
         * rather than a white hole, and the strip stops flashing as it loads. Seeded
         * photographs carry a hash; ones uploaded from a phone do not — see `prepare.ts`.
         */}
        <Photograph
          uri={photo.thumbUrl ?? photo.url}
          style={[styles.shotImage, wash === null ? null : { backgroundColor: wash }]}
          resizeMode="cover"
          fallback={
            /*
             * When it never arrives — a deleted Commons file, an R2 object that outlived its
             * row — the plate holds the frame's measure so the credit beneath stays put.
             */
            <PhotographMissing style={styles.shotImage} />
          }
        />
      </Pressable>
      <View style={styles.creditRow}>
        <Text style={styles.credit} numberOfLines={1}>
          {photo.sourceUrl ? (
            <Text style={styles.creditLink} onPress={() => openCredit(photo.sourceUrl)}>
              {creditOf(photo)}
            </Text>
          ) : (
            creditOf(photo)
          )}
          {photo.license ? ' · ' : ''}
          {photo.license ? (
            <Text style={styles.creditLink} onPress={() => openCredit(licenceUri(photo.license))}>
              {photo.license}
            </Text>
          ) : null}
        </Text>
        {photo.distM === null ? null : (
          <Text style={styles.creditDist}>{`${formatDistance(photo.distM, units)} in`}</Text>
        )}
      </View>
    </View>
  );
}

/**
 * One photograph, full bleed, on the dark scheme. The caption field appears only on your own
 * frames — captioning somebody else's photograph is a caption on their work.
 */
function Viewer({
  photo,
  trailName,
  units,
  position,
  onClose,
  onStep,
  onCaptioned,
  onRemoved,
}: {
  photo: TrailPhoto | null;
  trailName: string;
  units: UnitSystem;
  position: { index: number; total: number } | null;
  onClose: () => void;
  onStep: (delta: number) => void;
  onCaptioned: (photoId: string, caption: string | null) => void;
  onRemoved: (photoId: string) => void;
}) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  const saveCaption = useMutation(
    trpc.photos.caption.mutationOptions({
      onSuccess: (_result, variables) => {
        onCaptioned(variables.photoId, variables.caption);
        setDraft(null);
      },
    }),
  );

  const remove = useMutation(
    trpc.photos.remove.mutationOptions({
      onSuccess: (_result, variables) => onRemoved(variables.photoId),
    }),
  );

  const caption = draft ?? photo?.caption ?? '';
  const month = monthOf(photo?.capturedAt ?? null);
  const dirty = photo !== null && caption.trim() !== (photo.caption ?? '');

  return (
    <Modal
      visible={photo !== null}
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
      // Landscape too: a photograph is the one thing in this app worth turning the phone for.
      supportedOrientations={['portrait', 'landscape']}
      statusBarTranslucent
    >
      {photo === null ? null : (
        <View style={styles.viewer}>
          <ScrollView contentContainerStyle={styles.viewerScroll}>
            <Photograph
              uri={photo.url}
              accessibilityLabel={
                photo.caption ?? `${trailName}, photographed by ${creditOf(photo)}`
              }
              style={[
                styles.viewerImage,
                {
                  aspectRatio: aspectOf(photo),
                  backgroundColor: blurhashAverageColor(photo.blurhash) ?? dark.color.surface,
                },
              ]}
              resizeMode="contain"
              fallback={<PhotographUnavailable />}
            />

            <View style={styles.viewerBody}>
              {photo.isMine ? (
                <View style={styles.captionRow}>
                  <TextInput
                    value={caption}
                    onChangeText={setDraft}
                    maxLength={MAX_CAPTION_LENGTH}
                    placeholder="What is this — the crossing, the cairn, the turn people miss?"
                    placeholderTextColor={dark.color.inkMuted}
                    style={styles.captionField}
                    multiline
                  />
                  <Pressable
                    onPress={() =>
                      saveCaption.mutate({
                        photoId: photo.id,
                        caption: caption.trim() || null,
                      })
                    }
                    disabled={saveCaption.isPending || !dirty}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: saveCaption.isPending || !dirty }}
                    style={[styles.darkButton, dirty ? null : styles.darkButtonOff]}
                  >
                    <Text style={styles.darkButtonLabel}>
                      {saveCaption.isPending ? 'Saving…' : 'Save caption'}
                    </Text>
                  </Pressable>
                </View>
              ) : photo.caption ? (
                <Text style={styles.viewerCaption}>{photo.caption}</Text>
              ) : null}

              <Text style={styles.viewerCredit}>
                {[
                  creditOf(photo),
                  photo.license,
                  month,
                  photo.distM === null
                    ? null
                    : `${formatDistance(photo.distM, units)} along the trail`,
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(' · ')}
              </Text>

              {photo.isMine ? (
                <Pressable
                  onPress={() => remove.mutate({ photoId: photo.id })}
                  disabled={remove.isPending}
                  accessibilityRole="button"
                  style={[styles.darkButton, styles.removeButton]}
                >
                  <Text style={[styles.darkButtonLabel, styles.removeLabel]}>
                    {remove.isPending ? 'Removing…' : 'Remove this photograph'}
                  </Text>
                </Pressable>
              ) : (
                /*
                 * Somebody else's frame, and the one place it is big enough to judge.
                 * Reporting is public, so this works signed out — the person who finds their
                 * own house in a photograph has no account.
                 */
                <Pressable
                  onPress={() => setReporting(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`Report this photograph by ${creditOf(photo)}`}
                  style={styles.darkButton}
                >
                  <Text style={styles.darkButtonLabel}>Report</Text>
                </Pressable>
              )}
            </View>
          </ScrollView>

          <ReportSheet
            subject="photo"
            subjectId={photo.id}
            what={`this photograph by ${creditOf(photo)}`}
            visible={reporting}
            onClose={() => setReporting(false)}
          />
          {/*
           * The controls sit over the image rather than under it, because the image is as
           * tall as it is and a bar below the fold is a bar nobody can reach.
           */}
          <View style={styles.viewerBar}>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={theme.space.md}
              style={styles.barButton}
            >
              <Text style={styles.barLabel}>Close</Text>
            </Pressable>

            {position !== null && position.total > 1 ? (
              <View style={styles.stepper}>
                <Pressable
                  onPress={() => onStep(-1)}
                  accessibilityRole="button"
                  accessibilityLabel="Previous photograph"
                  hitSlop={theme.space.md}
                  style={styles.barButton}
                >
                  <Text style={styles.barLabel}>←</Text>
                </Pressable>
                <Text style={styles.position}>
                  {`${String(position.index + 1)}/${String(position.total)}`}
                </Text>
                <Pressable
                  onPress={() => onStep(1)}
                  accessibilityRole="button"
                  accessibilityLabel="Next photograph"
                  hitSlop={theme.space.md}
                  style={styles.barButton}
                >
                  <Text style={styles.barLabel}>→</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      )}
    </Modal>
  );
}

/**
 * Send one rendition. `File.upload` streams from disk through the native networking stack, so
 * the megabytes never enter the JavaScript heap.
 *
 * Two gaps to cover by hand: it resolves for *any* completed response, refusals included, so
 * the status must be read; and it will not resolve a relative URL, which is what the local
 * development driver returns when there is no bucket to sign against.
 */
async function put(ticket: UploadTicket, file: PreparedPhoto['full']): Promise<void> {
  const bytes = file.size;
  if (bytes !== null && bytes > ticket.maxBytes) {
    throw new Error(
      `That came to ${formatBytes(bytes)}, over the ${formatBytes(ticket.maxBytes)} limit.`,
    );
  }

  const result = await file.upload(new URL(ticket.url, apiBaseUrl()).toString(), {
    httpMethod: 'PUT',
    // Binary, not multipart. The signature covers `content-type`, and multipart is the one
    // mode where the native side overwrites that header with its own boundary type.
    uploadType: UploadType.BINARY_CONTENT,
    headers: ticket.headers,
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`The upload was refused (${String(result.status)}).`);
  }
}

/**
 * Width over height, or a square. Both dimensions are nullable — the seeded Commons and
 * Mapillary rows predate the measurement. `resizeMode="contain"` letterboxes inside whatever
 * box is reserved, so a wrong guess costs empty space, never a distorted photograph.
 */
function aspectOf(photo: TrailPhoto): number {
  const { width, height } = photo;
  if (width === null || height === null || width < 1 || height < 1) return 1;
  return width / height;
}

function creditOf(photo: TrailPhoto): string {
  if (photo.author) return photo.author.name ?? photo.author.username ?? 'A hiker';
  if (photo.attribution) return photo.attribution;
  return photo.source.charAt(0).toUpperCase() + photo.source.slice(1);
}

/**
 * Open a credit or a licence deed in the in-app browser. Swallows its own rejection: a credit
 * that will not open must not take the gallery down with it.
 */
function openCredit(href: string | null | undefined): void {
  if (!href) return;
  void WebBrowser.openBrowserAsync(href).catch(() => {});
}

/** `September 2024` — the month is as precise as a photograph's date needs to be. */
function monthOf(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'That did not upload.';
}

const styles = StyleSheet.create({
  block: { gap: theme.space.md },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  count: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  pending: { alignSelf: 'flex-start' },

  absent: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.inkMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderStyle: 'dashed',
    borderRadius: theme.radius.hair,
    padding: theme.space.lg,
  },
  // No box — see `reviews`. An empty section is a fact, not a failure.
  empty: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },

  strip: { gap: theme.space.md, paddingRight: theme.space.xl },
  frame: { width: THUMB_WIDTH, gap: theme.space.xs },
  shot: { borderRadius: theme.radius.hair, overflow: 'hidden' },
  shotPressed: { opacity: 0.7 },
  shotImage: {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
  },
  creditRow: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.sm },
  credit: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted, flex: 1 },
  // Underlined because a credit is a licence obligation and has to read as reachable, not as
  // decoration — CC BY-SA 4.0 §3.a.1 wants the material and its licence linked, not just named.
  creditLink: { textDecorationLine: 'underline' },
  // Contour, the plate that means distance everywhere else on this screen.
  creditDist: { ...theme.text('micro', { family: 'mono' }), color: theme.color.contour },

  add: {
    gap: theme.space.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderStyle: 'dashed',
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.lg,
  },
  addPressed: { borderColor: theme.color.ink },
  addLabel: { ...theme.collarLabel, color: theme.color.ink },
  addHint: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },
  note: { ...theme.text('caption', { family: 'text' }), color: theme.color.inkMuted },

  queue: { gap: theme.space.hair },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xs,
  },
  queueThumb: {
    width: 34,
    height: 34,
    borderRadius: theme.radius.hair,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
  },
  queueThumbEmpty: { borderStyle: 'dashed' },
  queueStage: { ...theme.collarLabel, color: theme.color.inkMuted, flex: 1 },
  queueError: {
    ...theme.text('caption', { family: 'text' }),
    color: theme.color.survey,
    flex: 1,
  },
  queueDismiss: { ...theme.collarLabel, color: theme.color.inkMuted },

  viewer: { flex: 1, backgroundColor: dark.color.canvas },
  viewerScroll: { paddingBottom: 96 },
  viewerImage: { width: '100%' },
  viewerBody: { gap: theme.space.md, padding: theme.space.xl },
  viewerCaption: { ...dark.text('body', { family: 'text' }), color: dark.color.ink },
  viewerCredit: { ...dark.text('micro', { family: 'mono' }), color: dark.color.inkMuted },

  captionRow: { gap: theme.space.sm },
  captionField: {
    ...dark.text('caption', { family: 'text' }),
    color: dark.color.ink,
    backgroundColor: dark.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: dark.color.bezel,
    borderRadius: dark.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    minHeight: 64,
  },

  darkButton: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: dark.color.ink,
    borderRadius: dark.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  darkButtonOff: { borderColor: dark.color.bezel, opacity: 0.4 },
  darkButtonLabel: { ...dark.collarLabel, color: dark.color.ink },
  removeButton: { borderColor: dark.color.survey },
  removeLabel: { color: dark.color.survey },

  viewerBar: {
    position: 'absolute',
    left: theme.space.xl,
    right: theme.space.xl,
    bottom: theme.space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.md,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  barButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: dark.color.bezel,
    borderRadius: dark.radius.hair,
    backgroundColor: dark.color.surface,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  barLabel: { ...dark.collarLabel, color: dark.color.ink },
  position: { ...dark.text('micro', { family: 'mono' }), color: dark.color.inkMuted },
});
