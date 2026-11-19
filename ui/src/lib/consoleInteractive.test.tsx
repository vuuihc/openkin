// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleReady, markConsoleInteractive } from "./consoleInteractive";
import type { KinDesktopAPI } from "./desktop";

/**
 * The console says "I am on screen" through the optional desktop bridge. The
 * shell, not the document, decides what that is worth: this side only has to
 * report after the first commit, stay quiet in a plain browser, and never let
 * a broken bridge take the console down.
 */

function bridge(mark: () => void): KinDesktopAPI {
  // Only the fields this component touches; the rest of the surface belongs to
  // other features and is irrelevant to the mark.
  return {
    isDesktop: true,
    platform: "darwin",
    selectDirectory: async () => null,
    markConsoleInteractive: mark,
  };
}

afterEach(() => {
  delete (window as { kinDesktop?: KinDesktopAPI }).kinDesktop;
});

describe("ConsoleReady", () => {
  it("does nothing outside the desktop shell", () => {
    expect(() => render(<ConsoleReady />)).not.toThrow();
    expect(() => markConsoleInteractive()).not.toThrow();
    expect(screen.queryByText("console")).toBeNull();
  });

  it("marks once, after the first commit", () => {
    const order: string[] = [];
    const mark = vi.fn(() => {
      order.push("mark");
    });
    window.kinDesktop = bridge(mark);

    render(
      <>
        <ConsoleReady />
        <Probe onRender={() => order.push("render")} />
        <span>console</span>
      </>,
    );

    // The effect runs after the tree committed: a call made during render
    // would push "mark" before the sibling's render.
    expect(order).toEqual(["render", "mark"]);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(screen.getByText("console")).toBeTruthy();
  });

  it("a throwing bridge never breaks the console", () => {
    const mark = vi.fn(() => {
      throw new Error("bridge is gone");
    });
    window.kinDesktop = bridge(mark);

    render(
      <>
        <ConsoleReady />
        <span>console</span>
      </>,
    );

    expect(mark).toHaveBeenCalledTimes(1);
    expect(screen.getByText("console")).toBeTruthy();
    expect(() => markConsoleInteractive()).not.toThrow();
  });
});

function Probe({ onRender }: { onRender: () => void }): null {
  onRender();
  return null;
}
