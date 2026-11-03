// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
