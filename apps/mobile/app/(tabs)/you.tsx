import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ListSummary, UnitSystem, HikeRecord, HikeRegion } from '@switchback/core';
import {
  REMOVED_NOTICE_OWN,
  formatBytes,
  formatDateLabel,
  formatDistance,
  formatElevation,
  formatTimeOnFoot,
  plural,
} from '@switchback/core';
import { nativeTheme } from '@switchback/ui';
import { useTRPC } from '@/api/trpc';
import { useAuth } from '@/auth/context';
import { Cadence } from '@/components/cadence';
import { Photograph } from '@/components/photograph';
import { useOfflineIndex } from '@/offline/store';

/**
 * You. Drawn in `sheet` like the trail screen, because this is a page to be read.
 *
 * Deliberately first-person only: the website has `/u/<username>` for somebody else's record,
 * and this needs no username and works before one has been chosen. Nothing here is ranked
 * against anyone else — a total scored against other people rewards logging hikes you did not do.
 */

const theme = nativeTheme('sheet');

export default function YouScreen() {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const { status, signOut } = useAuth();

  const signedIn = status === 'signedIn';

  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: signedIn });
  const stats = useQuery({ ...trpc.me.stats.queryOptions(), enabled: signedIn });
  const lists = useQuery({ ...trpc.lists.mine.queryOptions(), enabled: signedIn });
  /*
   * The same query the routes screen runs, shared through one React Query cache entry: the row
   * can say how many there are, and the screen behind it opens on data already in hand.
   */
  const routes = useQuery({ ...trpc.routes.mine.queryOptions(), enabled: signedIn });

  /*
   * Your own photographs, asked for here only so a takedown has somewhere to appear.
   * `photos.mine` is the one query that returns a hidden photograph; without this call a
   * removed frame would leave the gallery and the contributed count with no notice anywhere.
   */
  const photos = useQuery({ ...trpc.photos.mine.queryOptions({}), enabled: signedIn });

  // Downloads belong to the phone, not to the account — they are readable, and removable,
  // whether or not anybody is signed in. Hence a store read rather than a query.
  const offline = useOfflineIndex();

  if (status === 'loading') {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (status === 'signedOut') {
    return (
      <Chrome insets={insets}>
        <Text style={styles.name}>Not signed in</Text>
        <Text style={styles.prose}>
          Sign in and every hike you tick off is counted here — how far, how much climbing, and the
          months you were actually out.
        </Text>
        <Pressable
          onPress={() => router.push('/signin')}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionLabel}>Sign in</Text>
        </Pressable>
        {/*
         * Downloads are files on this phone, not rows in an account, so the way to them
         * outlives being signed out. Without this, saving a trail and then signing out would
         * strand the bytes behind a screen with no route to it.
         */}
        {offline.trails.length > 0 ? (
          <Pressable
            onPress={() => router.push('/downloads')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
          >
            <Text style={styles.actionLabel}>
              {offline.trails.length} {plural(offline.trails.length, 'trail')} saved on this phone →
            </Text>
          </Pressable>
        ) : null}
      </Chrome>
    );
  }

  if (me.isPending || stats.isPending) {
    return (
      <Chrome insets={insets}>
        <ActivityIndicator color={theme.color.inkMuted} style={styles.pending} />
      </Chrome>
    );
  }

  if (me.isError || stats.isError || !me.data) {
    return (
      <Chrome insets={insets}>
        <Text style={styles.name}>Could not load your record</Text>
        <Text style={styles.prose}>
          {me.error?.message ?? stats.error?.message ?? 'The server did not answer.'}
        </Text>
        <Pressable
          onPress={() => {
            void me.refetch();
            void stats.refetch();
          }}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionLabel}>Try again</Text>
        </Pressable>
      </Chrome>
    );
  }

  const profile = me.data;
  const record = stats.data;
  // Hidden ones only. `photos.mine` returns everything you uploaded, and the rest of your
  // gallery is not this tab's business — the trail screens already show it.
  const removed = (photos.data ?? []).filter((photo) => photo.hidden);
  const units: UnitSystem = profile.units;
  const name = profile.name ?? (profile.username ? `@${profile.username}` : 'A hiker');
  const since = new Date(profile.createdAt).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <Chrome insets={insets}>
      <View style={styles.head}>
        <Portrait src={profile.image} name={name} />
        <View style={styles.headText}>
          <Text style={styles.collar} numberOfLines={1}>
            {profile.username ? `@${profile.username} · ` : ''}
            Hiking here since {since}
          </Text>
          <Text style={styles.name}>{name}</Text>
        </View>
      </View>

      {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}

      {/*
       * The four totals as instrument readings — figure in mono, label in collar caps beneath
       * it. Two across rather than the website's four, which is the only concession the phone
       * asks for: at four abreast "1,655 km" wraps mid-number.
       */}
      <View style={styles.readings}>
        <Reading
          label="Distance"
          value={formatDistance(record.lengthM, units)}
          note={`${record.hikes} ${plural(record.hikes, 'hike')}`}
        />
        <Reading
          label="Ascent"
          value={`↑${formatElevation(record.gainM, units)}`}
          note={`${record.trails} ${plural(record.trails, 'trail')}`}
        />
        <Reading
          label="Time on foot"
          value={record.estimatedTimeS > 0 ? formatTimeOnFoot(record.estimatedTimeS) : '—'}
          note="estimated"
        />
        <Reading
          label="Latest"
          value={record.lastHike ? formatDateLabel(record.lastHike) : '—'}
          note={record.firstHike ? `first ${formatDateLabel(record.firstHike)}` : 'nothing yet'}
        />
      </View>

      <Block title="Thirteen months">
        <Cadence months={record.months} units={units} />
      </Block>

      {record.longest || record.steepest || record.highest ? (
        <Block title="Records">
          <Record
            label="Furthest"
            record={record.longest}
            format={(m) => formatDistance(m, units)}
          />
          <Record
            label="Most climbed"
            record={record.steepest}
            format={(m) => `↑${formatElevation(m, units)}`}
          />
          <Record
            label="Highest point"
            record={record.highest}
            format={(m) => formatElevation(m, units)}
          />
        </Block>
      ) : null}

      {record.regions.length > 0 ? (
        <Block title="Where">
          <Regions regions={record.regions} units={units} />
        </Block>
      ) : null}

      <Block title="Hikes">
        {record.hikes === 0 ? (
          <Text style={styles.prose}>
            Nothing ticked off yet. Open a trail and mark it done the day you hike it.
          </Text>
        ) : (
          <Text style={styles.prose}>
            {record.hikes} {plural(record.hikes, 'hike')} on the record, on {record.trails}{' '}
            {plural(record.trails, 'trail')}.
          </Text>
        )}
        {/*
         * Ticks and recordings are two different counts and the link says so — the number
         * above is trails marked done, the screen behind it is what the phone recorded.
         */}
        <Pressable
          onPress={() => router.push('/activities')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
        >
          <Text style={styles.actionLabel}>Everything you have recorded →</Text>
        </Pressable>
      </Block>

      {/*
       * Routes sit between what you hiked and what you saved, because that is where they sit
       * in the week: a plan is made after the last hike and before the next one. The count is
       * the whole row's content — "Routes" alone would make the tap the question.
       */}
      <Block title="Routes">
        <Text style={styles.prose}>
          {routes.data === undefined
            ? 'Lines you drew yourself, with their own distance, climbing and time on foot.'
            : routes.data.length === 0
              ? 'Nothing planned. Draw a route on the website, at Plan, and it is on your phone at the car park.'
              : `${routes.data.length} ${plural(routes.data.length, 'route')} planned, ${formatDistance(
                  routes.data.reduce((sum, route) => sum + route.stats.lengthM, 0),
                  units,
                )} of drawn line.`}
        </Text>
        <Pressable
          onPress={() => router.push('/routes')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
        >
          <Text style={styles.actionLabel}>Routes you planned →</Text>
        </Pressable>
      </Block>

      <Block title="On this phone">
        <Text style={styles.prose}>
          {offline.trails.length === 0
            ? 'No trails saved for offline yet. Open one and choose “Save for offline” before you lose the signal.'
            : `${offline.trails.length} ${plural(offline.trails.length, 'trail')} saved, ${formatBytes(offline.bytes)}. They open without a signal.`}
        </Text>
        <Pressable
          onPress={() => router.push('/downloads')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
        >
          <Text style={styles.actionLabel}>Trails saved on this phone →</Text>
        </Pressable>
      </Block>

      {lists.data && lists.data.length > 0 ? (
        <Block title="Lists">
          {lists.data.map((list) => (
            <ListRow key={list.id} list={list} units={units} />
          ))}
        </Block>
      ) : null}

      {/*
       * The settings row prints the one setting somebody came looking for rather than the word
       * "Settings" on its own. Units is the reason this screen gets opened — an American reading
       * kilometres wants to know the switch exists before tapping anything to find out.
       */}
      <Block title="Settings">
        <Text style={styles.prose}>
          {units === 'metric'
            ? 'Distances in kilometres and metres.'
            : 'Distances in miles and feet.'}{' '}
          {profile.username ? `You are @${profile.username}.` : 'You have no public handle yet.'}
        </Text>
        <Pressable
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
        >
          <Text style={styles.actionLabel}>Units, name and who sees your hikes →</Text>
        </Pressable>
      </Block>

      {removed.length > 0 ? (
        /*
         * Only the removed frames, named by trail, and only when there are some — this tab is
         * the record and the settings, not a photo grid. Survey plate: this is the reader's own
         * standing on the site. `toPhoto` strips url, thumbUrl, blurhash and caption
         * server-side, so there is no image to draw here in any case.
         */
        <Block title="Removed">
          {removed.map((photo) => (
            <View key={photo.id} style={styles.removed}>
              <Text style={styles.removedWhere}>{photo.trail?.name ?? 'A trail'}</Text>
              <Text style={styles.removedProse}>{REMOVED_NOTICE_OWN}</Text>
            </View>
          ))}
        </Block>
      ) : null}

      {record.reviews > 0 || record.photos > 0 ? (
        <Text style={styles.contributed}>
          Contributed {record.reviews} {plural(record.reviews, 'report')} and {record.photos}{' '}
          {plural(record.photos, 'photo')}
        </Text>
      ) : null}

      {/*
       * Sign out is set as a plain hairline control rather than in the survey plate. Survey is
       * reserved product-wide for things that destroy data, and signing out destroys nothing —
       * the record above is still there when you come back.
       */}
      <Pressable
        onPress={() => void signOut()}
        accessibilityRole="button"
        accessibilityLabel={`Sign out of ${profile.email ?? 'this account'}`}
        style={styles.action}
      >
        <Text style={styles.actionLabel}>Sign out</Text>
      </Pressable>
      {profile.email ? <Text style={styles.signedInAs}>Signed in as {profile.email}</Text> : null}
    </Chrome>
  );
}

/**
 * The scroll container, shared by every state this screen has. No back control — this is a tab.
 * The bottom pad is a plain measure: the tab bar already clears the home indicator.
 */
function Chrome({
  insets,
  children,
}: {
  insets: { top: number; bottom: number };
  children: React.ReactNode;
}) {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.space.lg }]}
    >
      {children}
    </ScrollView>
  );
}

