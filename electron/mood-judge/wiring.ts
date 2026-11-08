import path from 'node:path';
import { quickLineWithClaude } from '../inner-loop/model';
import { boredomLevel, longingLevel } from '../journal/sources';
import { MOOD_LABELS, type MoodView } from '../../shared/mood-runtime';
import type { MoodValues } from '../../shared/mood';
import type { ScreenActivity } from '../../shared/screen-activity';
import { MOOD_JUDGE_KNOBS } from '../../shared/behaviors/mood-judge/knobs';
import type { MoodJudgeFrame } from '../../shared/behaviors/mood-judge/choose';
import type { MoodJudgeAsk, MoodJudgeMoodNote, MoodJudgeNow, MoodJudgeSwitchView } from '../../shared/behaviors/mood-judge/interface';
import { MoodJudgeHost, type MoodJudgeHostOptions, type MoodJudgeQuiet } from './host';
import { MoodJudgeStore } from './store';

const FATIGUE_WORDS: Readonly<Record<string, string>> = { awake: '清醒', 'light-drowsy': '有点困', drowsy: '犯困', 'falling-asleep': '快睡着了',
  asleep: '睡着了', 'micro-awake': '睡梦里迷糊了一下' };
const DOING_WORDS: Readonly<Record<string, string>> = { company: '陪着你', daydream: '发呆', humming: '哼歌', thinking: '想事情', drowsy: '犯困' };
/** She sleeps (nothing is asked; waking up is an event of its own). */
export const sleepingPhase = (phase: string | undefined): boolean => phase === 'asleep' || phase === 'micro-awake';
const values = (value: Partial<MoodValues> | undefined, fallback: number): MoodValues =>
  ({ D: value?.D ?? fallback, O: value?.O ?? fallback, E: value?.E ?? fallback, N: value?.N ?? fallback, C: value?.C ?? fallback });

/** One published mood view (and the two closures main.ts has) → what the judge watches. Plain numbers and names only. */
export function moodJudgeFrame(view: MoodView, extras: { at: number; screen?: ScreenActivity | null; songs?: number | null }): MoodJudgeFrame {
  const s = view.snapshot, p = view.parameters;
  const bored = boredomLevel(s.boredom, p.boredom), longing = longingLevel(s.longing, p.longing);
  const need = view.herNeed && view.herNeed.mode === 'need' ? { id: view.herNeed.id, since: view.herNeed.since } : null;
  const cue = view.pose?.cue ?? null;
  return { characterId: view.characterId, at: extras.at, sleeping: sleepingPhase(view.fatigue?.phase),
    bored: bored === 'none' ? null : bored, longing: longing === 'none' ? null : longing, lastInteractionAt: s.lastInteractionAt, need,
    pose: cue ? { id: cue.id, kind: cue.kind, source: cue.source } : null, screen: extras.screen ?? null, songs: extras.songs ?? null };
}

/** "此刻" for haiku from the current view and the card's personality text (cut to knobs.personaChars). */
export function moodJudgeNow(view: MoodView, persona: string, at: number): MoodJudgeNow {
  const p = view.parameters, s = view.snapshot;
  return { characterId: view.characterId, persona: String(persona ?? '').slice(0, MOOD_JUDGE_KNOBS.personaChars * 2),
    personality: { playful: p.weights.playful, close: p.weights.close, comfortable: p.weights.comfortable, cautious: p.weights.cautious },
    values: values(s.values, 50), baseline: values(p.baseline, 50), sensitivity: values(p.sensitivity, 1),
    label: MOOD_LABELS[s.primary] ?? '', fatigue: FATIGUE_WORDS[view.fatigue?.phase ?? ''] ?? '', doing: DOING_WORDS[view.herLife?.activity ?? ''] ?? '', at };
}

/** The mood host as the judge uses it (electron/mood.ts MoodHost). */
export interface MoodJudgeMoodPort {
  get(): MoodView;
  isTestMoodActive(): boolean;
  lift(lift: { id: string; delta: Partial<MoodValues>; reason: string; context?: 'neutral' }, characterId?: string): void;
}

