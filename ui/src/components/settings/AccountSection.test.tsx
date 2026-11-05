// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { NO_ACCOUNT, useAppStore } from "../../store/appStore";
import { AccountSection } from "./AccountSection";
import { startOIDC } from "../../api/account";

// The real startOIDC assigns window.location, which jsdom refuses to redefine.
// The contract this test cares about is which provider and return target reach
// it, so the navigation itself is replaced.
vi.mock("../../api/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/account")>();
  return { ...actual, startOIDC: vi.fn() };
});

/**
 * The settings row that answers "how can this account sign in?".
 *
 * Two failures are silent without it: a linked provider that the screen omits
 * (so the owner thinks they only have a password), and a provider that exists
 * but has no link action (so OAuth can never be attached on a claimed Hub).
 */

const password = { id: "password", label: "password", kind: "password" as const };
const oidc = {
  id: "oidc:https://kin.example.com/dex",
  label: "GitHub / Google",
  kind: "oidc" as const,
  start_url: "/api/auth/oidc/start",
};

function setAccount(identities: string[]): void {
  useAppStore.setState({
    account: {
      ...NO_ACCOUNT,
      enabled: true,
      authenticated: true,
      providers: [password, oidc],
      identities,
    },
  });
}

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [] });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the account section's sign-in methods", () => {
  it("names every credential attached to the account", () => {
    setAccount([password.id, oidc.id]);
    render(<AccountSection />);

    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByText("GitHub / Google")).toBeTruthy();
  });

  it("offers to link a provider the account does not have yet, on the settings page", async () => {
    setAccount([password.id]);
    const user = userEvent.setup();
    render(<AccountSection />);

    await user.click(screen.getByRole("button", { name: "Link GitHub / Google" }));

    // A link flow is authorized by the session, and the return target is where
    // the owner was standing. Losing it drops them on the task list instead.
    expect(startOIDC).toHaveBeenCalledWith(oidc, "/settings");
  });

  // Dex fronts several connectors under one issuer, and each mints its own
  // subject. Hiding the action after the first link would make the second
  // provider impossible to attach from the UI.
  it("still offers a link action after one identity from the provider is attached", async () => {
    setAccount([password.id, oidc.id]);
    const user = userEvent.setup();
    render(<AccountSection />);

    await user.click(screen.getByRole("button", { name: "Link another sign-in" }));

    expect(startOIDC).toHaveBeenCalledWith(oidc, "/settings");
  });

  // An identity whose provider was removed from the Hub's configuration still
  // exists. Showing an empty row would read as "no way in"; the credential is
  // still there, even if the provider is currently unreachable.
  it("keeps an identity whose provider is no longer configured", () => {
    setAccount(["password", "oidc:https://old.example.com"]);
    render(<AccountSection />);

    expect(screen.getByText("Another sign-in")).toBeTruthy();
  });

  // The shell's webview cannot host a link flow: the provider hop would be
  // cancelled by the shell's navigation gate and the resulting Set-Cookie
  // would land in the system browser's jar, so the bind never completes (G9).
  // Offering the button there would be offering a dead end — it stays a
  // console-in-a-desktop-browser action.
  it("hides the link action inside the native shell and says where to link instead", () => {
    const scope = globalThis as { Capacitor?: unknown };
    const previous = scope.Capacitor;
    // A G8/G9 shell: the platform check plus every method the console calls.
    scope.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: {
        KinHubConfig: {
          getHubUrl: () => Promise.resolve({ url: "https://kin.example.com" }),
          setHubUrl: () => Promise.resolve({ url: "https://kin.example.com" }),
          clearHubUrl: () => Promise.resolve(),
          openSystemBrowser: () => Promise.resolve(),
          takeAuthCallback: () => Promise.resolve({ url: "" }),
        },
      },
    };
    try {
      setAccount([password.id]);
      render(<AccountSection />);

      expect(screen.queryByRole("button", { name: "Link GitHub / Google" })).toBeNull();
      expect(
        screen.getByText(
          "Any of these signs you in. Linking another provider is done from the console in a desktop browser.",
        ),
      ).toBeTruthy();
      // The credentials themselves stay legible on the phone.
      expect(screen.getByText("Password")).toBeTruthy();
    } finally {
      scope.Capacitor = previous;
    }
  });
});

describe("the result of a link flow", () => {
  it("confirms a link and clears the parameters from the address bar", () => {
    window.history.replaceState({}, "", "/settings?auth_notice=linked&tab=account");
    setAccount([password.id, oidc.id]);
    render(<AccountSection />);

    expect(useAppStore.getState().toasts.map((toast) => toast.message)).toContain(
      "Sign-in method linked.",
    );
    // The tab survives; only the auth parameters are spent.
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("?tab=account");
  });

  // Without this, a failed link returns to a page that looks exactly like
  // success except that the provider is still missing.
  it("surfaces a failed link with the translated reason", () => {
    window.history.replaceState({}, "", "/settings?auth_error_code=identity_taken");
    setAccount([password.id]);
    render(<AccountSection />);

    expect(useAppStore.getState().toasts.map((toast) => toast.message)).toContain(
      "That login is already linked to another account.",
    );
    expect(window.location.search).toBe("");
  });
});
