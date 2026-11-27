import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
} from "react-native-safe-area-context";
import { pairing, type AppState } from "../src/auth/pairing";
import { hubSignIn } from "../src/auth/hubSignIn";
import type { HubReason, HubStatus } from "../src/auth/hub";
import { t } from "../src/i18n";
import { pairView } from "../src/screens/pairModel";
import { useTheme } from "../src/theme/useTheme";
import type { Palette } from "../src/theme/tokens";

const FRESH: AppState = {
  route: "pairing",
  reason: "none",
  origin: null,
  tasks: [],
  display: null,
};

/** A screen rendered without a provider has no notch to clear. */
const NO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Every Hub refusal has a sentence; the transport reasons keep their names. */
const HUB_REASON_KEYS: Record<HubReason, string> = {
  expired: "pairing.expired",
  // `rejected` on this screen is the Hub refusing a sign-in, not a dead
  // pairing link.
  rejected: "pairing.hubRejected",
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
  const [hubReason, setHubReason] = useState<HubReason | null>(
    // The boot reason arrives in the URL; a Hub-first screen must show it
    // even when the node-pairing section below stays collapsed.
    params.reason === "expired" ? "expired" : null,
  );
  const [hubErrorCode, setHubErrorCode] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showNode, setShowNode] = useState(false);

  // The Hub flow and the node flow own separate generations: interleaving
  // them must not leave either `hubBusy` or `busy` stuck true.
  const hubFlow = useRef(0);
  const nodeFlow = useRef(0);
  const inputRef = useRef<TextInputInstance>(null);
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;

  useEffect(
    () => () => {
      hubFlow.current += 1;
      nodeFlow.current += 1;
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
      setHubErrorCode(null);
    }
  }, [params.hub]);

  const reportFailure = useCallback((code: string | undefined) => {
    setHubErrorCode(code ?? null);
  }, []);

  const probe = useCallback(async () => {
    if (hubBusy || hubTyped.trim() === "") return;
    const my = ++hubFlow.current;
    setHubBusy(true);
    setHubReason(null);
    setHubErrorCode(null);
    try {
      const result = await hubSignIn.probe(hubTyped);
      if (my !== hubFlow.current) return;
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
      if (my === hubFlow.current) setHubReason("unreachable");
    } finally {
      if (my === hubFlow.current) setHubBusy(false);
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
    const my = ++hubFlow.current;
    setHubBusy(true);
    setHubReason(null);
    setHubErrorCode(null);
    try {
      const result = await hubSignIn.signInWithPassword(
        origin,
        email.trim(),
        password,
      );
      if (my !== hubFlow.current) return;
      if (result.ok) {
        // A Hub session replaces whatever node token retired earlier; the
        // list route's boot read must not bounce back to /pair?reason=expired.
        pairing.clearRetired();
        router.replace("/list");
        return;
      }
      setHubReason(result.reason);
      reportFailure(result.errorCode);
    } catch {
      if (my === hubFlow.current) setHubReason("unreachable");
    } finally {
      if (my === hubFlow.current) setHubBusy(false);
    }
  }, [email, hubBusy, hubStatus, hubTyped, password, reportFailure, router]);

  const submitNode = useCallback(async () => {
    if (busy || typed.trim() === "") return;
    const myFlow = ++nodeFlow.current;
    setBusy(true);
    try {
      const next = await pairing.pairWithLink(typed);
      if (myFlow !== nodeFlow.current) return;
      setState(next);
      if (next.route === "list") {
        router.replace("/list");
        return;
      }
    } catch {
      if (myFlow === nodeFlow.current) {
        setState({ ...FRESH, reason: "rejected" });
      }
    } finally {
      if (myFlow === nodeFlow.current) setBusy(false);
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
      <ScrollView
        contentContainerStyle={[
          styles.form,
          {
            paddingTop: 24 + insets.top,
            paddingBottom: 24 + insets.bottom,
          },
        ]}
      >
        <Text style={styles.title}>{t("pairing.hubTitle")}</Text>
        <Text style={styles.hint}>{t("pairing.hubHint")}</Text>
        <TextInput
          accessibilityLabel={t("pairing.hubPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={(value) => {
            setHubTyped(value);
            // A refused sign-in belongs to the address it was tried on.
            setHubErrorCode(null);
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
          placeholderTextColor={colors.muted}
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
                  setHubErrorCode(null);
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
                  placeholderTextColor={colors.muted}
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
                  placeholderTextColor={colors.muted}
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
              placeholderTextColor={colors.muted}
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

const makeStyles = (colors: Palette) => StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  form: {
    flexGrow: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  section: {
    gap: 10,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "600",
  },
  subtitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  hint: {
    color: colors.secondary,
    fontSize: 15,
  },
  input: {
    borderColor: colors.hairlineStrong,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  reason: {
    color: colors.redInk,
    fontSize: 15,
  },
  action: {
    alignItems: "center",
    backgroundColor: colors.green,
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: colors.onStatus,
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryAction: {
    justifyContent: "center",
    minHeight: 44,
  },
  secondaryText: {
    color: colors.greenInk,
    fontSize: 16,
  },
  originRow: {
    gap: 4,
  },
  origin: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
});
