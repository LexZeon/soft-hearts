import { uiText, uiTemplate } from './ui-language';
import type { MoodChannel, MoodParameters, MoodSnapshot } from "../../shared/mood";
import type { FatigueView } from '../../shared/fatigue-runtime';
import { fatiguePanelView, fatigueRestLine } from './fatigue-panel-view';
import { defaultInnerLoopSource, InnerLoopSection, type InnerLoopPanelSource } from './inner-loop-panel';
import { USER_STATE_LABELS, type UserStateView } from '../../shared/user-state';
import { STAGE_LABELS, type RelationshipStage, type RelationshipView } from '../../shared/relationship';
import { HER_LIFE_TABLE, type HerLifeView } from '../../shared/her-life';
import { formatHerNeedLine, type HerNeedView } from '../../shared/her-needs';
import { formatRhythmMultiplier, rhythmSourceLabels, type ReplyRhythmView } from '../../shared/reply-rhythm';
import type { ExpressionRecipe, ExpressionSupport } from '../../shared/expression-preview';
import { ExpressionPreviewButtons } from './ExpressionPreviewButtons';
import { moodExtendedValues, moodRangeDisplay, moodTypicalRange } from '../../shared/mood-typical-ranges';
import type { IdleGestureWhy } from '../../shared/behaviors/idle-gesture/interface';
import type { BoredomKind, BoredomTimingWhy } from '../../shared/behaviors/boredom-timing/interface';
import type { ReplyLingerWhy } from '../../shared/behaviors/reply-linger/interface';
import type { TouchFeedWhy } from '../../shared/behaviors/touch-feed-effect/interface';
import type { BlushWhy } from '../../shared/behaviors/blush/interface';
import type { FeedCueWhy } from '../../shared/behaviors/feed-cue/interface';
import type { ModuleRouterWhy, RouterAnswerStatus, RouterDecider, RouterSkip } from '../../shared/module-router/interface';
import { MOOD_JUDGE_WHYS, type MoodJudgeOutcome, type MoodJudgeView } from '../../shared/behaviors/mood-judge/interface';
import type { PauseTalkPlan, PauseTalkSkip, PauseTalkStatus, PauseTalkView } from '../../shared/behaviors/pause-talk/interface';
import type { InteractionBudgetView } from '../../shared/behaviors/interaction-budget/interface';
import { INTERACTION_BUDGET_KNOBS } from '../../shared/behaviors/interaction-budget/knobs';
import { MOOD_CHANNELS } from '../../shared/mood';

export interface MoodPanelView {
  snapshot: MoodSnapshot;
  fatigue?: FatigueView;
  /** Her current read of the user; the host sends it in developer mode only. */
  userState?: UserStateView;
  /** How long she has known the user (熟悉度); the host sends it in developer mode only. */
  relationship?: RelationshipView;
  /** 她自己的生活: what she is doing, since when, about when it changes. */
  herLife?: HerLifeView;
  /** 她也会需要你: the small feeling she has now, or the warmth after she was soothed. */
  herNeed?: HerNeedView;
  /** F7 说话节奏: the latest reply's pace and what set it; the host sends it in developer mode only. */
  replyRhythm?: ReplyRhythmView;
  /** #11 动一动、看你一眼: why the last few were picked; the host sends it in developer mode only (memory only). */
  idleGestureWhy?: readonly IdleGestureWhy[];
  /** #8 你不理她时多久看你、动一下、想开口: this round and the last few; the host sends it in developer mode only (memory only). */
  boredomTimingWhy?: readonly BoredomTimingWhy[];
  /** #5 回复说完气泡留多久: how long the last few stayed and why; the host sends it in developer mode only (memory only). */
  replyLingerWhy?: readonly ReplyLingerWhy[];
  /** #21 摸头、捏脸、喂点心让她心情好多少: the last few and why; the host sends it in developer mode only (memory only). */
  touchFeedWhy?: readonly TouchFeedWhy[];
  /** #26 脸红: the last few blushes, how they looked and why; the host sends it in developer mode only (memory only). */
  blushWhy?: readonly BlushWhy[];
  /** #32 喂点心时的语气词和吃法: the last few snacks, what she said and how she ate, and why; developer mode only (memory only). */
  feedCueWhy?: readonly FeedCueWhy[];
  /** I-023 haiku 调度台: the last few messages, what haiku judged, how long, who decided; developer mode only (memory only). */
  moduleRouterWhy?: readonly ModuleRouterWhy[];
  /** I-027 心情调整员: on or off, today's count and cap, the last few batches; developer mode only (memory only). */
  moodJudge?: MoodJudgeView;
  /** F7 停停说说: on or off, the last few plans and first characters; developer mode only (memory only, numbers only). */
  pauseTalk?: PauseTalkView;
  /** I-010 互动余额: the balance now, the card's multiplier, what added and drew lately; developer mode only (memory only, numbers only). */
  interactionBudget?: InteractionBudgetView;
  parameters: MoodParameters;
  characterId?: string;
  revision?: number;
  developerMode?: boolean;
  degradation?: string;
}
export interface MoodPanelOptions {
  onApply(parameters: unknown): void | Promise<void>;
  onRestore(): void | Promise<void>;
  onWake?(): void | Promise<void>;
  onClose?(): void | Promise<void>;
  onError?(message: string): void;
  /** E1: what this window's stage can show of 惊喜 / 害羞 (the 「预览」 buttons under the music line). */
  expressionSupport?(recipe: ExpressionRecipe): ExpressionSupport | null;
  /** "主动发言" group (inner loop switch + diagnostics). Omitted: the window's desktop bridge; null: none. */
  innerLoop?: InnerLoopPanelSource | null;
}
const channels: MoodChannel[] = ["D", "O", "E", "N", "C"];
const channelNames: Record<MoodChannel, string> = { D: "奖励与期待", O: "亲近与陪伴", E: "舒适与满足", N: "激活与警觉", C: "压力与负担" };
const labels: Record<string, string> = {
  calm: "平静", close: "亲近", content: "满足", happy: "愉快", excited: "兴奋", concerned: "担心", disappointed: "失落", upset: "不满", longing: "想念", sad: "伤感", relieved: "释然", "tense-expectation": "紧张期待",
  playful: "玩闹", comfortable: "舒适", cautious: "谨慎", wistful: "想念余韵",
  idle: "日常陪伴", rua: "摸头接触", cheek: '捏脸持握', "food-wait": "等待点心", "food-ready": "张嘴准备", "food-eating": "接受点心",
  satisfied: "满足回应", reunion: "重逢回应", look: "回看", motion: "轻微姿态", speech: "主动短话",
};
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
}
/** A slider's range: the typical range (the soft limit; a value outside it needs the confirmation). */
function typical(path: string): [number, number] { const range = moodTypicalRange(path)!; return [range.min, range.max]; }
function number(value: number): string { return Number.isFinite(value) ? value.toFixed(1) : "—"; }

