import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { pairing, type AppState } from "../src/auth/pairing";
import { t } from "../src/i18n";
import { bootHref } from "../src/screens/pairModel";

/**
 * KIN-MOBILE-001 R2b — a minimal landing that proves the first list read
 * arrived. R3 replaces this screen with the device → project → conversation
 * list; it deliberately has no grouping, folds, search or composer.
 */
export default function ListScreen() {
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
    <View style={styles.container}>
      <Text style={styles.title}>
        {t("pairing.connected", { origin: state.origin ?? "" })}
      </Text>
      {state.reason === "unreachable" ? (
        <Text accessibilityRole="alert" style={styles.notice}>
          {t("pairing.unreachable")}
        </Text>
      ) : null}
      {state.tasks.length === 0 ? (
        <Text style={styles.empty}>{t("pairing.noTasks")}</Text>
      ) : (
        <View style={styles.rows}>
          {state.tasks.map((task) => (
            <Text key={task.id} style={styles.row}>
              {task.title}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 12,
    padding: 24,
    paddingTop: 72,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
  },
  notice: {
    color: "#a1261b",
    fontSize: 15,
  },
  empty: {
    color: "#555555",
    fontSize: 16,
  },
  rows: {
    gap: 12,
  },
  row: {
    fontSize: 16,
    minHeight: 44,
  },
});
