// 体验记录 (the experience journal): the entry types of the stage part (舞台): her-life, motion, topmost-fix, launch-time, mouth-reading, gpu-reset.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { count, finite, has, round, type JournalTranslate } from '../foundation/journal-fields';
import { GPU_PROCESS_ENDS, GPU_RESET_EVENTS, type GpuProcessEnd, type GpuResetEvent } from '../foundation/gpu-reset';
import { HER_LIFE_ACTIVITIES, type HerLifeActivity } from './her-life';
import { frameTimeFrom, frameTimeReason, frameTimeWords, gpuStartFrom, gpuStartReason, gpuStartWords, type FrameTimeRow, type GpuStartRow } from './smooth-journal';

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
export const TOPMOST_FIX_OUTCOMES = ['applied', 'forced', 'failed', 'unchanged'] as const;
export type TopmostFixOutcome = (typeof TOPMOST_FIX_OUTCOMES)[number];
/**
 * 嘴型记录 (2026-11-22): one line per reply read aloud on the
 * Unbound engine: for each stretch she spoke without a pause (≈ a sentence), which expression held her face most of it (a closed word, 'none')
 * and how far her lips parted at most, as a share of that model's own あ at full (0..2), and whether the floor or the ceiling held the flap.
 */
export const MOUTH_READING_WORDS = ['none', 'confirm-smile', 'warm-smile', 'laugh', 'pout', 'shy', 'surprise', 'sly', 'content', 'yawn'] as const;
export type MouthReadingWord = (typeof MOUTH_READING_WORDS)[number];
/** At most this many stretches in one line (a longer reading keeps its first ones). */
export const MOUTH_READING_MAX = 24;
export interface MouthReadingSentence { readonly word: MouthReadingWord; readonly peak: number; readonly floor: boolean; readonly ceiling: boolean }
const MOUTH_WORD_LABEL: Readonly<Record<MouthReadingWord, string>> = { none: '没表情', 'confirm-smile': '轻笑', 'warm-smile': '暖笑', laugh: '笑出声', pout: '撅嘴',
  shy: '害羞', surprise: '吃惊', sly: '坏笑', content: '满足', yawn: '哈欠' };
const ACTIVITY_LABEL: Readonly<Record<HerLifeActivity, string>> = { company: '陪着你', daydream: '发呆', humming: '哼歌', thinking: '想事情', drowsy: '犯困', watching: '跟着看' };
const TOPMOST_OUTCOME_LABEL: Readonly<Record<TopmostFixOutcome, string>> = { applied: '一次补回', forced: '反复切换后补回', failed: '没补回来', unchanged: '已经在置顶' };

/**
 * 2026-11-23 (a hug she wrote was silently turned away): a kiss or a hug her reply wrote that did not walk up, with the
 * closed block word (shared/unbound/close-moments/chat.ts CHAT_CLOSE_BLOCKS: the same list, checked by tests/action-ends.test.ts).
 */
export const CLOSE_BEAT_SKIP_KINDS = ['kiss', 'hug'] as const;
export const CLOSE_BEAT_SKIP_BLOCKS = ['not-shown', 'asleep', 'call', 'typing', 'pulled', 'busy', 'arms', 'cooldown', 'unready', 'unreached', 'waited'] as const;
export type CloseBeatSkipBlock = (typeof CLOSE_BEAT_SKIP_BLOCKS)[number];
/**
 * 2026-11-25 (the journal then had no row for it): one row per kiss or hug her reply wrote in full-screen, once its
 * fate is known: it landed (her hold was reached) or not, and why not (shared/unbound/close-moments/chat.ts CloseBeatWhy: the block words and
 * how a walk-up ended without its hold; the same lists, checked by tests/close-moments-1626.test.ts). `arms: 'still'`: a hug whose arms could
 * not move on this model (her face came).
 */
