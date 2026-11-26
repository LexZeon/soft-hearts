// I-188: the moments she recognises locally and then may speak about
// through the existing proactive path. On the one-second clock (no timer of its own) it:
//  1. notes tonight's last active minute (#4 learns the usual bedtime: numbers only);
//  2. recognises at most one moment at a time: a reminder whose time came (#13), a late night past the usual bedtime (#4), something on the
//     screen while watching together (#9), out of a full-screen program in Unbound (#18), the first meeting of the day (#2), her goodnight
//     (#11), back at the seat after a short absence (#3). Each moment
//     is only information handed to her (shared/behaviors/moments/prompt.ts); nothing here plays a reaction or words one for her;
//  3. asks the mood clock for one speech opportunity (MoodHost.welcomeAttention: its interval and hourly cap hold; a promised reminder uses
//     promiseAttention: only the hard state holds) after its own gate (never while typing, in a call, away, asleep or hidden: momentGate);
//  4. the opening choice gives that very cue to the inner loop with focus 'moment' (claims → put), rolling the interaction budget except
//     for a reminder; the inner loop's haiku decides with the moment line in its prompt, through the one proactive-speech gate;
//  5. one journal line per moment when it ends (spoke / quiet / expired / skipped, with a closed why), never a word.
import { randomUUID } from 'node:crypto';
import type { PresenceView } from '../../../shared/senses';
import { eveningNightKey, isNightMinute, lateNight, usualBedtime } from '../../../shared/behaviors/moments/bedtime';
import { momentGate, type Moment, type MomentFacts, type MomentKind, type MomentOutcome, type MomentWhy, type PoseMomentCandidate, type ScreenEvent, type ScreenMomentEvent } from '../../../shared/behaviors/moments/interface';
import { MOMENT_KNOBS, type MomentKnobs } from '../../../shared/behaviors/moments/knobs';
import { momentPromptLine } from '../../../shared/behaviors/moments/prompt';
import { backAtSeat, firstToday, FullscreenTracker, momentDayKey, previousEveningKey, screenMoment } from '../../../shared/behaviors/moments/recognise';
import { parseReminderRequest } from '../../../shared/behaviors/moments/reminder-parse';
import type { AlarmEvent } from '../../../shared/behaviors/alarms/interface';
import type { MomentStateStore } from './state-store';
import type { ReminderStore } from './reminder-store';
import type { HerAlarms } from './alarms';

/** Moments that are also events her alarms may wait for (I-195). */
const ALARM_OF_MOMENT: Readonly<Partial<Record<MomentKind, AlarmEvent>>> = { 'late-night': 'late-night', 'first-today': 'first-today', 'fullscreen-back': 'fullscreen-back', sitting: 'sitting' }; // sitting: I-189's pose moment (the keyboard stretch in HerAlarms.tick also raises it)
const ALARM_OF_SCREEN: Readonly<Partial<Record<ScreenMomentEvent, AlarmEvent>>> = { error: 'screen-error', 'game-over': 'game-over', win: 'win', 'download-done': 'download-done', 'video-end': 'video-end' };

/** One closed journal line (shared/initiative/journal-entries.ts 'moment'). */
export interface MomentJournalRow { characterId: string; kind: MomentKind; outcome: MomentOutcome; why?: MomentWhy; screen?: ScreenMomentEvent }

