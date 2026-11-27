// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { setLocale, t } from "../../i18n";
import { NO_ACCOUNT, useAppStore } from "../../store/appStore";
import { AccountSection } from "./AccountSection";
import { LocalAgentSettingsSection } from "./LocalAgentSettingsSection";
import { ProviderSettingsSection } from "./ProviderSettingsSection";
import { PushPermissionRow } from "./PushPermissionRow";
import type { AgentProvider, ProviderEntry } from "../../api/client";
import type { NativePushApi, NativePushPlugin } from "../../lib/nativePush";
import { unlinkIdentity } from "../../api/account";

/**
 * E2: the four sections inside Settings answer to the same action vocabulary
 * as the page shell did in E1.
 *
 * The migration is only worth anything if it is the *only* way these rows can
 * draw an action: a hand-built `kin-btn-secondary` copy is indistinguishable
 * from the facade in a screenshot, so the assertions here are about the
 * facade's classes, and one of them reads the sources to keep the next raw
 * button from being added quietly.
 *
 * The fields are no longer out of scope: `TextInput` exists, and the provider
 * form's text fields are asserted below to come from it.
 */

vi.mock("../../api/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/account")>();
  return {
    ...actual,
    startOIDC: vi.fn(),
    unlinkIdentity: vi.fn(async () => undefined),
  };
});

const FACADE_WEIGHTS = [
  "kin-btn-primary",
  "kin-btn-secondary",
  "kin-btn-approve",
  "kin-btn-deny",
] as const;

/** The facade class a role/name resolves to, or null for the quiet variant. */
function facadeWeight(button: HTMLElement): string | null {
  return FACADE_WEIGHTS.find((weight) => button.classList.contains(weight)) ?? null;
}

function buttonNamed(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/**
 * A button found by the words it shows, for a control whose own `<label>` owns
 * its accessible name. The model field's label names its first button and the
 * accessible-name algorithm skips that control's own text, so role+name
 * resolves the Fetch control to "Default model". The markup predates this
 * slice; the assertion here is about the facade class, not the name.
 */
function buttonShowing(text: string): HTMLButtonElement {
  const button = screen.getAllByRole("button").find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`no button showing ${text}`);
  return button as HTMLButtonElement;
}

const inactiveProvider: ProviderEntry = {
  id: "openai",
  name: "OpenAI",
  kind: "openai-compatible",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  active: false,
};

const activeProvider: ProviderEntry = { ...inactiveProvider, active: true };

type ProviderProps = ComponentProps<typeof ProviderSettingsSection>;

function providerSection(over: Partial<ProviderProps> = {}) {
  const props: ProviderProps = {
    active: true,
    providers: [inactiveProvider],
    activeProviderId: "",
    providerBusy: false,
    editingId: null,
    providerName: "",
    providerBaseUrl: "",
    providerApiKey: "",
    providerModel: "",
    providerStream: true,
    revealApiKey: false,
    providerModelOptions: [],
    providerModelLoading: false,
    providerModelError: null,
    showRouting: false,
    providerSupportsAgents: "",
    providerModels: [],
    agentDefault: "",
    agentList: [],
    settingsBusy: false,
    onAddProvider: vi.fn(),
    onActivateProvider: vi.fn(),
    onEditProvider: vi.fn(),
    onDeleteProvider: vi.fn(),
    onProviderNameChange: vi.fn(),
    onProviderBaseUrlChange: vi.fn(),
    onProviderApiKeyChange: vi.fn(),
    onProviderApiKeyDirty: vi.fn(),
    onProviderModelChange: vi.fn(),
    onProviderStreamChange: vi.fn(),
    onToggleApiKeyReveal: vi.fn(),
    onFetchProviderModels: vi.fn(),
    onToggleRouting: vi.fn(),
    onProviderSupportsAgentsChange: vi.fn(),
    onProviderModelsChange: vi.fn(),
    onCloseProviderForm: vi.fn(),
    onSaveProvider: vi.fn(),
    onAgentDefaultChange: vi.fn(),
    onSaveSettings: vi.fn(),
    ...over,
  };
  return render(
    <MemoryRouter>
      <ProviderSettingsSection {...props} />
    </MemoryRouter>,
  );
}

const codex: AgentProvider = {
  id: "codex",
  name: "Codex",
  kind: "cli",
  state: "available",
  installed: true,
  available: true,
  last_scanned_at: "2026-10-26T00:00:00Z",
  capabilities: [{ capability: "session_list", state: "available" }],
};

function localAgentSection(over: Partial<ComponentProps<typeof LocalAgentSettingsSection>> = {}) {
  return render(
    <LocalAgentSettingsSection
      active
      agentProviders={[codex]}
      refreshingAgentCatalog={false}
      importingSessions={false}
      settingsBusy={false}
      onRefreshAgentCatalog={vi.fn()}
      onImportSessions={vi.fn()}
      onImportProviderSessions={vi.fn()}
      onSaveSettings={vi.fn()}
      roles={[]}
      onRolesChange={vi.fn()}
      {...over}
    />,
  );
}