/**
 * The hiker, or the initial standing in for them. A square with a hairline, not a circle:
 * circular avatars read as a social feed, a square plate reads as a specimen label.
 */
function Portrait({ src, name }: { src: string | null; name: string }) {
  return (
    <Photograph
      uri={src}
      resizeMode="cover"
      style={styles.portrait}
      fallback={
        /*
         * The initial, which is also where a stale avatar lands: these URLs belong to the
         * identity provider and stop resolving when the hiker changes their picture there.
         */
        <View style={styles.portraitEmpty}>
          <Text style={styles.portraitInitial}>
            {name.replace(/^@/u, '').slice(0, 1).toUpperCase()}
          </Text>
        </View>
      }
    />
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <Text style={styles.collar}>{title}</Text>
      <View style={styles.blockBody}>{children}</View>
    </View>
  );
}

/** One headline total: the figure, what it is, and the denominator it needs. */
function Reading({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <View style={styles.reading}>
      <Text
        style={styles.readingValue}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {value}
      </Text>
      <Text style={styles.readingLabel}>{label}</Text>
      <Text style={styles.readingNote}>{note}</Text>
    </View>
  );
}

/**
 * One record, or the reason there isn't one. An absent record still occupies its row, so the
 * three read as a set of three whether or not the ingest produced a summit elevation.
 */