export interface MomentHostPorts {
  clock?(): number;
  random?(): number;
  createId?(): string;
  knobs?: MomentKnobs;
  characterId(): string | null;
  localMinute(wallMs: number): number;
  /** The inner loop's switch and 自动表现 on. */
  enabled(): boolean;
  /** The user is typing (userInputUntil) or a chat turn is under way. */
  typing(): boolean;
  /** A voice call with her, or the presence judgment's meeting (a call on the computer). */
  call(): boolean;
  /** She is asleep (the inner loop's own reading). */
  asleep(): boolean;
  /** Her window is on screen (or she is out in Unbound and not covered). */
  visible(): boolean;
  presence(): PresenceView | null;
  /** Seconds since the last key or mouse input (null: not known: the 「知道你是不是在忙」 switch off). */
  idleSeconds(): number | null;
  lastInteractionAt(): number | null;
  /** The inner loop's rest-reminder night (innerLoopNightKey) and whether its one reminder was already spent. */
  nightKey(wallMs: number): string;
  restUsed(night: string): boolean;
  state: MomentStateStore;
  reminders?: ReminderStore;
  /** One speech opportunity now: 'capped' (the welcome rules) or 'promise' (a reminder: only the hard state). True: the cue was made. */
  askSpeech(mode: 'capped' | 'promise'): boolean;
  /** #9: 一起看 is on (screen sharing and the dialogue, no 别看). Only then is a screen event read at all. */
  watching?(): boolean;
  /** #9: the frame describer's last event word for this character (null unless watching together). */
  screen?(characterId: string): { event: ScreenEvent; at: number; describedAt: number } | null;
  /** #18: Unbound's reading (null: not in Unbound). */
  unbound?(): { unbound: boolean; fullscreen: boolean } | null;
  /** #11: her fatigue phase is drowsy or falling asleep (not asleep). */
  drowsy?(): boolean;
  /** I-189: a fact the local pose watchers noticed (slumped, staring, sitting long); taking it counts it. Null: nothing now or sensing off. */
  pose?(now: number): PoseMomentCandidate | null;
  /** I-195: her own alarms (the switch on the user profile page; the store is the same file as the reminders). */
  alarms?: HerAlarms;
  /** I-195: the mood moments that happened lately (a kiss, a hug: objects, newest last); each object is read once. */
  closeMoments?(): readonly { readonly kind: string }[];
  /**
   * I-203: a kiss or a hug from her reply was interrupted (electron/unbound/close-cut.ts): its facts wait for ONE immediate turn. Taken only
   * while this host's gate is open (nobody typing, no chat turn under way, ...); `settled` says whether that turn happened.
   */
  closeCut?: { readonly waiting: boolean; take(characterId?: string): { id: number; line: string } | null; live(id: number): boolean; settled(id: number, happened: boolean): void };
  journal?(row: MomentJournalRow): void;
}

interface Pending {
  moment: Moment;
  nextTryAt: number;
  lastWhy: MomentWhy | null;
  /** 'offered': the inner loop owns the cue (cueId) and tells done(). */
  phase: 'waiting' | 'offered';
  cueId: string | null;
  offeredAt: number;
}

/** What the opening choice gets for the cue it asked about (claims): whether to roll the budget, and where to say how it went. */
export interface MomentClaim { readonly budget: boolean; put(outcome: 'inner' | 'quiet' | 'budget' | 'held'): void }

const SAVE_EVERY_MS = 60_000;
/** The inner loop answers within its own 60 s request; past this the offer is taken as not said. */
const OFFERED_MS = 90_000;

export class MomentHost {
  private pending: Pending | null = null;
  private asking: Pending | null = null;
  private outcome: 'inner' | 'quiet' | 'budget' | 'held' | null = null;
  private claimed = false;
  private readonly fullscreen: FullscreenTracker;
  private lastScreenAt = -Infinity;
  private lastScreenSpoke = -Infinity;
  private screenDay = { day: '', count: 0 };
  private seenInFullscreen: ScreenMomentEvent | null = null;
  private lastFullscreen = -Infinity;
  private lastBack = -Infinity;
  private backHandled = false;
  private lastSave = -Infinity;
  private lastAlarmScreenAt = -Infinity;
  private readonly closeSeen = new WeakSet<object>();
  private closeStarted = false;
  private readonly knobs: MomentKnobs;

  constructor(private readonly ports: MomentHostPorts) {
    this.knobs = ports.knobs ?? MOMENT_KNOBS;
    this.fullscreen = new FullscreenTracker(this.knobs);
  }

