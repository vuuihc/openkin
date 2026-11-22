// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import MachineTaskPage from "./MachineTaskPage";

/**
 * The run detail page is read-only: the machine that owns the run keeps its
 * approvals and replies. The one action it does have is re-reading a failed
 * load, and that retry is the shared facade's, not a hand-rolled button.
 */

const mocks = vi.hoisted(() => ({ retry: vi.fn() }));

vi.mock("../hooks/useRemoteTaskRun", () => ({
  useRemoteTaskRun: () => ({
    task: null,
    events: [],
    loaded: false,
    error: new Error("offline"),
    retry: mocks.retry,
  }),
}));

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [{ id: "dev-a", label: "Test node", isSelf: false, online: true, roots: [] }],
    agents: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../i18n/react", () => {
  const translate = (key: string) => key;
  return { useT: () => translate };
});

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  isTerminal: () => true,
}));

vi.mock("../components/chat/ChatStream", () => ({ default: () => null }));
vi.mock("../lib/attachments", () => ({ displayUserPrompt: (value: string) => value }));
vi.mock("../lib/phoneNavigation", () => ({ onGuardedLinkClick: () => false }));

function renderPage() {
  // The run lives on the task detail page now; the device says where. The old
  // `/machines/:device/tasks/:id` path redirects here.
  return render(
    <MemoryRouter initialEntries={["/tasks/run-1?device=dev-a"]}>
      <Routes>
        <Route path="/tasks/:id" element={<MachineTaskPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MachineTaskPage", () => {
  it("keeps the run retry on the facade", () => {
    renderPage();
    const alert = screen.getByRole("alert");
    const retry = within(alert).getByRole("button", { name: "runDetail.retry" });
    expect(retry.classList.contains("kin-btn")).toBe(true);
    expect(retry.classList.contains("kin-btn-secondary")).toBe(true);
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(mocks.retry).toHaveBeenCalledTimes(2);
  });
});
