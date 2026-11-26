import { ASSISTANT_CLI_NAME } from '../foundation/assistant-name';

// Which model names may reach `claude --model`. Profiles inherited from the Codex edition or the
// OpenAI-compatible/Ollama era can still carry names such as gpt-5, o4-mini or qwen3:8b, which
// Claude Code rejects. Anything that is not a Claude model becomes "" here; what "" then means is the
// caller's: the R20 task model follows Claude Code's default, her chat model is Opus (chatModelArgument).

/** Claude Code's own aliases (`claude --help`, 2.1.316), optionally with the 1M-context suffix. */
const claudeModelAlias = /^(?:default|fable|opus|sonnet|haiku|opusplan)(?:\[1m\])?$/i;

export function claudeModelOrDefault(value: string): string {
  const model = value.trim();
  if (!model || /[\s\u0000-\u001f\u007f]/u.test(model)) return '';
  return claudeModelAlias.test(model) || /claude/i.test(model) || /^arn:aws[a-z-]*:bedrock:/i.test(model) ? model : '';
}

/**
 * I-222: her chat model, as saved in `provider.model`.
 * - "" (every profile saved before 0.2.0, and a new one): Opus. The saved value stays "", so nobody's settings change.
 * - CHAT_MODEL_FOLLOW_CLAUDE_CODE: Claude Code's own default (no --model), for an account that cannot use Opus.
 * - a Claude alias or id: that model. A name from the Codex/OpenAI era (gpt-5, qwen3:8b...) was never chosen in this app: Opus too.
 * The follow value can never be a model name: no alias, no "claude", no Bedrock ARN, and claudeModelOrDefault cleans it to "",
 * so an older build that reads it follows Claude Code's default as well.
 */
export const CHAT_MODEL_FOLLOW_CLAUDE_CODE = 'follow-default';
/** The model an empty chat model means: Claude Code's alias for its current Opus. */
export const IMPLIED_CHAT_MODEL = 'opus';

/**
 * The value of `--model` for a chat-kind Claude Code process ('' = no --model, Claude Code's default). The one place the chat
 * model's meaning lives (electron/brain/claude.ts claudeArguments). `impliedUnavailable`: this run found the account cannot
 * use the implied Opus (electron/brain/chat-model-fallback.ts); an empty chat model then follows Claude Code's default.
 */
export function chatModelArgument(saved: string, impliedUnavailable = false): string {
  if (saved.trim() === CHAT_MODEL_FOLLOW_CLAUDE_CODE) return '';
  const model = claudeModelOrDefault(saved);
  if (model) return model;
  return impliedUnavailable ? '' : IMPLIED_CHAT_MODEL;
}

/** The saved chat model means "Opus because nothing else was chosen" (the only case that may fall back on its own). */
export function impliesChatModel(saved: string): boolean {
  return saved.trim() !== CHAT_MODEL_FOLLOW_CLAUDE_CODE && claudeModelOrDefault(saved) === '';
}

/**
 * Said once in the chat page when the implied Opus was refused and the chat model became the follow choice (electron/brain/chat-model-fallback.ts).
 * A fixed line: the windows show it only when a status event carries exactly this text (src/chat/chat-status-notice.ts); uiText translates it.
 */
export const CHAT_MODEL_FALLBACK_NOTICE = `你的账号现在用不了 Opus，聊天模型已经换成「跟随 ${ASSISTANT_CLI_NAME} 的默认」：她用你的 ${ASSISTANT_CLI_NAME} 自己选的模型，照常陪你聊。想换回来，在设置的「聊天模型」里选。`;

/** The choices the settings page and the internal channel offer (I-222), in this order; the label is Chinese (uiText translates). */
export const CHAT_MODEL_CHOICES: readonly { value: string; label: string }[] = Object.freeze([
  { value: '', label: 'Opus（默认）' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: CHAT_MODEL_FOLLOW_CLAUDE_CODE, label: `跟随 ${ASSISTANT_CLI_NAME} 的默认` },
]);

/**
 * Which choice shows a saved chat model: "" and "opus" both as Opus（默认）; a name that is not a Claude model as Opus too (that is
 * what answers); another Claude alias or id (fable, opusplan, a full id) as itself, which the caller adds as an extra choice.
 */
export function chatModelChoice(saved: string): string {
  const value = saved.trim();
  if (value === CHAT_MODEL_FOLLOW_CLAUDE_CODE) return value;
  const model = claudeModelOrDefault(value);
  if (!model || model.toLowerCase() === IMPLIED_CHAT_MODEL) return '';
  return CHAT_MODEL_CHOICES.some(choice => choice.value === model.toLowerCase()) ? model.toLowerCase() : model;
}

/** A short name for the chat model in labels ("Claude · Opus"); Chinese for the follow choice (uiText translates it). */
export function chatModelLabel(saved: string): string {
  const choice = chatModelChoice(saved);
  if (choice === CHAT_MODEL_FOLLOW_CLAUDE_CODE) return `${ASSISTANT_CLI_NAME} 的默认`;
  if (!choice) return 'Opus';
  return CHAT_MODEL_CHOICES.find(item => item.value === choice)?.label ?? choice;
}

/**
 * Claude Code refused the model it was started with (I-222 step 4). Read from the real CLI (2.1.316, 2026-11-26, `--model` naming a
 * model that does not exist): a synthetic assistant message with `"error":"model_not_found"` and HTTP 404, then a `result` with
 * is_error and the text "There's an issue with the selected model (<name>). It may not exist or you may not have access to it. Run
 * --model to pick a different model."; stderr says `[claude-code:unrecognized_model] {"model":"<name>",...}`. A refusal for lack of
 * access could not be produced here; the CLI's sentence covers both ("may not exist or you may not have access"), which is all this reads.
 * Returns the model the text names, '' when it names none, or null when the text is not a model refusal.
 */
export function refusedClaudeModel(detail: unknown): string | null {
  const text = typeof detail === 'string' ? detail.slice(0, 4000) : '';
  const named = /issue with the selected model \(([^)\n]{1,160})\)/i.exec(text) ?? /unrecognized_model\]?\s*\{[^}]*"model"\s*:\s*"([^"\n]{1,160})"/i.exec(text);
  if (named) return named[1];
  // An organisation that turned the model off (team / enterprise seats: the Pro plan has Opus in Claude Code, the free plan has no Claude
  // Code, Codex T-302). Its wording was not seen here, so only a sentence that says the model itself is unavailable or disabled counts;
  // a limit, a login, an overload or a network error never says that.
  if (/\b(?:model|opus)\b[^.\n]{0,80}\b(?:is not available|isn't available|not available (?:to|for|on|in)|has been disabled|is disabled|not enabled|not allowed)\b/i.test(text)) return '';
  return /may not exist or you may not have access to it|\bmodel_not_found\b|\bunrecognized_model\b/i.test(text) ? '' : null;
}

/**
 * The model id Claude Code's system/init event reports for a chat process (2026-11-23, docs/claude/2026-11-23-opening-marker-plan.md,
 * first step): short, only [A-Za-z0-9._:\[\]-]. Anything else, or nothing, is null (the journal then leaves the field out). A model id is not private.
 */
export const REPORTED_MODEL_MAX = 80;
export function reportedModelId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= REPORTED_MODEL_MAX && /^[A-Za-z0-9._:[\]-]+$/.test(value) ? value : null;
}
