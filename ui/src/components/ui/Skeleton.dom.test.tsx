// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageListSkeleton, SessionListSkeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("renders a geometry-matched SessionListSkeleton with accessible loading status", () => {
    render(<SessionListSkeleton shell="page" label="Loading sessions…" />);

    const status = screen.getByTestId("session-list-skeleton");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading sessions…")).toBeTruthy();
    expect(status.querySelectorAll(".kin-skeleton").length).toBeGreaterThanOrEqual(6);
    expect(status.innerHTML).toContain("px-4");
  });

  it("uses compact sidebar gutters and indent for sidebar SessionListSkeleton", () => {
    render(<SessionListSkeleton shell="sidebar" label="Loading sessions…" />);

    const status = screen.getByTestId("session-list-skeleton");
    expect(status.innerHTML).toContain("px-2");
    expect(status.innerHTML).toContain("pl-4");
  });

  it("renders requested row count in PageListSkeleton with accessible label", () => {
    render(<PageListSkeleton rows={3} label="Loading…" />);

    const status = screen.getByTestId("page-list-skeleton");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(status.children).toHaveLength(4);
  });
});
