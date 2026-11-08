/**
 * E1 惊喜 / 害羞 expression previews (docs/claude/2026-11-03-e1-r18-fixes.md): the closed set of recipes a window may
 * ask for. Nothing else crosses the bridge: no curve, no bone, no model path. The performance itself and what a model
 * can show of it live in the stage (src/stage/expression-show.ts).
 */
export const EXPRESSION_RECIPES = ['surprise', 'shy'] as const;
export type ExpressionRecipe = typeof EXPRESSION_RECIPES[number];
export const isExpressionRecipe = (value: unknown): value is ExpressionRecipe => value === 'surprise' || value === 'shy';
export const EXPRESSION_RECIPE_NAMES: Readonly<Record<ExpressionRecipe, string>> = Object.freeze({ surprise: '惊喜', shy: '害羞' });

/** What one stage can show of a recipe on the model it has loaded (plain data for the buttons). */
export interface ExpressionSupport {
  recipe: ExpressionRecipe;
  /** At least one part shows. False: the button is greyed out with `reason`. */
  usable: boolean;
  /** The parts this model shows, in the user's words ("眉毛上扬"…). */
  parts: string[];
  /** The parts this model has nothing for (skipped quietly). */
  missing: string[];
  /** Why nothing can show (only when `usable` is false). */
  reason: string;
}

/** The host's answer to a request: whether the pet window was there to show it. */
export interface ExpressionPreviewResult { sent: boolean; petVisible: boolean }
