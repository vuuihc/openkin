// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import RoutineEditor, { type FormDraft, type RoutineEditorProps } from "./RoutineEditor";

// The editor renders one controlled value and reports every edit as a patch;
// the page owns persistence and the leave guard. The pickers portal and size
// themselves for the shell, so these stand-ins keep their accessible names.
type FieldProps = {
  label: string;
  value: string;
  onChange: (id: string) => void;
};

vi.mock("../ui/SheetSelect", () => ({
  default: ({ label, value, onChange }: FieldProps) => (
    <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
// `ModelPicker` and `SearchSelect` stay real: the model chip's portaled
// popover is the layer the Escape case below needs.
vi.mock("../chat/CwdPicker", () => ({
  default: ({
    cwd,
    locked,
    onChange,
  }: {
    cwd: string;
    locked?: boolean;
    onChange: (v: string) => void;
  }) => (
    <input
      aria-label="cwd"
      value={cwd}
      disabled={locked}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("../chat/PermissionModePicker", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: "yolo") => void }) => (
    <input
      aria-label={t("permission.label")}
      value={value}
      onChange={(e) => onChange(e.target.value as "yolo")}
    />
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

/** The form before anyone typed in it. */
const base: FormDraft = {
  title: "Morning review",
  prompt: "Review new PRs",
  cwd: "/work/alpha",
  agentId: "kin",
  model: "",
  permissionMode: "default",
  conversationMode: "continue",
  intervalSecs: 86400,
  rule: null,
  ruleZone: null,
  nextRunLocal: "",
};

function setup(value: Partial<FormDraft> = {}, props: Partial<RoutineEditorProps> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <RoutineEditor
      value={{ ...base, ...value }}
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

const form = () => screen.getByRole("region", { name: t("routines.createPanelTitle") });
const saveButton = () =>
  screen.getByRole("button", { name: t("routines.createAndOpen") }) as HTMLButtonElement;
const cancelButton = () =>
  screen.getByRole("button", { name: t("routines.cancel") }) as HTMLButtonElement;

describe("RoutineEditor", () => {
  it("renders the form's fields as labelled controls", () => {
    setup();
    for (const label of [
      t("routines.titleLabel"),
      t("routines.promptLabel"),
      t("routines.agentLabel"),
      t("permission.label"),
      t("routines.conversationFresh"),
      t("routines.firstRunLabel"),
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText("cwd")).toBeTruthy();
    expect(screen.getByText(t("routines.repeatLabel"))).toBeTruthy();
  });

  it("reports every edit as the field's own patch", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText(t("routines.titleLabel")), {
      target: { value: "Evening review" },
    });
    expect(onChange).toHaveBeenCalledWith({ title: "Evening review" });
    fireEvent.change(screen.getByLabelText("cwd"), { target: { value: "/work/beta" } });
    expect(onChange).toHaveBeenCalledWith({ cwd: "/work/beta" });
    fireEvent.change(screen.getByLabelText(t("permission.label")), {
      target: { value: "yolo" },
    });
    expect(onChange).toHaveBeenCalledWith({ permissionMode: "yolo" });
    fireEvent.click(screen.getByLabelText(t("routines.conversationFresh")));
    expect(onChange).toHaveBeenCalledWith({ conversationMode: "fresh" });
    // A model from the old agent's catalog would fail every run.
    fireEvent.change(screen.getByLabelText(t("routines.agentLabel")), {
      target: { value: "other" },
    });
    expect(onChange).toHaveBeenCalledWith({ agentId: "other", model: "" });
  });

  it("⌘Enter submits a ready, unlocked form and nothing else", () => {
    const ready = setup();
    expect(saveButton().disabled).toBe(false);
    fireEvent.keyDown(form(), { key: "Enter", metaKey: true });
    expect(ready.onSubmit).toHaveBeenCalledTimes(1);
    ready.unmount();
    const incomplete = setup({ prompt: "" });
    expect(saveButton().disabled).toBe(true);
    fireEvent.keyDown(form(), { key: "Enter", metaKey: true });
    expect(incomplete.onSubmit).not.toHaveBeenCalled();
    incomplete.unmount();
    const locked = setup({}, { formLocked: true });
    expect(saveButton().disabled).toBe(true);
    fireEvent.keyDown(form(), { key: "Enter", metaKey: true });
    expect(locked.onSubmit).not.toHaveBeenCalled();
  });

  it("cancel and Escape close, but not while a save is in flight", () => {
    const cancelled = setup();
    fireEvent.click(screen.getByRole("button", { name: t("routines.cancel") }));
    expect(cancelled.onCancel).toHaveBeenCalledTimes(1);
    expect(cancelled.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(form(), { key: "Escape" });
    expect(cancelled.onCancel).toHaveBeenCalledTimes(2);
    cancelled.unmount();
    const saving = setup({}, { creating: true });
    fireEvent.keyDown(form(), { key: "Escape" });
    expect(saving.onCancel).not.toHaveBeenCalled();
  });

  it("closes only the open picker on Escape, then the form", async () => {
    const { onCancel } = setup({}, { models: [{ id: "opus", label: "Opus" }] });
    // Two triggers share this name: the desktop popover's chip and the phone's
    // sheet opener. The first in document order is the desktop one.
    const trigger = screen.getAllByRole("button", {
      name: new RegExp(`^${t("modelPicker.label")}`),
    })[0];

    fireEvent.click(trigger);
    await screen.findByRole("listbox");

    // The picker is portaled to <body>, but its key event still reaches this
    // form's React handler first. The layer the reader opened last owns the
    // first Escape; the form underneath must not take it too.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    // The layer hands focus back to the chip it opened from, so the reader can
    // reopen it or Tab on without hunting for where the caret went.
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(form(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("puts cancel and create/save on the shared Button and keeps the disabled rules", () => {
    const ready = setup();
    const cancel = cancelButton();
    // The console's secondary weight, not a hand-styled text rectangle: the
    // border, ink, hover and 44px floor come from the facade.
    expect(cancel.tagName).toBe("BUTTON");
    expect(cancel.getAttribute("type")).toBe("button");
    expect(cancel.className).toContain("kin-btn");
    expect(cancel.className).toContain("kin-btn-secondary");
    expect(cancel.className).not.toContain("kin-btn-primary");
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(ready.onCancel).toHaveBeenCalledTimes(1);

    const save = saveButton();
    expect(save.getAttribute("type")).toBe("button");
    expect(save.className).toContain("kin-btn");
    expect(save.className).toContain("kin-btn-primary");
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(ready.onSubmit).toHaveBeenCalledTimes(1);
    ready.unmount();

    // Cancel is the way out even when the machine is offline (offline locks
    // writes, not closing), but a save already in flight holds it.
    const saving = setup({}, { creating: true });
    expect(cancelButton().disabled).toBe(true);
    saving.unmount();

    // Save (and the ⌘Enter shortcut) refuse exactly these three states.
    const cases: Array<[Partial<FormDraft>, Partial<RoutineEditorProps>, boolean]> = [
      [{}, {}, false],
      [{ prompt: "" }, {}, true],
      [{ cwd: "" }, {}, true],
      [{}, { formLocked: true }, true],
    ];
    for (const [value, props, disabled] of cases) {
      const view = setup(value, props);
      expect(saveButton().disabled).toBe(disabled);
      view.unmount();
    }
  });

  it("keeps exactly one filled primary in the editor", () => {
    // TASTE 6 at the DOM level: the save/create action is the surface's one
    // filled button. Cancel is the outlined peer next to it, not a second
    // primary competing for the reader's next step.
    setup();
    const primaries = form().querySelectorAll(".kin-btn-primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(saveButton());
  });

  it("reports schedule edits through onChange", async () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText(t("routines.firstRunLabel")), {
      target: { value: "2026-11-16T09:00" },
    });
    expect(onChange).toHaveBeenCalledWith({ nextRunLocal: "2026-11-16T09:00" });
    // The repeat control is the shared select, not a native <select>: open its
    // list and take the row the old test typed into the element.
    const repeat = screen.getAllByRole("button", {
      name: new RegExp(`^${t("routines.repeatLabel")}`),
    })[0];
    fireEvent.click(repeat);
    fireEvent.click(
      await screen.findByRole("option", { name: t("routines.repeatEveryMinutes") }),
    );
    expect(onChange).toHaveBeenCalledWith({ rule: { kind: "minutes", every: 15 } });
  });
});
