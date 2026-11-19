// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { setLocale } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * A user message that carried image attachments draws the pictures, not just
 * their filenames. The same preview serves history (an event), the local
 * pending echo, and the cold task page's fallback prompt; a load failure falls
 * back to the filename chip rather than a broken image.
 */

const RAW = "look at this\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/abc.png";

function userMessage(seq: number, text: string): TaskEvent {
  return {
    task_id: "t1",
    event_epoch: 0,
    seq,
    ts: seq,
    type: "message",
    payload: { role: "user", speaker: "user", content: [{ type: "text", text }] },
  };
}

function uploadedImage(): HTMLImageElement | null {
  return document.querySelector('img[src^="/api/uploads/"]');
}

describe("images in a user bubble", () => {
  it("a user message draws its image inline", () => {
    setLocale("en");
    const { container } = render(<ChatStream events={[userMessage(1, RAW)]} hostSpeaker="kin" />);

    const img = uploadedImage();
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")?.startsWith("/api/uploads/")).toBe(true);
    expect(img?.getAttribute("alt")).toBe("shot.png");
    // The user's own words are still there, and no absolute path is drawn.
    expect(screen.getByText(/look at this/)).toBeTruthy();
    expect(container.innerHTML).not.toContain("/Users/");
  });

  it("a failed image load falls back to the filename chip", () => {
    setLocale("en");
    const { container } = render(<ChatStream events={[userMessage(1, RAW)]} hostSpeaker="kin" />);

    const img = uploadedImage();
    expect(img).toBeTruthy();
    fireEvent.error(img as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    // The chip is the exact filename, not the sentence around it.
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(container.innerHTML).not.toContain("/Users/");
  });

  it("a pending message draws its image before the server answers", () => {
    setLocale("en");
    render(
      <ChatStream
        events={[]}
        hostSpeaker="kin"
        loading
        pendingUserMessages={[
          {
            key: "pending-1",
            text: "look at this\n\nAttached image: shot.png",
            images: [{ name: "shot.png", src: "/api/uploads/abc.png" }],
          },
        ]}
      />,
    );

    expect(uploadedImage()).toBeTruthy();
    expect(screen.getByText(/look at this/)).toBeTruthy();
  });

  it("a cold task page draws the fallback prompt's images", () => {
    setLocale("en");
    render(
      <ChatStream
        events={[]}
        hostSpeaker="kin"
        fallbackUserPrompt={"look at this\n\nAttached image: shot.png"}
        fallbackUserPromptImages={[{ name: "shot.png", src: "/api/uploads/abc.png" }]}
      />,
    );

    expect(uploadedImage()).toBeTruthy();
    expect(screen.getByText(/look at this/)).toBeTruthy();
  });
});