function Record({
  label,
  record,
  format,
}: {
  label: string;
  record: HikeRecord | null;
  format: (metres: number) => string;
}) {
  if (!record) {
    return (
      <View style={styles.record}>
        <Text style={styles.recordLabel}>{label}</Text>
        <Text style={styles.recordEmpty}>—</Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: '/trails/[slug]', params: { slug: record.trailSlug } })
      }
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${format(record.valueM)}, ${record.trailName}`}
      style={({ pressed }) => [styles.record, pressed ? styles.recordPressed : null]}
    >
      <Text style={styles.recordLabel}>{label}</Text>
      <View style={styles.recordBody}>
        <Text style={styles.recordValue}>{format(record.valueM)}</Text>
        <Text style={styles.recordTrail} numberOfLines={2}>
          {record.trailName}
        </Text>
        <Text style={styles.recordDate}>{formatDateLabel(record.completedAt)}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Where somebody hikes, as a ranked set of proportional rules. Distance rather than count: a
 * region with one long traverse is not beaten by a region with two evening laps.
 */
function Regions({ regions, units }: { regions: readonly HikeRegion[]; units: UnitSystem }) {
  const peak = Math.max(...regions.map((region) => region.lengthM), 1);

  return (
    <View style={styles.regions}>
      {regions.map((region) => (
        <View key={region.region ?? '—'} style={styles.region}>
          <View style={styles.regionHead}>
            {/* Not "null", and not dropped: a trail OSM never gave a region to is still a hike. */}
            <Text style={styles.regionName} numberOfLines={1}>
              {region.region ?? 'Unnamed ground'}
            </Text>
            <Text style={styles.regionFigure}>
              {formatDistance(region.lengthM, units)} · {region.hikes}
            </Text>
          </View>
          <View style={styles.regionTrack}>
            <View
              style={[
                styles.regionRule,
                { width: `${Math.max((region.lengthM / peak) * 100, 2)}%` },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function ListRow({ list, units }: { list: ListSummary; units: UnitSystem }) {
  return (
    <View style={styles.listRow}>
      <Text style={styles.listName} numberOfLines={1}>
        {list.name}
      </Text>
      <Text style={styles.listFigure}>
        {list.trailCount} {plural(list.trailCount, 'trail')}
        {list.trailCount > 0 ? ` · ${formatDistance(list.totalLengthM, units)}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.canvas },
  content: {
    paddingHorizontal: theme.space.xl,
    paddingBottom: theme.space['3xl'],
    gap: theme.space.lg,
  },

  pending: { marginTop: theme.space['4xl'] },
  prose: { ...theme.text('body', { family: 'text' }), color: theme.color.inkMuted },
  action: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.ink,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    marginTop: theme.space.sm,
  },
  actionLabel: { ...theme.collarLabel, color: theme.color.ink },
  actionPressed: { backgroundColor: theme.color.surface },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.lg },
  headText: { flex: 1, gap: theme.space.xs },
  portrait: {
    width: 64,
    height: 64,
    borderRadius: theme.radius.hair,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    backgroundColor: theme.color.surface,
  },
  portraitEmpty: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.hair,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.bezel,
    backgroundColor: theme.color.surface,
  },
  portraitInitial: { ...theme.text('h4', { weight: 'medium' }), color: theme.color.inkMuted },

  collar: { ...theme.collarLabel, color: theme.color.inkMuted },
  name: { ...theme.text('h3', { weight: 'bold' }), color: theme.color.ink },
  bio: { ...theme.text('bodyLg', { family: 'text' }), color: theme.color.ink },

  readings: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: theme.space.lg,
    columnGap: theme.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.bezel,
    paddingTop: theme.space.lg,
    marginTop: theme.space.sm,
  },
  // Two across. `flexBasis` under half the row leaves the column gap somewhere to come from.
  reading: { flexBasis: '44%', flexGrow: 1, gap: theme.space.hair },
  readingValue: { ...theme.text('h4', { family: 'mono' }), color: theme.color.ink },
  readingLabel: { ...theme.collarLabel, color: theme.color.inkMuted },
  readingNote: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  block: { gap: theme.space.md, marginTop: theme.space.xl },
  blockBody: { gap: theme.space.sm },

  // A hairline in the survey plate around each notice. No fill and no shadow: the border is
  // what says something is missing here on purpose, and the sentence says who removed it.
  removed: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.survey,
    borderRadius: theme.radius.hair,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    gap: theme.space.xs,
  },
  removedWhere: { ...theme.collarLabel, color: theme.color.survey },
  removedProse: { ...theme.text('caption', { family: 'text' }), color: theme.color.ink },

  record: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.md,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  recordPressed: { backgroundColor: theme.color.surface },
  // Fixed, so the three figures line up in a column rather than stepping with the label width.
  recordLabel: {
    ...theme.collarLabel,
    color: theme.color.inkMuted,
    width: 96,
    paddingTop: theme.space.hair,
  },
  recordBody: { flex: 1, gap: theme.space.hair },
  recordValue: { ...theme.text('title', { family: 'mono' }), color: theme.color.ink },
  recordTrail: { ...theme.text('caption'), color: theme.color.ink },
  recordDate: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  recordEmpty: { ...theme.text('title', { family: 'mono' }), color: theme.color.inkMuted },

  regions: { gap: theme.space.md },
  region: { gap: theme.space.hair },
  regionHead: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.md },
  regionName: { ...theme.text('caption'), color: theme.color.ink, flex: 1 },
  regionFigure: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
  regionTrack: { height: 6, backgroundColor: theme.color.bezel },
  regionRule: { height: '100%', backgroundColor: theme.color.contour },

  listRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.md,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.bezel,
  },
  listName: { ...theme.text('body'), color: theme.color.ink, flex: 1 },
  listFigure: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },

  contributed: { ...theme.collarLabel, color: theme.color.inkMuted, marginTop: theme.space.xl },
  signedInAs: { ...theme.text('micro', { family: 'mono' }), color: theme.color.inkMuted },
});
