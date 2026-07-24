import { createTask, type Task } from "../api/client";
import {
  getRecipe,
  renderRecipe,
  type RecipeContext,
  type RecipeId,
} from "./catalog";

export type LaunchRecipeOptions = {
  id: RecipeId;
  ctx: RecipeContext;
  /** Required working directory for the task. */
  cwd: string;
  project_id?: string;
  agent?: string;
  model?: string;
  permission_mode?: string;
  title?: string;
};

/**
 * Render a prompt recipe and create a normal task (ADR 0013).
 * Project One-Pager digest is injected server-side when project_id/cwd resolve.
 */
export async function launchRecipe(opts: LaunchRecipeOptions): Promise<Task> {
  const recipe = getRecipe(opts.id);
  const prompt = renderRecipe(recipe.promptTemplate, opts.ctx).trim();
  if (!prompt) throw new Error("empty recipe prompt");
  const cwd = opts.cwd.trim();
  if (!cwd) throw new Error("cwd required");

  return createTask({
    cwd,
    prompt,
    project_id: opts.project_id || opts.ctx.project_id,
    agent: opts.agent,
    model: opts.model,
    permission_mode: opts.permission_mode,
    title: opts.title,
  });
}
