// 体验记录 (the experience journal): the entry types of the brain part (她的大脑：聊天): reply-rhythm, first-char, her-gesture, draft-filter, reply-check, look-turn, send-dropped.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { FATIGUE_PHASES, FIRST_CHAR_PROCESSES, count, finite, has, ms, round, type FirstCharProcess, type JournalTranslate } from '../foundation/journal-fields';
import { CHAT_ACTION_WORDS, type ChatActionWord } from './chat-actions';
import { streamGapsFrom, streamGapsWords, type StreamGaps } from './stream-gaps-journal';
import { reportedModelId } from './claude-model';
import { INTERNAL_WORD_RULES, REPLY_MARKER_STATES, type InternalWordRule, type ReplyMarkerState } from './reply-check';
import { REPLY_RHYTHM_MAX, REPLY_RHYTHM_MIN, RHYTHM_MOODS, USER_PACES, formatRhythmMultiplier, rhythmSourceLabels, type RhythmMood, type RhythmTendency, type UserPace } from './reply-rhythm';
import { SEND_DROP_FROMS, SEND_DROP_WHYS, SEND_HELD_WORDS, type SendDropFrom, type SendDropWhy, type SendHeld } from './send-drop/drop';
import { LOOK_TURN_CARRIES, LOOK_TURN_CARRY_WORDS, LOOK_TURN_SENSE_WORDS, LOOK_TURN_WHYS, LOOK_TURN_WHY_WORDS, type LookTurnCarry, type LookTurnWhy } from './text-first';
import { ASSISTANT_CLI_NAME } from '../foundation/assistant-name';
import { isStreamKindName } from './stream-kind';
import { isJournalPlumbingName } from './claude-session-env';

/** I-085 第 3 步: the look-turn line's reason (shared/brain/text-first.ts has the per-sense words). */
const LOOK_TURN_REASON = { frame: '这一轮附了画面', text: '这一轮她用文字知道你那边', none: '这一轮她没看到画面' } as const;
/**
 * Why a Claude reply did or did not reuse the conversation's warm process (2026-11-12, docs/claude/2026-11-12-warm-reuse-fix.md); a closed
 * list, never text. warm: the same process as the turn before. Otherwise what ended the process the turn before: first (none in this run),
 * context (new conversation, character, persona, model or provider), restart (the process had died), image (the turn before carried a picture),
 * budget (12 turns or 60K characters), idle / hidden (unused for a while), failure (the turn before failed), other; diverged-*: the app's
 * history window did not line up with what Claude had been told: window (it starts outside), short (it ends before Claude's last message),
 * user / reply (that kind of message differs). cap (I-186): more characters were kept warm than the cap allows and hers was used longest ago.
 */
export const FIRST_CHAR_REUSES = ['warm', 'first', 'context', 'restart', 'image', 'budget', 'idle', 'hidden', 'failure', 'other',
  'diverged-window', 'diverged-short', 'diverged-user', 'diverged-reply', 'cap'] as const;
export type FirstCharReuse = (typeof FIRST_CHAR_REUSES)[number];
/**
 * Why a spare Claude process was spawned ahead of her first line (docs/claude/2026-11-22-prewarm-free.md; spawn only, nothing is written to it):
 * start (the app is ready), switch (another character came on stage), visible (her window is seen again), fullscreen (out in Unbound opened),
 * call (a voice call started), context (a new conversation or persona of the one on stage). A closed list, never text.
 */
export const SPARE_WHYS = ['start', 'switch', 'visible', 'fullscreen', 'call', 'context'] as const;
export type SpareWhy = (typeof SPARE_WHYS)[number];
/**
 * I-202 (docs/claude/2026-11-23-claude-login-race.md): what the start gate for Claude Code processes saw. login-lost: a reply failed because
 * Claude Code's login is gone; no new process starts for a minute. One row per lost login (none again until Claude answers once). A closed list, never text.
 */
