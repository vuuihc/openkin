import { describe, expect, it } from "vitest";
import { displayUserPrompt } from "./attachments";
import { taskDisplayTitle } from "./taskTitle";

describe("taskDisplayTitle", () => {
  it("prefers the task's own title, and falls back to its prompt", () => {
    expect(taskDisplayTitle({ title: "Fix the login bug", prompt: "hello" })).toBe(
      "Fix the login bug",
    );
    expect(taskDisplayTitle({ title: "", prompt: "hello there" })).toBe("hello there");
  });

  it("trims, and has nothing to say about a task with neither", () => {
    expect(taskDisplayTitle({ title: "  spaced  ", prompt: "" })).toBe("spaced");
    expect(taskDisplayTitle({ title: "", prompt: "" })).toBe("");
    expect(taskDisplayTitle(null)).toBe("");
    expect(taskDisplayTitle(undefined)).toBe("");
  });

  // The reason this is a function and not the expression inlined at the call
  // site: the prompt half is not the raw prompt. Stated as the property the
  // callers rely on, so a rewrite that skips `displayUserPrompt` fails here
  // rather than showing a user the attachment block.
  it("asks displayUserPrompt what the prompt looks like", () => {
    for (const prompt of ["plain words", "Attached image:\n- a.png: /tmp/a.png", ""]) {
      expect(taskDisplayTitle({ title: "", prompt })).toBe(displayUserPrompt(prompt).trim());
    }
  });
});
