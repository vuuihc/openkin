import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
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
 *
 * KIN-MOBILE-001 R5 — Back is also a data event: the conversation behind the
 * reader may have approved or answered something, and the list's pending
 * badges are the server's answer (story §8). The route is the only place that
 * knows about focus, so it translates a refocus into a bumped `focusEpoch`;
 * the screen re-reads through its controller. The focus at mount is skipped —
 * the screen's initial load already covers it.
 */
export default function ListRoute() {
  const router = useRouter();
  const [state, setState] = useState<AppState | null>(null);
  const [focusEpoch, setFocusEpoch] = useState(0);
  // A focus event while the list is showing is a return. While the boot read
  // is still deciding the first frame there is nothing to re-read.
  const showing = useRef(false);
  showing.current = state !== null;

  useFocusEffect(
    useCallback(() => {
      if (!showing.current) return;
      setFocusEpoch((epoch) => epoch + 1);
    }, []),
  );

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
      focusEpoch={focusEpoch}
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
