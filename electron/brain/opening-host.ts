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
import type { MoodCue } from '../../shared/foundation/mood';
import type { MoodView } from '../../shared/mood';
import type { InnerLoopQuiet } from '../../shared/initiative';
import { OpeningChoiceDirector, openingNow } from '../../shared/behaviors/opening-choice/choose';
import { OPENING_CHOICE_KNOBS } from '../../shared/behaviors/opening-choice/knobs';
import type { OpeningCandidateId, OpeningChoice, OpeningChoiceHost, OpeningNow, OpeningWhy } from '../../shared/behaviors/opening-choice/interface';
import type { MoodCueOwner } from '../initiative';
import type { PresenceView } from '../../shared/senses';
import { HeldIntents } from '../../shared/behaviors/user-activity/held';
import type { HeldIntent, HeldKind } from '../../shared/senses';
import { greetChance } from '../../shared/behaviors/user-activity/presence';
import type { MoodTendency } from '../../shared/foundation/mood';
import type { SpeechCueOutcome, SpeechCueReason } from '../../shared/voice';

import type { OpeningBudget, OpeningClaimants, OpeningHostOptions } from './opening-ports';
export type { OpeningBudget, OpeningClaimants, OpeningHostOptions, OpeningLoop } from './opening-ports';

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
/** I-066: the greeting opportunity she asked for on a return counts this long (the mood clock publishes it at once). */
const GREETING_MS = 60_000;
const HELD_WORDS: Partial<Record<SpeechCueReason, string>> = { away: '你不在', meeting: '你在开会', unsure: '拿不准你在不在', 'not-present': '不知道你在不在' };
const HELD_KIND_WORDS: Readonly<Record<HeldKind, string>> = { keepsake: '她留给你的那件', need: '她的小需要', talk: '想找你说说话' };

export class OpeningHost {
  private readonly decided = new Map<string, Decided>();
  readonly chooser: OpeningChoiceHost;
  /** I-066: the one intent held while the user could not be interrupted. */
  readonly held = new HeldIntents();
  private deliveries = 0;
  /** I-066: the return episode the greeting was already tried for, and the greeting cue window it opened. */
  private backSeen = false;
  private greeting: { until: number } | null = null;
  /** 松绑: the speech opportunity her impulse asked for (electron/initiative/impulse/host.ts); its soft balance was already rolled there. */
  private reach: { until: number } | null = null;
  constructor(private readonly options: OpeningHostOptions) { this.chooser = options.chooser ?? new OpeningChoiceDirector(); }

