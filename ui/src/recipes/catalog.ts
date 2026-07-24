/**
 * Prompt recipes (ADR 0013) — application behavior as reviewable templates.
 * Launch via createTask / follow-up; no dedicated business APIs.
 */

export type RecipeId =
  | "focus.continue"
  | "cover.update"
  | "project.memory.tidy";

export type Recipe = {
  id: RecipeId;
  /** i18n key under projects.* or recipes.* */
  titleKey: string;
  /** i18n key for button title / hint */
  hintKey?: string;
  /** Template with {{project_name}} {{project_id}} {{cwd}} {{mode}} {{user_note}} */
  promptTemplate: string;
};

export type RecipeContext = {
  project_name?: string;
  project_id?: string;
  cwd?: string;
  mode?: string;
  user_note?: string;
};

export const RECIPE_CATALOG: Record<RecipeId, Recipe> = {
  "focus.continue": {
    id: "focus.continue",
    titleKey: "projects.continueFocus",
    hintKey: "projects.continueHint",
    promptTemplate: `继续当前焦点。优先最小可验证的下一步；除非我明确要求，不要改写 North Star。
若 One-Pager 与代码现状冲突，先指出冲突再动手。
项目：{{project_name}}（{{cwd}}）`,
  },
  "cover.update": {
    id: "cover.update",
    titleKey: "projects.summarize",
    hintKey: "projects.summarizeHint",
    promptTemplate: `请阅读本项目的 ONE_PAGER.md（项目封面，通常在 Kin 项目目录或仓库约定路径）与近期工作线索，更新封面：
- 可更新：Current Focus / 当前焦点、Next / 下一步、结论、未决问题等用户区
- 不要擅自改写 North Star，除非我在补充里说明
- 优先直接编辑 ONE_PAGER.md；若无把握先给出简短 diff 说明再写入
- 不要发明未发生的进度

项目：{{project_name}}
目录：{{cwd}}
模式：{{mode}}
我的补充：{{user_note}}`,
  },
  "project.memory.tidy": {
    id: "project.memory.tidy",
    titleKey: "projects.memoryTidy",
    hintKey: "projects.memoryTidyHint",
    promptTemplate: `整理本项目可沉淀的记忆草稿（结论、陷阱、下一步），写进对话；若用户已有 ONE_PAGER.md，只提议补丁、不擅自改 North Star。
项目：{{project_name}}（{{cwd}}）
补充：{{user_note}}`,
  },
};

/** Simple {{token}} replacement; missing keys → empty string. */
export function renderRecipe(
  template: string,
  ctx: RecipeContext = {},
): string {
  const map: Record<string, string> = {
    project_name: (ctx.project_name ?? "").trim(),
    project_id: (ctx.project_id ?? "").trim(),
    cwd: (ctx.cwd ?? "").trim(),
    mode: (ctx.mode ?? "").trim(),
    user_note: (ctx.user_note ?? "").trim() || "（无）",
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => {
    const k = key.toLowerCase();
    return map[k] ?? "";
  });
}

export function getRecipe(id: RecipeId): Recipe {
  const r = RECIPE_CATALOG[id];
  if (!r) throw new Error(`unknown recipe: ${id}`);
  return r;
}

export function listRecipes(): Recipe[] {
  return (Object.keys(RECIPE_CATALOG) as RecipeId[]).map((id) => RECIPE_CATALOG[id]);
}

