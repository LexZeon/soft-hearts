/**
 * 体验记录 (E2, docs/claude/2026-11-03-experience-journal.md): what happened to her mood and why, one JSON line per moment,
 * kept on this computer only (`<profile>/journal/<local date>.jsonl`) while the user's switch "保留体验记录（只存本机）" is on.
 *
 * THE BOUNDARY (tests/journal-*.test.ts pin it): a line holds times, the character id, a type, fixed enum values, numbers and a
 * plain-language reason that this module writes itself from a fixed table. It never holds the user's message, her reply, the
 * diary, the user profile, a nickname, a model's free-text reason, a file path or a key. `buildJournalEntry` copies field by
 * field from closed sets; free text given to it (for example a mood event's reason) is mapped to a fixed source or dropped.
 */
import { AGENT_SETTING_STATE_LABELS, AGENT_SETTINGS, AGENT_TOOLS, type AgentSettingId } from './agent-channel';
import { APP_STOP_CAUSES, APP_STOP_CAUSE_LABEL, type AppStopCause } from './app-session';
import { HER_LIFE_ACTIVITIES, type HerLifeActivity } from './her-life';
import { HER_NEED_IDS, type HerNeedId } from './her-needs';
import { INNER_LOOP_ACTIONS, INNER_LOOP_RESULTS, type InnerLoopAction, type InnerLoopResult } from './inner-loop';
import { MOOD_CHANNELS, type MoodContext, type MoodLabel, type MoodValues } from './mood';
import { MOOD_LABELS } from './mood-runtime';
import { POSE_FOLLOW_KINDS, type PoseFollowKind } from './pose-reactions';
import { RELATIONSHIP_DIAGNOSTIC_KINDS, RELATIONSHIP_STAGES, type RelationshipDiagnosticKind, type RelationshipStage } from './relationship';
import { CHAT_ACTION_WORDS, type ChatActionWord } from './chat-actions';
import { USER_STATES, type UserStateKind } from './user-state';
import { SPEECH_FAILURES, VOICE_INPUT_FAILURES, type SpeechFailure, type VoiceInputFailure } from './speech-failure';
import { FEED_CATEGORIES, FEED_JOURNAL_OUTCOMES, FEED_LIKINGS, type FeedCategory, type FeedJournalOutcome, type FeedLiking } from './feed-recognition';
import { MOOD_JUDGE_WHYS, MOOD_JUDGE_WHY_IDS, type MoodJudgeWhyId } from './behaviors/mood-judge/interface';
import {
  REACTION_BLOCKS, REACTION_BLOCK_WORDS, REACTION_DECIDERS, REACTION_HAIKU_OUTCOMES, type ReactionBlock, type ReactionDecider, type ReactionHaikuOutcome,
} from './behaviors/reactions/interface';
import { REACTION_EVENTS, REACTION_EVENT_IDS, type ReactionEventId } from './behaviors/reactions/events';
import { INTERNAL_WORD_RULES, REPLY_MARKER_STATES, type InternalWordRule, type ReplyMarkerState } from './reply-check';
import { REACTION_LEVELS, REACTION_LEVEL_WORDS, REACTION_TABLE, type ReactionLevel } from './behaviors/reactions/knobs';
import {
  REPLY_RHYTHM_MAX, REPLY_RHYTHM_MIN, RHYTHM_MOODS, USER_PACES, formatRhythmMultiplier, rhythmSourceLabels,
  type RhythmMood, type RhythmTendency, type UserPace,
} from './reply-rhythm';

export const JOURNAL_VERSION = 1;
/**
 * A wide daily ceiling, 8 MiB (8,388,608 bytes) **with** the `truncated` marker: a line is written only while the marker still
 * fits after it; the line that would not leave room becomes the marker, and nothing more is written that day (earlier lines stay).
 */
export const JOURNAL_DAY_LIMIT_BYTES = 8 * 1024 * 1024;
/** "刚才发生了什么": the newest lines shown in the control window. */
export const JOURNAL_RECENT = 50;