  /**
   * 松绑: the impulse is about to ask the mood clock for one speech opportunity (MoodHost.welcomeAttention: the speech interval and the
   * hourly cap hold as always). The next speech cue within `ms` skips the budget roll here (the impulse already pressed it by the same
   * budget); every floor and everything after it is unchanged. `cancelReach` when the mood clock refused.
   */
  expectReach(ms = GREETING_MS): void { this.reach = { until: this.now() + Math.max(0, Math.min(GREETING_MS, ms)) }; }
  cancelReach(): void { this.reach = null; }

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
    // I-066 你现在方便吗: "no" (away, a meeting or call, locked, not known) → nobody speaks and no model is called; what she wanted to
    // bring up is held (a kind, never words) with this cue's quota. A listen-together pause point keeps its own rules; only a meeting stops it.
    const presence = cue.kind === 'speech' ? this.presenceNow() : null;
    // I-188: a moment the local rules recognised asked for this very cue (electron/initiative/moments/); never held as an intent (the moment waits itself).
    let moment: ReturnType<NonNullable<OpeningClaimants['moment']>> = null;
    try { moment = cue.kind === 'speech' && cue.source === undefined ? claimants.moment?.(cue) ?? null : null; } catch { moment = null; }
    if (moment) return entry.owner = this.momentTake(entry, cue, moment, presence, view);
    if (presence && presence.interrupt === 'no' && (cue.source === undefined || presence.presence === 'meeting')) {
      if (presence.lookWanted) { try { this.options.presence?.look?.(); } catch { /* No look: the cue is held all the same. */ } }
      if (cue.source !== undefined) {
        this.refund(entry);
        this.note(entry.characterId, 'unspoken', 'meeting');
        this.why(entry, this.label('quiet'), ['你在开会：一起听的这一句也不出声（次数退回）']);
      } else this.holdCue(entry, presence);
      this.pass(cue, 'held', claimants);
      return entry.owner = 'held';
    }
    // I-136: her answer to a touch a moment ago (the brain asked for this very cue); refused by the inner loop → quiet, quota back.
    if (cue.kind === 'speech' && cue.source === undefined && safe(() => claimants.touch?.(cue) === true)) {
      if (safe(() => loop.offerOpportunity(cue, 'touch'))) {
        this.why(entry, '回应你碰她', ['你刚碰了她，她自己决定说点什么（不挑，不走互动余额）']);
        return entry.owner = 'inner';
      }
      this.refund(entry);
      this.why(entry, this.label('quiet'), ['你刚碰了她，她想回应，但这会儿说不了（次数退回）']);
      return entry.owner = 'quiet';
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
    // I-066: a held intent comes first at the first opening chance the user can be spoken to (the old cue's quota goes back; this one's is spent).
    if (presence && cue.source === undefined) {
      const now = this.now(), held = this.held.peek(now);
      if (held && held.characterId === characterId && !safe(() => loop.quietNow().quiet, true)) {
        const owner = this.bringUp(held, cue, innerOn);
        if (owner) {
          this.held.take(now);
          this.releaseHeld(held);
          this.spendFor(characterId, cue.id, held.kind === 'keepsake' && owner === 'inner' ? 'keepsake' : 'mood');
          this.note(characterId, 'delivered', presence.presence === 'back' ? 'back' : 'present');
          this.why(entry, '留着的话', [presence.presence === 'back' ? '你回来了：先说你不在时她想说的那件（不挑）' : '你又方便了：先说留着的那件（不挑）']);
          this.pass(cue, owner, claimants);
          return entry.owner = owner;
        }
      }
      // I-066: the greeting she asked for when the user came back from a long absence (her own words, or only a look: the inner loop decides).
      if (this.greeting && now < this.greeting.until && presence.presence === 'back' && innerOn) {
        this.greeting = null;
        if (safe(() => loop.offerOpportunity(cue, 'mood'))) {
          this.spendFor(characterId, cue.id, 'mood');
          this.why(entry, '你回来了', ['你离开很久刚回来：照她的性格招呼你一下（不挑）']);
          this.pass(cue, 'inner', claimants);
          return entry.owner = 'inner';
        }
      }
    }
    // 松绑: the opportunity her impulse asked for already rolled the same budget (once is enough).
    const reached = !!this.reach && cue.source === undefined && this.now() < this.reach.until;
    if (reached) this.reach = null;
    // I-010: no room in the interaction budget this time → she stays quiet (quota returned, the cooldown stays as always).
    const room = reached ? null : this.room(entry, view);
    if (room && !(this.roll() < room.factor)) {
      this.refund(entry);
      this.settle(entry, 'quiet');
      this.note(characterId, 'unspoken', 'budget');
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
   * I-066, the existing one-second tick: a held intent past its time is dropped (quota back); a held intent is brought up as soon as
   * the user can be spoken to (a short opportunity of its own for the inner loop, with the held cue's quota: nothing extra is spent);
   * and on a return from a long absence with nothing held, the greeting roll (by personality) may ask the mood clock for one opportunity.
   */
  tick(): void {
    if (!this.options.presence) return;
    const now = this.now();
    const expired = this.held.expired(now);
    if (expired) { this.releaseHeld(expired); this.note(expired.characterId, 'expired', 'too-long'); }
    const presence = this.presenceNow();
    if (!presence) return;
    const back = presence.presence === 'back';
    if (this.greeting && now >= this.greeting.until) this.greeting = null;
    const held = this.held.peek(now);
    if (held) {
      const current = this.currentCharacter();
      if (current !== null && current !== held.characterId) { this.held.clear(); this.releaseHeld(held); this.note(held.characterId, 'dropped', 'character'); return; }
      if (presence.interrupt === 'no') { if (presence.lookWanted) { try { this.options.presence?.look?.(); } catch { /* Next time. */ } } return; }
      if (back) this.backSeen = true; // the return is answered by the held line: no greeting on top of it
      this.deliver(held, presence, now);
      return;
    }
    if (!back) { this.backSeen = false; return; }
    if (this.backSeen) return;
    this.backSeen = true;
    let personality: Partial<Record<MoodTendency, number>> | null = null;
    try { personality = this.options.presence?.personality?.() ?? null; } catch { personality = null; }
    const chance = greetChance(presence, personality);
    if (chance <= 0 || !(this.roll() < chance) || !this.options.presence?.welcome) return;
    const characterId = this.currentCharacter() ?? '';
    // Set before asking: the mood clock publishes the new cue at once, and claim() must already know it is the greeting.
    this.greeting = { until: now + GREETING_MS };
    if (safe(() => this.options.presence!.welcome!())) { if (characterId) this.note(characterId, 'greet', 'back'); }
    else this.greeting = null;
  }

  /** The held one, brought up now through a short opportunity of its own (same quota: the held cue's). */
  private deliver(held: HeldIntent, presence: PresenceView, now: number): void {
    const loop = this.options.loop;
    if (safe(() => loop.asleep()) || safe(() => loop.quietNow().quiet, true)) return; // the night stays as it is: held until it expires
    const cue: MoodCue = { id: `${held.cue.id}-h${++this.deliveries}`, kind: 'speech', at: held.cue.at, until: now + FALLBACK_CUE_MS };
    if (!safe(() => loop.canTake(cue, 'mood'))) return; // not now (typing, hidden, a line out): the next second
    const innerOn = safe(() => this.options.innerOn());
    const owner = this.bringUp(held, cue, innerOn);
    if (!owner) return;
    this.held.take(now);
    this.spendFor(held.characterId, cue.id, held.kind === 'keepsake' ? 'keepsake' : 'mood');
    this.note(held.characterId, 'delivered', presence.presence === 'back' ? 'back' : 'present');
    if (held.characterId && safe(() => this.options.developerMode())) {
      try {
        this.chooser.note(held.characterId, { at: Math.floor(now), from: 'idle', label: '留着的话',
          why: [presence.presence === 'back' ? '你回来了：先说你不在时她想说的那件（不挑，用当初那一次的次数）' : '你又方便了：先说留着的那件（不挑，用当初那一次的次数）'], weights: '' });
        this.options.changed?.();
      } catch { /* Diagnostics never change who speaks. */ }
    }
  }

  /**
   * I-188: a moment's cue. The user cannot be spoken to → quiet (quota back; the moment retries itself); the interaction budget is rolled
   * unless it is a promised reminder; then the inner loop with focus 'moment' (refused → quiet, quota back). Spends as her own 'mood' line.
   */
  private momentTake(entry: Decided, cue: MoodCue, moment: NonNullable<ReturnType<NonNullable<OpeningClaimants['moment']>>>, presence: PresenceView | null,
    view: Pick<MoodView, 'snapshot'>): MoodCueOwner {
    const put = (outcome: 'inner' | 'quiet' | 'budget' | 'held') => { try { moment.put(outcome); } catch { /* bookkeeping only */ } };
    const quiet = (outcome: 'quiet' | 'budget' | 'held', words: string): MoodCueOwner => { this.refund(entry); put(outcome); this.why(entry, this.label('quiet'), [words]); return 'quiet'; };
    if (presence && presence.interrupt === 'no') return quiet('held', '她认出的时刻：你这会儿不方便，先不说（次数退回）');
    const room = moment.budget ? this.room(entry, view) : null;
    if (room && !(this.roll() < room.factor)) { this.note(entry.characterId, 'unspoken', 'budget'); return quiet('budget', `她认出的时刻；互动余额：${room.words}，这次不说（次数退回）`); }
    if (!safe(() => this.options.innerOn()) || !safe(() => this.options.loop.offerOpportunity(cue, 'moment'))) return quiet('quiet', '她认出的时刻，这会儿说不了（次数退回）');
    if (moment.budget) this.settle(entry, 'mood');
    put('inner');
    this.why(entry, '她认出的时刻', [moment.budget ? '本机认出一个时刻，她自己决定说不说（走互动余额）' : '到点的约定提醒（不走互动余额）']);
    return 'inner';
  }

  /** Bring a held intent up on this cue: her keepsake or special-day line if that is what she held and still holds it, else her own words. */
  private bringUp(held: HeldIntent, cue: MoodCue, innerOn: boolean): MoodCueOwner | null {
    if (!innerOn) return null;
    const loop = this.options.loop;
    if (held.kind === 'keepsake') {
      let mode: 'write' | 'tell' | null = null;
      try { mode = this.options.keepsake?.peek(held.characterId) ?? null; } catch { mode = null; }
      if (mode === 'tell' && safe(() => loop.offerOpportunity(cue, 'keepsake'))) return 'inner';
    }
    return safe(() => loop.offerOpportunity(cue, 'mood')) ? 'inner' : null;
  }

  /** "no": hold what she wanted to bring up (a kind only), keeping this cue's quota for when it is said. */
  private holdCue(entry: Decided, presence: PresenceView): void {
    const characterId = entry.characterId, now = this.now();
    if (!characterId) { this.refund(entry); return; }
    let kind: HeldKind = 'talk';
    try { if (this.options.keepsake?.peek(characterId) === 'tell') kind = 'keepsake'; } catch { /* talk */ }
    if (kind === 'talk') { try { if (this.options.need?.(characterId) === true) kind = 'need'; } catch { /* talk */ } }
    const intent: HeldIntent = { kind, characterId, cue: { id: entry.cue.id, at: entry.cue.at }, since: now };
    const dropped = this.held.hold(intent, now);
    const reason: SpeechCueReason = presence.presence === 'meeting' ? 'meeting'
      : presence.why === 'look-unknown' || presence.why === 'looking' ? 'unsure' : presence.why === 'not-known' ? 'not-present' : 'away';
    if (dropped === intent) {
      // A more important one is already held: this cue goes back as it is.
      this.refund(entry);
      this.note(characterId, 'dropped', 'replaced');
    } else {
      // The cue is held (its quota stays spent for when it is said); the chooser and the budget are not touched.
      entry.refunded = true;
      this.note(characterId, 'held', reason);
      if (dropped) { this.releaseHeld(dropped); this.note(dropped.characterId, 'dropped', 'replaced'); }
    }
    this.why(entry, '留着', [`${HELD_WORDS[reason] ?? '你这会儿不方便'}：这次不说，也不调模型；想说的先留着（${HELD_KIND_WORDS[kind]}）`]);
  }

  private presenceNow(): PresenceView | null {
    const port = this.options.presence;
    if (!port) return null;
    try { const view = port.view(); return view && typeof view.interrupt === 'string' ? view : null; } catch { return null; }
  }

  private currentCharacter(): string | null {
    try { const id = this.options.presence?.characterId?.(); return typeof id === 'string' && id ? id : null; } catch { return null; }
  }

  private releaseHeld(held: HeldIntent): void {
    try { this.options.releaseSpeech(held.cue, held.characterId); } catch { /* The quota stays charged; never retried. */ }
  }

  /** The held line's spend from the interaction budget (I-010), by the cue it is said on. */
  private spendFor(characterId: string, cueId: string, id: Exclude<OpeningCandidateId, 'quiet'>): void {
    try { this.chooser.settle(characterId, id, this.now()); } catch { /* Bookkeeping never changes who speaks. */ }
    if (!this.options.budget || !characterId) return;
    try { this.options.budget.spend(characterId, cueId, id); } catch { /* Bookkeeping never changes who speaks. */ }
  }

  private note(characterId: string, outcome: SpeechCueOutcome, reason: SpeechCueReason): void {
    if (!characterId) return;
    try { this.options.journal?.({ characterId, outcome, why: reason }); } catch { /* The journal never changes who speaks. */ }
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
    const owner = second ? this.take(second.id, cue, {}, entry.characterId) : null;
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
    this.note(entry.characterId, 'unspoken', 'unable');
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
    // I-050: her folder's keepsake (write one, or say a light line about the one she holds): never in the quiet hours.
    let keepsakeMode: 'write' | 'tell' | null = null;
    if (!quiet.quiet && this.options.keepsake) { try { keepsakeMode = this.options.keepsake.peek(characterId); } catch { keepsakeMode = null; } }
    let last: { id: OpeningCandidateId; at: number } | null = null;
    try { last = this.chooser.last(characterId); } catch { last = null; }
    const snapshot = view?.snapshot ?? { primary: 'calm', companion: null, boredom: 0, lastInteractionAt: null };
    // 'tell' needs the inner loop to be able to take the cue (it speaks through it); 'write' does not.
    const keepsake = keepsakeMode === 'write' || (keepsakeMode === 'tell' && mood);
    // I-086: she hands you something only when her own line can be said (the inner loop takes the cue) and never in the quiet hours.
    let give: { readonly leans: readonly { readonly text: string; readonly factor: number }[] } | null = null;
    if (mood && !quiet.quiet && this.options.give) { try { give = this.options.give.peek(characterId); } catch { give = null; } }
    // 松绑: her urge's factor on each candidate (merged with the give host's own hormone leans).
    let urge: OpeningNow['leans'] | null = null;
    if (this.options.leans) { try { urge = this.options.leans(characterId); } catch { urge = null; } }
    const leans: Partial<Record<OpeningCandidateId, { text: string; factor: number }[]>> = {};
    for (const [id, list] of Object.entries(urge ?? {}) as [OpeningCandidateId, readonly { text: string; factor: number }[]][]) if (Array.isArray(list)) leans[id] = [...list];
    if (give?.leans.length) leans.give = [...give.leans, ...(leans.give ?? [])];
    return openingNow({ available: { listen, screen, mood, play, ...(keepsake ? { keepsake: true } : {}), ...(give ? { give: true } : {}) }, snapshot, personality: view?.parameters?.weights, need,
      quiet: { night: quiet.night, drowsy: quiet.drowsy }, last, gift: keepsakeMode === 'tell', ...(Object.keys(leans).length ? { leans } : {}),
      // I-006 / I-066: busy is "gently" (the busy lean), never a stop; the shared judgment says so when there is no separate reader.
      busy: safe(() => this.options.busy ? this.options.busy() === true : this.presenceNow()?.presence === 'busy') });
  }

  /** She picks; if that cannot be done, one more pick among the rest; then silence. */
  private pick(entry: Decided, cue: MoodCue, claimants: OpeningClaimants): MoodCueOwner {
    const first = this.choose(entry.characterId, entry.now!, []);
    const firstOwner = first ? this.take(first.id, cue, claimants, entry.characterId) : null;
    if (first && firstOwner) {
      if (firstOwner === 'quiet') {
        this.refund(entry);
        // I-066: why she let it pass, closed (busy → she held back; night or drowsy; or simply her choice).
        const moments = entry.now?.moments ?? [];
        this.note(entry.characterId, 'unspoken', moments.includes('busy') ? 'busy-declined' : moments.includes('night') || moments.includes('drowsy') ? 'night' : 'chose-not');
      }
      this.settle(entry, first.id);
      this.why(entry, first.label, firstOwner === 'quiet' ? [...first.why, '这次不说（次数退回）'] : [...first.why, ...this.hush(entry, first.id)], first.weights);
      return firstOwner;
    }
    // The inner loop refused (it already saw the cue): neither of its two can take it now.
    const without: OpeningCandidateId[] = first ? (first.id === 'mood' || first.id === 'play' || first.id === 'give' ? ['mood', 'play', 'give'] : [first.id]) : [];
    const second = first ? this.choose(entry.characterId, entry.now!, without) : null;
    const secondOwner = second ? this.take(second.id, cue, claimants, entry.characterId) : null;
    const word = first ? `${first.label}这会儿做不成` : '';
    if (second && secondOwner && secondOwner !== 'quiet') {
      this.settle(entry, second.id);
      this.why(entry, second.label, [`${word}，备选：${second.label}`, ...second.why, ...this.hush(entry, second.id)], second.weights);
      return secondOwner;
    }
    this.refund(entry);
    this.settle(entry, 'quiet');
    this.note(entry.characterId, 'unspoken', second?.id === 'quiet' ? 'chose-not' : 'unable');
    this.why(entry, this.label('quiet'), [first ? (second && second.id !== 'quiet' ? `${word}，备选${second.label}也做不成，这次不说（次数退回）` : `${word}，这次不说（次数退回）`)
      : '这次不说（次数退回）', ...(second?.id === 'quiet' ? second.why : [])], second?.weights ?? first?.weights ?? '');
    return 'quiet';
  }

  /** Start what was picked, the way it always started. Only the inner loop really starts here; the screen and sound engines act on the owner. */
  private take(id: OpeningCandidateId, cue: MoodCue, claimants: OpeningClaimants, characterId = ''): MoodCueOwner | null {
    const loop = this.options.loop;
    if (id === 'keepsake') {
      // I-050: the quiet writing starts (the cue is hers and stays spent; nothing is shown), or the light line about a keepsake she holds.
      const keepsake = this.options.keepsake;
      if (!keepsake) return null;
      let mode: 'write' | 'tell' | null = null;
      try { mode = keepsake.peek(characterId); } catch { mode = null; }
      if (mode === 'tell') return safe(() => loop.offerOpportunity(cue, 'keepsake')) ? 'inner' : null;
      if (mode === 'write') return safe(() => keepsake.write(characterId, { id: cue.id, at: cue.at })) ? 'keepsake' : null;
      return null;
    }
    // I-086: her own line as she hands you something (the inner loop, focus 'give': same quota, same bubble and archive).
    if (id === 'give') return this.options.give && safe(() => loop.offerOpportunity(cue, 'give')) ? 'inner' : null;
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
    if (id === 'keepsake') {
      // I-050: counts only (how many she left, how many are still unsaid), never a name or a word of it.
      try { const line = this.options.keepsake?.counts?.(entry.characterId); return line ? [line] : []; } catch { return []; }
    }
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