  // ---------------------------------------------------------------- the clock

  tick(): void {
    const now = this.now();
    const characterId = this.read(() => this.ports.characterId(), null);
    if (!characterId) { if (this.pending) this.end(this.pending, 'skipped', 'switch'); return; }
    const localMinute = this.read(() => this.ports.localMinute(now), NaN);
    const active = this.active(now);
    if (active && Number.isFinite(localMinute) && isNightMinute(localMinute)) this.ports.state.noteActive(eveningNightKey(now, localMinute), localMinute);
    if (now - this.lastSave >= SAVE_EVERY_MS) { this.lastSave = now; try { this.ports.state.save(); } catch { /* next minute */ } }
    const watching = this.read(() => this.ports.watching?.() === true, false);
    const fullscreenMinutes = this.fullscreen.update(this.read(() => this.ports.unbound?.() ?? null, null), now);
    if (this.fullscreen.inFront) { const seen = this.screenNow(characterId, now); if (seen) this.seenInFullscreen = seen.event; }
    const backMinutes = this.backEpisode();
    this.alarmEvents(characterId, now, active, backMinutes);
    const pending = this.pending;
    if (pending) {
      if (pending.moment.characterId !== characterId) return this.end(pending, 'skipped', 'switch');
      if (now >= pending.moment.until) return this.end(pending, 'expired', pending.lastWhy ?? 'cap');
      if (pending.moment.kind === 'her-alarm' && pending.moment.reminderId) {
        // I-195: the switch turned off, or she/the user cancelled it, even after the offer went to the inner loop: it does not speak (done() then finds nothing).
        if (!this.read(() => this.ports.alarms?.on === true, false)) return this.end(pending, 'skipped', 'switch');
        if (pending.phase === 'offered' && this.read(() => this.ports.alarms?.keep(characterId, pending.moment.reminderId!, now) ?? null, null) === 'cancelled') return this.end(pending, 'cancelled', 'user');
      }
      if (pending.phase === 'offered') { if (now - pending.offeredAt > OFFERED_MS) this.notSaid(pending, now); return; }
      if (now >= pending.nextTryAt) this.tryAsk(pending, now);
      return;
    }
    if (!Number.isFinite(localMinute)) return;
    const moment = this.recognise(characterId, now, localMinute, active, watching, fullscreenMinutes, backMinutes);
    if (!moment) return;
    this.pending = { moment, nextTryAt: now, lastWhy: null, phase: 'waiting', cueId: null, offeredAt: 0 };
    this.tryAsk(this.pending, now);
  }

  // ---------------------------------------------------------------- the opening choice and the inner loop

  /** The opening choice's claimant: this speech cue is the one a moment just asked for. Null for any other cue. */
  claims(cue: { id?: unknown; kind?: unknown; source?: unknown } | null | undefined): MomentClaim | null {
    const asking = this.asking;
    if (!asking || !cue || cue.kind !== 'speech' || cue.source !== undefined || typeof cue.id !== 'string' || this.claimed) return null;
    this.claimed = true;
    asking.cueId = cue.id;
    return { budget: asking.moment.budget, put: outcome => { if (this.asking === asking) this.outcome = outcome; } };
  }

  /** The inner loop, at the offer: the moment this cue carries (focus 'moment'), or null. */
  current(characterId: string): { kind: MomentKind; quietOk: boolean; night?: string } | null {
    const p = this.asking ?? this.pending;
    if (!p || p.moment.characterId !== characterId || p.cueId === null || this.alarmOff(p)) return null;
    return { kind: p.moment.kind, quietOk: p.moment.quietOk, ...(p.moment.night ? { night: p.moment.night } : {}) };
  }

