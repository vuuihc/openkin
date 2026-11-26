import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { pairing, type AppState } from "../src/auth/pairing";
import { t } from "../src/i18n";
import { bootHref } from "../src/screens/pairModel";

/**
 * KIN-MOBILE-001 R2b — the boot decision.
 *
 * One resume decides the first frame: a stored, accepted session lands on the
 * list; anything else (no token, an expired token) opens the pairing entry.
 * The mounted flag keeps a late resume from navigating a screen that moved on
 * (AGENTS.md §11).
 */
export default function IndexScreen() {
  const router = useRouter();
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    let mounted = true;
    void pairing
      .startRoute()
      .then((next) => {
        if (!mounted) return;
        setState(next);
        router.replace(bootHref(next));
      })
      .catch(() => {
        if (mounted) router.replace("/pair");
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  return (
    <View style={styles.container}>
      <ActivityIndicator
        accessibilityLabel={state === null ? t("common.loading") : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});