export const CLOSE_BEAT_OUTCOMES = ['played', 'not-played'] as const;
export const CLOSE_BEAT_WHYS = [...CLOSE_BEAT_SKIP_BLOCKS, 'pulled-away', 'game', 'timeout', 'input', 'reply', 'fullscreen', 'left'] as const;
export type CloseBeatJournalWhy = (typeof CLOSE_BEAT_WHYS)[number];
/** 2026-11-23: an action of hers you ended directly (shared/unbound/action-ends ACTION_KINDS, USER_END_CAUSES: the same lists). */
export const INTERRUPTED_ACTIONS = ['kiss', 'hug', 'look', 'walk', 'life', 'beat', 'opening', 'act'] as const;
export type InterruptedAction = (typeof INTERRUPTED_ACTIONS)[number];
export const INTERRUPTED_BY = ['pull', 'click'] as const;
/**
 * 2026-11-23 (her go-words left no row about whether she walked): one row per "go where" word she wrote ('go-beat'; the
 * same lists as shared/unbound/her-position/ask.ts GO_WORDS and journal.ts GO_STAY_WHYS, held equal by tests/i193-walk-log.test.ts) and one per walk
 * of her own life that ended ('place-moved': whose walk, where she stands now in rough words, the metres). Closed words and numbers only.
 */
export const GO_JOURNAL_WORDS = ['go-left', 'go-right', 'go-middle', 'come-near', 'go-far', 'go-corner', 'go-cursor', 'go'] as const;
/** I-193 numbers: the largest target a go-beat row keeps (a whole percent across, told metres); the same bounds as her-position/ask.ts GO_TARGET_MAX. */
export const GO_TARGET_JOURNAL_MAX = Object.freeze({ percent: 999, metres: 999.9 });
export const GO_STAY_JOURNAL_WHYS = ['not-shown', 'asleep', 'pulled', 'playing', 'typing', 'close-moment', 'already-there', 'cursor-stale', 'covered', 'no-place', 'queued', 'dropped'] as const;
export const GO_OUTCOMES = ['went', 'stayed'] as const;
export const PLACE_MOVED_BY = ['go-word', 'own'] as const;
export const PLACE_SIDES = ['left', 'middle', 'right'] as const;
export const PLACE_RANGES = ['very-near', 'near', 'middle', 'far'] as const;
/** I-212: her hidden ⟪keep-place⟫ / ⟪clear-place⟫ in her reply to the user (electron/unbound/place-marks.ts): which, and whether it took (closed words). */
export const DEFAULT_PLACE_ACTIONS = ['keep', 'clear'] as const;
/** 2026-11-24: the panel's 「设为默认位置」 click writes a row too; 'done' = kept, the rest say why nothing was kept (electron/unbound/place-keeper.ts keepHere). */
export const DEFAULT_PLACE_OUTCOMES = ['done', 'not-out', 'refused', 'out-of-reach', 'no-height', 'moving', 'not-saved'] as const;
const DEFAULT_PLACE_OUTCOME_LABEL: Readonly<Record<(typeof DEFAULT_PLACE_OUTCOMES)[number], string>> = { done: '记好了', 'not-out': '她当时不在全屏里，没有记', refused: '那个位置太近或太远，没有记',
  'out-of-reach': '她被拉得比"只有脸"还近（或太远），没有记', 'no-height': '她的身高还没量出来，没有记', moving: '她正在走，没有记', 'not-saved': '记了但写不进文件（下次进全屏不会从这儿出来）' };
/** The farthest a walk can be (m); a larger number is not written. */
export const WALK_METRES_MAX = 100;
/** A go-beat row's target as kept (numbers only: a whole percent, metres to one decimal, at least one; no other key); null otherwise. */
function goTargetRow(value: unknown): { percent?: number; metres?: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (Object.keys(v).some(key => key !== 'percent' && key !== 'metres')) return null;
  const percent = num(v.percent) && Number.isInteger(v.percent) && v.percent >= 0 && v.percent <= GO_TARGET_JOURNAL_MAX.percent ? v.percent : undefined;
  const metres = num(v.metres) && v.metres >= 0 && v.metres <= GO_TARGET_JOURNAL_MAX.metres ? Math.round(v.metres * 10) / 10 : undefined;
  if ((v.percent !== undefined && percent === undefined) || (v.metres !== undefined && metres === undefined) || (percent === undefined && metres === undefined)) return null;
  return { ...(percent !== undefined ? { percent } : {}), ...(metres !== undefined ? { metres } : {}) };
}
const GO_WORD_LABEL: Readonly<Record<(typeof GO_JOURNAL_WORDS)[number], string>> = { 'go-left': '去左边', 'go-right': '去右边', 'go-middle': '到中间', 'come-near': '走近', 'go-far': '走远',
  'go-corner': '去角落', 'go-cursor': '到你鼠标旁边', go: '到指定位置' };