/** Developer readout of her read of the user: "她觉得你现在：累（把握 0.8，约 70 分钟后消退）". No reason text. */
export function formatUserStateLine(view: UserStateView | undefined, now = Date.now()): string {
  if (!view) return uiText("她觉得你现在：暂无判断");
  const remaining = view.fadesAt - now;
  if (!(remaining > 0)) return uiText("她觉得你现在：暂无判断");
  const label = uiText(`用户状态：${USER_STATE_LABELS[view.state]}`).replace(/^用户状态：/u, '');
  return uiTemplate`她觉得你现在：${label}（把握 ${view.confidence}，约 ${Math.max(1, Math.round(remaining / 60_000))} 分钟后消退）`;
}

/**
 * Developer readout of 熟悉度: "关系：认识第 12 天 · 相处 9 天（有质量 2 天，折算 10）· 慢慢升温：开 · 阶段：熟起来，再过 1 天到熟悉".
 * Numbers only; never the nickname. Without "关系慢慢升温" there is no stage line at all.
 */
export function formatRelationshipLine(view: RelationshipView | undefined): string {
  if (!view) return uiText('关系：暂无数据');
  const base = uiTemplate`关系：认识第 ${view.dayNumber} 天 · 相处 ${view.togetherDays} 天（有质量 ${view.qualityDays} 天，折算 ${Math.round(view.effectiveDays * 10) / 10}）`;
  if (!view.slowWarmUp || !view.stage) return `${base} · ${uiText('慢慢升温：关（从第一天起就很熟）')}`;
  const stage = uiText(STAGE_LABELS[view.stage]);
  const next = view.nextStage && view.daysToNext ? uiTemplate`，再过 ${view.daysToNext} 天到${uiText(STAGE_LABELS[view.nextStage])}` : uiText('，已是最后一个阶段');
  const hand = view.overridden ? uiText('（手动设置，重启后恢复）') : '';
  return `${base} · ${uiText('慢慢升温：开')} · ${uiTemplate`阶段：${stage}`}${view.overridden ? hand : next}`;
}

/**
 * Developer readout of 她自己的生活: "她在做的事：发呆 · 已经 12 分钟 · 大约 9 分钟后换". While she keeps the user company
 * after a return (or is drowsy) the change waits for the user to be away (or for the fatigue model).
 */
export function formatHerLifeLine(view: HerLifeView | undefined, now = Date.now()): string {
  if (!view || !HER_LIFE_TABLE[view.activity]) return uiText('她在做的事：暂无');
  const label = uiText(`她在做：${HER_LIFE_TABLE[view.activity].label}`).replace(/^她在做：/u, '');
  const elapsed = Math.max(0, Math.round((now - view.since) / 60_000));
  const next = view.until >= Number.MAX_SAFE_INTEGER
    ? view.activity === 'drowsy' ? uiText('困意过去后再换') : uiText('等你离开一会儿再换')
    : view.until <= now ? uiText('你离开时就换') : uiTemplate`大约 ${Math.max(1, Math.round((view.until - now) / 60_000))} 分钟后换`;
  return uiTemplate`她在做的事：${label} · 已经 ${elapsed} 分钟 · ${next}`;
}

/** Developer readout of 说话节奏 (F7): "这条回复的节奏：×1.10（困了、舒适）· 文字语气强度 50". Names and numbers only. */
export function formatReplyRhythmLine(view: ReplyRhythmView | undefined): string {
  const cue = view?.cue;
  if (!cue) return uiText('这条回复的节奏：还没有回复');
  const sources = rhythmSourceLabels(cue).map(label => uiText(label)).join(uiText('、'));
  // 兜底，待定: while the fallback is off the bubbles keep R27's pacing; the line says what it would have been.
  return view!.applied
    ? uiTemplate`这条回复的节奏：${formatRhythmMultiplier(cue.multiplier)}（${sources}）· 文字语气强度 ${cue.textIntensity}`
    : uiTemplate`这条回复的节奏（兜底，未启用，气泡照旧）：${formatRhythmMultiplier(cue.multiplier)}（${sources}）· 文字语气强度 ${cue.textIntensity}`;
}

/** The window's own desktop bridge, when it offers the developer voice listening trial (F7). */
function replyRhythmTrialSetter(): ((on: boolean) => Promise<unknown>) | null {
  const desktop = (globalThis as { window?: { desktop?: { setReplyRhythmVoiceTrial?: (on: boolean) => Promise<unknown> } } }).window?.desktop;
  return desktop && typeof desktop.setReplyRhythmVoiceTrial === 'function' ? on => desktop.setReplyRhythmVoiceTrial!(on) : null;
}

/** The window's own desktop bridge, when it offers the developer stage switch. */
function relationshipStageSetter(): ((stage: RelationshipStage | null) => Promise<void>) | null {
  const desktop = (globalThis as { window?: { desktop?: { setRelationshipStage?: (stage: RelationshipStage | null) => Promise<void> } } }).window?.desktop;
  return desktop && typeof desktop.setRelationshipStage === 'function' ? stage => desktop.setRelationshipStage!(stage) : null;
}

/** List only newly chosen extended values; an already confirmed value is not re-confirmed. The ranges: shared/mood-typical-ranges.ts. */
/**
 * Developer readout of #11 ("为什么挑这个"): the last few looks and small motions, newest first, one line each:
 * "小动作：21:03:12 动一动 → 歪头 · 浅浅一笑｜闲着到了动一动的时候；心情：满足；…（分量：歪头 1.9 · …）".
 */
export function formatIdleGestureLines(entries: readonly IdleGestureWhy[] | undefined, count = 3): string {
  if (!entries?.length) return uiText('小动作：暂无');
  return entries.slice(0, count).map(entry => uiTemplate`小动作：${new Date(entry.at).toLocaleTimeString()} ${entry.kind === 'look' ? uiText('看你一眼') : uiText('动一动')} → ${entry.shape} · ${entry.face}｜${entry.why.join('；')}（分量：${entry.weights}）`).join('\n');
}

const BOREDOM_KIND_WORDS: Readonly<Record<BoredomKind, string>> = { look: '看你', motion: '动一下', speech: '想开口' };
/**
 * Developer readout of #8 ("这次门槛为什么落在这里"): this round first, then the last rounds where something happened, one line each:
 * "什么时候找你：这一轮（21:03:12 起）看你 第 17.4 分钟（到了：第 17.4 分钟） · 动一下 第 33 分钟 · 想开口 第 44.2 分钟｜早一点来找你——…｜宽限 … （分量：…）".
 */
