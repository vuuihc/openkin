// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { overlayOwnsKeyboard } from "./overlayOwnsKeyboard";

/**
 * KIN-CONTINUE-001: an overlay keeps the covered surface's shortcuts dead.
 *
 * The conversation's `j/k/a/d` and ⌘F handlers read this predicate, so the
 * roles listed here are the contract between the layers that open over a
 * session and the keys that session would otherwise answer. A new layer that
 * forgets one of these roles is a shortcut approving an approval nobody can
 * see.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

describe("overlayOwnsKeyboard", () => {
  it("leaves the keys to the page when nothing is floating", () => {
    const page = document.createElement("div");
    page.innerHTML = '<button type="button">plain control</button>';
    document.body.appendChild(page);
    expect(overlayOwnsKeyboard()).toBe(false);
  });

  it.each([
    ["dialog", '<div role="dialog" aria-label="Run settings"></div>'],
    ["alert dialog", '<div role="alertdialog" aria-label="Confirm"></div>'],
    ["menu", '<div role="menu" aria-label="Permission"></div>'],
    ["listbox", '<div role="listbox" aria-label="Model"></div>'],
    ["phone sheet layer", '<div data-sheet-layer><div role="listbox"></div></div>'],
  ])("claims the keys while a %s is open", (_name, markup) => {
    const layer = document.createElement("div");
    layer.innerHTML = markup;
    document.body.appendChild(layer);
    expect(overlayOwnsKeyboard()).toBe(true);
  });

  it("ignores a closed overlay host the framework leaves in the DOM", () => {
    // Ionic keeps a closed inline action sheet mounted as a role="dialog"
    // host. Treating it as open would kill every conversation shortcut below
    // md, where that host exists.
    const host = document.createElement("div");
    host.setAttribute("role", "dialog");
    host.style.display = "none";
    document.body.appendChild(host);
    expect(overlayOwnsKeyboard()).toBe(false);
  });

  it("ignores a menu inside a hidden, kept-alive pane", () => {
    // A session pane behind the tab strip stays mounted; its composer menu can
    // stay open in state while the pane is not drawn. The visible pane must
    // keep its keys.
    const pane = document.createElement("div");
    pane.setAttribute("aria-hidden", "true");
    pane.innerHTML = '<div role="listbox" aria-label="Mentions"></div>';
    document.body.appendChild(pane);
    expect(overlayOwnsKeyboard()).toBe(false);
  });

  it("ignores a layer hidden by its stylesheet state", () => {
    const pane = document.createElement("div");
    pane.style.visibility = "hidden";
    pane.innerHTML = "<div data-sheet-layer></div>";
    document.body.appendChild(pane);
    expect(overlayOwnsKeyboard()).toBe(false);
  });
});
