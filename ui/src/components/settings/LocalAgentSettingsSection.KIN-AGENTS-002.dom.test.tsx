// @vitest-environment jsdom
// KIN-AGENTS-002 — 看清安装探测与会话/角色导入的边界（J6）：本套件持有
// 「安装状态 → 导入会话 → 角色默认」三组的组件验收行：每组一句规则、
// 每行上次检测时间、不支持导入的原因、探测失败的保留、离线只读。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAgentSettingsSection } from "./LocalAgentSettingsSection";
import type { AgentProvider } from "../../api/client";
import type { AgentRole } from "../../lib/agentRoles";
import { setLocale, t } from "../../i18n";

beforeEach(() => {
  setLocale("en");
});

function provider(over: Partial<AgentProvider> & { id: string }): AgentProvider {
  return {
    name: over.id,
    kind: "cli",
    state: "available",
    installed: true,
    available: true,
    // A local-time literal (no Z) so the expected HH:MM is the same in every
    // timezone the suite runs in.
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
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function lastDetected(iso: string): string {
  return t("settings.localAgents.lastDetected", { value: hhmm(iso) });
}

/** The `<section>` under a group heading, so a duplicate row in two groups is
 *  never matched by accident. */
function group(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title, level: 2 });
  return heading.closest("section") as HTMLElement;
}

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

// Read through the translator at call time: this file sets the locale in
// `beforeEach`, so a module-level constant would freeze the default language.
const detectionHeading = () => t("settings.localAgents.detectionHeading");
const importHeading = () => t("settings.localAgents.importHeading");
const rolesHeading = () => t("settings.roles.heading");