  /** Her prompt's moment line (inner loop context, focus 'moment'). */
  promptLine(characterId: string): string {
    const p = this.asking ?? this.pending;
    if (!p || p.moment.characterId !== characterId || p.cueId === null || this.alarmOff(p)) return '';
    // A reminder that waited for you: how late it is now, not when it was recognised.
    const due = p.moment.kind === 'reminder' || (p.moment.kind === 'her-alarm' && p.moment.facts.alarmWhy === 'time') ? p.moment.facts.dueAt : undefined;
    const moment = due !== undefined ? { ...p.moment, facts: { ...p.moment.facts, lateMinutes: Math.max(0, (this.now() - due) / 60_000) } } : p.moment;
    try { return momentPromptLine(moment); } catch { return ''; }
  }

  /** The inner loop finished the cue it took for a moment: her line was delivered, or it ended without one. */
  done(cueId: string, delivered: boolean): void {
    const p = this.pending;
    if (!p || p.cueId !== cueId) return;
    if (delivered) {
      if ((p.moment.kind === 'reminder' || p.moment.kind === 'her-alarm') && p.moment.reminderId) { try { this.ports.reminders?.fired(p.moment.reminderId, this.now()); } catch { /* the in-memory state already moved */ } }
      if (p.moment.kind === 'screen') this.lastScreenSpoke = this.now();
      this.end(p, 'spoke');
      return;
    }
    this.notSaid(p, this.now());
  }

