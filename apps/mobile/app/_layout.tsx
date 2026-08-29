import {
  Archivo_400Regular,
  Archivo_500Medium,
  Archivo_600SemiBold,
  Archivo_700Bold,
} from '@expo-google-fonts/archivo';
import { ArchivoNarrow_700Bold } from '@expo-google-fonts/archivo-narrow';
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono';
import {
  SourceSerif4_400Regular,
  SourceSerif4_400Regular_Italic,
  SourceSerif4_600SemiBold,
} from '@expo-google-fonts/source-serif-4';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { nativeTheme } from '@switchback/ui';
import { ApiProvider } from '@/api/trpc';
import { AuthProvider } from '@/auth/context';
import { RecordBridge } from '@/record/bridge';
// Side effect only: registering the CoreLocation task at module load is what lets iOS relaunch
// the app headless and hand it a position. Imported here rather than left to whichever component
// happens to pull the recorder in, so a refactor cannot silently end background recording.
import '@/record/background';

/**
 * Root layout.
 *
 * Provider order is load-bearing: `ApiProvider` builds a tRPC link whose headers call into
 * the session module, so auth has to be mounted around it.
 */

/**
 * The typefaces, keyed by the names `packages/ui` promises in `NATIVE_FONTS`.
 *
 * One file per weight, and only the weights the design actually uses — each entry is bytes
 * downloaded before the first screen paints, which on a trailhead with one bar is a real
 * cost. `ArchivoNarrow_700Bold` is here for exactly one treatment, the collar label.
 */
const FACES = {
  Archivo_400Regular,
  Archivo_500Medium,
  Archivo_600SemiBold,
  Archivo_700Bold,
  ArchivoNarrow_700Bold,
  SourceSerif4_400Regular,
  SourceSerif4_400Regular_Italic,
  SourceSerif4_600SemiBold,
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
};

const theme = nativeTheme('field');

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FACES);

  /*
   * Hold on the canvas colour rather than rendering unstyled text for a frame. Expo hides
   * the native splash once the root view paints, so this View is what the splash hands off
   * to — same colour, no white flash between them.
   *
   * `fontError` releases the gate deliberately. A font that fails to download is a reason
   * to show the app in the fallback faces, not a reason to show nothing on a mountain.
   */
  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: theme.color.canvas }} />;
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ApiProvider>
          {/* Restores an interrupted hike and gives the recorder its uploader. Draws nothing. */}
          <RecordBridge />
          {/* Fixed light, because the field scheme is the app's ground rather than a preference. */}
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              // Without this the push transition flashes the platform default white.
              contentStyle: { backgroundColor: theme.color.canvas },
            }}
          />
        </ApiProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
