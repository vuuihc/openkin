// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import NewChatPage from "./NewChatPage";
import { setLocale } from "../i18n";

/**
 * The `?q=` prefill from Agent Ops is a one-time invitation.
 *
 * Leaving it in the URL meant a reload applied the install request again over
 * whatever the person had typed since. Applying it over a saved draft also
 * discarded text without asking. These drive the real page on BrowserRouter:
 * empty drafts take the prefill, existing drafts keep their words unless the
 * person agrees to replace them, and the query is gone before a reload can
 * replay it.
 */

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    recentCwds: pending,
    getRoutingOptions: pending,
    findProjectByRoot: pending,
    serverVersion: vi.fn().mockResolvedValue({
      desktop_id: "desktop-hub",
      desktop_name: "hub",
    }),
    listMachines: vi.fn(async () => []),
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      {
        id: "self",
        label: "This Mac",
        isSelf: true,
        online: true,
        roots: ["/work"],
        agents: [],
      },
    ],
    agents: [
      {
        id: "kin",
        name: "Kin",
        installed: true,
        available: true,
        default: true,
        models: [],
      },
    ],
    loading: false,
    failed: false,
    refresh: () => {},
  }),
}));

vi.mock("../hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));

vi.mock("../components/chat/Composer", async () => {
  const React = await import("react");
  function FakeComposer({
    initialValue = "",
    onValueChange,
  }: {
    initialValue?: string;
    onValueChange?: (value: string) => void;
  }) {
    const [value, setValue] = React.useState(initialValue);
    React.useEffect(() => setValue(initialValue), [initialValue]);
    return React.createElement("textarea", {
      "aria-label": "prompt",
      value,
      onChange: (event: { target: { value: string } }) => {
        setValue(event.target.value);
        onValueChange?.(event.target.value);
      },
    });
  }
  return { default: FakeComposer };
});

const installPrompt =
  "Please install Claude Code on this Mac.\n\nInstallation command (ask for my confirmation before running it):\nnpm i -g @anthropic-ai/claude-code";

function app() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/new" element={<NewChatPage />} />
        <Route path="/agents" element={<div>agents page</div>} />
        <Route path="/sessions" element={<div>list page</div>} />
      </Routes>
    </BrowserRouter>
  );
}

function open(url: string) {
  window.history.replaceState({ idx: 0 }, "", url);
  return render(app());
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "prompt" }) as HTMLTextAreaElement;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({ idx: 0 }, "", "/");
  vi.restoreAllMocks();
});

describe("the draft's one-time prefill", () => {
  it("fills an empty draft and removes the query before a reload can replay it", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const view = open(`/new?q=${encodeURIComponent(installPrompt)}`);

    await waitFor(() => expect(promptBox().value).toBe(installPrompt));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(window.location.search).toBe(""));

    fireEvent.change(promptBox(), { target: { value: "words typed after the prefill" } });
    view.unmount();

    // A reload starts at the same URL the browser now holds: no q, so the
    // saved draft is the only thing that can fill the box.
    open("/new");
    await waitFor(() => expect(promptBox().value).toBe("words typed after the prefill"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps an existing draft when the person declines to replace it", async () => {
    localStorage.setItem("kin_draft_prompt", "my own unsent words");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    open(`/new?q=${encodeURIComponent(installPrompt)}`);

    await waitFor(() => expect(window.location.search).toBe(""));
    expect(promptBox().value).toBe("my own unsent words");
    expect(localStorage.getItem("kin_draft_prompt")).toBe("my own unsent words");
    expect(confirm).toHaveBeenCalledWith(
      "You have an unsent draft. Replace it with the request that just opened this page?",
    );
  });

  it("replaces an existing draft only after an explicit yes", async () => {
    localStorage.setItem("kin_draft_prompt", "my own unsent words");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    open(`/new?q=${encodeURIComponent(installPrompt)}`);

    await waitFor(() => expect(promptBox().value).toBe(installPrompt));
    expect(window.location.search).toBe("");
    expect(localStorage.getItem("kin_draft_prompt")).toBe(installPrompt);
  });

  it("does not ask when the saved draft is the same request", async () => {
    localStorage.setItem("kin_draft_prompt", installPrompt);
    const confirm = vi.spyOn(window, "confirm");

    open(`/new?q=${encodeURIComponent(installPrompt)}`);

    await waitFor(() => expect(window.location.search).toBe(""));
    expect(promptBox().value).toBe(installPrompt);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps the prefill across leaving for Agent Ops and coming back", async () => {
    const view = open(`/new?q=${encodeURIComponent(installPrompt)}`);
    await waitFor(() => expect(promptBox().value).toBe(installPrompt));
    await waitFor(() => expect(window.location.search).toBe(""));

    view.unmount();
    open("/agents");
    expect(screen.getByText("agents page")).toBeTruthy();

    // Reopening the draft is a fresh mount of the page at the same URL. The
    // query is gone, so nothing is applied twice.
    const reopened = open("/new");
    expect(promptBox().value).toBe(installPrompt);
    expect(window.location.search).toBe("");
    reopened.unmount();
  });
});
