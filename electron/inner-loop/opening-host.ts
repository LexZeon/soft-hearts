/**
 * I-020 #10 接线：她想找你说话时，这次说什么由她挑（docs/claude/2026-11-04-opening-choice.md；挑法和旋钮在
 * shared/behaviors/opening-choice/）。electron/main.ts 的心情回调每次发布都问这里一次 claim()，同一个时机只在第一次见到时定下来。
 *
 * 一次说话时机：
 *  1. 睡着时谁都不说（不挑，InnerLoop.silence：不调模型，次数退回，记作"睡着了"）。
 *  2. 她在聊天里提出的纪念邀请先问（不挑）；代办提议 R20（默认关）照旧排在它后面。
 *  3. 深夜"醒着时提醒一次休息"走内心循环原来那条路（不挑）。
 *  4. 其余的：只看不拿地问一遍此刻有哪些候选（屏幕、声音只在开关开着时才有；小情绪和邀你玩要内心循环开着），交给"她来挑"。
 *     挑这一步 0 次模型调用、不截图、不录音、不花掉小需要或纪念邀请。挑中的再照原来的方式去说。
 *  5. 备选：挑中的做不成（这会儿接不了，或屏幕取不到画面、画面没想出要说的），
 *     在剩下的里再挑一次；还不行就这次不说，次数退回（间隔照算）。最多两次，不会变回固定顺序。
 * 小动作时机（look / motion）不挑，照旧交给内心循环。开口的时机和次数都不在这里定：这里多不出一次机会。
 *
 * I-010 互动余额：第 4 步挑之前，
 * 先按余额掷一次（OpeningBudget.room：余额够就是 1，不够时平滑往下压，很想你、很兴奋可以越过）；没余地就这次不说，次数退回。
 * 挑中说话的那件（她的小情绪、邀你玩、看一看屏幕、聊刚听完的）花一次（按这次时机的编号，只花一次）；这次时机后来没说出口
 * （这里退回、内心循环自己退回、屏幕做不成），余额也退回（主机的 releaseSpeech 那一处）。纪念邀请、代办提议、提醒休息不经过余额。
 * 余额只能让她少说，不能让她多说：没接余额（budget 不给）时和原来一模一样。
 */
import type { MoodCue } from '../../shared/mood';
import type { MoodView } from '../../shared/mood-runtime';
import type { InnerLoopFocus, InnerLoopQuiet } from '../../shared/inner-loop';
import { OpeningChoiceDirector, openingNow } from '../../shared/behaviors/opening-choice/choose';
import { OPENING_CHOICE_KNOBS } from '../../shared/behaviors/opening-choice/knobs';
import type { OpeningCandidateId, OpeningChoice, OpeningChoiceHost, OpeningNow, OpeningWhy } from '../../shared/behaviors/opening-choice/interface';
import type { MoodCueOwner } from './claim';

/** The inner loop surface the opening choice uses (electron/inner-loop/inner-loop.ts InnerLoop). */
export interface OpeningLoop {
  offerOpportunity(cue: unknown, focus?: InnerLoopFocus): boolean;
  canTake(cue: unknown, focus?: InnerLoopFocus): boolean;
  claims(cueId: unknown): boolean;
  asleep(): boolean;
  silence(cue: unknown): boolean;
  restReminderDue(): boolean;
  quietNow(): InnerLoopQuiet;
}

/** What electron/main.ts supplies for one cue. Each is a plain check on what already exists: no capture, no recording, no model call. */
export interface OpeningClaimants {
  /** Her own memorial invitation (TextMemorials.offerOpportunity): takes the cue when she has one to ask. */
  memorial?(cue: MoodCue): boolean;
  /** R20 (off by default): takes the cue as before, right after the memorial. */
  r20?(cue: MoodCue): boolean;
  /** Look, don't take: the screen chat could take this generic speech cue (its switch and a shared screen or camera are on). */
  vision?(cue: MoodCue): boolean;
  /** Look, don't take: a sound line (一起听's pause point, or 声音理解) could take this source cue. */
  ambient?(cue: MoodCue): boolean;
  /** This source cue went to something else: the pause-point candidate is dropped (nothing was spent there). */
  ambientPassed?(cue: MoodCue): void;
}