export function formatBoredomTimingLines(entries: readonly BoredomTimingWhy[] | undefined, count = 3): string {
  if (!entries?.length) return uiText('什么时候找你：暂无');
  return entries.slice(0, count).map(entry => {
    const moments = (['look', 'motion', 'speech'] as const).map(kind => {
      const plan = entry.plan[kind], done = entry.happened[kind];
      return `${uiText(BOREDOM_KIND_WORDS[kind])} ${plan === null ? uiText('不会') : uiTemplate`第 ${plan} 分钟`}${done === undefined ? '' : uiTemplate`（到了：第 ${done} 分钟）`}`;
    }).join(' · ');
    return uiTemplate`什么时候找你：${entry.current ? uiText('这一轮') : uiText('前一轮')}（${new Date(entry.startedAt).toLocaleTimeString()} 起）${moments}｜${entry.why.join('；')}｜${entry.rules}（分量：${entry.weights}）`;
  }).join('\n');
}

/**
 * Developer readout of #5 ("这次留多久、为什么"): the last few completed replies, newest first, one line each:
 * "气泡：21:03:12 留 8.1 秒｜最后一句在问你（多留一会儿）；32 个字（读完约 6.3 秒）；心情：愉快（收得早一点）".
 */
export function formatReplyLingerLines(entries: readonly ReplyLingerWhy[] | undefined, count = 3): string {
  if (!entries?.length) return uiText('气泡：暂无');
  return entries.slice(0, count).map(entry => uiTemplate`气泡：${new Date(entry.at).toLocaleTimeString()} 留 ${(Math.round(entry.ms / 100) / 10).toFixed(1)} 秒｜${entry.why.join('；')}`).join('\n');
}

const TOUCH_FEED_CONTACT_WORDS: Readonly<Record<TouchFeedWhy['contact'], string>> = { pat: '摸头', pinch: '捏脸', food: '喂点心' };
/**
 * Developer readout of #21 ("这次效果为什么是这么多"): the last few pats, pinches and snacks, newest first, one line each:
 * "摸头喂食：21:03:12 摸头 → 正好挠到心上 × 0.96｜…；腻得慢（性格：黏人）｜新鲜感 100% → 64%（这次 3 剂）（分量：…）".
 */
export function formatTouchFeedLines(entries: readonly TouchFeedWhy[] | undefined, count = 3): string {
  if (!entries?.length) return uiText('摸头喂食：暂无');
  return entries.slice(0, count).map(entry => {
    const fresh = entry.fresh.first === entry.fresh.last ? `${entry.fresh.first}%` : `${entry.fresh.first}% → ${entry.fresh.last}%`;
    return uiTemplate`摸头喂食：${new Date(entry.at).toLocaleTimeString()} ${uiText(TOUCH_FEED_CONTACT_WORDS[entry.contact])} → ${entry.landing} × ${entry.scale}｜${entry.why.join('；')}｜新鲜感 ${fresh}（这次 ${entry.doses} 剂）（分量：${entry.weights}）`;
  }).join('\n');
}

const BLUSH_CONTACT_WORDS: Readonly<Record<BlushWhy['contact'], string>> = { pat: '被摸头', pinch: '被捏脸', words: '你说了暖心的话' };
/**
 * Developer readout of #26 ("脸红为什么这样"): the last few blushes, newest first, one line each:
 * "脸红：21:03:12 被摸头 → 一下子红透了｜…｜深浅 ×1.08 · 红起来 0.5 秒 · …｜下次至少隔 72 秒（分量：…）".
 */
export function formatBlushLines(entries: readonly BlushWhy[] | undefined, count = 3): string {
  if (!entries?.length) return uiText('脸红：暂无');
  return entries.slice(0, count).map(entry => uiTemplate`脸红：${new Date(entry.at).toLocaleTimeString()} ${uiText(BLUSH_CONTACT_WORDS[entry.contact])} → ${entry.look}｜${entry.why.join('；')}｜${entry.shape}｜下次至少隔 ${Math.round(entry.cooldownMs / 1000)} 秒（分量：${entry.weights}）`).join('\n');
}

/**
 * Developer readout of #32 ("这一份点心她为什么这样出声、这样吃"): the last few snacks, newest first, one line each:
 * "喂食声音：21:03:12 张嘴前 哇～（心情：愉快；上次是啊～，这次不重复）→ 吃到 嗯嗯！（这一块吃得很香）｜吃法：慢慢吃（…）张嘴 ×0.58 · …（分量：…）".
 */
export function formatFeedCueLines(entries: readonly FeedCueWhy[] | undefined, count = 3): string {
  if (!entries?.length) return uiText('喂食声音：暂无');
  return entries.slice(0, count).map(entry => {
    const eat = entry.eat ? uiTemplate` → 吃到 ${entry.eat.sound}（${entry.eat.why.join('；')}）` : uiText(' → 还没咬下去');
    const weights = [entry.open.weights ? uiTemplate`张嘴前 ${entry.open.weights}` : '', entry.eat?.weights ? uiTemplate`吃到 ${entry.eat.weights}` : ''].filter(Boolean).join('｜');
    const numbers = entry.manner.numbers === '和原来一样' ? uiText('和原来一样') : entry.manner.numbers;
    return uiTemplate`喂食声音：${new Date(entry.at).toLocaleTimeString()} 张嘴前 ${entry.open.sound}（${entry.open.why.join('；')}）${eat}｜吃法：${uiText(entry.manner.label)}（${entry.manner.why.join('；')}）${numbers}（分量：${weights}）`;
  }).join('\n');
}

const ROUTER_SKIP_WORDS: Readonly<Record<RouterSkip, string>> = {
  prefilter: '粗筛没命中', local: '本机认出来了', unavailable: 'Claude 暂时不能用', empty: '空消息', long: '消息太长', quota: '今天问得太多了',
};
const ROUTER_STATUS_WORDS: Readonly<Record<Exclude<RouterAnswerStatus, 'answered'> | 'pending', string>> = {
  pending: '还在等', timeout: '超时', error: '出错', 'bad-json': '答的不是要求的 JSON', superseded: '被新消息作废',
};
const ROUTER_BY_WORDS: Readonly<Record<RouterDecider, string>> = { local: '本机说了算', haiku: 'haiku 说了算', refusal: '本机认出是拒绝，拒绝优先', nobody: 'haiku 说没在叫' };
const seconds = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1);

/**
 * Developer readout of I-023 (haiku 调度台): the last few messages, newest first, one line each:
 * "调度台：21:03:12 问了 haiku（猜拳）→ 叫到 猜拳（把握 0.92）· 1.8 秒｜猜拳：haiku 说了算 → 答应，回复说完开局".
 * Module names, verdicts and times only; never the message.
 */
