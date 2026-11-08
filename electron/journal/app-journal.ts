// 体验记录 (E2) for the app: the writer, the card observer, the build's commit and the few host moments (start, quit, a setting
// changed through the agent channel, her music tier). electron/main.ts only passes closures it already has and calls these.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentSettingId, AgentSettingValue } from '../../shared/agent-channel';
import type { AppStopCause, LastStop } from '../../shared/app-session';
import type { CharacterCardState } from '../../shared/character-cards';
import type { InnerLoopDiagnostic } from '../../shared/inner-loop';
import { DANCE_TIERS, type JournalInput, type JournalView } from '../../shared/journal';
import type { RpsJournalEntry } from '../rps/host';
import type { FeedJournalEntry } from '../feed-recognition/host';
import { CharacterJournal, innerLoopInput, type JournalHolder, type JournalSink } from './sources';
import { JournalWriter, type JournalFs } from './writer';

/** The commit this build was made from (scripts/build-electron.mjs writes build-info.json next to main.cjs); null when unknown. */
export function readBuildCommit(file: string): string | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { commit?: unknown };
    return typeof value.commit === 'string' && /^[0-9a-f]{7,40}$/.test(value.commit) ? value.commit : null;
  } catch { return null; }
}

export interface AppJournalOptions {
  /** The profile folder; the journal lives in its `journal` subfolder. */
  profileDirectory(): string | null;
  /** AppSettings.experienceJournal. */
  enabled(): boolean;
  /** Card names for the panel's character filter. */
  characters(): Pick<CharacterCardState, 'cards'> | null;
  /** The control window's view changed (debounced here). */
  publish(view: JournalView): void;
  clock?(): number;
  fs?: JournalFs;
  /** Debounce for publish (tests use 0). */
  publishDelayMs?: number;
}

const MUSIC_MIN_GAP_MS = 1_000;

export class AppJournal implements JournalSink {
  readonly writer: JournalWriter;
  private readonly cards: CharacterJournal;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private quitNoted = false;
  private music: { characterId: string; tier: string; at: number } | null = null;
  private readonly holders = new Set<JournalHolder>();
  constructor(private readonly options: AppJournalOptions) {
    this.writer = new JournalWriter({
      directory: () => { const root = options.profileDirectory(); return root ? path.join(root, 'journal') : null; },
      enabled: options.enabled, clock: options.clock, fs: options.fs, changed: () => this.schedulePublish(),
    });
    this.cards = new CharacterJournal(this);
  }

  record(input: JournalInput): unknown { return this.writer.record(input); }
  accepting(): boolean { return this.writer.accepting(); }
  holdBack(holder: JournalHolder): void { this.holders.add(holder); }
  /** Before the switch goes off: a run still being merged (pats) becomes its line now, while it is still on. */
  settle(): void { for (const holder of this.holders) { try { holder.settle(); } catch { /* One holder never blocks the switch. */ } } }

  view(): JournalView {
    const status = this.writer.status();
    let characters: JournalView['characters'] = [];
    try { characters = (this.options.characters()?.cards ?? []).map(card => ({ id: card.id, name: card.name })); } catch { characters = []; }
    return { enabled: status.enabled, entries: this.writer.recent(), characters, failure: !!status.failure, truncatedToday: status.truncatedToday };
  }

  private schedulePublish(): void {
    if (this.publishTimer) return;
    const run = () => { this.publishTimer = null; try { this.options.publish(this.view()); } catch { /* A closed window misses one update. */ } };
    const delay = this.options.publishDelayMs ?? 250;
    if (delay <= 0) { run(); return; }
    this.publishTimer = setTimeout(run, delay);
    this.publishTimer.unref?.();
  }
  /** The switch changed: publish now (and read back the newest lines when it was turned on). */
  async switched(): Promise<JournalView> {
    await this.writer.loadRecent();
    const view = this.view();
    try { this.options.publish(view); } catch { /* Same. */ }
    return view;
  }

  /** After each card change (main.ts syncCharacter) and once at start (that first look only learns the cards). */
  characters(state: Pick<CharacterCardState, 'cards' | 'activeId'> | null | undefined): void { this.cards.observe(state); }

  /**
   * "应用启动", with how the previous run ended (I-022 "关应用也记", electron/app-session/): `lastStop` is the very object her
   * fatigue was given, so the line and her rest use one number. `undefined` (older callers) adds nothing; null: no previous record.
   */
  appStarted(version: string, commit: string | null, characterId: string | null, lastStop?: LastStop | null): void {
    const previous = lastStop === undefined ? {} : lastStop === null ? { stopped: 'unknown' as const }
      : { stopped: lastStop.exact ? 'clean' as const : 'unclean' as const, stoppedAt: lastStop.at, closedMs: lastStop.closedMs,
        ...(lastStop.exact && lastStop.cause ? { cause: lastStop.cause } : {}), ...(lastStop.exact ? {} : { estimated: true as const }),
        ...(lastStop.clockBack ? { clockBack: true as const } : {}) };
    this.record({ type: 'app', characterId, event: 'start', version, commit, ...previous });
  }
  /** Once, at the start of quitting (before-quit, or the window's session-end on shutdown), with how the quit was asked for. */
  appQuitting(version: string, commit: string | null, characterId: string | null, cause?: AppStopCause | null): void {
    if (this.quitNoted) return;
    this.quitNoted = true;
    this.record({ type: 'app', characterId, event: 'quit', version, commit, ...(cause ? { cause } : {}) });
  }

