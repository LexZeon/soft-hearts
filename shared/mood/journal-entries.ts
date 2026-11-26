// 体验记录 (the experience journal): the entry types of the mood part (心情和反应): mood-event, mood-label, boredom, longing, her-need, sleep, pose, mood-judge, blush, fatigue-phase, reaction, mood-book, touch.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { FATIGUE_PHASES, count, finite, has, level, ms, round, unit, type JournalTranslate } from '../foundation/journal-fields';
import { MOOD_CONTEXTS as ALL_MOOD_CONTEXTS, MOOD_CHANNELS, type MoodContext, type MoodLabel, type MoodValues } from '../foundation/mood';
import { MOOD_BOOK_BY, MOOD_BOOK_BY_WORDS, MOOD_BOOK_CONTEXT_WORDS, MOOD_BOOK_OUTCOMES, MOOD_BOOK_OUTCOME_WORDS, MOOD_BOOK_VIAS, MOOD_BOOK_VIA_WORDS, moodBookDelta, moodBookDeltaText, type MoodBookBy, type MoodBookOutcome, type MoodBookVia } from '../foundation/mood-book';
import { MOOD_MOMENT_KINDS, MOOD_MOMENT_REASONS } from '../foundation/mood-moments';
import { MOOD_JUDGE_WHYS, MOOD_JUDGE_WHY_IDS, type MoodJudgeWhyId } from '../behaviors/mood-judge/interface';
import { REACTION_EVENTS, REACTION_EVENT_IDS, type ReactionEventId } from '../behaviors/reactions/events';
import { REACTION_BLOCKS, REACTION_BLOCK_WORDS, REACTION_DECIDERS, REACTION_HAIKU_OUTCOMES, type ReactionBlock, type ReactionDecider, type ReactionHaikuOutcome } from '../behaviors/reactions/interface';
import { REACTION_LEVELS, REACTION_LEVEL_WORDS, REACTION_TABLE, type ReactionLevel } from '../behaviors/reactions/knobs';
import { TOUCH_EPISODE_KINDS, TOUCH_FACE_IDS, TOUCH_SPEAK_OUTCOMES, type TouchEpisodeKind, type TouchFaceId, type TouchSpeakOutcome } from '../behaviors/touch-response/interface';
import { TOUCH_FACES } from '../behaviors/touch-response/knobs';
import { HER_NEED_IDS, type HerNeedId } from './her-needs';
import { MOOD_LABELS } from './mood-runtime';
import { buildMoodSnapshot, moodAuxOf, moodNowOf, moodNowText, turnOf, type MoodAux, type MoodNow, type MoodSnapshotInput } from './journal-state';
import { POSE_FOLLOW_KINDS, type PoseFollowKind } from './pose-reactions';
import { TOUCH_PARTS, TOUCH_PART_WORDS, TOUCH_PLACES, type TouchPart, type TouchPlace } from './touch';

/** I-136: the touch row's closed words. */
const TOUCH_KIND_WORDS: Readonly<Record<TouchEpisodeKind, string>> = { click: '你点了她', pull: '你拉了她', pinch: '你捏了她的脸', pat: '你摸了她的头', food: '你喂了她点心' };
const TOUCH_SPEAK_WORDS: Readonly<Record<TouchSpeakOutcome, string>> = { quiet: '她没开口', asked: '她想说点什么', held: '她想说点什么，这会儿没说成',
  asleep: '她在睡觉', off: '自动表现关着' };
const TOUCH_PLACE_WORDS: Readonly<Record<TouchPlace, string>> = { pet: '小窗', unbound: 'Unbound' };

/** Where a mood change came from. The free-text reason of the event never goes further than `moodEventSource`. */
export const MOOD_EVENT_SOURCES = ['touch', 'cheek', 'food', 'chat', 'voice', 'appraisal', 'game', 'soothed', 'dip', 'relief', 'chat-other', 'lift-other',
  // 心情第二批 (shared/foundation/mood-moments.ts): the moments that now come back to her mood
  'moment-back', 'moment-wake', 'moment-dance', 'moment-song', 'moment-special-day', 'moment-keepsake', 'moment-diary', 'moment-shy', 'moment-tailless',
  'moment-music-lift', 'moment-music-settle', 'moment-music-enjoy', 'moment-music-moved', 'moment-music-recognize', // I-077
  'moment-woken', 'moment-sleep-soothed', // I-078 第 2 步
  'moment-gave-taken', // I-086
  'moment-eye-contact', // I-081
  'moment-held-hands', 'moment-high-five', // I-087
  'moment-spoke-answered', 'moment-spoke-unanswered', 'moment-invite-declined', // 松绑
  'moment-look-present', 'moment-look-smile', // I-085 steps 2 and 4
  'moment-peek-answered', // I-104 (Unbound U2): she came up to the lens and you answered
  'moment-waved', // Unbound step 4: the camera saw you wave to her
  'moment-kiss', 'moment-hug'] as const; // I-184: in full-screen Unbound she kissed or hugged you
