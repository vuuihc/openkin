// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionsHeader from "./SessionsHeader";
import { setLocale } from "../../i18n";

/**
 * KIN-CONTINUE-004: the phone header's search is a magnifier until it is
 * needed.
 *
 * The field itself is still `SessionsSearch` writing `?search=`: this suite
 * pins the disclosure around it, not a second search control. A query is a
 * filter that is on screen, so it cannot be folded away; Escape clears the
 * word first and only then puts the field away, returning focus to the
 * magnifier rather than dropping it to the top of the page.
 */

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function header(path = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionsHeader />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function magnifier(): HTMLElement {
  return screen.getByRole("button", { name: "Search chats" });
}

beforeEach(() => {
  setLocale("en");
});

describe("the phone header's search magnifier", () => {
  it("keeps the search field collapsed until the magnifier is pressed", () => {
    header();

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the same SessionsSearch field and focuses it", async () => {
    header();

    await userEvent.click(magnifier());

    const field = screen.getByRole("searchbox");
    // The opener points at the field's own container, not at a second control.
    const panel = document.getElementById(magnifier().getAttribute("aria-controls") ?? "");
    expect(panel).toBeTruthy();
    expect(panel?.contains(field)).toBe(true);
    expect(magnifier().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(field);
  });

  it("keeps the field open while a query exists", async () => {
    header("/sessions?search=week");

    const field = screen.getByRole("searchbox") as HTMLInputElement;
    expect(field.value).toBe("week");
    expect(magnifier().getAttribute("aria-expanded")).toBe("true");

    // Clearing the word is not asking to leave the search.
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).not.toContain("search="),
    );
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("clears on Escape before it closes", async () => {
    header("/sessions?search=week");

    await userEvent.click(screen.getByRole("searchbox"));
    await userEvent.keyboard("{Escape}");

    // The first Escape removes the filter; the field stays so the reader can
    // see the list it now shows.
    expect(screen.getByTestId("location").textContent).not.toContain("search=");
    expect(screen.getByRole("searchbox")).toBeTruthy();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(document.activeElement).toBe(magnifier());
  });

  it("reports aria-expanded on the magnifier", async () => {
    header();

    // The magnifier is a finger-sized control in the icon slot.
    expect(magnifier().className).toContain("h-11");
    expect(magnifier().className).toContain("w-11");

    await userEvent.click(magnifier());
    expect(magnifier().getAttribute("aria-expanded")).toBe("true");

    await userEvent.keyboard("{Escape}");
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
  });
});
