import { describe, expect, it, vi } from "vitest";
import { hubAnswers, hubBootPlan } from "./hubBoot";

const LOCAL = "capacitor://localhost/";
const HUB = "https://hub.example.com";

describe("hubBootPlan", () => {
  it("leaves a browser alone", () => {
    expect(
      hubBootPlan({ inShell: false, storedUrl: HUB, here: "https://console.example.com/" }),
    ).toEqual({ kind: "stay" });
  });

  it("leaves a first-run shell on the bundled console", () => {
    expect(hubBootPlan({ inShell: true, storedUrl: "", here: LOCAL })).toEqual({ kind: "stay" });
    expect(hubBootPlan({ inShell: true, storedUrl: "   ", here: LOCAL })).toEqual({
      kind: "stay",
    });
  });

  it("moves a shell from the bundled console to the stored Hub", () => {
    expect(hubBootPlan({ inShell: true, storedUrl: HUB, here: LOCAL })).toEqual({
      kind: "navigate",
      url: HUB,
    });
  });

  it("keeps the stored path, not just the origin", () => {
    expect(hubBootPlan({ inShell: true, storedUrl: `${HUB}/kin`, here: LOCAL })).toEqual({
      kind: "navigate",
      url: `${HUB}/kin`,
    });
  });

  it("does not reload when the webview is already on that Hub", () => {
    expect(hubBootPlan({ inShell: true, storedUrl: HUB, here: `${HUB}/sessions` })).toEqual({
      kind: "stay",
    });
    // The port is part of the origin: 443 is the same Hub, :8443 is not.
    expect(
      hubBootPlan({ inShell: true, storedUrl: "https://hub.example.com:443", here: HUB }),
    ).toEqual({ kind: "stay" });
    expect(
      hubBootPlan({ inShell: true, storedUrl: "https://hub.example.com:8443", here: HUB }),
    ).toEqual({ kind: "navigate", url: "https://hub.example.com:8443" });
  });

  it("does not spend a sign-in link, pairing secret or claim code", () => {
    for (const here of [
      `${LOCAL}?token=abc`,
      `${LOCAL}?pairing=1&token=abc`,
      `${LOCAL}#login=abc`,
      `${LOCAL}#claim=abc`,
    ]) {
      expect(hubBootPlan({ inShell: true, storedUrl: HUB, here })).toEqual({ kind: "stay" });
    }
  });

  it("ignores a stored value that is not an address", () => {
    expect(hubBootPlan({ inShell: true, storedUrl: "not a url", here: LOCAL })).toEqual({
      kind: "stay",
    });
  });
});

describe("hubAnswers", () => {
  it("treats any response as reachable", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 405 }));
    await expect(hubAnswers(HUB, { fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      HUB,
      expect.objectContaining({ method: "HEAD", mode: "no-cors" }),
    );
  });

  it("treats a network failure as unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network error");
    });
    await expect(hubAnswers(HUB, { fetchImpl })).resolves.toBe(false);
  });
});
