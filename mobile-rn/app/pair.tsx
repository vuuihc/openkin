import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { pairing, type AppState } from "../src/auth/pairing";
import { t } from "../src/i18n";
import { pairView } from "../src/screens/pairModel";

const FRESH: AppState = {
  route: "pairing",
  reason: "none",
  origin: null,
  tasks: [],
  display: null,
};

/**
 * KIN-MOBILE-001 R2b — the pairing screen.
 *
 * One paste field and one primary action. The typed link is never cleared: a
 * failed attempt keeps it so a retry needs no retyping. A flow counter drops a
 * late answer from a screen that has moved on (AGENTS.md §11).
 */
export default function PairScreen() {
  const router = useRouter();
  // The boot and list screens carry the reason in the href; a fresh entry has
  // none, so the first frame says why this screen is showing (story §1).
  const { reason } = useLocalSearchParams<{ reason?: string | string[] }>();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AppState>(() => ({
    ...FRESH,
    reason: reason === "expired" ? "expired" : "none",
  }));
  const flow = useRef(0);
  const inputRef = useRef<TextInputInstance>(null);

  useEffect(
    () => () => {
      flow.current += 1;
    },
    [],
  );

  const view = pairView(state, { busy, typed });

  const submit = useCallback(async () => {
    if (busy || typed.trim() === "") return;
    const myFlow = ++flow.current;
    setBusy(true);
    try {
      const next = await pairing.pairWithLink(typed);
      if (myFlow !== flow.current) return;
      setState(next);
      if (next.route === "list") {
        router.replace("/list");
        return;
      }
    } catch {
      // A rejected Keychain/SecureStore promise must not strand the action:
      // name a reason and hand the field back so a retry stays possible.
      if (myFlow !== flow.current) return;
      setState({ ...FRESH, reason: "rejected" });
    } finally {
      // A stale flow's answer must not clear the busy state of a newer one.
      if (myFlow === flow.current) setBusy(false);
    }
    // A failed attempt keeps the link and returns focus to the field so the
    // reason is read and a retry needs no retyping (story §1, 键盘与焦点).
    inputRef.current?.focus();
  }, [busy, typed, router]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <View style={styles.form}>
        <Text style={styles.title}>{t(view.headingKey)}</Text>
        <Text style={styles.hint}>{t("pairing.hint")}</Text>
        <TextInput
          accessibilityLabel={t("pairing.hint")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={setTyped}
          onSubmitEditing={() => {
            void submit();
          }}
          placeholder={t("pairing.placeholder")}
          ref={inputRef}
          returnKeyType="go"
          style={styles.input}
          value={typed}
        />
        {view.bodyKey !== null ? (
          <Text accessibilityRole="alert" style={styles.reason}>
            {t(view.bodyKey)}
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel={t(view.actionKey)}
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: !view.canSubmit }}
          disabled={!view.canSubmit}
          onPress={() => {
            void submit();
          }}
          style={[styles.action, !view.canSubmit && styles.actionDisabled]}
        >
          <Text style={styles.actionText}>{t(view.actionKey)}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
  },
  form: {
    gap: 12,
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: "600",
  },
  hint: {
    color: "#555555",
    fontSize: 15,
  },
  input: {
    borderColor: "#888888",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  reason: {
    color: "#a1261b",
    fontSize: 15,
  },
  action: {
    alignItems: "center",
    backgroundColor: "#1f5f3f",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
});
