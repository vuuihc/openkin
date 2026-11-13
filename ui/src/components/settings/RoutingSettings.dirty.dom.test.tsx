// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { RoutingDefaultsSection } from "./RoutingSettings";

/**
 * What "unsaved" means while the routing defaults are in flight.
 *
 * The form's baseline is what the server holds, never what the reader happened
 * to have typed when the response arrived: an edit made during a slow save is
 * still unsaved, and a first load that failed cannot make the form permanently
 * clean — there is no server value to compare against, so the rows on screen
 * are the only draft there is.
 */

const api = vi.hoisted(() => ({
  defaults: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    getRoutingDefaults: api.defaults,
    getRoutingOptions: vi.fn(async () => ({ teams: [] })),
    getRoutingProfiles: vi.fn(async () => ({ profiles: [] })),
    updateRoutingDefaults: api.update,
    updateRoutingProfiles: vi.fn(async () => ({ profiles: [] })),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setLocale("en");
  useAppStore.setState({ reconnectGen: 0 });
  api.defaults.mockReset();
  api.update.mockReset();
  api.defaults.mockResolvedValue(loaded);
  Element.prototype.scrollIntoView = vi.fn();
});

describe("routing defaults leave guard", () => {
  it("keeps an edit made during a slow save unsaved", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    api.update.mockReturnValue(pending.promise);
    const onDirtyChange = vi.fn();

    render(<RoutingDefaultsSection onDirtyChange={onDirtyChange} />);
    const attempts = await screen.findByRole("spinbutton", { name: /Max attempts/ });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    fireEvent.change(attempts, { target: { value: "4" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", { name: "Save routing defaults" }));
    expect(api.update).toHaveBeenCalledTimes(1);
    // The save carries 4. While it is in flight the reader types 5; the
    // response must not bless 5 as saved.
    fireEvent.change(attempts, { target: { value: "5" } });
    pending.resolve();
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("treats edits as dirty when the first load failed", async () => {
    const user = userEvent.setup();
    api.defaults.mockRejectedValue(new Error("unavailable"));
    const onDirtyChange = vi.fn();

    render(<RoutingDefaultsSection onDirtyChange={onDirtyChange} />);
    const enabled = await screen.findByRole("checkbox", { name: /Enable auto routing/ });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    await user.click(enabled);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});

describe("a slow read of the routing defaults", () => {
  it("keeps a field edited before a reconnect and fills the fields left alone", async () => {
    const user = userEvent.setup();
    api.defaults.mockResolvedValueOnce(loaded);
    const reload = deferred<typeof loaded>();
    api.defaults.mockReturnValueOnce(reload.promise);
    const onDirtyChange = vi.fn();

    render(<RoutingDefaultsSection onDirtyChange={onDirtyChange} />);
    const attempts = await screen.findByRole("spinbutton", { name: /Max attempts/ });
    await waitFor(() => expect(attempts).toHaveProperty("value", "3"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    // The reader types 4, then the connection comes back and the page re-reads
    // the server under the open form.
    fireEvent.change(attempts, { target: { value: "4" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    act(() => {
      useAppStore.setState({ reconnectGen: 1 });
    });
    expect(api.defaults).toHaveBeenCalledTimes(2);

    // They type again while that read is out. Neither 4 nor 5 may be replaced
    // by the server's 7; the objective, untouched, does take the snapshot.
    fireEvent.change(attempts, { target: { value: "5" } });
    await act(async () => {
      reload.resolve({ ...loaded, max_attempts_per_step: 7, objective: "cost-min" });
    });
    await waitFor(() => expect(attempts).toHaveProperty("value", "5"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    api.update.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Save routing defaults" }));
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({ max_attempts_per_step: 5, objective: "cost-min" }),
    );
  });

  it("takes the whole snapshot on a reconnect when nothing was edited", async () => {
    api.defaults.mockResolvedValueOnce(loaded).mockResolvedValueOnce({
      ...loaded,
      max_attempts_per_step: 6,
    });
    const onDirtyChange = vi.fn();

    render(<RoutingDefaultsSection onDirtyChange={onDirtyChange} />);
    const attempts = await screen.findByRole("spinbutton", { name: /Max attempts/ });
    await waitFor(() => expect(attempts).toHaveProperty("value", "3"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    act(() => {
      useAppStore.setState({ reconnectGen: 1 });
    });
    await waitFor(() => expect(attempts).toHaveProperty("value", "6"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps a checkbox edited while the first read was out", async () => {
    const user = userEvent.setup();
    const first = deferred<typeof loaded>();
    api.defaults.mockReturnValueOnce(first.promise);
    const onDirtyChange = vi.fn();

    render(<RoutingDefaultsSection onDirtyChange={onDirtyChange} />);
    const enabled = await screen.findByRole("checkbox", { name: /Enable auto routing/ });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    // Checked while the first read is still out; the server will answer false.
    await user.click(enabled);
    expect(enabled).toHaveProperty("checked", true);
    await act(async () => {
      first.resolve({ ...loaded, enabled: false, max_attempts_per_step: 7 });
    });

    // The edit survives the answer, and the baseline is the server's own
    // snapshot, not the empty one: checking it back to false is what makes
    // the form clean again.
    expect(enabled).toHaveProperty("checked", true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    // The untouched attempts field was filled from that same snapshot, while
    // the edited checkbox kept its draft.
    expect(screen.getByRole("spinbutton", { name: /Max attempts/ })).toHaveProperty("value", "7");

    await user.click(enabled);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
});
