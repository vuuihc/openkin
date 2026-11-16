// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { setLocale } from "../../i18n";
import PendingBadge from "./PendingBadge";

/**
 * The row's waiting mark: a count for the eye, a sentence for a screen reader,
 * and no button semantics — the conversation row is the only click target.
 */
describe("PendingBadge", () => {
  it("draws nothing when nothing waits", () => {
    setLocale("en");
    const { container } = render(<PendingBadge count={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("caps the visible number but keeps the real count in its name", () => {
    setLocale("en");
    render(<PendingBadge count={12} />);
    expect(screen.getByText("9+")).toBeTruthy();
    expect(screen.getByText("12 waiting for you")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
