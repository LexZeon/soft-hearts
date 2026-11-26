// I-138: the run over all moments (resume, call cap, outputs) and the Question-1 helper. The CLI is scripts/i138-restart-drift.ts.
// State is written after every finished turn to <out>/state.json (private: it holds the texts). A moment that was interrupted is redone
// from its warm-up (the live process and the fork cannot be rebuilt identically); finished moments are kept.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LONG_CHAT_KNOBS } from '../../shared/behaviors/long-chat/knobs';
import { locatePoint, type PointSpec } from './i134-replay';
import { DRIFT_ARMS, DRIFT_ARM_NAMES, plannedCalls, type CallCap, type DriftArm, type DriftSettings } from './i138-plan';
import { Conversation, removeTranscripts, runMoment, type Ask, type EngineOptions, type MomentState } from './i138-run';
import {
  buildDriftSheet, compareStyle, driftSheetHtml, jokePickup, reviewedArms, styleNumbers, tokenRatio, projectSessionTokens,
  type DriftMomentView, type Line, type TokenSample,
} from './i138-analysis';

export interface DriftState { version: 1; seed: number; warmup: number; next: number; fake: boolean; callsUsed: number; moments: MomentState[]; stopped?: string }

export async function loadDriftState(out: string): Promise<DriftState | null> {
  try {
    const state = JSON.parse(await readFile(path.join(out, 'state.json'), 'utf8')) as DriftState;
    return state?.version === 1 && Array.isArray(state.moments) ? state : null;
  } catch { return null; }
}
export async function saveDriftState(out: string, state: DriftState): Promise<void> {
  await mkdir(out, { recursive: true });
  const file = path.join(out, 'state.json');
  await writeFile(file + '.tmp', JSON.stringify(state), 'utf8');
  await rename(file + '.tmp', file);
}

export interface DriftRunOptions {
  engine: EngineOptions;
  points: readonly PointSpec[];
  settings: Pick<DriftSettings, 'warmup' | 'next' | 'review'>;
  arms?: readonly DriftArm[];
  seed: number;
  out: string;
  resume: boolean;
  fake: boolean;
  askNote: Ask;
  askReview: Ask;
  cap: CallCap;
  /** Delete the saved transcripts of the persisted sessions at the end (real runs). */
  removeTranscripts?: boolean;
}

/** Every call the run would still make, before any is made: the moments not yet done. Throws when that passes the cap. */
export function remainingPlan(options: Pick<DriftRunOptions, 'points' | 'settings' | 'arms' | 'cap'>, doneIds: ReadonlySet<string>): { moments: number; calls: number } {
  const moments = options.points.filter(point => !doneIds.has(point.id)).length;
  const calls = plannedCalls({ ...options.settings, moments, q1Calls: 0, ...(options.arms ? { arms: options.arms } : {}) }).total;
  if (options.cap.used + calls > options.cap.cap) throw new Error(`还要 ${calls} 次调用，加上已用的 ${options.cap.used}，超过上限 ${options.cap.cap}，没有开始。`);
  return { moments, calls };
}

