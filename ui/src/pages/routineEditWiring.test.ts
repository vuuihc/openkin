import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Editing a routine, guarded where a unit cannot reach.
 *
 * `routineEdit.test.ts` holds the patch rule — what counts as a change and what
 * must stay out of the body. What is left is the page: that the row opens the
 * form on the routine itself, that Save goes through the rule instead of
 * sending the whole form, and that an unchanged form closes without a request.
 *
 * Source rather than DOM: mounting this page needs a daemon, a task feed, an
 * agent list and a router.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const PAGE = readFileSync(join(UI, "src/pages/RoutinesPage.tsx"), "utf8");
// The form itself lives in its own component; the page owns the draft, the
// leave guard, and the create/patch calls. Form-layout assertions read the
// component that renders the controls.
const EDITOR = readFileSync(join(UI, "src/components/routine/RoutineEditor.tsx"), "utf8");
// The rows live in their own component too; the page still owns the handlers
// they call and every request the form makes.
const LIST = readFileSync(join(UI, "src/components/routine/RoutineList.tsx"), "utf8");
const NEW_CHAT = readFileSync(join(UI, "src/pages/NewChatPage.tsx"), "utf8");

/** The source between two markers, so a test can speak about one function. */
function block(start: string, end: string, source = PAGE): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("editing a routine", () => {
  it("opens the form on the routine's own values", () => {
    // The form is the create form; the only difference between the two modes
    // is where its initial values come from.
    expect(LIST).toContain('{tr("routines.edit")}');
    expect(LIST).toContain("onClick={() => onEdit(r)}");
    expect(PAGE).toContain("onEdit={(r) => void openEdit(r)}");
    const open = block("const openEdit = async", "focusFormSoon(true);");
    expect(open).toContain("await getRoutine(r.id, view.deviceId)");
    expect(open).toContain("const draft = routineForm(full);");
    expect(open).toContain("rule: draft.rule,");
    expect(open).toContain("ruleZone: draft.ruleZone,");
    expect(open).toContain("toLocalInputValue(new Date(draft.nextRunMs))");
    expect(open).toContain("applyDraft(next);");
  });

  it("saves through the patch rule, not the whole form", () => {
    // Sending every field is what moves a routine's next run when only its
    // title was edited, so the page must not call `patchRoutine` with the form.
    expect(PAGE).toContain("const patch = routinePatch(editing, {");
    expect(PAGE).toContain("await patchRoutine(editing.id, patch, view.deviceId)");
    // Nothing changed is a valid save: close, and do not send an empty PATCH.
    expect(PAGE).toContain("if (!patch) {");
    // The form's zone is part of the schedule: without it a rule written in
    // another zone would be re-stamped with the browser's.
    const scheduled = block("const patch = routinePatch(editing, {", "});");
    expect(scheduled).toContain("ruleZone,");
    expect(EDITOR).toContain("ruleZone={ruleZone}");
  });

  it("says which of the two things the form is doing", () => {
    expect(EDITOR).toContain(
      'editing ? tr("routines.editPanelTitle") : tr("routines.createPanelTitle")',
    );
    expect(EDITOR).toContain('editing ? tr("routines.save") : tr("routines.createAndOpen")');
  });

  it("gives the create form back what the edit borrowed it from", () => {
    // An edit takes over the create form. Every field it overwrites has to come
    // back, or the next new routine would inherit another routine's directory,
    // agent, cadence and permissions.
    const snapshot = block("const formDraft = ", "const applyDraft = ");
    for (const field of [
      "title",
      "prompt",
      "cwd",
      "agentId",
      "model",
      "permissionMode",
      "intervalSecs",
      "routineRule",
      "ruleZone",
      "nextRunLocal",
    ]) {
      expect(snapshot).toContain(field);
    }
    const restore = block("const applyDraft = ", "const closeForm = ");
    for (const setter of [
      "setTitle",
      "setPrompt",
      "setCwd",
      "setAgentId",
      "setModel",
      "setPermissionMode",
      "setIntervalSecs",
      "setRoutineRule",
      "setRuleZone",
      "setNextRunLocal",
    ]) {
      expect(restore).toContain(setter);
    }
    // The draft is taken before the edit fills the form, and put back on close.
    expect(PAGE).toContain("if (!currentEditing) createDraftRef.current = formDraft();");
    expect(PAGE).toContain("if (draft) applyDraft(draft);");
    expect(PAGE).toContain("if (editing && !closeForm()) return;");
  });

  it("reports a one-off with no instant instead of greying out Save", () => {
    // A disabled Save button cannot say why it is disabled, and the date-time
    // field is often empty when the form opens, so the check runs on submit.
    expect(PAGE).toContain('if (routineRule?.kind === "once" && nextMs == null) {');
    expect(PAGE).toContain('pushToast(tr("routines.needNextRun"), "error");');
    expect(EDITOR).toContain("disabled={formLocked || !prompt.trim() || !cwd.trim()}");
    expect(PAGE).not.toContain("parseLocalDateTime(nextRunLocal) == null");
  });

  it("holds the form and the rows still while a save is in flight", () => {
    // A save completes on a later render. If the reader can open or close
    // another form meanwhile, the completion closes that one instead.
    expect(PAGE).toContain(
      "disabled={creating || (machineOffline && !showCreate)}\n              onClick={() => (showCreate ? closeForm() : openCreate())}",
    );
    // Four row actions: run now, edit, pause/resume, delete.
    expect(LIST.split("disabled={!!busy[r.id] || creating || machineOffline}").length - 1).toBe(4);
  });
});

