import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { pairing, type AppState } from "../src/auth/pairing";
import { t } from "../src/i18n";
import { bootHref } from "../src/screens/pairModel";
import ListScreen from "../src/screens/ListScreen";

/**
 * KIN-MOBILE-001 R3 — the list route.
 *
 * The boot check decides the first frame (a stored, accepted session lands
 * here; anything else opens the pairing entry), then the wired screen reads
 * the session itself and draws device → project → conversation. A row pushes
 * the conversation; `push` keeps this screen mounted under the stack, which is
 * what restores its folds and scroll position on Back.
 */
export default function ListRoute() {
  const router = useRouter();
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    let mounted = true;
    void pairing
      .startRoute()
      .then((next) => {
        if (!mounted) return;
        if (next.route === "pairing") {
          router.replace(bootHref(next));
          return;
        }
        setState(next);
      })
      .catch(() => {
        if (mounted) router.replace("/pair");
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  if (state === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel={t("common.loading")} />
      </View>
    );
  }

  return (
    <ListScreen
      onNeedsPairing={() => router.replace("/pair")}
      onOpen={(taskId) => router.push(`/thread/${encodeURIComponent(taskId)}`)}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});