export type MoodEventSource = (typeof MOOD_EVENT_SOURCES)[number];
export const BOREDOM_LEVELS = ['none', 'look', 'motion', 'speech'] as const;
export type BoredomLevel = (typeof BOREDOM_LEVELS)[number];
export const LONGING_LEVELS = ['none', 'longing', 'sad', 'cry'] as const;
export type LongingLevel = (typeof LONGING_LEVELS)[number];
export const HER_NEED_JOURNAL_EVENTS = ['started', 'soothed', 'faded', 'cleared', 'glow-ended', 'relieved'] as const;
export type HerNeedJournalEvent = (typeof HER_NEED_JOURNAL_EVENTS)[number];
/**
 * P1 第二阶段 (shared/mood/pose-reactions.ts): the user arrived / left (local camera sensing), she caught a yawn, a stretch or a wave from
 * the user ('follow') or let it pass ('pass'), or stretched on her own after the user sat long ('own'). Categories only: never a
 * picture, a position or a number from the camera.
 */
/** I-006 第 2 步: 'pause' (she did something for your breather: stretch / yawn) and 'pause-pass' (she let it go). */
export const POSE_JOURNAL_EVENTS = ['arrive', 'leave', 'follow', 'pass', 'own', 'pause', 'pause-pass'] as const;
export type PoseJournalEvent = (typeof POSE_JOURNAL_EVENTS)[number];
const MOOD_CONTEXTS: readonly MoodContext[] = ALL_MOOD_CONTEXTS;
const LABELS = Object.keys(MOOD_LABELS) as MoodLabel[];
export const BLUSH_SOURCES = ['words', 'pat'] as const;
export type BlushSource = (typeof BLUSH_SOURCES)[number];
export const BLUSH_OUTCOMES = ['fired', 'blocked', 'stage'] as const;
export type BlushOutcome = (typeof BLUSH_OUTCOMES)[number];
export const BLUSH_BLOCKS = ['cooldown', 'showing', 'threshold', 'off'] as const;
export type BlushBlock = (typeof BLUSH_BLOCKS)[number];
export const BLUSH_STAGES = ['shown', 'no-cheek', 'face-busy', 'off', 'size-zero'] as const;
export type BlushStage = (typeof BLUSH_STAGES)[number];

