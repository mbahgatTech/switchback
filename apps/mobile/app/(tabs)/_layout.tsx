import { Tabs, TabSlot } from 'expo-router/ui';
import { TabBar } from '@/components/tab-bar';

/**
 * The four places.
 *
 * `expo-router/ui` rather than the classic `Tabs` navigator, because the bar is drawn from
 * scratch in `components/tab-bar` and the headless API is the supported way to do that —
 * `TabSlot` renders whichever screen is current and `TabList` is whatever we hand it.
 *
 * Order is the order of a hike: find something, keep the ones worth keeping, hike it, and
 * then look at what you have hiked. Record sits third rather than in the middle-as-hero
 * position some apps give it, because a recorder you can start by accident is worse than one
 * that takes a deliberate tap.
 *
 * Trail detail, sign-in and an activity's own page stay outside this group: they are places
 * you arrive at from somewhere, and pushing them over the bar keeps the way back obvious.
 */
export default function TabsLayout() {
  return (
    <Tabs>
      <TabSlot />
      <TabBar />
    </Tabs>
  );
}