export const CLAUDE_GATE_EVENTS = ['login-lost'] as const;
export type ClaudeGateEvent = (typeof CLAUDE_GATE_EVENTS)[number];
/**
 * I-209 step 4 (electron/brain/stage-chat/chime-in.ts): one chime-in decision on the full-screen stage (her haiku: yes / no / dropped because
 * someone else said yes first or a newer line came / failed) or her line (said / quiet / undelivered), with how long it took. Never a word.
 * Stage voice (docs/claude/2026-11-24-i209-stage-voice.md): 'undelivered' is split into what happened: dropped (a newer line or your turn came
 * before it showed), failed (her call failed), unreadable (her answer was not one line), busy (the stage never came free), not-shown (her
 * bubble could not take it, or she left). Older rows keep 'undelivered'.
 */
export const CHIME_ASK_OUTCOMES = ['yes', 'no', 'dropped', 'failed'] as const;
export const CHIME_LINE_OUTCOMES = ['said', 'quiet', 'undelivered', 'dropped', 'failed', 'unreadable', 'busy', 'not-shown'] as const;
const CHIME_OUTCOME_WORDS: Readonly<Record<string, string>> = { yes: '想接', no: '不接', dropped: '没等到结果（别人先接了，或有了新的话）', failed: '没判断成', said: '说了', quiet: '最后没说', undelivered: '没送到' };
/** Stage voice: her line's own words where they differ from the decision's (a 'line' row). */
const CHIME_LINE_WORDS: Readonly<Record<string, string>> = { dropped: '有了新的话，这句作废了', failed: '没写成（调用失败）', unreadable: '写回来的不是一句话', busy: '台上一直没空，等太久了', 'not-shown': '没能放进她的气泡（或她已经回去了）' };
export const GESTURE_ANSWERS = ['played', 'cannot', 'busy', 'waiting', 'held', 'dropped', 'failed', 'spaced'] as const;
export type GestureAnswer = (typeof GESTURE_ANSWERS)[number];

/** I-046: the reply-check reason when the marker did not go as asked (with it as asked, the line says what else was found). */
const REPLY_MARKER_REASON: Readonly<Partial<Record<ReplyMarkerState, string>>> = {
  missing: '这条回复她没写开头标记', foreign: '这条回复用的不是这一轮的开头标记', empty: '这条回复的开头标记后面是空的',
};
const INTERNAL_WORD_LABEL: Readonly<Record<InternalWordRule, string>> = {
  marker: '标记', 'body-label': '“正文：”', 'tail-word': '尾注一类的词', 'memorial-field': '纪念提议的字段', 'field-name': '尾注的字段名', 'english-line': '计划里的英文句子',
};
/** 2026-11-22 (docs/claude/2026-11-22-typed-line-drops.md): why a typed line did not go out, and where it was typed. */
const SEND_DROP_LABEL: Readonly<Record<SendDropWhy, string>> = { busy: '她还在回上一句', 'readout-pending': '上一个小指令还没回音', superseded: '中途开始了别的一轮',
  'save-failed': '设置没存上', 'host-refused': '主进程没收下', 'no-ack': '一直没发出，已收回', late: '收回后才到，没有再发' };