const password = { id: "password", label: "password", kind: "password" as const };
const oidc = {
  id: "oidc:https://kin.example.com/dex",
  label: "GitHub / Google",
  kind: "oidc" as const,
  start_url: "/api/auth/oidc/start",
};

function setAccount(): void {
  useAppStore.setState({
    account: {
      ...NO_ACCOUNT,
      enabled: true,
      authenticated: true,
      providers: [password, oidc],
      identities: [password.id, oidc.id],
      linked: [
        { id: "id-password", provider: password.id },
        { id: "id-linked", provider: oidc.id },
      ],
    },
  });
}

function pushPlugin(status: "granted" | "denied" | "prompt"): NativePushPlugin {
  return {
    permission: vi.fn(async () => ({ status })),
    requestPermission: vi.fn(async () => ({ status: "granted" as const })),
    register: vi.fn(async () => ({
      installId: "install-1",
      token: "token-1",
      environment: "production" as const,
    })),
    unregister: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
  };
}

function pushApi(): NativePushApi {
  return {
    registerPushDevice: vi.fn(async () => ({ id: "device-1" })),
    deletePushDevice: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [] });
  window.history.replaceState({}, "", "/");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the provider form's text fields", () => {
  it("draws every provider text field with the shared TextInput", () => {
    providerSection({
      editingId: "openai",
      providerModels: [{ id: "claude-sonnet-4", tier: "balanced", cost_label: "unknown" }],
      showRouting: true,
    });

    const keys = [
      "settings.provider.apiKey",
      "settings.provider.model",
      "settings.routing.supportsAgents",
    ] as const;

    for (const key of keys) {
      const field = screen.getByLabelText(t(key));
      expect(field).toBeInstanceOf(HTMLInputElement);
      expect(field.classList.contains("kin-input")).toBe(true);
      expect(field.closest("label")).toBeNull();
    }

    // The per-model id has no visible label of its own; the shared field keeps
    // an accessible name for it, hidden beside the row's "Model 1" caption.
    const modelField = screen.getByLabelText(t("settings.provider.modelLabel", { index: 1 }));
    expect(modelField).toBeInstanceOf(HTMLInputElement);
    expect(modelField.classList.contains("kin-input")).toBe(true);
    expect(modelField.closest("label")).toBeNull();
    expect((modelField as HTMLInputElement).placeholder).toBe("claude-sonnet-4-20250514");
  });
});

