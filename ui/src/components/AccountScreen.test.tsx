// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { claimOwner, startOIDC } from "../api/account";
import { setLocale } from "../i18n";
import { NO_ACCOUNT, useAppStore, type AccountProvider } from "../store/appStore";
import AccountScreen from "./AccountScreen";

// The screen only calls these on submit; the render path is what this test
// covers, so the implementations never run.
vi.mock("../api/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/account")>();
  return {
    ...actual,
    claimOwner: vi.fn(),
    joinHub: vi.fn(),
    signIn: vi.fn(),
    startOIDC: vi.fn(),
  };
});

const password: AccountProvider = { id: "password", label: "password", kind: "password" };
const oidc: AccountProvider = {
  id: "oidc:https://kin.example.com/dex",
  label: "GitHub / Google",
  kind: "oidc",
  start_url: "/api/auth/oidc/start",
};

/**
 * Federated sign-in is only offered where it can finish.
 *
 * Claiming and joining both spend a code the provider callback does not carry,
 * so an OIDC button there can only answer with a false "this hub already has an
 * owner". The login screen is the one place the flow works.
 */
describe("where federated sign-in is offered", () => {
  beforeEach(() => {
    setLocale("en");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
  });

  it("offers the provider on the login screen", () => {
    useAppStore.setState({
      account: {
        ...NO_ACCOUNT,
        enabled: true,
        authenticated: false,
        providers: [password, oidc],
      },
    });

    render(<AccountScreen mode="login" />);

    expect(screen.getByRole("button", { name: "Continue with GitHub / Google" })).toBeTruthy();
  });

  it.each(["claim", "join"] as const)("does not offer it while enrolling (%s)", (mode) => {
    useAppStore.setState({
      account: {
        ...NO_ACCOUNT,
        enabled: true,
        needsBootstrap: mode === "claim",
        claimable: mode === "claim",
        providers: [password, oidc],
      },
    });

    render(<AccountScreen mode={mode} />);

    expect(screen.queryByRole("button", { name: /^Continue with / })).toBeNull();
  });
});

/**
 * A claim link is the agent-era version of the code read off a terminal log.
 * The person should land on a form that is already filled in, and should not be
 * told to go looking for a code that is on their screen.
 */
