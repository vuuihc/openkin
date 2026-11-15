import { useT } from "../../i18n/react";
import {
  AGENT_ROLE_NAME_MAX,
  AGENT_ROLE_PROMPT_MAX,
  AGENT_ROLES_MAX,
  newAgentRoleId,
  type AgentRole,
} from "../../lib/agentRoles";
import { SettingsSection } from "./SettingsPrimitives";

/**
 * The role editor: a name, the text it inserts, and nothing else.
 *
 * A role is a saved prompt prefix, so the editor is a list of prompts rather
 * than a table of settings — the same two fields the composer will paste, in
 * the order they matter. Rows are edited in place and saved with the page's
 * one Save action, like every other section here; a half-written row (a name
 * with no text, or the reverse) is dropped on save rather than persisted as a
 * role that would insert nothing.
 */
export function RolesSection({
  roles,
  onChange,
  onSave,
  saving,
  disabled,
}: {
  roles: AgentRole[];
  onChange: (roles: AgentRole[]) => void;
  /** Saves the page's settings, roles included. */
  onSave: () => void;
  saving?: boolean;
  disabled?: boolean;
}) {
  const tr = useT();

  function patch(id: string, field: "name" | "prompt", value: string) {
    onChange(roles.map((role) => (role.id === id ? { ...role, [field]: value } : role)));
  }

  function remove(id: string) {
    onChange(roles.filter((role) => role.id !== id));
  }

  function add() {
    onChange([...roles, { id: newAgentRoleId(roles), name: "", prompt: "" }]);
  }

  return (
    <SettingsSection
      title={tr("settings.roles.heading")}
      description={tr("settings.roles.description")}
      action={
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={add}
            disabled={disabled || roles.length >= AGENT_ROLES_MAX}
            className="rounded-lg border border-[var(--kin-hairline-strong)] px-3 py-1.5 text-body font-medium text-kin-secondary hover:bg-[var(--kin-fill)] disabled:opacity-50"
          >
            {tr("settings.roles.add")}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={disabled || saving}
            className="kin-btn-primary disabled:opacity-50"
          >
            {saving ? tr("settings.saving") : tr("settings.localAgents.save")}
          </button>
        </div>
      }
    >
      {roles.length === 0 ? (
        <p className="text-body text-kin-muted">{tr("settings.roles.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {roles.map((role, index) => (
            <li
              key={role.id}
              className="space-y-2 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  className="kin-input min-h-11 flex-1"
                  value={role.name}
                  maxLength={AGENT_ROLE_NAME_MAX}
                  disabled={disabled}
                  placeholder={tr("settings.roles.namePlaceholder")}
                  aria-label={tr("settings.roles.name", { index: index + 1 })}
                  onChange={(event) => patch(role.id, "name", event.target.value)}
                />
                <button
                  type="button"
                  onClick={() => remove(role.id)}
                  disabled={disabled}
                  className="rounded-lg px-2 py-1.5 text-body text-kin-muted hover:bg-[var(--kin-fill-strong)] hover:text-kin-red-ink disabled:opacity-50"
                  aria-label={tr("settings.roles.remove", { name: role.name || index + 1 })}
                >
                  {tr("settings.roles.removeShort")}
                </button>
              </div>
              <textarea
                className="kin-input min-h-[4.5rem] font-mono text-body leading-5"
                value={role.prompt}
                maxLength={AGENT_ROLE_PROMPT_MAX}
                disabled={disabled}
                rows={3}
                placeholder={tr("settings.roles.promptPlaceholder")}
                aria-label={tr("settings.roles.prompt", { index: index + 1 })}
                onChange={(event) => patch(role.id, "prompt", event.target.value)}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
