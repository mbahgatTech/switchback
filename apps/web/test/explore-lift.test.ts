import { describe, expect, it } from 'vitest';
import { LIFT_HEADROOM_PX, liftCeiling, MAP_CHROME_PX } from '../src/components/explore/lift';

/**
 * The pick card lifts MapLibre's bottom chrome by a bottom margin. Unclamped, a long title made a
 * 282 px card, a 306 px lift, and a zoom pair at y = −14 on a 320 px phone — a control off the
 * screen, which nothing in the suite would have caught.
 */
describe('map chrome lift ceiling', () => {
  /** 45dvh of a 720 px phone, the viewport the unclamped lift went off the bottom of. */
  const PANE_320 = 324;

  it('leaves the tallest control on the pane, with headroom', () => {
    const ceiling = liftCeiling(PANE_320);
    expect(PANE_320 - ceiling - MAP_CHROME_PX).toBe(LIFT_HEADROOM_PX);
    expect(ceiling).toBeLessThan(PANE_320);
  });

  it('holds the zoom pair and the scale bar inside the pane at the ceiling', () => {
    const SCALE_BAR_PX = 32;
    const lift = liftCeiling(PANE_320);
    expect(PANE_320 - lift - MAP_CHROME_PX).toBeGreaterThan(0);
    expect(PANE_320 - lift - SCALE_BAR_PX).toBeGreaterThan(0);
  });

  it('never returns a negative lift on a pane shorter than the chrome', () => {
    // A split viewport or a keyboard can leave less room than the controls need. Clamping at zero
    // overlaps the card on the chrome, which is recoverable; a negative margin pushes it upward.
    expect(liftCeiling(40)).toBe(0);
    expect(liftCeiling(0)).toBe(0);
  });

  it('grows with the pane, so a tablet is not held to a phone ceiling', () => {
    expect(liftCeiling(900)).toBeGreaterThan(liftCeiling(PANE_320));
  });
});
