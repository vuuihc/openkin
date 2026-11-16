// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { AgentRole } from "../../lib/agentRoles";
import { RolesSection } from "./RolesSection";

/**
 * The role editor, which is where a prompt prefix becomes something a new chat
 * can insert. What is pinned here is that every edit leaves through `onChange`
 * as a whole list — the page owns the one Save — and that removing a row
 * removes that row and no other.
 */
function setup(roles: AgentRole[] = []) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  render(<RolesSection roles={roles} onChange={onChange} onSave={onSave} />);
  return { onChange, onSave };
}

const review: AgentRole = {
  id: "review",
  name: "Review",
  prompt: "Review as a security engineer.",
};
const commit: AgentRole = { id: "commit", name: "Commit", prompt: "Write in the imperative." };

describe("RolesSection", () => {
  it("says what an empty list means and offers the first one", () => {
    const { onChange } = setup();
    expect(screen.getByText(t("settings.roles.empty"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("settings.roles.add") }));
    const next = onChange.mock.calls[0][0] as AgentRole[];
    expect(next).toHaveLength(1);
    expect(next[0].id).toBeTruthy();
    expect(next[0].name).toBe("");
  });

  it("edits a row by id, leaving the other rows alone", () => {
    const { onChange } = setup([review, commit]);
    fireEvent.change(screen.getByLabelText(t("settings.roles.name", { index: 2 })), {
      target: { value: "Commit messages" },
    });
    const next = onChange.mock.calls[0][0] as AgentRole[];
    expect(next[0]).toEqual(review);
    expect(next[1]).toEqual({ ...commit, name: "Commit messages" });
  });

  it("edits the prompt", () => {
    const { onChange } = setup([review]);
    fireEvent.change(screen.getByLabelText(t("settings.roles.prompt", { index: 1 })), {
      target: { value: "New text." },
    });
    expect((onChange.mock.calls[0][0] as AgentRole[])[0]).toEqual({
      ...review,
      prompt: "New text.",
    });
  });

  it("removes only the row that was asked for", () => {
    const { onChange } = setup([review, commit]);
    fireEvent.click(
      screen.getByRole("button", { name: t("settings.roles.remove", { name: "Review" }) }),
    );
    expect(onChange.mock.calls[0][0]).toEqual([commit]);
  });

  it("saves through the page's one action", () => {
    const { onSave } = setup([review]);
    fireEvent.click(screen.getByRole("button", { name: t("settings.localAgents.save") }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
