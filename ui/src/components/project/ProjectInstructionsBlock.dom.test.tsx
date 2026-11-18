// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { setLocale } from "../../i18n";
import ProjectInstructionsBlock from "./ProjectInstructionsBlock";

/**
 * KIN-PROJECT-003: the cover block is a window onto ONE_PAGER.md, not a second
 * editor. It shows the text a new chat would receive, says whether that is the
 * whole section, and its one action carries a pre-filled request into the
 * draft — no save, no task, no network call of its own.
 */

function renderBlock(overrides: Partial<ComponentProps<typeof ProjectInstructionsBlock>> = {}) {
  const props: ComponentProps<typeof ProjectInstructionsBlock> = {
    titleId: "instructions",
    loaded: true,
    loading: false,
    loadError: null,
    markdown: "# alpha\n\n## 工作方式\n先跑 make test\n不要手改 generated/\n",
    offline: false,
    launcherHref: "/new?cwd=%2Fwork%2Falpha&q=edit%20it",
    launcherLabel: "Ask Kin to edit…",
    launcherReason: "",
    onLauncherClick: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <ProjectInstructionsBlock {...props} />
    </MemoryRouter>,
  );
  return { ...view, props };
}

beforeEach(() => {
  setLocale("en");
});

describe("the project work-instructions block (KIN-PROJECT-003)", () => {
  it("KIN-PROJECT-003: shows the full text read-only with the launcher href", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { props } = renderBlock();

    expect(screen.getByRole("region", { name: "How to work here" })).toBeTruthy();
    expect(screen.getByText("先跑 make test 不要手改 generated/")).toBeTruthy();
    expect(screen.getByText("New chats receive this text as written")).toBeTruthy();
    // No editor: the section is not a textarea or a second form.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();

    const link = screen.getByRole("link", { name: /Ask Kin to edit…/ });
    expect(link.getAttribute("href")).toBe("/new?cwd=%2Fwork%2Falpha&q=edit%20it");
    await user.click(link);
    expect(props.onLauncherClick).toHaveBeenCalledTimes(1);
    // The launcher navigates; it does not save or start anything itself.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("KIN-PROJECT-003: an empty section invites Kin to write it", () => {
    renderBlock({ markdown: "# alpha\n\n## 工作方式\n\n## Next\n- one\n" });

    expect(screen.getByText("No working instructions yet")).toBeTruthy();
    expect(screen.getByText("New chats will not receive this section")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ask Kin to write…/ })).toBeTruthy();
  });

  it("KIN-PROJECT-003: a truncated body says where the rest stays", () => {
    const body = "工".repeat(401);
    renderBlock({ markdown: `# alpha\n\n## 工作方式\n${body}\n` });

    expect(screen.getByText("工".repeat(400) + "…")).toBeTruthy();
    expect(
      screen.getByText(
        "Truncated: new chats receive the first 400 characters; the rest stays in ONE_PAGER.md",
      ),
    ).toBeTruthy();
  });

  it("KIN-PROJECT-003: loading shares the summary skeleton and does not say empty", () => {
    renderBlock({ loaded: false, loading: true, markdown: "" });

    expect(document.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.queryByText("No working instructions yet")).toBeNull();
  });

  it("KIN-PROJECT-003: a failed read shows the error and retries without guessing", async () => {
    const user = userEvent.setup();
    const { props } = renderBlock({
      loaded: false,
      loadError: "The summary is unavailable right now",
    });

    expect(screen.getByRole("alert").textContent).toContain("The summary is unavailable right now");
    expect(screen.queryByText("No working instructions yet")).toBeNull();
    expect(screen.queryByRole("link", { name: /Ask Kin/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("KIN-PROJECT-003: offline keeps the last text and disables the launcher with its reason", () => {
    renderBlock({
      offline: true,
      launcherHref: null,
      launcherReason: "Offline — a new chat cannot start.",
    });

    expect(screen.getByText(/先跑 make test/)).toBeTruthy();
    expect(screen.getByText(/Last known text/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ask Kin to edit…/ }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByText(/Offline — a new chat cannot start\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Ask Kin/ })).toBeNull();
  });

  it("KIN-PROJECT-003: a missing root disables the launcher without hiding the text", () => {
    renderBlock({
      launcherHref: null,
      launcherReason: "Link a working directory to this project before starting a chat",
    });

    expect(screen.getByText(/先跑 make test/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Ask Kin/ })).toBeNull();
    expect(
      screen.getByText(/Link a working directory to this project before starting a chat/),
    ).toBeTruthy();
  });
});
