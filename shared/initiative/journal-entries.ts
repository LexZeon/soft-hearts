// 体验记录 (the experience journal): the entry types of the initiative part (她主动做的事): inner-loop, rps, her-folder, give, hands, self-look, initiative.
// shared/memory/journal.ts joins every part's slice and keeps THE BOUNDARY written at its top: a line holds times, the character
// id, a type, fixed enum values, numbers and a plain-language reason from a fixed table; never a word of chat, a file path or a key.
// Moved here from shared/memory/journal.ts on 2026-11-16 (docs/claude/2026-11-16-journal-split.md) without changing a line it writes.
// THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
// <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
// name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES in shared/memory/journal.ts, valid inputs for it into
// BASES in tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
// scripts/dev/journal-behaviour.ts --write), saying why in the commit. A part without a slice gets one: a new file like this, one
// entry in each of the four slice tables of shared/memory/journal.ts, and its names on the part's index.ts.
import { count, has, type JournalTranslate } from '../foundation/journal-fields';
import { RPS_UNREAD_WHYS, type RpsUnreadWhy } from './rps';
import { PICTURE_REASONS, type PictureReason } from '../behaviors/give/choose';
import { GIVE_ITEM_IDS, GIVE_LEAN_MOMENTS, type GiveItemId, type GiveLeanMoment } from '../behaviors/give/knobs';
import { HAND_OUTCOMES, HAND_USES, HAND_WHYS, type HandOutcome, type HandUse, type HandWhy } from '../behaviors/hands/knobs';
import { INITIATIVE_FLOORS, INITIATIVE_FLOOR_WORDS, INITIATIVE_KINDS, INITIATIVE_KIND_WORDS, INITIATIVE_WHYS, INITIATIVE_WHY_WORDS, URGE_BUCKETS, URGE_BUCKET_WORDS, type InitiativeFloor, type InitiativeKind, type InitiativeWhy, type UrgeBucket } from '../behaviors/impulse/interface';
import { HER_FOLDER_ACTIONS, HER_FOLDER_REFUSALS, type HerFolderActionKind, type HerFolderRefusal } from './her-folder';
import { INNER_LOOP_ACTIONS, INNER_LOOP_RESULTS, type InnerLoopAction, type InnerLoopResult } from './inner-loop';
import { MOMENT_KINDS, MOMENT_OUTCOMES, MOMENT_WHYS, SCREEN_MOMENT_EVENTS, type MomentKind, type MomentOutcome, type MomentWhy, type ScreenMomentEvent } from '../behaviors/moments/interface';
import { SELF_LOOK_RESULTS, SELF_LOOK_RESULT_WORDS, SELF_LOOK_SENSES, SELF_LOOK_SENSE_WORDS, SELF_LOOK_WHYS, SELF_LOOK_WHY_WORDS, type SelfLookResult, type SelfLookSense, type SelfLookWhy } from './self-look';

/** I-087: one reach of hers (shared/behaviors/hands/): which use, how it ended, why she offered (closed words), the first hold ever. */
const HANDS_USE_WORDS: Readonly<Record<HandUse, string>> = { hold: '牵手', pinky: '拉钩', 'high-five': '击掌' };
const HANDS_REASON: Readonly<Record<HandUse, Readonly<Record<HandOutcome, string>>>> = {
  hold: { taken: '她伸手想牵你，你牵住了', 'not-taken': '她伸手想牵你，你没顾上，她悄悄收回了手', 'let-go': '你们牵了一会儿手，松开了', interrupted: '牵手被别的事打断了' },
  pinky: { taken: '你们拉了钩', 'not-taken': '她伸出小指想拉钩，你没顾上，她收回了', 'let-go': '你们拉了钩', interrupted: '拉钩被别的事打断了' },
  'high-five': { taken: '你们击了掌', 'not-taken': '她抬手想击掌，你没顾上，她放下了', 'let-go': '你们击了掌', interrupted: '击掌被别的事打断了' },
};
const HANDS_WHY_WORDS: Readonly<Record<HandWhy, string>> = { rest: '你的鼠标停在她身边', close: '她很想亲近你', scared: '她有点怕、想找你的手', herself: '她自己想',
  shy: '还有点害羞', plan: '你刚说了一件要做的事', game: '猜拳分出了胜负', finished: '你说做完了一件事' };