describe("claim links", () => {
  beforeEach(() => {
    setLocale("en");
    useAppStore.setState({
      account: {
        ...NO_ACCOUNT,
        enabled: true,
        needsBootstrap: true,
        claimable: true,
        providers: [password],
      },
    });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("fills the code in from the link and drops the 'where to find it' help", () => {
    window.history.replaceState({}, "", "/?claim=abcde23456");

    render(<AccountScreen mode="claim" />);

    const field = screen.getByLabelText("Claim code") as HTMLInputElement;
    expect(field.value).toBe("ABCDE-23456");
    expect(screen.queryByText(/Where does the code come from/)).toBeNull();
    expect(screen.getByText(/Your claim code came from the link/)).toBeTruthy();
  });

  it("fills the code in from a link that carries it in the fragment", () => {
    // Current links use `#claim=`: the code never reaches a server, a proxy log
    // or a link preview. The person still lands on a filled-in form.
    window.history.replaceState({}, "", "/#claim=abcde23456");

    render(<AccountScreen mode="claim" />);

    const field = screen.getByLabelText("Claim code") as HTMLInputElement;
    expect(field.value).toBe("ABCDE-23456");
    expect(screen.queryByText(/Where does the code come from/)).toBeNull();
    expect(screen.getByText(/Your claim code came from the link/)).toBeTruthy();
    // Read once: the credential does not stay in the address bar or history.
    expect(window.location.hash).toBe("");
  });

  it("still accepts a claim link printed by an older version", () => {
    // Those carry `?claim=`, which is what the code-in-the-query change was
    // fixing; refusing them would strand anybody holding one.
    window.history.replaceState({}, "", "/?claim=abcde23456");

    render(<AccountScreen mode="claim" />);

    const field = screen.getByLabelText("Claim code") as HTMLInputElement;
    expect(field.value).toBe("ABCDE-23456");
    // The code the form now holds is not left behind in the address bar.
    expect(window.location.search).toBe("");
  });

  it("still explains where a code comes from on an ordinary visit", () => {
    window.history.replaceState({}, "", "/");

    render(<AccountScreen mode="claim" />);

    expect((screen.getByLabelText("Claim code") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Where does the code come from/)).toBeTruthy();
  });

  it("keeps that help after the person types, since no link was followed", () => {
    window.history.replaceState({}, "", "/");

    render(<AccountScreen mode="claim" />);
    fireEvent.change(screen.getByLabelText("Claim code"), { target: { value: "abcde23456" } });

    expect(screen.getByText(/Where does the code come from/)).toBeTruthy();
    expect(screen.queryByText(/Your claim code came from the link/)).toBeNull();
  });
});

/**
 * Consuming the URL's error is a once-per-visit job.
 *
 * StrictMode mounts every effect twice in development: the first pass reads the
 * error out of the query string and deletes it, so an unguarded second pass
 * reads nothing and clears the message it just set. The person then sees a
 * plain login form after following a dead link.
 */
describe("an auth error carried by the URL", () => {
  beforeEach(() => {
    setLocale("en");
    useAppStore.setState({
      account: { ...NO_ACCOUNT, enabled: true, providers: [password] },
    });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("is still shown after StrictMode's second mount", () => {
    window.history.replaceState({}, "", "/?auth_error_code=login_link_invalid&auth_error=gone");

    render(
      <StrictMode>
        <AccountScreen mode="login" />
      </StrictMode>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "This sign-in link is not valid or has expired",
    );
  });
});

/**
 * E6: the gate's controls are the console's shared button.
 *
 * The migration is a surface change, so these tests name controls the way a
 * person does — role and accessible name — and read the facade's variant from
 * the class list. The call behind the form is asserted separately: a facade
 * that quietly defaulted to `type="button"` would still look right and submit
 * nothing.
 */
describe("the account screen's actions", () => {
  beforeEach(() => {
    setLocale("en");
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("puts the account screen's actions on the shared button facade", () => {
    useAppStore.setState({
      account: {
        ...NO_ACCOUNT,
        enabled: true,
        authenticated: false,
        providers: [password, oidc],
      },
    });

    const { unmount } = render(<AccountScreen mode="login" />);

    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit.className.split(/\s+/)).toContain("kin-btn");
    expect(submit.className.split(/\s+/)).toContain("kin-btn-primary");

    const federated = screen.getByRole("button", { name: "Continue with GitHub / Google" });
    expect(federated.className.split(/\s+/)).toContain("kin-btn");
    expect(federated.className.split(/\s+/)).toContain("kin-btn-secondary");
    expect(federated.className.split(/\s+/)).not.toContain("kin-btn-primary");

    unmount();

    // The invitation's escape hatch is a quiet inline action, not a second
    // filled or bordered button competing with "Join and sign in".
    render(<AccountScreen mode="join" />);

    const escape = screen.getByRole("button", { name: "Sign in" });
    expect(escape.className.split(/\s+/)).toContain("kin-btn");
    expect(escape.className.split(/\s+/)).not.toContain("kin-btn-primary");
    expect(escape.className.split(/\s+/)).not.toContain("kin-btn-secondary");
  });

  it("still submits the same claim call", async () => {
    useAppStore.setState({
      account: {
        ...NO_ACCOUNT,
        enabled: true,
        needsBootstrap: true,
        claimable: true,
        providers: [password],
      },
    });

    render(<AccountScreen mode="claim" />);

    fireEvent.change(screen.getByLabelText("Claim code"), { target: { value: "abcde23456" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: "secret123" },
    });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Owner" } });

    fireEvent.click(screen.getByRole("button", { name: "Claim and sign in" }));

    await waitFor(() => expect(claimOwner).toHaveBeenCalledTimes(1));
    expect(claimOwner).toHaveBeenCalledWith({
      code: "ABCDE-23456",
      email: "owner@example.com",
      password: "secret123",
      displayName: "Owner",
    });
  });
});

/**
 * KIN-RESULT-002 「登录」: a sign-in round trip comes back to the page the
 * reader was on.
 *
 * The provider owns the address bar for the length of the hop, so the page to
 * come back to travels as `return_to`. Sending only `pathname` loses the query
 * and the fragment along the way: a filtered list comes back unfiltered, and a
 * notification deep link to `#frag` lands at the top of the page instead.
 */
describe("returning after federated sign-in", () => {
  // Percent-encoded and in this order on purpose: a URL round trip would turn
  // `%20` into `+` and could reorder the parameters, and both are visible in
  // the address bar the person comes back to.
  const deepLink = "/tasks/t1?panel=files&file=a%20b.html#frag";

  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
    useAppStore.setState({
      account: {
        ...NO_ACCOUNT,
        enabled: true,
        authenticated: false,
        providers: [password, oidc],
      },
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ pendingAppSignIn: null });
    window.history.replaceState({}, "", "/");
  });

  it("sends federated sign-in back to the page with its query and fragment", () => {
    window.history.replaceState({}, "", deepLink);

    render(<AccountScreen mode="login" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub / Google" }));

    expect(vi.mocked(startOIDC)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startOIDC).mock.calls[0][1]).toBe(deepLink);
  });

  it("sends the app-flow sign-in back to the same full URL", () => {
    window.history.replaceState({}, "", deepLink);
    // A G8/G9 shell: the platform check plus every method the console calls
    // (the same shape `AccountSection.test.tsx` builds). The flow hands the
    // start URL to the system browser, so the return address has to survive
    // the hop through the provider and the shell.
    const scope = globalThis as { Capacitor?: unknown };
    const previous = scope.Capacitor;
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
      render(<AccountScreen mode="login" />);
      fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub / Google" }));

      expect(vi.mocked(startOIDC)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(startOIDC).mock.calls[0][1]).toBe(deepLink);
    } finally {
      scope.Capacitor = previous;
    }
  });
});
