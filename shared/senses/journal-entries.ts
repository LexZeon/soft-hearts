// 体验记录 (the experience journal): the entry types of the senses part (感知): user-state, music, feed, listen-tally, watch-tally, pause-stuck, music-verdict, presence-look, camera-look, gaze, face-check.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { finite, has, round, unit, type JournalTranslate } from '../foundation/journal-fields';
import { GAZE_JOURNAL_EVENTS, GAZE_JOURNAL_REASON, GAZE_JOURNAL_WHY_WORDS, type GazeJournalEvent, type GazeJournalWhy } from '../behaviors/gaze-attention/interface';
import { SCREEN_LOOKS, type ScreenLook } from '../behaviors/user-activity/interface';
import { parsePoseUseFact, POSE_USE_EVENT_WORDS, POSE_USE_WORDS, type PoseUse, type PoseUseEvent } from '../behaviors/pose-uses/journal';
import { CAMERA_LOOK_SEEN, CAMERA_LOOK_SEEN_WORDS, CAMERA_LOOK_VIA, CAMERA_LOOK_VIA_WORDS, CAMERA_LOOK_WHY, CAMERA_LOOK_WHY_WORDS, type CameraLookSeen, type CameraLookVia, type CameraLookWhy,
  CAMERA_LOOK_MISSES, CAMERA_LOOK_MISS_WORDS, CAMERA_LOOK_STAGES, CAMERA_LOOK_STAGE_WORDS, CAMERA_LOOK_ENDS, CAMERA_LOOK_END_WORDS, CAMERA_LOOK_OUT_WORD, type CameraLookDetail, type CameraLookMiss, type CameraLookStage, type CameraLookEnd } from './camera-look';
import { buildFaceScoreEntry, describeFaceScore, faceScoreReason, type FaceScoreInput } from './face-journal';
import { FEED_CATEGORIES, FEED_JOURNAL_OUTCOMES, FEED_LIKINGS, type FeedCategory, type FeedJournalOutcome, type FeedLiking } from './feed-recognition';
import { MUSIC_OFF_LABEL, MUSIC_OFF_REASONS, type MusicOffReason } from './music-detect/verdict';
import { USER_STATES, type UserStateKind } from './user-state';
import { CLOSER_MISSES, CLOSER_MISS_WORDS, CLOSER_OUTCOMES, CLOSER_OUTCOME_WORDS, CLOSER_WHYS, CLOSER_WHY_WORDS, LOOK_SENSE_WORDS, SEE_AND_SAY_EVENTS, SEE_AND_SAY_REASON, type CloserMiss, type CloserOutcome, type CloserWhy } from './see-and-say/words';
import { LOOK_SENSES, type LookSense } from './see-and-say/marker';

/** I-066: a screen look's category words (the picture and any description are never kept). */
const SCREEN_LOOK_WORDS: Readonly<Record<ScreenLook | 'failed', string>> = {
  meeting: '开会', watching: '看视频', gaming: '玩游戏', working: '做事', browsing: '随便看看', desktop: '桌面', unknown: '看不出来', failed: '没看成',
};
export const DANCE_TIERS = ['none', 'nod', 'dance'] as const;
export type JournalDanceTier = (typeof DANCE_TIERS)[number];

