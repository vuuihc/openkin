import { describe, expect, it } from "vitest";
import { relayPrimaryAction, type RelayGuidanceInput } from "./RelayGuidance";

const ready: RelayGuidanceInput = {
  cloudflareAuthenticated: true,
  needsAccountRefresh: false,
  hasAccount: true,
  hasWorker: true,
  hasZone: true,
  hasCustomDomain: true,
  customDomainRecommended: false,
};

describe("relayPrimaryAction", () => {
  it("starts with Cloudflare connection", () => {
    expect(relayPrimaryAction({ ...ready, cloudflareAuthenticated: false })).toBe(
      "connect-cloudflare",
    );
  });

  it("refreshes accounts before deployment when authenticated but no account snapshot exists", () => {
    expect(relayPrimaryAction({ ...ready, needsAccountRefresh: true, hasAccount: false })).toBe(
      "refresh-accounts",
    );
  });

  it("waits for an account selection before making deploy primary", () => {
    expect(relayPrimaryAction({ ...ready, hasAccount: false })).toBeNull();
  });

  it("deploys the worker before custom domain binding", () => {
    expect(relayPrimaryAction({ ...ready, hasWorker: false })).toBe("deploy-worker");
  });

  it("binds a custom domain only after a worker, zone, and recommendation are available", () => {
    expect(
      relayPrimaryAction({
        ...ready,
        hasCustomDomain: false,
        customDomainRecommended: true,
      }),
    ).toBe("bind-domain");
    expect(
      relayPrimaryAction({
        ...ready,
        hasZone: false,
        hasCustomDomain: false,
        customDomainRecommended: true,
      }),
    ).toBeNull();
    expect(relayPrimaryAction({ ...ready, hasCustomDomain: false })).toBeNull();
  });

  it("has no primary action once relay prerequisites are complete", () => {
    expect(relayPrimaryAction(ready)).toBeNull();
  });
});