/** I-086: how one offer ended, or a picture she left you (with its closed reason). */
export const GIVE_JOURNAL_EVENTS = ['taken', 'not-taken', 'interrupted', 'picture'] as const;
export type GiveJournalEvent = (typeof GIVE_JOURNAL_EVENTS)[number];
const GIVE_REASON: Readonly<Record<GiveJournalEvent, string>> = {
  taken: '她递给你的东西，你接住了', 'not-taken': '她递给你的东西，你没顾上接，她悄悄收回去了', interrupted: '她递东西时被别的事打断，收回去了', picture: '她给你留了一张她自己的图',
};
const GIVE_ITEM_WORDS: Readonly<Record<GiveItemId, string>> = { snack: '点心', cushion: '靠垫' };
const GIVE_WHY_WORDS: Readonly<Record<GiveLeanMoment, string>> = { sleepy: '她自己困了', night: '深夜', tired: '你刚说累', still: '你很久没动', playful: '她有点调皮' };
const PICTURE_WHY_WORDS: Readonly<Record<PictureReason, string>> = { late: '你熬到很晚', miss: '她很想你', 'special-day': '特别的日子' };
/** 'line-unread': one of her game lines was not read aloud (`unread` says why; never the line itself). */
export const RPS_JOURNAL_EVENTS = ['invite', 'accept', 'decline', 'expired', 'start', 'result', 'line-unread'] as const;
export type RpsJournalEvent = (typeof RPS_JOURNAL_EVENTS)[number];
export const RPS_ENDS = ['finished', 'timeout', 'quit', 'abandoned'] as const;
const DECISION_LABEL: Readonly<Record<InnerLoopAction, string>> = {
  none: '什么都不做', motion: '做个小动作', look: '看你一眼', speak: '说一句话', switch: '换件事做', invite: '邀你猜拳',
};
const RESULT_LABEL: Readonly<Record<InnerLoopResult, string>> = {
  ok: '完成', delivered: '说出口了', undelivered: '没说出来', invalid: '回答无效', timeout: '超时', cancelled: '取消了', error: '出错了', asleep: '睡着了，不说',
};
const RPS_REASON: Readonly<Record<RpsJournalEvent, string>> = {
  invite: '她邀你猜拳', accept: '你接受了猜拳', decline: '你婉拒了猜拳', expired: '猜拳邀请没人接', start: '开始猜拳', result: '猜拳结束', 'line-unread': '她的一句猜拳台词没读出来',
};
const RPS_UNREAD_WORDS: Readonly<Record<RpsUnreadWhy, string>> = { busy: '聊天或打字占着窗口', 'voice-off': '朗读关着', 'voice-failed': '朗读出了错', 'bubble-hidden': '她的气泡没露出来' };

// ---- I-188 the moments she recognises: what it was, how it ended, why (closed words; never a word said, seen or asked to remind).
const MOMENT_KIND_WORDS: Readonly<Record<MomentKind, string>> = { 'late-night': '深夜你还在用电脑', screen: '一起看时屏幕上出了事', reminder: '你请她提醒的事', 'fullscreen-back': '你从全屏程序里出来',
  'first-today': '今天第一次见', back: '你离开座位又回来', goodnight: '她困得快睡着、你还在',
  posture: '你瘫坐或离屏幕很近很久了', staring: '你盯着屏幕很久没怎么动', 'staring-away': '你盯了很久之后把视线移开了', sitting: '你连续坐了很久没起身', // I-189
  'her-alarm': '她给自己留的心', // I-195
  'close-cut': '她回复里的亲抱被打断了' }; // I-203
const MOMENT_OUTCOME_WORDS: Readonly<Record<MomentOutcome, string>> = { recognised: '认出来了', asked: '要了一次开口机会', spoke: '她说了一句', quiet: '这次没说', skipped: '没告诉她',
  expired: '没等到机会', set: '记下了', cancelled: '取消了' };