const GO_STAY_LABEL: Readonly<Record<(typeof GO_STAY_JOURNAL_WHYS)[number], string>> = { 'not-shown': '她不在全屏里', asleep: '她当时睡着了', pulled: '你正拉着她', playing: '你们正在玩游戏',
  typing: '你正在打字', 'close-moment': '正在凑近看或亲亲抱抱', 'already-there': '她已经站在那儿了', 'cursor-stale': '不知道你的鼠标在哪', covered: '那个位置会挡住你要用的窗口',
  'no-place': '还不知道自己站在哪', queued: '上一个走位还没排完', dropped: '等了太久没能走成' };
const PLACE_SIDE_LABEL: Readonly<Record<(typeof PLACE_SIDES)[number], string>> = { left: '屏幕偏左', middle: '屏幕中间', right: '屏幕偏右' };
const PLACE_RANGE_LABEL: Readonly<Record<(typeof PLACE_RANGES)[number], string>> = { 'very-near': '几乎贴着屏幕', near: '离用户比较近', middle: '离用户不远不近', far: '离用户比较远' };
const SKIP_KIND_LABEL: Readonly<Record<(typeof CLOSE_BEAT_SKIP_KINDS)[number], string>> = { kiss: '亲亲', hug: '抱抱' };
const SKIP_BLOCK_LABEL: Readonly<Record<CloseBeatSkipBlock, string>> = { 'not-shown': '她不在全屏里', asleep: '她睡着了', call: '在通话', typing: '你正在打字',
  pulled: '你正拉着她', busy: '上一个动作还没做完', arms: '手被游戏占着', cooldown: '冷却（旧记录）', unready: '还没读到她的心情', unreached: '她凑过去了，脸没能到镜头跟前，没做成', waited: '等了很久，话先放出来了' };
const CLOSE_BEAT_WHY_LABEL: Readonly<Record<CloseBeatJournalWhy, string>> = { ...SKIP_BLOCK_LABEL, arms: '手被游戏或递东西占着', unreached: '脸没能到镜头跟前',
  'pulled-away': '你用力把她拉开了', game: '开始玩游戏了', timeout: '走过来太久，超时了', input: '被打断了', reply: '被新的回复打断了', fullscreen: '前面有全屏程序', left: '中途结束了（离开全屏或被别的接过去）' };
const INTERRUPTED_LABEL: Readonly<Record<InterruptedAction, string>> = { kiss: '亲亲', hug: '抱抱', look: '凑近看', walk: '走过去', life: '自己的小动作',
  beat: '边说边演', opening: '开口前的动作', act: '一个动作' };