export const JOURNAL_TYPES = ['mood-event', 'mood-label', 'boredom', 'longing', 'inner-loop', 'her-life', 'her-need', 'user-state', 'relationship',
  'music', 'rps', 'sleep', 'app', 'setting', 'character', 'journal', 'truncated', 'reply-rhythm', 'motion', 'speech', 'voice-input', 'pose', 'audio-reading', 'feed',
  'agent-words', 'mood-judge', 'first-char', 'listen-tally', 'watch-tally', 'pause-stuck',
  'reading-time', 'voice-time', 'voice-capture', 'blush', 'her-gesture', 'fatigue-phase', 'topmost-fix', 'launch-time', 'draft-filter', 'reaction', 'reply-check'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

/**
 * 动作跳变记录 (on her own model, which tests never use): when the display guard had to catch a
 * jump, or a physics bone kicked within one frame, which bone, how far, and what she was doing then. Numbers, a bone or morph name
 * of the model and closed activity names; never chat. `guard`: the R29 display guard absorbed it (degrees, or a morph weight);
 * `physics`: a hair or chest bone turned unexpectedly far in one frame after physics (degrees). `block` (色块哨兵, src/stage/stray-pixels.ts): her picture reached far outside where her bones are; `part` says what
 * the stage found (a bad bone or morph weight by name, or `gpu`: its own numbers were fine), `size` the share of the sampled
 * strip pixels drawn (0–1), `cleared` whether it went away after she was sent to the GPU again.
 */
export const MOTION_GLITCH_KINDS = ['guard', 'physics', 'block'] as const;
export type MotionGlitchKind = (typeof MOTION_GLITCH_KINDS)[number];
export const MOTION_ACTIVITIES = ['idle', 'chat-gesture', 'speaking', 'pat', 'feed', 'music', 'her-life', 'expression-preview', 'rps', 'body-motion', 'transition', 'pose', 'her-action'] as const;
export type MotionActivity = (typeof MOTION_ACTIVITIES)[number];
const MOTION_ACTIVITY_LABEL: Readonly<Record<MotionActivity, string>> = { idle: '待机', 'chat-gesture': '说话手势', speaking: '说话', pat: '被摸头', feed: '喂食',
  music: '有音乐', 'her-life': '她自己的事', 'expression-preview': '表情预览', rps: '猜拳', 'body-motion': '自动小动作', transition: '动作切换', pose: '跟着你动',
  'her-action': '她的动作' };
/** A bone or morph name from the model: plain characters, no path separators or control characters, at most 40. */
const PART_NAME = /^[^\u0000-\u001f\u007f\\/:*?"<>|]{1,40}$/u;

/** Where a mood change came from. The free-text reason of the event never goes further than `moodEventSource`. */
export const MOOD_EVENT_SOURCES = ['touch', 'cheek', 'food', 'chat', 'voice', 'appraisal', 'game', 'soothed', 'dip', 'relief', 'chat-other', 'lift-other'] as const;
export type MoodEventSource = (typeof MOOD_EVENT_SOURCES)[number];
export const BOREDOM_LEVELS = ['none', 'look', 'motion', 'speech'] as const;
export type BoredomLevel = (typeof BOREDOM_LEVELS)[number];
export const LONGING_LEVELS = ['none', 'longing', 'sad', 'cry'] as const;
export type LongingLevel = (typeof LONGING_LEVELS)[number];
export const HER_NEED_JOURNAL_EVENTS = ['started', 'soothed', 'faded', 'cleared', 'glow-ended', 'relieved'] as const;
export type HerNeedJournalEvent = (typeof HER_NEED_JOURNAL_EVENTS)[number];
export const RPS_JOURNAL_EVENTS = ['invite', 'accept', 'decline', 'expired', 'start', 'result'] as const;
export type RpsJournalEvent = (typeof RPS_JOURNAL_EVENTS)[number];
export const RPS_ENDS = ['finished', 'timeout', 'quit', 'abandoned'] as const;
export const DANCE_TIERS = ['none', 'nod', 'dance'] as const;
export type JournalDanceTier = (typeof DANCE_TIERS)[number];
export const FATIGUE_PHASES = ['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'] as const;
export const CHARACTER_JOURNAL_EVENTS = ['activate', 'update', 'model-link', 'add', 'remove'] as const;
/**
 * P1 第二阶段 (shared/pose-reactions.ts): the user arrived / left (local camera sensing), she caught a yawn, a stretch or a wave from
 * the user ('follow') or let it pass ('pass'), or stretched on her own after the user sat long ('own'). Categories only: never a
 * picture, a position or a number from the camera.
 */
/** I-006 第 2 步: 'pause' (she did something for your breather: stretch / yawn) and 'pause-pass' (she let it go). */
export const POSE_JOURNAL_EVENTS = ['arrive', 'leave', 'follow', 'pass', 'own', 'pause', 'pause-pass'] as const;
export type PoseJournalEvent = (typeof POSE_JOURNAL_EVENTS)[number];
export type CharacterJournalEvent = (typeof CHARACTER_JOURNAL_EVENTS)[number];
const MOOD_CONTEXTS: readonly MoodContext[] = ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense'];
const LABELS = Object.keys(MOOD_LABELS) as MoodLabel[];

/** What a caller hands to the writer (no time, no reason: the writer adds the time, this module the reason). */
export type JournalInput =
  | { type: 'mood-event'; characterId: string; source: MoodEventSource; context?: MoodContext; before: MoodValues; after: MoodValues;
      labelBefore: MoodLabel; labelAfter: MoodLabel; count?: number; durationMs?: number }
  | { type: 'mood-label'; characterId: string; from: MoodLabel; to: MoodLabel }
  | { type: 'boredom'; characterId: string; level: BoredomLevel; value: number; atStart?: boolean }
  | { type: 'longing'; characterId: string; level: LongingLevel; value: number; atStart?: boolean }
  | { type: 'inner-loop'; characterId: string; cue: 'motion' | 'speech'; decision: InnerLoopAction; result: InnerLoopResult; called: boolean; quiet: boolean; restReminder?: boolean }
  | { type: 'her-life'; characterId: string; from: HerLifeActivity; to: HerLifeActivity; untilMinutes: number | null; test?: boolean }
  | { type: 'her-need'; characterId: string; event: HerNeedJournalEvent; need: HerNeedId | null; via?: 'touch' | 'food' | 'chat'; snubbed?: boolean; dejection?: number; relief?: number }
  | { type: 'user-state'; characterId: string; state: UserStateKind; confidence: number }
  | { type: 'relationship'; characterId: string; kind: RelationshipDiagnosticKind; dayNumber: number; togetherDays: number; qualityDays: number; stage?: RelationshipStage }
  | { type: 'music'; characterId: string; tier: JournalDanceTier; score: number | null }
  | { type: 'rps'; characterId: string; event: RpsJournalEvent; origin?: 'her' | 'user'; rounds?: number; herWins?: number; userWins?: number; draws?: number;
      result?: 'her' | 'user' | 'none'; end?: (typeof RPS_ENDS)[number];
      /** How many lines she said in that match (a count, never her words). */
      spoke?: number }
  | { type: 'sleep'; characterId: string; event: 'asleep' | 'awake'; phase: (typeof FATIGUE_PHASES)[number] }
  /**
   * 应用启动 / 退出 (I-022 "关应用也记"): times, a closed cause and how long it was closed, never anything else.
   * quit: `cause`, how it was asked to quit. start: how the previous run ended — `stopped` 'clean' (it wrote its stop: `stoppedAt`
   * is exact, with its `cause`), 'unclean' (上次没正常退出: `stoppedAt` is its last sign of life and `closedMs` an upper bound,
   * `estimated: true`) or 'unknown' (no record, the first start that keeps one); `clockBack` when the clock is now earlier than that.
   * Lines written before I-022 have none of these and still read back.
   */
  | { type: 'app'; characterId: string | null; event: 'start' | 'quit'; version: string; commit: string | null;
      cause?: AppStopCause; stopped?: 'clean' | 'unclean' | 'unknown'; stoppedAt?: number; closedMs?: number; estimated?: true; clockBack?: true }
  | { type: 'setting'; characterId: string | null; id: AgentSettingId; previous: boolean | number | string | null; value: boolean | number | string | null; via: 'agent' | 'chat' }
  | { type: 'character'; characterId: string; event: CharacterJournalEvent; linked?: boolean }
  | { type: 'journal'; characterId: string | null; event: 'on' | 'off' }
  | { type: 'truncated'; characterId: null; day: string }
  /** F7 说话节奏: one reply's pace and what set it (numbers and categories only, never the reply). */
  | { type: 'reply-rhythm'; characterId: string; multiplier: number; mood: RhythmMood; fatigue: (typeof FATIGUE_PHASES)[number] | null;
      tendency: RhythmTendency | null; shy: boolean; user: UserPace | null }
  /** 动作跳变记录: numbers, the model's bone or morph name and closed activity names (never chat). */
  | { type: 'motion'; characterId: string; kind: MotionGlitchKind; part: 'bone' | 'morph' | 'geometry' | 'gpu'; name: string; size: number; activities: MotionActivity[];
      fps: number | null; frameMs: number | null; cleared?: boolean }
  /** 朗读失败: a Bailian reading that did not play, by closed category only — never the reply, never an address or key. */
  | { type: 'speech'; characterId: string | null; provider: 'bailian'; failure: SpeechFailure }
  /** 语音输入没听到: why recognition failed or was refused, by closed category; never audio, never words. */
  | { type: 'voice-input'; characterId: string | null; engine: 'local' | 'compatible'; failure: VoiceInputFailure; stopped: boolean; /** Loudest level of the clip in whole dBFS (a number, never audio); only on 'empty'. */ peakDb?: number }
  /**
   * 陪听歌、看剧的转写没成 (2026-11-03, electron/asr/ambient-route.ts): why a switch could not turn on (`refused`) or a clip of the
   * played sound was not transcribed, by the same closed categories as voice input; never audio, never words.
   */
  | { type: 'audio-reading'; characterId: string | null; engine: 'local' | 'compatible'; failure: VoiceInputFailure; refused: boolean }
  /** P1 第二阶段: what she did about the local pose signals, by category only (kind: what the user did, or her own stretch). */
  | { type: 'pose'; characterId: string; event: PoseJournalEvent; kind: PoseFollowKind | null }
  /** I-019 喂食认图: one accepted picture, by closed categories only (never the picture, the food's name or her words). */
  | { type: 'feed'; characterId: string; outcome: FeedJournalOutcome; category?: FeedCategory; liking?: FeedLiking }
  /**
   * I-025 需要用户原话: Claude did something that needs the user's consent, on the user's own words in the
   * conversation. Only which item (a setting id or the tool), what it became (a closed short value) and how many characters the
   * words had; never the words themselves.
   */
  | { type: 'agent-words'; characterId: string | null; tool: string; item: string; value: boolean | number | string | null; words: number }
  /**
   * I-027 心情调整员: haiku looked at the last few moments and the app added its bounded correction. Which numbers moved (before and
   * after) and why, as one of the closed reasons (shared/behaviors/mood-judge/interface.ts MOOD_JUDGE_WHYS); never haiku's words,
   * never the user's.
   */
  | { type: 'mood-judge'; characterId: string; why: MoodJudgeWhyId; before: MoodValues; after: MoodValues; labelBefore: MoodLabel; labelAfter: MoodLabel }
  /**
   * F7 停停说说 · 首字: how long one reply took from the user's send until its first character was painted in her bubble (ms), whether
   * the 停停说说 switch was on, and whether the turn carried her earlier reply's unsaid part as background. A number and two flags,
   * so the user's ordinary use answers "did the first character get slower?"; never the text.
   */
  | { type: 'first-char'; characterId: string | null; ms: number; pauseTalk: boolean; carried: boolean;
      /** Where the time went (ms from the send): the content reached the main process, the bubble got it, and how long since the app started / the last reply. */
      contentMs?: number; bubbleMs?: number; sinceStartMs?: number; sinceLastMs?: number }
  /** 她的朗读时间: one reply's reading. firstAudioMs: first text shown -> first sound; waitMs: accepted -> handed to the voice. */
  | { type: 'reading-time'; characterId: string | null; firstAudioMs: number | null; waitMs: number | null; chars: number; provider: ReadingProvider;
      result: ReadingResult; why: ReadingWhy | null; firstSinceStart: boolean }
  /** 语音输入时间: from the end of the user's speech to the text (ms), the recognition alone (ms), the clip's length (s); never the words. */
  | { type: 'voice-time'; characterId: string | null; ms: number | null; recognizeMs: number | null; seconds: number | null; result: VoiceTimeResult;
      engine: (typeof VOICE_TIME_ENGINES)[number] }
  /** 语音输入的麦克风数字: what one capture received (chunks, loudest sample and RMS, the gate, sample rate, device kind, her speaking pause). */
  | { type: 'voice-capture'; characterId: string | null; end: VoiceCaptureEnd; chunks: number; peak: number; rms: number; threshold: number;
      sampleRate: number; device: (typeof VOICE_DEVICES)[number]; pausedAtStart: boolean; pausedMs: number; seconds: number }
  /** 脸红: a candidate moment, fired or blocked and why; 'stage' lines say whether the pet window could show it. */
  | { type: 'blush'; characterId: string; outcome: BlushOutcome; source: BlushSource | null; why?: BlushBlock; stage?: BlushStage;
      dO?: number; dE?: number; dN?: number; total?: number; threshold?: number }
  /** 她选的小动作: the word in the reply tail (or none) and the answer. */
  | { type: 'her-gesture'; characterId: string | null; gesture: ChatActionWord | 'none'; answer: GestureAnswer | null; waited: boolean }
  /** 困倦阶段变化: from -> to with A, F, W and the two terms of F's target (clock, mood), two decimals. */
  | { type: 'fatigue-phase'; characterId: string; from: (typeof FATIGUE_PHASES)[number]; to: (typeof FATIGUE_PHASES)[number]; A: number; F: number; W: number; clock: number; mood: number }
  /** 置顶守护补回: one repair of the pet window's topmost style (never the foreground app). */
  | { type: 'topmost-fix'; characterId: string | null; outcome: TopmostFixOutcome; visible: boolean; nth: number }
  /** 应用启动到她出现: ms from the app's start to the pet stage fully faded in. */
  | { type: 'launch-time'; characterId: string | null; ms: number }
  /** 草稿过滤: what the filter cut from one reply, by four closed groups (counts) and whether the whole reply went. */
  | { type: 'draft-filter'; characterId: string | null; english: number; plan: number; format: number; garbled: number; chars: number; whole: boolean; /** F4: the whole reply went and she said a short line of her own instead (absent otherwise). */ filled?: true }
  /**
   * 回复存档前的体检 (I-046, electron/reply-opening.ts): written when a reply's opening marker did not go as asked, something in front
   * of it was dropped, or protocol words are still in what was shown. `before`: characters dropped in front of the marker; `cut`:
   * characters the cut of a reply without a usable marker dropped, `rules` the protocol words that found it; `residue`: the protocol
   * words still in the shown reply. Closed names and numbers only, never the text.
   */
  | { type: 'reply-check'; characterId: string | null; marker: ReplyMarkerState; before: number; cut: number; rules: InternalWordRule[]; residue: InternalWordRule[];
      whole: boolean; /** F4: nothing of the reply was left and she said a short line of her own instead (absent otherwise). */ filled?: true }
  /**
   * 陪听的一分钟: what happened to the clips of the played sound in the last minute, as counts only —
   * received, skipped because listening was paused, transcribed with words, transcribed with none, failed. Never audio or words.
   */
  | { type: 'listen-tally'; characterId: string | null; received: number; skippedPaused: number; withText: number; empty: number; failed: number }
  /** 一起看的一分钟 (I-048): counts and timings only, never a description, a keyword or a picture. */
  | { type: 'watch-tally'; characterId: string | null; described: number; skipped: number; failed: number; late: number; summaries: number; heard: number; haikuCalls: number; haikuMs: number; keywordHits: number; cacheFiles: number; cacheKb: number }
  /** 一个"暂停听"没等到该有的结束，被强制放开 (2026-11-06, 朗读过后听不见了): which pause it was; nothing else. */
  | { type: 'pause-stuck'; characterId: string | null; what: PauseStuckKind }
  /**
   * I-037 新的反应方式 (electron/reactions/host.ts): one thing that could bring a reaction (a class of what the user said, a pat, a
   * pinch, a snack), who decided (haiku, the top score, her warm tail as a fallback, nobody), how haiku's call went, the top
   * candidates with their scores, and each pick with its level and whether it played or why not. Reaction ids are short plain
   * ids (a reaction table row, also a test's fake one); never the user's words or haiku's.
   */
  | { type: 'reaction'; characterId: string; event: ReactionEventId | 'none'; decider: ReactionDecider; haiku: ReactionHaikuOutcome | null;
      candidates: { id: string; score: number }[]; picks: { id: string; level: ReactionLevel; done: boolean; why?: ReactionBlock }[] };
/**
 * 第一批新记录项 (2026-11-06, docs/claude/2026-11-06-journal-batch1.md): numbers and closed categories only, never a word of chat.
 * reading-time: one reply's reading (how long until the first sound, how long it waited, how many characters, which voice, how it ended).
 */
export const READING_PROVIDERS = ['system', 'bailian', 'other'] as const;
export type ReadingProvider = (typeof READING_PROVIDERS)[number];
export const READING_RESULTS = ['played', 'partial', 'unread'] as const;
export type ReadingResult = (typeof READING_RESULTS)[number];
export const READING_WHYS = ['cancelled', 'off', 'failed', 'hidden'] as const;
export type ReadingWhy = (typeof READING_WHYS)[number];
export const VOICE_TIME_RESULTS = ['text', 'no-sound', 'no-words', 'failed'] as const;
export type VoiceTimeResult = (typeof VOICE_TIME_RESULTS)[number];
export const VOICE_TIME_ENGINES = ['local', 'compatible', 'other'] as const;
export const VOICE_CAPTURE_ENDS = ['stopped', 'no-sound', 'failed'] as const;
export type VoiceCaptureEnd = (typeof VOICE_CAPTURE_ENDS)[number];
export const VOICE_DEVICES = ['default', 'specified', 'unknown'] as const;
export const BLUSH_SOURCES = ['words', 'pat'] as const;
export type BlushSource = (typeof BLUSH_SOURCES)[number];
export const BLUSH_OUTCOMES = ['fired', 'blocked', 'stage'] as const;
export type BlushOutcome = (typeof BLUSH_OUTCOMES)[number];
export const BLUSH_BLOCKS = ['cooldown', 'showing', 'threshold', 'off'] as const;
export type BlushBlock = (typeof BLUSH_BLOCKS)[number];
export const BLUSH_STAGES = ['shown', 'no-cheek', 'face-busy', 'off', 'size-zero'] as const;
export type BlushStage = (typeof BLUSH_STAGES)[number];
export const GESTURE_ANSWERS = ['played', 'cannot', 'busy', 'waiting', 'held', 'dropped', 'failed'] as const;
export type GestureAnswer = (typeof GESTURE_ANSWERS)[number];
export const TOPMOST_FIX_OUTCOMES = ['applied', 'forced', 'failed', 'unchanged'] as const;
export type TopmostFixOutcome = (typeof TOPMOST_FIX_OUTCOMES)[number];

export const PAUSE_STUCK_KINDS = ['speech-route', 'speaking-window', 'mic-window', 'listen-pause', 'ambient-suspend'] as const;
export type PauseStuckKind = (typeof PAUSE_STUCK_KINDS)[number];
const PAUSE_STUCK_LABEL: Readonly<Record<PauseStuckKind, string>> = {
  'speech-route': '朗读的路由没人收尾', 'speaking-window': '窗口说"她在说话"后没再说停', 'mic-window': '麦克风因朗读暂停后没恢复',
  'listen-pause': '陪听因朗读暂停后没恢复', 'ambient-suspend': '系统声音理解因朗读暂停后没恢复',
};

/** One line of a journal file: the input's fields plus the version, the time and the fixed plain-language reason. */
export type JournalEntry = JournalInput & { v: 1; at: number; time: string; reason: string };

// ---------------------------------------------------------------- the fixed plain-language reasons

const SOURCE_REASON: Readonly<Record<MoodEventSource, string>> = {
  touch: '你摸了摸头', cheek: '你捏了捏脸', food: '你喂了她点心', chat: '你发来一条消息', voice: '你用语音和她说话',
  appraisal: '你说的话让她心情有点变化', game: '你们玩了猜拳', soothed: '她被你哄好了', dip: '一个人待了一会儿，有点低落',
  relief: '你来了，她松了口气', 'chat-other': '聊天带来的变化', 'lift-other': '她自己的心情变化',
};
const APPRAISAL_REASON: Readonly<Record<MoodContext, string>> = {
  neutral: '你说的话让她心情有点变化', positive: '你说的话让她开心', support: '你说的话让她觉得被支持',
  concern: '你说的话让她担心你', disappointment: '你说的话让她有点失落', offense: '你说的话让她觉得被冒犯',
};
const BOREDOM_REASON: Readonly<Record<BoredomLevel, string>> = {
  none: '不无聊了', look: '她有点无聊了（会看你一眼）', motion: '她更无聊了（会做个小动作）', speech: '她无聊得想说句话',
};
const LONGING_REASON: Readonly<Record<LongingLevel, string>> = {
  none: '不再想念', longing: '她开始想你了', sad: '她想你想得有点难过', cry: '她太想你了，见到你可能会哭',
};
const DECISION_LABEL: Readonly<Record<InnerLoopAction, string>> = {
  none: '什么都不做', motion: '做个小动作', look: '看你一眼', speak: '说一句话', switch: '换件事做', invite: '邀你猜拳',
};
const RESULT_LABEL: Readonly<Record<InnerLoopResult, string>> = {
  ok: '完成', delivered: '说出口了', undelivered: '没说出来', invalid: '回答无效', timeout: '超时', cancelled: '取消了', error: '出错了', asleep: '睡着了，不说',
};
const ACTIVITY_LABEL: Readonly<Record<HerLifeActivity, string>> = { company: '陪着你', daydream: '发呆', humming: '哼歌', thinking: '想事情', drowsy: '犯困', watching: '跟着看' };
const NEED_LABEL: Readonly<Record<HerNeedId, string>> = { lonely: '有点闷', dream: '做了个不开心的梦', lowEnergy: '今天有点没精神', chatty: '无聊得想找人说话' };
const NEED_REASON: Readonly<Record<HerNeedJournalEvent, string>> = {
  started: '她有了个小情绪', soothed: '她的小情绪被哄好了', faded: '她的小情绪淡掉了', cleared: '她的小情绪没了',
  'glow-ended': '被哄好的开心过去了', relieved: '你来了，她松了口气',
};
const USER_STATE_LABEL: Readonly<Record<UserStateKind, string>> = {
  tired: '累', annoyed: '烦', low: '低落', happy: '开心', excited: '兴奋', calm: '平静', unknown: '看不出来',
};
const RELATIONSHIP_REASON: Readonly<Record<RelationshipDiagnosticKind, string>> = {
  day: '新的一天（相处天数 +1）', quality: '今天是好好相处的一天', stage: '关系阶段变了', backfill: '补算了以前的相处天数',
  milestone: '认识纪念日', 'nickname-ask': '她问了以后怎么称呼你', 'nickname-saved': '记住了你的称呼', 'nickname-declined': '你没让她换称呼',
  'nickname-ignored': '称呼的事没有下文', 'nickname-changed': '你改了称呼', 'her-nickname-saved': '记住了你给她起的外号', override: '开发者临时改了关系阶段',
};
const MUSIC_REASON: Readonly<Record<JournalDanceTier, string>> = { none: '听着音乐，她没动', nod: '她跟着音乐点头', dance: '她跟着音乐跳起来' };
const RPS_REASON: Readonly<Record<RpsJournalEvent, string>> = {
  invite: '她邀你猜拳', accept: '你接受了猜拳', decline: '你婉拒了猜拳', expired: '猜拳邀请没人接', start: '开始猜拳', result: '猜拳结束',
};
const POSE_FOLLOW_REASON: Readonly<Record<PoseFollowKind, string>> = { yawn: '你打了个哈欠，她也跟着打了一个', stretch: '你伸了个懒腰，她也跟着伸了一下', wave: '你冲她挥手，她也挥手回应' };
const POSE_PASS_REASON: Readonly<Record<PoseFollowKind, string>> = { yawn: '你打了个哈欠，她这次没跟', stretch: '你伸了个懒腰，她这次没跟', wave: '你冲她挥手，她这次没回应' };
const FEED_REASON: Readonly<Record<FeedJournalOutcome, string>> = {
  said: '她认出了你喂的东西，说了一句', quiet: '她认出了你喂的东西，没开口', unclear: '她没看清你喂的是什么，只吃了',
  failed: '这次没认出你喂的是什么，只吃了', missed: '认出了你喂的东西，那句话没说出口',
};
const CHARACTER_REASON: Readonly<Record<CharacterJournalEvent, string>> = {
  activate: '换成了这个角色', update: '角色卡更新了', 'model-link': '角色关联的模型变了', add: '新增了角色卡', remove: '删除了角色卡',
};

/** The fixed reason of an entry. Only enum fields choose it; nothing a caller wrote can reach it. */
export function journalReason(entry: JournalInput): string {
  switch (entry.type) {
    case 'mood-event': return entry.source === 'appraisal' ? APPRAISAL_REASON[entry.context ?? 'neutral'] : SOURCE_REASON[entry.source];
    case 'mood-label': return '心情变了';
    case 'boredom': return BOREDOM_REASON[entry.level];
    case 'longing': return LONGING_REASON[entry.level];
    case 'inner-loop': return `内心循环：${DECISION_LABEL[entry.decision]}`;
    case 'her-life': return `她开始${ACTIVITY_LABEL[entry.to]}`;
    case 'her-need': return entry.event === 'faded' && entry.snubbed ? '没人理，她有点低落' : NEED_REASON[entry.event];
    case 'user-state': return `她觉得你现在：${USER_STATE_LABEL[entry.state]}`;
    case 'relationship': return RELATIONSHIP_REASON[entry.kind];
    case 'music': return MUSIC_REASON[entry.tier];
    case 'rps': return RPS_REASON[entry.event];
    case 'sleep': return entry.event === 'asleep' ? '她睡着了' : '她醒了';
    case 'app': return entry.event === 'start' ? '应用启动' : '应用退出';
    case 'setting': return entry.via === 'chat' ? '通过聊天卡片改了设置' : '通过内部通道改了设置';
    case 'character': return CHARACTER_REASON[entry.event];
    case 'journal': return entry.event === 'on' ? '体验记录开启' : '体验记录关闭';
    case 'truncated': return '今天的记录到上限了，后面的不再写';
    case 'reply-rhythm': return '这条回复的节奏';
    case 'motion': return entry.kind === 'guard' ? '显示护栏接住了一次动作跳变' : entry.kind === 'block' ? '窗口里突然出现了一块色块' : '物理骨骼一帧里跳了一下';
    case 'speech': return '这次朗读没读出来';
    case 'voice-input': return entry.stopped ? '语音输入没听到你，已经关掉' : entry.failure === 'no-sound' || entry.failure === 'empty' ? '语音输入开着，但没听到字' : '语音输入没能打开';
    case 'audio-reading': return entry.refused ? '陪听歌、看剧没能打开' : '一段播放的声音没能转写';
    case 'pose': return entry.event === 'arrive' ? '你来到电脑前' : entry.event === 'leave' ? '你离开了电脑前' : entry.event === 'own' ? '你坐了很久，她自己伸了个小懒腰'
      : entry.event === 'pause' ? (entry.kind === 'yawn' ? '你停下来歇口气，她困困地打了个哈欠' : '你停下来歇口气，她也伸了一下')
      : entry.event === 'pause-pass' ? '你停下来歇口气，她这次没动'
      : entry.kind ? (entry.event === 'follow' ? POSE_FOLLOW_REASON : POSE_PASS_REASON)[entry.kind] : '她对你的动作有了反应';
    case 'feed': return FEED_REASON[entry.outcome];
    case 'agent-words': return '照你的原话，Claude 做了一件要你同意的事';
    case 'mood-judge': return '她又想了想';
    case 'first-char': return '这条回复的第一个字';
    case 'listen-tally': return '陪听这一分钟的片段';
    case 'watch-tally': return '一起看这一分钟';
    case 'pause-stuck': return '一次"暂停听"没等到结束，被放开了';
    case 'reading-time': return entry.result === 'played' ? '她读完了这条回复' : entry.result === 'partial' ? '这条回复只读了一部分' : '这条回复没有读';
    case 'voice-time': return entry.result === 'text' ? '你说完话，转成了文字' : entry.result === 'no-sound' ? '你说话时麦克风没有声音'
      : entry.result === 'no-words' ? '听到了声音但没转出字' : '语音转文字失败了';
    case 'voice-capture': return entry.end === 'no-sound' ? '麦克风一直是静音，语音输入的收音数字' : entry.end === 'failed' ? '语音输入出错了，这是收音数字' : '一次语音输入结束，这是收音数字';
    case 'blush': return entry.outcome === 'fired' ? '她脸红了' : entry.outcome === 'blocked' ? '本来可能脸红，这次被挡住了'
      : entry.stage === 'shown' ? '舞台上看得到这次脸红' : '舞台上显示不出这次脸红';
    case 'her-gesture': return entry.gesture === 'none' ? '她这条回复没选小动作' : '她选了一个小动作';
    case 'fatigue-phase': return '她的困倦阶段变了';
    case 'topmost-fix': return '桌宠窗口掉出了置顶，已补回';
    case 'launch-time': return '她从应用启动到出现用了这么久';
    case 'draft-filter': return entry.whole ? (entry.filled ? '这条回复整条都是草稿，被拦掉了，她另说了一句' : '这条回复整条都是草稿，被拦掉了') : '这条回复里的草稿被拦掉了一部分';
    case 'reply-check': return REPLY_MARKER_REASON[entry.marker] ?? (entry.residue.length ? '这条回复里还留着内部用的词' : '她在开头标记前写的话没有显示');
    case 'reaction': return entry.picks.some(pick => pick.done) ? '她有了反应' : entry.picks.length ? '她本来要有反应，这次被挡住了' : '这次她没有特别的反应';
  }
}

/** I-046: the reply-check reason when the marker did not go as asked (with it as asked, the line says what else was found). */
const REPLY_MARKER_REASON: Readonly<Partial<Record<ReplyMarkerState, string>>> = {
  missing: '这条回复她没写开头标记', foreign: '这条回复用的不是这一轮的开头标记', empty: '这条回复的开头标记后面是空的',
};
const INTERNAL_WORD_LABEL: Readonly<Record<InternalWordRule, string>> = {
  marker: '标记', 'body-label': '“正文：”', 'tail-word': '尾注一类的词', 'memorial-field': '纪念提议的字段', 'field-name': '尾注的字段名', 'english-line': '计划里的英文句子',
};
const REACTION_DECIDER_LABEL: Readonly<Record<ReactionDecider, string>> = { top: '直接按分数', haiku: 'haiku 挑的', fallback: 'haiku 没答，按她回复的语气', none: '没有挑' };
const REACTION_HAIKU_LABEL: Readonly<Record<ReactionHaikuOutcome, string>> = { answered: 'haiku 答了', none: 'haiku 说不算哪一类', invalid: 'haiku 的回答不合格',
  'low-confidence': 'haiku 拿不准', timeout: 'haiku 超时', error: 'haiku 出错', quota: '今天的 haiku 次数用完了', quiet: '这时不问 haiku', superseded: '你又发了新消息' };
/** A reaction id in a journal line: a table row's id (or a test's fake row), plain and short. */
const REACTION_ID = /^[a-z][a-z0-9-]{0,31}$/u;

const READING_PROVIDER_LABEL: Readonly<Record<ReadingProvider, string>> = { system: '系统语音', bailian: '百炼语音', other: '其他朗读方式' };
const READING_WHY_LABEL: Readonly<Record<ReadingWhy, string>> = { cancelled: '被取消', off: '朗读关着', failed: '朗读出错', hidden: '桌宠窗口没显示' };
const VOICE_DEVICE_LABEL: Readonly<Record<(typeof VOICE_DEVICES)[number], string>> = { default: '默认', specified: '指定的', unknown: '不明的' };
const BLUSH_BLOCK_LABEL: Readonly<Record<BlushBlock, string>> = { cooldown: '还在冷却', showing: '正在红', threshold: '这一下没到门槛', off: '脸红开关关着或强度为 0' };
const BLUSH_STAGE_LABEL: Readonly<Record<Exclude<BlushStage, 'shown'>, string>> = { 'no-cheek': '舞台找不到脸颊或模型不支持', 'face-busy': '脸正被别的动作占着', off: '角色页关了能脸红', 'size-zero': '红晕大小是 0' };
const GESTURE_ANSWER_LABEL: Readonly<Record<GestureAnswer, string>> = { played: '做了', cannot: '这个模型做不了', busy: '舞台正忙', waiting: '等她说完', held: '心情不让做', dropped: '没等到时机，丢掉了', failed: '没能交给舞台' };
const FATIGUE_PHASE_LABEL: Readonly<Record<(typeof FATIGUE_PHASES)[number], string>> = { awake: '清醒', 'light-drowsy': '有点困', drowsy: '犯困', 'falling-asleep': '正在睡着', asleep: '睡着了', 'micro-awake': '半醒' };
const TOPMOST_OUTCOME_LABEL: Readonly<Record<TopmostFixOutcome, string>> = { applied: '一次补回', forced: '反复切换后补回', failed: '没补回来', unchanged: '已经在置顶' };

/** Plain words for the closed failure categories (journal lines only). */
export const SPEECH_FAILURE_LABEL: Readonly<Record<SpeechFailure, string>> = {
  network: '网络', auth: '鉴权', quota: '额度', service: '服务错误', timeout: '超时', other: '其他',
};
export const VOICE_INPUT_FAILURE_LABEL: Readonly<Record<VoiceInputFailure, string>> = {
  'needs-component': '本机识别组件还没下载', preparing: '本机识别组件还在准备', 'local-failed': '本机识别出错', unreachable: '识别服务连不上',
  service: '识别服务出错', timeout: '识别超时', other: '其他', 'no-sound': '麦克风几乎没有声音', empty: '听到了声音但没识别出字',
};

// ---------------------------------------------------------------- mood events: free text stops here

/** App-fixed mood reasons (electron/mood.ts, companion.ts, her-needs, rps) and the source each one means. */
const FIXED_MOOD_REASONS: Readonly<Record<string, MoodEventSource>> = {
  '有效摸头': 'touch', '有效捏脸': 'cheek', '接受一份点心': 'food', '收到用户聊天': 'chat', '收到用户语音': 'voice', '收到用户回应': 'chat',
  '和用户玩了猜拳': 'game', '被用户哄好了': 'soothed', '一个人待了一会儿，有点低落': 'dip', '用户来了，松了口气': 'relief',
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
  return fixed === 'soothed' || fixed === 'dip' || fixed === 'relief' ? fixed : 'lift-other';
}

// ---------------------------------------------------------------- building a line (the whitelist)

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How long the app may have been closed in a line: ten years is plenty (more is kept as ten years). */
const CLOSED_MAX_MS = 10 * 366 * 86_400_000;
const has = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number, places = 1) => { const f = 10 ** places; return Math.round(value * f) / f; };
const count = (value: unknown, max = 1_000_000): number | undefined => finite(value) && value >= 0 ? Math.min(max, Math.round(value)) : undefined;
const unit = (value: unknown): number | undefined => finite(value) ? round(Math.min(1, Math.max(0, value)), 2) : undefined;
const level = (value: unknown): number => finite(value) ? round(Math.min(100, Math.max(0, value))) : 0;
/** A millisecond span kept as a whole number, or null (a missing or impossible one). */
const ms = (value: unknown): number | null => finite(value) && value >= 0 && value <= 3_600_000 ? Math.round(value) : null;
const id = (value: unknown): string | null => typeof value === 'string' && ID.test(value) ? value : null;

function channels(value: unknown): MoodValues | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>, out = {} as MoodValues;
  for (const channel of MOOD_CHANNELS) { if (!finite(source[channel])) return null; out[channel] = level(source[channel]); }
  return out;
}

