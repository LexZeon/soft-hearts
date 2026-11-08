// L1 inner loop: a synthetic idle timeline on the real MoodHost + InnerLoop + shared gate, with a
// simulated clock (the model call itself runs in real time while the simulated clock waits).
// Used by tests (fake decisions) and by scripts/inner-loop-day.ts (real Claude Code, haiku).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../../electron/mood';
import { ProactiveSpeechGate } from '../../electron/proactive-speech-gate';
import { InnerLoop, type InnerLoopUsage } from '../../electron/inner-loop/inner-loop';
import { claimMoodCue } from '../../electron/inner-loop/claim';
import { OpeningHost } from '../../electron/inner-loop/opening-host';
import type { OpeningChoiceHost } from '../../shared/behaviors/opening-choice/interface';
import { innerLoopPrompt, innerLoopQuietAt } from '../../electron/inner-loop/context';
import { advanceFatigue, createFatigue, DEFAULT_FATIGUE_PARAMETERS, type FatigueParameters, type FatigueState } from '../../shared/fatigue';
import type { MoodParameters } from '../../shared/mood';
import type { ProactiveTalk } from "../../shared/behaviors/inner-rhythm/knobs";
import type { BoredomTimingHost } from '../../shared/behaviors/boredom-timing/interface';
import type { InnerLoopAction, InnerLoopDiagnostic, InnerLoopQuiet } from '../../shared/inner-loop';