export function formatModuleRouterLines(entries: readonly ModuleRouterWhy[] | undefined, count = 3): string {
  if (!entries?.length) return uiText('调度台：暂无');
  return entries.slice(0, count).map(entry => {
    const time = new Date(entry.at).toLocaleTimeString();
    const local = entry.local.map(item => `${item.module} ${item.kind === 'called' ? uiText('叫了') : uiText('拒绝')}`).join(uiText('、'));
    let asked: string;
    if (!entry.answer) asked = uiTemplate`没问 haiku（${uiText(ROUTER_SKIP_WORDS[entry.skipped ?? 'prefilter'])}${local ? `：${local}` : ''}）`;
    else {
      const status = entry.answer.status, took = entry.answer.ms === null ? '' : uiTemplate` · ${seconds(entry.answer.ms)} 秒`;
      const result = status === 'answered'
        ? entry.answer.called.length ? entry.answer.called.map(call => uiTemplate`叫到 ${call.module}（把握 ${call.confidence.toFixed(2)}）`).join(uiText('、')) : uiText('谁都没叫')
        : uiText(ROUTER_STATUS_WORDS[status]);
      asked = uiTemplate`问了 haiku（${entry.asked.join(uiText('、'))}）→ ${result}${took}${local ? uiTemplate`；本机：${local}` : ''}`;
    }
    const decisions = entry.decisions.map(item => uiTemplate`｜${item.module}：${uiText(ROUTER_BY_WORDS[item.by])} → ${uiText(item.action)}`).join('');
    return uiTemplate`调度台：${time} ${asked}${decisions}`;
  }).join('\n');
}

const MOOD_JUDGE_OUTCOME_WORDS: Readonly<Record<MoodJudgeOutcome, string>> = {
  applied: '动了', nothing: '没动（本机调得合理）', 'low-confidence': '把握不够，没用', invalid: '答得不对，没用', timeout: '超时，没用', error: '出错，没用',
  stale: '太旧，丢掉', character: '换了角色，丢掉', asleep: '她睡着了，没问', 'test-mood': '测试心情中，没问', hidden: '桌宠不在屏幕上，没问',
  unavailable: 'Claude 用不了，没问', 'expressions-off': '自动表现关着，没问', quota: '今天的次数用完了，没问', off: '关掉了，丢掉',
};
/** The channel's letter with its Chinese name (the developer panel's own words; not translated, like the table's D/O/E/N/C). */
const JUDGE_CHANNEL_WORDS: Readonly<Record<MoodChannel, string>> = { D: 'D 期待', O: 'O 亲近', E: 'E 舒适', N: 'N 激活', C: 'C 压力' };

/**
 * Developer readout of I-027 (心情调整员): today's count against the cap (and when it is used up), then the last few batches,
 * newest first: "心情调整员：21:03:12 看了 3 件事 → 动了 O 亲近 +2.0、C 压力 -1.0（刚才反应不够，补一点） · 3.1 秒".
 * Counts, outcomes, numbers and the closed reasons only; never a word anyone said.
 */
export function formatMoodJudgeLines(view: MoodJudgeView | undefined, count = 3): string {
  if (!view) return uiText('心情调整员：暂无');
  const head = !view.enabled ? uiText('心情调整员：关着（在「隐私与设置」里打开）')
    : view.capReached ? uiText('心情调整员：今天 {0} / {1} 次，今天的次数用完了，只用本机规则', view.today, view.cap)
    : uiText('心情调整员：今天 {0} / {1} 次', view.today, view.cap);
  const lines = view.recent.slice(0, count).map(entry => {
    const moved = entry.delta ? MOOD_CHANNELS.filter(c => typeof entry.delta?.[c] === 'number')
      .map(c => `${JUDGE_CHANNEL_WORDS[c]} ${entry.delta![c]! > 0 ? '+' : ''}${entry.delta![c]!.toFixed(1)}`).join(uiText('、')) : '';
    const why = entry.why ? uiText('（{0}）', uiText(MOOD_JUDGE_WHYS[entry.why])) : '';
    const took = typeof entry.ms === 'number' ? uiText(' · {0} 秒', seconds(entry.ms)) : '';
    const opus = entry.afterOpus ? uiText('，Opus 已判断，每个数最多 ±3') : '';
    return uiText('心情调整员：{0} 看了 {1} 件事 → {2}{3}{4}{5}{6}', new Date(entry.at).toLocaleTimeString(), entry.events,
      uiText(MOOD_JUDGE_OUTCOME_WORDS[entry.outcome]), moved ? ` ${moved}` : '', why, opus, took);
  });
  return [head, ...lines].join('\n');
}

const PAUSE_TALK_STATUS_WORDS: Readonly<Record<PauseTalkStatus, string>> = {
  pending: '等 haiku…', answered: 'haiku 定了', 'bad-json': 'haiku 答得不对，照原来的节奏', timeout: '超时，照原来的节奏', error: '出错，照原来的节奏',
  superseded: '来了新消息，作废', cancelled: '回复取消了，丢掉', character: '换了角色，丢掉',
};
const PAUSE_TALK_SKIP_WORDS: Readonly<Record<PauseTalkSkip, string>> = { unavailable: 'Claude 用不了，没问', quota: '今天的次数用完了，没问', 'no-character': '没有角色，没问',
  budget: '互动余额这次没给余地，没问（照原来的节奏）' };
const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** "第 2 句后停 0.8 秒、问完等你 8 秒"; "一口气说完" for an empty plan. */
export function formatPauseTalkPlan(plan: PauseTalkPlan | null): string {
  if (!plan) return '';
  const parts = plan.pauses.map(pause => uiText('第 {0} 句后停 {1} 秒', pause.after, seconds(pause.ms)));
  if (plan.wait) parts.push(plan.wait.after === 'question' ? uiText('问完等你 {0} 秒', Math.round(plan.wait.ms / 1000))
    : uiText('第 {0} 句后等你 {1} 秒', plan.wait.after, Math.round(plan.wait.ms / 1000)));
  return parts.length ? parts.join(uiText('、')) : uiText('一口气说完');
}

/**
 * Developer readout of F7 停停说说: on or off; the first visible character of the last replies (median with the switch on and
 * off, so the user's ordinary use answers "did it get slower?"); then the last few replies' plans, newest first:
 * "停停说说：21:03:12 haiku 定了：第 2 句后停 0.8 秒、问完等你 8 秒 · 2.7 秒". Numbers and fixed words only; never a word anyone said.
 */
