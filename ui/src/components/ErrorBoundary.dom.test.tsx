// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

function Boom(): null {
  throw new Error("bad payload");
}

describe("ErrorBoundary", () => {
  // React reports a caught error through console.error; the assertions here
  // are about what is on screen, not about the log.
  afterEach(() => vi.restoreAllMocks());

  it("renders an explicitly empty fallback as nothing", () => {
    // The floating approval passes `null`: a card built from an agent-supplied
    // payload that cannot render must disappear, not replace itself with a
    // full-size panel over the screen it was floating on.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary fallback={null}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the recovery panel when no fallback is supplied", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("forgets a caught error when the reset key changes", () => {
    // The floating approval's outer boundary renders nothing on a throw and
    // has no Retry button to reach; without a reset key a single bad render
    // would hide every later approval for the rest of the session.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary fallback={null} resetKey="a">
        <Boom />
      </ErrorBoundary>,
    );
    expect(document.body.textContent).toBe("");

    rerender(
      <ErrorBoundary fallback={null} resetKey="b">
        <p>recovered</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("recovered")).toBeTruthy();
  });
});