/** I-010 互动余额, as the opening choice uses it (electron/interaction-budget/host.ts through electron/main.ts). */
export interface OpeningBudget {
  /** How much room she has to speak now (0..1) and one line for the developer "why". */
  room(characterId: string, mood: string): { readonly factor: number; readonly words: string };
  /** She took this cue to speak (`candidate`): spend once per cue id. */
  spend(characterId: string, cueId: string, candidate: Exclude<OpeningCandidateId, 'quiet'>): void;
  /** That cue ended unspoken: give it back (once). */
  refund(characterId: string, cueId: string): void;
}

export interface OpeningHostOptions {
  loop: OpeningLoop;
  /** I-010: omitted, nothing about the budget happens (exactly as before). */
  budget?: OpeningBudget;
  /** The budget's one roll per opportunity (tests inject a seeded random). */
  random?: () => number;
  /** Replaceable as a whole (tests inject a seeded random or the fixed-order fake). */
  chooser?: OpeningChoiceHost;
  /** App setting `innerLoop` and "自动表现": off, there is no small-feeling or invite candidate (#13: no fixed lines either). */
  innerOn(): boolean;
  /** Look, don't take (G1 RpsHost.inviteEligible): an invite to play would be offered now. */
  play?(characterId: string, quiet: boolean): boolean;
  /** I-006: the user is absorbed in something now (UserActivityView.state === 'busy'); she leans toward 这次不说. Omitted: never. */
  busy?(): boolean;
  /** Look, don't take (HerNeedsHost.hasSpeechChance): she has a small need she could speak about now. */
  need?(characterId: string): boolean;
  /** A speech cue that ends without anyone speaking returns its hourly and unanswered quota (MoodHost.releaseSpeech; cooldown stays). */
  releaseSpeech(cue: { readonly id: string; readonly at: number }, characterId: string): void;
  developerMode(): boolean;
  /** The developer view changed (a new "why" line). */
  changed?(): void;
  clock?(): number;
}

interface Decided {
  owner: MoodCueOwner | null;
  readonly cue: MoodCue;
  readonly characterId: string;
  readonly from: 'pause' | 'idle';
  now: OpeningNow | null;
  fellBack: boolean;
  refunded: boolean;
}

const KEEP = 256;
/** A screen fallback is a new short opportunity for the inner loop (same quota and time, its own gate id). */
const FALLBACK_CUE_MS = 3_000;
const UNABLE_WORDS = { capture: '取不到画面', generation: '画面没想出要说的' } as const;

export class OpeningHost {
  private readonly decided = new Map<string, Decided>();
  readonly chooser: OpeningChoiceHost;
  constructor(private readonly options: OpeningHostOptions) { this.chooser = options.chooser ?? new OpeningChoiceDirector(); }

