import { quickLineWithClaude } from '../inner-loop/model';
import { WarmLine, type WarmLineOptions } from '../inner-loop/warm-line';
import { MOOD_LABELS, type MoodView } from '../../shared/mood-runtime';
import type { MoodValues } from '../../shared/mood';
import type { ChatActionWord } from '../../shared/chat-actions';
import { DISPOSITIONS, DISPOSITION_IDS, deriveDispositions, type Dispositions } from '../../shared/behaviors/reactions/dispositions';
import { REACTION_KNOBS } from '../../shared/behaviors/reactions/knobs';
import type { MoodReactionPort, ReactionAsk, ReactionPerformed, ReactionPerformer } from '../../shared/behaviors/reactions/interface';
import { readReactionStageReply, type ReactionStageAnswer, type ReactionStageCue } from '../../shared/behaviors/reactions/stage';
import type { ReactionDispositionsView, ReactionSwitchView, ReactionsBroadcast } from '../../shared/behaviors/reactions/views';
import { ReactionHost, type ReactionHostOptions, type ReactionJournalInput, type ReactionNowSource, type ReactionQuiet, type ReactionSensePort } from './host';
import { createReactionPerformers } from './performers';
import { ReactionStore } from './store';

const FATIGUE_WORDS: Readonly<Record<string, string>> = { 'light-drowsy': '有点困', drowsy: '犯困', 'falling-asleep': '快睡着了' };
const SLEEPY = new Set(['light-drowsy', 'drowsy', 'falling-asleep']);
const SLEEPING = new Set(['asleep', 'micro-awake']);

/** The mood host as the reactions use it (electron/mood.ts MoodHost). */
export interface ReactionMoodPort {
  get(): MoodView;
  isTestMoodActive(): boolean;
  setReactionPort(port: MoodReactionPort | null): void;
  reactionBlush(characterId: string, id: string, strength: number, floor?: number): ReactionPerformed;
  lift(lift: { id: string; delta: Partial<MoodValues>; reason: string }, characterId?: string): void;
}

/** What electron/main.ts supplies: closures read only when needed. */
export interface ReactionsWiring {
  directory(): string | null;
  /** The switch's default when the user never chose: on, except the stable channel. */
  defaultEnabled: boolean;
  mood(): ReactionMoodPort | null;
  /** The active card's personality and description (her own text, not the user's). */
  persona(): string;
  petVisible(): boolean;
  available(): boolean;
  /** Her small actions (electron/chat-actions-host.ts ChatActionHost). */
  actions(): { offered(): ChatActionWord[]; perform(word: ChatActionWord): Promise<{ played: boolean; status: string }> } | null;
  /** desk:reaction to the pet window (false when it is not on screen). */
  stage(cue: ReactionStageCue): boolean;
  /**
   * The pet window's webContents id. When given, the stage's answer to each cue (desk:reactionResult, pet window only) is awaited, so the
   * record says what the stage did; without it a sent cue counts as done (tests).
   */
  petSender?(): number | null;
  /** Tests only: how long to wait for that answer (default REACTION_STAGE_ANSWER_MS). */
  stageAnswerMs?: number;
  journal?(entry: ReactionJournalInput): void;
  /** Both views changed: the control window hears it (desk:reactions). */
  broadcast?(view: ReactionsBroadcast): void;
  /** Her reply is running (a chat task in flight): the warm haiku is never started or rebuilt then. */
  chatBusy?(): boolean;
  /** I-040 看一眼、听一下: the senses question on the same haiku call (electron/sense-router/host.ts SenseRouterHost.port). */
  senses?: ReactionSensePort;
  /** Tests only. */
  ask?: ReactionAsk;
  /** Tests only: the warm haiku (default: a WarmLine; none when `ask` is given and this is not). */
  warm?: ReactionWarmPort | null;
  /** Tests only: seams for the default WarmLine (it is then built even when `ask` is given). */
  warmLine?: Partial<WarmLineOptions>;
  performers?: Readonly<Record<string, ReactionPerformer>>;
  host?: Partial<Pick<ReactionHostOptions, 'clock' | 'timers' | 'knobs' | 'localDate' | 'random' | 'table' | 'id'>>;
}
/** The warm haiku as the reactions use it (electron/inner-loop/warm-line.ts WarmLine). */
export interface ReactionWarmPort {
  readonly ready: boolean;
  readonly alive: boolean;
  want(delayMs?: number, reset?: boolean): void;
  ask(prompt: string, signal: AbortSignal): Promise<string>;
  stop(): void;
  dispose(): void;
}
/** After the app starts, the warm haiku is started this much later at the earliest (and only while her reply is not running). */
export const REACTION_WARM_STARTUP_MS = 15_000;
/** How long the host waits for the pet window to say what it did with a cue (the stage answers in the same frame; this only covers a lost message). */
export const REACTION_STAGE_ANSWER_MS = 2_000;
type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