export const PAUSE_STUCK_KINDS = ['speech-route', 'speaking-window', 'mic-window', 'listen-pause', 'ambient-suspend'] as const;
export type PauseStuckKind = (typeof PAUSE_STUCK_KINDS)[number];
const PAUSE_STUCK_LABEL: Readonly<Record<PauseStuckKind, string>> = {
  'speech-route': '朗读的路由没人收尾', 'speaking-window': '窗口说"她在说话"后没再说停', 'mic-window': '麦克风因朗读暂停后没恢复',
  'listen-pause': '陪听因朗读暂停后没恢复', 'ambient-suspend': '系统声音理解因朗读暂停后没恢复',
};
/** turned off: why, as closed words (docs/claude/2026-11-24-watch-turns-off.md). Never a word of what was on the screen or in the sound. */
export const WATCH_OFF_WHYS = ['user', 'window-gone', 'window-hidden', 'reset', 'conversation-change', 'unbound-exit', 'other'] as const;
export type WatchOffWhy = (typeof WATCH_OFF_WHYS)[number];
const WATCH_OFF_LABEL: Readonly<Record<WatchOffWhy, string>> = {
  user: '你关的', 'window-gone': '她的窗口没了', 'window-hidden': '她的窗口离开了屏幕', reset: '重置或退出', 'conversation-change': '换了角色或对话被清掉', 'unbound-exit': '从全屏回小窗时把开关放回原样', other: '别的原因',
};
/**
 * changes that are not "turned off" (docs/claude/2026-11-24-watch-turns-off.md, 续): the share lost (the capture gave nothing,
 * the chosen window or screen went, or it ended and nobody named why), her window minimized (paused) and back (resumed, or not resumed because
 * you had turned it off meanwhile). Closed words and one length of time; never a title, a path or any of what was on the screen.
 */
export const WATCH_CHANGE_EVENTS = ['share-lost', 'paused', 'resumed', 'not-resumed', 'kept-after-unbound'] as const;
export type WatchChangeEvent = (typeof WATCH_CHANGE_EVENTS)[number];
export const WATCH_LOST_WHYS = ['capture-lost', 'source-gone', 'unexplained'] as const;
export type WatchLostWhy = (typeof WATCH_LOST_WHYS)[number];
export const WATCH_NOT_RESUMED_WHYS = ['turned-off', 'screen-gone', 'not-allowed', 'changed'] as const;
export type WatchNotResumedWhy = (typeof WATCH_NOT_RESUMED_WHYS)[number];
const WATCH_CHANGE_REASON: Readonly<Record<WatchChangeEvent, string>> = {
  'share-lost': '一起看的屏幕共享断了', paused: '她的窗口最小化了，一起看先停着', resumed: '她的窗口回来了，一起看接着开了', 'not-resumed': '她的窗口回来了，一起看没有接着开', 'kept-after-unbound': '你在全屏里开的一起看，回到小窗时留着了',
};
const WATCH_CHANGE_LABEL: Readonly<Record<WatchLostWhy | WatchNotResumedWhy, string>> = {
  'capture-lost': '屏幕画面一直取不到', 'source-gone': '共享的窗口或屏幕不在了', unexplained: '没人说得出原因', 'turned-off': '你在这期间关了', 'screen-gone': '屏幕共享不再开着', 'not-allowed': '台词那一路开不起来', changed: '换了角色或对话',
};
const USER_STATE_LABEL: Readonly<Record<UserStateKind, string>> = {
  tired: '累', annoyed: '烦', low: '低落', happy: '开心', excited: '兴奋', calm: '平静', unknown: '看不出来',
};
const MUSIC_REASON: Readonly<Record<JournalDanceTier, string>> = { none: '听着音乐，她没动', nod: '她跟着音乐点头', dance: '她跟着音乐跳起来' };
const FEED_REASON: Readonly<Record<FeedJournalOutcome, string>> = {
  said: '她认出了你喂的东西，说了一句', quiet: '她认出了你喂的东西，没开口', unclear: '她没看清你喂的是什么，只吃了',
  failed: '这次没认出你喂的是什么，只吃了', missed: '认出了你喂的东西，那句话没说出口',
  superseded: '认出了你喂的东西，你又喂了一口，那句话换成了新的一句', busy: '认出了你喂的东西，一直没轮到她开口，那句话没说出口',
};