  /**
   * The chat turn (electron/wiring/brain-chat-wiring.ts): "明天八点提醒我…" is noted, "不用提醒了" cancels; the line goes into this turn's
   * private context only (her reply confirms; a guessed time she asks about). '' when the message is not about a reminder.
   */
  chatTurn(text: unknown): string {
    const reminders = this.ports.reminders, characterId = this.read(() => this.ports.characterId(), null), now = this.now();
    if (!reminders || !characterId) return '';
    let request: ReturnType<typeof parseReminderRequest> = null;
    try { request = parseReminderRequest(text, now, this.knobs.reminder.whatChars); } catch { request = null; }
    if (!request) return '';
    if (request.kind === 'cancel') {
      const cancelled = reminders.cancelLatest(characterId, now);
      if (!cancelled) return '（应用提示：用户说不用提醒了，不过现在没有等着的提醒。）';
      if (this.pending?.moment.reminderId === cancelled.id) this.end(this.pending, 'cancelled', 'user');
      else this.journal({ characterId, kind: 'reminder', outcome: 'cancelled', why: 'user' });
      return `（应用提示：用户说不用提醒了，应用已经取消了「${safeWords(cancelled.what)}」那条提醒。）`;
    }
    if (request.kind === 'unclear') {
      return `（应用提示：用户好像想让你到时候提醒 TA${request.what ? `「${safeWords(request.what)}」` : ''}，但应用没听出是什么时候，所以没有记下。）`;
    }
    const item = reminders.add(characterId, request, now);
    if (!item) return '（应用提示：用户想让你到时候提醒 TA，但应用这次没能记下（可能提醒太多或记录读不了），到时候不会有提醒。）';
    this.journal({ characterId, kind: 'reminder', outcome: 'set' });
    const due = new Date(item.dueAt), today = new Date(now);
    const day = due.toDateString() === today.toDateString() ? '今天' : `${due.getMonth() + 1}月${due.getDate()}日`;
    const time = `${day} ${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
    return `（应用提示：应用已经记下，${time} 提醒用户「${safeWords(item.what)}」，到时候会把这件事告诉你。${item.guessed ? '这个时间是应用按用户的话推测的（用户没说清几点或上午下午）。' : ''}用户之后说"不用提醒了"就会取消。）`;
  }

  /** 数据地图 (I-188): the reminder store, so deleting a character takes her reminders. */
  get reminderStore(): ReminderStore | null { return this.ports.reminders ?? null; }

  /** Developer view and tests: the moment waiting now (kind and phase only). */
  view(): { kind: MomentKind; phase: 'waiting' | 'offered'; why: MomentWhy | null } | null {
    const p = this.pending;
    return p ? { kind: p.moment.kind, phase: p.phase, why: p.lastWhy } : null;
  }

  // ---------------------------------------------------------------- inside

  private recognise(characterId: string, now: number, localMinute: number, active: boolean, watching: boolean, fullscreenMinutes: number | null,
    backMinutes: number | null): Moment | null {
    const window = this.knobs.ask.windowSeconds * 1000;
    const make = (kind: MomentKind, facts: MomentFacts, extra: Partial<Pick<Moment, 'quietOk' | 'budget' | 'night' | 'reminderId' | 'until'>> = {}): Moment => {
      const event = ALARM_OF_MOMENT[kind];
      if (event) this.ports.alarms?.event(event); // I-195: her alarms waiting for this event are armed (they wake after this moment)
      return {
        id: this.id(), kind, characterId, at: now, until: extra.until ?? now + window, facts, quietOk: extra.quietOk ?? false, budget: extra.budget ?? true,
        ...(extra.night ? { night: extra.night } : {}), ...(extra.reminderId ? { reminderId: extra.reminderId } : {}) };
    };
    // I-203: her kiss / hug from her reply was just interrupted: one immediate turn with the facts.
    // Not her own autonomous behaviour: no cooldown, no budget roll ('promise' below). Taken only with the gate open: someone typing or a chat
    // turn under way leaves the facts for that next turn instead (close-cut.ts turnLine). Never a second turn for the same moment (take is once).
    const cut = this.ports.closeCut;
    if (cut && this.read(() => cut.waiting, false) && !this.gate()) {
      const taken = this.read(() => cut.take(characterId), null); // I-209 step 2: only the one whose reply was cut
      if (taken) return { ...make('close-cut', { closeCut: taken.line }, { quietOk: true, budget: false }), cutId: taken.id };
    }
    // #13: a reminder whose time came (it waits for you to come back; too late and it is missed).
    const reminders = this.ports.reminders;
    if (reminders) {
      let due: ReturnType<ReminderStore['due']> = { item: null, missed: [] };
      try { due = reminders.due(characterId, now); } catch { /* none */ }
      for (const _ of due.missed) this.journal({ characterId, kind: 'reminder', outcome: 'expired', why: 'late' });
      if (due.item) return make('reminder', { what: due.item.what, dueAt: due.item.dueAt, lateMinutes: Math.max(0, (now - due.item.dueAt) / 60_000), guessed: due.item.guessed },
        { quietOk: true, budget: false, reminderId: due.item.id, until: Infinity }); // it waits for you; the store says when it is too late (tryAsk)
    }
    // I-195: one of her own alarms woke (a time, an event she waited for): the information goes to her like any moment, by the same gates.
    const woken = this.ports.alarms?.due(characterId, now) ?? null;
    if (woken) return make('her-alarm', { alarmNote: woken.note, alarmWhy: woken.why, dueAt: woken.dueAt, lateMinutes: woken.time ? Math.max(0, (now - woken.dueAt) / 60_000) : 0 },
      { reminderId: woken.id, budget: false, until: Infinity }); // her own small thing: no interaction-budget roll; the store gives it up (lateHours / expiry), not a window
    // #4: still at the computer well past the usual bedtime: once a night, sharing the old rest reminder's night.
    const night = this.read(() => this.ports.nightKey(now), '');
    if (night && active && !this.ports.state.used('late-night', night) && !this.read(() => this.ports.restUsed(night), true)) {
      const bed = usualBedtime(this.ports.state.bedNights(), eveningNightKey(now, localMinute), this.knobs);
      const late = lateNight({ localMinute, active, bed }, this.knobs);
      if (late) {
        this.ports.state.remember('late-night', night);
        return make('late-night', { bedMinute: late.bedMinute, nowMinute: late.nowMinute, nights: late.nights }, { quietOk: true, night });
      }
    }
    // #9: something on the screen while watching together (screenNow is the one check: never read otherwise).
    {
      const seen = this.screenNow(characterId, now);
      if (seen && seen.at !== this.lastScreenAt) {
        this.lastScreenAt = seen.at;
        const day = momentDayKey(now, localMinute, this.knobs);
        if (this.screenDay.day !== day) this.screenDay = { day, count: 0 };
        if (now - this.lastScreenSpoke < this.knobs.screen.cooldownMinutes * 60_000) this.journal({ characterId, kind: 'screen', outcome: 'skipped', why: 'cooldown', screen: seen.event });
        else if (this.screenDay.count >= this.knobs.screen.perDay) this.journal({ characterId, kind: 'screen', outcome: 'skipped', why: 'cap', screen: seen.event });
        else { this.screenDay.count++; return make('screen', { screen: seen.event }); }
      }
    }
    // #18: out of a full-screen program in Unbound (what was seen meanwhile only while watching together).
    if (fullscreenMinutes !== null) {
      const seen = watching ? this.seenInFullscreen : null;
      this.seenInFullscreen = null;
      if (now - this.lastFullscreen >= this.knobs.fullscreen.cooldownMinutes * 60_000) {
        this.lastFullscreen = now;
        return make('fullscreen-back', { fullscreenMinutes, ...(seen ? { screen: seen } : {}) });
      }
      this.journal({ characterId, kind: 'fullscreen-back', outcome: 'skipped', why: 'cooldown' });
    }
    // #2: today's first meeting (once a day, whatever then happens to it).
    const today = momentDayKey(now, localMinute, this.knobs);
    if (localMinute >= this.knobs.firstToday.dayStartMinute && localMinute < 22 * 60 && !this.ports.state.used('first-today', today)) {
      const presence = this.read(() => this.ports.presence(), null);
      const bed = usualBedtime(this.ports.state.bedNights(), eveningNightKey(now, localMinute), this.knobs);
      const first = firstToday({ back: presence?.presence === 'back' ? presence.awayMinutes ?? null : null, active, lastInteractionAt: this.read(() => this.ports.lastInteractionAt(), null),
        now, weekday: new Date(now).getDay(), lastNight: localMinute < 720 ? eveningNightKey(now, localMinute) : previousEveningKey(now, localMinute), nights: this.ports.state.bedNights(), bedMinute: bed.minute }, this.knobs);
      if (first) { this.ports.state.remember('first-today', today); return make('first-today', first); }
    }
    // #3: back at the seat after a short absence (once per return, by chance, with its own spacing).
    if (backMinutes !== null && backAtSeat(backMinutes, this.knobs)) {
      if (now - this.lastBack < this.knobs.back.cooldownMinutes * 60_000) this.journal({ characterId, kind: 'back', outcome: 'skipped', why: 'cooldown' });
      else if (!(this.random() < this.knobs.back.chance)) this.journal({ characterId, kind: 'back', outcome: 'skipped', why: 'chance' });
      else { this.lastBack = now; return make('back', { awayMinutes: backMinutes }); }
    }
    // #11: she is about to fall asleep and the user is still here: one goodnight a night.
    if (this.knobs.goodnight.enabled && night && active && this.read(() => this.ports.drowsy?.() === true, false) && !this.ports.state.used('goodnight', night)) {
      this.ports.state.remember('goodnight', night);
      return make('goodnight', {}, { quietOk: true });
    }
    // I-189: what the local pose watchers noticed (information only; the same gate, interval and hourly cap as every moment).
    const posed = this.read(() => this.ports.pose?.(now) ?? null, null);
    if (posed) return make(posed.kind, posed.facts);
    return null;
  }

  /** I-195: a pending alarm of hers while the switch is off: the inner loop is told nothing (no moment, no line). */
  private alarmOff(p: Pending): boolean { return p.moment.kind === 'her-alarm' && !this.read(() => this.ports.alarms?.on === true, false); }

  private tryAsk(p: Pending, now: number): void {
    if (p.moment.kind === 'her-alarm' && p.moment.reminderId) {
      // I-195: the switch turned off meanwhile: nothing fires (the alarm stays, dormant); the store gives up a late one or a cancelled one is gone.
      if (!this.read(() => this.ports.alarms?.on === true, false)) return this.end(p, 'skipped', 'switch');
      const state = this.read(() => this.ports.alarms?.keep(p.moment.characterId, p.moment.reminderId!, now) ?? null, null);
      if (state !== 'due') return this.end(p, state === 'missed' ? 'expired' : 'cancelled', state === 'missed' ? 'late' : 'user');
    }
    if (p.moment.kind === 'reminder' && p.moment.reminderId) {
      // The store decides when a reminder is too late (lateHours: 'missed'); cancelled in chat meanwhile: 'cancelled'.
      let state: string | null = null;
      try { this.ports.reminders?.due(p.moment.characterId, now); state = this.ports.reminders?.stateOf(p.moment.reminderId) ?? null; } catch { state = null; }
      if (state !== 'due') return this.end(p, state === 'missed' ? 'expired' : 'cancelled', state === 'missed' ? 'late' : 'user');
    }
    // I-203: the user's next chat turn already heard the facts of this cut (close-cut.ts turnLine): no immediate turn after that.
    if (p.moment.kind === 'close-cut' && p.moment.cutId !== undefined && !this.read(() => this.ports.closeCut?.live(p.moment.cutId!) === true, false)) return this.end(p, 'skipped', 'user');
    const why = this.gate();
    if (why) { p.lastWhy = why; p.nextTryAt = now + this.knobs.ask.retrySeconds * 1000; return; }
    this.asking = p; this.outcome = null; this.claimed = false; p.cueId = null;
    let made = false;
    try { made = this.ports.askSpeech(p.moment.kind === 'reminder' || p.moment.kind === 'close-cut' ? 'promise' : 'capped') === true; } catch { made = false; } // I-203: a cut is not autonomous: no cooldown
    const claimed = this.claimed, outcome = this.outcome;
    this.asking = null; this.claimed = false; this.outcome = null;
    if (made && claimed && outcome === 'inner') { p.phase = 'offered'; p.offeredAt = now; return; }
    p.cueId = null;
    if (made && claimed && outcome === 'budget') return this.end(p, 'quiet', 'budget');
    p.lastWhy = !made ? 'cap' : outcome === 'held' ? 'away' : 'refused';
    p.nextTryAt = now + this.knobs.ask.retrySeconds * 1000;
  }

  private notSaid(p: Pending, now: number): void {
    p.phase = 'waiting'; p.cueId = null;
    if ((p.moment.kind === 'reminder' || p.moment.kind === 'her-alarm') && p.moment.reminderId) {
      let state: string | null = null;
      try { state = this.ports.reminders?.tried(p.moment.reminderId, now) ?? null; } catch { state = null; }
      if (state === 'due') { p.lastWhy = 'not-said'; p.nextTryAt = now + this.knobs.reminder.retryMinutes * 60_000; return; }
    }
    this.end(p, 'quiet', 'not-said');
  }

  private end(p: Pending, outcome: MomentOutcome, why?: MomentWhy): void {
    if (this.pending === p) this.pending = null;
    if (p.moment.kind === 'close-cut' && p.moment.cutId !== undefined) { const id = p.moment.cutId; this.read(() => { this.ports.closeCut?.settled(id, outcome === 'spoke'); return true; }, false); } // I-203: not said: her next chat turn hears it
    this.journal({ characterId: p.moment.characterId, kind: p.moment.kind, outcome, ...(why ? { why } : {}), ...(p.moment.facts.screen ? { screen: p.moment.facts.screen } : {}) });
  }

  /** The one gate: never while typing, in a call, asleep, hidden, away (or with the switch off). */
  private gate(): MomentWhy | null {
    const presence = this.read(() => this.ports.presence(), null);
    return momentGate({ enabled: this.read(() => this.ports.enabled() === true, false), typing: this.read(() => this.ports.typing() === true, true),
      call: this.read(() => this.ports.call() === true, true) || presence?.presence === 'meeting', asleep: this.read(() => this.ports.asleep() === true, true),
      visible: this.read(() => this.ports.visible() === true, false), away: presence?.presence === 'away' });
  }

  /**
   * I-195: what her own alarms may wait for, read from the same signals the moments use (and nothing else): the user at the computer a long stretch,
   * a return, something on the screen while watching together, a kiss or a hug. Nothing runs with the switch off. The first-today, late-night and
   * fullscreen-back events come from `make` (the moment itself).
   */
  private alarmEvents(characterId: string, now: number, active: boolean, backMinutes: number | null): void {
    const alarms = this.ports.alarms;
    if (!alarms) return;
    alarms.tick(active, now);
    if (!alarms.on) return;
    if (backMinutes !== null) alarms.event('back');
    const seen = this.screenNow(characterId, now);
    if (seen && seen.at !== this.lastAlarmScreenAt) { this.lastAlarmScreenAt = seen.at; const word = ALARM_OF_SCREEN[seen.event]; if (word) alarms.event(word); }
    const recent = this.read(() => this.ports.closeMoments?.() ?? [], []);
    for (const note of recent) {
      if (!note || typeof note !== 'object' || this.closeSeen.has(note)) continue;
      this.closeSeen.add(note);
      if (this.closeStarted && (note.kind === 'kiss' || note.kind === 'hug')) alarms.event(note.kind); // the first look only takes stock: older ones are not "now"
    }
    this.closeStarted = true;
  }

  /** The minutes away of a return the presence judgment just reported ('back'), once per return; null otherwise. */
  private backEpisode(): number | null {
    const presence = this.read(() => this.ports.presence(), null);
    if (presence?.presence !== 'back') { this.backHandled = false; return null; }
    if (this.backHandled) return null;
    this.backHandled = true;
    return typeof presence.awayMinutes === 'number' ? presence.awayMinutes : null;
  }

  private screenNow(characterId: string, now: number): { event: ScreenMomentEvent; at: number } | null {
    if (!this.read(() => this.ports.watching?.() === true, false)) return null;
    return screenMoment(this.read(() => this.ports.screen?.(characterId) ?? null, null), now, this.knobs);
  }

  private active(now: number): boolean {
    const idle = this.read(() => this.ports.idleSeconds(), null);
    if (typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 && idle <= this.knobs.active.idleSeconds) return true;
    const at = this.read(() => this.ports.lastInteractionAt(), null);
    return typeof at === 'number' && Number.isFinite(at) && at <= now && now - at <= this.knobs.active.interactionMinutes * 60_000;
  }

  private journal(row: MomentJournalRow): void { try { this.ports.journal?.(row); } catch { /* the journal never changes what she does */ } }
  private read<T>(get: () => T, fallback: T): T { try { return get(); } catch { return fallback; } }
  private random(): number { try { const value = (this.ports.random ?? Math.random)(); return Number.isFinite(value) ? value : 1; } catch { return 1; } }
  private id(): string { try { return (this.ports.createId ?? randomUUID)(); } catch { return `m${this.now()}`; } }
  private now(): number { try { const value = (this.ports.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); } catch { return Date.now(); } }
}

/** A reminder's words inside her private line: one line, no tags. */
function safeWords(text: string): string {
  return Array.from(String(text ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/[<>]/gu, m => (m === '<' ? '＜' : '＞')).replace(/[「」]/gu, '').replace(/\s+/gu, ' ').trim()).slice(0, 60).join('');
}
