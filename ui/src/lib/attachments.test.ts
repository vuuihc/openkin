import { describe, expect, it } from "vitest";
import { displayUserPrompt, parseUserPrompt, stripAttachmentBlock } from "./attachments";

describe("attachments display helpers", () => {
  it("strips absolute paths from attached image block", () => {
    const raw = "what is this?\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/abc.png";
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

  it("keeps the filename when the path has spaces", () => {
    const raw = "look\n\nAttached image:\n- a b.png: /Users/me/my shots/a b.png";
    expect(displayUserPrompt(raw)).toBe("look\n\nAttached image: a b.png");
    expect(displayUserPrompt(raw).includes("/Users")).toBe(false);
  });
});

describe("parseUserPrompt", () => {
  it("shows one image and keeps the words", () => {
    const raw = "what is this?\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/abc.png";
    const parsed = parseUserPrompt(raw);
    expect(parsed.text).toBe("what is this?\n\nAttached image: shot.png");
    expect(parsed.images).toEqual([{ name: "shot.png", src: "/api/uploads/abc.png" }]);
    expect(parsed.files).toEqual([]);
  });

  it("handles several images among non-image files", () => {
    const raw =
      "look\n\nAttached files:\n- a.png: /tmp/up/a.png\n- notes.pdf: /tmp/up/notes.pdf\n- b.JPG: /tmp/up/b.JPG";
    const parsed = parseUserPrompt(raw);
    expect(parsed.images).toEqual([
      { name: "a.png", src: "/api/uploads/a.png" },
      { name: "b.JPG", src: "/api/uploads/b.JPG" },
    ]);
    expect(parsed.files).toEqual(["notes.pdf"]);
    // Same summary shape as before this change: the header alternation
    // captures "file" before "files", so the noun has always been singular.
    expect(parsed.text).toBe("look\n\nAttached file: a.png, notes.pdf, b.JPG");
  });

  it("keeps a path with spaces", () => {
    const raw = "look\n\nAttached image:\n- a b.png: /Users/me/my shots/a b.png";
    const parsed = parseUserPrompt(raw);
    expect(parsed.images).toEqual([{ name: "a b.png", src: "/api/uploads/a%20b.png" }]);
  });

  it("leaves a plain prompt alone", () => {
    expect(parseUserPrompt("hello")).toEqual({ text: "hello", images: [], files: [] });
  });
});