/** Unbound step 4 (afternoon addition C): what she noticed of you while she was out (shared/unbound/life/history.ts NOTICED_KINDS), how sure, whether she spoke. */
export const NOTICED_JOURNAL_KINDS = ['left', 'came-back', 'facing', 'wave', 'stretch', 'leaned-back', 'talked', 'answered', 'pulled-along'] as const;
export type NoticedJournalKind = (typeof NOTICED_JOURNAL_KINDS)[number];
export const NOTICED_JOURNAL_BANDS = ['sure', 'maybe'] as const;
export const NOTICED_JOURNAL_SPOKE = ['asked', 'held', 'quiet', 'asleep'] as const;
const NOTICED_REASON: Readonly<Record<NoticedJournalKind, string>> = {
  left: '她在外面，注意到你走开了', 'came-back': '她在外面，注意到你回来了', facing: '她在外面，注意到你看着她', wave: '她在外面，注意到你挥手',
  stretch: '她在外面，注意到你伸懒腰', 'leaned-back': '她在外面，注意到你往后靠着', talked: '她在外面，注意到你在和别人说话', answered: '她走近你，你理了她',
  'pulled-along': '她在外面，被你拉着走了一段',
};
const NOTICED_SPOKE_WORDS: Readonly<Record<(typeof NOTICED_JOURNAL_SPOKE)[number], string>> = { asked: '她想说句话', held: '她想说话，没轮到', quiet: '她没开口', asleep: '她在睡觉' };

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const SENSES_JOURNAL_TYPES = ['user-state', 'music', 'feed', 'listen-tally', 'watch-tally', 'pause-stuck', 'watch-off', 'watch-change', 'music-verdict', 'presence-look', 'camera-look', 'see-and-say', 'gaze', 'face-check', 'face-score', 'noticed', 'pose-use'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type SensesJournalInput =
  | { type: 'user-state'; characterId: string; state: UserStateKind; confidence: number }
  | { type: 'music'; characterId: string; tier: JournalDanceTier; score: number | null }
  /** I-019 喂食认图: one accepted picture, by closed categories only (never the picture, the food's name or her words). */
  | { type: 'feed'; characterId: string; outcome: FeedJournalOutcome; category?: FeedCategory; liking?: FeedLiking }
  /** 听歌判定翻转 (I-053): the fast "is it music" layer said music / not music: score, beat strength, speech-likeness (0..1), seconds of sound in its window, and why it went off. Numbers only. */
  | { type: 'music-verdict'; characterId: string; music: boolean; score: number; beat: number; speech: number; soundS: number; why?: MusicOffReason }
  /**
   * 陪听的一分钟: what happened to the clips of the played sound in the last minute, as counts only —
   * received, skipped because listening was paused, transcribed with words, transcribed with none, failed. Never audio or words.
   */
  | { type: 'listen-tally'; characterId: string | null; received: number; skippedPaused: number; withText: number; empty: number; failed: number; /** I-187: turned away because the recognizer's queue was full */ skippedBusy?: number }
  /**
   * 一起看的一分钟 (I-048): counts and timings only, never a description, a keyword or a picture. I-187: hearS / pausedS / noCaptureS —
   * seconds watched while the dialogue could reach her, was paused (she read aloud, you spoke), or had no capture of the computer's sound.
   */
  | { type: 'watch-tally'; characterId: string | null; described: number; skipped: number; failed: number; late: number; summaries: number; heard: number; haikuCalls: number; haikuMs: number; keywordHits: number; cacheFiles: number; cacheKb: number; hearS?: number; pausedS?: number; noCaptureS?: number }
  /** 一个"暂停听"没等到该有的结束，被强制放开 (2026-11-06, 朗读过后听不见了): which pause it was; nothing else. */
  | { type: 'pause-stuck'; characterId: string | null; what: PauseStuckKind }
  /** 「和她一起看」 went from on (screen and dialogue) to off: one row, with why. Closed words only. */
  | { type: 'watch-off'; characterId: string | null; why: WatchOffWhy }
  /** changed without being turned off: see WATCH_CHANGE_EVENTS. `why` only with 'share-lost' / 'not-resumed'; `awayS` (whole seconds the window was away) only with 'resumed' / 'not-resumed'. */
  | { type: 'watch-change'; characterId: string | null; event: WatchChangeEvent; why?: WatchLostWhy | WatchNotResumedWhy; awayS?: number }
  /** I-066: one screen look (only while the user's screen sharing is on): its category, or 'failed'. Never the picture or a description. */
  | { type: 'presence-look'; characterId: string | null; look: ScreenLook | 'failed' }
  /** I-084: one chat turn with 「发图片」 on — what she saw of the user (shared/senses/camera-look.ts); `via` only with 'clear', `why` only with 'small' / 'none'. */
  | { type: 'camera-look'; characterId: string | null; seen: CameraLookSeen; via?: CameraLookVia; why?: CameraLookWhy } & CameraLookDetail
  /** I-081: her attention to you (shared/behaviors/gaze-attention/): start (why arrived / facing), stop (why left / turned / off / asleep), eye-contact, shy. Never a position. */
  | { type: 'gaze'; characterId: string | null; event: GazeJournalEvent; why?: GazeJournalWhy }
  /** I-135: face-check counts since the last row (written when the verdict changes, checks stop, or every 30 minutes). Numbers only. */
  | { type: 'face-check'; characterId: string | null; matched: number; notYou: number; unsure: number; skipped: number; stranger: number }
  /** 2026-11-25: one face check's closed outcome and its numbers, or why none ran for a minute (shared/senses/face-journal.ts). Never a picture or the face's numbers. */
  | FaceScoreInput
  /** Unbound step 4: one thing she noticed of you while out: its kind, sure or maybe, and whether she asked to speak. Never a word, a picture or a sound. */
  | { type: 'noticed'; characterId: string | null; kind: NoticedJournalKind; band: (typeof NOTICED_JOURNAL_BANDS)[number]; spoke: (typeof NOTICED_JOURNAL_SPOKE)[number] }
  /** I-189: a local pose use did something (her reading paused for you, a turned face held a barge-in, a nod answer, the two-people note, sitting asked). Closed words and seconds. */
  | { type: 'pose-use'; characterId: string | null; use: PoseUse; event: PoseUseEvent; seconds?: number }
  /** I-166: a turn's small frames (which senses carried one) or her own closer look (which sense, how it ended, why, ms to her next word). Never a picture or a word. */
  | { type: 'see-and-say'; characterId: string | null; event: 'frames'; camera: boolean; screen: boolean }
  | { type: 'see-and-say'; characterId: string | null; event: 'closer'; sense: LookSense; outcome: CloserOutcome; why?: CloserWhy; ms?: number;
      /** 2026-11-22: why no clear picture came (closed words), and how many captures were tried (1–3). */
      miss?: CloserMiss; tries?: number };

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function sensesJournalReason(entry: SensesJournalInput): string {
  switch (entry.type) {
    case 'user-state': return `她觉得你现在：${USER_STATE_LABEL[entry.state]}`;
    case 'music': return MUSIC_REASON[entry.tier];
    case 'feed': return FEED_REASON[entry.outcome];
    case 'listen-tally': return '陪听这一分钟的片段';
    case 'watch-tally': return '一起看这一分钟';
    case 'pause-stuck': return '一次"暂停听"没等到结束，被放开了';
    case 'watch-off': return '和她一起看关了';
    case 'watch-change': return WATCH_CHANGE_REASON[entry.event];
    case 'music-verdict': return entry.music ? '她听出这是音乐' : '她觉得这不是音乐了';
    case 'presence-look': return '她看了一眼你的屏幕，判断你在做什么';
    case 'camera-look': return CAMERA_LOOK_SEEN_WORDS[entry.seen];
    case 'gaze': return GAZE_JOURNAL_REASON[entry.event];
    case 'face-check': return entry.stranger ? '她认出坐在电脑前的不是你' : '她看了看是不是你';
    case 'face-score': return faceScoreReason(entry);
    case 'noticed': return NOTICED_REASON[entry.kind];
    case 'pose-use': return `本机姿势：${POSE_USE_WORDS[entry.use]}`;
    case 'see-and-say': return SEE_AND_SAY_REASON[entry.event];
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildSensesJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): SensesJournalInput | null {
  let body: SensesJournalInput | null = null;
  switch (type) {
    case 'user-state': {
      const confidence = unit(v.confidence);
      if (!characterId || !has(USER_STATES, v.state) || confidence === undefined) return null;
      body = { type, characterId, state: v.state, confidence };
      break;
    }
    case 'music':
      if (!characterId || !has(DANCE_TIERS, v.tier)) return null;
      body = { type, characterId, tier: v.tier, score: unit(v.score) ?? null };
      break;
    case 'feed':
      if (!characterId || !has(FEED_JOURNAL_OUTCOMES, v.outcome) || (v.category != null && !has(FEED_CATEGORIES, v.category))
        || (v.liking != null && !has(FEED_LIKINGS, v.liking))) return null;
      body = { type, characterId, outcome: v.outcome, ...(has(FEED_CATEGORIES, v.category) ? { category: v.category } : {}),
        ...(has(FEED_LIKINGS, v.liking) ? { liking: v.liking } : {}) };
      break;
    case 'listen-tally': {
      const count = (n: unknown) => finite(n) && (n as number) >= 0 && (n as number) <= 100_000 ? Math.round(n as number) : null;
      const received = count(v.received), skippedPaused = count(v.skippedPaused), withText = count(v.withText), empty = count(v.empty), failed = count(v.failed);
      if (received === null || skippedPaused === null || withText === null || empty === null || failed === null) return null;
      const skippedBusy = v.skippedBusy === undefined ? undefined : count(v.skippedBusy);
      if (skippedBusy === null) return null;
      body = { type, characterId, received, skippedPaused, withText, empty, failed, ...(skippedBusy ? { skippedBusy } : {}) };
      break;
    }
    case 'watch-tally': {
      const count = (n: unknown, max = 1_000_000) => finite(n) && (n as number) >= 0 && (n as number) <= max ? Math.round(n as number) : null;
      const described = count(v.described), skipped = count(v.skipped), failed = count(v.failed), late = count(v.late), summaries = count(v.summaries), heard = count(v.heard);
      const haikuCalls = count(v.haikuCalls), haikuMs = count(v.haikuMs, 100_000_000), keywordHits = count(v.keywordHits), cacheFiles = count(v.cacheFiles), cacheKb = count(v.cacheKb, 100_000_000);
      if (described === null || skipped === null || failed === null || late === null || summaries === null || heard === null || haikuCalls === null
        || haikuMs === null || keywordHits === null || cacheFiles === null || cacheKb === null) return null;
      const seconds = (n: unknown) => n === undefined ? undefined : count(n, 3600);
      const hearS = seconds(v.hearS), pausedS = seconds(v.pausedS), noCaptureS = seconds(v.noCaptureS);
      if (hearS === null || pausedS === null || noCaptureS === null) return null;
      body = { type, characterId, described, skipped, failed, late, summaries, heard, haikuCalls, haikuMs, keywordHits, cacheFiles, cacheKb,
        ...(hearS !== undefined || pausedS !== undefined || noCaptureS !== undefined ? { hearS: hearS ?? 0, pausedS: pausedS ?? 0, noCaptureS: noCaptureS ?? 0 } : {}) };
      break;
    }
    case 'pause-stuck':
      if (!has(PAUSE_STUCK_KINDS, v.what)) return null;
      body = { type, characterId, what: v.what };
      break;
    case 'watch-off':
      if (!has(WATCH_OFF_WHYS, v.why)) return null;
      body = { type, characterId, why: v.why };
      break;
    case 'watch-change': {
      const event = v.event, why = v.why;
      if (!has(WATCH_CHANGE_EVENTS, event)) return null;
      if (event === 'share-lost' ? !has(WATCH_LOST_WHYS, why) : event === 'not-resumed' ? !has(WATCH_NOT_RESUMED_WHYS, why) : why != null) return null;
      const away = v.awayS === undefined ? undefined : finite(v.awayS) && (v.awayS as number) >= 0 && (v.awayS as number) <= 604_800 ? Math.round(v.awayS as number) : null;
      if (away === null || (away !== undefined && event !== 'resumed' && event !== 'not-resumed')) return null;
      body = { type, characterId, event, ...(why != null ? { why: why as WatchLostWhy | WatchNotResumedWhy } : {}), ...(away !== undefined ? { awayS: away } : {}) };
      break;
    }
    case 'music-verdict': {
      const score = unit(v.score), beat = unit(v.beat), speech = unit(v.speech), soundS = finite(v.soundS) && v.soundS >= 0 && v.soundS <= 60 ? round(v.soundS, 1) : undefined;
      if (!characterId || typeof v.music !== 'boolean' || score === undefined || beat === undefined || speech === undefined || soundS === undefined) return null;
      if (v.music) { body = { type, characterId, music: true, score, beat, speech, soundS }; break; }
      if (!has(MUSIC_OFF_REASONS, v.why)) return null;
      body = { type, characterId, music: false, score, beat, speech, soundS, why: v.why };
      break;
    }
    case 'presence-look':
      if (v.look !== 'failed' && !has(SCREEN_LOOKS, v.look)) return null;
      body = { type, characterId, look: v.look as ScreenLook | 'failed' };
      break;
    case 'camera-look':
      // A clear look says how it was asked for and nothing else; no clear look says why; 'later' says neither.
      if (!has(CAMERA_LOOK_SEEN, v.seen)) return null;
      if (v.seen === 'clear' ? !has(CAMERA_LOOK_VIA, v.via) || v.why != null
        : v.seen === 'later' ? v.via != null || v.why != null : !has(CAMERA_LOOK_WHY, v.why) || v.via != null) return null;
      if (v.out != null && (v.out !== true || v.seen !== 'later')) return null; // 2026-11-21: only 'later' says its line was said out in Unbound
      // 2026-11-21: a miss only on a failed or frameless look, a stage and an end only on a cut-short one (closed words).
      if (v.miss != null && (!has(CAMERA_LOOK_MISSES, v.miss) || (v.why !== 'look-failed' && v.why !== 'no-frame'))) return null;
      if ((v.stage != null && (!has(CAMERA_LOOK_STAGES, v.stage) || v.why !== 'cut-short')) || (v.end != null && (!has(CAMERA_LOOK_ENDS, v.end) || v.why !== 'cut-short'))) return null;
      body = { type, characterId, seen: v.seen, ...(v.seen === 'clear' ? { via: v.via as CameraLookVia } : {}),
        ...(v.seen === 'small' || v.seen === 'none' ? { why: v.why as CameraLookWhy } : {}),
        ...(v.out === true ? { out: true as const } : {}), ...(v.miss != null ? { miss: v.miss as CameraLookMiss } : {}), ...(v.stage != null ? { stage: v.stage as CameraLookStage } : {}), ...(v.end != null ? { end: v.end as CameraLookEnd } : {}) };
      break;
    case 'gaze': {
      // start and stop say why (their own words); eye-contact and shy say nothing more.
      if (!has(GAZE_JOURNAL_EVENTS, v.event)) return null;
      const whys: readonly string[] = v.event === 'start' ? ['arrived', 'facing'] : v.event === 'stop' ? ['left', 'turned', 'off', 'asleep'] : [];
      if (whys.length ? !whys.includes(v.why as string) : v.why != null) return null;
      body = { type, characterId, event: v.event, ...(whys.length ? { why: v.why as GazeJournalWhy } : {}) };
      break;
    }
    case 'face-check': {
      // Five counts, nothing else (no picture, embedding or score ever fits here).
      const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
      if (![v.matched, v.notYou, v.unsure, v.skipped, v.stranger].every(count)) return null;
      body = { type, characterId, matched: v.matched as number, notYou: v.notYou as number, unsure: v.unsure as number, skipped: v.skipped as number, stranger: v.stranger as number };
      break;
    }
    case 'face-score':
      body = buildFaceScoreEntry(v, characterId);
      if (!body) return null;
      break;
    case 'noticed':
      // Three closed words; nothing else fits (no duration, no words, no picture).
      if (!has(NOTICED_JOURNAL_KINDS, v.kind) || !has(NOTICED_JOURNAL_BANDS, v.band) || !has(NOTICED_JOURNAL_SPOKE, v.spoke)) return null;
      body = { type, characterId, kind: v.kind, band: v.band, spoke: v.spoke };
      break;
    case 'pose-use': {
      // I-189: two closed words and an optional number of seconds; nothing else fits.
      const fact = parsePoseUseFact({ use: v.use, event: v.event, ...(v.seconds != null ? { seconds: v.seconds } : {}) });
      if (!fact) return null;
      body = { type, characterId, ...fact };
      break;
    }
    case 'see-and-say':
      // Closed values only: two booleans for a turn's small frames; a sense, an outcome, a reason and a bounded number for a closer look.
      if (!has(SEE_AND_SAY_EVENTS, v.event)) return null;
      if (v.event === 'frames') {
        if (typeof v.camera !== 'boolean' || typeof v.screen !== 'boolean') return null;
        body = { type, characterId, event: 'frames', camera: v.camera, screen: v.screen };
        break;
      }
      if (!has(LOOK_SENSES, v.sense) || !has(CLOSER_OUTCOMES, v.outcome) || (v.why != null && !has(CLOSER_WHYS, v.why))
        || (v.ms != null && !(finite(v.ms) && v.ms >= 0 && v.ms <= 600_000)) || (v.miss != null && !has(CLOSER_MISSES, v.miss))
        || (v.tries != null && !(Number.isInteger(v.tries) && (v.tries as number) >= 1 && (v.tries as number) <= 3))) return null;
      body = { type, characterId, event: 'closer', sense: v.sense, outcome: v.outcome, ...(v.why != null ? { why: v.why as CloserWhy } : {}), ...(v.ms != null ? { ms: Math.round(v.ms as number) } : {}),
        ...(v.miss != null ? { miss: v.miss as CloserMiss } : {}), ...(v.tries != null ? { tries: v.tries as number } : {}) };
      break;
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeSensesJournalEntry(entry: SensesJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'user-state': body = tr('{0}（把握 {1}）', reason, entry.confidence.toFixed(2)); break;
    case 'feed': body = entry.category ? tr('{0}（{1}）', reason, entry.liking && entry.liking !== '不知道' ? tr('{0} · {1}', tr(entry.category), tr(entry.liking)) : tr(entry.category)) : reason; break;
    case 'listen-tally':
      body = tr('{0}：收到 {1} 段，暂停时跳过 {2} 段，有字 {3} 段，没字 {4} 段，出错 {5} 段', reason, String(entry.received), String(entry.skippedPaused), String(entry.withText), String(entry.empty), String(entry.failed))
        + (entry.skippedBusy ? tr('；识别排满跳过 {0} 段', String(entry.skippedBusy)) : '');
      break;
    case 'watch-tally':
      body = tr('{0}：描述了 {1} 帧，跳过 {2} 帧，失败 {3} 帧，迟到丢掉 {4} 个，概要 {5} 次，听到 {6} 段，haiku {7} 次共 {8} 秒，关键词命中 {9} 次，截图缓存 {10} 张 {11} KB',
        reason, String(entry.described), String(entry.skipped), String(entry.failed), String(entry.late), String(entry.summaries), String(entry.heard),
        String(entry.haikuCalls), (entry.haikuMs / 1000).toFixed(1), String(entry.keywordHits), String(entry.cacheFiles), String(entry.cacheKb))
        + (entry.hearS !== undefined ? tr('；台词能听到 {0} 秒，暂停 {1} 秒，没采到电脑的声音 {2} 秒', String(entry.hearS), String(entry.pausedS ?? 0), String(entry.noCaptureS ?? 0)) : '');
      break;
    case 'pause-stuck':
      body = tr('{0}（{1}）', reason, tr(PAUSE_STUCK_LABEL[entry.what]));
      break;
    case 'watch-off':
      body = tr('{0}（{1}）', reason, tr(WATCH_OFF_LABEL[entry.why]));
      break;
    case 'watch-change':
      body = reason + (entry.why ? tr('（{0}）', tr(WATCH_CHANGE_LABEL[entry.why])) : '') + (entry.awayS !== undefined ? tr('；离开了 {0} 秒', String(entry.awayS)) : '');
      break;
    case 'music-verdict':
      body = tr('{0}（像音乐 {1} · 节拍 {2} · 像说话 {3} · 有声 {4} 秒{5}）', reason, entry.score.toFixed(2), entry.beat.toFixed(2), entry.speech.toFixed(2), entry.soundS.toFixed(1),
        entry.why ? tr('；原因：{0}', tr(MUSIC_OFF_LABEL[entry.why])) : '');
      break;
    case 'presence-look':
      body = tr('{0}（{1}）', reason, tr(SCREEN_LOOK_WORDS[entry.look]));
      break;
    case 'camera-look':
      body = entry.via ? tr('{0}（{1}）', reason, tr(CAMERA_LOOK_VIA_WORDS[entry.via])) : entry.why ? tr('{0}（{1}）', reason, [tr(CAMERA_LOOK_WHY_WORDS[entry.why]),
        ...(entry.miss ? [tr(CAMERA_LOOK_MISS_WORDS[entry.miss])] : []), ...(entry.stage ? [tr(CAMERA_LOOK_STAGE_WORDS[entry.stage])] : []), ...(entry.end ? [tr(CAMERA_LOOK_END_WORDS[entry.end])] : [])].reduce((all, part) => tr('{0}；{1}', all, part))) : entry.out ? tr('{0}（{1}）', reason, tr(CAMERA_LOOK_OUT_WORD)) : reason;
      break;
    case 'gaze':
      body = entry.why ? tr('{0}（{1}）', reason, tr(GAZE_JOURNAL_WHY_WORDS[entry.why])) : reason;
      break;
    case 'pose-use':
      body = tr('{0}（{1}）', reason, entry.seconds !== undefined ? tr('{0}，约 {1} 秒', tr(POSE_USE_EVENT_WORDS[entry.event]), String(entry.seconds)) : tr(POSE_USE_EVENT_WORDS[entry.event]));
      break;
    case 'noticed':
      body = tr('{0}（{1}）', reason, entry.band === 'maybe' ? tr('好像；{0}', tr(NOTICED_SPOKE_WORDS[entry.spoke])) : tr(NOTICED_SPOKE_WORDS[entry.spoke]));
      break;
    case 'face-check':
      body = tr('{0}（{1}）', reason, tr('认出你 {0} 次，明显不是你 {1} 次，拿不准当成你 {2} 次，跳过 {3} 次，当成陌生人 {4} 回',
        String(entry.matched), String(entry.notYou), String(entry.unsure), String(entry.skipped), String(entry.stranger)));
      break;
    case 'face-score': body = describeFaceScore(entry, reason, tr); break;
    case 'see-and-say':
      body = entry.event === 'frames'
        ? tr('{0}（{1}）', reason, entry.camera && entry.screen ? tr('摄像头和屏幕') : entry.camera ? tr('摄像头') : entry.screen ? tr('屏幕') : tr('这一轮一张也没备好'))
        : tr('{0}（{1}：{2}{3}{4}）', reason, tr(LOOK_SENSE_WORDS[entry.sense]), tr(CLOSER_OUTCOME_WORDS[entry.outcome]), (entry.why ? tr('；{0}', tr(CLOSER_WHY_WORDS[entry.why])) : '')
          + (entry.miss ? tr('；{0}', tr(CLOSER_MISS_WORDS[entry.miss])) : '') + (entry.tries !== undefined && entry.tries > 1 ? tr('；试了 {0} 次', String(entry.tries)) : ''), // 2026-11-22
          entry.ms !== undefined ? tr('；{0} 秒后接着说', (entry.ms / 1000).toFixed(1)) : '');
      break;
    default: body = reason;
  }
  return body;
}
