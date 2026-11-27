// @vitest-environment jsdom
// KIN-AGENTS-002 — agents tab 的两组边界（J6）：导入组拥有读取生命周期与自己的
// 刷新入口，每行保留上次检测时间与不支持导入的原因；角色组只是保存。探测组已于
// R-agents-probe-removal（2026-11-27）删除。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAgentSettingsSection } from "./LocalAgentSettingsSection";
import type { AgentProvider } from "../../api/client";
import type { AgentRole } from "../../lib/agentRoles";
import { setLocale, t } from "../../i18n";

beforeEach(() => setLocale("en"));
afterEach(() => vi.unstubAllGlobals());

function provider(over: Partial<AgentProvider> & { id: string }): AgentProvider {
  return {
    name: over.id,
    kind: "cli",
    state: "available",
    installed: true,
    available: true,
    // Local-time literal (no Z), so the expected HH:MM is timezone-stable.
    last_scanned_at: "2026-10-26T09:07:00",
    ...over,
  };
}

const codex = provider({
  id: "codex",
  name: "Codex",
  capabilities: [{ capability: "session_list", state: "available" }],
});
const claude = provider({
  id: "claude-code",
  name: "Claude Code",
  capabilities: [{ capability: "session_list", state: "available" }],
});
const gemini = provider({
  id: "gemini-cli",
  name: "Gemini CLI",
  state: "unsupported",
  installed: false,
  available: false,
  capabilities: [{ capability: "session_list", state: "unsupported" }],
});

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const lastDetected = (iso: string) => t("settings.localAgents.lastDetected", { value: hhmm(iso) });

/** The `<section>` under a group heading. */
function group(title: string): HTMLElement {
  return screen.getByRole("heading", { name: title, level: 2 }).closest("section") as HTMLElement;
}
// Read at call time: the locale is set in `beforeEach`.
const detectionHeading = () => t("settings.localAgents.detectionHeading");
const importHeading = () => t("settings.localAgents.importHeading");
const rolesHeading = () => t("settings.roles.heading");

type SectionProps = {
  importing?: boolean;
  refreshing?: boolean;
  providers?: AgentProvider[];
  providersStatus?: "loading" | "ready" | "failed";
  providersError?: string | null;
  online?: boolean;
  roles?: AgentRole[];
  onRefresh?: () => void;
  onImportSessions?: () => void;
  onImportProviderSessions?: (agentId: string) => void;
};

function section(props: SectionProps) {
  return (
    <LocalAgentSettingsSection
      active
      agentProviders={props.providers ?? [codex]}
      providersStatus={props.providersStatus ?? "ready"}
      providersError={props.providersError ?? null}
      online={props.online ?? true}
      refreshingAgentCatalog={props.refreshing ?? false}
      importingSessions={props.importing ?? false}
      settingsBusy={false}
      onRefreshAgentCatalog={props.onRefresh ?? vi.fn()}
      onImportSessions={props.onImportSessions ?? vi.fn()}
      onImportProviderSessions={props.onImportProviderSessions ?? vi.fn()}
      onSaveSettings={() => {}}
      roles={props.roles ?? []}
      onRolesChange={() => {}}
    />
  );
}

