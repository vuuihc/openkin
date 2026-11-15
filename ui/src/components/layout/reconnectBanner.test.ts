import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The reconnect strip is for a link that was lost, not for one being made.
 *
 * `wsStatus` is "connecting" from the moment the console starts until the
 * first answer arrives; the strip used to render for anything that was not
 * "connected", so every cold open began with "正在重连…" over a healthy
 * connection. This is a source assertion because the shell is too large to
 * mount for one boolean, and the mistake is a comparison, not a rendering.
 */
const SHELL = fileURLToPath(new URL("./AppShell.tsx", import.meta.url));

describe("reconnect strip", () => {
  it("is shown for a disconnected channel, not a connecting one", () => {
    const source = readFileSync(SHELL, "utf8");
    expect(source).toContain('wsStatus === "disconnected" && (');
    expect(source).not.toContain('wsStatus !== "connected" && (');
  });
});
