// I-222: the settings page's 聊天模型 choice (a select since 0.2.0): Opus（默认）, Sonnet, Haiku, 跟随 Claude Code 的默认. A saved "opus"
// shows as Opus（默认）; another Claude alias or id saved before (fable, opusplan, a full id) shows as itself, as an extra choice, so the
// page never changes it unasked. What each value means for `claude --model`: shared/brain/claude-model.ts.
import { CHAT_MODEL_CHOICES, chatModelChoice, chatModelLabel } from '../../shared/brain';
import { uiText } from '../foundation/ui-language';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';

/** The select's options for this saved chat model, and the one it shows. */
export function chatModelOptions(saved: string): { options: { value: string; label: string }[]; selected: string } {
  const selected = chatModelChoice(saved);
  const options = CHAT_MODEL_CHOICES.map(choice => ({ value: choice.value, label: uiText(choice.label) }));
  if (!options.some(option => option.value === selected)) options.push({ value: selected, label: selected });
  return { options, selected };
}

/** Rebuilds the select for the saved chat model (skipped while it has focus, like the other fields). */
export function syncChatModelSelect(select: HTMLSelectElement | null, saved: string): void {
  if (!select || select.ownerDocument.activeElement === select) return;
  const { options, selected } = chatModelOptions(saved);
  select.replaceChildren(...options.map(option => {
    const element = select.ownerDocument.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    return element;
  }));
  select.value = selected;
}

/** The chat model the select's choice saves; the saved value itself when the choice is what it already shows (no change). */
export function chosenChatModel(choice: string, saved: string): string {
  return choice === chatModelChoice(saved) ? saved : choice;
}

/** "Claude · Opus" for the summary badge. */
export function chatModelBadge(saved: string): string {
  return `${ASSISTANT_NAME} · ${uiText(chatModelLabel(saved))}`;
}