const SETTING_IDS = AGENT_SETTINGS.map(spec => spec.id);
const AGENT_TOOL_NAMES = AGENT_TOOLS.map(tool => tool.name);
/** I-025: an agent-words line's item when it is neither a setting nor a tool (e.g. a perception kind), and its value as text. */
const WORDS_ITEM = /^[a-z][a-z0-9_]{0,31}$/u;
const WORDS_VALUE = /^[A-Za-z0-9_,.-]{0,32}$/u;
function settingValue(settingId: AgentSettingId, value: unknown): boolean | number | string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (finite(value)) return round(value, 3);
  const spec = AGENT_SETTINGS.find(item => item.id === settingId);
  // A string is only ever one of the catalog's own enum values; any other text is refused.
  if (typeof value === 'string' && spec && spec.kind === 'enum' && spec.choices.some(choice => choice.value === value)) return value;
  return undefined;
}

/** The only way a journal line is made: field by field from closed sets. Null when anything does not fit. */
export function buildJournalEntry(input: unknown, at: number): JournalEntry | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !finite(at) || at < 0) return null;
  const v = input as Record<string, unknown>;
  const type = v.type;
  if (!has(JOURNAL_TYPES, type)) return null;
  const characterId = id(v.characterId);
  let body: JournalInput | null = null;
  switch (type) {
    case 'mood-event': {
      const before = channels(v.before), after = channels(v.after);
      if (!characterId || !has(MOOD_EVENT_SOURCES, v.source) || !before || !after || !has(LABELS, v.labelBefore) || !has(LABELS, v.labelAfter)) return null;
      const context = has(MOOD_CONTEXTS, v.context) ? v.context : undefined;
      const times = count(v.count), duration = count(v.durationMs, 24 * 3_600_000);
      body = { type, characterId, source: v.source, ...(context ? { context } : {}), before, after, labelBefore: v.labelBefore, labelAfter: v.labelAfter,
        ...(times && times > 1 ? { count: times } : {}), ...(duration ? { durationMs: duration } : {}) };
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
    case 'inner-loop':
      if (!characterId || (v.cue !== 'motion' && v.cue !== 'speech') || !has(INNER_LOOP_ACTIONS, v.decision) || !has(INNER_LOOP_RESULTS, v.result)) return null;
      body = { type, characterId, cue: v.cue, decision: v.decision, result: v.result, called: v.called === true, quiet: v.quiet === true,
        ...(v.restReminder === true ? { restReminder: true } : {}) };
      break;
    case 'her-life': {
      if (!characterId || !has(HER_LIFE_ACTIVITIES, v.from) || !has(HER_LIFE_ACTIVITIES, v.to)) return null;
      const until = v.untilMinutes === null ? null : count(v.untilMinutes, 24 * 60);
      body = { type, characterId, from: v.from, to: v.to, untilMinutes: until ?? null, ...(v.test === true ? { test: true } : {}) };
      break;
    }
    case 'her-need': {
      if (!characterId || !has(HER_NEED_JOURNAL_EVENTS, v.event) || (v.need !== null && !has(HER_NEED_IDS, v.need))) return null;
      const via = v.via === 'touch' || v.via === 'food' || v.via === 'chat' ? v.via : undefined;
      const dejection = unit(v.dejection), relief = unit(v.relief);
      body = { type, characterId, event: v.event, need: (v.need ?? null) as HerNeedId | null, ...(via ? { via } : {}), ...(v.snubbed === true ? { snubbed: true } : {}),
        ...(dejection !== undefined ? { dejection } : {}), ...(relief !== undefined ? { relief } : {}) };
      break;
    }
    case 'user-state': {
      const confidence = unit(v.confidence);
      if (!characterId || !has(USER_STATES, v.state) || confidence === undefined) return null;
      body = { type, characterId, state: v.state, confidence };
      break;
    }
    case 'relationship': {
      const dayNumber = count(v.dayNumber, 100_000), togetherDays = count(v.togetherDays, 100_000), qualityDays = count(v.qualityDays, 100_000);
      if (!characterId || !has(RELATIONSHIP_DIAGNOSTIC_KINDS, v.kind) || dayNumber === undefined || togetherDays === undefined || qualityDays === undefined) return null;
      body = { type, characterId, kind: v.kind, dayNumber, togetherDays, qualityDays, ...(has(RELATIONSHIP_STAGES, v.stage) ? { stage: v.stage } : {}) };
      break;
    }
    case 'music':
      if (!characterId || !has(DANCE_TIERS, v.tier)) return null;
      body = { type, characterId, tier: v.tier, score: unit(v.score) ?? null };
      break;
    case 'rps': {
      if (!characterId || !has(RPS_JOURNAL_EVENTS, v.event)) return null;
      const numbers: Record<string, number> = {};
      for (const key of ['rounds', 'herWins', 'userWins', 'draws', 'spoke'] as const) { const n = count(v[key], 1_000); if (n !== undefined) numbers[key] = n; }
      body = { type, characterId, event: v.event, ...(v.origin === 'her' || v.origin === 'user' ? { origin: v.origin } : {}), ...numbers,
        ...(v.result === 'her' || v.result === 'user' || v.result === 'none' ? { result: v.result } : {}), ...(has(RPS_ENDS, v.end) ? { end: v.end } : {}) };
      break;
    }
    case 'sleep':
      if (!characterId || (v.event !== 'asleep' && v.event !== 'awake') || !has(FATIGUE_PHASES, v.phase)) return null;
      body = { type, characterId, event: v.event, phase: v.phase };
      break;
    case 'app': {
      if ((v.event !== 'start' && v.event !== 'quit') || typeof v.version !== 'string' || !VERSION.test(v.version)) return null;
      // I-022: a field that does not fit is dropped, the line stays (it still says the app started or quit).
      const extra: { cause?: AppStopCause; stopped?: 'clean' | 'unclean' | 'unknown'; stoppedAt?: number; closedMs?: number; estimated?: true; clockBack?: true } = {};
      if (v.event === 'quit' && has(APP_STOP_CAUSES, v.cause)) extra.cause = v.cause;
      if (v.event === 'start' && (v.stopped === 'clean' || v.stopped === 'unclean' || v.stopped === 'unknown')) {
        const stoppedAt = finite(v.stoppedAt) && v.stoppedAt >= 0 ? Math.floor(v.stoppedAt) : undefined, closedMs = count(v.closedMs, CLOSED_MAX_MS);
        if (v.stopped === 'unknown') extra.stopped = 'unknown';
        else if (stoppedAt !== undefined && closedMs !== undefined) {
          Object.assign(extra, { stopped: v.stopped, stoppedAt, closedMs });
          if (v.stopped === 'unclean') extra.estimated = true;
          else if (has(APP_STOP_CAUSES, v.cause)) extra.cause = v.cause;
          if (v.clockBack === true) extra.clockBack = true;
        }
      }
      body = { type, characterId, event: v.event, version: v.version, commit: typeof v.commit === 'string' && COMMIT.test(v.commit) ? v.commit : null, ...extra };
      break;
    }
    case 'setting': {
      if (!has(SETTING_IDS, v.id) || (v.via !== 'agent' && v.via !== 'chat')) return null;
      const previous = settingValue(v.id, v.previous), value = settingValue(v.id, v.value);
      if (previous === undefined || value === undefined) return null;
      body = { type, characterId, id: v.id, previous, value, via: v.via };
      break;
    }
    case 'character':
      if (!characterId || !has(CHARACTER_JOURNAL_EVENTS, v.event)) return null;
      body = { type, characterId, event: v.event, ...(typeof v.linked === 'boolean' ? { linked: v.linked } : {}) };
      break;
    case 'journal':
      if (v.event !== 'on' && v.event !== 'off') return null;
      body = { type, characterId, event: v.event };
      break;
    case 'truncated':
      if (typeof v.day !== 'string' || !DAY.test(v.day)) return null;
      body = { type, characterId: null, day: v.day };
      break;
    case 'reply-rhythm': {
      if (!characterId || !finite(v.multiplier) || v.multiplier < REPLY_RHYTHM_MIN || v.multiplier > REPLY_RHYTHM_MAX || !has(RHYTHM_MOODS, v.mood)
        || (v.fatigue != null && !has(FATIGUE_PHASES, v.fatigue)) || (v.tendency != null && v.tendency !== 'playful' && v.tendency !== 'comfortable')
        || (v.user != null && !has(USER_PACES, v.user))) return null;
      body = { type, characterId, multiplier: round(v.multiplier, 3), mood: v.mood, fatigue: (v.fatigue ?? null) as (typeof FATIGUE_PHASES)[number] | null,
        tendency: (v.tendency ?? null) as RhythmTendency | null, shy: v.shy === true, user: (v.user ?? null) as UserPace | null };
      break;
    }
    case 'motion': {
      const name = typeof v.name === 'string' ? v.name.normalize('NFKC') : '';
      const list: unknown[] = Array.isArray(v.activities) ? v.activities : [];
      const block = v.kind === 'block';
      if (!characterId || !has(MOTION_GLITCH_KINDS, v.kind) || (v.part !== 'bone' && v.part !== 'morph' && !(block && (v.part === 'gpu' || v.part === 'geometry')))
        || (v.part === 'gpu' && name !== 'gpu') || (v.part === 'geometry' && name !== 'geometry') || !PART_NAME.test(name) || !finite(v.size) || v.size < 0 || (block && (v.size > 1 || typeof v.cleared !== 'boolean'))
        || list.length > MOTION_ACTIVITIES.length || !list.every(item => has(MOTION_ACTIVITIES, item))) return null;
      const fps = finite(v.fps) && v.fps > 0 && v.fps <= 240 ? Math.round(v.fps) : null;
      const frameMs = finite(v.frameMs) && v.frameMs >= 0 ? round(Math.min(10_000, v.frameMs), 1) : null;
      body = { type, characterId, kind: v.kind, part: v.part, name, size: round(Math.min(360, v.size), v.part === 'morph' || block ? 3 : 2),
        activities: [...new Set(list as MotionActivity[])], fps, frameMs, ...(block ? { cleared: v.cleared === true } : {}) };
      break;
    }
    case 'speech':
      if (v.provider !== 'bailian' || !has(SPEECH_FAILURES, v.failure)) return null;
      body = { type, characterId, provider: 'bailian', failure: v.failure };
      break;
    case 'voice-input':
      if ((v.engine !== 'local' && v.engine !== 'compatible') || !has(VOICE_INPUT_FAILURES, v.failure)) return null;
      body = { type, characterId, engine: v.engine, failure: v.failure, stopped: v.stopped === true,
        ...(typeof v.peakDb === 'number' && Number.isFinite(v.peakDb) ? { peakDb: Math.max(-120, Math.min(0, Math.round(v.peakDb))) } : {}) };
      break;
    case 'audio-reading':
      if ((v.engine !== 'local' && v.engine !== 'compatible') || !has(VOICE_INPUT_FAILURES, v.failure)) return null;
      body = { type, characterId, engine: v.engine, failure: v.failure, refused: v.refused === true };
      break;
    case 'pose': {
      const followed = v.event === 'follow' || v.event === 'pass' || v.event === 'pause';
      // follow / pass name what the user did, pause what she did (stretch or yawn); the others carry no kind (an own stretch is always a stretch).
      if (!characterId || !has(POSE_JOURNAL_EVENTS, v.event) || (followed ? !has(POSE_FOLLOW_KINDS, v.kind) : v.kind != null)
        || (v.event === 'pause' && v.kind === 'wave')) return null;
      body = { type, characterId, event: v.event, kind: followed ? v.kind as PoseFollowKind : null };
      break;
    }
    case 'feed':
      if (!characterId || !has(FEED_JOURNAL_OUTCOMES, v.outcome) || (v.category != null && !has(FEED_CATEGORIES, v.category))
        || (v.liking != null && !has(FEED_LIKINGS, v.liking))) return null;
      body = { type, characterId, outcome: v.outcome, ...(has(FEED_CATEGORIES, v.category) ? { category: v.category } : {}),
        ...(has(FEED_LIKINGS, v.liking) ? { liking: v.liking } : {}) };
      break;
    case 'agent-words': {
      // Closed names only: a channel tool, a setting id or the tool itself; a value that is a flag, a number or a short id.
      const value = v.value === null || typeof v.value === 'boolean' || (finite(v.value) && Math.abs(v.value) < 1e6)
        || (typeof v.value === 'string' && WORDS_VALUE.test(v.value)) ? v.value as boolean | number | string | null : undefined;
      if (!has(AGENT_TOOL_NAMES, v.tool) || typeof v.item !== 'string' || !(has(SETTING_IDS, v.item) || has(AGENT_TOOL_NAMES, v.item) || WORDS_ITEM.test(v.item))
        || value === undefined || !Number.isSafeInteger(v.words) || (v.words as number) < 1 || (v.words as number) > 2000) return null;
      body = { type, characterId, tool: v.tool, item: v.item, value, words: v.words as number };
      break;
    }
    case 'mood-judge': {
      const before = channels(v.before), after = channels(v.after);
      if (!characterId || !has(MOOD_JUDGE_WHY_IDS, v.why) || !before || !after || !has(LABELS, v.labelBefore) || !has(LABELS, v.labelAfter)) return null;
      body = { type, characterId, why: v.why, before, after, labelBefore: v.labelBefore, labelAfter: v.labelAfter };
      break;
    }
    case 'first-char':
      if (!finite(v.ms) || v.ms < 0 || v.ms > 600_000 || typeof v.pauseTalk !== 'boolean' || typeof v.carried !== 'boolean') return null;
    {
      const split: { contentMs?: number; bubbleMs?: number; sinceStartMs?: number; sinceLastMs?: number } = {};
      for (const key of ['contentMs', 'bubbleMs', 'sinceStartMs', 'sinceLastMs'] as const) { const n = ms(v[key]); if (n !== null) split[key] = n; }
      body = { type, characterId, ms: Math.round(v.ms), pauseTalk: v.pauseTalk, carried: v.carried, ...split };
    }
      break;
    case 'listen-tally': {
      const count = (n: unknown) => finite(n) && (n as number) >= 0 && (n as number) <= 100_000 ? Math.round(n as number) : null;
      const received = count(v.received), skippedPaused = count(v.skippedPaused), withText = count(v.withText), empty = count(v.empty), failed = count(v.failed);
      if (received === null || skippedPaused === null || withText === null || empty === null || failed === null) return null;
      body = { type, characterId, received, skippedPaused, withText, empty, failed };
      break;
    }
    case 'watch-tally': {
      const count = (n: unknown, max = 1_000_000) => finite(n) && (n as number) >= 0 && (n as number) <= max ? Math.round(n as number) : null;
      const described = count(v.described), skipped = count(v.skipped), failed = count(v.failed), late = count(v.late), summaries = count(v.summaries), heard = count(v.heard);
      const haikuCalls = count(v.haikuCalls), haikuMs = count(v.haikuMs, 100_000_000), keywordHits = count(v.keywordHits), cacheFiles = count(v.cacheFiles), cacheKb = count(v.cacheKb, 100_000_000);
      if (described === null || skipped === null || failed === null || late === null || summaries === null || heard === null || haikuCalls === null
        || haikuMs === null || keywordHits === null || cacheFiles === null || cacheKb === null) return null;
      body = { type, characterId, described, skipped, failed, late, summaries, heard, haikuCalls, haikuMs, keywordHits, cacheFiles, cacheKb };
      break;
    }
    case 'pause-stuck':
      if (!has(PAUSE_STUCK_KINDS, v.what)) return null;
      body = { type, characterId, what: v.what };
      break;
    case 'reading-time': {
      const chars = count(v.chars, 100_000);
      if (chars === undefined || !has(READING_PROVIDERS, v.provider) || !has(READING_RESULTS, v.result) || (v.why != null && !has(READING_WHYS, v.why))
        || (v.result === 'played' && v.why != null) || (v.result !== 'played' && v.why == null)) return null;
      body = { type, characterId, firstAudioMs: ms(v.firstAudioMs), waitMs: ms(v.waitMs), chars, provider: v.provider, result: v.result,
        why: (v.why ?? null) as ReadingWhy | null, firstSinceStart: v.firstSinceStart === true };
      break;
    }
    case 'voice-time': {
      if (!has(VOICE_TIME_RESULTS, v.result) || !has(VOICE_TIME_ENGINES, v.engine)) return null;
      const seconds = finite(v.seconds) && v.seconds >= 0 ? round(Math.min(3_600, v.seconds), 1) : null;
      body = { type, characterId, ms: ms(v.ms), recognizeMs: ms(v.recognizeMs), seconds, result: v.result, engine: v.engine };
      break;
    }
    case 'voice-capture': {
      const chunks = count(v.chunks, 10_000_000), rate = count(v.sampleRate, 400_000), paused = count(v.pausedMs, 24 * 3_600_000), seconds = finite(v.seconds) && v.seconds >= 0 ? round(Math.min(86_400, v.seconds), 1) : undefined;
      if (!has(VOICE_CAPTURE_ENDS, v.end) || chunks === undefined || rate === undefined || paused === undefined || seconds === undefined || !has(VOICE_DEVICES, v.device)
        || !finite(v.peak) || !finite(v.rms) || !finite(v.threshold)) return null;
      body = { type, characterId, end: v.end, chunks, peak: round(Math.min(1, Math.max(0, v.peak)), 5), rms: round(Math.min(1, Math.max(0, v.rms)), 5),
        threshold: round(Math.min(1, Math.max(0, v.threshold)), 4), sampleRate: rate, device: v.device, pausedAtStart: v.pausedAtStart === true, pausedMs: paused, seconds };
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
    case 'her-gesture':
      if (!(v.gesture === 'none' || has(CHAT_ACTION_WORDS, v.gesture)) || (v.answer != null && !has(GESTURE_ANSWERS, v.answer)) || (v.gesture === 'none') !== (v.answer == null)) return null;
      body = { type, characterId, gesture: v.gesture as ChatActionWord | 'none', answer: (v.answer ?? null) as GestureAnswer | null, waited: v.waited === true };
      break;
    case 'fatigue-phase': {
      const two = (n: unknown) => finite(n) ? round(Math.min(1, Math.max(-1, n)), 2) : undefined;
      const A = two(v.A), F = two(v.F), W = two(v.W), clock = two(v.clock), mood = two(v.mood);
      if (!characterId || !has(FATIGUE_PHASES, v.from) || !has(FATIGUE_PHASES, v.to) || v.from === v.to || A === undefined || F === undefined || W === undefined
        || clock === undefined || mood === undefined) return null;
      body = { type, characterId, from: v.from, to: v.to, A, F, W, clock, mood };
      break;
    }
    case 'topmost-fix': {
      const nth = count(v.nth, 1_000_000);
      if (!has(TOPMOST_FIX_OUTCOMES, v.outcome) || nth === undefined || typeof v.visible !== 'boolean') return null;
      body = { type, characterId, outcome: v.outcome, visible: v.visible, nth };
      break;
    }
    case 'launch-time':
      if (!finite(v.ms) || v.ms < 0 || v.ms > 3_600_000) return null;
      body = { type, characterId, ms: Math.round(v.ms) };
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
  }
  if (!body) return null;
  const time = new Date(Math.floor(at)).toISOString();
  return { v: JOURNAL_VERSION, at: Math.floor(at), time, ...body, reason: journalReason(body) } as JournalEntry;
}

/** A line read back from a journal file: parsed, then rebuilt through the same whitelist (a damaged or foreign line is dropped). */
export function readJournalLine(line: string): JournalEntry | null {
  if (typeof line !== 'string' || !line.trim() || line.length > 4_000) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || value.v !== JOURNAL_VERSION || !finite(value.at)) return null;
    return buildJournalEntry(value, value.at);
  } catch { return null; }
}

