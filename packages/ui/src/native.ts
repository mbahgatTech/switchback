/**
 * React Native shape of the same tokens.
 *
 * This file imports nothing from `react-native` on purpose — `packages/ui` is consumed by
 * the Next.js app as well, and a stray `react-native` import would break that bundle. What
 * it does instead is the unit conversion, which is the actual reason it exists.
 *
 * Three conversions that are easy to get wrong per-component and impossible to get wrong
 * here:
 *
 * - **lineHeight.** CSS takes a unitless multiplier; React Native takes points. A `1.6`
 *   passed straight through renders 1.6pt line spacing, i.e. overlapping text.
 * - **letterSpacing.** Our tracking is in em so it scales with size; React Native takes
 *   points. +0.14em on an 11px collar label is 1.54pt, and passing `0.14` gives you
 *   letterspacing you cannot see.
 * - **weight.** On the web, `font-family: Archivo` plus `font-weight: 600` picks an
 *   instance out of one variable font. React Native has no such indirection: `expo-font`
 *   registers each file under its own family name, so the weight *is* the family. These
 *   styles therefore carry `fontFamily: 'Archivo_600SemiBold'` and deliberately no
 *   `fontWeight` — leaving one in asks iOS to synthesise a fake bold on top of a real one,
 *   which is the smeared, slightly-too-heavy text that gives away a React Native app.
 */

import { FONT_SIZE, FONTS, LINE_HEIGHT, TRACKING } from './tokens/type';
import type { FontSizeName } from './tokens/type';
import { HAIRLINE, RADIUS, SPACE } from './tokens/space';
import { SCHEMES } from './tokens/color';
import type { Scheme, SchemeColors } from './tokens/color';

/**
 * The faces the app loads, keyed by the role and weight a caller asks for.
 *
 * The values are `@expo-google-fonts/*` export names, written out rather than derived:
 * that package turns `Source Serif 4` into `SourceSerif4` and `IBM Plex Mono` into
 * `IBMPlexMono`, and a clever string transform that reproduces both would be a worse thing
 * to debug than a table. `apps/mobile/app/_layout.tsx` registers exactly these keys, and
 * the type below is what stops the two lists drifting apart silently.
 *
 * Only the weights actually used are here, and that is the point — every entry is a font
 * file downloaded over cellular before the first screen paints. `displayCondensed` has one
 * because the collar label is one treatment.
 *
 * Archivo Narrow rather than Archivo at `wdth: 78`: React Native cannot drive an OpenType
 * width axis, so the condensed cut has to be a separate file. Narrow is Archivo's own
 * companion family from the same foundry, drawn at very nearly that width, which is why
 * `tokens/type.ts` can describe a width axis for the web and this file a second family.
 */
export const NATIVE_FONTS = {
  display: {
    regular: 'Archivo_400Regular',
    medium: 'Archivo_500Medium',
    semibold: 'Archivo_600SemiBold',
    bold: 'Archivo_700Bold',
  },
  displayCondensed: {
    bold: 'ArchivoNarrow_700Bold',
  },
  text: {
    regular: 'SourceSerif4_400Regular',
    /** The hydrography convention — water and conditions narrative is set in italic. */
    italic: 'SourceSerif4_400Regular_Italic',
    semibold: 'SourceSerif4_600SemiBold',
  },
  mono: {
    regular: 'IBMPlexMono_400Regular',
    medium: 'IBMPlexMono_500Medium',
  },
} as const;

export type NativeFamily = keyof typeof NATIVE_FONTS;
export type NativeWeight<F extends NativeFamily> = keyof (typeof NATIVE_FONTS)[F];

/** Every registered face, flat — what `useFonts` needs and what the app must not drift from. */
export type NativeFontName =
  (typeof NATIVE_FONTS)[NativeFamily][keyof (typeof NATIVE_FONTS)[NativeFamily]];

/**
 * Fallbacks for the frames before `useFonts` resolves, and for a device where it fails.
 *
 * Named per role so a failed load degrades to the right *kind* of face — the serif prose
 * stays serif — rather than dropping the whole app to one system sans.
 */
export const NATIVE_FALLBACKS: Readonly<Record<NativeFamily, string>> = {
  display: 'System',
  displayCondensed: 'System',
  text: FONTS.text.name,
  mono: 'Menlo',
} as const;

/** A style object React Native accepts directly — points throughout, no ems, no ratios. */
export interface NativeTextStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

/** Build a React Native text style from a scale step, converting units on the way out. */
export function nativeTextStyle<F extends NativeFamily = 'display'>(
  size: FontSizeName,
  options: { family?: F; weight?: NativeWeight<F> } = {},
): NativeTextStyle {
  const family: NativeFamily = options.family ?? 'display';
  const faces = NATIVE_FONTS[family] as Record<string, string>;
  const weight = (options.weight as string | undefined) ?? 'regular';
  const px = FONT_SIZE[size];
  return {
    // `?? regular` is not a silent fallback: `displayCondensed` has no regular either, so
    // the only way past the type check into this branch is a family whose sole face is
    // named something else, and taking it is better than rendering an undefined family.
    fontFamily: faces[weight] ?? Object.values(faces)[0]!,
    fontSize: px,
    lineHeight: Math.round(px * LINE_HEIGHT[size]),
    letterSpacing: Number((px * TRACKING[size]).toFixed(2)),
  };
}

/**
 * The collar label, pre-built because it is one specific treatment rather than a range of
 * options: 11pt, condensed, uppercase, letterspaced. Everywhere a map sheet would print
 * marginalia and nowhere else.
 */
export const collarLabel: NativeTextStyle & { textTransform: 'uppercase' } = {
  ...nativeTextStyle('micro', { family: 'displayCondensed', weight: 'bold' }),
  textTransform: 'uppercase',
};

export interface NativeTheme {
  scheme: Scheme;
  color: Readonly<SchemeColors>;
  space: typeof SPACE;
  radius: typeof RADIUS;
  /**
   * One *device* pixel, not one point — thinner and correcter on a retina screen, which
   * matters because on the field scheme this line is what separates surfaces rather than
   * a shadow. The app substitutes `StyleSheet.hairlineWidth`; this is the fallback for
   * anywhere that value is not reachable.
   */
  hairline: number;
  text: typeof nativeTextStyle;
  collarLabel: typeof collarLabel;
}

export function nativeTheme(scheme: Scheme): NativeTheme {
  return {
    scheme,
    color: SCHEMES[scheme],
    space: SPACE,
    radius: RADIUS,
    hairline: HAIRLINE,
    text: nativeTextStyle,
    collarLabel,
  };
}