const INTERRUPTED_BY_LABEL: Readonly<Record<(typeof INTERRUPTED_BY)[number], string>> = { pull: '用力拉开', click: '点了她' };

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const STAGE_JOURNAL_TYPES = ['her-life', 'motion', 'topmost-fix', 'launch-time', 'mouth-reading', 'gpu-reset', 'close-beat-skipped', 'action-interrupted', 'go-beat', 'place-moved', 'default-place', 'gpu-start', 'frame-time', 'close-beat'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type StageJournalInput =
  | { type: 'her-life'; characterId: string; from: HerLifeActivity; to: HerLifeActivity; untilMinutes: number | null; test?: boolean }
  /** 动作跳变记录: numbers, the model's bone or morph name and closed activity names (never chat). */
  | { type: 'motion'; characterId: string; kind: MotionGlitchKind; part: 'bone' | 'morph' | 'geometry' | 'gpu'; name: string; size: number; activities: MotionActivity[];
      fps: number | null; frameMs: number | null; cleared?: boolean }
  /** 置顶守护补回: one repair of the companion window's topmost style (never the foreground app). */
  | { type: 'topmost-fix'; characterId: string | null; outcome: TopmostFixOutcome; visible: boolean; nth: number }
  /** 应用启动到她出现: ms from the app's start to the companion stage fully faded in. */
  | { type: 'launch-time'; characterId: string | null; ms: number }
  /** 嘴型记录: per stretch of one reply read aloud, the expression word and the peak opening (numbers and closed words only). */
  | { type: 'mouth-reading'; characterId: string; sentences: MouthReadingSentence[] }
  /**
   * 显卡重置 (docs/claude/2026-11-22-gpu-reset.md): the GPU process went away ('gone': how it ended, its exit code) or WebGL went off for
   * the rest of the run ('software'); how many ends in the last 10 minutes and in this run. Closed words and numbers only.
   */
  | { type: 'gpu-reset'; characterId: string | null; event: GpuResetEvent; ended: GpuProcessEnd | null; exitCode: number | null; recent: number; total: number }
  /** 2026-11-23: a kiss or a hug her reply wrote did not walk up: which, and the closed block word. Never a word of chat. */
  | { type: 'close-beat-skipped'; characterId: string | null; kind: (typeof CLOSE_BEAT_SKIP_KINDS)[number]; block: CloseBeatSkipBlock }
  /** 2026-11-23: you ended an action of hers directly: which action, by what (closed words). */
  | { type: 'action-interrupted'; characterId: string | null; action: InterruptedAction; by: (typeof INTERRUPTED_BY)[number] }
  /**
   * 2026-11-23: a "go where" word of hers: whether she walked (with the metres the walk is for) or stayed (the closed reason). I-193 numbers
   * (2026-11-24): `target`, only when ⟦go …⟧ carried numbers: the percent across and the told metres she asked for (numbers only, no text).
   */
  | { type: 'go-beat'; characterId: string | null; word: (typeof GO_JOURNAL_WORDS)[number]; outcome: (typeof GO_OUTCOMES)[number]; why: (typeof GO_STAY_JOURNAL_WHYS)[number] | null; metres: number | null;
    target?: { percent?: number; metres?: number } }
  /** 2026-11-23: a walk of hers ended: whose it was, where she stands now (rough words) and the metres she moved. */
  | { type: 'place-moved'; characterId: string | null; by: (typeof PLACE_MOVED_BY)[number]; side: (typeof PLACE_SIDES)[number]; range: (typeof PLACE_RANGES)[number]; metres: number }
  /** 2026-11-24 (I-212): a hidden place marker in her reply to you: keep or clear your default place, and whether it took. */
  | { type: 'default-place'; characterId: string | null; action: (typeof DEFAULT_PLACE_ACTIONS)[number]; outcome: (typeof DEFAULT_PLACE_OUTCOMES)[number] }
  /** 2026-11-24 (docs/claude/2026-11-24-stage-smooth.md): once at start, which graphics chip draws WebGL (closed words); once a minute per full-screen instance, its frame times (numbers). */
  | ({ type: 'gpu-start'; characterId: string | null } & GpuStartRow)
  | ({ type: 'frame-time'; characterId: string | null } & FrameTimeRow)
  /** 2026-11-25: a kiss or a hug her reply wrote, once its fate is known: played or not, why not (closed words); never a word of chat. */
  | { type: 'close-beat'; characterId: string | null; kind: (typeof CLOSE_BEAT_SKIP_KINDS)[number]; outcome: (typeof CLOSE_BEAT_OUTCOMES)[number]; why: CloseBeatJournalWhy | null; arms?: 'still' };

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function stageJournalReason(entry: StageJournalInput): string {
  switch (entry.type) {
    case 'her-life': return `她开始${ACTIVITY_LABEL[entry.to]}`;
    case 'motion': return entry.kind === 'guard' ? '显示护栏接住了一次动作跳变' : entry.kind === 'block' ? '窗口里突然出现了一块色块' : '物理骨骼一帧里跳了一下';
    case 'topmost-fix': return '桌宠窗口掉出了置顶，已补回';
    case 'launch-time': return '她从应用启动到出现用了这么久';
    case 'mouth-reading': return '她念这条回复时嘴张开了多少';
    case 'gpu-reset': return entry.event === 'gone' ? '显卡进程停了一次，已自动重启' : '显卡反复出错，画面改成软件绘制，她暂时显示不出来';
    case 'close-beat-skipped': if (entry.block === 'unreached') return entry.kind === 'kiss' ? '她凑过去亲，没做成' : '她凑过去抱，没做成'; return entry.kind === 'kiss' ? '她回复里写的亲亲没有走过来做' : '她回复里写的抱抱没有走过来做';
    case 'action-interrupted': return '你打断了她正在做的动作';
    case 'go-beat': return entry.outcome === 'went' ? '她回复里写的走位词，她走过去了' : '她回复里写的走位词，她没有走';
    case 'place-moved': return entry.by === 'go-word' ? '她按回复里写的走到了新的位置' : '她自己换了个地方站';
    case 'gpu-start': return gpuStartReason(entry);
    case 'frame-time': return frameTimeReason();
    case 'default-place': return entry.action === 'keep' ? '她把站的地方记成了你给她定的出场位置' : '她清掉了你给她定的出场位置';
    case 'close-beat': if (entry.outcome === 'played') return entry.kind === 'kiss' ? '她回复里写的亲亲，亲到了' : '她回复里写的抱抱，抱到了';
      return entry.kind === 'kiss' ? '她回复里写的亲亲，没亲成' : '她回复里写的抱抱，没抱成';
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildStageJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): StageJournalInput | null {
  let body: StageJournalInput | null = null;
  switch (type) {
    case 'her-life': {
      if (!characterId || !has(HER_LIFE_ACTIVITIES, v.from) || !has(HER_LIFE_ACTIVITIES, v.to)) return null;
      const until = v.untilMinutes === null ? null : count(v.untilMinutes, 24 * 60);
      body = { type, characterId, from: v.from, to: v.to, untilMinutes: until ?? null, ...(v.test === true ? { test: true } : {}) };
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
    case 'mouth-reading': {
      const list: unknown[] = Array.isArray(v.sentences) ? v.sentences : [];
      if (!characterId || !list.length || list.length > MOUTH_READING_MAX) return null;
      const sentences: MouthReadingSentence[] = [];
      for (const item of list) {
        const s = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
        if (!s || !has(MOUTH_READING_WORDS, s.word) || !finite(s.peak) || s.peak < 0 || s.peak > 2 || typeof s.floor !== 'boolean' || typeof s.ceiling !== 'boolean') return null;
        sentences.push({ word: s.word, peak: round(s.peak, 2), floor: s.floor, ceiling: s.ceiling });
      }
      body = { type, characterId, sentences };
      break;
    }
    case 'gpu-reset': {
      const recent = count(v.recent, 1_000_000), total = count(v.total, 1_000_000);
      if (!has(GPU_RESET_EVENTS, v.event) || recent === undefined || total === undefined) return null;
      const gone = v.event === 'gone';
      if (gone ? !has(GPU_PROCESS_ENDS, v.ended) : v.ended !== null) return null;
      const exitCode = gone && finite(v.exitCode) && Number.isInteger(v.exitCode) && v.exitCode >= -2_147_483_648 && v.exitCode <= 4_294_967_295 ? v.exitCode : null;
      body = { type, characterId, event: v.event, ended: gone ? v.ended as GpuProcessEnd : null, exitCode, recent, total };
      break;
    }
    case 'close-beat-skipped':
      if (!has(CLOSE_BEAT_SKIP_KINDS, v.kind) || !has(CLOSE_BEAT_SKIP_BLOCKS, v.block)) return null;
      body = { type, characterId, kind: v.kind, block: v.block };
      break;
    case 'action-interrupted':
      if (!has(INTERRUPTED_ACTIONS, v.action) || !has(INTERRUPTED_BY, v.by)) return null;
      body = { type, characterId, action: v.action, by: v.by };
      break;
    case 'go-beat': {
      if (!has(GO_JOURNAL_WORDS, v.word) || !has(GO_OUTCOMES, v.outcome)) return null;
      const went = v.outcome === 'went', metres = finite(v.metres) && v.metres >= 0 && v.metres <= WALK_METRES_MAX ? round(v.metres, 1) : null;
      if (went ? v.why !== null : !has(GO_STAY_JOURNAL_WHYS, v.why)) return null;
      if (!went && v.metres !== null) return null;
      const target = goTargetRow(v.target);
      if (v.target !== undefined && (v.word !== 'go' || !target)) return null; // numbers only on `go`, and only numbers
      body = { type, characterId, word: v.word, outcome: v.outcome, why: went ? null : v.why as (typeof GO_STAY_JOURNAL_WHYS)[number], metres: went ? metres : null, ...(target ? { target } : {}) };
      break;
    }
    case 'place-moved':
      if (!has(PLACE_MOVED_BY, v.by) || !has(PLACE_SIDES, v.side) || !has(PLACE_RANGES, v.range) || !finite(v.metres) || v.metres < 0 || v.metres > WALK_METRES_MAX) return null;
      body = { type, characterId, by: v.by, side: v.side, range: v.range, metres: round(v.metres, 1) };
      break;
    case 'gpu-start': { const row = gpuStartFrom(v); if (!row) return null; body = { type, characterId, ...row }; break; }
    case 'frame-time': { const row = frameTimeFrom(v); if (!row) return null; body = { type, characterId, ...row }; break; }
    case 'default-place':
      if (!has(DEFAULT_PLACE_ACTIONS, v.action) || !has(DEFAULT_PLACE_OUTCOMES, v.outcome)) return null;
      body = { type, characterId, action: v.action, outcome: v.outcome };
      break;
    case 'close-beat': {
      if (!has(CLOSE_BEAT_SKIP_KINDS, v.kind) || !has(CLOSE_BEAT_OUTCOMES, v.outcome)) return null;
      const played = v.outcome === 'played';
      if (played ? v.why !== null : !has(CLOSE_BEAT_WHYS, v.why)) return null; // played: no reason; not played: always one
      if (v.arms !== undefined && (v.arms !== 'still' || v.kind !== 'hug' || !played)) return null;
      body = { type, characterId, kind: v.kind, outcome: v.outcome, why: played ? null : v.why as CloseBeatJournalWhy, ...(v.arms === 'still' ? { arms: 'still' as const } : {}) };
      break;
    }
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeStageJournalEntry(entry: StageJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'motion': {
      const doing = (entry.activities.length ? entry.activities : ['idle' as const]).map(item => tr(MOTION_ACTIVITY_LABEL[item])).join(tr('、'));
      if (entry.kind === 'block') {
        const found = entry.part === 'gpu' ? tr('程序里的骨骼、表情和模型数据都正常') : entry.part === 'geometry' ? tr('程序内存里的模型数据坏了') : tr(entry.part === 'bone' ? '骨骼「{0}」的数值坏了' : '表情「{0}」的数值坏了', entry.name);
        body = tr('{0}：{1}，{2}（{3}）', reason, found, tr(entry.cleared ? '重传给显卡后消失了' : '重传给显卡后还在'), doing);
      } else body = tr('{0}：{1} {2}（{3}）', reason, entry.name, entry.part === 'morph' ? entry.size.toFixed(2) : `${entry.size.toFixed(1)}°`, doing);
      break;
    }
    case 'topmost-fix': body = tr('{0}（第 {1} 次 · {2}）', reason, String(entry.nth), tr(TOPMOST_OUTCOME_LABEL[entry.outcome])); break;
    case 'launch-time': body = tr('{0}：{1} 秒', reason, (entry.ms / 1000).toFixed(1)); break;
    case 'gpu-reset': body = tr('{0}（最近 10 分钟第 {1} 次）', reason, String(entry.recent)); break;
    case 'close-beat-skipped': body = tr('{0}：{1}', reason, tr(SKIP_BLOCK_LABEL[entry.block])); break;
    case 'close-beat': body = entry.why ? tr('{0}：{1}', reason, tr(CLOSE_BEAT_WHY_LABEL[entry.why])) : entry.arms === 'still' ? tr('{0}（手臂没动，脸贴过来了）', reason) : reason; break;
    case 'go-beat': {
      const t = entry.target, aim = t ? [t.percent !== undefined ? tr('横向 {0}%', String(t.percent)) : '', t.metres !== undefined ? tr('离你约 {0} 米', String(t.metres)) : ''].filter(Boolean).join(tr('、')) : '';
      const word = aim ? tr('{0}（{1}）', tr(GO_WORD_LABEL[entry.word]), aim) : tr(GO_WORD_LABEL[entry.word]); // I-193: what ⟦go …⟧ asked for
      body = entry.outcome === 'went' ? tr(entry.metres === null ? '{0}：{1}' : '{0}：{1}（{2} 米）', reason, word, String(entry.metres)) : tr('{0}：{1}（{2}）', reason, word, tr(GO_STAY_LABEL[entry.why!]));
      break;
    }
    case 'place-moved': body = tr('{0}：{1}，{2}（走了 {3} 米）', reason, tr(PLACE_SIDE_LABEL[entry.side]), tr(PLACE_RANGE_LABEL[entry.range]), String(entry.metres)); break;
    case 'gpu-start': body = gpuStartWords(entry, reason, tr); break;
    case 'frame-time': body = frameTimeWords(entry, reason, tr); break;
    case 'default-place': body = tr('{0}（{1}）', reason, tr(DEFAULT_PLACE_OUTCOME_LABEL[entry.outcome])); break;
    case 'action-interrupted': body = tr('{0}：{1}（{2}）', reason, tr(INTERRUPTED_LABEL[entry.action]), tr(INTERRUPTED_BY_LABEL[entry.by])); break;
    case 'mouth-reading': body = tr('{0}：{1}', reason, entry.sentences.map(s => tr(s.floor ? '{0} {1}（托底）' : s.ceiling ? '{0} {1}（封顶）' : '{0} {1}', tr(MOUTH_WORD_LABEL[s.word]), s.peak.toFixed(2))).join(tr('、'))); break;
    default: body = reason;
  }
  return body;
}