const SEND_FROM_LABEL: Readonly<Record<SendDropFrom, string>> = { controls: '控制窗口', companion: '小窗', unbound: '全屏输入框' };
const SEND_HELD_LABEL: Readonly<Record<SendHeld, string>> = { before: '开始发送前（全屏框转交、先停她的回复）', note: '告诉主进程你在打字', save: '保存这个窗口的设置', look: '取这一轮的画面', ipc: '请求送到主进程' };
const SPARE_WHY_WORDS: Readonly<Record<SpareWhy, string>> = { start: '软件刚打开', switch: '切到了这个角色', visible: '她又出现在屏幕上', fullscreen: '她出去了（全屏）', call: '开始通话', context: '新对话或换了设定' };
const GESTURE_ANSWER_LABEL: Readonly<Record<GestureAnswer, string>> = { played: '做了', cannot: '这个模型做不了', busy: '舞台正忙', waiting: '等她说完', held: '心情不让做', dropped: '没等到时机，丢掉了', failed: '没能交给舞台', spaced: '刚做过小表情，隔开' };

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const BRAIN_JOURNAL_TYPES = ['reply-rhythm', 'first-char', 'her-gesture', 'draft-filter', 'reply-check', 'look-turn', 'send-dropped', 'spare-process', 'claude-gate', 'stream-gaps', 'chime-in', 'claude-stream-kind', 'claude-env-dropped'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type BrainJournalInput =
  /** F7 说话节奏: one reply's pace and what set it (numbers and categories only, never the reply). */
  | { type: 'reply-rhythm'; characterId: string; multiplier: number; mood: RhythmMood; fatigue: (typeof FATIGUE_PHASES)[number] | null;
      tendency: RhythmTendency | null; shy: boolean; user: UserPace | null }
  /**
   * F7 停停说说 · 首字: how long one reply took from the user's send until its first character was painted in her bubble (ms), whether
   * the 停停说说 switch was on, and whether the turn carried her earlier reply's unsaid part as background. A number and two flags,
   * so the user's ordinary use answers "did the first character get slower?"; never the text.
   */
  | { type: 'first-char'; characterId: string | null; ms: number; pauseTalk: boolean; carried: boolean;
      /** Where the time went (ms from the send): the content reached the main process, the bubble got it, and how long since the app started / the last reply. */
      contentMs?: number; bubbleMs?: number; sinceStartMs?: number; sinceLastMs?: number;
      /** 2026-11-22: send → the host had the message (the window's settings save, the look, IPC), ms; part of every number above. */
      sendMs?: number;
      /** 2026-11-22: which of the window's waits held sendMs longest (closed word) and how long (ms); see shared/brain/send-drop/drop.ts SendWaits. */
      held?: SendHeld; heldMs?: number;
      /**
       * First-char measuring (2026-11-09): for a Claude reply, whether its process was new (cold / prewarmed) or reused (warm), the turn
       * inside it, Claude's first delta (ms from the send), and how many characters this turn sent / the process had counted before.
       */
      process?: FirstCharProcess; turn?: number; deltaMs?: number; inputChars?: number; sessionChars?: number;
      /** 2026-11-12: why this turn did or did not reuse the warm process, and whether it carried a picture (which retires the process after it). */
      reuse?: FirstCharReuse; image?: boolean;
      /** 2026-11-23: the model id Claude Code reported for this reply's process (reportedModelId; absent when none or odd). */
      model?: string;
      /** I-165: her bubble waited for her voice, so `ms` is when the text arrived and this is when the first sentence showed (ms from the send). */
      shownMs?: number;
      /** 2026-11-24: 'settle-timeout' when the line was written by the settle timer (about 15 s after the reply), not when the first character showed; `ms` is right either way. */
      endedBy?: 'settle-timeout' }
  /** 她选的小动作: the word in the reply tail (or none) and the answer. */
  | { type: 'her-gesture'; characterId: string | null; gesture: ChatActionWord | 'none'; answer: GestureAnswer | null; waited: boolean }
  /** 草稿过滤: what the filter cut from one reply, by four closed groups (counts) and whether the whole reply went. */
  | { type: 'draft-filter'; characterId: string | null; english: number; plan: number; format: number; garbled: number; chars: number; whole: boolean; /** F4: the whole reply went and she said a short line of her own instead (absent otherwise). */ filled?: true }
  /**
   * 回复存档前的体检 (I-046, electron/brain/reply-opening.ts): written when a reply's opening marker did not go as asked, something in front
   * of it was dropped, or protocol words are still in what was shown. `before`: characters dropped in front of the marker; `cut`:
   * characters the cut of a reply without a usable marker dropped, `rules` the protocol words that found it; `residue`: the protocol
   * words still in the shown reply. Closed names and numbers only, never the text.
   */
  | { type: 'reply-check'; characterId: string | null; marker: ReplyMarkerState; before: number; cut: number; rules: InternalWordRule[]; residue: InternalWordRule[];
      whole: boolean; /** F4: nothing of the reply was left and she said a short line of her own instead (absent otherwise). */ filled?: true }
  /** I-085 第 3 步: one chat turn with 和她一起看 (`screen`) or 「发图片」 (`camera`) on: a picture, text, nothing, or a "别看"; `why` only with a picture. Never what she saw. */
  | { type: 'look-turn'; characterId: string | null; screen?: LookTurnCarry; camera?: LookTurnCarry; why?: LookTurnWhy }
  /** 2026-11-22: a typed line that did not go out: why (closed), where it was typed, ms from the send (the full-screen box's submit) to the drop. Never the line. */
  | { type: 'send-dropped'; characterId: string | null; why: SendDropWhy; from: SendDropFrom; waitMs?: number }
  /** 提前待命的进程: one spare chat process spawned ahead of her first line, and why (a closed word). Nothing was sent to it. */
  | { type: 'spare-process'; characterId: string | null; why: SpareWhy }
  /** I-202: the start gate for Claude Code processes saw something (a closed word): login-lost. Never a failure text. */
  | { type: 'claude-gate'; characterId: string | null; event: ClaudeGateEvent }
  /**
   * 2026-11-25 (docs/claude/2026-11-25-peer-messages-refused.md): a Claude Code stream-json event kind the chat reader does not know, once per
   * process: its `type` and, for `system`, its `subtype`, each identifier-shaped (shared/brain/stream-kind.ts) or the word "odd". Never a field's text.
   */
  | { type: 'claude-stream-kind'; characterId: string | null; event: string; subtype?: string }
  /**
   * 2026-11-25 (docs/claude/2026-11-25-claude-env-from-session.md): the app was started from inside a Claude Code session and its endpoint
   * and credential variables were left out of every Claude Code process, once per app run: their names (shared/brain/claude-session-env.ts). Never a value.
   */
  | { type: 'claude-env-dropped'; characterId: string | null; names: string[] }
  /** I-209 step 4: one chime-in decision ('ask', haiku) or line ('line', her chat model) on the full-screen stage; closed words and ms. */
  | { type: 'chime-in'; characterId: string | null; step: 'ask'; outcome: (typeof CHIME_ASK_OUTCOMES)[number]; ms: number }
  | { type: 'chime-in'; characterId: string | null; step: 'line'; outcome: (typeof CHIME_LINE_OUTCOMES)[number]; ms: number }
  /** 2026-11-24 回复文字的停顿: per reply, the largest gap between the model's raw chunks and between the deltas that left the host, and where each fell. Numbers and one closed word. */
  | ({ type: 'stream-gaps'; characterId: string | null } & StreamGaps);

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function brainJournalReason(entry: BrainJournalInput): string {
  switch (entry.type) {
    case 'reply-rhythm': return '这条回复的节奏';
    case 'first-char': return '这条回复的第一个字';
    case 'her-gesture': return entry.gesture === 'none' ? '她这条回复没选小动作' : '她选了一个小动作';
    case 'draft-filter': return entry.whole ? (entry.filled ? '这条回复整条都是草稿，被拦掉了，她另说了一句' : '这条回复整条都是草稿，被拦掉了') : '这条回复里的草稿被拦掉了一部分';
    case 'reply-check': return REPLY_MARKER_REASON[entry.marker] ?? (entry.residue.length ? '这条回复里还留着内部用的词' : '她在开头标记前写的话没有显示');
    case 'spare-process': return '提前备好了一个聊天进程';
    case 'claude-gate': return `${ASSISTANT_CLI_NAME} 的登录没了，先停一分钟不再起新进程`;
    case 'claude-stream-kind': return `${ASSISTANT_CLI_NAME} 的输出里有一种聊天没见过的事件（只记名字）`;
    case 'claude-env-dropped': return `软件是从一个 ${ASSISTANT_CLI_NAME} 会话里打开的：那个会话的连接和登录变量没有交给她的进程（只记名字）`;
    case 'chime-in': return entry.step === 'ask' ? '三人同框：她判断要不要接话（一次 haiku）' : '三人同框：她接话（一次聊天模型）';
    case 'stream-gaps': return '这条回复的文字到达得有多连贯';
    case 'look-turn': return entry.screen === 'frame' || entry.camera === 'frame' ? LOOK_TURN_REASON.frame
      : entry.screen === 'text' || entry.camera === 'text' ? LOOK_TURN_REASON.text : LOOK_TURN_REASON.none;
    case 'send-dropped': return '你打的一句没发出去';
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildBrainJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): BrainJournalInput | null {
  let body: BrainJournalInput | null = null;
  switch (type) {
    case 'reply-rhythm': {
      if (!characterId || !finite(v.multiplier) || v.multiplier < REPLY_RHYTHM_MIN || v.multiplier > REPLY_RHYTHM_MAX || !has(RHYTHM_MOODS, v.mood)
        || (v.fatigue != null && !has(FATIGUE_PHASES, v.fatigue)) || (v.tendency != null && v.tendency !== 'playful' && v.tendency !== 'comfortable')
        || (v.user != null && !has(USER_PACES, v.user))) return null;
      body = { type, characterId, multiplier: round(v.multiplier, 3), mood: v.mood, fatigue: (v.fatigue ?? null) as (typeof FATIGUE_PHASES)[number] | null,
        tendency: (v.tendency ?? null) as RhythmTendency | null, shy: v.shy === true, user: (v.user ?? null) as UserPace | null };
      break;
    }
    case 'first-char':
      if (!finite(v.ms) || v.ms < 0 || v.ms > 600_000 || typeof v.pauseTalk !== 'boolean' || typeof v.carried !== 'boolean') return null;
    {
      const split: { contentMs?: number; bubbleMs?: number; sendMs?: number; sinceStartMs?: number; sinceLastMs?: number; deltaMs?: number; shownMs?: number } = {};
      for (const key of ['contentMs', 'bubbleMs', 'sendMs', 'sinceStartMs', 'sinceLastMs', 'deltaMs', 'shownMs'] as const) { const n = ms(v[key]); if (n !== null) split[key] = n; }
      const size = (n: unknown, max: number) => finite(n) && (n as number) >= 0 && (n as number) <= max ? Math.round(n as number) : null;
      const turn = size(v.turn, 10_000), inputChars = size(v.inputChars, 10_000_000), sessionChars = size(v.sessionChars, 100_000_000);
      const heldMs = ms(v.heldMs), held = has(SEND_HELD_WORDS, v.held) && heldMs !== null && split.sendMs !== undefined ? { held: v.held, heldMs } : {};
      body = { type, characterId, ms: Math.round(v.ms), pauseTalk: v.pauseTalk, carried: v.carried, ...split, ...held,
        ...(has(FIRST_CHAR_PROCESSES, v.process) ? { process: v.process } : {}), ...(turn === null ? {} : { turn }),
        ...(has(FIRST_CHAR_REUSES, v.reuse) ? { reuse: v.reuse } : {}), ...(typeof v.image === 'boolean' ? { image: v.image } : {}), ...(reportedModelId(v.model) === null ? {} : { model: reportedModelId(v.model) as string }),
        ...(inputChars === null ? {} : { inputChars }), ...(sessionChars === null ? {} : { sessionChars }), ...(v.endedBy === 'settle-timeout' ? { endedBy: 'settle-timeout' as const } : {}) };
    }
      break;
    case 'her-gesture':
      if (!(v.gesture === 'none' || has(CHAT_ACTION_WORDS, v.gesture)) || (v.answer != null && !has(GESTURE_ANSWERS, v.answer)) || (v.gesture === 'none') !== (v.answer == null)) return null;
      body = { type, characterId, gesture: v.gesture as ChatActionWord | 'none', answer: (v.answer ?? null) as GestureAnswer | null, waited: v.waited === true };
      break;
    case 'draft-filter': {
      const a = count(v.english, 10_000), b = count(v.plan, 10_000), c = count(v.format, 10_000), d = count(v.garbled, 10_000), chars = count(v.chars, 1_000_000);
      if (a === undefined || b === undefined || c === undefined || d === undefined || chars === undefined) return null;
      body = { type, characterId, english: a, plan: b, format: c, garbled: d, chars, whole: v.whole === true, ...(v.whole === true && v.filled === true ? { filled: true as const } : {}) };
      break;
    }
    case 'reply-check': {
      const before = count(v.before, 1_000_000), cut = count(v.cut, 1_000_000);
      const names = (value: unknown): InternalWordRule[] | null => Array.isArray(value) && value.length <= INTERNAL_WORD_RULES.length && value.every(item => has(INTERNAL_WORD_RULES, item))
        ? INTERNAL_WORD_RULES.filter(rule => value.includes(rule)) : null;
      const rules = names(v.rules), residue = names(v.residue);
      if (!has(REPLY_MARKER_STATES, v.marker) || before === undefined || cut === undefined || !rules || !residue) return null;
      body = { type, characterId, marker: v.marker, before, cut, rules, residue, whole: v.whole === true, ...(v.whole === true && v.filled === true ? { filled: true as const } : {}) };
      break;
    }
    case 'spare-process':
      if (!has(SPARE_WHYS, v.why)) return null;
      body = { type, characterId, why: v.why };
      break;
    case 'stream-gaps': {
      const gaps = streamGapsFrom(v);
      if (!gaps) return null;
      body = { type, characterId, ...gaps };
      break;
    }
    case 'chime-in': {
      const took = ms(v.ms);
      if (took === null || !(v.step === 'ask' ? has(CHIME_ASK_OUTCOMES, v.outcome) : v.step === 'line' && has(CHIME_LINE_OUTCOMES, v.outcome))) return null;
      body = { type, characterId, step: v.step, outcome: v.outcome, ms: took } as BrainJournalInput;
      break;
    }
    case 'claude-gate':
      if (!has(CLAUDE_GATE_EVENTS, v.event)) return null;
      body = { type, characterId, event: v.event };
      break;
    case 'claude-stream-kind':
      // Identifier-shaped names only (a subtype only beside "system"); anything else is not written.
      if (!isStreamKindName(v.event) || (v.subtype !== undefined && (v.event !== 'system' || !isStreamKindName(v.subtype)))) return null;
      body = { type, characterId, event: v.event, ...(v.subtype !== undefined ? { subtype: v.subtype as string } : {}) };
      break;
    case 'claude-env-dropped': {
      // Plumbing names only (identifier-shaped, on the fixed list or of its shape), at most 16; anything else is not written.
      const names = Array.isArray(v.names) ? v.names : null;
      if (!names || !names.length || names.length > 16 || !names.every(isJournalPlumbingName)) return null;
      body = { type, characterId, names: [...new Set(names as string[])].sort() };
      break;
    }
    case 'look-turn': {
      // Closed words only: what each sense gave her, and why a picture went (only with one). Never a description or her own look's line.
      const carries = [v.screen, v.camera].filter(value => value !== undefined);
      const framed = carries.includes('frame');
      if (!carries.length || !carries.every(value => has(LOOK_TURN_CARRIES, value)) || (v.why !== undefined && (!framed || !has(LOOK_TURN_WHYS, v.why)))) return null;
      body = { type, characterId, ...(v.screen !== undefined ? { screen: v.screen as LookTurnCarry } : {}), ...(v.camera !== undefined ? { camera: v.camera as LookTurnCarry } : {}),
        ...(v.why !== undefined ? { why: v.why } : {}) };
      break;
    }
    case 'send-dropped': {
      if (!has(SEND_DROP_WHYS, v.why) || !has(SEND_DROP_FROMS, v.from)) return null;
      const waitMs = ms(v.waitMs);
      body = { type, characterId, why: v.why, from: v.from, ...(waitMs === null ? {} : { waitMs }) };
      break;
    }
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeBrainJournalEntry(entry: BrainJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'reply-rhythm': body = tr('{0}：{1}（{2}）', reason, formatRhythmMultiplier(entry.multiplier), rhythmSourceLabels(entry).map(label => tr(label)).join(tr('、'))); break;
    case 'first-char':
      body = tr('{0}：{1} 秒（停停说说 {2}）', reason, (entry.ms / 1000).toFixed(2), tr(entry.pauseTalk ? (entry.carried ? '开，带了上一条没说完的话' : '开') : '关'));
      if (entry.contentMs !== undefined || entry.bubbleMs !== undefined)
        body += tr('，内容 {0} 秒到主进程、{1} 秒到气泡，离启动 {2} 分、离上一句 {3} 秒', ((entry.contentMs ?? 0) / 1000).toFixed(2), ((entry.bubbleMs ?? 0) / 1000).toFixed(2),
          String(Math.round((entry.sinceStartMs ?? 0) / 60_000)), String(Math.round((entry.sinceLastMs ?? 0) / 1000)));
      if (entry.process !== undefined)
        body += tr('；{0}，第 {1} 轮，这轮发了 {2} 字', tr(entry.process === 'warm' ? '进程热着' : entry.process === 'prewarmed' ? '提前待命的新进程' : '临时新开的进程'),
          String(entry.turn ?? 0), String(entry.inputChars ?? 0));
      if (entry.reuse !== undefined) body += tr('；{0}', entry.reuse === 'warm' ? tr('接着上一轮') : tr('没接上：{0}', entry.reuse)) + (entry.image ? tr('，这轮带了图') : '');
      if (entry.endedBy === 'settle-timeout') body += tr('；这一行是定时器收尾时写的（回复结束约 15 秒后），不是第一个字出现的时刻'); // 2026-11-24
      if (entry.shownMs !== undefined) body += tr('；气泡等她开口，第一句 {0} 秒出现', (entry.shownMs / 1000).toFixed(2)); // I-165
      if (entry.sendMs !== undefined) body += tr('；发出后 {0} 秒主进程才收到', (entry.sendMs / 1000).toFixed(2)); // 2026-11-22
      if (entry.sendMs !== undefined && entry.held !== undefined) body += tr('，最久的一段是{0} {1} 秒', tr(SEND_HELD_LABEL[entry.held]), ((entry.heldMs ?? 0) / 1000).toFixed(2)); // typed-line drops
      break;
    case 'her-gesture': body = entry.gesture === 'none' ? reason : tr('{0}「{1}」：{2}', reason, entry.gesture, entry.answer ? tr(GESTURE_ANSWER_LABEL[entry.answer]) + (entry.waited ? tr('（等她说完）') : '') : ''); break;
    case 'draft-filter':
      body = tr('{0}（英文备注 {1} · 计划 {2} · 格式标记 {3} · 乱码 {4}）', reason, String(entry.english), String(entry.plan), String(entry.format), String(entry.garbled));
      break;
    case 'reply-check': {
      const words = (list: readonly InternalWordRule[]) => list.map(rule => tr(INTERNAL_WORD_LABEL[rule])).join(tr('、'));
      const parts = entry.marker === 'off' ? [tr('没开开头标记')] : [tr('标记前去掉 {0} 字', String(entry.before))];
      if (entry.cut || entry.rules.length) parts.push(tr('按{0}去掉 {1} 字', words(entry.rules), String(entry.cut)));
      if (entry.residue.length) parts.push(tr('显示的话里还有{0}', words(entry.residue)));
      if (entry.whole) parts.push(tr(entry.filled ? '整条都没了，她另说了一句' : '整条都没了'));
      body = tr('{0}（{1}）', reason, parts.join(tr('，')));
      break;
    }
    case 'look-turn': {
      const parts = (['screen', 'camera'] as const).filter(sense => entry[sense] !== undefined)
        .map(sense => tr('{0}：{1}', tr(LOOK_TURN_SENSE_WORDS[sense]), tr(LOOK_TURN_CARRY_WORDS[entry[sense]!])));
      if (entry.why) parts.push(tr(LOOK_TURN_WHY_WORDS[entry.why]));
      body = tr('{0}（{1}）', reason, parts.join(tr('，')));
      break;
    }
    case 'send-dropped':
      body = tr('{0}（{1}，{2}）', reason, tr(SEND_FROM_LABEL[entry.from]), tr(SEND_DROP_LABEL[entry.why]));
      if (entry.waitMs !== undefined) body += tr('：发出后 {0} 秒', (entry.waitMs / 1000).toFixed(2));
      break;
    case 'spare-process': body = tr('{0}（{1}）', reason, tr(SPARE_WHY_WORDS[entry.why])); break;
    case 'chime-in': body = tr('{0}：{1}（{2} 秒）', reason, tr((entry.step === 'line' ? CHIME_LINE_WORDS[entry.outcome] : undefined) ?? CHIME_OUTCOME_WORDS[entry.outcome] ?? entry.outcome), (entry.ms / 1000).toFixed(2)); break;
    case 'stream-gaps': body = tr('{0}：{1}', reason, streamGapsWords(entry, tr)); break;
    case 'claude-stream-kind': body = tr('{0}：{1}', reason, entry.subtype === undefined ? entry.event : `${entry.event}/${entry.subtype}`); break;
    case 'claude-env-dropped': body = tr('{0}：{1}', reason, entry.names.join(', ')); break;
    default: body = reason;
  }
  return body;
}
