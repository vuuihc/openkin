import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { pairing, type AppState } from "../src/auth/pairing";
import { hubSignIn } from "../src/auth/hubSignIn";
import type { HubReason, HubStatus } from "../src/auth/hub";
import { t } from "../src/i18n";

const FRESH: AppState = {
  route: "pairing",
  reason: "none",
  origin: null,
  tasks: [],
  display: null,
};

/** Every Hub refusal has a sentence; the transport reasons keep their names. */
const HUB_REASON_KEYS: Record<HubReason, string> = {
  expired: "pairing.expired",
  rejected: "pairing.rejected",
  unreachable: "pairing.unreachable",
  insecure: "pairing.hubInsecure",
  "no-accounts": "pairing.hubNoAccounts",
};

/**
 * R-rn-hub-signin — the pairing screen now offers a Hub first.
 *
 * One primary action at a time: the Hub address, then the methods
 * `/api/auth/status` listed, then (secondary) the single-node pairing link the
 * app has always accepted. A browser sign-in leaves the app; its callback is
 * completed by the root layout and the same singleton, so this screen only
 * shows the waiting note. Typed values are never cleared by a failure.
 */
export default function PairScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    reason?: string | string[];
    hub?: string | string[];
  }>();
  const initialHub = typeof params.hub === "string" ? params.hub : "";

  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AppState>(() => ({
    ...FRESH,
    reason: params.reason === "expired" ? "expired" : "none",
  }));

  const [hubTyped, setHubTyped] = useState(initialHub);
  const [hubStatus, setHubStatus] = useState<HubStatus | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  const [hubReason, setHubReason] = useState<HubReason | null>(null);
  const [hubErrorCode, setHubErrorCode] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showNode, setShowNode] = useState(false);

  const flow = useRef(0);
  const inputRef = useRef<TextInputInstance>(null);

  useEffect(
    () => () => {
      flow.current += 1;
    },
    [],
  );

  // A connect link can land while this screen is already mounted; the route
  // replaces its params rather than remounting, so sync the field here.
  useEffect(() => {
    if (typeof params.hub === "string" && params.hub !== "") {
      setHubTyped(params.hub);
      setHubStatus(null);
      setHubReason(null);
    }
  }, [params.hub]);

  const reportFailure = useCallback((code: string | undefined) => {
    setHubErrorCode(code ?? null);
  }, []);

  const probe = useCallback(async () => {
    if (hubBusy || hubTyped.trim() === "") return;
    const my = ++flow.current;
    setHubBusy(true);
    setHubReason(null);
    setHubErrorCode(null);
    try {
      const result = await hubSignIn.probe(hubTyped);
      if (my !== flow.current) return;
      if (result.ok) {
        setHubTyped(result.origin);
        setHubStatus(result.status);
        if (result.status.providers.length === 0 || result.status.needsBootstrap) {
          setHubReason("no-accounts");
        }
      } else {
        setHubReason(result.reason);
      }
    } catch {
      if (my === flow.current) setHubReason("unreachable");
    } finally {
      if (my === flow.current) setHubBusy(false);
    }
  }, [hubBusy, hubTyped]);

  const signIn = useCallback(async () => {
    const origin = hubStatus?.origin ?? hubTyped;
    if (
      hubBusy ||
      origin.trim() === "" ||
      email.trim() === "" ||
      password === ""
    ) {
      return;
    }
    const my = ++flow.current;
    setHubBusy(true);
    setHubReason(null);
    setHubErrorCode(null);
    try {
      const result = await hubSignIn.signInWithPassword(
        origin,
        email.trim(),
        password,
      );
      if (my !== flow.current) return;
      if (result.ok) {
        router.replace("/list");
        return;
      }
      setHubReason(result.reason);
      reportFailure(result.errorCode);
    } catch {
      if (my === flow.current) setHubReason("unreachable");
    } finally {
      if (my === flow.current) setHubBusy(false);
    }
  }, [email, hubBusy, hubStatus, hubTyped, password, reportFailure, router]);

  const submitNode = useCallback(async () => {
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
      if (myFlow === flow.current) {
        setState({ ...FRESH, reason: "rejected" });
      }
    } finally {
      if (myFlow === flow.current) setBusy(false);
    }
    inputRef.current?.focus();
  }, [busy, typed, router]);

  const nodeView = pairView(state, { busy, typed });
  const errorKey = hubErrorCode ? `account.errors.${hubErrorCode}` : "";
  const localizedError = errorKey ? t(errorKey) : "";
  const reasonKey =
    localizedError && localizedError !== errorKey
      ? localizedError
      : hubReason
        ? t(HUB_REASON_KEYS[hubReason])
        : null;
  const needsOwner = hubStatus?.needsBootstrap === true;
  const passwordListed =
    hubStatus !== null &&
    !needsOwner &&
    hubStatus.providers.some((provider) => provider.kind === "password");
  const oidcOnly =
    hubStatus !== null &&
    !needsOwner &&
    !passwordListed &&
    hubStatus.providers.some((provider) => provider.kind === "oidc");

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.form}>
        <Text style={styles.title}>{t("pairing.hubTitle")}</Text>
        <Text style={styles.hint}>{t("pairing.hubHint")}</Text>
        <TextInput
          accessibilityLabel={t("pairing.hubPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={(value) => {
            setHubTyped(value);
            // A changed address is a different Hub: the methods listed for
            // the previous one do not apply.
            if (hubStatus !== null && value !== hubStatus.origin) {
              setHubStatus(null);
              setHubReason(null);
            }
          }}
          onSubmitEditing={() => {
            void probe();
          }}
          placeholder={t("pairing.hubPlaceholder")}
          returnKeyType="go"
          style={styles.input}
          value={hubTyped}
        />
        {hubStatus === null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: hubBusy, disabled: hubBusy }}
            disabled={hubBusy}
            onPress={() => {
              void probe();
            }}
            style={[styles.action, hubBusy && styles.actionDisabled]}
          >
            <Text style={styles.actionText}>
              {t(hubBusy ? "pairing.hubChecking" : "pairing.hubContinue")}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.section}>
            <View style={styles.originRow}>
              <Text style={styles.origin}>{hubStatus.origin}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setHubStatus(null);
                  setHubReason(null);
                  setBrowserOpened(false);
                }}
                style={styles.secondaryAction}
              >
                <Text style={styles.secondaryText}>{t("pairing.hubBack")}</Text>
              </Pressable>
            </View>

            {passwordListed ? (
              <>
                <Text style={styles.hint}>{t("pairing.hubPasswordHint")}</Text>
                <TextInput
                  accessibilityLabel={t("account.emailLabel")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  placeholder={t("account.emailPlaceholder")}
                  style={styles.input}
                  textContentType="username"
                  value={email}
                />
                <TextInput
                  accessibilityLabel={t("account.passwordLabel")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setPassword}
                  placeholder={t("account.passwordLabel")}
                  secureTextEntry
                  style={styles.input}
                  textContentType="password"
                  value={password}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{
                    busy: hubBusy,
                    disabled: hubBusy || email.trim() === "" || password === "",
                  }}
                  disabled={hubBusy || email.trim() === "" || password === ""}
                  onPress={() => {
                    void signIn();
                  }}
                  style={[
                    styles.action,
                    (hubBusy || email.trim() === "" || password === "") &&
                      styles.actionDisabled,
                  ]}
                >
                  <Text style={styles.actionText}>
                    {t(hubBusy ? "pairing.hubSigningIn" : "pairing.hubSignIn")}
                  </Text>
                </Pressable>
              </>
            ) : null}

            {oidcOnly ? (
              <Text accessibilityRole="alert" style={styles.hint}>
                {t("pairing.hubOidcPending")}
              </Text>
            ) : null}
            {needsOwner ? (
              <Text accessibilityRole="alert" style={styles.reason}>
                {t("pairing.hubNeedsOwner")}
              </Text>
            ) : null}
          </View>
        )}

        {reasonKey !== null && !(needsOwner && hubReason === "no-accounts") ? (
          <Text accessibilityRole="alert" style={styles.reason}>
            {reasonKey}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => setShowNode((open) => !open)}
          style={styles.secondaryAction}
        >
          <Text style={styles.secondaryText}>
            {t(showNode ? "pairing.hubTitle" : "pairing.hubNodeInstead")}
          </Text>
        </Pressable>

        {showNode ? (
          <View style={styles.section}>
            <Text style={styles.subtitle}>{t("pairing.hubNodeTitle")}</Text>
            <Text style={styles.hint}>{t("pairing.hint")}</Text>
            <TextInput
              accessibilityLabel={t("pairing.hint")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setTyped}
              onSubmitEditing={() => {
                void submitNode();
              }}
              placeholder={t("pairing.placeholder")}
              ref={inputRef}
              returnKeyType="go"
              style={styles.input}
              value={typed}
            />
            {nodeView.bodyKey !== null ? (
              <Text accessibilityRole="alert" style={styles.reason}>
                {t(nodeView.bodyKey)}
              </Text>
            ) : null}
            <Pressable
              accessibilityLabel={t(nodeView.actionKey)}
              accessibilityRole="button"
              accessibilityState={{ busy, disabled: !nodeView.canSubmit }}
              disabled={!nodeView.canSubmit}
              onPress={() => {
                void submitNode();
              }}
              style={[styles.action, !nodeView.canSubmit && styles.actionDisabled]}
            >
              <Text style={styles.actionText}>{t(nodeView.actionKey)}</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  form: {
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  section: {
    gap: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 18,
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
  secondaryAction: {
    justifyContent: "center",
    minHeight: 44,
  },
  secondaryText: {
    color: "#1f5f3f",
    fontSize: 16,
  },
  originRow: {
    gap: 4,
  },
  origin: {
    fontSize: 15,
    fontWeight: "600",
  },
});