  innerLoop(entry: InnerLoopDiagnostic, characterId: string): void { this.record(innerLoopInput(characterId, entry)); }
  rps(characterId: string, entry: RpsJournalEntry): void { this.record({ type: 'rps', characterId, ...entry }); }
  /** I-019 喂食认图: what came of one accepted picture (categories only). */
  feed(characterId: string, entry: FeedJournalEntry): void { this.record({ type: 'feed', characterId, ...entry }); }
  setting(id: AgentSettingId, previous: AgentSettingValue | null, value: AgentSettingValue | null, via: 'agent' | 'chat', characterId: string | null): void {
    if (previous === value) return;
    this.record({ type: 'setting', characterId, id, previous, value, via });
  }
  /** I-025: Claude did a user-words call (which item, to what, how long the user's words were; never the words). */
  agentWords(use: { tool: string; item: string; value: AgentSettingValue | null; words: number }, characterId: string | null): void {
    this.record({ type: 'agent-words', characterId, tool: use.tool, item: use.item, value: use.value, words: use.words });
  }

  /**
   * The pet window's music tier changed (src/stage/MmdStage.ts onMusicTier). Only a closed tier and a 0..1 score are accepted; a
   * repeat of the same tier, or a change sooner than a second after the last one, is ignored. Returns whether it was kept.
   */
  musicTier(value: unknown, characterId: string | null): boolean {
    if (!characterId || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => key !== 'tier' && key !== 'score')) return false;
    const tier = input.tier;
    if (typeof tier !== 'string' || !(DANCE_TIERS as readonly string[]).includes(tier)) return false;
    const score = typeof input.score === 'number' && Number.isFinite(input.score) ? input.score : null;
    const now = (this.options.clock ?? Date.now)();
    const last = this.music;
    if (last && last.characterId === characterId && (last.tier === tier || now - last.at < MUSIC_MIN_GAP_MS)) return false;
    this.music = { characterId, tier, at: now };
    return !!this.record({ type: 'music', characterId, tier: tier as (typeof DANCE_TIERS)[number], score });
  }

  /**
   * 动作跳变记录 from the pet window (src/stage/motion-glitch.ts): only these fields are passed on, and shared/journal.ts rebuilds the
   * line from closed sets and checked numbers (a bone or morph name of at most 40 plain characters). Returns whether it was kept.
   */
  motionGlitch(value: unknown, characterId: string | null): boolean {
    if (!characterId || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return !!this.record({ type: 'motion', characterId, kind: v.kind, part: v.part, name: v.name, size: v.size, activities: v.activities, fps: v.fps,
      frameMs: v.frameMs, ...(v.kind === 'block' ? { cleared: v.cleared } : {}) } as JournalInput);
  }

  async flush(): Promise<void> {
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
    await this.writer.flush();
  }
}

/** Closures electron/main.ts already has. */
export interface JournalIpcPorts {
  journal: AppJournal;
  enabled(): boolean;
  characterId(): string | null;
  /** The host's single mutation queue (the agent channel's guarded calls go through it too). */
  mutate<T>(run: () => Promise<T>): Promise<T>;
  /** Saves AppSettings.experienceJournal (and tells the windows). */
  persist(value: boolean): Promise<void>;
}

/**
 * The control window's two operations (the agent channel reuses `setExperienceJournal`, electron/agent-channel/bridge.ts).
 * Turning it off first settles what was still being merged while on (a run of pats), then writes "体验记录关闭" and keeps every
 * file; turning it on writes "体验记录开启" and reads the newest lines back. Nothing from while it was off is written later
 * (sources.ts MoodJournal merges nothing while off).
 */
export function registerJournalIpc(register: (method: string, operation: (...args: any[]) => unknown) => void, ports: JournalIpcPorts): void {
  register('getJournal', () => ports.journal.view());
  register('setExperienceJournal', (value: unknown) => ports.mutate(async () => {
    if (typeof value !== 'boolean') throw new Error('体验记录开关不正确。');
    if (ports.enabled() !== value) {
      if (!value) { ports.journal.settle(); ports.journal.record({ type: 'journal', characterId: ports.characterId(), event: 'off' }); }
      await ports.persist(value);
      if (value) ports.journal.record({ type: 'journal', characterId: ports.characterId(), event: 'on' });
    }
    return ports.journal.switched();
  }));
}
