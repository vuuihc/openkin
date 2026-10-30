// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { rememberLastConversation } from "../lib/lastConversation";
import StartRoute from "./StartRoute";

/**
 * KIN-CONTINUE-001, step 1: opening the app without touching anything lands in
 * the conversation that was last open. A first run lands on the draft.
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
        <Route path="/tasks/:id" element={<div>conversation page</div>} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
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
});