describe("the settings sections on the shared button", () => {
  // RolesSection and RoutingSettings are other slices' files: this test covers
  // the four sections E2 owns, and the source scan below is what keeps a raw
  // copy from being added back to them.
  it("routes every settings action through the shared Button", () => {
    providerSection({
      providers: [inactiveProvider],
      editingId: "openai",
      providerModels: [{ id: "", tier: "balanced", cost_label: "unknown" }],
      showRouting: true,
    });

    // Filled: the one primary action of each group.
    expect(facadeWeight(buttonNamed("Save provider"))).toBe("kin-btn-primary");
    expect(facadeWeight(buttonNamed("Save default agent"))).toBe("kin-btn-primary");
    // Bordered peers.
    for (const name of ["Add provider", "Use", "Edit", "Delete", "Reveal", "Cancel"]) {
      expect(facadeWeight(buttonNamed(name))).toBe("kin-btn-secondary");
    }
    // Link-shaped inline actions: the facade's quiet weight, no kin-btn-* fill.
    const fetchModels = buttonShowing("Fetch models");
    expect(facadeWeight(fetchModels)).toBeNull();
    expect(fetchModels.className).toContain("text-kin-blue-ink!");
    expect(facadeWeight(buttonNamed("Add model"))).toBeNull();
    expect(buttonNamed("Add model").className).toContain("text-kin-blue-ink!");
    // The destructive inline action is quiet too, in red ink.
    const remove = buttonNamed("Remove");
    expect(facadeWeight(remove)).toBeNull();
    expect(remove.className).toContain("text-kin-red-ink");

    cleanup();
    localAgentSection();
    // The import group keeps its own read entry after the detection half left.
    expect(facadeWeight(buttonNamed("Refresh detection"))).toBe("kin-btn-secondary");
    expect(facadeWeight(buttonNamed("Import sessions now"))).toBe("kin-btn-secondary");
    const rowImports = screen.getAllByRole("button", { name: "Import sessions from Codex" });
    expect(rowImports).toHaveLength(1);
    expect(facadeWeight(rowImports[0])).toBe("kin-btn-secondary");
    const [saveSession] = screen.getAllByRole("button", { name: "Save session settings" });
    expect(facadeWeight(saveSession)).toBe("kin-btn-primary");
    // RolesSection (E3's file, outside this slice) still hand-builds its Save
    // with the same class and label; the facade's focus token tells them apart.
    expect(saveSession.className).not.toContain("focus-visible:outline-kin-focus-ring");

    cleanup();
    setAccount();
    render(<AccountSection />);
    expect(facadeWeight(buttonNamed("Sign out"))).toBe("kin-btn-secondary");
    expect(facadeWeight(buttonNamed("Link another sign-in"))).toBe("kin-btn-secondary");
    expect(facadeWeight(buttonNamed("Remove GitHub / Google"))).toBeNull();

    cleanup();
    render(<PushPermissionRow plugin={pushPlugin("prompt")} api={pushApi()} />);
    return waitFor(() => {
      expect(facadeWeight(buttonNamed("Enable notifications"))).toBe("kin-btn-primary");
    });
  });

  it("leaves exactly one raw button in the four sections, and it is the routing disclosure", () => {
    const here = (name: string) =>
      readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
    const sources = {
      provider: here("./ProviderSettingsSection.tsx"),
      localAgent: here("./LocalAgentSettingsSection.tsx"),
      account: here("./AccountSection.tsx"),
      push: here("./PushPermissionRow.tsx"),
    };
    const rawButtons = (source: string) => source.match(/<button\b/g)?.length ?? 0;

    expect(rawButtons(sources.provider)).toBe(1);
    expect(rawButtons(sources.localAgent)).toBe(0);
    expect(rawButtons(sources.account)).toBe(0);
    expect(rawButtons(sources.push)).toBe(0);
    // The survivor is a disclosure header, not an action: it keeps
    // `aria-expanded` and the rotating marker, which the facade has no
    // vocabulary for.
    expect(sources.provider).toContain("aria-expanded={showRouting}");
    expect(sources.provider).toContain("onToggleRouting");
  });

  it("keeps the provider row's destructive action destructive", async () => {
    const user = userEvent.setup();
    const onDeleteProvider = vi.fn();
    providerSection({ onDeleteProvider });

    const remove = buttonNamed("Delete");
    expect(remove.className).toContain("text-kin-red-ink");
    await user.click(remove);

    expect(onDeleteProvider).toHaveBeenCalledWith("openai");
  });

  it("disables every provider action while a provider request is in flight", () => {
    providerSection({
      providerBusy: true,
      editingId: "openai",
      providers: [inactiveProvider],
    });

    // A busy provider form renames its Save to the shared "Saving…" label.
    for (const name of ["Add provider", "Use", "Edit", "Delete", "Saving…", "Cancel"]) {
      expect(buttonNamed(name).disabled).toBe(true);
    }

    cleanup();
    providerSection({ editingId: "openai", providers: [inactiveProvider] });
    for (const name of ["Add provider", "Use", "Edit", "Delete", "Save provider", "Cancel"]) {
      expect(buttonNamed(name).disabled).toBe(false);
    }
  });

  it("keeps the account chip's remove control inline and named", () => {
    setAccount();
    render(<AccountSection />);

    const remove = buttonNamed("Remove GitHub / Google");
    // The accessible name stays the translated removal sentence.
    expect(remove.getAttribute("aria-label")).toBe("Remove GitHub / Google");
    // It sits inside the chip, so it must not take the shared 44px floor; the
    // `!` is required because the facade's own base carries `sm:min-h-0`.
    expect(remove.className).toContain("min-h-0!");
  });

  it("keeps the push permission actions wired to their own handlers", async () => {
    const user = userEvent.setup();
    const plugin = pushPlugin("prompt");
    const api = pushApi();
    render(<PushPermissionRow plugin={plugin} api={api} />);

    await user.click(await screen.findByRole("button", { name: "Enable notifications" }));

    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    // Granted means the row is gone: no second prompt to tap.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull(),
    );

    cleanup();
    const denied = pushPlugin("denied");
    render(<PushPermissionRow plugin={denied} api={pushApi()} />);
    await user.click(await screen.findByRole("button", { name: "Open system settings" }));
    expect(denied.openSettings).toHaveBeenCalledTimes(1);
    expect(denied.requestPermission).not.toHaveBeenCalled();
  });

  it("routes the account unlink through the facade without losing its id", async () => {
    const user = userEvent.setup();
    setAccount();
    render(<AccountSection />);

    await user.click(buttonNamed("Remove GitHub / Google"));

    expect(unlinkIdentity).toHaveBeenCalledWith("id-linked");
  });

  it("keeps the active provider row free of a redundant Use action", () => {
    providerSection({ providers: [activeProvider] });

    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
    expect(buttonNamed("Edit")).toBeTruthy();
  });
});
