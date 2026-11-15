// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { rememberLastConversation } from "../lib/lastConversation";
import StartRoute from "./StartRoute";

function viewport(wide: boolean) {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

/**
 * KIN-CONTINUE-001, step 1 (Mac): opening the app without touching anything
 * lands in the conversation that was last open. A first run lands on the draft.
 *
 * KIN-CONTINUE-002, step 1 (phone): the list is the navigation root, so `/`
 * lands on it — superseding the phone half of CONTINUE-001's step 1.
 */

function Landing() {
  return <span>landed</span>;
}

function landingAt(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<StartRoute />} />
        <Route path="/new" element={<div>draft page</div>} />
        <Route path="/sessions" element={<div>list page</div>} />
        <Route path="/tasks/:id" element={<div>conversation page</div>} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  viewport(true);
});

describe("the start route", () => {
  it("reopens the conversation that was last on screen", () => {
    rememberLastConversation("task-1");
    landingAt("/");
    expect(screen.getByText("conversation page")).toBeTruthy();
    expect(screen.queryByText("draft page")).toBeNull();
  });

  it("shows the draft on a first run", () => {
    landingAt("/");
    expect(screen.getByText("draft page")).toBeTruthy();
    expect(screen.queryByText("conversation page")).toBeNull();
  });

  it("lands on the list on a phone, even with a conversation behind it", () => {
    viewport(false);
    rememberLastConversation("task-1");
    landingAt("/");
    expect(screen.getByText("list page")).toBeTruthy();
    expect(screen.queryByText("conversation page")).toBeNull();
  });

  it("lands on the list on a phone first run too", () => {
    viewport(false);
    landingAt("/");
    expect(screen.getByText("list page")).toBeTruthy();
    expect(screen.queryByText("draft page")).toBeNull();
  });
});
