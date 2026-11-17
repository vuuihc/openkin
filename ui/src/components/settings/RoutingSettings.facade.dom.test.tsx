// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale, t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { RoutingDefaultsSection, RoutingProfilesSection } from "./RoutingSettings";

/**
 * What Settings → Routing's actions are made of.
 *
 * The profile/phase editor, the wait/ask/switch and fallback semantics, the
 * dirty baseline and the leave guard have their own tests; these assertions are
 * about the control family. Every action must be the shared Button so the focus
 * ring, the disabled treatment and the phone floor come from one place, and the
 * only element still allowed to be a raw `<button>` is the two-state phase chip,
 * whose 24px shape the facade does not draw.
 */

const api = vi.hoisted(() => ({
  defaults: vi.fn(),
  updateDefaults: vi.fn(),
  options: vi.fn(),
  profiles: vi.fn(),
  updateProfiles: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    getRoutingDefaults: api.defaults,
    getRoutingOptions: api.options,
    getRoutingProfiles: api.profiles,
    updateRoutingDefaults: api.updateDefaults,
    updateRoutingProfiles: api.updateProfiles,
  };
});

const loaded = {
  enabled: true,
  default_team: "",
  objective: "balanced",
  max_attempts_per_step: 3,
  terminal_limit_policy: "ask",
  manual_fallback: false,
  quality_floor: "",
  force_phases: [],
};

const profile = {
  id: "team-a",
  name: "Team A",
  alias: "A",
  enabled: true,
  phases: {
    plan: { agent: "claude-code", tier: "balanced", provider_priority: [], fallback: [] },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  setLocale("en");
  useAppStore.setState({ reconnectGen: 0 });
  api.defaults.mockReset();
  api.updateDefaults.mockReset();
  api.options.mockReset();
  api.profiles.mockReset();
  api.updateProfiles.mockReset();
  api.defaults.mockResolvedValue(loaded);
  api.options.mockResolvedValue({ teams: [] });
  api.profiles.mockResolvedValue({ profiles: [profile] });
  api.updateProfiles.mockResolvedValue({ profiles: [] });
  api.updateDefaults.mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
});

describe("routing fields on the shared TextInput", () => {
  it("draws every routing text field with the shared TextInput", async () => {
    const user = userEvent.setup();
    render(
      <>
        <RoutingDefaultsSection />
        <RoutingProfilesSection />
      </>,
    );
    // The profile editor is where five of the seven fields live.
    await user.click(await screen.findByRole("button", { name: "Edit" }));

    const keys = [
      "settings.routing.maxAttempts",
      "settings.routing.profileId",
      "settings.routing.profileName",
      "settings.routing.alias",
      "settings.routing.agent",
      "settings.routing.providerPriority",
      "settings.routing.fallback",
    ] as const;

    for (const key of keys) {
      const field = screen.getByLabelText(t(key));
      // The shared field's two guarantees: `.kin-input` sits on the native
      // input (the stylesheet's visual contract) and the label reaches it by
      // `htmlFor`, never by wrapping it in a `<label>`.
      expect(field).toBeInstanceOf(HTMLInputElement);
      expect(field.classList.contains("kin-input")).toBe(true);
      expect(field.closest("label")).toBeNull();
    }
  });
});

