import { StyleSheet, Text, View } from "react-native";
import en from "@ui/i18n/locales/en";

/**
 * R1 placeholder route. It renders no product surface; its only job is to make
 * the shared-import closure real by importing a signed locale catalog in place
 * (ADR 0036 §2).
 */
export default function IndexScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{en.app.name}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "600",
  },
});
