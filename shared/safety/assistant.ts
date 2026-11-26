// I-071 v2 第二步: the user's own Claude in the control window, for using and adjusting
// soft hearts. It is not her: no persona, nothing goes into her memory, diary or journal text. Types and pure helpers shared by
// the host (electron/safety/assistant/) and the panel (src/safety/AssistantPanel.ts). Nothing here grants authority: the host's registry
// (the same tools and tiers as the internal channel) decides every call, and confirm-tier calls always open the popup.
import type { AgentCallOutcome, AgentExposedTier } from './agent-channel';
import { CONVERSION_STEP_LABELS, CONVERSION_TARGET_LABELS, leftOutSummary, type ConversionJobView } from '../cards';

/** Like Claude's own model picker (13:3x). Sonnet by default: quality vs. the user's quota. */
export type AssistantModel = 'sonnet' | 'opus' | 'haiku';
/** Claude Code's `--effort` levels the panel offers (低 / 中 / 高); `claude --help` 2.1.316 also has xhigh and max. */
export type AssistantEffort = 'low' | 'medium' | 'high';
export interface AssistantPrefs { model: AssistantModel; effort: AssistantEffort }
export const ASSISTANT_MODELS: ReadonlyArray<{ value: AssistantModel; label: string }> = Object.freeze([
  { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' },
]);
export const ASSISTANT_EFFORTS: ReadonlyArray<{ value: AssistantEffort; label: string }> = Object.freeze([
  { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' },
]);
export const DEFAULT_ASSISTANT_PREFS: Readonly<AssistantPrefs> = Object.freeze({ model: 'sonnet', effort: 'medium' });

/** A partial update over `previous`; anything else throws a fixed message. */
export function validateAssistantPrefs(value: unknown, previous: AssistantPrefs = DEFAULT_ASSISTANT_PREFS): AssistantPrefs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('助手设置格式不正确。');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'model' && key !== 'effort')) throw new Error('助手设置只有模型和思考强度。');
  const model = record.model ?? previous.model, effort = record.effort ?? previous.effort;
  if (!ASSISTANT_MODELS.some(item => item.value === model)) throw new Error('助手的模型只能是 Sonnet、Opus 或 Haiku。');
  if (!ASSISTANT_EFFORTS.some(item => item.value === effort)) throw new Error('思考强度只能是低、中、高。');
  return { model: model as AssistantModel, effort: effort as AssistantEffort };
}
/** A stored file: anything unreadable is the default. */
export function readAssistantPrefs(value: unknown): AssistantPrefs {
  try { return validateAssistantPrefs(value); } catch { return { ...DEFAULT_ASSISTANT_PREFS }; }
}

/**
 * One line per tool call, written by the host from the registry's own result, never by the model
 */
export type AssistantActionOutcome = 'done' | 'read' | 'declined' | 'timeout' | 'stopped' | 'busy' | 'failed';
export interface AssistantAction {
  tool: string; title: string; tier: AgentExposedTier; outcome: AssistantActionOutcome;
  detail?: string; message?: string;
  /** The host's undo slot this call left (30 minutes; a newer change replaces it). */
  undoId?: string; undone?: boolean;
}
export function assistantActionOf(summary: { tool: string; title: string; tier: AgentExposedTier; outcome: AgentCallOutcome; detail?: string; code?: string; message?: string },
  undoId?: string): AssistantAction {
  // A detail that only repeats the title (use_bundled_model's notice) is left out.
  const detail = summary.detail && summary.detail !== summary.title ? summary.detail.slice(0, 80) : '';
  const base = { tool: summary.tool, title: summary.title.slice(0, 60), tier: summary.tier, ...(detail ? { detail } : {}) };
  if (summary.outcome === 'allowed') return { ...base, outcome: summary.tier === 'read' ? 'read' : 'done', ...(undoId ? { undoId } : {}) };
  const outcome: AssistantActionOutcome = summary.code === 'denied_by_user' ? 'declined' : summary.code === 'confirm_timeout' ? 'timeout'
    : summary.code === 'channel_off' ? 'stopped' : summary.code === 'confirm_busy' ? 'busy' : 'failed';
  return { ...base, outcome, ...(outcome === 'failed' && summary.message ? { message: summary.message.slice(0, 160) } : {}) };
}
/** The Chinese line (the panel translates the fixed parts itself). */
export function assistantActionLine(action: AssistantAction): string {
  const what = `${action.title}${action.detail ? `：${action.detail}` : ''}`;
  switch (action.outcome) {
    case 'read': return `查看了：${what}`;
    case 'done': return action.undone ? `${what} · 已撤回` : `${what} · ${action.undoId ? '可以撤回' : '不能撤回'}`;
    case 'declined': return `没有执行：${what}（你没有允许）`;
    case 'timeout': return `没有执行：${what}（没有确认，算作不允许）`;
    case 'stopped': return `没有执行：${what}（已停止）`;
    case 'busy': return `没有执行：${what}（另一个确认还开着）`;
    default: return `没做成：${what}${action.message ? `（${action.message}）` : ''}`;
  }
}

/** The Chinese line a conversion part stands for in the transcript (state, steps, result; never a memory). */
export function conversionLine(job: ConversionJobView): string {
  const what = `把「${job.sourceName}」转成${CONVERSION_TARGET_LABELS[job.target]}`;
  // Fix 5: items left out are said by count and reason (their titles are on the conversion line the user sees).
  if (job.state === 'done') return `${what}：转好了，新角色「${job.newName}」在角色页（还不是当前角色）${leftOutSummary(job) ? `；${leftOutSummary(job)}，标题列在进度框里` : ''}`;
  if (job.state === 'cancelled') return `${what}：已取消，没有留下任何新东西`;
  if (job.state === 'failed') return `${what}：没有转成（${job.error ?? '出错了'}），原角色没有任何改动`;
  const step = job.steps.find(item => item.status === 'running');
  return `${what}：进行中${step ? `（${CONVERSION_STEP_LABELS[step.id]}）` : ''}`;
}

