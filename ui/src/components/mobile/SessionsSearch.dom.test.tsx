// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionsSearch from "./SessionsSearch";
import { setLocale } from "../../i18n";

/**
 * The page's own search pill, bound to `?search=`.
 *
 * The list is mounted on `/new` and beside an open conversation, so its param
 * must not be the composer's `q` or the transcript's `find`: both belong to a
 * neighbour and are consumed there. This suite pins the pill's own half of
 * that contract without mounting the page around it.
 */

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function pill() {
  return (
    <MemoryRouter initialEntries={["/sessions?q=draft&find=seed"]}>
      <SessionsSearch />
      <LocationProbe />
    </MemoryRouter>
  );
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

beforeEach(() => {
  setLocale("en");
});

describe("the phone search pill", () => {
  it("keeps its query in `search`, not in a neighbour's param", async () => {
    render(pill());

    await userEvent.type(screen.getByRole("searchbox"), "alpha");

    await waitFor(() => expect(locationText()).toContain("search=alpha"));
    // Both neighbours survive: rebuilding the search string from scratch
    // would delete the composer's prefill and the transcript's find seed.
    expect(locationText()).toContain("q=draft");
    expect(locationText()).toContain("find=seed");
  });

  it("clears the param with the clear button", async () => {
    render(pill());

    await userEvent.type(screen.getByRole("searchbox"), "alpha");
    await waitFor(() => expect(locationText()).toContain("search=alpha"));

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(locationText()).not.toContain("search="));
    expect(locationText()).toContain("q=draft");
    expect(locationText()).toContain("find=seed");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });
});
