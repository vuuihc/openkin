import { describe, expect, it } from "vitest";
import { displayUserPrompt, stripAttachmentBlock } from "./attachments";

describe("attachments display helpers", () => {
  it("strips absolute paths from attached image block", () => {
    const raw =
      "what is this?\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/abc.png";
    expect(displayUserPrompt(raw)).toBe("what is this?\n\nAttached image: shot.png");
    expect(stripAttachmentBlock(raw).includes("/Users")).toBe(false);
  });

  it("handles attachment-only prompts", () => {
    const raw = "Attached file:\n- notes.txt: /tmp/notes.txt";
    expect(displayUserPrompt(raw)).toBe("Attached file: notes.txt");
  });

  it("leaves normal prompts alone", () => {
    expect(displayUserPrompt("hello")).toBe("hello");
  });
});
