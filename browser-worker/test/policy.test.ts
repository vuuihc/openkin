import { describe, expect, it } from "vitest";
import {
  assertActionAllowed,
  assertAllowedURL,
  isPrivateHost,
  requiresApproval,
  sanitizeActionForEvidence,
  type BrowserPolicyConfig,
} from "../src/policy.js";

const config: BrowserPolicyConfig = {
  allowed_domains: ["example.com"],
  download_dir: "/tmp/downloads",
  upload_dir: "/tmp/uploads",
  max_download_bytes: 1000,
  require_approval_for_side_effects: true,
};

describe("browser policy", () => {
  it("allows exact and subdomains but rejects lookalikes", () => {
    expect(assertAllowedURL("https://example.com/a", config.allowed_domains).hostname).toBe(
      "example.com",
    );
    expect(assertAllowedURL("https://app.example.com/a", config.allowed_domains).hostname).toBe(
      "app.example.com",
    );
    expect(() => assertAllowedURL("https://example.com.evil.test", config.allowed_domains)).toThrow();
  });

  it("requires approval for declared side effects", () => {
    const action = { type: "click", selector: "#send", side_effect: true } as const;
    expect(() => assertActionAllowed(action, config)).not.toThrow();
    expect(requiresApproval(action, config)).toBe(true);
    expect(requiresApproval({ type: "click", selector: "#read" }, config)).toBe(true);
    expect(requiresApproval({
      type: "upload",
      selector: "#file",
      path: "/tmp/uploads/report.pdf",
    }, config)).toBe(true);
    expect(requiresApproval({
      type: "download",
      url: "https://example.com/report",
      filename: "report.pdf",
      sensitive: true,
    }, config)).toBe(true);
  });

  it("rejects runtime actions outside the typed protocol", () => {
    expect(() => assertActionAllowed({ type: "shell" } as never, config)).toThrow(
      "unsupported browser action",
    );
  });

  it("blocks private and link-local destinations", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.20")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });

  it("does not put fill values or upload paths into evidence", () => {
    expect(sanitizeActionForEvidence({
      type: "fill",
      selector: "#password",
      value: "secret-value",
      sensitive: true,
    })).toEqual({ type: "fill", selector: "#password", sensitive: true });
    expect(sanitizeActionForEvidence({
      type: "upload",
      selector: "#file",
      path: "/private/secret.pdf",
      sensitive: true,
    })).toEqual({ type: "upload", selector: "#file", sensitive: true });
  });
});
