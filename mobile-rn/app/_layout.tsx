import { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { parseHubConnectLink } from "../src/auth/hub";

export default function RootLayout() {
  const router = useRouter();

  // `kin://connect?hub=…` is the console's G8 link: it pre-fills the pair
  // screen with a Hub address, never a credential. The person still taps
  // Continue, exactly as for a typed address.
  useEffect(() => {
    let live = true;

    const handle = (url: string | null): void => {
      if (!url || !live) return;
      const hub = parseHubConnectLink(url);
      if (hub !== null) router.replace({ pathname: "/pair", params: { hub } });
    };

    const subscription = Linking.addEventListener("url", ({ url }) => {
      handle(url);
    });
    void Linking.getInitialURL()
      .then(handle)
      .catch(() => undefined);

    return () => {
      live = false;
      subscription.remove();
    };
  }, [router]);

  return (
    // Production metrics come from the platform's own safe area; nothing is
    // guessed at launch. Every screen reads the same provider (R4/R7).
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
