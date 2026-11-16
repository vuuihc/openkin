// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setLocale } from "../i18n";
import DesignSystemPage, { designSystemRoute } from "./DesignSystemPage";

/**
 * F4: the developer-only gallery at `/dev/components`.
 *
 * Two contracts live here. The first is absence: the production build must
 * register no such route, and the flag that decides it is a prop so the test
 * can prove that shape without touching `import.meta.env`. The second is the
 * gallery itself: every adopted control, every state the rules name, and one
 * real phone form and desktop form — not a screenshot or a code sample.
 *
 * React Router v6 rejects a component child inside `<Routes>`; a returned
 * `<Route>` or `null` is the supported conditional shape, so the helper below
 * mounts what `App` mounts: `{designSystemRoute(dev)}`.
 */

function renderAt(path: string, dev: boolean) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {designSystemRoute(dev)}
        <Route path="*" element={<p>fallback</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/dev/components"]}>
      <DesignSystemPage />
    </MemoryRouter>,
  );
}

function primitive(container: HTMLElement, name: string): HTMLElement {
  const section = container.querySelector<HTMLElement>(`[data-primitive="${name}"]`);
  if (!section) throw new Error(`missing gallery section: ${name}`);
  return section;
}

/** A narrow viewport: `SheetSelect` then renders the sheet form rather than the menu. */
function narrowViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  setLocale("en");
  window.history.replaceState({ idx: 0 }, "", "/dev/components");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the dev-only route", () => {
  it("registers no route when dev is false", () => {
    renderAt("/dev/components", false);
    expect(screen.getByText("fallback")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Design system gallery" })).toBeNull();
  });

  it("serves the gallery at /dev/components when dev is true", () => {
    renderAt("/dev/components", true);
    expect(screen.getByRole("heading", { name: "Design system gallery" })).toBeTruthy();
  });
});

describe("the gallery", () => {
  it("shows every primitive that exists today", () => {
    const { container } = renderPage();

    // Each section holds a live control, not an image or a code sample.
    expect(
      within(primitive(container, "ActionSheet")).getByRole("button", {
        name: "Open action sheet",
      }),
    ).toBeTruthy();
    expect(
      within(primitive(container, "PendingBadge")).getByText("12 waiting for you"),
    ).toBeTruthy();
    // SearchSelect renders one trigger per width; both are live instances.
    expect(
      within(primitive(container, "SearchSelect")).getAllByRole("button", { name: /^Model/ }),
    ).toHaveLength(2);
    expect(
      within(primitive(container, "SessionFilters")).getByRole("button", { name: /^Filter/ }),
    ).toBeTruthy();
    expect(
      within(primitive(container, "SheetSelect")).getByRole("button", { name: /^Role/ }),
    ).toBeTruthy();

    // The facade's other two shipped primitives are live here too.
    expect(
      within(primitive(container, "Button")).getByRole("button", { name: "Secondary action" }),
    ).toBeTruthy();
    expect(
      within(primitive(container, "Popover")).getByRole("button", { name: "Open popover" }),
    ).toBeTruthy();
  });

  it("shows the states the rules name", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    const states = primitive(container, "States");

    expect(states.querySelector('[data-state="default"] button')).toBeTruthy();
    // jsdom cannot apply :hover/:active, so the hover and pressed cases are
    // marked on wrappers with `data-state="hover"` / `data-state="pressed"`;
    // the control's own shipped classes draw the wash. This is the documented
    // hook for the later visual pass.
    expect(states.querySelector('[data-state="hover"] button')).toBeTruthy();
    expect(states.querySelector('[data-state="pressed"] button')).toBeTruthy();

    const disabled = within(states).getByRole("button", { name: "Disabled example" });
    expect(disabled.hasAttribute("disabled")).toBe(true);

    const loading = within(states).getByRole("button", { name: "Saving changes…" });
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.hasAttribute("disabled")).toBe(true);

    // The rules accept error text where a control has no error prop yet.
    expect(within(states).getByText("That name is already taken.")).toBeTruthy();

    // Focus is reached the way a keyboard reaches it, not by calling .focus().
    const focusTarget = within(states).getByRole("button", { name: "Focus me" });
    for (let step = 0; step < 80 && document.activeElement !== focusTarget; step += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(focusTarget);

    // IME: the searchable picker is a real text field with the shared guard.
    // The intermediate composition value must not commit a selection.
    const ime = states.querySelector<HTMLElement>('[data-gallery-control="ime-search"]');
    if (!ime) throw new Error("missing IME demo");
    const trigger = Array.from(ime.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-haspopup") === "listbox",
    );
    if (!trigger) throw new Error("missing IME trigger");
    await user.click(trigger);

    const field = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "na" } });
    // 229 is the sentinel an IME sends when `isComposing` has not flipped yet.
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(within(states).getByText("Selected: none")).toBeTruthy();
    expect(field.value).toBe("na");

    fireEvent.compositionEnd(field);
    expect(field.value).toBe("na");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(within(states).getByText("Selected: nano")).toBeTruthy();
  });

  it("keeps one phone form and one desktop form per control", async () => {
    const user = userEvent.setup();
    narrowViewport();
    const { container } = renderPage();

    const phone = container.querySelector<HTMLElement>(
      '[data-form="phone"][data-gallery-control="sheet-select-phone"]',
    );
    const desktop = container.querySelector<HTMLElement>(
      '[data-form="desktop"][data-gallery-control="search-select-desktop"]',
    );
    if (!phone || !desktop) throw new Error("missing phone or desktop form");

    // The phone form is the phone component: the chip opens the action sheet.
    const phoneChip = within(phone).getByRole("button", { name: /^Role/ });
    expect(phoneChip.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(phoneChip);
    expect(screen.getByRole("dialog", { name: "Role" })).toBeTruthy();

    // The desktop form is the anchored listbox, not the sheet in a wider box.
    const desktopChip = within(desktop)
      .getAllByRole("button", { name: /^Model/ })
      .find((button) => button.getAttribute("aria-haspopup") === "listbox");
    expect(desktopChip).toBeTruthy();
  });

  it("every visible control is reachable by keyboard", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    const controls = Array.from(
      container.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled])",
      ),
    );
    expect(controls.length).toBeGreaterThan(10);

    const reached: HTMLElement[] = [];
    for (let step = 0; step < controls.length; step += 1) {
      await user.tab();
      reached.push(document.activeElement as HTMLElement);
    }
    // Every control is a tab stop, in document order: no tabIndex={-1} on a
    // visible control and no aria-hidden wrapper around a focusable one.
    expect(reached).toEqual(controls);
  });
});