describe("routing actions on the shared Button", () => {
  it("routes every routing action through the shared Button", async () => {
    const user = userEvent.setup();
    render(
      <>
        <RoutingDefaultsSection />
        <RoutingProfilesSection />
      </>,
    );

    // Filled: each half's one primary.
    const saveDefaults = await screen.findByRole("button", { name: "Save routing defaults" });
    const add = await screen.findByRole("button", { name: "Add profile" });
    const edit = await screen.findByRole("button", { name: "Edit" });
    const removeProfile = screen.getByRole("button", { name: "Delete" });
    expect(saveDefaults.className).toContain("kin-btn-primary");
    for (const button of [add, edit, removeProfile]) {
      expect(button.className).toContain("kin-btn-secondary");
    }

    await user.click(edit);
    const saveProfile = await screen.findByRole("button", { name: "Save profile" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const removePhase = screen.getByRole("button", { name: "remove" });
    expect(saveProfile.className).toContain("kin-btn-primary");
    expect(cancel.className).toContain("kin-btn-secondary");

    // Quiet: the phase row's destructive link-shaped action carries no
    // `kin-btn-*` variant, only the facade's base class and red ink.
    expect(removePhase.className).toContain("kin-btn");
    expect(removePhase.className).not.toMatch(/kin-btn-(primary|secondary|approve|deny)/);
    expect(removePhase.className).toContain("text-kin-red-ink");
    expect(removePhase.className).toContain("text-micro");
  });

  it("leaves exactly one raw button in the file, the phase chip", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/settings/RoutingSettings.tsx"),
      "utf8",
    );

    // The ratchet: a future hand-written copy that looks right still fails.
    expect(source.match(/<button\b/g) ?? []).toHaveLength(1);

    // And the one that remains is the add-vs-added phase chip, still inside
    // the phase map rather than promoted to the facade.
    const at = source.indexOf("<button");
    expect(source.slice(Math.max(0, at - 400), at + 800)).toContain("addPhase(phase)");
    expect(source).toContain('["plan", "execute", "review", "chat"] as const');
  });

  it("keeps a routing save disabled and labelled while it is in flight", async () => {
    const user = userEvent.setup();
    const pendingDefaults = deferred<void>();
    api.updateDefaults.mockReturnValue(pendingDefaults.promise);

    render(<RoutingDefaultsSection />);
    const save = await screen.findByRole("button", { name: "Save routing defaults" });
    await user.click(save);
    expect(api.updateDefaults).toHaveBeenCalledTimes(1);

    const saving = screen.getByRole("button", { name: "Saving…" });
    expect(saving.hasAttribute("disabled")).toBe(true);
    await user.click(saving);
    expect(api.updateDefaults).toHaveBeenCalledTimes(1);

    await act(async () => pendingDefaults.resolve());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save routing defaults" })).toBeTruthy(),
    );
  });

  it("keeps a profile save disabled and labelled while it is in flight", async () => {
    const user = userEvent.setup();
    const pendingProfiles = deferred<{ profiles: (typeof profile)[] }>();
    api.updateProfiles.mockReturnValue(pendingProfiles.promise);

    render(<RoutingProfilesSection />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(api.updateProfiles).toHaveBeenCalledTimes(1);

    const saving = screen.getByRole("button", { name: "Saving…" });
    expect(saving.hasAttribute("disabled")).toBe(true);
    await user.click(saving);
    expect(api.updateProfiles).toHaveBeenCalledTimes(1);

    await act(async () => pendingProfiles.resolve({ profiles: [profile] }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull());
  });

  it("keeps profile delete behind its confirm and destructive", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<RoutingProfilesSection />);

    const remove = await screen.findByRole("button", { name: "Delete" });
    expect(remove.className).toContain("kin-btn-secondary");
    expect(remove.className).toContain("text-kin-red-ink");

    await user.click(remove);
    expect(confirm).toHaveBeenCalledWith("Remove this profile?");
    expect(api.updateProfiles).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(remove);
    await waitFor(() => expect(api.updateProfiles).toHaveBeenCalledTimes(1));
    expect(api.updateProfiles).toHaveBeenCalledWith([]);
  });

  it("keeps the phase chip's added state disabled and green", async () => {
    const user = userEvent.setup();
    render(<RoutingProfilesSection />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));

    const added = screen.getByRole("button", { name: "plan" });
    expect(added.hasAttribute("disabled")).toBe(true);
    expect(added.className).toContain("border-kin-green");
    expect(added.className).toContain("text-kin-green-ink");

    const free = screen.getByRole("button", { name: "execute" });
    expect(free.hasAttribute("disabled")).toBe(false);
    expect(free.className).toContain("border-[var(--kin-hairline)]");

    await user.click(free);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "execute" })).toHaveProperty("disabled", true),
    );
    // The added phase now has its own editor row, which is what the chip added.
    expect(screen.getAllByRole("button", { name: "remove" })).toHaveLength(2);
  });

  it("does not change when the dirty callback fires", async () => {
    // The failed-first-load rule and the slow-save baseline are covered by
    // RoutingSettings.dirty.dom.test.tsx; this keeps the common path: an edit
    // is a draft, and only a save that blesses it makes the form clean again.
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();

    render(<RoutingDefaultsSection onDirtyChange={onDirtyChange} />);
    const attempts = await screen.findByRole("spinbutton", { name: /Max attempts/ });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    fireEvent.change(attempts, { target: { value: "4" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", { name: "Save routing defaults" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
});
