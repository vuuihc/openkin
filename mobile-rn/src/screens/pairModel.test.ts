import { describe, expect, it } from "@jest/globals";
import en from "../../../ui/src/i18n/locales/en";
import zh from "../../../ui/src/i18n/locales/zh";
import type { AppState, PairingReason } from "../auth/pairing";
import { t } from "../i18n";
import { bootHref, pairView } from "./pairModel";

/**
 * KIN-MOBILE-001 R2b — the pairing screen's pure view-model.
 *
 * The screen itself is a thin renderer over these functions, so every sentence
 * choice and every enabled state is proven here without a renderer (ADR 0036
 * §3 keeps component tests for R3).
 */

function lookup(tree: unknown, path: string): string | undefined {
  let current: unknown = tree;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function state(route: AppState["route"], reason: PairingReason): AppState {
  return { route, reason, origin: null, tasks: [], display: null };
}

const reasons = ["none", "expired", "rejected", "unreachable"] as const;

describe("KIN-MOBILE-001 R2b pairing view-model", () => {
  it("KIN-MOBILE-001 R2b: an unpaired boot offers the pairing entry and one primary action", () => {
    const fresh = pairView(state("pairing", "none"), { busy: false, typed: "" });

    expect(fresh.headingKey).toBe("pairing.title");
    expect(fresh.bodyKey).toBeNull();
    expect(fresh.actionKey).toBe("pairing.submit");
    expect(fresh.landing).toBeNull();
    // Nothing typed yet: the one primary action is present but not enabled.
    expect(fresh.canSubmit).toBe(false);

    const typed = pairView(state("pairing", "none"), {
      busy: false,
      typed: "https://kin.example.com/?token=fixture-token-not-real",
    });
    expect(typed.canSubmit).toBe(true);
    expect(typed.landing).toBeNull();
  });

  it("KIN-MOBILE-001 R2b: each pairing failure keeps the typed link and names its own reason", () => {
    const failures = (["expired", "rejected", "unreachable"] as const).map(
      (reason) => pairView(state("pairing", reason), { busy: false, typed: "kept" }),
    );

    for (const view of failures) {
      expect(view.landing).toBeNull();
      expect(view.bodyKey).not.toBeNull();
      // The model has no instruction to drop the typed text; the screen keeps it
      // so a retry needs no retyping.
      expect(Object.keys(view).sort()).toEqual(
        ["actionKey", "bodyKey", "canSubmit", "headingKey", "landing"].sort(),
      );
    }

    const keys = failures.map((view) => view.bodyKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key).not.toBeNull();
      if (key === null) continue;
      expect(lookup(zh, key)).toBeDefined();
      expect(lookup(en, key)).toBeDefined();
    }
  });

  it("KIN-MOBILE-001 R2b: a submit in flight disables the action and says it is connecting", () => {
    const busy = pairView(state("pairing", "none"), {
      busy: true,
      typed: "https://kin.example.com/?token=fixture-token-not-real",
    });

    expect(busy.canSubmit).toBe(false);
    expect(busy.actionKey).toBe("pairing.connecting");

    const empty = pairView(state("pairing", "none"), { busy: false, typed: "   " });
    expect(empty.canSubmit).toBe(false);
  });

  it("KIN-MOBILE-001 R2b: a paired state lands on the list route and an unpaired one on pairing", () => {
    expect(bootHref(state("list", "none"))).toBe("/list");
    expect(bootHref(state("pairing", "none"))).toBe("/pair");
    // An expired token is not a fresh entry: the pairing screen must render
    // its reason sentence on the first frame, so the href carries it.
    expect(bootHref(state("pairing", "expired"))).toBe("/pair?reason=expired");
    expect(bootHref(state("pairing", "rejected"))).toBe("/pair");

    expect(pairView(state("list", "none"), { busy: false, typed: "" }).landing).toBe(
      "/list",
    );
  });

  it("KIN-MOBILE-001 R2b: every key the pairing screen can render exists in both catalogs", () => {
    const keys = new Set<string>();

    for (const reason of reasons) {
      for (const busy of [false, true]) {
        const view = pairView(state("pairing", reason), { busy, typed: "kept" });
        keys.add(view.headingKey);
        keys.add(view.actionKey);
        if (view.bodyKey !== null) keys.add(view.bodyKey);
      }
    }

    for (const key of keys) {
      for (const [locale, catalog] of [
        ["zh", zh],
        ["en", en],
      ] as const) {
        const value = lookup(catalog, key);
        // `t()` falls back to the dotted path, so a missing key is a visible
        // row that reads `pairing.expired`; both checks below catch it.
        expect({ key, locale, value }).toEqual({
          key,
          locale,
          value: expect.any(String),
        });
        expect({ key, locale, blank: value?.trim() === "" }).toEqual({
          key,
          locale,
          blank: false,
        });
        expect({ key, locale, isPath: value === key }).toEqual({
          key,
          locale,
          isPath: false,
        });
      }
    }
  });

  it("KIN-MOBILE-001 R2b: the adapter interpolates the device origin into a sentence", () => {
    const connected = t("pairing.connected", { origin: "kin.example.com" });

    expect(connected).toContain("kin.example.com");
    expect(connected).not.toContain("{");
    expect(connected).not.toContain("}");

    // The same fallback the web layer uses: an unknown dotted path reads as
    // itself rather than throwing or rendering nothing.
    expect(t("pairing.doesNotExist")).toBe("pairing.doesNotExist");
  });
});