const SOURCE_REASON: Readonly<Record<MoodEventSource, string>> = {
  touch: '你摸了摸头', cheek: '你捏了捏脸', food: '你喂了她点心', chat: '你发来一条消息', voice: '你用语音和她说话',
  appraisal: '你说的话让她心情有点变化', game: '你们玩了猜拳', soothed: '她被你哄好了', dip: '一个人待了一会儿，有点低落',
  relief: '你来了，她松了口气', 'chat-other': '聊天带来的变化', 'lift-other': '她自己的心情变化',
  'moment-back': '你回到电脑前，她有点开心', 'moment-wake': '她睡醒了，轻松了些', 'moment-dance': '跳完一段舞，心情好了些', 'moment-song': '听完一首喜欢的歌，心情好了些',
  'moment-special-day': '说起你的特别的日子，她很开心', 'moment-keepsake': '给你留了点东西，心里轻了些', 'moment-diary': '写完日记，心里轻了些',
  'moment-shy': '害羞了一下，心里暖暖的', 'moment-tailless': '回了你一句，心情跟着动了一点',
  'moment-music-lift': '歌起来了，她跟着来了劲', 'moment-music-settle': '歌慢下来，她跟着放松了', 'moment-music-enjoy': '听歌听得很投入，心情好了些',
  'moment-music-moved': '被一首慢歌打动了，有点感伤', 'moment-music-recognize': '又听到熟悉的歌，她有点开心',
  'moment-woken': '没睡够就被叫醒，有点迷糊', 'moment-sleep-soothed': '睡着时被你轻轻摸了摸，睡得更安稳了',
  'moment-gave-taken': '你接住了她递的东西，她很开心',
  'moment-eye-contact': '和你对视了一会儿，觉得亲近了些',
  'moment-held-hands': '和你牵了手，心里安稳了些', 'moment-high-five': '和你击了掌，挺开心的',
  'moment-spoke-answered': '她先开口，你接了她的话，她挺开心', 'moment-spoke-unanswered': '她先开口你没接，有点失落', 'moment-invite-declined': '邀你玩你说下次，有点失落',
  'moment-look-present': '她看了你一眼，你在，心里安稳了些', 'moment-look-smile': '她看了你一眼，你在笑，她也轻松了些',
  'moment-peek-answered': '她凑到镜头前看你，你回应了她，她挺开心',
  'moment-waved': '你朝她挥了挥手，她心里暖了一下',
  'moment-kiss': '她凑过来亲了你一下，心里甜甜的', 'moment-hug': '她凑过来抱了抱你，心里暖暖的',
};
const APPRAISAL_REASON: Readonly<Record<MoodContext, string>> = {
  neutral: '你说的话让她心情有点变化', positive: '你说的话让她开心', support: '你说的话让她觉得被支持',
  concern: '你说的话让她担心你', disappointment: '你说的话让她有点失落', offense: '你说的话让她觉得被冒犯', fright: '你说的话吓到她了',
};
const BOREDOM_REASON: Readonly<Record<BoredomLevel, string>> = {
  none: '不无聊了', look: '她有点无聊了（会看你一眼）', motion: '她更无聊了（会做个小动作）', speech: '她无聊得想说句话',
};
const LONGING_REASON: Readonly<Record<LongingLevel, string>> = {
  none: '不再想念', longing: '她开始想你了', sad: '她想你想得有点难过', cry: '她太想你了，见到你可能会哭',
};
const NEED_LABEL: Readonly<Record<HerNeedId, string>> = { lonely: '有点闷', dream: '做了个不开心的梦', lowEnergy: '今天有点没精神', chatty: '无聊得想找人说话' };
const NEED_REASON: Readonly<Record<HerNeedJournalEvent, string>> = {
  started: '她有了个小情绪', soothed: '她的小情绪被哄好了', faded: '她的小情绪淡掉了', cleared: '她的小情绪没了',
  'glow-ended': '被哄好的开心过去了', relieved: '你来了，她松了口气',
};
const POSE_FOLLOW_REASON: Readonly<Record<PoseFollowKind, string>> = { yawn: '你打了个哈欠，她也跟着打了一个', stretch: '你伸了个懒腰，她也跟着伸了一下', wave: '你冲她挥手，她也挥手回应' };
const POSE_PASS_REASON: Readonly<Record<PoseFollowKind, string>> = { yawn: '你打了个哈欠，她这次没跟', stretch: '你伸了个懒腰，她这次没跟', wave: '你冲她挥手，她这次没回应' };
const REACTION_DECIDER_LABEL: Readonly<Record<ReactionDecider, string>> = { top: '直接按分数', haiku: 'haiku 挑的', fallback: 'haiku 没答，按她回复的语气', none: '没有挑' };
const REACTION_HAIKU_LABEL: Readonly<Record<ReactionHaikuOutcome, string>> = { answered: 'haiku 答了', none: 'haiku 说不算哪一类', invalid: 'haiku 的回答不合格',
  'low-confidence': 'haiku 拿不准', timeout: 'haiku 超时', error: 'haiku 出错', quota: '今天的 haiku 次数用完了', quiet: '这时不问 haiku', superseded: '你又发了新消息' };
/** A reaction id in a journal line: a table row's id (or a test's fake row), plain and short. */
const REACTION_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const BLUSH_BLOCK_LABEL: Readonly<Record<BlushBlock, string>> = { cooldown: '还在冷却', showing: '正在红', threshold: '这一下没到门槛', off: '脸红开关关着或强度为 0' };
const BLUSH_STAGE_LABEL: Readonly<Record<Exclude<BlushStage, 'shown'>, string>> = { 'no-cheek': '舞台找不到脸颊或模型不支持', 'face-busy': '脸正被别的动作占着', off: '角色页关了能脸红', 'size-zero': '红晕大小是 0' };
const FATIGUE_PHASE_LABEL: Readonly<Record<(typeof FATIGUE_PHASES)[number], string>> = { awake: '清醒', 'light-drowsy': '有点困', drowsy: '犯困', 'falling-asleep': '正在睡着', asleep: '睡着了', 'micro-awake': '半醒' };

// ---------------------------------------------------------------- mood events: free text stops here

/** App-fixed mood reasons (electron/mood/mood.ts, companion.ts, her-needs, rps) and the source each one means. */
const FIXED_MOOD_REASONS: Readonly<Record<string, MoodEventSource>> = {
  '有效摸头': 'touch', '有效捏脸': 'cheek', '接受一份点心': 'food', '收到用户聊天': 'chat', '收到用户语音': 'voice', '收到用户回应': 'chat',
  '和用户玩了猜拳': 'game', '被用户哄好了': 'soothed', '一个人待了一会儿，有点低落': 'dip', '用户来了，松了口气': 'relief',
  ...Object.fromEntries(MOOD_MOMENT_KINDS.map(kind => [MOOD_MOMENT_REASONS[kind], `moment-${kind}` as MoodEventSource])),
};

/**
 * The source of a mood change from the event type and the event's reason. An appraisal's reason is the model's own words and is
 * never looked at (its context says what kind of moment it was); any reason not in the fixed table falls back to a generic source.
 */