const MOMENT_WHY_WORDS: Readonly<Record<MomentWhy, string>> = { typing: '你在打字', call: '你在通话', away: '你不在', asleep: '她睡着了', switch: '开关关着或换了角色', hidden: '她没露面',
  cooldown: '刚说过不久', cap: '说话次数或间隔不够', refused: '这会儿接不了', budget: '互动余额不够', 'not-said': '她决定不说', late: '过了太久', used: '今天或今晚已经有过', chance: '这次没轮到',
  user: '你说不用了', 'quiet-hours': '安静时段' };
const MOMENT_SCREEN_WORDS: Readonly<Record<ScreenMomentEvent, string>> = { error: '报错', stuck: '一直在加载', 'game-over': '游戏输了', win: '游戏赢了', 'download-done': '下载完成', 'video-end': '视频放完' };

// ---- I-050 her folder: the fixed reasons and refusal words.
const HER_FOLDER_REASON: Readonly<Record<HerFolderActionKind, string>> = {
  created: '她在她的文件夹里放了一个文件', changed: '她改了她文件夹里的一个文件', appended: '她在她文件夹里的一个文件后面接着写了',
  trashed: '她把一个文件挪进了她的回收站', restored: '你从她的文件夹里恢复了一项',
};
const HER_FOLDER_REFUSAL_LABEL: Readonly<Record<HerFolderRefusal, string>> = {
  off: '文件夹关着', stale: '开关或文件夹已经变了', malformed: '格式不对', name: '文件名不合格', extension: '不是 .md 或 .txt', size: '单个文件超过 200 KB',
  total: '她的东西总共超过 20 MB', link: '那里是链接或联接', outside: '在文件夹外面', missing: '文件不在了', 'not-file': '不是普通文件', moved: '文件夹被移动或换了', failed: '写入出错',
};
/** A file name as the journal keeps it: a plain top-level .md / .txt name, nothing else. */
const HER_FILE_NAME = /^[^\u0000-\u001f\u007f<>:"/\\|?*]{1,76}\.(?:md|txt|png)$/iu; // I-086: her picture (a PNG the app made) too

/** The journal entry types of this part, in JOURNAL_TYPES order (shared/memory/journal.ts dispatches by it). */
export const INITIATIVE_JOURNAL_TYPES = ['inner-loop', 'rps', 'her-folder', 'give', 'hands', 'self-look', 'initiative', 'moment'] as const;

/** What a caller hands to the writer for this part's types (shared/memory/journal.ts JournalInput joins every part's). */
export type InitiativeJournalInput =
  | { type: 'inner-loop'; characterId: string; cue: 'motion' | 'speech'; decision: InnerLoopAction; result: InnerLoopResult; called: boolean; quiet: boolean; restReminder?: boolean }
  | { type: 'rps'; characterId: string; event: RpsJournalEvent; origin?: 'her' | 'user'; rounds?: number; herWins?: number; userWins?: number; draws?: number;
      result?: 'her' | 'user' | 'none'; end?: (typeof RPS_ENDS)[number]; unread?: RpsUnreadWhy;
      /** How many lines she said in that match (a count, never her words). */
      spoke?: number }
  // ---- I-050 her folder (electron/initiative/her-folder/): one line per action, the file's name and size only, never its content.
  /**
   * `by`: she did it from her reply, or the user restored something. `userFile`: the file was the user's (its original was kept).
   * 'refused': nothing was written; `why` says which check stopped it (no name: it may not be a valid one).
   */
  | { type: 'her-folder'; characterId: string | null; action: HerFolderActionKind | 'refused' | 'mentioned'; by: 'her' | 'user'; name?: string; bytes?: number; userFile?: boolean; why?: HerFolderRefusal }
  /** I-086: one line per offer (the item, how it ended, why it was offered: closed reasons only), or a picture she left (its closed reason). fromFed: the snack was a picture of one you fed her. Never a name, a line or a picture. */
  | { type: 'give'; characterId: string; event: GiveJournalEvent; item: GiveItemId; why: GiveLeanMoment[]; fromFed?: boolean; picture?: PictureReason }
  /** I-087: one reach of hers: which (hold / pinky / high-five), how it ended, the closed reasons she offered; `first` the first hold ever. */
  | { type: 'hands'; characterId: string; use: HandUse; outcome: HandOutcome; why: HandWhy[]; first?: true }
  /** I-085 第 1 步: one moment she wanted to look at you (shared/initiative/self-look.ts): why, which sense, how it ended. Never the line she got or anything seen. */
  | { type: 'self-look'; characterId: string | null; why: SelfLookWhy; sense: SelfLookSense; result: SelfLookResult; hour?: number }
  /** 松绑 (shared/behaviors/impulse/): one reach. The urge's bucket, what she did (talk asks for a speech opportunity; what she then says is the inner loop's own row), or none and why; `floor` only with why 'floor'. Never a word. */
  | { type: 'initiative'; characterId: string; bucket: UrgeBucket; kind: InitiativeKind | 'none'; why?: InitiativeWhy; floor?: InitiativeFloor }
  /** I-188: one moment she recognised (electron/initiative/moments/host.ts): which, how it ended, why (closed), what was on the screen (closed). Never a word. */
  | { type: 'moment'; characterId: string; kind: MomentKind; outcome: MomentOutcome; why?: MomentWhy; screen?: ScreenMomentEvent };

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of this part's entries (shared/memory/journal.ts journalReason). Only enum fields choose it; nothing a caller wrote can reach it. */
export function initiativeJournalReason(entry: InitiativeJournalInput): string {
  switch (entry.type) {
    case 'inner-loop': return `内心循环：${DECISION_LABEL[entry.decision]}`;
    case 'rps': return RPS_REASON[entry.event];
    case 'give': return GIVE_REASON[entry.event];
    case 'hands': return entry.first ? '你们第一次牵了手' : HANDS_REASON[entry.use][entry.outcome];
    case 'self-look': return SELF_LOOK_RESULT_WORDS[entry.result];
    case 'initiative': return INITIATIVE_KIND_WORDS[entry.kind];
    case 'moment': return `她认出的时刻：${MOMENT_KIND_WORDS[entry.kind]}`;
    case 'her-folder': return entry.action === 'refused' ? '她想在她的文件夹里放东西，没放成'
      : entry.action === 'mentioned' ? '她的文件夹还没开，她顺口提了一次' : HER_FOLDER_REASON[entry.action];
  }
}

// ---------------------------------------------------------------- building a line (the whitelist)

/**
 * This part's lines, field by field from closed sets (shared/memory/journal.ts buildJournalEntry checked the input, the type and the
 * character id, and adds the version, the time and the reason). Null when anything does not fit.
 */
export function buildInitiativeJournalEntry(type: string, v: Record<string, unknown>, characterId: string | null): InitiativeJournalInput | null {
  let body: InitiativeJournalInput | null = null;
  switch (type) {
    case 'inner-loop':
      if (!characterId || (v.cue !== 'motion' && v.cue !== 'speech') || !has(INNER_LOOP_ACTIONS, v.decision) || !has(INNER_LOOP_RESULTS, v.result)) return null;
      body = { type, characterId, cue: v.cue, decision: v.decision, result: v.result, called: v.called === true, quiet: v.quiet === true,
        ...(v.restReminder === true ? { restReminder: true } : {}) };
      break;
    case 'rps': {
      if (!characterId || !has(RPS_JOURNAL_EVENTS, v.event)) return null;
      const numbers: Record<string, number> = {};
      for (const key of ['rounds', 'herWins', 'userWins', 'draws', 'spoke'] as const) { const n = count(v[key], 1_000); if (n !== undefined) numbers[key] = n; }
      body = { type, characterId, event: v.event, ...(v.origin === 'her' || v.origin === 'user' ? { origin: v.origin } : {}), ...numbers,
        ...(v.result === 'her' || v.result === 'user' || v.result === 'none' ? { result: v.result } : {}), ...(has(RPS_ENDS, v.end) ? { end: v.end } : {}),
        ...(v.event === 'line-unread' && has(RPS_UNREAD_WHYS, v.unread) ? { unread: v.unread } : {}) };
      break;
    }
    case 'give': {
      if (!characterId || !has(GIVE_JOURNAL_EVENTS, v.event) || !has(GIVE_ITEM_IDS, v.item) || !Array.isArray(v.why) || v.why.length > GIVE_LEAN_MOMENTS.length
        || !v.why.every(w => has(GIVE_LEAN_MOMENTS, w)) || (v.fromFed !== undefined && typeof v.fromFed !== 'boolean')
        || (v.picture != null && !has(PICTURE_REASONS, v.picture)) || ((v.event === 'picture') !== (v.picture != null))) return null;
      body = { type, characterId, event: v.event, item: v.item, why: [...new Set(v.why as GiveLeanMoment[])], ...(v.fromFed === true ? { fromFed: true } : {}),
        ...(v.picture != null ? { picture: v.picture as PictureReason } : {}) };
      break;
    }
    case 'hands': {
      // Closed words only: the use, how it ended, why she offered; the first hold ever is a taken hold.
      if (!characterId || !has(HAND_USES, v.use) || !has(HAND_OUTCOMES, v.outcome) || !Array.isArray(v.why) || v.why.length > HAND_WHYS.length
        || !v.why.every(w => has(HAND_WHYS, w)) || (v.first !== undefined && (v.first !== true || v.use !== 'hold' || v.outcome !== 'taken'))) return null;
      body = { type, characterId, use: v.use, outcome: v.outcome, why: [...new Set(v.why as HandWhy[])], ...(v.first === true ? { first: true as const } : {}) };
      break;
    }
    case 'self-look':
      // Closed words only: why she wanted to, which sense, how it ended. The line haiku wrote is never an input.
      // I-168: `hour`, a bounded count of her looks in the last hour (no cap any more, so the journal shows how often).
      if (!has(SELF_LOOK_WHYS, v.why) || !has(SELF_LOOK_SENSES, v.sense) || !has(SELF_LOOK_RESULTS, v.result)
        || (v.hour != null && !(Number.isInteger(v.hour) && (v.hour as number) >= 1 && (v.hour as number) <= 10_000))) return null;
      body = { type, characterId, why: v.why, sense: v.sense, result: v.result, ...(v.hour != null ? { hour: v.hour as number } : {}) };
      break;
    case 'initiative': {
      // Closed values only: why only with none, floor only with why 'floor'.
      const none = v.kind === 'none';
      if (!characterId || !has(URGE_BUCKETS, v.bucket) || !(none || has(INITIATIVE_KINDS, v.kind)) || (none ? !has(INITIATIVE_WHYS, v.why) : v.why !== undefined)
        || (v.why === 'floor' ? !has(INITIATIVE_FLOORS, v.floor) : v.floor !== undefined)) return null;
      body = { type, characterId, bucket: v.bucket as UrgeBucket, kind: v.kind as InitiativeKind | 'none', ...(none ? { why: v.why as InitiativeWhy } : {}),
        ...(v.why === 'floor' ? { floor: v.floor as InitiativeFloor } : {}) };
      break;
    }
    case 'moment':
      if (!characterId || !has(MOMENT_KINDS, v.kind) || !has(MOMENT_OUTCOMES, v.outcome) || (v.why !== undefined && !has(MOMENT_WHYS, v.why))
        || (v.screen !== undefined && !has(SCREEN_MOMENT_EVENTS, v.screen))) return null;
      body = { type, characterId, kind: v.kind, outcome: v.outcome, ...(v.why !== undefined ? { why: v.why as MomentWhy } : {}), ...(v.screen !== undefined ? { screen: v.screen as ScreenMomentEvent } : {}) };
      break;
    // ---- I-050 her folder
    case 'her-folder': {
      if (v.by !== 'her' && v.by !== 'user') return null;
      if (v.action === 'refused') {
        if (!has(HER_FOLDER_REFUSALS, v.why)) return null;
        body = { type, characterId, action: 'refused', by: v.by, why: v.why };
        break;
      }
      // I-056: she mentioned the folder once while it was never turned on; nothing but the fact.
      if (v.action === 'mentioned') { body = { type, characterId, action: 'mentioned', by: 'her' }; break; }
      const bytes = count(v.bytes, 100_000_000);
      if (!has(HER_FOLDER_ACTIONS, v.action) || typeof v.name !== 'string' || !HER_FILE_NAME.test(v.name) || v.name.startsWith('.') || bytes === undefined) return null;
      body = { type, characterId, action: v.action, by: v.by, name: v.name, bytes, userFile: v.userFile === true };
      break;
    }
  }
  return body;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** This part's entries in the control window, after the time (shared/memory/journal.ts describeJournalEntry); `reason` is the entry's reason, translated. */
export function describeInitiativeJournalEntry(entry: InitiativeJournalInput, reason: string, tr: JournalTranslate): string {
  let body: string;
  switch (entry.type) {
    case 'inner-loop': body = tr('{0}（{1}）', reason, tr(RESULT_LABEL[entry.result])); break;
    case 'rps': body = entry.event === 'result'
      ? tr('{0}：她赢 {1} · 你赢 {2} · 平 {3}', reason, entry.herWins ?? 0, entry.userWins ?? 0, entry.draws ?? 0)
      : entry.event === 'line-unread' && entry.unread ? tr('{0}（{1}）', reason, tr(RPS_UNREAD_WORDS[entry.unread])) : reason; break;
    case 'give': {
      const parts = [tr(GIVE_ITEM_WORDS[entry.item]) + (entry.fromFed ? tr('（你喂过她的那张）') : '')];
      if (entry.picture) parts.push(tr(PICTURE_WHY_WORDS[entry.picture]));
      parts.push(entry.why.length ? entry.why.map(w => tr(GIVE_WHY_WORDS[w])).join(tr('、')) : tr('她自己想递'));
      body = tr('{0}（{1}）', reason, parts.join(tr('，')));
      break;
    }
    case 'hands':
      body = tr('{0}（{1}）', reason, [tr(HANDS_USE_WORDS[entry.use]), entry.why.length ? entry.why.map(w => tr(HANDS_WHY_WORDS[w])).join(tr('、')) : tr('她自己想')].join(tr('，')));
      break;
    case 'self-look':
      body = tr('{0}（{1}）', reason, [tr(SELF_LOOK_WHY_WORDS[entry.why]), tr(SELF_LOOK_SENSE_WORDS[entry.sense]),
        ...(entry.hour !== undefined ? [tr('这一小时第 {0} 次', String(entry.hour))] : [])].join(tr('，')));
      break;
    case 'initiative':
      body = tr('{0}（{1}）', reason, [tr(URGE_BUCKET_WORDS[entry.bucket]), entry.why ? tr(INITIATIVE_WHY_WORDS[entry.why]) : null,
        entry.floor ? tr(INITIATIVE_FLOOR_WORDS[entry.floor]) : null].filter(Boolean).join(tr('，')));
      break;
    case 'moment':
      body = tr('{0}（{1}）', reason, [tr(MOMENT_OUTCOME_WORDS[entry.outcome]), entry.why ? tr(MOMENT_WHY_WORDS[entry.why]) : null, entry.screen ? tr(MOMENT_SCREEN_WORDS[entry.screen]) : null].filter(Boolean).join(tr('，')));
      break;
    // ---- I-050 her folder
    case 'her-folder':
      body = entry.action === 'refused' ? tr('{0}（{1}）', reason, tr(HER_FOLDER_REFUSAL_LABEL[entry.why ?? 'failed']))
        : entry.action === 'mentioned' ? reason
        : tr('{0}：{1}（{2} KB{3}）', reason, entry.name ?? '', ((entry.bytes ?? 0) / 1024).toFixed(1), entry.userFile ? tr('，原来的文件留了一份') : '');
      break;
    default: body = reason;
  }
  return body;
}