  /** Who takes this cue. Decided on first sight; later publishes of the same cue get the same answer. */
  claim(cue: MoodCue | null | undefined, claimants: OpeningClaimants, view: Pick<MoodView, 'characterId' | 'snapshot' | 'parameters'>): MoodCueOwner | null {
    if (!cue || typeof cue.id !== 'string') return null;
    const known = this.decided.get(cue.id);
    if (known) return known.owner;
    const loop = this.options.loop, characterId = typeof view?.characterId === 'string' ? view.characterId : '';
    const entry: Decided = { owner: null, cue: { ...cue }, characterId, from: cue.source !== undefined ? 'pause' : 'idle', now: null, fellBack: false, refunded: false };
    this.decided.set(cue.id, entry);
    while (this.decided.size > KEEP) this.decided.delete(this.decided.keys().next().value!);
    if (safe(() => loop.claims(cue.id))) return entry.owner = 'inner';
    if (cue.kind === 'speech' && safe(() => loop.asleep())) {
      try { loop.silence(cue); } catch { /* Nobody speaks either way; at worst the quota stays charged. */ }
      this.why(entry, '睡着了', ['睡着时谁都不开口（不挑）']);
      return entry.owner = 'asleep';
    }
    if (safe(() => claimants.memorial?.(cue) === true)) {
      this.why(entry, '纪念邀请', ['她在聊天里提出的纪念邀请，下一次开口先问（不挑）']);
      return entry.owner = 'memorial';
    }
    if (safe(() => claimants.r20?.(cue) === true)) { this.why(entry, '代办提议', ['代办提议（照旧，不挑）']); return entry.owner = 'r20'; }
    if (cue.kind !== 'speech') return entry.owner = safe(() => loop.offerOpportunity(cue)) ? 'inner' : null;
    const innerOn = safe(() => this.options.innerOn());
    if (innerOn && safe(() => loop.restReminderDue()) && safe(() => loop.offerOpportunity(cue, 'rest'))) {
      this.why(entry, '提醒休息', ['深夜你还醒着：提醒一次休息（照原来那条路，不挑）']);
      this.pass(cue, 'inner', claimants);
      return entry.owner = 'inner';
    }
    // I-010: no room in the interaction budget this time → she stays quiet (quota returned, the cooldown stays as always).
    const room = this.room(entry, view);
    if (room && !(this.roll() < room.factor)) {
      this.refund(entry);
      this.settle(entry, 'quiet');
      this.why(entry, this.label('quiet'), [`互动余额：${room.words}`, '这次不说（次数退回）']);
      this.pass(cue, 'quiet', claimants);
      return entry.owner = 'quiet';
    }
    entry.now = this.moment(cue, claimants, characterId, view, innerOn);
    const owner = this.pick(entry, cue, claimants);
    this.pass(cue, owner, claimants);
    return entry.owner = owner;
  }

  /**
   * The screen chat took the cue but could not make a line (ProactiveVision: no frame, or the model gave nothing): the fallback.
   * One more pick among the rest; nothing there or it cannot either → silence, quota returned. A cancellation is not this.
   */
  unable(opportunityId: string, stage: 'capture' | 'generation'): void {
    const entry = this.decided.get(opportunityId);
    if (!entry || entry.owner !== 'vision' || entry.fellBack || !entry.now) return;
    entry.fellBack = true;
    const loop = this.options.loop, now = this.now();
    const cue: MoodCue = { id: `${opportunityId}-b`, kind: 'speech', at: entry.cue.at, until: now + FALLBACK_CUE_MS };
    const innerOn = safe(() => this.options.innerOn()), quiet = safe(() => loop.quietNow().quiet, true);
    const mood = innerOn && safe(() => loop.canTake(cue, 'mood'));
    const play = mood && !quiet && !!this.options.play && safe(() => this.options.play!(entry.characterId, quiet));
    const moment: OpeningNow = { ...entry.now, available: { listen: false, screen: false, mood, play } };
    const second = this.choose(entry.characterId, moment, ['screen']);
    const owner = second ? this.take(second.id, cue, {}) : null;
    const word = `${this.label('screen')}做不成（${UNABLE_WORDS[stage] ?? '做不成'}）`;
    if (second && owner && owner !== 'quiet') {
      // I-010: the screen's spend moves to the fallback cue (the inner loop gives back by that cue's id if it then stays quiet).
      this.budgetRefund(entry.characterId, entry.cue.id);
      this.settle(entry, second.id, cue.id);
      this.why(entry, second.label, [`${word}，备选：${second.label}`, ...second.why, ...this.hush(entry, second.id)], second.weights);
      entry.owner = owner;
      return;
    }
    this.refund(entry);
    this.settle(entry, 'quiet');
    this.why(entry, this.label('quiet'), [second && second.id !== 'quiet' ? `${word}，备选${second.label}也做不成，这次不说（次数退回）` : `${word}，这次不说（次数退回）`,
      ...(second?.id === 'quiet' ? second.why : [])], second?.weights ?? '');
    entry.owner = 'quiet';
  }

