// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAgentSettingsSection, type AutoImportSnapshot } from "./LocalAgentSettingsSection";
import type { AgentProvider } from "../../api/client";
import { setLocale } from "../../i18n";

/**
 * The rendering half of the settings section. Its pure helpers — the status
 * key, the capability predicate — are covered in the sibling file, and both can
 * be right while the section hands the wrong thing to the wrong control: a
 * per-provider row that imports *everything*, or a main button that stays live
 * through a fan-out, is a bug that only shows up on screen.
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
      autoImportMode="prompt"
      lastAutoImport={null as AutoImportSnapshot | null}
      settingsBusy={false}
      onRefreshAgentCatalog={() => {}}
      onImportSessions={props.onImportSessions ?? vi.fn()}
      onImportProviderSessions={props.onImportProviderSessions ?? vi.fn()}
      onAutoImportModeChange={() => {}}
      onSaveSettings={() => {}}
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

    // An import started anywhere in the console — the sidebar's menu, the
    // automatic sync — reaches this button too, because they share one flag.
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

    // Every row carries the same label, and the rows are drawn in the order the
    // catalog gave them, so the second button is the second provider's row. What
    // is asserted is the *id*: a row that asked for everything would call this
    // once with the wrong argument, and a row that ignored its provider would
    // call it with a constant.
    const rows = screen.getAllByRole("button", { name: "Import" });
    expect(rows).toHaveLength(2);
    await user.click(rows[1]);

    expect(onImportProviderSessions).toHaveBeenCalledTimes(1);
    expect(onImportProviderSessions).toHaveBeenCalledWith("claude-code");
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

    // The row is still there — the person needs to see that the provider exists
    // and why it is not usable — but nothing invites an errand that cannot run.
    expect(screen.queryByText("Gemini")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });
});
