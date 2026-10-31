// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
