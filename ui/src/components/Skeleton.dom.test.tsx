// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageListSkeleton, SessionListSkeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("renders a geometry-matched SessionListSkeleton with accessible loading status", () => {
    render(<SessionListSkeleton shell="page" label="Loading sessions…" />);

    const status = screen.getByRole("status", { name: "Loading sessions…" });
    expect(status.getAttribute("data-testid")).toBe("session-list-skeleton");
    expect(status.hasAttribute("aria-busy")).toBe(false);
    expect(status.querySelectorAll(".kin-skeleton").length).toBeGreaterThanOrEqual(6);
    expect(status.querySelector(".px-4")).toBeTruthy();
  });

  it("uses compact sidebar gutters and indent for sidebar SessionListSkeleton", () => {
    render(<SessionListSkeleton shell="sidebar" label="Loading sessions…" />);

    const status = screen.getByRole("status", { name: "Loading sessions…" });
    expect(status.querySelector(".px-2")).toBeTruthy();
    expect(status.querySelector(".pl-4")).toBeTruthy();
  });

  it("renders card rows by default in PageListSkeleton with accessible status role", () => {
    render(<PageListSkeleton rows={3} label="Loading routines…" />);

    const status = screen.getByRole("status", { name: "Loading routines…" });
    expect(status.getAttribute("data-testid")).toBe("page-list-skeleton");
    expect(status.hasAttribute("aria-busy")).toBe(false);
    expect(status.children).toHaveLength(3);
    expect(status.querySelectorAll(".kin-skeleton-card")).toHaveLength(3);
  });

  it("renders flat borderless rows for variant='rows' without card wrappers", () => {
    render(<PageListSkeleton variant="rows" rows={4} label="Loading projects…" />);

    const status = screen.getByRole("status", { name: "Loading projects…" });
    expect(status.children).toHaveLength(4);
    expect(status.querySelectorAll(".kin-skeleton-card")).toHaveLength(0);
    expect(status.querySelectorAll(".min-h-11")).toHaveLength(4);
  });
});