/** What electron/main.ts supplies: closures read only when needed. */
export interface MoodJudgeWiring {
  directory(): string | null;
  mood(): MoodJudgeMoodPort | null;
  /** The active card's personality and description (her own text, not the user's), for the summary. */
  persona(): string;
  /** The pet window is on screen (not hidden, not minimized). */
  petVisible(): boolean;
  /** chatAvailability.isAvailable(). */
  available(): boolean;
  /** Her reply is being written or read aloud right now. */
  busy(): boolean;
  developerMode(): boolean;
  /** companion.mood.moodJudgeChanged(): the developer panel's line. */
  changed?(): void;
  /** The switch changed: the control window hears it. */
  broadcast?(view: MoodJudgeSwitchView): void;
  /** Screen sharing's rough activity now (electron/screen-glance.ts rough()), null when off or unknown. */
  screen?(): ScreenActivity | null;
  /** How many pieces listening together has begun (electron/listen-together counts.segment), null when it does not run. */
  songs?(): number | null;
  /** I-037: 新的反应方式 is on: its haiku call gives each message's mood, the judge leaves messages alone (host.ts skipMessages). */
  skipMessages?(): boolean;
  /** Tests only: another small-model call. */
  ask?: MoodJudgeAsk;
  host?: Partial<Pick<MoodJudgeHostOptions, 'clock' | 'timers' | 'knobs' | 'localDate'>>;
}
type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

/**
 * I-027 心情调整员 for the app: the store, the host and two fixed IPC operations (getMoodJudge, setMoodJudge; the channel
 * desk:mood-judge). Brain interface (docs/claude/brain-interface.md): its one call is electron/inner-loop/model.ts
 * quickLineWithClaude (haiku, no tools, its own system prompt); nothing else here knows Claude.
 */
export function createMoodJudge(wiring: MoodJudgeWiring) {
  const store = new MoodJudgeStore({ file: () => { const dir = wiring.directory(); return dir ? path.join(dir, 'mood-judge.json') : null; } });
  const safe = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
  const host = new MoodJudgeHost({
    ask: wiring.ask ?? (async (prompt, systemPrompt, signal) => (await quickLineWithClaude(prompt, systemPrompt, signal)).text),
    store,
    now: () => {
      const mood = wiring.mood();
      if (!mood) return null;
      const view = mood.get();
      return view.characterId ? moodJudgeNow(view, safe(() => wiring.persona(), ''), Date.now()) : null;
    },
    quiet: (): MoodJudgeQuiet | null => {
      const mood = wiring.mood();
      if (!mood) return 'unavailable';
      const view = mood.get();
      if (sleepingPhase(view.fatigue?.phase)) return 'asleep';
      if (safe(() => mood.isTestMoodActive(), false)) return 'test-mood';
      if (!view.expressions) return 'expressions-off';
      if (!safe(() => wiring.petVisible(), false)) return 'hidden';
      if (!safe(() => wiring.available(), false)) return 'unavailable';
      return null;
    },
    busy: () => wiring.busy(),
    apply: (lift, characterId) => { wiring.mood()?.lift(lift, characterId); },
    developerMode: wiring.developerMode,
    changed: wiring.changed,
    skipMessages: () => wiring.skipMessages?.() === true,
    ...wiring.host,
  });
  const view = (): MoodJudgeSwitchView => ({ enabled: store.enabled, cap: host.capToday(), base: MOOD_JUDGE_KNOBS.callsPerDay,
    perChat: MOOD_JUDGE_KNOBS.callsPerChat, max: MOOD_JUDGE_KNOBS.callsPerDayMax });
  const setEnabled = (value: unknown): MoodJudgeSwitchView => {
    if (typeof value !== 'boolean') throw new Error('心情调整员开关不正确。');
    store.setEnabled(value);
    host.switched();
    const next = view();
    try { wiring.broadcast?.(next); } catch { /* A closed window misses one update. */ }
    return next;
  };
  const register = (scopedHost: Register) => {
    scopedHost('getMoodJudge', () => view(), false);
    // The switch: the control window only (隐私与设置); the agent channel calls the same operation.
    scopedHost('setMoodJudge', (_sender, value) => setEnabled(value), true);
  };
  return {
    host, store, register, view, setEnabled,
    load: () => store.load(),
    /** MoodHost.setJudgeObserver. */
    noteMood: (note: MoodJudgeMoodNote) => { try { host.noteMood(note); } catch { /* Never into her mood. */ } },
    /** Every published mood view. */
    watch: (moodView: MoodView) => {
      if (!moodView?.characterId || !moodView.snapshot || !moodView.parameters) return;
      // Called inside every mood publish: it must never throw into her view.
      try { host.watch(moodJudgeFrame(moodView, { at: Date.now(), screen: safe(() => wiring.screen?.() ?? null, null), songs: safe(() => wiring.songs?.() ?? null, null) })); }
      catch { /* Watching never disturbs her. */ }
    },
    dispose: () => { host.dispose(); return store.flush(); },
  };
}
