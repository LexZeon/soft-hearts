import type { ChatMessage } from '../shared/contracts';
import type { LanguageProfile } from '../shared/personalize-language';
import { buildCodexChatPrompt } from './conversation-context';
import { chatSettingsSystemText } from './chat-settings';
import { LEADING_BREAKS } from './mood-chat';
import { COMPANION_RULES } from '../shared/companion-rules';
import { PERCEPTION_RULE } from '../shared/perception-rule';
import { COMPANION_REFUSAL_ENABLED, COMPANION_REFUSAL_RULES } from '../shared/companion-refusal-rules';
import { APP_REPLY_OPENING, OPENING_SYSTEM_SENTENCE } from './reply-opening';

/**
 * What a conversation-scoped Claude Code process is told, and when.
 *
 * Fixed for the whole process (argv `--system-prompt`, constant app text only):
 *   CLAUDE_SESSION_SYSTEM_PROMPT, including the companion rules (principles 1, 6 and 7,
 *   shared/companion-rules.ts: fixed here and never in the per-turn message, which R28
 *   showed slows the first token) and the static catalog of settings the
 *   user may ask to change in chat (labels and allowed values; current values are
 *   per turn, and only when the message is about settings). No persona, history or user data goes on the
 *   command line, so nothing private shows up in a process listing and the
 *   Windows command-line limit never applies.
 * Fixed for the whole session (the opening user message, once):
 *   the character persona and the renderer's history window, exactly as the
 *   per-message path builds them today, plus the relationship lines right after the
 *   persona (how long they have known each other, the optional stage, the nickname,
 *   a milestone; 熟悉度). They are inside the composed persona and withoutOpeningContext
 *   takes them out of every follow-up turn.
 * Per turn (every user message):
 *   this turn's mood, recalled memories (with their "do not invent" note),
 *   reply-rhythm rules, the state-tail protocol with this turn's nonce, user
 *   profile / language habits / visual and ambient data, any history the
 *   session has not seen yet, the current user message and its images.
 */
const SESSION_PROMPT_BASE =
  '你在一个桌面陪伴应用里，扮演对话开头那条用户消息中描述的角色。你没有任何工具，也不能读写文件或执行命令。'
  + '这是一段连续的多轮聊天：开头的消息给出角色设定和此前的聊天记录；之后每条消息只带这一轮的私有上下文（当前心情、相关回忆、格式要求和本轮尾注标记）以及新的聊天内容。'
  + '角色设定在整段对话中持续有效；心情、回忆、格式要求和尾注标记一律以最新一条消息为准，较早轮次的标记全部作废。'
  + '严格按每条消息里的要求和格式只输出回复内容；不要提及自己是 Claude Code 或编程助手。';

/**
 * The persistent process's fixed system prompt: the base text, the companion rules, the refusal
 * section ("婉拒也要像她", shared/companion-refusal-rules.ts) only if it is switched on, the settings catalog.
 * The section is OFF by default (it measured about +0.35 s on the
 * first token); COMPANION_REFUSAL_ENABLED in shared/companion-refusal-rules.ts is the one switch for the app.
 * `companionRules: false` is the wording from before the rules existed; `refusalRules: true` / `false` forces the
 * section on / off whatever the switch says. Only the evaluation (scripts/lib/fidelity-*.ts: the first-token A/B and
 * the baselines) passes any of these. The section follows the companion rules, so it is never present without them.
 * The perception fact (shared/perception-rule.ts, pretrial issue 8) comes after the rules (and the section), before the
 * settings catalog; `perception: false` is the wording before it, for the first-token A/B only.
 */
export function claudeSessionSystemPrompt(options: { companionRules?: boolean; refusalRules?: boolean; refusalText?: string; perception?: boolean; opening?: boolean } = {}): string {
  const rules = options.companionRules !== false;
  const refusal = rules && (options.refusalRules ?? COMPANION_REFUSAL_ENABLED);
  // I-046 'fixed': the one opening marker is named here, right after the base (electron/reply-opening.ts); `opening` forces it on / off.
  const opening = options.opening ?? APP_REPLY_OPENING === 'fixed';
  // `refusalText` swaps the section's wording (the evaluation's A/B of the long and the short version); the app never sets it.
  return SESSION_PROMPT_BASE + (opening ? OPENING_SYSTEM_SENTENCE : '') + (rules ? '\n' + COMPANION_RULES : '') + (refusal ? '\n' + (options.refusalText ?? COMPANION_REFUSAL_RULES) : '')
    + (options.perception !== false ? '\n' + PERCEPTION_RULE : '')
    + '\n' + chatSettingsSystemText();
}

export const CLAUDE_SESSION_SYSTEM_PROMPT = claudeSessionSystemPrompt();

/** Leads every follow-up message, so the newest turn's private context is unambiguous. */
export const CLAUDE_FOLLOW_UP_HEADER =
  '【同一段对话的新一轮】开头消息里的角色设定继续有效。以下是这一轮的私有上下文，只以它为准；之前轮次的心情、回忆和尾注标记已作废。';