  /** Developer panel: newest first; empty outside developer mode. */
  recent(characterId: string): readonly OpeningWhy[] {
    return safe(() => this.options.developerMode()) ? this.chooser.recent(characterId) : [];
  }

  private moment(cue: MoodCue, claimants: OpeningClaimants, characterId: string, view: Pick<MoodView, 'snapshot' | 'parameters'>, innerOn: boolean): OpeningNow {
    const loop = this.options.loop;
    let quiet: InnerLoopQuiet;
    try { quiet = loop.quietNow(); } catch { quiet = { asleep: false, drowsy: false, night: false, quiet: true }; }
    const listen = cue.source !== undefined && safe(() => claimants.ambient?.(cue) === true);
    const screen = cue.source === undefined && safe(() => claimants.vision?.(cue) === true);
    const mood = innerOn && safe(() => loop.canTake(cue, 'mood'));
    const play = mood && !quiet.quiet && !!this.options.play && safe(() => this.options.play!(characterId, quiet.quiet));
    const need = mood && !quiet.quiet && !!this.options.need && safe(() => this.options.need!(characterId));
    let last: { id: OpeningCandidateId; at: number } | null = null;
    try { last = this.chooser.last(characterId); } catch { last = null; }
    const snapshot = view?.snapshot ?? { primary: 'calm', companion: null, boredom: 0, lastInteractionAt: null };
    return openingNow({ available: { listen, screen, mood, play }, snapshot, personality: view?.parameters?.weights, need,
      quiet: { night: quiet.night, drowsy: quiet.drowsy }, last, busy: safe(() => this.options.busy?.() === true) });
  }

  /** She picks; if that cannot be done, one more pick among the rest; then silence. */
  private pick(entry: Decided, cue: MoodCue, claimants: OpeningClaimants): MoodCueOwner {
    const first = this.choose(entry.characterId, entry.now!, []);
    const firstOwner = first ? this.take(first.id, cue, claimants) : null;
    if (first && firstOwner) {
      if (firstOwner === 'quiet') this.refund(entry);
      this.settle(entry, first.id);
      this.why(entry, first.label, firstOwner === 'quiet' ? [...first.why, '这次不说（次数退回）'] : [...first.why, ...this.hush(entry, first.id)], first.weights);
      return firstOwner;
    }
    // The inner loop refused (it already saw the cue): neither of its two can take it now.
    const without: OpeningCandidateId[] = first ? (first.id === 'mood' || first.id === 'play' ? ['mood', 'play'] : [first.id]) : [];
    const second = first ? this.choose(entry.characterId, entry.now!, without) : null;
    const secondOwner = second ? this.take(second.id, cue, claimants) : null;
    const word = first ? `${first.label}这会儿做不成` : '';
    if (second && secondOwner && secondOwner !== 'quiet') {
      this.settle(entry, second.id);
      this.why(entry, second.label, [`${word}，备选：${second.label}`, ...second.why, ...this.hush(entry, second.id)], second.weights);
      return secondOwner;
    }
    this.refund(entry);
    this.settle(entry, 'quiet');
    this.why(entry, this.label('quiet'), [first ? (second && second.id !== 'quiet' ? `${word}，备选${second.label}也做不成，这次不说（次数退回）` : `${word}，这次不说（次数退回）`)
      : '这次不说（次数退回）', ...(second?.id === 'quiet' ? second.why : [])], second?.weights ?? first?.weights ?? '');
    return 'quiet';
  }

