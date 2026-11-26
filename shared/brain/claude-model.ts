// Which model names may reach `claude --model`. Profiles inherited from the Codex edition or the
// OpenAI-compatible/Ollama era can still carry names such as gpt-5, o4-mini or qwen3:8b, which
// Claude Code rejects. Anything that is not a Claude model becomes "" (Claude Code's default).

/** Claude Code's own aliases (`claude --help`, 2.1.316), optionally with the 1M-context suffix. */
const claudeModelAlias = /^(?:default|fable|opus|sonnet|haiku|opusplan)(?:\[1m\])?$/i;

export function claudeModelOrDefault(value: string): string {
  const model = value.trim();
  if (!model || /[\s\u0000-\u001f\u007f]/u.test(model)) return '';
  return claudeModelAlias.test(model) || /claude/i.test(model) || /^arn:aws[a-z-]*:bedrock:/i.test(model) ? model : '';
}

/**
 * The model id Claude Code's system/init event reports for a chat process (2026-11-23, docs/claude/2026-11-23-opening-marker-plan.md,
 * first step): short, only [A-Za-z0-9._:\[\]-]. Anything else, or nothing, is null (the journal then leaves the field out). A model id is not private.
 */
export const REPORTED_MODEL_MAX = 80;
export function reportedModelId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= REPORTED_MODEL_MAX && /^[A-Za-z0-9._:[\]-]+$/.test(value) ? value : null;
}