export function formatPauseTalkLines(view: PauseTalkView | undefined, count = 3): string {
  if (!view) return uiText('停停说说：暂无');
  const head = view.enabled ? uiText('停停说说：开') : uiText('停停说说：关着（在「连接与声音 → 声音」里打开）');
  const on = view.firstChar.filter(item => item.on).map(item => item.ms), off = view.firstChar.filter(item => !item.on).map(item => item.ms);
  const side = (values: number[]) => { const m = median(values); return m === null ? uiText('还没有') : uiText('中位 {0} 秒（{1} 条）', seconds(m), values.length); };
  const first = view.firstChar.length
    ? uiText('首字（画到气泡上）：开 {0} · 关 {1}；最近 {2}', side(on), side(off),
      view.firstChar.slice(0, 5).map(item => `${seconds(item.ms)}${item.on ? uiText('（开）') : ''}`).join(uiText('、')))
    : uiText('首字（画到气泡上）：还没有');
  const lines = view.why.slice(0, count).map(entry => {
    const what = entry.status === null ? uiText(PAUSE_TALK_SKIP_WORDS[entry.skipped ?? 'unavailable'])
      : entry.status === 'answered' ? uiText('{0}：{1}', uiText(PAUSE_TALK_STATUS_WORDS.answered), formatPauseTalkPlan(entry.plan))
      : uiText(PAUSE_TALK_STATUS_WORDS[entry.status]);
    const took = typeof entry.ms === 'number' ? uiText(' · {0} 秒', seconds(entry.ms)) : '';
    const carried = entry.carried > 0 ? uiText('；带了上一条没说完的 {0} 个字', entry.carried) : '';
    const dropped = entry.waitDropped ? uiText('（互动余额不够她等你后接着说，这条没停下来等）') : '';
    return uiText('停停说说：{0} {1}{2}{3}', new Date(entry.at).toLocaleTimeString(), what, took, carried) + dropped;
  });
  return [head, first, ...lines].join('\n');
}

const budgetNumber = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
/**
 * Developer readout of I-010 (互动余额): the balance now (earned + floor), the card's cost multiplier and the night, then the last
 * few things that added to it or drew from it, newest first:
 * "互动余额：3.2（攒下 2.2 + 保底 1.0）· 性格 × 0.85 · 最近一小时互动 4 次\n最近：21:03:12 你发消息 +1.0 · 21:40:05 她邀请玩猜拳 −1.0（退回）".
 * Kinds and numbers only; never a word anyone said.
 */
export function formatBudgetLines(view: InteractionBudgetView | undefined, count = 6): string {
  if (!view) return uiText('互动余额：暂无');
  const head = uiText('互动余额：{0}（攒下 {1} + 保底 {2}）· 性格 × {3}{4} · 最近一小时互动 {5} 次', budgetNumber(view.balance), budgetNumber(view.earned),
    budgetNumber(view.floor), budgetNumber(view.scale), view.night ? uiText(' · 深夜花费加倍') : '', view.lastHour);
  if (!view.recent.length) return [head, uiText('最近：还没有加减')].join('\n');
  const items = view.recent.slice(0, count).map(entry => {
    const label = INTERACTION_BUDGET_KNOBS.labels[entry.kind] ?? entry.kind;
    const delta = entry.delta >= 0 ? `+${budgetNumber(entry.delta)}` : `−${budgetNumber(-entry.delta)}`;
    return `${new Date(entry.at).toLocaleTimeString()} ${uiText(label)} ${delta}${entry.refunded ? uiText('（退回）') : ''}`;
  });
  return [head, uiText('最近：{0}', items.join(' · '))].join('\n');
}

export function moodExtendedDifferences(candidate: unknown, current: MoodParameters): string[] {
  return moodExtendedValues(candidate, current).map(({ range, before, after }) => {
    const label = uiText(range.label, range.labelValue === undefined ? '' : range.translateValue ? uiText(range.labelValue) : range.labelValue);
    const unit = range.unit && range.unit !== '%' ? uiText(range.unit) : range.unit;
    const display = (n: number) => moodRangeDisplay(range, n, unit);
    return uiTemplate`${label}：${display(before)} → ${display(after)}（常规 ${display(range.min)}～${display(range.max)}）`;
  });
}

