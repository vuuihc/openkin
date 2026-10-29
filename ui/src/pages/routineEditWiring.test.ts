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

/** The source between two markers, so a test can speak about one function. */
function block(start: string, end: string): string {
  const from = PAGE.indexOf(start);
  const to = PAGE.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return PAGE.slice(from, to);
}

describe("editing a routine", () => {
  it("opens the form on the routine's own values", () => {
    // The form is the create form; the only difference between the two modes
    // is where its initial values come from.
    expect(PAGE).toContain('{tr("routines.edit")}');
    expect(PAGE).toContain("onClick={() => openEdit(r)}");
    expect(PAGE).toContain("const draft = routineForm(r);");
    expect(PAGE).toContain("setRoutineRule(draft.rule);");
    expect(PAGE).toContain("setRuleZone(draft.ruleZone);");
    expect(PAGE).toContain("setNextRunLocal(");
    expect(PAGE).toContain("toLocalInputValue(new Date(draft.nextRunMs))");
  });

  it("saves through the patch rule, not the whole form", () => {
    // Sending every field is what moves a routine's next run when only its
    // title was edited, so the page must not call `patchRoutine` with the form.
    expect(PAGE).toContain("const patch = routinePatch(editing, {");
    expect(PAGE).toContain("await patchRoutine(editing.id, patch)");
    // Nothing changed is a valid save: close, and do not send an empty PATCH.
    expect(PAGE).toContain("if (!patch) {");
    // The form's zone is part of the schedule: without it a rule written in
    // another zone would be re-stamped with the browser's.
    const scheduled = block("const patch = routinePatch(editing, {", "});");
    expect(scheduled).toContain("ruleZone,");
    expect(PAGE).toContain("ruleZone={ruleZone}");
  });

  it("says which of the two things the form is doing", () => {
    expect(PAGE).toContain(
      'editing ? tr("routines.editPanelTitle") : tr("routines.createPanelTitle")',
    );
    expect(PAGE).toContain('editing ? tr("routines.save") : tr("routines.createAndOpen")');
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
      "setPermissionMode",
      "setIntervalSecs",
      "setRoutineRule",
      "setRuleZone",
      "setNextRunLocal",
    ]) {
      expect(restore).toContain(setter);
    }
    // The draft is taken before the edit fills the form, and put back on close.
    expect(PAGE).toContain("if (!editing) createDraftRef.current = formDraft();");
    expect(PAGE).toContain("if (draft) applyDraft(draft);");
    expect(PAGE).toContain("if (editing) closeForm();");
  });

  it("reports a one-off with no instant instead of greying out Save", () => {
    // A disabled Save button cannot say why it is disabled, and the date-time
    // field is often empty when the form opens, so the check runs on submit.
    expect(PAGE).toContain('if (routineRule?.kind === "once" && nextMs == null) {');
    expect(PAGE).toContain('pushToast(tr("routines.needNextRun"), "error");');
    expect(PAGE).toContain("disabled={creating || !prompt.trim() || !cwd.trim()}");
    expect(PAGE).not.toContain("parseLocalDateTime(nextRunLocal) == null");
  });

  it("holds the form and the rows still while a save is in flight", () => {
    // A save completes on a later render. If the reader can open or close
    // another form meanwhile, the completion closes that one instead.
    expect(PAGE).toContain(
      "disabled={creating}\n              onClick={() => (showCreate ? closeForm() : openCreate())}",
    );
    // Four row actions: run now, edit, pause/resume, delete.
    expect(PAGE.split("disabled={!!busy[r.id] || creating}").length - 1).toBe(4);
  });
});
