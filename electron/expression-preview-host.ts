import { isExpressionRecipe, type ExpressionPreviewResult, type ExpressionRecipe } from '../shared/expression-preview';

export interface ExpressionPreviewPorts {
  /** Sends the recipe to every window's stage (desk:expression-preview). */
  send(recipe: ExpressionRecipe): void;
  /** The pet window exists, is shown and not minimised. */
  petVisible(): boolean;
}

/**
 * E1 (docs/claude/2026-11-03-e1-r18-fixes.md): a window's 「预览：惊喜 / 害羞」 or the D2 test command. Only the closed recipe
 * crosses: no curve, bone, model or path. Each stage plays it on its own model and skips what that model lacks; nothing is
 * stored and nothing reaches the chat or her mood.
 */
export function relayExpressionPreview(recipe: unknown, ports: ExpressionPreviewPorts): ExpressionPreviewResult {
  if (!isExpressionRecipe(recipe)) throw new Error('预览类型不正确。');
  const petVisible = ports.petVisible();
  ports.send(recipe);
  return { sent: true, petVisible };
}