/**
 * I-037 新的反应方式 for the app: the store, the performers, the host, and five fixed IPC operations (reactionResult is the pet window's answer to a cue; getReactions, setReactions,
 * getReactionDispositions, setReactionDispositions; the channel desk:reactions). Brain interface (docs/claude/brain-interface.md):
 * its one call is electron/inner-loop/model.ts quickLineWithClaude (haiku, no tools, its own system prompt).
 */
export function createReactions(wiring: ReactionsWiring) {
  const safe = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
  const store = new ReactionStore({ directory: () => wiring.directory(), defaultEnabled: wiring.defaultEnabled });
  const dispositionsOf = (view: MoodView): { values: Dispositions; stored: boolean; derived: Dispositions } => {
    const derived = deriveDispositions(view.parameters), stored = store.dispositions(view.characterId);
    return { values: stored ?? derived, stored: !!stored, derived };
  };
  const now = (): ReactionNowSource | null => {
    const mood = wiring.mood();
    if (!mood) return null;
    const view = mood.get();
    if (!view?.characterId) return null;
    const phase = view.fatigue?.phase ?? '';
    return { characterId: view.characterId, dispositions: dispositionsOf(view).values, mood: view.snapshot.primary, moodWords: MOOD_LABELS[view.snapshot.primary] ?? '',
      fatigue: FATIGUE_WORDS[phase] ?? '', sleepy: SLEEPY.has(phase), values: { ...view.snapshot.values }, persona: safe(() => wiring.persona(), '') };
  };
  const waiting = new Map<string, (answer: ReactionStageAnswer) => void>();
  const stage = (cue: ReactionStageCue): boolean | Promise<ReactionStageAnswer> => {
    const sent = wiring.stage(cue);
    if (!sent || !wiring.petSender) return sent;
    return new Promise<ReactionStageAnswer>(resolve => {
      const timer = setTimeout(() => { waiting.delete(cue.id); resolve('no-answer'); }, wiring.stageAnswerMs ?? REACTION_STAGE_ANSWER_MS);
      timer.unref?.();
      waiting.set(cue.id, answer => { clearTimeout(timer); waiting.delete(cue.id); resolve(answer); });
    });
  };
  const performers = wiring.performers ?? createReactionPerformers({ mood: () => wiring.mood(), actions: () => wiring.actions(), stage });
  const oneShot: ReactionAsk = wiring.ask ?? (async (prompt, systemPrompt, signal) => (await quickLineWithClaude(prompt, systemPrompt, signal)).text);
  // The warm haiku (I-037, docs/claude/2026-11-07-reactions-warm-haiku.md): only while the switch is on and nothing keeps haiku quiet;
  // started and rebuilt only when her reply is not running. Its call is used whenever it is alive; otherwise a one-off call.
  const warm: ReactionWarmPort | null = wiring.warm !== undefined ? wiring.warm : wiring.ask && !wiring.warmLine ? null : new WarmLine({
    systemPrompt: () => host.systemPrompt, allowed: () => host.on && quiet() === null, busy: () => safe(() => wiring.chatBusy?.() === true, false),
    log: line => { try { console.info('[soft hearts] reactions haiku', line); } catch { /* Best effort. */ } },
    ...wiring.warmLine,
  });
  const quiet = (): ReactionQuiet | null => {
    const mood = wiring.mood();
    if (!mood) return 'unavailable';
    const view = mood.get();
    if (SLEEPING.has(view.fatigue?.phase ?? '')) return 'asleep';
    if (!view.expressions) return 'off';
    if (safe(() => mood.isTestMoodActive(), false)) return 'test-mood';
    if (!safe(() => wiring.petVisible(), false)) return 'hidden';
    if (!safe(() => wiring.available(), false)) return 'unavailable';
    return null;
  };
  const host: ReactionHost = new ReactionHost({
    ask: (prompt, systemPrompt, signal) => warm?.alive && systemPrompt === host.systemPrompt ? warm.ask(prompt, signal) : oneShot(prompt, systemPrompt, signal),
    warm: () => warm?.ready === true,
    store, now, performers, quiet,
    lift: (lift, characterId) => { wiring.mood()?.lift(lift, characterId); },
    journal: entry => { try { wiring.journal?.(entry); } catch { /* the journal never changes a reaction */ } },
    ...(wiring.senses ? { senses: wiring.senses } : {}),
    ...wiring.host,
  });

  /** MoodHost holds the port only while the switch is on (off: it behaves exactly as before). */
  const attach = () => { const mood = wiring.mood(); if (mood) safe(() => mood.setReactionPort(host.on ? host.port : null), undefined); };
  const switchView = (): ReactionSwitchView => ({ enabled: store.enabled, chosen: store.chosen, defaultEnabled: wiring.defaultEnabled, today: host.todayCalls(),
    cap: host.capToday(), base: REACTION_KNOBS.callsPerDay, perChat: REACTION_KNOBS.callsPerChat, max: REACTION_KNOBS.callsPerDayMax });
  const items = DISPOSITION_IDS.map(id => ({ id, label: DISPOSITIONS[id].label, hint: DISPOSITIONS[id].hint }));
  const dispositionsView = (): ReactionDispositionsView => {
    const view = safe(() => wiring.mood()?.get() ?? null, null);
    if (!view?.characterId) return { characterId: null, values: null, stored: false, derived: null, items };
    const d = dispositionsOf(view);
    return { characterId: view.characterId, values: d.values, stored: d.stored, derived: d.derived, items };
  };
  const broadcast = () => { try { wiring.broadcast?.({ switch: switchView(), dispositions: dispositionsView() }); } catch { /* A closed window misses one update. */ } };
  const setEnabled = (value: unknown): ReactionSwitchView => {
    if (typeof value !== 'boolean') throw new Error('新的反应方式开关不正确。');
    store.setEnabled(value);
    host.switched();
    if (host.on) warm?.want(undefined, true); else warm?.stop();
    attach();
    broadcast();
    return switchView();
  };
  /**
   * The current character's six: some or all (0–100 integers), or null for "back to what the card gives". Returns the view, and
   * `before` (what was stored; null: nothing) so the agent channel can offer to undo it.
   */
  const setDispositions = (value: unknown): ReactionDispositionsView & { before: Dispositions | null } => {
    const view = wiring.mood()?.get();
    if (!view?.characterId) throw new Error('还没有角色。');
    let before: Dispositions | null;
    if (value === null) { before = store.dispositions(view.characterId); store.restore(view.characterId, null); }
    else before = store.setDispositions(view.characterId, value, dispositionsOf(view).values).before;
    broadcast();
    return { ...dispositionsView(), before };
  };
  const register = (scopedHost: Register) => {
    scopedHost('getReactions', () => switchView(), false);
    // The pet window's answer to a cue it was sent (what its stage did with it): the pet window only, exactly { id, result }.
    scopedHost('reactionResult', (sender, value) => {
      const reply = readReactionStageReply(value);
      if (!reply || sender !== wiring.petSender?.()) return false;
      const done = waiting.get(reply.id);
      if (!done) return false;
      done(reply.result);
      return true;
    }, false);
    // The switch and the sliders: the control window only (隐私与设置, 角色页); the agent channel calls the same operations.
    scopedHost('setReactions', (_sender, value) => setEnabled(value), true);
    scopedHost('getReactionDispositions', () => dispositionsView(), false);
    scopedHost('setReactionDispositions', (_sender, value) => setDispositions(value), true);
  };
  return {
    host, store, warm, performers, register, switchView, dispositionsView, setEnabled, setDispositions, attach, broadcast,
    load: async () => { await store.load(); attach(); if (host.on) warm?.want(REACTION_WARM_STARTUP_MS); },
    /** The user's message (typed or spoken), the same text Opus gets. Never awaited; nothing runs while the switch is off. */
    userTurn: (id: string, text: unknown) => { try { host.userTurn(id, text); if (host.on) warm?.want(); } catch { /* Never into her chat. */ } },
    /** Every visible delta of her reply to `id` (only the first one matters: haiku starts after her first character). */
    firstChar: (id: string) => { try { host.firstChar(id); } catch { /* Never into her chat. */ } },
    /** True while it gives each message's mood (the 心情调整员 then leaves messages alone). */
    on: () => host.on,
    dispose: () => { safe(() => wiring.mood()?.setReactionPort(null), undefined); host.dispose(); safe(() => warm?.dispose(), undefined); return store.flush(); },
  };
}