/** offer_choices (the assistant's own tool): 2–6 buttons; a click comes back as the user's next message. */
export interface AssistantChoices { id: string; question: string; options: string[]; answered?: string }
export const ASSISTANT_CHOICES_TOOL = 'offer_choices';
export function validateChoicesInput(raw: unknown): { question: string; options: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数必须是一个对象。');
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'question' && key !== 'options')) throw new Error('只接受 question 和 options。');
  const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
  const question = record.question === undefined ? '' : clean(record.question, 200);
  if (record.question !== undefined && typeof record.question !== 'string') throw new Error('question 只接受文字。');
  if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 6) throw new Error('options 要 2～6 个。');
  const options = record.options.map(item => {
    if (typeof item !== 'string' || !clean(item, 60)) throw new Error('每个选项是 1～60 字的文字。');
    return clean(item, 60);
  });
  if (new Set(options).size !== options.length) throw new Error('选项不能重复。');
  return { question, options };
}

export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'action'; action: AssistantAction }
  | { kind: 'choices'; choices: AssistantChoices }
  /** I-071 v2 第三步: a conversion this conversation started; the host keeps it current (progress lines, the result, 「取消」). */
  | { kind: 'conversion'; job: ConversionJobView }
  /**
   * I-071 fix 5: a plain line the software itself shows (never the model's words): what a conversion carries, what not, the exact
   * number of calls, from prepare_character_conversion's result, before any name is asked.
   */
  | { kind: 'notice'; text: string };
export const ASSISTANT_NOTICE_LIMIT = 2_000;
export type AssistantStatus = 'streaming' | 'done' | 'stopped' | 'failed';
export interface AssistantMessage {
  id: string; role: 'user' | 'assistant'; at: number; parts: AssistantPart[];
  status?: AssistantStatus; error?: string;
  /** Fix 4 (I-071): foreign tools the turn asked for, names only (a diagnostic in the assistant's own history; never their input). */
  refusedTools?: string[];
}
export interface AssistantView { messages: AssistantMessage[]; busy: boolean; prefs: AssistantPrefs }

/** What the popup shows: host-written text from the tool's own confirmation (never the model's words). */
export interface AssistantConfirmView { id: string; title: string; detail: string; toolTitle: string; buttons: [string, string]; timeoutMs: number }

export type AssistantEvent =
  | { type: 'state'; view: AssistantView }
  | { type: 'text'; messageId: string; text: string }
  | { type: 'part'; messageId: string; part: AssistantPart }
  | { type: 'thinking'; messageId: string; on: boolean }
  | { type: 'confirm'; request: AssistantConfirmView }
  | { type: 'confirm-closed'; id: string }
  | { type: 'conversion'; job: ConversionJobView };

export const ASSISTANT_MESSAGE_LIMIT = 8_000;
export function validateAssistantText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('消息只接受文字。');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('消息是空的。');
  if ([...text].length > ASSISTANT_MESSAGE_LIMIT) throw new Error(`一条消息最多 ${ASSISTANT_MESSAGE_LIMIT} 字。`);
  return text;
}

/**
 * T-239 (Codex review: "纯文本历史中的用户标签可由正文伪造"): text that is not the user's own cannot carry the prompt's section
 * headers (【用户这次说】…); the brackets are swapped for look-alikes, the words stay readable.
 */
const notASection = (text: string) => text.replace(/【/g, '〖').replace(/】/g, '〗');

/**
 * How earlier turns are given back to a fresh process, newest last, within `maxChars`. T-239: one JSON object per line,
 * `{"from":"user"|"assistant","text":…}`: newlines inside a message are escaped, so nothing a message contains (a quoted
 * "\n用户：…", a tool result, a notice) can start a line of its own; and only messages the user typed are `"from":"user"`
 * (their text parts only).
 */
export function assistantTranscript(messages: readonly AssistantMessage[], maxChars = 24_000): string {
  const lines: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const user = message.role === 'user';
    const body = (user ? message.parts.filter(part => part.kind === 'text') : message.parts).map(part => part.kind === 'text' ? part.text
      : part.kind === 'action' ? `〔软件记录：${assistantActionLine(part.action)}〕`
      : part.kind === 'conversion' ? `〔软件记录：${conversionLine(part.job)}〕`
      : part.kind === 'notice' ? `〔软件已经把这段显示给用户（不用重复）：${part.text}〕`
      : `〔给了按钮：${part.choices.question ? `${part.choices.question}｜` : ''}${part.choices.options.join('｜')}${part.choices.answered ? `；用户选了「${part.choices.answered}」` : ''}〕`).join('\n').trim();
    if (!body) continue;
    const note = message.status === 'stopped' ? '这条被用户停止了' : message.status === 'failed' ? '这条没有回完' : '';
    const line = JSON.stringify({ from: user ? 'user' : 'assistant', text: user ? body : notASection(body), ...(note ? { note } : {}) })
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); // valid JSON either way; escaped, they cannot look like a line break
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join('\n\n');
}

/** The one stdin message of a turn: earlier conversation (if any), then what the user just said. */
export function assistantTurnPrompt(earlier: readonly AssistantMessage[], text: string, uiLanguage: 'en' | 'zh-CN' = 'zh-CN'): string {
  const history = assistantTranscript(earlier);
  return [
    history ? `【之前的对话】\n${history}` : '',
    `【界面语言】${uiLanguage === 'en' ? 'English' : '简体中文'}`,
    `【用户这次说】\n${text}`,
  ].filter(Boolean).join('\n\n');
}
