// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import RoutineEditor, {
  formDraftDefaults,
  type FormDraft,
  type RoutineEditorProps,
} from "./RoutineEditor";

/**
 * The editor is the create/edit form, extracted from the page.
 *
 * It renders one controlled value and reports every field change as a patch;
 * the page owns persistence, the draft and the leave guard. These tests pin
 * that contract so the page can move behind it without the form changing.
 */

// The directory control reads recent directories from the daemon; this test
// is about the form's wiring, not that list.
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  recentCwds: vi.fn(async () => []),
}));

// The real pickers portal and size themselves for the shell. Stand-ins keep
// the accessible names the page's tests already rely on, so what is checked
// here is the editor's own labels and patch calls.
vi.mock("../chat/CwdPicker", () => ({
  default: (props: { cwd: string; locked?: boolean; onChange: (v: string) => void }) => (
    <input
      aria-label="cwd"
      value={props.cwd}
      disabled={props.locked}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));
vi.mock("../chat/ModelPicker", () => ({
  default: (props: {
    value: string;
    disabled?: boolean;
    models: Array<{ id: string }>;
    onChange: (v: string) => void;
  }) => (
    <select
      aria-label={t("modelPicker.label")}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">default</option>
      {props.models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../chat/PermissionModePicker", () => ({
  default: (props: {
    value: string;
    disabled?: boolean;
    onChange: (v: "default" | "accept_edits" | "yolo") => void;
  }) => (
    <select
      aria-label={t("permission.label")}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as "default")}
    >
      <option value="default">default</option>
      <option value="yolo">yolo</option>
    </select>
  ),
}));
vi.mock("../ui/SheetSelect", () => ({
  default: (props: {
    label: string;
    value: string;
    disabled?: boolean;
    options: Array<{ id: string; label: string }>;
    onChange: (id: string) => void;
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const agent = {
  id: "kin",
  name: "Kin",
  installed: true,
  available: true,
  default: true,
  model_list_source: "configured" as const,
  model_list_status: "available" as const,
};

function setup(overrides: Partial<FormDraft> = {}, props: Partial<RoutineEditorProps> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const value: FormDraft = {
    ...formDraftDefaults(),
    title: "Morning review",
    prompt: "Review new PRs",
    cwd: "/work/alpha",
    agentId: "kin",
    permissionMode: "default",
    ...overrides,
  };
  const utils = render(
    <RoutineEditor
      value={value}
      editing={null}
      onChange={onChange}
      onSubmit={onSubmit}
      onCancel={onCancel}
      creating={false}
      formLocked={false}
      agents={[agent]}
      models={[]}
      deviceId="node-1"
      nextRunPreview={null}
      conversationHint="hint"
      sectionRef={createRef<HTMLElement>()}
      titleRef={createRef<HTMLInputElement>()}
      {...props}
    />,
  );
  return { ...utils, onChange, onSubmit, onCancel };
}

describe("RoutineEditor", () => {
  it("renders every FormDraft field as a labelled control", () => {
    setup();
    expect(screen.getByLabelText(t("routines.titleLabel"))).toBeTruthy();
    expect(screen.getByLabelText(t("routines.promptLabel"))).toBeTruthy();
    expect(screen.getByLabelText("cwd")).toBeTruthy();
    expect(screen.getByLabelText(t("routines.agentLabel"))).toBeTruthy();
    expect(screen.getByLabelText(t("modelPicker.label"))).toBeTruthy();
    expect(screen.getByLabelText(t("permission.label"))).toBeTruthy();
    // Both conversation modes are radios under one group label.
    expect(screen.getByText(t("routines.conversationLabel"))).toBeTruthy();
    expect(screen.getByLabelText(t("routines.conversationContinue"))).toBeTruthy();
    expect(screen.getByLabelText(t("routines.conversationFresh"))).toBeTruthy();
    // The schedule row (repeat + first run) is the sibling component's.
    expect(screen.getByText(t("routines.repeatLabel"))).toBeTruthy();
    expect(screen.getByLabelText(t("routines.firstRunLabel"))).toBeTruthy();
  });

  it("onChange is called with the updated field when the title input changes", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText(t("routines.titleLabel")), {
      target: { value: "Evening review" },
    });
    expect(onChange).toHaveBeenCalledWith({ title: "Evening review" });
  });

  it("onChange is called with the updated field when the prompt changes", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText(t("routines.promptLabel")), {
      target: { value: "Review releases" },
    });
    expect(onChange).toHaveBeenCalledWith({ prompt: "Review releases" });
  });

  it("onChange is called with the updated field when the cwd changes", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("cwd"), { target: { value: "/work/beta" } });
    expect(onChange).toHaveBeenCalledWith({ cwd: "/work/beta" });
  });

  it("onChange carries the fields the other pickers own", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText(t("permission.label")), {
      target: { value: "yolo" },
    });
    expect(onChange).toHaveBeenCalledWith({ permissionMode: "yolo" });
    fireEvent.click(screen.getByLabelText(t("routines.conversationFresh")));
    expect(onChange).toHaveBeenCalledWith({ conversationMode: "fresh" });
  });

  it("clears the model when the agent changes", () => {
    const other = { ...agent, id: "other", name: "Other", default: false };
    const { onChange } = setup({}, { agents: [agent, other] });
    fireEvent.change(screen.getByLabelText(t("routines.agentLabel")), {
      target: { value: "other" },
    });
    expect(onChange).toHaveBeenCalledWith({ agentId: "other", model: "" });
  });

  it("submit button is disabled when prompt or cwd is empty", () => {
    setup({ prompt: "" });
    expect(
      (screen.getByRole("button", { name: t("routines.createAndOpen") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("submit button is disabled when cwd is empty", () => {
    setup({ cwd: "" });
    expect(
      (screen.getByRole("button", { name: t("routines.createAndOpen") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("a save in flight holds the submit button", () => {
    setup({}, { formLocked: true });
    expect(
      (screen.getByRole("button", { name: t("routines.createAndOpen") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("⌘Enter submits when the form is not locked and prompt and cwd are non-empty", () => {
    const { onSubmit } = setup();
    const form = screen.getByRole("region", { name: t("routines.createPanelTitle") });
    fireEvent.keyDown(form, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("⌘Enter does not submit an incomplete form", () => {
    const { onSubmit } = setup({ prompt: "" });
    const form = screen.getByRole("region", { name: t("routines.createPanelTitle") });
    fireEvent.keyDown(form, { key: "Enter", metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("editing mode pre-fills the form from the Routine passed in", () => {
    setup(
      {
        title: "Weekly sweep",
        prompt: "Sweep the queue",
        cwd: "/work/beta",
        agentId: "kin",
        model: "kin-large",
      },
      {
        editing: {
          id: "routine-1",
          cwd: "/work/beta",
          agent: "kin",
          prompt: "Sweep the queue",
          interval_secs: 86400,
          enabled: true,
          next_due_at: 0,
          consec_failures: 0,
          created_at: 0,
          title: "Weekly sweep",
          missed_run_policy: "coalesce",
          lane: "routine",
          permission_mode: "default",
        },
        models: [{ id: "kin-large" }],
      },
    );
    expect((screen.getByLabelText(t("routines.titleLabel")) as HTMLInputElement).value).toBe(
      "Weekly sweep",
    );
    expect((screen.getByLabelText(t("routines.promptLabel")) as HTMLTextAreaElement).value).toBe(
      "Sweep the queue",
    );
    expect((screen.getByLabelText("cwd") as HTMLInputElement).value).toBe("/work/beta");
    expect((screen.getByLabelText(t("modelPicker.label")) as HTMLSelectElement).value).toBe(
      "kin-large",
    );
    // The mode changes the wording, not the fields.
    expect(screen.getByText(t("routines.editPanelTitle"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("routines.save") })).toBeTruthy();
  });

  it("cancel calls onCancel and saves nothing", () => {
    const { onCancel, onSubmit } = setup();
    fireEvent.click(screen.getByRole("button", { name: t("routines.cancel") }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Escape cancels, but not while a save is in flight", () => {
    const first = setup();
    fireEvent.keyDown(screen.getByRole("region", { name: t("routines.createPanelTitle") }), {
      key: "Escape",
    });
    expect(first.onCancel).toHaveBeenCalledTimes(1);

    first.unmount();
    const { onCancel } = setup({}, { creating: true });
    fireEvent.keyDown(screen.getByRole("region", { name: t("routines.createPanelTitle") }), {
      key: "Escape",
    });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
