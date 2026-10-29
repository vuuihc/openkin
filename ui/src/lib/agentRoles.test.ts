import { describe, expect, it } from "vitest";
import {
  AGENT_ROLE_NAME_MAX,
  AGENT_ROLE_PROMPT_MAX,
  AGENT_ROLES_MAX,
  appliedRole,
  hasRole,
  insertRole,
  newAgentRoleId,
  parseAgentRoles,
  removeRole,
  selectRole,
  serializeAgentRoles,
  type AgentRole,
} from "./agentRoles";

const review: AgentRole = {
  id: "review",
  name: "Review",
  prompt: "Review as a security engineer.",
};
const commit: AgentRole = {
  id: "commit",
  name: "Commit",
  prompt: "Write the message in the imperative.",
};

describe("agent roles", () => {
  it("reads nothing from an empty or broken value", () => {
    expect(parseAgentRoles("")).toEqual([]);
    expect(parseAgentRoles(null)).toEqual([]);
    expect(parseAgentRoles("not json")).toEqual([]);
    expect(parseAgentRoles('{"name":"x"}')).toEqual([]);
  });

  it("drops rows with either half missing", () => {
    const raw = JSON.stringify([
      { id: "a", name: "Review", prompt: "Be strict." },
      { id: "b", name: "", prompt: "No name." },
      { id: "c", name: "No prompt", prompt: "   " },
      { id: "d", name: "Not a string", prompt: 42 },
      null,
      "row",
    ]);
    expect(parseAgentRoles(raw)).toEqual([{ id: "a", name: "Review", prompt: "Be strict." }]);
  });

  it("gives hand-typed rows a stable id and keeps written ids", () => {
    const raw = JSON.stringify([
      { name: "Review", prompt: "Be strict." },
      { name: "Review", prompt: "Be kind." },
      { id: "kept", name: "Commit", prompt: "Imperative." },
    ]);
    const roles = parseAgentRoles(raw);
    expect(roles.map((role) => role.id)).toEqual(["review", "review-2", "kept"]);
    // Re-reading the same value must produce the same ids, or an editor row
    // would remount under the caret on every save.
    expect(parseAgentRoles(raw).map((role) => role.id)).toEqual(["review", "review-2", "kept"]);
  });

  it("replaces a duplicate id rather than keying two rows the same", () => {
    const raw = JSON.stringify([
      { id: "same", name: "One", prompt: "First." },
      { id: "same", name: "Two", prompt: "Second." },
    ]);
    const ids = parseAgentRoles(raw).map((role) => role.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("clamps names and prompts and caps the list", () => {
    const roles = parseAgentRoles(
      JSON.stringify([
        { name: "n".repeat(200), prompt: "p".repeat(AGENT_ROLE_PROMPT_MAX + 10) },
        ...Array.from({ length: AGENT_ROLES_MAX + 5 }, (_, i) => ({
          name: `Role ${i}`,
          prompt: "x",
        })),
      ]),
    );
    expect(Array.from(roles[0].name).length).toBe(AGENT_ROLE_NAME_MAX);
    expect(Array.from(roles[0].prompt).length).toBe(AGENT_ROLE_PROMPT_MAX);
    expect(roles.length).toBe(AGENT_ROLES_MAX);
  });

  it("round-trips through the settings value", () => {
    const roles = [review, commit];
    const parsed = parseAgentRoles(serializeAgentRoles(roles));
    expect(parsed).toEqual([
      { id: "review", name: "Review", prompt: review.prompt },
      { id: "commit", name: "Commit", prompt: commit.prompt },
    ]);
  });

  it("does not persist a row that would insert nothing", () => {
    // A name with no text and text with no name are both rows the list cannot
    // show; saving them would leave settings that disagree with the editor.
    // The stored value is what pins this, not the round-trip: parse drops the
    // same rows, so only the JSON shows what was actually written.
    const saved = serializeAgentRoles([
      review,
      { id: "blank-prompt", name: "Half", prompt: "   " },
      { id: "blank-name", name: " ", prompt: "Do the thing." },
    ]);
    expect(JSON.parse(saved)).toEqual([
      { id: "review", name: "Review", prompt: review.prompt },
    ]);
  });

  it("inserts above the draft with one blank line between", () => {
    expect(insertRole("", review)).toBe("Review as a security engineer.");
    expect(insertRole("Check the login flow.", review)).toBe(
      "Review as a security engineer.\n\nCheck the login flow.",
    );
    // Leading whitespace in the draft does not push the role down.
    expect(insertRole("\n\n  Check it.", review)).toBe(
      "Review as a security engineer.\n\nCheck it.",
    );
  });

  it("inserts only once", () => {
    const once = insertRole("Check it.", review);
    expect(insertRole(once, review)).toBe(once);
    expect(hasRole(once, review)).toBe(true);
    expect(hasRole("Check it.", review)).toBe(false);
    expect(hasRole("Something else entirely", review)).toBe(false);
  });

  it("removes exactly what it inserted", () => {
    expect(removeRole(insertRole("Check it.", review), review)).toBe("Check it.");
    expect(removeRole(insertRole("", review), review)).toBe("");
    // A draft that no longer opens with the role is left alone: the words
    // there now are the user's.
    expect(removeRole("Check it.", review)).toBe("Check it.");
    // The role's own opening words, continued into a sentence of the user's,
    // are not the role any more. Removing them would delete an edit.
    const edited = "Review as a security engineer. Edited.";
    expect(hasRole(edited, review)).toBe(false);
    expect(removeRole(edited, review)).toBe(edited);
  });

  it("still removes a role the user re-wrapped onto one line", () => {
    expect(removeRole("Review as a security engineer.\nCheck it.", review)).toBe("Check it.");
    expect(removeRole("Review as a security engineer.  \n\nCheck it.", review)).toBe("Check it.");
  });

  it("keeps the paragraph after the role intact on removal", () => {
    const draft = insertRole("Line one.\n\nLine two.", review);
    expect(removeRole(draft, review)).toBe("Line one.\n\nLine two.");
  });

  it("names the role a draft opens with", () => {
    expect(appliedRole("Check it.", [review, commit])).toBeNull();
    expect(appliedRole(insertRole("Check it.", review), [review, commit])).toBe(review);
    expect(appliedRole(insertRole("", commit), [review, commit])).toBe(commit);
  });

  it("switches roles without leaving the old instruction behind", () => {
    const draft = insertRole("Check the login flow.", review);
    const switched = selectRole(draft, [review, commit], commit.id);
    expect(switched).toBe("Write the message in the imperative.\n\nCheck the login flow.");
    expect(appliedRole(switched, [review, commit])).toBe(commit);
  });

  it("clears the role", () => {
    expect(selectRole(insertRole("Check the login flow.", review), [review, commit], null)).toBe(
      "Check the login flow.",
    );
    expect(selectRole(insertRole("Check the login flow.", review), [review, commit], "")).toBe(
      "Check the login flow.",
    );
  });

  it("cannot remove what it can no longer recognize", () => {
    // A role deleted from settings leaves its text in the draft and out of the
    // list. There is nothing left to match it by, so the text stays: the draft
    // is the truth, and guessing at text that is no longer named would risk
    // deleting the user's words.
    const draft = insertRole("Check the login flow.", review);
    expect(selectRole(draft, [], review.id)).toBe(draft);
  });

  it("keeps an edited role in place when switching", () => {
    const edited = "Review as a security engineer. Also check headers.";
    expect(selectRole(edited, [review, commit], commit.id)).toBe(
      "Write the message in the imperative.\n\n" + edited,
    );
  });

  it("issues a free id for a new role", () => {
    const id = newAgentRoleId([review, commit]);
    expect(id && ![review.id, commit.id].includes(id)).toBe(true);
  });
});