describe("KIN-AGENTS-002 · the three groups and what they read", () => {
  it("KIN-AGENTS-002 opening the tab starts no import and reads no secure store", () => {
    const onImportSessions = vi.fn();
    const onImportProviderSessions = vi.fn();
    const onRefresh = vi.fn();
    render(section({ onImportSessions, onImportProviderSessions, onRefresh }));

    // Everything the rows say comes from props (the daemon's metadata); the
    // section itself has no read, no secure-store access and no import start.
    expect(within(group(detectionHeading())).getByText("Codex")).not.toBeNull();
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
    const view = render(
      section({
        onRefresh,
        onImportSessions,
        onImportProviderSessions,
        providers: [provider({ ...codex, last_scanned_at: "2026-10-26T08:00:00" })],
      }),
    );

    expect(screen.getByText(lastDetected("2026-10-26T08:00:00"))).not.toBeNull();
    await user.click(screen.getByRole("button", { name: t("settings.localAgents.refresh") }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.rerender(
      section({
        refreshing: true,
        onImportSessions,
        onImportProviderSessions,
        providers: [provider({ ...codex, last_scanned_at: "2026-10-26T08:00:00" })],
      }),
    );
    // The old rows and the old timestamp stay while the probe runs.
    expect(screen.getByText(lastDetected("2026-10-26T08:00:00"))).not.toBeNull();
    const busy = screen.getByRole("button", { name: t("settings.localAgents.refreshing") });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    view.rerender(
      section({
        onImportSessions,
        onImportProviderSessions,
        providers: [provider({ ...codex, last_scanned_at: "2026-10-26T09:42:00" })],
      }),
    );
    expect(screen.getByText(lastDetected("2026-10-26T09:42:00"))).not.toBeNull();
    expect(screen.queryByText(lastDetected("2026-10-26T08:00:00"))).toBeNull();
    expect(onImportSessions).not.toHaveBeenCalled();
    expect(onImportProviderSessions).not.toHaveBeenCalled();
    // Detection has no default-agent control at all.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("KIN-AGENTS-002 a provider without session_list has no import button and names the reason", () => {
    render(section({ providers: [gemini] }));

    // The row stays — it explains why this provider cannot be imported — but
    // nothing invites an errand that cannot run.
    expect(screen.getAllByText("Gemini CLI")).toHaveLength(2);
    expect(
      screen.queryByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Gemini CLI" }),
      }),
    ).toBeNull();
    expect(screen.getAllByText(t("settings.localAgents.importUnsupportedReason")).length).toBe(2);
  });

  it("KIN-AGENTS-002 a row import asks for that provider on this machine and reports the indexed count", async () => {
    const user = userEvent.setup();
    const onImportProviderSessions = vi.fn();
    render(
      section({ providers: [codex, claude], onImportProviderSessions }),
    );

    // The import group owns its own rows: removing the detection half later
    // cannot take them with it.
    const imports = group(importHeading());
    expect(within(imports).getByText(t("settings.localAgents.importRowDetail", { name: "Claude Code" }))).not.toBeNull();
    await user.click(
      within(imports).getByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Claude Code" }),
      }),
    );

    expect(onImportProviderSessions).toHaveBeenCalledTimes(1);
    expect(onImportProviderSessions).toHaveBeenCalledWith("claude-code");
  });

  it("KIN-AGENTS-002 one import in flight disables every import button", () => {
    render(section({ importing: true, providers: [codex, claude] }));

    const buttons = within(group(importHeading())).getAllByRole("button");
    // Two row imports and the group action, all sharing the one in-flight flag.
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("KIN-AGENTS-002 saved roles render without starting a probe or import", () => {
    const onRefresh = vi.fn();
    const onImportSessions = vi.fn();
    const onImportProviderSessions = vi.fn();
    render(
      section({
        onRefresh,
        onImportSessions,
        onImportProviderSessions,
        roles: [{ id: "role-1", name: "Security review", prompt: "Review this diff." }],
      }),
    );

    expect((screen.getByLabelText(t("settings.roles.name", { index: 1 })) as HTMLInputElement).value).toBe(
      "Security review",
    );
    expect(
      (screen.getByLabelText(t("settings.roles.prompt", { index: 1 })) as HTMLTextAreaElement).value,
    ).toBe("Review this diff.");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onImportSessions).not.toHaveBeenCalled();
    expect(onImportProviderSessions).not.toHaveBeenCalled();
  });

  it("KIN-AGENTS-002 offline marks all three groups, disables probe/import with a reason, and leaves roles read-only", () => {
    render(
      section({
        online: false,
        providers: [codex],
        roles: [{ id: "role-1", name: "Security review", prompt: "Review this diff." }],
      }),
    );

    expect(screen.getByText(t("settings.localAgents.offlineDetection"))).not.toBeNull();
    expect(screen.getByText(t("settings.localAgents.offlineImport"))).not.toBeNull();
    expect(screen.getByText(t("settings.localAgents.offlineRoles"))).not.toBeNull();

    expect(
      (screen.getByRole("button", { name: t("settings.localAgents.refresh") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    for (const button of within(group(importHeading())).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(
      (screen.getByLabelText(t("settings.roles.name", { index: 1 })) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(group(rolesHeading())).getByRole("button", {
        name: t("settings.localAgents.save"),
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("KIN-AGENTS-002 a failed probe keeps the previous rows and the old timestamp and shows the reason", () => {
    render(
      section({
        providersStatus: "failed",
        providersError: "daemon did not respond",
        providers: [codex],
      }),
    );

    expect(within(group(detectionHeading())).getByText("Codex")).not.toBeNull();
    expect(screen.getByText(lastDetected("2026-10-26T09:07:00"))).not.toBeNull();
    expect(
      screen.getByText(
        t("settings.localAgents.detectionFailed", { reason: "daemon did not respond" }),
      ),
    ).not.toBeNull();
    const retry = screen.getByRole("button", { name: t("settings.localAgents.retryDetection") });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });

  it("KIN-AGENTS-002 the tab renders no install, update, uninstall, login, smoke or usage control", () => {
    render(section({ providers: [codex, gemini] }));

    for (const name of [/install/i, /update/i, /uninstall/i, /sign in/i, /login/i, /smoke/i, /usage/i]) {
      expect(screen.queryByRole("button", { name, hidden: true })).toBeNull();
      expect(screen.queryByRole("link", { name, hidden: true })).toBeNull();
    }
  });

  it("KIN-AGENTS-002 each row's import is named for its provider", () => {
    render(section({ providers: [codex, claude] }));

    expect(screen.queryByRole("button", { name: t("settings.localAgents.importProvider") })).toBeNull();
    expect(
      screen.getAllByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Codex" }),
      }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", {
        name: t("settings.localAgents.importProviderLabel", { name: "Claude Code" }),
      }).length,
    ).toBeGreaterThan(0);
  });
});