/** Text-only observer and parameter editor. It has no authority to change a running value. */
export class MoodPanel {
  private view: MoodPanelView | null = null;
  private identity = "";
  private revision = -1;
  private dirty = false;
  private jsonDirty = false;
  private busy = false;
  private disposed = false;
  private readonly panel = node("section", "mood-panel");
  private readonly title = node("strong", "", uiText("心情状态 · 试验版"));
  private readonly summary = node("p", "mood-summary");
  private readonly phase = node("p", "mood-phase");
  private readonly reason = node("p", "mood-reason");
  private readonly waiting = node("p", "mood-waiting");
  private readonly expression = node("p", "mood-expression");
  private readonly adenosine = node('span');
  private readonly adenosineMeter = node('meter');
  private readonly fatigueSummary = node('p', 'mood-fatigue');
  /** I-022 developer line: the last time off screen counted as rest (hidden when there is none). */
  private readonly fatigueRestLine = node('p', 'mood-fatigue-rest');
  private readonly userStateLine = node('p', 'mood-user-state');
  private readonly relationshipLine = node('p', 'mood-relationship');
  private readonly herLifeLine = node('p', 'mood-her-life');
  private readonly idleGestureLine = node('p', 'mood-idle-gesture');
  private readonly boredomTimingLine = node('p', 'mood-boredom-timing');
  private readonly herNeedLine = node('p', 'mood-her-need');
  private readonly musicDesireLine = node('p', 'mood-music-desire');
  private readonly replyRhythmLine = node('p', 'mood-reply-rhythm');
  private readonly replyLingerLine = node('p', 'mood-reply-linger');
  private readonly touchFeedLine = node('p', 'mood-touch-feed');
  private readonly blushLine = node('p', 'mood-blush');
  private readonly feedCueLine = node('p', 'mood-feed-cue');
  private readonly moduleRouterLine = node('p', 'mood-module-router');
  private readonly moodJudgeLine = node('p', 'mood-judge-line');
  private readonly pauseTalkLine = node('p', 'mood-pause-talk');
  private readonly budgetLine = node('p', 'mood-budget');
  private rhythmTrial?: HTMLInputElement;
  private stageButton?: HTMLButtonElement;
  private wakeButton?: HTMLButtonElement;
  private innerLoop?: InnerLoopSection;
  private readonly notice = node("output", "mood-notice");
  private readonly rows = new Map<MoodChannel, { value: HTMLElement; baseline: HTMLElement; trend: HTMLElement; meter: HTMLMeterElement }>();
  private readonly sliders = new Map<string, { input: HTMLInputElement; value: HTMLOutputElement; min: number; max: number }>();
  private readonly editor = node("textarea", "mood-json");
  private readonly blushEnabled = node("input");
  private readonly buttons: HTMLButtonElement[] = [];
  constructor(private readonly container: HTMLElement, private readonly options: MoodPanelOptions) {
    this.panel.setAttribute("aria-label", uiText("心情开发者面板"));
    this.panel.dataset.moodUi = "true";
    const heading = node("div", "mood-heading"); heading.append(this.title);
    if (options.onClose) heading.append(this.button(uiText("关闭"), () => options.onClose!()));
    this.panel.append(heading, node("p", "mood-description", uiText("数值为角色模拟量。旧五通道参数保存在角色卡；腺苷与疲倦状态单独保存在本机，不随卡导出，不清空状态或记忆。")), this.summary, this.phase);
    const table = node("table", "mood-channels");
    const thead = node("thead"); const header = node("tr");
    for (const text of [uiText("通道"), uiText("当前 / 基线"), uiText("近期变化")]) header.append(node("th", "", text));
    thead.append(header); table.append(thead);
    const body = node("tbody");
    for (const channel of channels) {
      const row = node("tr");
      const name = node("th", "", channel); name.title = uiText(channelNames[channel]); name.scope = "row";
      const valueCell = node("td"); const value = node("span"); const baseline = node("span", "mood-baseline");
      const meter = node("meter"); meter.min = 0; meter.max = 100; meter.setAttribute("aria-label", uiTemplate`${uiText(channelNames[channel])}当前值`);
      valueCell.append(value, baseline, meter);
      const trend = node("td"); row.append(name, valueCell, trend); body.append(row);
      this.rows.set(channel, { value, baseline, trend, meter });
    }
    const pressure = node('tr'), pressureName = node('th', '', uiText('A 腺苷')); pressureName.scope = 'row';
    pressureName.title = uiText('角色的长期睡眠压力模拟量，与旧五通道分开保存');
    const pressureValue = node('td'); this.adenosine.textContent = uiText('尚未接入'); this.adenosineMeter.hidden = true;
    this.adenosineMeter.min = 0; this.adenosineMeter.max = 100;
    this.adenosineMeter.setAttribute('aria-label', uiText('腺苷睡眠压力')); pressureValue.append(this.adenosine, this.adenosineMeter);
    pressure.append(pressureName, pressureValue, node('td', '', uiText('长期睡眠压力'))); body.append(pressure);
    this.fatigueSummary.textContent = uiText('疲倦状态尚未接入。');
    this.fatigueRestLine.hidden = true;
    table.append(body); this.panel.append(table, this.fatigueSummary, this.fatigueRestLine, this.waiting, this.reason, this.userStateLine, this.relationshipLine, this.herLifeLine, this.boredomTimingLine, this.idleGestureLine, this.touchFeedLine, this.feedCueLine, this.blushLine, this.herNeedLine, this.replyRhythmLine, this.replyLingerLine, this.moduleRouterLine, this.moodJudgeLine, this.pauseTalkLine, this.budgetLine, this.musicDesireLine, this.expression);
    this.musicDesireLine.hidden = true;
    this.budgetLine.hidden = true;
    const setTrial = replyRhythmTrialSetter();
    if (setTrial) {
      // Developer mode only (the host refuses otherwise), this run only: listen to a slow reply with a little silence between its sentences.
      const label = node('label', 'mood-reply-rhythm-trial'), box = node('input'); box.type = 'checkbox';
      box.setAttribute('aria-label', uiText('试听：节奏慢时朗读句间多停一点（只在本次运行，默认关）'));
      box.onchange = () => { void Promise.resolve(setTrial(box.checked)).catch(error => { box.checked = !box.checked; this.error(error); }); };
      label.append(box, node('span', '', uiText('试听：节奏慢时朗读句间多停一点（只在本次运行，默认关）')));
      this.rhythmTrial = box; this.panel.append(label);
    }
    // E1: 「预览：惊喜 / 害羞」 on the pet (any model; missing parts skipped).
    if (typeof (globalThis as { window?: { desktop?: { playExpressionPreview?: unknown } } }).window?.desktop?.playExpressionPreview === 'function')
      this.panel.append(new ExpressionPreviewButtons({ support: recipe => options.expressionSupport?.(recipe) ?? null }, { className: 'mood-expression-preview' }).root);
    const setStage = relationshipStageSetter();
    if (setStage) {
      // Developer mode only (the host refuses otherwise): try "熟悉" without waiting for the days; undone by pressing again or on restart.
      this.stageButton = this.button(uiText('试用：临时设为“熟悉”'), () => setStage(this.view?.relationship?.overridden ? null : 'familiar'));
      this.stageButton.hidden = true; this.panel.append(this.stageButton);
    }
    if (options.onWake) { this.wakeButton = this.button(uiText('叫醒'), () => options.onWake!()); this.wakeButton.disabled = true; this.panel.append(this.wakeButton); }
    const innerLoop = options.innerLoop === undefined ? defaultInnerLoopSource() : options.innerLoop;
    if (innerLoop) this.innerLoop = new InnerLoopSection(this.panel, innerLoop);
    const parameters = node("details", "mood-parameters"); parameters.append(node("summary", "", uiText("试验参数")));
    parameters.append(node("p", "mood-description", uiText("基础控件使用常规范围；完整参数可在高级编辑器中查看。恢复 Gene 参数保留状态和记录。")));
    const sensitivity = node("fieldset"); sensitivity.append(node("legend", "", uiText("事件敏感度")));
    for (const channel of channels) this.slider(sensitivity, `sensitivity.${channel}`, `${channel} ${uiText(channelNames[channel])}`, ...typical(`sensitivity.${channel}`), 0.05);
    const weights = node("fieldset"); weights.append(node("legend", "", uiText("反应倾向")));
    for (const [key, label] of Object.entries({ playful: uiText("玩闹"), close: uiText("亲近"), comfortable: uiText("舒适"), cautious: uiText("谨慎") })) this.slider(weights, `weights.${key}`, label, ...typical(`weights.${key}`), 0.05);
    const intensities = node("fieldset"); intensities.append(node("legend", "", uiText("表现强度")));
    for (const [key, label] of Object.entries({ expression: uiText("表情"), gaze: uiText("眼神"), posture: uiText("亲近姿态"), playful: uiText("玩闹幅度"), text: uiText("文字语气") })) this.slider(intensities, `intensity.${key}`, label, ...typical(`intensity.${key}`), 1);
    const blush = node("fieldset"); blush.append(node("legend", "", uiText("脸红 · 试验参数")));
    const toggle = node("label"); this.blushEnabled.type = "checkbox"; this.blushEnabled.setAttribute("aria-label", uiText("启用自动脸红"));
    this.blushEnabled.onchange = () => {
      if (!this.view || this.jsonDirty) { this.setNotice(uiText("高级 JSON 有未应用的编辑；请先应用或放弃编辑。")); this.blushEnabled.checked = this.view?.parameters.blush.enabled ?? true; return; }
      const parameters = this.editedParameters(); parameters.blush.enabled = this.blushEnabled.checked;
      this.editor.value = JSON.stringify(parameters, null, 2); this.dirty = true; this.setNotice(uiText("脸红设置已编辑，应用后生效。"));
    };
    toggle.append(this.blushEnabled, node("span", "", uiText("启用自动脸红"))); blush.append(toggle);
    this.slider(blush, "blush.intensity", uiText("脸红强度（0 为关闭）"), 0, 100, 1);
    this.slider(blush, "blush.size", uiText("脸红大小（50 为标准，0 为隐藏）"), 0, 100, 1);
    blush.append(node("p", "hint", uiText("需要模型有可用脸红通道。由新的亲近或支持事件触发，自然显现后淡出；时长和冷却可在 JSON 中调整。")));
    parameters.append(sensitivity, weights, intensities, blush);
    const advanced = node("details", "mood-advanced"); advanced.append(node("summary", "", uiText("高级参数 JSON")));
    this.editor.rows = 12; this.editor.spellcheck = false; this.editor.maxLength = 24000; this.editor.setAttribute("aria-label", uiText("心情完整试验参数 JSON"));
    this.editor.addEventListener("input", () => { this.dirty = true; this.jsonDirty = true; this.setNotice(uiText("完整参数已编辑，应用后生效。")); });
    advanced.append(this.editor); parameters.append(advanced);
    const actions = node("div", "mood-actions");
    actions.append(this.button(uiText("应用参数"), () => this.apply()), this.button(uiText("放弃编辑"), () => { this.dirty = false; this.jsonDirty = false; this.fillParameters(); this.setNotice(uiText("已恢复当前生效参数。")); }), this.button(uiText("恢复 Gene 参数"), () => this.restore()));
    parameters.append(actions); this.panel.append(parameters, this.notice);
    container.append(this.panel); this.setVisible(false);
  }
  setVisible(visible: boolean): void { this.panel.hidden = !visible; }
  /** M1 developer line: her want to dance, the tier it gives and why. Empty hides it (not in developer mode, or no music settings yet). */
  setMusicDesire(line: string): void {
    if (this.musicDesireLine.textContent !== line) this.musicDesireLine.textContent = line;
    this.musicDesireLine.hidden = !line;
  }
  get visible(): boolean { return !this.panel.hidden; }
  /** Caller must invoke on disconnect or before a new character context becomes authoritative. */
  clearFatigue(): void {
    if (this.disposed) return;
    if (this.view) this.view = { ...this.view, fatigue: undefined };
    this.adenosine.textContent = uiText('尚未接入'); this.adenosineMeter.hidden = true;
    this.fatigueSummary.textContent = uiText('疲倦状态尚未接入。');
    this.fatigueRestLine.textContent = ''; this.fatigueRestLine.hidden = true;
    if (this.wakeButton) this.wakeButton.disabled = true;
  }
  update(view: MoodPanelView): void {
    if (this.disposed) return;
    const identity = view.characterId ?? "";
    if (identity === this.identity && (view.revision ?? this.revision) < this.revision) return;
    const identityChanged = identity !== this.identity;
    this.identity = identity; this.revision = view.revision ?? this.revision;
    this.view = structuredClone(view);
    if (identityChanged) { this.dirty = false; this.jsonDirty = false; }
    const state = view.snapshot;
    this.summary.textContent = `${labels[state.primary] ? uiText(labels[state.primary]) : state.primary}${state.companion ? ` · ${labels[state.companion] ? uiText(labels[state.companion]) : state.companion}` : ""}`;
    this.phase.textContent = uiTemplate`互动：${labels[state.phase] ? uiText(labels[state.phase]) : state.phase}${state.cue ? ` · ${labels[state.cue.kind] ? uiText(labels[state.cue.kind]) : state.cue.kind}` : ""}`;
    for (const channel of channels) {
      const row = this.rows.get(channel)!;
      row.value.textContent = number(state.values[channel]);
      row.baseline.textContent = ` / ${number(view.parameters.baseline[channel])}`;
      row.meter.value = state.values[channel];
      const change = state.trend[channel];
      row.trend.textContent = `${change > 0 ? "+" : ""}${number(change)}${state.fast[channel] === "up" ? uiText(" ↑ 快变") : state.fast[channel] === "down" ? uiText(" ↓ 快变") : ""}`;
    }
    const fatigue = fatiguePanelView(view.fatigue);
    this.adenosine.textContent = fatigue.connected ? fatigue.A === null ? uiText('未知') : number(fatigue.A) : uiText('尚未接入');
    this.adenosineMeter.hidden = fatigue.A === null;
    if (fatigue.A !== null) this.adenosineMeter.value = fatigue.A;
    const display = (value: number | null) => value === null ? uiText('未知') : number(value);
    this.fatigueSummary.textContent = fatigue.connected
      ? uiTemplate`疲倦 F ${display(fatigue.F)} · 短时清醒 W ${display(fatigue.W)} · ${fatigue.phase ?? uiText('状态未知')}；活动来源${fatigue.entryReady === true ? uiText('已接入') : fatigue.entryReady === false ? uiText('尚未全部接入') : uiText('状态未知')}${fatigue.storageError ? `；${fatigue.storageError}` : ''}`
      : uiText('疲倦状态尚未接入。');
    const rest = fatigue.connected ? fatigueRestLine(view.fatigue?.rest) : '';
    this.fatigueRestLine.textContent = rest; this.fatigueRestLine.hidden = !rest;
    if (this.wakeButton) this.wakeButton.disabled = this.busy || !fatigue.connected || !fatigue.phase || view.fatigue?.phase === 'awake';
    this.waiting.textContent = uiTemplate`无聊 B ${number(state.boredom)} · 想念 M ${number(state.longing)}\n上次有效互动：${state.lastInteractionAt === null ? uiText("尚无") : new Date(state.lastInteractionAt).toLocaleString()}`;
    this.reason.textContent = uiTemplate`最近原因：${state.reason || uiText("尚无新事件")}；${state.event ? uiText("近期变化来自实际事件") : uiText("近期无事件冲击，自然恢复不算新的负面回应")}`;
    this.userStateLine.textContent = formatUserStateLine(view.userState);
    this.relationshipLine.textContent = formatRelationshipLine(view.relationship);
    this.herLifeLine.textContent = formatHerLifeLine(view.herLife);
    this.boredomTimingLine.textContent = formatBoredomTimingLines(view.boredomTimingWhy); // one line each (src/mood.css: pre-wrap)
    this.idleGestureLine.textContent = formatIdleGestureLines(view.idleGestureWhy); // one line each (src/mood.css: pre-wrap)
    this.herNeedLine.textContent = formatHerNeedLine(view.herNeed);
    this.replyRhythmLine.textContent = formatReplyRhythmLine(view.replyRhythm);
    this.replyLingerLine.textContent = formatReplyLingerLines(view.replyLingerWhy); // one line each (src/mood.css: pre-wrap)
    this.touchFeedLine.textContent = formatTouchFeedLines(view.touchFeedWhy); // one line each (src/mood.css: pre-wrap)
    this.blushLine.textContent = formatBlushLines(view.blushWhy); // one line each (src/mood.css: pre-wrap)
    this.feedCueLine.textContent = formatFeedCueLines(view.feedCueWhy); // one line each (src/mood.css: pre-wrap)
    this.moduleRouterLine.textContent = formatModuleRouterLines(view.moduleRouterWhy); // one line each (src/mood.css: pre-wrap)
    this.moduleRouterLine.hidden = !view.developerMode;
    this.moodJudgeLine.textContent = formatMoodJudgeLines(view.moodJudge); // one line each (src/mood.css: pre-wrap)
    this.moodJudgeLine.hidden = !view.developerMode;
    this.pauseTalkLine.textContent = formatPauseTalkLines(view.pauseTalk); // one line each (src/mood.css: pre-wrap)
    this.pauseTalkLine.hidden = !view.developerMode;
    this.budgetLine.textContent = formatBudgetLines(view.interactionBudget); // one line each (src/mood.css: pre-wrap)
    this.budgetLine.hidden = !view.developerMode;
    if (this.rhythmTrial) this.rhythmTrial.checked = view.replyRhythm?.voiceTrial === true;
    if (this.stageButton) {
      this.stageButton.hidden = !view.relationship?.slowWarmUp;
      this.stageButton.textContent = view.relationship?.overridden ? uiText('恢复真实阶段') : uiText('试用：临时设为“熟悉”');
    }
    this.expression.textContent = uiTemplate`表现：${state.blush ? uiTemplate`脸红 ${Math.round(state.blush.amount * 100)}% · ` : ""}${view.degradation || (state.cryingCandidate ? uiText("含泪候选；实际能力以模型适配为准") : state.cue ? labels[state.cue.kind] ? uiText(labels[state.cue.kind]) : state.cue.kind : uiText("局部表情与自然姿态"))}`;
    if (!this.dirty) this.fillParameters();
  }
  private slider(parent: HTMLElement, path: string, labelText: string, min: number, max: number, step: number): void {
    const label = node("label", "mood-slider"); const text = node("span", "", labelText); const input = node("input"); const value = node("output");
    input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step); input.setAttribute("aria-label", labelText);
    input.addEventListener("input", () => {
      if (!this.view) return;
      if (this.jsonDirty) { this.setNotice(uiText("高级 JSON 有未应用的编辑；请先应用或放弃编辑。")); return; }
      this.dirty = true; value.textContent = String(Number(input.value));
      const parameters = this.editedParameters();
      const [group, key] = path.split(".");
      (parameters as unknown as Record<string, Record<string, number>>)[group][key] = Number(input.value);
      this.editor.value = JSON.stringify(parameters, null, 2); this.setNotice(uiText("参数已编辑，应用后生效。"));
    });
    label.append(text, input, value); parent.append(label); this.sliders.set(path, { input, value, min, max });
  }
  private fillParameters(): void {
    if (!this.view) return;
    this.editor.value = JSON.stringify(this.view.parameters, null, 2);
    this.blushEnabled.checked = this.view.parameters.blush.enabled;
    for (const [path, slider] of this.sliders) {
      const [group, key] = path.split(".");
      const value = (this.view.parameters as unknown as Record<string, Record<string, number>>)[group][key];
      // Preserve an existing extended-range value until this exact slider is deliberately moved.
      slider.input.min = String(Math.min(slider.min, value));
      slider.input.max = String(Math.max(slider.max, value));
      slider.input.value = String(value); slider.value.textContent = String(value);
    }
  }
  private editedParameters(): MoodParameters { return JSON.parse(this.editor.value) as MoodParameters; }
  private async apply(): Promise<void> {
    if (this.busy || !this.view) return;
    const identity = this.identity;
    try {
      const parameters: unknown = JSON.parse(this.editor.value);
      const extended = moodExtendedDifferences(parameters, this.view.parameters);
      if (extended.length && !window.confirm(uiTemplate`以下角色参数超出常规范围，会改变反应速度、敏感程度或表现强弱：\n\n${extended.slice(0, 20).join("\n")}${extended.length > 20 ? uiTemplate`\n另有 ${extended.length - 20} 项。` : ""}\n\n是否采用本次扩展配置？`)) {
        this.setNotice(uiText("扩展参数尚未应用；现有状态和记录保留。")); return;
      }
      this.setBusy(true); await this.options.onApply(parameters);
      if (this.disposed || identity !== this.identity) return;
      this.dirty = false; this.jsonDirty = false;
      this.fillParameters();
      this.setNotice(uiText("参数已应用；当前状态与聊天记录保留。"));
    } catch (error) { this.error(error); }
    finally { this.setBusy(false); }
  }
  private async restore(): Promise<void> {
    if (this.busy) return;
    const identity = this.identity;
    try {
      this.setBusy(true); await this.options.onRestore();
      if (this.disposed || identity !== this.identity) return;
      this.dirty = false; this.jsonDirty = false; this.fillParameters();
      this.setNotice(uiText("已恢复 Gene 参数；当前状态与聊天记录保留。"));
    } catch (error) { this.error(error); }
    finally { this.setBusy(false); }
  }
  private button(text: string, action: () => unknown): HTMLButtonElement {
    const button = node("button", "", text); button.type = "button";
    button.addEventListener("click", () => { if (!this.busy) void Promise.resolve(action()).catch(error => this.error(error)); });
    this.buttons.push(button); return button;
  }
  private setBusy(busy: boolean): void {
    this.busy = busy; for (const button of this.buttons) button.disabled = busy;
    this.editor.disabled = this.blushEnabled.disabled = busy; for (const slider of this.sliders.values()) slider.input.disabled = busy;
    const fatigue = fatiguePanelView(this.view?.fatigue);
    if (this.wakeButton) this.wakeButton.disabled = busy || !fatigue.connected || !fatigue.phase || this.view?.fatigue?.phase === 'awake';
  }
  private setNotice(message: string): void { this.notice.textContent = message; }
  private error(error: unknown): void { const message = String(error); this.setNotice(message); this.options.onError?.(message); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.innerLoop?.dispose(); this.panel.remove(); this.view = null; }
}