/** What the control window's "刚才发生了什么" shows (electron/journal/app-journal.ts). Names come from the cards, not the journal. */
export interface JournalView {
  enabled: boolean;
  /** Newest last, at most JOURNAL_RECENT; empty while the switch is off. */
  entries: JournalEntry[];
  characters: Array<{ id: string; name: string }>;
  /** The last write failed (the lines are still shown from memory). */
  failure: boolean;
  /** Today's file reached the daily ceiling. */
  truncatedToday: boolean;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** The UI's translator (src/ui/ui-language.ts uiText); tests pass a plain formatter. */
export type JournalTranslate = (source: string, ...values: readonly unknown[]) => string;

const CHANNEL_TEMPLATE: Readonly<Record<keyof MoodValues, string>> = { D: '期待 {0}', O: '亲近 {0}', E: '舒适 {0}', N: '激活 {0}', C: '压力 {0}' };

/** The channels that moved by at least one point, biggest first, at most three: "亲近 +6、舒适 +2". */
export function journalDeltaText(before: MoodValues, after: MoodValues, tr: JournalTranslate): string {
  const moved = MOOD_CHANNELS.map(channel => ({ channel, delta: Math.round(after[channel] - before[channel]) }))
    .filter(item => item.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
  return moved.map(item => tr(CHANNEL_TEMPLATE[item.channel], `${item.delta > 0 ? '+' : ''}${item.delta}`)).join(tr('、'));
}

const pad = (n: number) => String(n).padStart(2, '0');
export function journalClock(at: number): string { const date = new Date(at); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }

function describeValue(entry: Extract<JournalEntry, { type: 'setting' }>, value: boolean | number | string | null, tr: JournalTranslate): string {
  if (value === null) return tr('未知');
  const spec = AGENT_SETTINGS.find(item => item.id === entry.id);
  if (spec && spec.kind !== 'number') { const choice = spec.choices.find(item => item.value === value); if (choice) return tr(choice.label); }
  return spec && spec.kind === 'number' ? `${value}${spec.unit}` : String(value);
}

/** "8 小时 12 分", "3 天 2 小时", "12 分", "40 秒": how long the app was closed, in the panel's words. */
export function journalDuration(ms: number, tr: JournalTranslate): string {
  const seconds = Math.max(0, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days > 0) return tr('{0} 天 {1} 小时', days, hours % 24);
  if (hours > 0) return tr('{0} 小时 {1} 分', hours, minutes % 60);
  if (minutes > 0) return tr('{0} 分', minutes);
  return tr('{0} 秒', seconds);
}

/** I-022: what an app line adds after the version — how it quit, or when the previous run stopped and how long it was closed. */
function appStopText(entry: Extract<JournalEntry, { type: 'app' }>, tr: JournalTranslate): string {
  if (entry.event === 'quit') return entry.cause ? tr(' · {0}', tr(APP_STOP_CAUSE_LABEL[entry.cause])) : '';
  if (entry.stopped === 'unknown') return tr(' · 没有上次退出的记录');
  if (entry.stoppedAt === undefined || entry.closedMs === undefined) return '';
  if (entry.clockBack) return tr(' · 电脑时间比上次停下时还早，关了多久不算');
  if (entry.stopped === 'unclean') return tr(' · 上次没正常退出，最多关了 {0}（估的：按 {1} 最后一次还在算）', journalDuration(entry.closedMs, tr), journalClock(entry.stoppedAt));
  return tr(' · 上次 {0} 退出（{1}），关了 {2}', journalClock(entry.stoppedAt), tr(APP_STOP_CAUSE_LABEL[entry.cause ?? 'other']), journalDuration(entry.closedMs, tr));
}

/** "11:42 你摸了摸头 → 亲近 +6，现在：满足". Plain text only; the panel sets it as textContent. */
export function describeJournalEntry(entry: JournalEntry, tr: JournalTranslate): string {
  const reason = tr(entry.reason);
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
    case 'inner-loop': body = tr('{0}（{1}）', reason, tr(RESULT_LABEL[entry.result])); break;
    case 'her-need': body = entry.need && entry.event === 'started' ? tr('{0}：{1}', reason, tr(NEED_LABEL[entry.need])) : reason; break;
    case 'user-state': body = tr('{0}（把握 {1}）', reason, entry.confidence.toFixed(2)); break;
    case 'relationship': body = tr('{0}（认识第 {1} 天 · 相处 {2} 天）', reason, entry.dayNumber, entry.togetherDays); break;
    case 'rps': body = entry.event === 'result'
      ? tr('{0}：她赢 {1} · 你赢 {2} · 平 {3}', reason, entry.herWins ?? 0, entry.userWins ?? 0, entry.draws ?? 0) : reason; break;
    case 'app': body = tr('{0}（{1}{2}）', reason, entry.version, entry.commit ? ` · ${entry.commit.slice(0, 7)}` : '') + appStopText(entry, tr); break;
    case 'setting': {
      const spec = AGENT_SETTINGS.find(item => item.id === entry.id);
      body = tr('{0}「{1}」：{2} → {3}', reason, spec ? tr(spec.label) : entry.id, describeValue(entry, entry.previous, tr), describeValue(entry, entry.value, tr));
      break;
    }
    case 'reply-rhythm': body = tr('{0}：{1}（{2}）', reason, formatRhythmMultiplier(entry.multiplier), rhythmSourceLabels(entry).map(label => tr(label)).join(tr('、'))); break;
    case 'motion': {
      const doing = (entry.activities.length ? entry.activities : ['idle' as const]).map(item => tr(MOTION_ACTIVITY_LABEL[item])).join(tr('、'));
      if (entry.kind === 'block') {
        const found = entry.part === 'gpu' ? tr('程序里的骨骼、表情和模型数据都正常') : entry.part === 'geometry' ? tr('程序内存里的模型数据坏了') : tr(entry.part === 'bone' ? '骨骼「{0}」的数值坏了' : '表情「{0}」的数值坏了', entry.name);
        body = tr('{0}：{1}，{2}（{3}）', reason, found, tr(entry.cleared ? '重传给显卡后消失了' : '重传给显卡后还在'), doing);
      } else body = tr('{0}：{1} {2}（{3}）', reason, entry.name, entry.part === 'morph' ? entry.size.toFixed(2) : `${entry.size.toFixed(1)}°`, doing);
      break;
    }
    case 'speech': body = tr('{0}（{1}）', reason, tr(SPEECH_FAILURE_LABEL[entry.failure])); break;
    case 'voice-input': case 'audio-reading': body = tr('{0}（{1}）', reason, tr(VOICE_INPUT_FAILURE_LABEL[entry.failure])); break;
    case 'feed': body = entry.category ? tr('{0}（{1}）', reason, entry.liking && entry.liking !== '不知道' ? tr('{0} · {1}', tr(entry.category), tr(entry.liking)) : tr(entry.category)) : reason; break;
    case 'agent-words': {
      const spec = AGENT_SETTINGS.find(item => item.id === entry.item), tool = AGENT_TOOLS.find(item => item.name === entry.item);
      const label = spec ? spec.label : tool ? tool.title : entry.item;
      const choice = spec && spec.kind !== 'number' ? spec.choices.find(item => item.value === entry.value)?.label : undefined;
      const value = entry.value === null ? '' : choice ?? (typeof entry.value === 'string' ? AGENT_SETTING_STATE_LABELS[entry.value] ?? entry.value
        : spec?.kind === 'number' ? `${entry.value}${spec.unit}` : String(entry.value));
      body = value ? tr('{0}：「{1}」→ {2}（原话 {3} 字）', reason, tr(label), tr(value), entry.words) : tr('{0}：「{1}」（原话 {2} 字）', reason, tr(label), entry.words);
      break;
    }
    case 'mood-judge': {
      const delta = journalDeltaText(entry.before, entry.after, tr), label = tr(MOOD_LABELS[entry.labelAfter]), why = tr(MOOD_JUDGE_WHYS[entry.why]);
      body = delta ? tr('{0}（{1}）→ {2}，现在：{3}', reason, why, delta, label) : tr('{0}（{1}），现在：{2}', reason, why, label);
      break;
    }
    case 'first-char':
      body = tr('{0}：{1} 秒（停停说说 {2}）', reason, (entry.ms / 1000).toFixed(2), tr(entry.pauseTalk ? (entry.carried ? '开，带了上一条没说完的话' : '开') : '关'));
      if (entry.contentMs !== undefined || entry.bubbleMs !== undefined)
        body += tr('，内容 {0} 秒到主进程、{1} 秒到气泡，离启动 {2} 分、离上一句 {3} 秒', ((entry.contentMs ?? 0) / 1000).toFixed(2), ((entry.bubbleMs ?? 0) / 1000).toFixed(2),
          String(Math.round((entry.sinceStartMs ?? 0) / 60_000)), String(Math.round((entry.sinceLastMs ?? 0) / 1000)));
      break;
    case 'listen-tally':
      body = tr('{0}：收到 {1} 段，暂停时跳过 {2} 段，有字 {3} 段，没字 {4} 段，出错 {5} 段', reason, String(entry.received), String(entry.skippedPaused), String(entry.withText), String(entry.empty), String(entry.failed));
      break;
    case 'watch-tally':
      body = tr('{0}：描述了 {1} 帧，跳过 {2} 帧，失败 {3} 帧，迟到丢掉 {4} 个，概要 {5} 次，听到 {6} 段，haiku {7} 次共 {8} 秒，关键词命中 {9} 次，截图缓存 {10} 张 {11} KB',
        reason, String(entry.described), String(entry.skipped), String(entry.failed), String(entry.late), String(entry.summaries), String(entry.heard),
        String(entry.haikuCalls), (entry.haikuMs / 1000).toFixed(1), String(entry.keywordHits), String(entry.cacheFiles), String(entry.cacheKb));
      break;
    case 'pause-stuck':
      body = tr('{0}（{1}）', reason, tr(PAUSE_STUCK_LABEL[entry.what]));
      break;
    case 'reading-time': {
      const parts = [tr(READING_PROVIDER_LABEL[entry.provider]), tr('{0} 字', entry.chars)];
      if (entry.firstAudioMs !== null) parts.push(tr('出声用了 {0} 秒', (entry.firstAudioMs / 1000).toFixed(2)));
      if (entry.waitMs !== null) parts.push(tr('排队 {0} 秒', (entry.waitMs / 1000).toFixed(2)));
      if (entry.why) parts.push(tr(READING_WHY_LABEL[entry.why]));
      if (entry.firstSinceStart) parts.push(tr('启动后第一句'));
      body = tr('{0}（{1}）', reason, parts.join(tr('、')));
      break;
    }
    case 'voice-time': {
      const parts = [tr(entry.engine === 'local' ? '本机识别' : entry.engine === 'compatible' ? '转写地址' : '其他识别方式')];
      if (entry.seconds !== null) parts.push(tr('录了 {0} 秒', entry.seconds.toFixed(1)));
      if (entry.ms !== null) parts.push(tr('说完到出字 {0} 秒', (entry.ms / 1000).toFixed(2)));
      if (entry.recognizeMs !== null) parts.push(tr('其中识别 {0} 秒', (entry.recognizeMs / 1000).toFixed(2)));
      body = tr('{0}（{1}）', reason, parts.join(tr('、')));
      break;
    }
    case 'voice-capture': {
      const db = (n: number) => n > 0 ? `${(20 * Math.log10(n)).toFixed(0)} dB` : tr('全零');
      const paused = entry.pausedAtStart || entry.pausedMs > 0
        ? tr('；她说话时暂停了 {0} 秒{1}', (entry.pausedMs / 1000).toFixed(1), entry.pausedAtStart ? tr('（开始时就在暂停）') : '') : '';
      body = tr('{0}：{1} 块音频、{2} 秒，最大峰值 {3}，最大 RMS {4}，门槛 {5}，{6} Hz，{7}输入设备{8}', reason, String(entry.chunks), entry.seconds.toFixed(1), db(entry.peak), db(entry.rms),
        db(entry.threshold), String(entry.sampleRate), tr(VOICE_DEVICE_LABEL[entry.device]), paused);
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
    case 'her-gesture': body = entry.gesture === 'none' ? reason : tr('{0}「{1}」：{2}', reason, entry.gesture, entry.answer ? tr(GESTURE_ANSWER_LABEL[entry.answer]) + (entry.waited ? tr('（等她说完）') : '') : ''); break;
    case 'fatigue-phase':
      body = tr('{0}：{1} → {2}（累积 {3} · 疲倦 {4} · 清醒 {5} · 生物钟 {6} · 心情 {7}）', reason, tr(FATIGUE_PHASE_LABEL[entry.from]), tr(FATIGUE_PHASE_LABEL[entry.to]),
        entry.A.toFixed(2), entry.F.toFixed(2), entry.W.toFixed(2), entry.clock.toFixed(2), entry.mood.toFixed(2));
      break;
    case 'topmost-fix': body = tr('{0}（第 {1} 次 · {2}）', reason, String(entry.nth), tr(TOPMOST_OUTCOME_LABEL[entry.outcome])); break;
    case 'launch-time': body = tr('{0}：{1} 秒', reason, (entry.ms / 1000).toFixed(1)); break;
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
    default: body = reason;
  }
  return `${journalClock(entry.at)} ${body}`;
}
