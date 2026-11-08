import { quickLineWithClaude } from '../inner-loop/model';
import { MOOD_LABELS, type MoodView } from '../../shared/mood-runtime';
import { PAUSE_TALK_KNOBS } from '../../shared/behaviors/pause-talk/knobs';
import type { PauseTalkAsk, PauseTalkCue, PauseTalkNow } from '../../shared/behaviors/pause-talk/interface';
import { PauseTalkHost, type PauseTalkHostOptions } from './host';

const FATIGUE_WORDS: Readonly<Record<string, string>> = { awake: '清醒', 'light-drowsy': '有点困', drowsy: '犯困', 'falling-asleep': '快睡着了',
  asleep: '睡着了', 'micro-awake': '睡梦里迷糊了一下' };
/** A blush this faint no longer reads as shy (the same line as electron/reply-rhythm-host.ts). */
const SHY_MIN_AMOUNT = 0.05;

/** "此刻" for haiku from the current mood view and the card's own personality text (cut to knobs.personaChars). Labels and numbers only. */
export function pauseTalkNow(view: MoodView, persona: string, at: number): PauseTalkNow {
  const p = view.parameters, s = view.snapshot;
  return { characterId: view.characterId, persona: String(persona ?? '').slice(0, PAUSE_TALK_KNOBS.personaChars * 2),
    personality: { playful: p.weights.playful, close: p.weights.close, comfortable: p.weights.comfortable, cautious: p.weights.cautious },
    label: MOOD_LABELS[s.primary] ?? '', values: { ...s.values }, fatigue: FATIGUE_WORDS[view.fatigue?.phase ?? ''] ?? '',
    shy: !!s.blush && s.blush.amount >= SHY_MIN_AMOUNT, at };
}

/** What electron/main.ts supplies: closures read only when needed. */
export interface PauseTalkWiring {
  /** settings.voice.pauseTalk === true. */
  enabled(): boolean;
  /** chatAvailability.isAvailable(). */
  available(): boolean;
  /** companion.mood.get(), or null before it exists. */
  mood(): MoodView | null;
  /** The active card's personality and description (her own text, not the user's), for the summary. */
  persona(): string;
  /** broadcast('desk:pause-talk', cue). */
  send(cue: PauseTalkCue): void;
  /** The mood view's developer mode. */
  developerMode(): boolean;
  /** companion.mood.pauseTalkChanged(): the developer panel's line. */
  changed?(): void;
  /** Tests only: another small-model call. */
  ask?: PauseTalkAsk;
  /** I-010 互动余额 (CompanionService.budget), read each time; null before the service exists. */
  budget?: PauseTalkHostOptions['budget'];
  host?: Partial<Pick<PauseTalkHostOptions, 'clock' | 'timers' | 'knobs' | 'localDate' | 'random'>>;
}

/**
 * F7 停停说说 for the app. Brain interface (docs/claude/brain-interface.md): its one call is electron/inner-loop/model.ts
 * quickLineWithClaude (haiku, no tools, its own system prompt), the same as the I-023 调度台; nothing else here knows Claude.
 */
export function createPauseTalk(wiring: PauseTalkWiring): PauseTalkHost {
  const safe = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
  return new PauseTalkHost({
    ask: wiring.ask ?? (async (prompt, systemPrompt, signal) => (await quickLineWithClaude(prompt, systemPrompt, signal)).text),
    enabled: wiring.enabled, available: wiring.available, send: wiring.send, developerMode: wiring.developerMode, changed: wiring.changed,
    ...(wiring.budget ? { budget: wiring.budget } : {}),
    now: () => {
      const view = wiring.mood();
      return view?.characterId && view.snapshot && view.parameters ? pauseTalkNow(view, safe(() => wiring.persona(), ''), Date.now()) : null;
    },
    ...wiring.host,
  });
}
