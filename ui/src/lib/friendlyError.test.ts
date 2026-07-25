import { describe, expect, it } from "vitest";
import { friendlyErrorLabel, isCancelNoise } from "./friendlyError";

const tr = (key: string) =>
  ({ "chat.canceled": "已取消", "chat.timedOut": "已超时" } as Record<string, string>)[
    key
  ] ?? key;

describe("friendlyErrorLabel", () => {
  it("maps cancel noise to canceled", () => {
    expect(friendlyErrorLabel("canceled", tr)).toBe("已取消");
    expect(
      friendlyErrorLabel(
        "stream error: stream ID 3; CANCEL; received from peer",
        tr,
      ),
    ).toBe("已取消");
    expect(friendlyErrorLabel("context canceled", tr)).toBe("已取消");
  });

  it("maps timeout tokens", () => {
    expect(friendlyErrorLabel("timed out", tr)).toBe("已超时");
    expect(friendlyErrorLabel("context deadline exceeded", tr)).toBe("已超时");
  });

  it("passes through other errors", () => {
    expect(friendlyErrorLabel("provider HTTP 500", tr)).toBe("provider HTTP 500");
  });
});

describe("isCancelNoise", () => {
  it("detects cancel tokens", () => {
    expect(isCancelNoise("canceled")).toBe(true);
    expect(isCancelNoise("context canceled")).toBe(true);
    expect(
      isCancelNoise("stream error: stream ID 3; CANCEL; received from peer"),
    ).toBe(true);
  });

  it("rejects real failures", () => {
    expect(isCancelNoise("provider HTTP 500")).toBe(false);
    expect(isCancelNoise("bash exited 1")).toBe(false);
    expect(isCancelNoise("")).toBe(false);
  });
});