describe("KIN-AGENTS-002 · the two groups and what they read", () => {
  it("KIN-AGENTS-002 the agents tab has no detection group; import and roles keep their address", () => {
    render(section({}));

    expect(
      screen.queryByRole("heading", { name: detectionHeading(), level: 2 }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: importHeading(), level: 2 })).not.toBeNull();
    expect(screen.getByRole("heading", { name: rolesHeading(), level: 2 })).not.toBeNull();
    expect(
      within(group(importHeading())).getByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
      }),
    ).not.toBeNull();
    // Every row keeps its provenance: the time the import button stands on.
    expect(screen.getByText(lastDetected("2026-10-26T09:07:00"))).not.toBeNull();
  });

  it("KIN-AGENTS-002 a failed provider read keeps the import rows and names the failure in one banner", () => {
    const onImportSessions = vi.fn();
    const onImportProviderSessions = vi.fn();
    render(
      section({
        providersStatus: "failed",
        providersError: "daemon did not respond",
        providers: [codex],
        onImportSessions,
        onImportProviderSessions,
      }),
    );

    const imports = group(importHeading());
    expect(within(imports).getByText("Codex")).not.toBeNull();
    // D1: an explicit refresh that fails keeps the old rows and timestamps.
    expect(screen.getByText(lastDetected("2026-10-26T09:07:00"))).not.toBeNull();
    expect(
      screen.getAllByText(
        t("settings.localAgents.detectionFailed", { reason: "daemon did not respond" }),
      ),
    ).toHaveLength(1);
    const refresh = within(imports).getByRole("button", {
      name: t("settings.localAgents.retryDetection"),
    });
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    expect(onImportSessions).not.toHaveBeenCalled();
    expect(onImportProviderSessions).not.toHaveBeenCalled();
  });

  it("KIN-AGENTS-002 a failed first read says it has no results instead of calling the list empty", () => {
    render(
      section({ providersStatus: "failed", providersError: "daemon did not respond", providers: [] }),
    );

    const imports = group(importHeading());
    expect(within(imports).getByText(t("settings.localAgents.firstReadFailed"))).not.toBeNull();
    expect(within(imports).getByRole("button", { name: t("common.retry") })).not.toBeNull();
    expect(screen.queryByText(t("settings.localAgents.emptyImport"))).toBeNull();
    expect(screen.queryByText(t("settings.localAgents.emptyImportHint"))).toBeNull();
  });

  it("KIN-AGENTS-002 a read in flight says it is reading instead of empty", () => {
    render(section({ providersStatus: "loading", providers: [] }));

    const imports = group(importHeading());
    // Once on the refresh control's in-flight label and once as the group's
    // reading copy: a first read that has not answered is not an empty list.
    expect(within(imports).getAllByText(t("settings.localAgents.refreshing"))).toHaveLength(2);
    expect(screen.queryByText(t("settings.localAgents.emptyImport"))).toBeNull();
  });

  it("KIN-AGENTS-002 the import group's refresh control re-reads providers and starts no import", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onImportSessions = vi.fn();
    const onImportProviderSessions = vi.fn();
    render(section({ onRefresh, onImportSessions, onImportProviderSessions }));

    // The import group owns its own read entry (D2).
    await user.click(
      within(group(importHeading())).getByRole("button", {
        name: t("settings.localAgents.refresh"),
      }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onImportSessions).not.toHaveBeenCalled();
    expect(onImportProviderSessions).not.toHaveBeenCalled();
  });

  it("KIN-AGENTS-002 opening the tab starts no import and reads no secure store", () => {
    const onRefresh = vi.fn();
    const onImportSessions = vi.fn();
    const onImportProviderSessions = vi.fn();
    render(section({ onRefresh, onImportSessions, onImportProviderSessions }));

    expect(within(group(importHeading())).getByText("Codex")).not.toBeNull();
    expect(screen.getByRole("button", { name: t("settings.localAgents.refresh") })).not.toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onImportSessions).not.toHaveBeenCalled();
    expect(onImportProviderSessions).not.toHaveBeenCalled();
    expect(screen.queryByText(t("settings.localAgents.importing"))).toBeNull();
  });

  it("KIN-AGENTS-002 refresh marks the group busy, updates last-detected, and starts no import or default-agent change", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onImportSessions = vi.fn();
    const onImportProviderSessions = vi.fn();
    const keep = { onImportSessions, onImportProviderSessions };
    const old = [provider({ ...codex, last_scanned_at: "2026-10-26T08:00:00" })];
    const view = render(section({ ...keep, onRefresh, providers: old }));

    expect(screen.getByText(lastDetected("2026-10-26T08:00:00"))).not.toBeNull();
    await user.click(screen.getByRole("button", { name: t("settings.localAgents.refresh") }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.rerender(section({ ...keep, refreshing: true, providers: old }));
    // Old rows and timestamp stay while the probe runs.
    expect(screen.getByText(lastDetected("2026-10-26T08:00:00"))).not.toBeNull();
    const busy = screen.getByRole("button", { name: t("settings.localAgents.refreshing") });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    view.rerender(
      section({
        ...keep,
        providers: [provider({ ...codex, last_scanned_at: "2026-10-26T09:42:00" })],
      }),
    );
    expect(screen.getByText(lastDetected("2026-10-26T09:42:00"))).not.toBeNull();
    expect(screen.queryByText(lastDetected("2026-10-26T08:00:00"))).toBeNull();
    expect(onImportSessions).not.toHaveBeenCalled();
    expect(onImportProviderSessions).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("KIN-AGENTS-002 a provider without session_list has no import button and names the reason", () => {
    render(section({ providers: [gemini] }));

    expect(screen.getAllByText("Gemini CLI")).toHaveLength(1);
    expect(
      screen.queryByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Gemini CLI" }),
      }),
    ).toBeNull();
    expect(screen.getAllByText(t("settings.localAgents.importUnsupportedReason"))).toHaveLength(1);
  });

  it("KIN-AGENTS-002 a row import asks for that provider on this machine and reports the indexed count", async () => {
    const user = userEvent.setup();
    const onImportProviderSessions = vi.fn();
    render(section({ providers: [codex, claude], onImportProviderSessions }));

    const imports = group(importHeading());
    const name = t("settings.localAgents.importProviderLabel", { name: "Claude Code" });
    expect(
      within(imports).getByText(t("settings.localAgents.importRowDetail", { name: "Claude Code" })),
    ).not.toBeNull();
    await user.click(within(imports).getByRole("button", { name }));

    expect(onImportProviderSessions).toHaveBeenCalledTimes(1);
    expect(onImportProviderSessions).toHaveBeenCalledWith("claude-code");
  });

  it("KIN-AGENTS-002 one import in flight disables every import button", () => {
    render(section({ importing: true, providers: [codex, claude] }));

    const imports = group(importHeading());
    const rowImports = within(imports).getAllByRole("button", {
      name: /^Import sessions from /,
    });
    const groupImport = within(imports).getByRole("button", {
      name: t("settings.localAgents.importing"),
    });
    expect(rowImports).toHaveLength(2); // one per importable provider
    for (const button of [...rowImports, groupImport]) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("KIN-AGENTS-002 saved roles render without starting a probe or import", () => {
    const onRefresh = vi.fn();
    const onImportSessions = vi.fn();
    const onImportProviderSessions = vi.fn();
    const roles = [{ id: "role-1", name: "Security review", prompt: "Review this diff." }];
    render(section({ onRefresh, onImportSessions, onImportProviderSessions, roles }));

    expect(
      (screen.getByLabelText(t("settings.roles.name", { index: 1 })) as HTMLInputElement).value,
    ).toBe("Security review");
    expect(
      (screen.getByLabelText(t("settings.roles.prompt", { index: 1 })) as HTMLTextAreaElement)
        .value,
    ).toBe("Review this diff.");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onImportSessions).not.toHaveBeenCalled();
    expect(onImportProviderSessions).not.toHaveBeenCalled();
  });

  it("KIN-AGENTS-002 offline marks the import and role groups and disables their writes", () => {
    render(
      section({
        online: false,
        providers: [codex],
        roles: [{ id: "role-1", name: "Security review", prompt: "Review this diff." }],
      }),
    );

    const imports = group(importHeading());
    const rolesGroup = group(rolesHeading());
    const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
    expect(within(imports).getByText(t("settings.localAgents.offlineImport"))).not.toBeNull();
    expect(within(rolesGroup).getByText(t("settings.localAgents.offlineRoles"))).not.toBeNull();
    // The detection group's copy left with that group.
    expect(screen.queryByText(t("settings.localAgents.offlineDetection"))).toBeNull();
    // Everything in the import group is a write or a read that needs the daemon.
    for (const button of within(imports).getAllByRole("button")) {
      expect(disabled(button)).toBe(true);
    }
    expect(
      (screen.getByLabelText(t("settings.roles.name", { index: 1 })) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      disabled(within(rolesGroup).getByRole("button", { name: t("settings.localAgents.save") })),
    ).toBe(true);
  });

  it("KIN-AGENTS-002 a coarse pointer keeps every row import at the 44px floor", () => {
    // jsdom has no matchMedia; this case declares a finger, per TASTE 16.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(section({}));

    const button = screen.getByRole("button", {
      name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
    });
    // The row's own coarse box, not just the shared Button's single base floor:
    // on a mouse this row renders the compact class without `min-h-11`.
    expect(button.className).toContain("min-h-11 px-2.5 py-1 text-caption");
  });

  it("KIN-AGENTS-002 the tab renders no install, update, uninstall, login, smoke or usage control", () => {
    render(section({ providers: [codex, gemini] }));

    for (const name of [
      /install/i,
      /update/i,
      /uninstall/i,
      /sign in/i,
      /login/i,
      /smoke/i,
      /usage/i,
    ]) {
      expect(screen.queryByRole("button", { name, hidden: true })).toBeNull();
      expect(screen.queryByRole("link", { name, hidden: true })).toBeNull();
    }
  });

  it("KIN-AGENTS-002 each row's import is named for its provider", () => {
    render(section({ providers: [codex, claude] }));

    expect(
      screen.queryByRole("button", { name: t("settings.localAgents.importProvider") }),
    ).toBeNull();
    for (const name of ["Codex", "Claude Code"]) {
      expect(
        screen.getAllByRole("button", {
          name: t("settings.localAgents.importProviderLabel", { name }),
        }).length,
      ).toBeGreaterThan(0);
    }
  });
});
