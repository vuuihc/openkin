import { describe, expect, it } from "vitest";
import { publishDraftFrom } from "./publishDraft";
import type { TaskEvent } from "../api/client";

/** A message event with only the fields the draft reads. */
function message(
  seq: number,
  role: string,
  text: string,
  partial = false,
): TaskEvent {
  return {
    seq,
    type: "message",
    payload: { role, content: [{ type: "text", text }], partial },
  } as unknown as TaskEvent;
}

describe("publishDraftFrom", () => {
  it("takes the agent's last answer, title from its first line", () => {
    const draft = publishDraftFrom([
      message(1, "user", "please fix the parser"),
      message(2, "assistant", "## Fix the parser\n\nIt now handles empty input."),
    ]);
    expect(draft.title).toBe("Fix the parser");
    expect(draft.body).toBe("## Fix the parser\n\nIt now handles empty input.");
  });

  it("keeps the newest answer, not the first", () => {
    const draft = publishDraftFrom([
      message(1, "assistant", "First attempt."),
      message(2, "assistant", "Second attempt, and this is the one."),
    ]);
    expect(draft.title).toBe("Second attempt, and this is the one.");
  });

  it("appends the pieces of a streamed reply instead of taking the last one", () => {
    // A partial message is a piece of the answer being written. Reading each one
    // as an answer would put a single token in the title box.
    const draft = publishDraftFrom([
      message(1, "assistant", "The parser now ", true),
      message(2, "assistant", "handles empty input.", true),
    ]);
    expect(draft.title).toBe("The parser now handles empty input.");
  });

  it("prefers the finished answer to the pieces that built it", () => {
    // The adapter sends the whole message once when the turn ends, and that one
    // is the answer; the partials were the same answer arriving.
    const draft = publishDraftFrom([
      message(1, "assistant", "The parser now ", true),
      message(2, "assistant", "handles empty input.", true),
      message(3, "assistant", "The parser now handles empty input."),
    ]);
    expect(draft.body).toBe("The parser now handles empty input.");
  });

  it("prefers a reply still arriving over the last finished one", () => {
    const draft = publishDraftFrom([
      message(1, "assistant", "Old answer."),
      message(2, "assistant", "Newer answer, still arriving", true),
    ]);
    expect(draft.body).toBe("Newer answer, still arriving");
  });

  it("ignores what the person said", () => {
    const draft = publishDraftFrom([
      message(1, "assistant", "Done."),
      message(2, "user", "thanks!"),
    ]);
    expect(draft.body).toBe("Done.");
  });

  it("leaves both boxes empty when the agent has not answered", () => {
    expect(publishDraftFrom([message(1, "user", "go")])).toEqual({
      title: "",
      body: "",
    });
    expect(publishDraftFrom([])).toEqual({ title: "", body: "" });
  });

  it("cuts a title that is a paragraph, and a body that is a dump", () => {
    const long = "x".repeat(200);
    const draft = publishDraftFrom([
      message(1, "assistant", `${long}\n\n${"y".repeat(20000)}`),
    ]);
    expect(draft.title.length).toBeLessThanOrEqual(121);
    expect(draft.title.endsWith("…")).toBe(true);
    expect(draft.body.length).toBeLessThanOrEqual(16001);
    expect(draft.body.endsWith("…")).toBe(true);
  });

  it("takes a list marker off the front of the title", () => {
    const draft = publishDraftFrom([
      message(1, "assistant", "- Add the retry\n- and the test"),
    ]);
    expect(draft.title).toBe("Add the retry");
  });
});