describe("a routine's model", () => {
  it("is picked from the routine's own agent, not from a free list", () => {
    // A model id from another agent's catalog is a run that fails at start,
    // so the picker lists exactly the models the selected agent reports.
    const picker = block("<ModelPicker", "/>", EDITOR);
    expect(picker).toContain("value={model}");
    expect(picker).toContain("models={models}");
    expect(picker).toContain("onChange={(model) => onChange({ model })}");
    expect(picker).toContain("disabled={formLocked}");
    // The picker's "Custom" flag survives a value change by design, so a
    // cleared model needs a fresh mount to stop reading "Custom" with a blank
    // box. The key is what makes the form identity part of that mount.
    expect(picker).toContain('key={`${editing?.id ?? "new"}:${agentId}`}');
    // The page still decides which catalog is the selected agent's.
    expect(PAGE).toContain("models={modelsForAgent(machineAgents, agentId)}");
  });

  it("is cleared when the agent changes", () => {
    // The same rule New Chat applies: the new agent does not know the old
    // catalog's id, and a stored one it cannot run would fail every fire
    // instead of falling back to its default.
    const handler = block("onChange={(agentId) => {", "}}", EDITOR);
    expect(handler).toContain('onChange({ agentId, model: "" });');
  });

  it("travels with create and with a patch", () => {
    expect(PAGE).toContain("...(model.trim() ? { model: model.trim() } : {}),");
    // A patch has to carry an emptied picker too — "" is what puts a routine
    // back on the agent default.
    const edit = block("const patch = routinePatch(editing, {", "});");
    expect(edit).toContain("model,");
    // Opening an edit applies the routine's own form snapshot, including its
    // model, instead of silently reverting to the last draft or agent default.
    const open = block("const openEdit =", "openDraftRef.current = draftKey(next);");
    expect(open).toContain("agentId: draft.agent,");
    expect(open).toContain("model: draft.model,");
    expect(open).toContain("applyDraft(next);");
  });

  it("is carried by New Chat's routine mode instead of being dropped", () => {
    // The model picker stays visible in routine mode; without this line the
    // control looked applied while every run started on the agent's default.
    // The indentation is part of the assertion: the ordinary send a few lines
    // below carries the same expression, and only this one is the schedule's.
    expect(NEW_CHAT).toContain(
      "\n            ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),",
    );
  });
});