export interface DayCard { id: string; persona: string; parameters: MoodParameters; fatigue?: Readonly<FatigueParameters> }
/** One idle stretch: the user interacts (a chat) at `startMinute` local time, then leaves her alone. */
export interface IdleBlock { startMinute: number; idleMinutes: number }
export interface DecideInfo { cue: 'motion' | 'speech'; allowSpeech: boolean; quiet: Readonly<InnerLoopQuiet> }
export type DayDecide = (prompt: string, signal: AbortSignal, info: DecideInfo) => Promise<{ text: string; usage?: InnerLoopUsage | null }>;
export interface DayOptions {
  card: DayCard;
  blocks: readonly IdleBlock[];
  decide: DayDecide;
  /** Never ask the model more than this many times (the call then counts as not made). */
  maxCalls?: number;
  /** Stop everything after the first failed call this accepts (e.g. a 429 or quota error); never retried. */
  stopOn?: (error: unknown) => boolean;
  /** Local midnight of the simulated day (wall ms); defaults to today's. */
  midnight?: number;
  /** Optional: the visible bubble is confirmed (default true). */
  presented?: boolean;
  /** Optional (#8): when she looks, moves and may speak; default her own timing (random), FixedBoredomTiming = the card's numbers. */
  boredomTiming?: BoredomTimingHost;
  /**
   * Optional (I-020 #10): route speech cues through the opening choice (electron/inner-loop/opening-host.ts), as the app does now.
   * Absent: the old arm (every speech cue goes to the inner loop). The day has no screen, sound or game, so the candidates are her
   * small feeling and "这次不说".
   */
  opening?: { chooser: OpeningChoiceHost };
  /**
   * Optional (I-013 L1): the inner loop's call rhythm (varied spacing, stretched at night and while the user is away), with this random
   * source; `userAway(now)` stands in for the system's away reading. Absent: the old fixed spacing, which the older tests measure.
   */
  /** Optional (I-039): extra user chat messages at these local minutes (before the first block they are the "busy stretch"). Default none. */
  messages?: readonly number[];
  /** Optional (I-039): the 「她主动找你说话」 setting seen by the mood host (default 适中). */
  proactiveTalk?: ProactiveTalk;
  rhythm?: { random: () => number; userAway?: (wallMs: number) => boolean; /** 设置「她主动找你说话」 (default 适中). */ talk?: ProactiveTalk };
}
export interface DayResult {
  card: string;
  opportunities: { motion: number; speech: number; look: number };
  calls: number;
  allowSpeechCalls: number;
  quietSpeechCalls: number;
  decisions: Record<InnerLoopAction, number>;
  results: Record<string, number>;
  spoken: { at: number; text: string }[];
  prompts: string[];
  diagnostics: InnerLoopDiagnostic[];
  /** Real wall-clock duration of each model call (the simulated clock stands still meanwhile). */
  ms: number[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  stoppedByError: string | null;
  idleMinutes: number;
  /** I-020 #10 (with `opening`): who took each speech cue. */
  owners: Record<string, number>;
  /** When each speech cue was accepted (simulated wall ms). */
  speechAt: number[];
}

const MINUTE = 60_000;
const NO_BLOCKERS = Object.freeze({ chat: false, tts: false, manualMotion: false });

export async function runInnerLoopDay(options: DayOptions): Promise<DayResult> {
  const midnight = options.midnight ?? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const blocks = [...options.blocks].sort((a, b) => a.startMinute - b.startMinute);
  const messages = [...(options.messages ?? [])].sort((a, b) => a - b);
  const start = midnight + Math.min(blocks[0]?.startMinute ?? 0, messages[0] ?? Infinity) * MINUTE - MINUTE;
  const clock = { now: start };
  const localMinute = (wall: number) => (wall - midnight) / MINUTE % 1440;
  const fatigueParameters = options.card.fatigue ?? DEFAULT_FATIGUE_PARAMETERS;
  let fatigue: Readonly<FatigueState> = createFatigue({ monotonicMs: 86_400_000, localMinute: localMinute(start) }, {}, fatigueParameters);
  const monotonic = () => 86_400_000 + clock.now - start;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-inner-loop-day-'));
  const result: DayResult = { card: options.card.id, opportunities: { motion: 0, speech: 0, look: 0 }, calls: 0, allowSpeechCalls: 0,
    quietSpeechCalls: 0, decisions: { none: 0, motion: 0, look: 0, speak: 0, switch: 0, invite: 0 }, results: {}, spoken: [], prompts: [], diagnostics: [],
    ms: [], costUsd: 0, inputTokens: 0, outputTokens: 0, stoppedByError: null, idleMinutes: blocks.reduce((sum, b) => sum + b.idleMinutes, 0), owners: {}, speechAt: [] };
  const seenCues = new Set<string>();
  let token = '';
  let loop: InnerLoop | null = null;
  let opening: OpeningHost | null = null;
  const host = new MoodHost(directory, view => {
    token = view.token;
    const cue = view.snapshot.cue;
    const first = !!cue && !seenCues.has(cue.id) && (cue.kind === 'look' || cue.kind === 'motion' || cue.kind === 'speech');
    if (first) { seenCues.add(cue!.id); result.opportunities[cue!.kind as 'look' | 'motion' | 'speech']++; if (cue!.kind === 'speech') result.speechAt.push(cue!.at); }
    if (!loop) return;
    const owner = opening ? opening.claim(cue, {}, view)
      : claimMoodCue(cue, { inner: c => loop!.offerOpportunity(c) }, c => loop!.claims(c.id) ? 'inner' : null);
    if (first && cue!.kind === 'speech') result.owners[String(owner)] = (result.owners[String(owner)] ?? 0) + 1;
  }, () => clock.now, { fatigueClock: { monotonicMs: () => clock.now - start, wallMs: () => clock.now, localMinute },
    ...(options.boredomTiming ? { boredomTiming: options.boredomTiming } : {}) });
  const gate = new ProactiveSpeechGate(() => clock.now);
  let pendingAck: string | null = null;
  try {
    await host.load();
    host.activate(options.card.id, options.card.parameters);
    host.setFatigueActivity(NO_BLOCKERS);
    if (options.proactiveTalk) host.setProactiveTalkSource(() => options.proactiveTalk);
    const scope = () => `day:${token}`;
    let lastInfo: DecideInfo | null = null;
    loop = new InnerLoop({
      gate, clock: () => clock.now,
      enabled: () => !result.stoppedByError, canStart: () => !gate.busy, current: () => true,
      scope: () => ({ characterId: options.card.id, gateScope: scope() }),
      parameters: () => host.get().parameters,
      ...(options.rhythm ? { rhythm: {
        random: options.rhythm.random,
        awayMinutes: () => { const at = host.get().snapshot.lastInteractionAt; return typeof at === 'number' ? Math.max(0, (clock.now - at) / MINUTE) : null; },
        userAway: () => options.rhythm?.userAway?.(clock.now) === true,
        ...(options.rhythm.talk ? { talk: () => options.rhythm!.talk! } : {}),
      } } : {}),
      quiet: () => innerLoopQuietAt(fatigue.phase, localMinute(clock.now), fatigueParameters),
      prompt: (claim, allowSpeech, quiet, _herLife, play, focus) => {
        lastInfo = { cue: claim.kind, allowSpeech, quiet: { ...quiet } };
        const prompt = innerLoopPrompt({ now: () => clock.now, localMinute, persona: () => options.card.persona, language: () => '',
          mood: () => host.chatContext(), parameters: () => host.get().parameters,
          lastInteractionAt: () => host.get().snapshot.lastInteractionAt, profileEnabled: () => false, profilePoints: () => '',
          audioReading: () => false, ambientText: () => '' }, claim, allowSpeech, quiet, null, play, focus);
        result.prompts.push(prompt);
        return prompt;
      },
      decide: async (prompt, signal) => {
        if (options.maxCalls !== undefined && result.calls >= options.maxCalls) throw new Error('call budget reached');
        result.calls++;
        const info = lastInfo!;
        if (info.allowSpeech) result.allowSpeechCalls++;
        if (info.cue === 'speech' && info.quiet.quiet) result.quietSpeechCalls++;
        const started = performance.now();
        try { return await options.decide(prompt, signal, info); }
        catch (error) {
          if (options.stopOn?.(error)) result.stoppedByError = String(error instanceof Error ? error.message : error).slice(0, 300);
          throw error;
        } finally { result.ms.push(Math.round(performance.now() - started)); }
      },
      realize: (claim, kind, id) => host.event({ type: 'attention', id, kind, claimed: { id: claim.id, kind: claim.kind, at: claim.at } }, claim.characterId),
      releaseSpeech: claim => host.releaseSpeech({ id: claim.id, at: claim.at }, claim.characterId),
      offer: message => { pendingAck = message.id; },
      present: async () => options.presented !== false,
      presentationCurrent: () => options.presented !== false,
      archive: async message => { result.spoken.push({ at: message.origin.at, text: message.text }); },
      record: entry => {
        result.diagnostics.push(entry);
        result.results[entry.result] = (result.results[entry.result] ?? 0) + 1;
        if (entry.called) result.decisions[entry.decision]++;
        result.costUsd += entry.costUsd ?? 0; result.inputTokens += entry.inputTokens ?? 0; result.outputTokens += entry.outputTokens ?? 0;
      },
    });
    if (options.opening) opening = new OpeningHost({ loop, chooser: options.opening.chooser, innerOn: () => !result.stoppedByError,
      releaseSpeech: (cue, characterId) => host.releaseSpeech({ id: cue.id, at: cue.at }, characterId), developerMode: () => false, clock: () => clock.now });
    const step = async () => {
      clock.now += 1000;
      while (messages.length && midnight + messages[0] * MINUTE <= clock.now) host.event({ type: 'chat', id: `user_msg_${messages.shift()}_${clock.now}` }, options.card.id);
      fatigue = advanceFatigue(fatigue, { clock: { monotonicMs: monotonic(), localMinute: localMinute(clock.now) },
        channels: host.get().snapshot.values, baseline: host.get().parameters.baseline, blockers: NO_BLOCKERS, mode: 'active' }, fatigueParameters);
      gate.setScope(scope());
      loop!.sweep();
      host.tick(!gate.busy, { fatigueActivity: NO_BLOCKERS });
      // The simulated clock waits while the (fake or real) model answers.
      while (loop!.busy) {
        if (pendingAck) { const id = pendingAck; pendingAck = null; await loop!.ack(id); continue; }
        await new Promise(resolve => setImmediate(resolve));
      }
    };
    for (const [index, block] of blocks.entries()) {
      const at = midnight + block.startMinute * MINUTE;
      // Between blocks the user is busy with her (or the pet is hidden): the gap is a quiet relaunch for the
      // mood clock (boredom starts from 0), while her own fatigue keeps running awake.
      while (clock.now < at - 1_000) {
        clock.now = Math.min(at - 1_000, clock.now + 60_000);
        while (messages.length && midnight + messages[0] * MINUTE <= clock.now) {
          const sent = messages.shift()!;
          host.event({ type: 'chat', id: `user_msg_${sent}_${index}` }, options.card.id);
        }
        fatigue = advanceFatigue(fatigue, { clock: { monotonicMs: monotonic(), localMinute: localMinute(clock.now) },
          channels: host.get().snapshot.values, baseline: host.get().parameters.baseline, blockers: NO_BLOCKERS, mode: 'active' }, fatigueParameters);
      }
      await step();
      host.event({ type: 'chat', id: `user_${index}` });      const end = at + block.idleMinutes * MINUTE;
      while (clock.now < end && !result.stoppedByError) await step();
    }
    return result;
  } finally {
    loop?.dispose(); gate.dispose();
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