export async function runDrift(options: DriftRunOptions): Promise<{ state: DriftState; stopped: string | null }> {
  const { engine } = options;
  const log = engine.log ?? (() => {});
  const arms = options.arms ?? DRIFT_ARMS;
  const previous = options.resume ? await loadDriftState(options.out) : null;
  const state: DriftState = previous && previous.seed === options.seed && previous.warmup === options.settings.warmup && previous.next === options.settings.next
    ? { ...previous, moments: previous.moments.filter(moment => moment.done), fake: options.fake }
    : { version: 1, seed: options.seed, warmup: options.settings.warmup, next: options.settings.next, fake: options.fake, callsUsed: 0, moments: [] };
  if (options.resume && previous && state.moments.length === 0 && previous.moments.length) log('[i138] 续跑：之前没有完整做完的时刻，从头开始');
  options.cap.used = state.callsUsed;
  const doneIds = new Set(state.moments.map(moment => moment.id));
  for (const point of options.points) locatePoint(engine.snapshot.messages, point); // a bad point stops before any call
  remainingPlan(options, doneIds);
  let stopped: string | null = null;
  const cwds: string[] = [];
  const withCwds: EngineOptions = { ...engine, cwds };
  try {
    for (const point of options.points) {
      if (doneIds.has(point.id)) { log(`[i138] ${point.id} 已完成，沿用`); continue; }
      log(`[i138] ${point.id}：笔记、热身 ${options.settings.warmup} 次、各组 ${options.settings.next} 次`);
      const finished = await runMoment(withCwds, point, { settings: options.settings, seed: options.seed, arms, askNote: options.askNote, askReview: options.askReview,
        save: async moment => { state.callsUsed = options.cap.used; await saveDriftState(options.out, { ...state, moments: [...state.moments, moment] }); } });
      state.moments.push(finished);
      state.callsUsed = options.cap.used;
      await saveDriftState(options.out, state);
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    state.stopped = stopped;
    state.callsUsed = options.cap.used;
  } finally {
    if (options.removeTranscripts) log(`[i138] 删掉了 ${await removeTranscripts(cwds, engine.claudeHome ?? path.join(process.env.USERPROFILE ?? '', '.claude'))} 个临时会话记录`);
  }
  await saveDriftState(options.out, state);
  await writeDriftOutputs(options.out, state);
  return { state, stopped };
}

// ---- outputs ------------------------------------------------------------------------------------------------------------------------

const median = (values: readonly number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]! : null;
const lines = (state: MomentState, arm: DriftArm): Line[] => (state.arms[arm] ?? []).map(rec => ({ user: rec.user, assistant: rec.text }));

/** Numbers only: per moment and arm, the style numbers against W, the jokes picked up, refusals, timings and tokens. */
export function driftMetricsMarkdown(state: DriftState): string {
  const out = ['# I-138 机器量（只有数字）', '', `热身 ${state.warmup} 句，每组 ${state.next} 句，${state.moments.length} 个时刻，已用 ${state.callsUsed} 次调用${state.fake ? '（假 Claude）' : ''}`, ''];
  if (state.stopped) out.push(`中止：${state.stopped}`, '');
  for (const moment of state.moments) {
    out.push(`## ${moment.id}`, '', `笔记 ${Array.from(moment.note).length} 字；热身里长出的梗 ${moment.jokes.length} 条；她的惯用词 ${moment.profile.catchphrases.length} 个，称呼 ${moment.profile.addresses.length} 个`);
    if (moment.compaction) out.push(`压缩：${moment.compaction.ok ? '成功' : '失败'}，${moment.compaction.ms ?? '-'}ms${moment.compaction.usage ? `，读入 ${moment.compaction.usage.inputTokens + moment.compaction.usage.cacheReadTokens + moment.compaction.usage.cacheCreationTokens} 词元` : ''}`);
    out.push('', '| 组 | 句数 | 被拒 | 平均字数 | 问句 | 省略号 | 感叹号 | 称呼 | 惯用词 | 接上的梗 | 首字中位 ms | 平均读入词元 | 与 W 差超两成的项 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const base = styleNumbers((moment.arms.W ?? []).filter(rec => !rec.error).map(rec => rec.text), moment.profile);
    for (const arm of DRIFT_ARMS) {
      const recs = moment.arms[arm];
      if (!recs?.length) continue;
      const good = recs.filter(rec => !rec.error);
      const style = styleNumbers(good.map(rec => rec.text), moment.profile);
      const pick = jokePickup(good.map(rec => rec.text), moment.jokes);
      const usage = good.map(rec => rec.usage).filter((item): item is NonNullable<typeof item> => !!item).map(item => item.inputTokens + item.cacheReadTokens + item.cacheCreationTokens);
      const off = arm === 'W' || !base.replies ? '-' : compareStyle(style, base).filter(item => !item.within).map(item => item.metric).join('、') || '无';
      out.push(`| ${arm} ${DRIFT_ARM_NAMES[arm]} | ${good.length} | ${recs.filter(rec => rec.refused).length} | ${style.avgChars} | ${style.questions} | ${style.ellipses} | ${style.exclamations} | ${style.addresses} | ${style.catchphrases} | ${pick.jokes}/${pick.total}（${pick.replies} 句） | ${median(good.map(rec => rec.firstCharMs).filter((v): v is number => v !== null)) ?? '-'} | ${usage.length ? Math.round(usage.reduce((a, b) => a + b, 0) / usage.length) : '-'} | ${off} |`);
    }
    if (moment.review) {
      const answer = moment.review.answer ? reviewedArms(moment.review.answer, moment.review.key) : null;
      out.push('', `第一道关（Claude 审查）：${answer ? DRIFT_ARMS.filter(arm => answer[arm]).map(arm => `${arm} ${answer[arm]!.changed ? '有明显变化（第 ' + answer[arm]!.lines.join('、') + ' 轮）' : '没有明显变化'}`).join('；') : '没有可用的回答（' + (moment.review.error ?? '') + '）'}`);
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

export interface DriftFiles { state: string; metrics: string; sheet: string; items: string; key: string }
/** metrics.md, the reading sheet (sheet.html + items.json + key.json) and one reviewer prompt/answer file per moment. All private. */
export async function writeDriftOutputs(out: string, state: DriftState): Promise<DriftFiles> {
  await mkdir(path.join(out, 'review'), { recursive: true });
  const files: DriftFiles = { state: path.join(out, 'state.json'), metrics: path.join(out, 'metrics.md'), sheet: path.join(out, 'sheet.html'), items: path.join(out, 'items.json'), key: path.join(out, 'key.json') };
  await writeFile(files.metrics, driftMetricsMarkdown(state), 'utf8');
  const views: DriftMomentView[] = state.moments.filter(moment => moment.done).map(moment => ({
    id: moment.id, context: moment.warm.slice(-3).flatMap(rec => [{ role: 'user' as const, text: rec.user }, { role: 'assistant' as const, text: rec.text }]),
    arms: Object.fromEntries(DRIFT_ARMS.filter(arm => (moment.arms[arm]?.length ?? 0) > 0).map(arm => [arm, lines(moment, arm)])),
  }));
  const { items, key } = buildDriftSheet(views, state.seed);
  await writeFile(files.items, JSON.stringify(items, null, 2), 'utf8');
  await writeFile(files.key, JSON.stringify(key, null, 2), 'utf8');
  await writeFile(files.sheet, driftSheetHtml(items), 'utf8');
  for (const moment of state.moments) {
    if (!moment.review) continue;
    await writeFile(path.join(out, 'review', `${moment.id}-prompt.txt`), moment.review.prompt, 'utf8');
    await writeFile(path.join(out, 'review', `${moment.id}-answer.json`), JSON.stringify({ key: moment.review.key, answer: moment.review.answer, error: moment.review.error }, null, 2), 'utf8');
  }
  for (const moment of state.moments) await writeFile(path.join(out, `jokes-${moment.id}.json`), JSON.stringify(moment.jokes, null, 2), 'utf8');
  return files;
}

// ---- Question 1: characters to tokens -------------------------------------------------------------------------------------------------

export interface Q1Result { samples: (TokenSample & { point: string })[]; ratio: ReturnType<typeof tokenRatio>; projection: ReturnType<typeof projectSessionTokens> | null; sessionMaxChars: number }
/**
 * One opening per point with a large real window (windowMaxChars and beforeDay raised), the first turn of a fresh process; reads what Claude Code
 * reports (input + cache read + cache creation) against the characters of the prompt that went out. Counts against the cap like any call.
 */
export async function measureTokens(engine: EngineOptions, points: readonly PointSpec[], windowChars: number, out: string): Promise<Q1Result> {
  const samples: Q1Result['samples'] = [];
  const big: EngineOptions = { ...engine, knobs: { ...LONG_CHAT_KNOBS, beforeDay: 1_000_000, windowMaxChars: windowChars } };
  for (const point of points) {
    const index = locatePoint(engine.snapshot.messages, point);
    const conversation = await Conversation.open(big, { point, index, note: null, mode: 'plain', label: `${point.id}-q1` });
    try {
      const rec = await conversation.turn({ text: engine.snapshot.messages[index]!.content, createdAt: point.at });
      if (rec.error || !rec.usage || !rec.promptChars) throw new Error(`问题 1：${point.id} 没有量到词元（${rec.error ?? '没有用量'}）`);
      samples.push({ point: point.id, promptChars: rec.promptChars, inputTokens: rec.usage.inputTokens, cacheReadTokens: rec.usage.cacheReadTokens, cacheCreationTokens: rec.usage.cacheCreationTokens });
    } finally { await conversation.dispose(); }
  }
  const ratio = tokenRatio(samples);
  const sessionMaxChars = LONG_CHAT_KNOBS.sessionMaxChars;
  const result: Q1Result = { samples, ratio, projection: ratio ? projectSessionTokens(ratio, sessionMaxChars) : null, sessionMaxChars };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'q1.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}