/**
 * This turn's part of the composed persona: everything after the fixed
 * character persona (buildCompanionPersona joins parts with blank lines, and
 * the host may append ambient or memorial context after that). Returns null
 * when the composition is not recognisably "fixed persona first", in which case
 * the caller repeats the whole persona rather than guessing.
 */
export function turnContext(basePersona: string, turnPersona: string): string | null {
  if (!basePersona) return turnPersona;
  if (turnPersona === basePersona) return '';
  if (turnPersona.startsWith(basePersona + '\n\n')) return turnPersona.slice(basePersona.length + 2);
  return null;
}

/** Messages to put in this turn's `history`: all of it when opening, only unseen ones afterwards. */
export interface SessionTurnPlan { opening: boolean; history: ChatMessage[] }

// The renderer keeps what the user saw; the session keeps what Claude produced.
// For Claude's replies they differ only by the private state/memorial tail, a
// leading run of "<br>" the reply protocol drops (R28), and surrounding blanks.
// User messages are the same object on both sides and are compared exactly: a
// user who types something marker-shaped must not make two different messages
// look alike (X-087).
// The second form is an opening marker cut off mid-nonce (a cancelled or R33
// superseded turn); MoodReplyProtocol hides that fragment from the screen too.
const privateTail = /<\/?sh-(?:state|memorial|setting)-[a-f0-9]{1,32}>[\s\S]*$|<sh-(?:state|memorial|setting)-[a-f0-9]{1,32}$/u;
// I-046 (electron/reply-opening.ts): what she wrote in front of the turn's opening marker was never shown, and the marker itself
// (written again, or closed) neither.
const beforeOpening = /^[\s\S]*?<sh-open(?:-[a-f0-9]{1,32})?>/u;
const openingMarkers = /<\/?sh-open(?:-[a-f0-9]{1,32})?>/gu;
export function sessionText(value: string): string {
  return value.replace(privateTail, '').replace(beforeOpening, '').replace(openingMarkers, '').replace(LEADING_BREAKS, '').trim();
}
const same = (a: ChatMessage, b: ChatMessage) => a.role === b.role
  && (a.role === 'user' ? a.content === b.content : sessionText(a.content) === sessionText(b.content));

/**
 * Lines the renderer's history window up with what this session has already
 * told Claude. The window must start inside what Claude knows and continue
 * past its last message; anything after that overlap is new (an ambient
 * comment, a command receipt, a voice turn) and is sent this turn. Returns null
 * when they diverge (cleared chat, a dropped interrupted turn, an edited or
 * shortened message): the caller must then open a fresh session so Claude never
 * knows more, or something different, than the app's own history.
 */
export function planSessionTurn(known: readonly ChatMessage[] | null, history: readonly ChatMessage[]): SessionTurnPlan | null {
  // A process that has been told nothing yet opens with the full window.
  if (!known?.length) return { opening: true, history: [...history] };
  for (let overlap = Math.min(known.length, history.length); overlap > 0; overlap--) {
    let aligned = true;
    for (let index = 0; index < overlap && aligned; index++)
      aligned = same(history[index], known[known.length - overlap + index]);
    if (aligned) return { opening: false, history: history.slice(overlap) };
  }
  return null;
}

/**
 * 熟悉度: the relationship lines (how long they have known each other, the stage, the nickname, a
 * milestone) sit right after the persona in the composed text, so the opening message and the
 * per-message path carry them. A follow-up turn of a session must not repeat them: R28 showed that
 * every added per-turn sentence slows the first token.
 */
export function withoutOpeningContext(turnContext: string, openingContext?: string | null): string {
  if (!openingContext) return turnContext;
  if (turnContext === openingContext) return '';
  if (turnContext.startsWith(openingContext + '\n\n')) return turnContext.slice(openingContext.length + 2);
  return turnContext;
}

export interface SessionPromptInput {
  plan: SessionTurnPlan;
  /** The character persona as configured (fixed for the session). */
  basePersona: string;
  /** The composed persona for this turn (fixed persona + this turn's context, including the relationship lines). */
  turnPersona: string;
  /** The relationship lines inside `turnPersona` (see withoutOpeningContext); removed from follow-up turns. */
  openingContext?: string | null;
  current: ChatMessage;
  profileContext?: string | null;
  language?: LanguageProfile | null;
}

/**
 * The stdin text for one turn. The opening turn is byte-for-byte the prompt the
 * per-message path sends today; follow-ups drop the fixed persona and the
 * already-known history, and lead with CLAUDE_FOLLOW_UP_HEADER.
 */
export function composeSessionPrompt(input: SessionPromptInput): string {
  const messages = [...input.plan.history, input.current];
  if (input.plan.opening) return buildCodexChatPrompt(input.turnPersona, messages, input.profileContext, input.language);
  const context = withoutOpeningContext(turnContext(input.basePersona, input.turnPersona) ?? input.turnPersona, input.openingContext);
  return buildCodexChatPrompt([CLAUDE_FOLLOW_UP_HEADER, context].filter(Boolean).join('\n\n'), messages, input.profileContext, input.language);
}
