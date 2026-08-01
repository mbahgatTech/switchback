/**
 * React Native shape of the same tokens. Imports nothing from `react-native`, because
 * `packages/ui` is also consumed by the Next.js app.
 *
 * It exists for three unit conversions: `lineHeight` (CSS multiplier → points), `letterSpacing`
 * (em → points), and `weight` — `expo-font` registers each file under its own family name, so
 * the weight *is* the family. These styles carry `fontFamily: 'Archivo_600SemiBold'` and
 * deliberately no `fontWeight`; leaving one in makes iOS synthesise a fake bold over a real one.
 */

import { FONT_SIZE, FONTS, LINE_HEIGHT, TRACKING } from './tokens/type';
import type { FontSizeName } from './tokens/type';
import { HAIRLINE, RADIUS, SPACE } from './tokens/space';
import { SCHEMES } from './tokens/color';
import type { Scheme, SchemeColors } from './tokens/color';

/**
 * The faces the app loads. Values are `@expo-google-fonts/*` export names, written out rather
 * than derived — that package produces both `SourceSerif4` and `IBMPlexMono`, and a transform
 * covering both would be worse to debug than a table. `apps/mobile/app/_layout.tsx` registers
 * exactly these keys; `NativeFontName` stops the two lists drifting.
 *
 * Only the weights actually used, since each entry is a file downloaded before the first paint.
 * Archivo Narrow rather than Archivo at `wdth: 78`: React Native cannot drive an OpenType width
 * axis, so the condensed cut has to be a separate family.
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
 * Fallbacks for the frames before `useFonts` resolves, and for a device where it fails. Named
 * per role so a failed load degrades to the right *kind* of face.
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
    // Reachable only for a family whose sole face is not named `regular`; rendering its first
    // face beats rendering an undefined family.
    fontFamily: faces[weight] ?? Object.values(faces)[0]!,
    fontSize: px,
    lineHeight: Math.round(px * LINE_HEIGHT[size]),
    letterSpacing: Number((px * TRACKING[size]).toFixed(2)),
  };
}

/**
 * The collar label: 11pt, condensed, uppercase, letterspaced. Pre-built because it is one
 * specific treatment — marginalia, and nowhere else.
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
  /** Fallback for where `StyleSheet.hairlineWidth` (one *device* pixel) is not reachable. */
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
