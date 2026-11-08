import { uiTemplate, uiText } from './ui-language';
import { EXPRESSION_RECIPES, EXPRESSION_RECIPE_NAMES, type ExpressionPreviewResult, type ExpressionRecipe, type ExpressionSupport } from '../../shared/expression-preview';

/** "惊喜：眉毛上扬、睁大眼睛 · 这个模型没有：小"o"嘴（跳过）", each authored piece through the UI language. */
export function supportText(support: ExpressionSupport): string {
  const name = uiText(EXPRESSION_RECIPE_NAMES[support.recipe]);
  if (!support.usable) return uiTemplate`${name}：${uiText(support.reason)}`;
  const shown = uiTemplate`${name}：${support.parts.map(part => uiText(part)).join(uiText('、'))}`;
  return support.missing.length ? uiTemplate`${shown} · 这个模型没有：${support.missing.map(part => uiText(part)).join(uiText('、'))}（跳过）` : shown;
}

export interface ExpressionPreviewHooks {
  /** What this window's stage can show on the model it has loaded (the same model as the pet). Omitted / null: not known here. */
  support?(recipe: ExpressionRecipe): ExpressionSupport | null;
  /** The request; default: window.desktop.playExpressionPreview (every window's stage plays it). */
  play?(recipe: ExpressionRecipe): Promise<ExpressionPreviewResult>;
}

function defaultPlay(): ((recipe: ExpressionRecipe) => Promise<ExpressionPreviewResult>) | null {
  const desktop = (globalThis as { window?: { desktop?: { playExpressionPreview?: (recipe: ExpressionRecipe) => Promise<ExpressionPreviewResult> } } }).window?.desktop;
  return desktop && typeof desktop.playExpressionPreview === 'function' ? recipe => desktop.playExpressionPreview!(recipe) : null;
}

/**
 * E1 「预览：惊喜 / 害羞」 (docs/claude/2026-11-03-e1-r18-fixes.md): two buttons and one status line, in the character page's
 * 「心情和反应」 and in the developer mood panel. A button is greyed out only when this model has nothing for it (the line
 * says why); otherwise it plays on the pet and the line names what shows and what this model skips. Text only via textContent.
 */
export class ExpressionPreviewButtons {
  readonly root: HTMLElement;
  private readonly buttons = new Map<ExpressionRecipe, HTMLButtonElement>();
  private readonly status: HTMLOutputElement;
  private readonly play: ((recipe: ExpressionRecipe) => Promise<ExpressionPreviewResult>) | null;
  private busy = false;
  /** The status line shows a "why it cannot" reason (cleared once it no longer holds). */
  private reasonShown = false;

  constructor(private readonly hooks: ExpressionPreviewHooks = {}, options: { className?: string; label?: string } = {}) {
    const root = this.root = document.createElement('div');
    root.className = `expression-preview${options.className ? ` ${options.className}` : ''}`;
    root.setAttribute('role', 'group'); root.setAttribute('aria-label', uiText('预览表情'));
    root.dataset.moodUi = 'true';
    const label = document.createElement('span'); label.className = 'expression-preview-label'; label.textContent = options.label ?? uiText('预览：');
    root.append(label);
    for (const recipe of EXPRESSION_RECIPES) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.expressionPreview = recipe;
      button.textContent = uiText(EXPRESSION_RECIPE_NAMES[recipe]);
      button.onclick = () => void this.request(recipe);
      this.buttons.set(recipe, button); root.append(button);
    }
    this.status = document.createElement('output'); this.status.className = 'expression-preview-status'; this.status.setAttribute('role', 'status');
    root.append(this.status);
    this.play = hooks.play ?? defaultPlay();
    // The model can change at any time: look again whenever the user comes near the buttons.
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('pointerenter', () => this.refresh());
      root.addEventListener('focusin', () => this.refresh());
    }
    // ...and every 1.5 s while shown (a model that finishes loading after the panel was built must not leave the buttons grey).
    if (typeof setInterval === 'function') {
      const timer = setInterval(() => { if (root.isConnected !== false) this.refresh(); }, 1_500);
      (timer as { unref?: () => void }).unref?.();
    }
    this.refresh();
  }

  private support(recipe: ExpressionRecipe): ExpressionSupport | null {
    try { return this.hooks.support?.(recipe) ?? null; } catch { return null; }
  }

  /** Greys out a recipe this model has nothing for (with the reason as its tooltip). */
  refresh(): void {
    const reasons: string[] = [];
    for (const [recipe, button] of this.buttons) {
      const support = this.support(recipe);
      const usable = !!this.play && (support === null || support.usable);
      button.disabled = this.busy || !usable;
      button.title = support ? supportText(support) : '';
      if (support && !support.usable) reasons.push(supportText(support));
    }
    if (!this.play) { this.setStatus(uiText('这里不能预览。')); this.reasonShown = true; }
    else if (reasons.length === this.buttons.size && !this.busy) { this.setStatus(reasons[0]); this.reasonShown = true; }
    // A reason that no longer holds (the model has loaded since) is cleared, never left standing.
    else if (this.reasonShown) { this.setStatus(''); this.reasonShown = false; }
  }

  private async request(recipe: ExpressionRecipe): Promise<void> {
    if (!this.play || this.busy) return;
    const support = this.support(recipe);
    if (support && !support.usable) { this.refresh(); return; }
    this.busy = true; this.refresh();
    try {
      const result = await this.play(recipe);
      const line = support ? supportText(support) : uiTemplate`${uiText(EXPRESSION_RECIPE_NAMES[recipe])}：已发给桌面上的她。`;
      this.setStatus(result.petVisible ? line : `${line} · ${uiText('桌宠现在没显示，显示后再试。')}`);
    } catch { this.setStatus(uiText('预览没发出去，请再试一次。')); }
    finally { this.reasonShown = false; this.busy = false; this.refresh(); }
  }

  private setStatus(text: string): void { if (this.status.textContent !== text) this.status.textContent = text; }
}

export interface PreviewCardDeps {
  button(id: 'surprise-preview' | 'shy-preview'): Pick<HTMLElement, 'onclick'> | null;
  support(recipe: ExpressionRecipe): ExpressionSupport;
  play(recipe: ExpressionRecipe): Promise<ExpressionPreviewResult>;
  status(line: string): void;
  error(message: string): void;
}
/**
 * E1: the control window's preview card ("惊喜试作" / "害羞试作") plays the same model-agnostic show as the new buttons,
 * on every window (the pet first of all), instead of the old Gene-only host lease. Its footnote names what shows.
 */
export function bindPreviewCardButtons(deps: PreviewCardDeps): void {
  const play = async (recipe: ExpressionRecipe) => {
    try {
      const support = deps.support(recipe);
      if (!support.usable) { deps.status(supportText(support)); return; }
      const result = await deps.play(recipe);
      deps.status(result.petVisible ? supportText(support) : `${supportText(support)} · ${uiText('桌宠现在没显示，显示后再试。')}`);
    } catch (error) { deps.error(String(error)); }
  };
  const surprise = deps.button('surprise-preview'), shy = deps.button('shy-preview');
  if (surprise) surprise.onclick = () => void play('surprise');
  if (shy) shy.onclick = () => void play('shy');
}