  /** Start what was picked, the way it always started. Only the inner loop really starts here; the screen and sound engines act on the owner. */
  private take(id: OpeningCandidateId, cue: MoodCue, claimants: OpeningClaimants): MoodCueOwner | null {
    const loop = this.options.loop;
    if (id === 'listen') return safe(() => claimants.ambient?.(cue) === true) ? 'ambient' : null;
    if (id === 'screen') return safe(() => claimants.vision?.(cue) === true) ? 'vision' : null;
    if (id === 'mood' || id === 'play') return safe(() => loop.offerOpportunity(cue, id)) ? 'inner' : null;
    return 'quiet';
  }

  private choose(characterId: string, now: OpeningNow, without: OpeningCandidateId[]): OpeningChoice | null {
    try { return this.chooser.choose(characterId, now, without); } catch { return null; }
  }

  private pass(cue: MoodCue, owner: MoodCueOwner | null, claimants: OpeningClaimants): void {
    if (cue.source === undefined || owner === 'ambient') return;
    try { claimants.ambientPassed?.(cue); } catch { /* The candidate expires on its own a few minutes later. */ }
  }

  private refund(entry: Decided): void {
    if (entry.refunded) return;
    entry.refunded = true;
    try { this.options.releaseSpeech({ id: entry.cue.id, at: entry.cue.at }, entry.characterId); } catch { /* The quota stays charged; never retried. */ }
    this.budgetRefund(entry.characterId, entry.cue.id);
  }

  /** Who finally does it; a speaking one also spends from the interaction budget (I-010), once per cue id. */
  private settle(entry: Decided, id: OpeningCandidateId, cueId: string = entry.cue.id): void {
    try { this.chooser.settle(entry.characterId, id, this.now()); } catch { /* Bookkeeping never changes who speaks. */ }
    if (id !== 'quiet' && this.options.budget && entry.characterId) {
      try { this.options.budget.spend(entry.characterId, cueId, id); } catch { /* Bookkeeping never changes who speaks. */ }
    }
  }

  /** I-010: the room this opportunity has, or null without a budget (or when it cannot be read: then as before, no extra press). */
  private room(entry: Decided, view: Pick<MoodView, 'snapshot'>): { factor: number; words: string } | null {
    const budget = this.options.budget;
    if (!budget || !entry.characterId) return null;
    try {
      const room = budget.room(entry.characterId, typeof view?.snapshot?.primary === 'string' ? view.snapshot.primary : 'calm');
      return Number.isFinite(room?.factor) ? { factor: Math.min(1, Math.max(0, room.factor)), words: String(room.words ?? '') } : null;
    } catch { return null; }
  }

  private roll(): number {
    try { const value = (this.options.random ?? Math.random)(); return Number.isFinite(value) ? value : 0; } catch { return 0; }
  }

  private budgetRefund(characterId: string, cueId: string): void {
    if (!this.options.budget || !characterId) return;
    try { this.options.budget.refund(characterId, cueId); } catch { /* Bookkeeping never changes who speaks. */ }
  }

  private why(entry: Decided, label: string, why: readonly string[], weights = ''): void {
    if (!entry.characterId || !safe(() => this.options.developerMode())) return;
    try {
      this.chooser.note(entry.characterId, { at: Math.floor(this.now()), from: entry.from, label, why: [...why], weights });
      this.options.changed?.();
    } catch { /* Diagnostics never change who speaks. */ }
  }

  private label(id: OpeningCandidateId): string { return OPENING_CHOICE_KNOBS.candidates[id].label; }

  /** Her small feeling at night or drowsy: the inner loop's quiet rules still hold (no line of her own but the rest reminder). */
  private hush(entry: Decided, id: OpeningCandidateId): string[] {
    if (id !== 'mood') return [];
    const moments = entry.now?.moments ?? [];
    return moments.includes('night') ? ['深夜：她自己的话只剩提醒休息，这次只会动一动、看你一眼或不做']
      : moments.includes('drowsy') ? ['有点困：这次只会动一动、看你一眼或不做'] : [];
  }

  private now(): number { const value = (this.options.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); }
}

function safe(check: () => boolean, fallback = false): boolean {
  try { return check() === true; } catch { return fallback; }
}
