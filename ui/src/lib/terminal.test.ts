import { describe, it, expect } from "vitest";
import {
  isTerminalToggle,
  clampTerminalHeight,
  effectiveTerminalCwd,
  maxTerminalHeight,
  parseTerminalHeight,
  contextCwd,
  terminalSocketURL,
  MIN_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_HEIGHT,
  MAX_TERMINAL_VIEWPORT_RATIO,
} from "./terminal";

// Create test helper to construct KeyboardEvent-like objects for testing
// without requiring jsdom.
function makeKeyboardEvent(
  code: string,
  options: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; repeat?: boolean } = {},
): Partial<KeyboardEvent> {
  return {
    code,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    repeat: options.repeat ?? false,
  } as Partial<KeyboardEvent>;
}

describe("isTerminalToggle", () => {
  it("accepts non-repeating Ctrl+Backquote", () => {
    const e = makeKeyboardEvent("Backquote", { ctrlKey: true, repeat: false });
    expect(isTerminalToggle(e as KeyboardEvent)).toBe(true);
  });

  it("rejects Meta+Backquote (macOS Cmd+` is the OS window-cycle shortcut)", () => {
    const e = makeKeyboardEvent("Backquote", { metaKey: true, repeat: false });
    expect(isTerminalToggle(e as KeyboardEvent)).toBe(false);
  });

  it("rejects repeating Ctrl+Backquote", () => {
    const e = makeKeyboardEvent("Backquote", { ctrlKey: true, repeat: true });
    expect(isTerminalToggle(e as KeyboardEvent)).toBe(false);
  });

  it("rejects plain Backquote without Ctrl", () => {
    const e = makeKeyboardEvent("Backquote", { ctrlKey: false, metaKey: false, repeat: false });
    expect(isTerminalToggle(e as KeyboardEvent)).toBe(false);
  });

  it("rejects Ctrl+other keys", () => {
    const e = makeKeyboardEvent("KeyA", { ctrlKey: true, repeat: false });
    expect(isTerminalToggle(e as KeyboardEvent)).toBe(false);
  });

  it("accepts Shift+Ctrl+Backquote (code is Backquote, code is authoritative)", () => {
    // When user presses Shift+Ctrl+Backquote, the code is still "Backquote"
    // and both ctrl and shift are set. This should still be accepted because
    // code is authoritative, not key.
    const e = makeKeyboardEvent("Backquote", {
      ctrlKey: true,
      shiftKey: true,
      repeat: false,
    });
    expect(isTerminalToggle(e as KeyboardEvent)).toBe(true);
  });

  it("rejects repeated key events", () => {
    const e = makeKeyboardEvent("Backquote", {
      ctrlKey: true,
      repeat: true,
    });
    expect(isTerminalToggle(e as KeyboardEvent)).toBe(false);
  });
});

describe("parseTerminalHeight", () => {
  const viewportHeight = 1000;

  it("returns DEFAULT_TERMINAL_HEIGHT when storage is empty", () => {
    const result = parseTerminalHeight(null, viewportHeight);
    expect(result).toBe(DEFAULT_TERMINAL_HEIGHT);
  });

  it("clamps to MIN_TERMINAL_HEIGHT when parsed value is too small", () => {
    const result = parseTerminalHeight("100", viewportHeight);
    expect(result).toBe(MIN_TERMINAL_HEIGHT);
  });

  it("clamps to 70% of viewport when parsed value is too large", () => {
    const max = Math.floor(viewportHeight * MAX_TERMINAL_VIEWPORT_RATIO);
    const result = parseTerminalHeight("9999", viewportHeight);
    expect(result).toBe(max);
  });

  it("returns parsed value when it is within bounds", () => {
    const result = parseTerminalHeight("300", viewportHeight);
    expect(result).toBe(300);
  });

  it("handles invalid storage values gracefully", () => {
    const result = parseTerminalHeight("not-a-number", viewportHeight);
    expect(result).toBe(DEFAULT_TERMINAL_HEIGHT);
  });

  it("handles empty string gracefully", () => {
    const result = parseTerminalHeight("", viewportHeight);
    expect(result).toBe(DEFAULT_TERMINAL_HEIGHT);
  });

  it("rejects partially numeric storage values", () => {
    expect(parseTerminalHeight("300px", viewportHeight)).toBe(
      DEFAULT_TERMINAL_HEIGHT,
    );
  });

  it("keeps the minimum usable height in a very short viewport", () => {
    expect(maxTerminalHeight(200)).toBe(MIN_TERMINAL_HEIGHT);
    expect(clampTerminalHeight(20, 200)).toBe(MIN_TERMINAL_HEIGHT);
  });
});

describe("contextCwd", () => {
  it("prefers selected task cwd when available", () => {
    const result = contextCwd("/task/cwd", "/draft/cwd");
    expect(result).toBe("/task/cwd");
  });

  it("falls back to draft cwd when task cwd is undefined", () => {
    const result = contextCwd(undefined, "/draft/cwd");
    expect(result).toBe("/draft/cwd");
  });

  it("returns empty string when both are empty", () => {
    const result = contextCwd(undefined, "");
    expect(result).toBe("");
  });

  it("returns draft cwd when task cwd is undefined, even if it's empty", () => {
    const result = contextCwd(undefined, "");
    expect(result).toBe("");
  });
});

describe("effectiveTerminalCwd", () => {
  it("prefers a later route cwd over a panel-only folder choice", () => {
    expect(effectiveTerminalCwd("/task", "/picked")).toBe("/task");
  });

  it("uses the panel override while the route has no cwd", () => {
    expect(effectiveTerminalCwd("", "/picked")).toBe("/picked");
  });
});

describe("terminalSocketURL", () => {
  it("builds ws:// URL for HTTP protocol", () => {
    const url = terminalSocketURL("http:", "localhost:3000", "sess123", "token456");
    expect(url).toContain("ws://");
    expect(url).toContain("localhost:3000");
    expect(url).toContain("sess123");
    expect(url).toContain("token456");
  });

  it("builds wss:// URL for HTTPS protocol", () => {
    const url = terminalSocketURL("https:", "example.com", "sess123", "token456");
    expect(url).toContain("wss://");
    expect(url).toContain("example.com");
  });

  it("URL-encodes session ID", () => {
    const url = terminalSocketURL("http:", "localhost:3000", "sess/123", "token");
    expect(url).toContain("sess%2F123");
  });

  it("URL-encodes token", () => {
    const url = terminalSocketURL("http:", "localhost:3000", "sess", "tok+en=456");
    expect(url).toContain("tok%2Ben%3D456");
  });

  it("builds correct URL structure", () => {
    const url = terminalSocketURL(
      "http:",
      "localhost:3000",
      "mySessionId",
      "myToken123",
    );
    expect(url).toMatch(
      /^ws:\/\/localhost:3000\/api\/terminal\/sessions\/mySessionId\/ws\?token=myToken123$/,
    );
  });
});