export function moodEventSource(type: 'rua' | 'food' | 'chat' | 'appraisal' | 'lift', reason: unknown): MoodEventSource {
  if (type === 'appraisal') return 'appraisal';
  const fixed = typeof reason === 'string' && Object.hasOwn(FIXED_MOOD_REASONS, reason) ? FIXED_MOOD_REASONS[reason] : undefined;
  if (type === 'rua') return fixed === 'cheek' ? 'cheek' : 'touch';
  if (type === 'food') return 'food';
  if (type === 'chat') return fixed === 'chat' || fixed === 'voice' || fixed === 'game' ? fixed : 'chat-other';
  return fixed === 'soothed' || fixed === 'dip' || fixed === 'relief' || fixed?.startsWith('moment-') ? fixed : 'lift-other';
}

function channels(value: unknown): MoodValues | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>, out = {} as MoodValues;
  for (const channel of MOOD_CHANNELS) { if (!finite(source[channel])) return null; out[channel] = level(source[channel]); }
  return out;
}

const CHANNEL_TEMPLATE: Readonly<Record<keyof MoodValues, string>> = { D: '期待 {0}', O: '亲近 {0}', E: '舒适 {0}', N: '激活 {0}', C: '压力 {0}' };

/** The channels that moved by at least one point, biggest first, at most three: "亲近 +6、舒适 +2". */
export function journalDeltaText(before: MoodValues, after: MoodValues, tr: JournalTranslate): string {
  const moved = MOOD_CHANNELS.map(channel => ({ channel, delta: Math.round(after[channel] - before[channel]) }))
    .filter(item => item.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
  return moved.map(item => tr(CHANNEL_TEMPLATE[item.channel], `${item.delta > 0 ? '+' : ''}${item.delta}`)).join(tr('、'));
}

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const MOOD_JOURNAL_TYPES = ['mood-event', 'mood-label', 'boredom', 'longing', 'her-need', 'sleep', 'pose', 'mood-judge', 'blush', 'fatigue-phase', 'reaction', 'mood-book', 'touch', 'mood-snapshot'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type MoodJournalInput =
  | { type: 'mood-event'; characterId: string; source: MoodEventSource; context?: MoodContext; before: MoodValues; after: MoodValues;
      labelBefore: MoodLabel; labelAfter: MoodLabel; count?: number; durationMs?: number; aux?: MoodAux; turn?: string }
  | { type: 'mood-label'; characterId: string; from: MoodLabel; to: MoodLabel }
  | { type: 'boredom'; characterId: string; level: BoredomLevel; value: number; atStart?: boolean }
  | { type: 'longing'; characterId: string; level: LongingLevel; value: number; atStart?: boolean }
  | { type: 'her-need'; characterId: string; event: HerNeedJournalEvent; need: HerNeedId | null; via?: 'touch' | 'food' | 'chat'; snubbed?: boolean; dejection?: number; relief?: number }
  | { type: 'sleep'; characterId: string; event: 'asleep' | 'awake'; phase: (typeof FATIGUE_PHASES)[number] }
  /** P1 第二阶段: what she did about the local pose signals, by category only (kind: what the user did, or her own stretch). */
  | { type: 'pose'; characterId: string; event: PoseJournalEvent; kind: PoseFollowKind | null }
  /**
   * I-027 心情调整员: haiku looked at the last few moments and the app added its bounded correction. Which numbers moved (before and
   * after) and why, as one of the closed reasons (shared/behaviors/mood-judge/interface.ts MOOD_JUDGE_WHYS); never haiku's words,
   * never the user's.
   */
  | { type: 'mood-judge'; characterId: string; why: MoodJudgeWhyId; before: MoodValues; after: MoodValues; labelBefore: MoodLabel; labelAfter: MoodLabel; aux?: MoodAux; turn?: string }
  /** 脸红: a candidate moment, fired or blocked and why; 'stage' lines say whether the companion window could show it. */
  | { type: 'blush'; characterId: string; outcome: BlushOutcome; source: BlushSource | null; why?: BlushBlock; stage?: BlushStage;
      dO?: number; dE?: number; dN?: number; total?: number; threshold?: number }
  /** 困倦阶段变化: from -> to with A, F, W and the two terms of F's target (clock, mood), two decimals. */
  | { type: 'fatigue-phase'; characterId: string; from: (typeof FATIGUE_PHASES)[number]; to: (typeof FATIGUE_PHASES)[number]; A: number; F: number; W: number; clock: number; mood: number }
  /**
   * I-037 新的反应方式 (electron/mood/reactions/host.ts): one thing that could bring a reaction (a class of what the user said, a pat, a
   * pinch, a snack), who decided (haiku, the top score, her warm tail as a fallback, nobody), how haiku's call went, the top
   * candidates with their scores, and each pick with its level and whether it played or why not. Reaction ids are short plain
   * ids (a reaction table row, also a test's fake one); never the user's words or haiku's.
   */
  | { type: 'reaction'; characterId: string; event: ReactionEventId | 'none'; decider: ReactionDecider; haiku: ReactionHaikuOutcome | null;
      candidates: { id: string; score: number }[]; picks: { id: string; level: ReactionLevel; done: boolean; why?: ReactionBlock }[] }
  /**
   * I-136 (electron/mood/touch/brain.ts): one merged touch when she decided whether to say something. Closed values and counts only: the kind,
   * the part (neutral parts), where, how many touches it merged, the face she showed, the reaction picked, the outcome, the chance in tenths.
   */
  | { type: 'touch'; characterId: string; kind: TouchEpisodeKind; part: TouchPart | null; where: TouchPlace; count: number; face: TouchFaceId | 'none';
      reaction: string | null; speak: TouchSpeakOutcome; chance?: number }
  /**
   * I-098 (shared/foundation/mood-book.ts): one typed message's mood book. `by` her own tail or the judge (haiku after she spoke); `outcome`;
   * `via` which haiku answered; with an answer, its context and delta as answered (D/O/E/N/C within ±6, before any blend), `user`
   * when it named the user's state, `ms` the judge's time. Never a reason, a word of chat or of the answer.
   */
  | { type: 'mood-book'; characterId: string; by: MoodBookBy; outcome: MoodBookOutcome; via?: MoodBookVia; context?: MoodContext; delta?: Partial<MoodValues>; user?: true; ms?: number; now?: MoodNow; turn?: string }
  | MoodSnapshotInput;

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function moodJournalReason(entry: MoodJournalInput): string {
  switch (entry.type) {
    case 'mood-event': return entry.source === 'appraisal' ? APPRAISAL_REASON[entry.context ?? 'neutral'] : SOURCE_REASON[entry.source];
    case 'mood-label': return '心情变了';
    case 'boredom': return BOREDOM_REASON[entry.level];
    case 'longing': return LONGING_REASON[entry.level];
    case 'her-need': return entry.event === 'faded' && entry.snubbed ? '没人理，她有点低落' : NEED_REASON[entry.event];
    case 'sleep': return entry.event === 'asleep' ? '她睡着了' : '她醒了';
    case 'pose': return entry.event === 'arrive' ? '你来到电脑前' : entry.event === 'leave' ? '你离开了电脑前' : entry.event === 'own' ? '你坐了很久，她自己伸了个小懒腰'
      : entry.event === 'pause' ? (entry.kind === 'yawn' ? '你停下来歇口气，她困困地打了个哈欠' : '你停下来歇口气，她也伸了一下')
      : entry.event === 'pause-pass' ? '你停下来歇口气，她这次没动'
      : entry.kind ? (entry.event === 'follow' ? POSE_FOLLOW_REASON : POSE_PASS_REASON)[entry.kind] : '她对你的动作有了反应';
    case 'mood-judge': return '她又想了想';
    case 'blush': return entry.outcome === 'fired' ? '她脸红了' : entry.outcome === 'blocked' ? '本来可能脸红，这次被挡住了'
      : entry.stage === 'shown' ? '舞台上看得到这次脸红' : '舞台上显示不出这次脸红';
    case 'fatigue-phase': return '她的困倦阶段变了';
    case 'reaction': return entry.picks.some(pick => pick.done) ? '她有了反应' : entry.picks.length ? '她本来要有反应，这次被挡住了' : '这次她没有特别的反应';
    case 'touch': return TOUCH_KIND_WORDS[entry.kind];
    case 'mood-snapshot': return '心情快照';
    case 'mood-book': return entry.outcome === 'judged' ? '记了一笔心情账' : '这条消息的心情账没记上';
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildMoodJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): MoodJournalInput | null {
  let body: MoodJournalInput | null = null;
  switch (type) {
    case 'mood-event': {
      const before = channels(v.before), after = channels(v.after);
      if (!characterId || !has(MOOD_EVENT_SOURCES, v.source) || !before || !after || !has(LABELS, v.labelBefore) || !has(LABELS, v.labelAfter)) return null;
      const context = has(MOOD_CONTEXTS, v.context) ? v.context : undefined;
      const times = count(v.count), duration = count(v.durationMs, 24 * 3_600_000);
      body = { type, characterId, source: v.source, ...(context ? { context } : {}), before, after, labelBefore: v.labelBefore, labelAfter: v.labelAfter,
        ...(times && times > 1 ? { count: times } : {}), ...(duration ? { durationMs: duration } : {}), ...moodAuxOf(v.aux), ...turnOf(v.turn) };
      break;
    }
    case 'mood-label':
      if (!characterId || !has(LABELS, v.from) || !has(LABELS, v.to) || v.from === v.to) return null;
      body = { type, characterId, from: v.from, to: v.to };
      break;
    case 'boredom':
      if (!characterId || !has(BOREDOM_LEVELS, v.level)) return null;
      body = { type, characterId, level: v.level, value: level(v.value), ...(v.atStart === true ? { atStart: true } : {}) };
      break;
    case 'longing':
      if (!characterId || !has(LONGING_LEVELS, v.level)) return null;
      body = { type, characterId, level: v.level, value: level(v.value), ...(v.atStart === true ? { atStart: true } : {}) };
      break;
    case 'her-need': {
      if (!characterId || !has(HER_NEED_JOURNAL_EVENTS, v.event) || (v.need !== null && !has(HER_NEED_IDS, v.need))) return null;
      const via = v.via === 'touch' || v.via === 'food' || v.via === 'chat' ? v.via : undefined;
      const dejection = unit(v.dejection), relief = unit(v.relief);
      body = { type, characterId, event: v.event, need: (v.need ?? null) as HerNeedId | null, ...(via ? { via } : {}), ...(v.snubbed === true ? { snubbed: true } : {}),
        ...(dejection !== undefined ? { dejection } : {}), ...(relief !== undefined ? { relief } : {}) };
      break;
    }
    case 'sleep':
      if (!characterId || (v.event !== 'asleep' && v.event !== 'awake') || !has(FATIGUE_PHASES, v.phase)) return null;
      body = { type, characterId, event: v.event, phase: v.phase };
      break;
    case 'pose': {
      const followed = v.event === 'follow' || v.event === 'pass' || v.event === 'pause';
      // follow / pass name what the user did, pause what she did (stretch or yawn); the others carry no kind (an own stretch is always a stretch).
      if (!characterId || !has(POSE_JOURNAL_EVENTS, v.event) || (followed ? !has(POSE_FOLLOW_KINDS, v.kind) : v.kind != null)
        || (v.event === 'pause' && v.kind === 'wave')) return null;
      body = { type, characterId, event: v.event, kind: followed ? v.kind as PoseFollowKind : null };
      break;
    }
    case 'mood-judge': {
      const before = channels(v.before), after = channels(v.after);
      if (!characterId || !has(MOOD_JUDGE_WHY_IDS, v.why) || !before || !after || !has(LABELS, v.labelBefore) || !has(LABELS, v.labelAfter)) return null;
      body = { type, characterId, why: v.why, before, after, labelBefore: v.labelBefore, labelAfter: v.labelAfter, ...moodAuxOf(v.aux), ...turnOf(v.turn) };
      break;
    }
    case 'blush': {
      if (!characterId || !has(BLUSH_OUTCOMES, v.outcome) || (v.source != null && !has(BLUSH_SOURCES, v.source)) || (v.why != null && !has(BLUSH_BLOCKS, v.why))
        || (v.stage != null && !has(BLUSH_STAGES, v.stage)) || (v.outcome === 'blocked') !== (v.why != null) || (v.outcome === 'stage') !== (v.stage != null)) return null;
      const num = (n: unknown) => finite(n) ? round(Math.min(100, Math.max(-100, n)), 2) : undefined;
      const extra: { dO?: number; dE?: number; dN?: number; total?: number; threshold?: number } = {};
      for (const key of ['dO', 'dE', 'dN', 'total', 'threshold'] as const) { const n = num(v[key]); if (n !== undefined) extra[key] = n; }
      body = { type, characterId, outcome: v.outcome, source: (v.source ?? null) as BlushSource | null, ...(v.why != null ? { why: v.why as BlushBlock } : {}),
        ...(v.stage != null ? { stage: v.stage as BlushStage } : {}), ...extra };
      break;
    }
    case 'fatigue-phase': {
      const two = (n: unknown) => finite(n) ? round(Math.min(1, Math.max(-1, n)), 2) : undefined;
      const A = two(v.A), F = two(v.F), W = two(v.W), clock = two(v.clock), mood = two(v.mood);
      if (!characterId || !has(FATIGUE_PHASES, v.from) || !has(FATIGUE_PHASES, v.to) || v.from === v.to || A === undefined || F === undefined || W === undefined
        || clock === undefined || mood === undefined) return null;
      body = { type, characterId, from: v.from, to: v.to, A, F, W, clock, mood };
      break;
    }
    case 'reaction': {
      if (!characterId || !(v.event === 'none' || has(REACTION_EVENT_IDS, v.event)) || !has(REACTION_DECIDERS, v.decider)
        || (v.haiku != null && !has(REACTION_HAIKU_OUTCOMES, v.haiku)) || !Array.isArray(v.candidates) || !Array.isArray(v.picks)
        || v.candidates.length > 8 || v.picks.length > 4) return null;
      const candidates: { id: string; score: number }[] = [];
      for (const item of v.candidates as unknown[]) {
        const c = item as Record<string, unknown> | null;
        if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !REACTION_ID.test(c.id) || !finite(c.score)) return null;
        candidates.push({ id: c.id, score: round(Math.min(200, Math.max(-200, c.score)), 1) });
      }
      const picks: { id: string; level: ReactionLevel; done: boolean; why?: ReactionBlock }[] = [];
      for (const item of v.picks as unknown[]) {
        const p = item as Record<string, unknown> | null;
        if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !REACTION_ID.test(p.id) || !has(REACTION_LEVELS, p.level) || typeof p.done !== 'boolean'
          || (p.why != null && !has(REACTION_BLOCKS, p.why)) || (p.done && p.why != null)) return null;
        picks.push({ id: p.id, level: p.level, done: p.done, ...(p.why != null ? { why: p.why as ReactionBlock } : {}) });
      }
      body = { type, characterId, event: v.event as ReactionEventId | 'none', decider: v.decider, haiku: (v.haiku ?? null) as ReactionHaikuOutcome | null, candidates, picks };
      break;
    }
    case 'touch': {
      // I-136: closed values and small counts only; a reaction id must be one of the reaction table's.
      if (!characterId || !has(TOUCH_EPISODE_KINDS, v.kind) || !(v.part === null || has(TOUCH_PARTS, v.part)) || !has(TOUCH_PLACES, v.where)
        || !Number.isSafeInteger(v.count) || (v.count as number) < 1 || !(v.face === 'none' || has(TOUCH_FACE_IDS, v.face))
        || !(v.reaction === null || (typeof v.reaction === 'string' && REACTION_ID.test(v.reaction) && v.reaction in REACTION_TABLE))
        || !has(TOUCH_SPEAK_OUTCOMES, v.speak) || (v.chance !== undefined && !(Number.isSafeInteger(v.chance) && (v.chance as number) >= 0 && (v.chance as number) <= 9))) return null;
      body = { type, characterId, kind: v.kind, part: v.part as TouchPart | null, where: v.where, count: Math.min(999, v.count as number), face: v.face as TouchFaceId | 'none',
        reaction: v.reaction as string | null, speak: v.speak, ...(v.chance !== undefined ? { chance: v.chance as number } : {}) };
      break;
    }
    case 'mood-book': {
      // Closed values and numbers only; a delta or context only with an answer, a delta outside D/O/E/N/C or ±6 refuses the line.
      const judged = v.outcome === 'judged';
      const delta = v.delta === undefined ? undefined : moodBookDelta(v.delta);
      const time = ms(v.ms);
      if (!characterId || !has(MOOD_BOOK_BY, v.by) || !has(MOOD_BOOK_OUTCOMES, v.outcome) || (v.via !== undefined && !has(MOOD_BOOK_VIAS, v.via))
        || (v.by === 'tail' && (!judged || v.via !== undefined)) || delta === null || (!judged && (v.delta !== undefined || v.context !== undefined || v.user !== undefined))
        || (v.context !== undefined && !has(MOOD_CONTEXTS, v.context))) return null;
      body = { type, characterId, by: v.by, outcome: v.outcome, ...(v.via !== undefined ? { via: v.via as MoodBookVia } : {}),
        ...(judged && v.context !== undefined ? { context: v.context as MoodContext } : {}), ...(judged ? { delta: delta ?? {} } : {}),
        ...(judged && v.user === true ? { user: true as const } : {}), ...(time !== null && v.ms !== undefined ? { ms: time } : {}),
        ...(moodNowOf(v.now) ? { now: moodNowOf(v.now) as MoodNow } : {}), ...turnOf(v.turn) };
      break;
    }
    case 'mood-snapshot': {
      body = buildMoodSnapshot(characterId, v);
      if (!body) return null;
      break;
    }
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeMoodJournalEntry(entry: MoodJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'mood-event': {
      const what = entry.source === 'touch' && entry.durationMs ? tr('{0}（{1} 秒）', reason, Math.max(1, Math.round(entry.durationMs / 1000))) : reason;
      const delta = journalDeltaText(entry.before, entry.after, tr), label = tr(MOOD_LABELS[entry.labelAfter]);
      body = delta ? tr('{0} → {1}，现在：{2}', what, delta, label) : tr('{0}，现在：{1}', what, label);
      break;
    }
    case 'mood-label': body = tr('心情：{0} → {1}', tr(MOOD_LABELS[entry.from]), tr(MOOD_LABELS[entry.to])); break;
    case 'boredom': case 'longing': body = entry.atStart ? tr('{0}（打开应用时）', reason) : reason; break;
    case 'her-need': body = entry.need && entry.event === 'started' ? tr('{0}：{1}', reason, tr(NEED_LABEL[entry.need])) : reason; break;
    case 'mood-judge': {
      const delta = journalDeltaText(entry.before, entry.after, tr), label = tr(MOOD_LABELS[entry.labelAfter]), why = tr(MOOD_JUDGE_WHYS[entry.why]);
      body = delta ? tr('{0}（{1}）→ {2}，现在：{3}', reason, why, delta, label) : tr('{0}（{1}），现在：{2}', reason, why, label);
      break;
    }
    case 'blush': {
      const parts: string[] = [];
      if (entry.source) parts.push(tr(entry.source === 'words' ? '暖心话' : '摸头'));
      if (entry.why) parts.push(tr(BLUSH_BLOCK_LABEL[entry.why]));
      if (entry.stage && entry.stage !== 'shown') parts.push(tr(BLUSH_STAGE_LABEL[entry.stage]));
      const rises = ([['dO', '亲近'], ['dE', '舒适'], ['dN', '激活']] as const).filter(([key]) => entry[key] !== undefined)
        .map(([key, name]) => tr('{0} {1}', tr(name), `${(entry[key] ?? 0) > 0 ? '+' : ''}${entry[key]}`));
      if (rises.length) parts.push(rises.join(tr('、')));
      body = parts.length ? tr('{0}（{1}）', reason, parts.join(tr('、'))) : reason;
      break;
    }
    case 'fatigue-phase':
      body = tr('{0}：{1} → {2}（累积 {3} · 疲倦 {4} · 清醒 {5} · 生物钟 {6} · 心情 {7}）', reason, tr(FATIGUE_PHASE_LABEL[entry.from]), tr(FATIGUE_PHASE_LABEL[entry.to]),
        entry.A.toFixed(2), entry.F.toFixed(2), entry.W.toFixed(2), entry.clock.toFixed(2), entry.mood.toFixed(2));
      break;
    case 'reaction': {
      const name = (id: string) => REACTION_TABLE[id] ? tr(REACTION_TABLE[id].label) : id;
      const parts = [tr(entry.event === 'none' ? '不算哪一类' : REACTION_EVENTS[entry.event].label), tr(REACTION_DECIDER_LABEL[entry.decider])];
      if (entry.haiku && entry.haiku !== 'answered') parts.push(tr(REACTION_HAIKU_LABEL[entry.haiku]));
      const picks = entry.picks.map(pick => pick.done ? tr('{0}（{1}）', name(pick.id), tr(REACTION_LEVEL_WORDS[pick.level]))
        : tr('{0}没做：{1}', name(pick.id), tr(pick.why ? REACTION_BLOCK_WORDS[pick.why] : '没做')));
      if (picks.length) parts.push(picks.join(tr('、')));
      body = tr('{0}（{1}）', reason, parts.join(tr('，')));
      break;
    }
    case 'touch': {
      // I-136: where, which part, how many, the face, the reaction, whether she spoke (closed words only).
      const parts = [tr(TOUCH_PLACE_WORDS[entry.where])];
      if (entry.part && entry.part !== 'other') parts.push(tr(TOUCH_PART_WORDS[entry.part]));
      if (entry.count > 1) parts.push(tr('{0} 下', String(entry.count)));
      if (entry.face !== 'none') parts.push(tr(TOUCH_FACES[entry.face].label));
      if (entry.reaction && REACTION_TABLE[entry.reaction]) parts.push(tr(REACTION_TABLE[entry.reaction].label));
      parts.push(tr(TOUCH_SPEAK_WORDS[entry.speak]));
      body = tr('{0}（{1}）', reason, parts.join(tr('，')));
      break;
    }
    case 'mood-book': {
      const parts = [tr(MOOD_BOOK_BY_WORDS[entry.by])];
      if (entry.via) parts.push(tr(MOOD_BOOK_VIA_WORDS[entry.via]));
      if (entry.outcome !== 'judged') parts.push(tr(MOOD_BOOK_OUTCOME_WORDS[entry.outcome]));
      else {
        if (entry.context) parts.push(tr(MOOD_BOOK_CONTEXT_WORDS[entry.context]));
        const delta = moodBookDeltaText(entry.delta ?? {});
        parts.push(delta || tr('心情数不动'));
        if (entry.user) parts.push(tr('写了你的状态'));
      }
      if (entry.ms !== undefined) parts.push(tr('{0} 秒', (entry.ms / 1000).toFixed(1)));
      body = tr('{0}（{1}）', reason, parts.join(tr('，')));
      break;
    }
    case 'mood-snapshot': body = tr('{0}：{1}，{2}', reason, tr(MOOD_LABELS[entry.label]), moodNowText(entry, tr)); break;
    default: body = reason;
  }
  return body;
}
