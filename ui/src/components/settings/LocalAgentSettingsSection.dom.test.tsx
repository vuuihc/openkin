// @vitest-environment jsdom
// KIN-SETTINGS-001 — 改默认设置（J6）：本套件持有本地 agent 列表与手动导入的验收行。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAgentSettingsSection } from "./LocalAgentSettingsSection";
import type { AgentProvider } from "../../api/client";
import { setLocale } from "../../i18n";

/**
 * The rendering half of the settings section. Its pure helper — the capability
 * predicate — is covered in the sibling file, and it can be right while the
 * section hands the wrong thing to the wrong control: a per-provider row that
 * imports *everything*, or a main button that stays live through a fan-out, is
 * a bug that only shows up on screen.
 */

beforeEach(() => {
  // The console's default locale is Chinese; the assertions below are about
  // labels, so the test says which language it means.
  setLocale("en");
});

function provider(over: Partial<AgentProvider> & { id: string }): AgentProvider {
  return {
    name: over.id,
    kind: "cli",
    state: "available",
    installed: true,
    available: true,
    last_scanned_at: "2026-10-26T00:00:00Z",
    ...over,
  };
}

/** A provider whose session listing works, which is the only kind the section
 *  offers an import for. */
const codex = provider({
  id: "codex",
  name: "Codex",
  capabilities: [{ capability: "session_list", state: "available" }],
});

type SectionProps = {
  importing?: boolean;
  providers?: AgentProvider[];
  onImportSessions?: () => void;
  onImportProviderSessions?: (agentId: string) => void;
};

function section(props: SectionProps) {
  return (
    <LocalAgentSettingsSection
      active
      agentProviders={props.providers ?? [codex]}
      refreshingAgentCatalog={false}
      importingSessions={props.importing ?? false}
      settingsBusy={false}
      onRefreshAgentCatalog={() => {}}
      onImportSessions={props.onImportSessions ?? vi.fn()}
      onImportProviderSessions={props.onImportProviderSessions ?? vi.fn()}
      onSaveSettings={() => {}}
      roles={[]}
      onRolesChange={() => {}}
    />
  );
}

const mainImport = () => screen.getByRole("button", { name: "Import sessions now" });

describe("the settings section's import controls", () => {
  it("runs the import it is labelled with, and says so while one is running", async () => {
    const user = userEvent.setup();
    const onImportSessions = vi.fn();
    const { rerender } = render(section({ onImportSessions }));

    await user.click(mainImport());
    expect(onImportSessions).toHaveBeenCalledTimes(1);

    // An import started anywhere in the console — the sidebar's menu or
    // Agent Ops — reaches this button too, because they share one flag.
    // The label is the whole of its progress reporting: there is no spinner.
    rerender(section({ onImportSessions, importing: true }));
    const running = screen.getByRole("button", { name: /importing/i });
    expect((running as HTMLButtonElement).disabled).toBe(true);

    await user.click(running);
    expect(onImportSessions).toHaveBeenCalledTimes(1);
  });

  it("imports the provider whose row was pressed, not every provider", async () => {
    const user = userEvent.setup();
    const onImportProviderSessions = vi.fn();
    render(
      section({
        onImportProviderSessions,
        providers: [
          codex,
          provider({
            id: "claude-code",
            name: "Claude Code",
            capabilities: [{ capability: "session_list", state: "available" }],
          }),
        ],
      }),
    );

    // Provider-named imports (KIN-AGENTS-002), one per importable provider in
    // the import group. The *id* is what is asserted.
    const rows = screen.getAllByRole("button", { name: /^Import sessions from / });
    expect(rows).toHaveLength(2);
    await user.click(rows[1]);

    expect(onImportProviderSessions).toHaveBeenCalledTimes(1);
    expect(onImportProviderSessions).toHaveBeenCalledWith("claude-code");
  });

  it("offers no automatic-import control, only the explicit import buttons", () => {
    render(section({}));

    // KIN-AGENTS-001: an agent's history is never imported automatically, so
    // there is no policy switch to mislead anyone into thinking it might be.
    expect(screen.queryByText(/auto-import/i)).toBeNull();
    expect(screen.queryByText(/automatic sync/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Import sessions now" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Import sessions from Codex" })).not.toHaveLength(
      0,
    );
  });

  it("offers no import for a provider that cannot list sessions", () => {
    render(
      section({
        providers: [
          provider({
            id: "gemini",
            name: "Gemini",
            state: "unsupported",
            capabilities: [{ capability: "session_list", state: "unsupported" }],
          }),
        ],
      }),
    );

    // The row stays, but nothing invites an errand that cannot run.
    expect(screen.getAllByText("Gemini")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Import sessions from Gemini" })).toBeNull();
  });
});
