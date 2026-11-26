/**
 * 松绑的主机这一侧（纯规则在 shared/behaviors/impulse/，接口说明在那里的 interface.ts）。方案 docs/claude/2026-11-11-loosen-plan.md，
 * 做了什么 docs/claude/2026-11-12-loosen.md。
 *
 * 没有自己的定时器：electron/main.ts 原有的每秒一下调 tick()。每个角色一份小状态，只在内存（重开应用从头算；心情本身照旧存档）：
 *  - 伸手：你互动完先安静一会儿（每轮抽），之后按冲动大小抛硬币"想起你"；想起来以后过底线、过互动余额、她挑一件（说话 / 看你一眼 / 哼歌）
 *    或这次不做。说话只是向心情时钟要一次开口的机会（MoodHost.welcomeAttention：开口间隔、每小时上限照旧），说什么由"这次说什么"挑。
 *    每次想起来记一行体验记录（同样的"被拦下"连着只记一次）。
 *  - 表现：内心循环的提示词问 expression()：话头（只从真有的里挑）、偶尔的小毛病（有冷却、不连着同一种）、最近几次开头。
 *  - 回到心情：她的一句真的说出口了（spoke）→ 等你一会儿：你有互动就 O、D 小涨；没有就 D 小降、C 小涨，那个话头几小时内不再给；
 *    邀你玩你说下次（inviteAnswered）→ D 小降，几小时内邀请那一项压得很低。走 MoodHost.moments 的小时刻（冷却、每天次数、相对基线）。
 * 一律不抛错给调用方。
 */
import type { MoodContext, MoodTendency, MoodValues } from '../../../shared/foundation/mood';
import type { CardSlips } from '../../../shared/foundation/character-card';
import type { PresenceView } from '../../../shared/senses';
import type { ProactiveTalk } from '../../../shared/foundation/settings';
import { IMPULSE_KNOBS, type ImpulseKnobs } from '../../../shared/behaviors/impulse/knobs';
import { drawMinutes, impulseLeans, impulseNow, initiativeFloor, reachChance, regulateInitiative } from '../../../shared/behaviors/impulse/choose';
import { lineOpening, pickSlip, pickTopic, type SlipKind, type SlipMemory, type TopicKind } from '../../../shared/behaviors/impulse/expression';
import type { FloorInput, Impulse, InitiativeDecision, InitiativeFloor, InitiativeRow } from '../../../shared/behaviors/impulse/interface';
import type { OpeningNow } from '../../../shared/brain';

/** Her mood as the host reads it each second (numbers and closed labels only). */
export interface ImpulseMoodRead {
  readonly characterId: string;
  readonly values: MoodValues;
  readonly baseline: MoodValues;
  readonly evidence: number;
  readonly boredom: number;
  readonly longing: number;
  readonly A: number | null;
  readonly personality: Partial<Record<MoodTendency, number>>;
  /** The card's 小毛病 switch (shared/cards/card-slips.ts); absent or null = the default. */
  readonly cardSlips?: CardSlips | null;
  readonly lastInteractionAt: number | null;
  /** MoodState.unansweredSpeech. */
  readonly unanswered: number;
  readonly primary: string;
  /** The context of her recent reason (MoodSnapshot.context: not neutral only within the afterglow). */
  readonly context: MoodContext;
  readonly reason: string;
}

export type OutcomeMoment = 'spoke-answered' | 'spoke-unanswered' | 'invite-declined';

export interface ImpulseHostOptions {
  clock?(): number;
  random?(): number;
  knobs?: ImpulseKnobs;
  /** The current character's mood; null when none (or 自动表现 is off: nothing of hers starts then). */
  mood(): ImpulseMoodRead | null;
  /** The inner loop's quiet rules now (InnerLoop.quietNow): asleep → no reach at all; night or drowsy → the floor. */
  quiet(): { readonly asleep: boolean; readonly quiet: boolean };
  /** I-066 (electron/senses/user-activity.ts presence()); null while not running yet. */
  presence(): PresenceView | null;
  /** The expression gate: visible, no typing, no chat or speech, not dragged, inner loop and 自动表现 on, Claude available. */
  canExpress(): boolean;
  /** I-006: the user is absorbed in something (a soft press on talk, never a stop). Omitted: from presence 'busy'. */
  busy?(): boolean;
  /** 设置「她主动找你说话」. Omitted: normal. */
  talk?(): ProactiveTalk;
  /** I-010 互动余额 for her speaking now (0..1, a strong feeling already let through); null: no press. */
  balance?(characterId: string, want: number, mood: string): number | null;
  /** Her-life offers humming now (its own gates). Omitted: never. */
  humOffered?(characterId: string): boolean;
  /** Ask the mood clock for one speech opportunity (OpeningHost.expectReach + MoodHost.welcomeAttention); false = refused (interval, cap). */
  talkNow(characterId: string): boolean;
  /**
   * I-085 step 2: called once she has decided to speak on her own, before the speech opportunity is asked for: one look at the user first
   * (electron/initiative/self-look/host.ts beforeSpeaking: bounded wait, never throws, and does nothing unless 「发图片」 is on and free). The floor is
   * read again after it resolves. Omitted: no look.
   */
  lookFirst?(characterId: string): Promise<unknown>;
  /** One look cue (MoodHost.glanceAttention); false = refused (its interval). */
  glanceNow(characterId: string): boolean;
  /** Start humming (her-life switch); false = refused. */
  humNow?(characterId: string): boolean;
  /** One outcome moment back to her mood (MoodHost.moments). */
  lift(kind: OutcomeMoment, characterId: string, key: string): boolean;
  /** 体验记录 'initiative' (closed values only). */
  journal?(row: InitiativeRow): void;
  /**
   * P-001 step 3: a plan the user told her whose time has come (electron/memory/upcoming/ask.ts topic; null when none, not now, or a tender one) and the
   * call for when her own line that came out of it was shown (the plan is then asked, once).
   */
  plan?: { due(characterId: string): { id: string; text: string } | null; asked(id: string): void };
}

interface CharacterState {
  lastTick: number | null;
  /** The interaction this round started from, and the quiet she keeps after it. */
  round: { from: number | null; quietUntil: number } | null;
  refractoryUntil: number;
  lastRow: string;
  topics: { recent: TopicKind[]; quietUntil: Partial<Record<TopicKind, number>> };
  given: { topic: TopicKind | null; at: number; plan?: string } | null;
  /** The plan the last duePlan() call offered (picked only if the topic roll lands on it). */
  offeredPlan: string | null;
  slip: SlipMemory;
  openings: string[];
  spoken: { at: number; key: string; topic: TopicKind | null; deadline: number } | null;
  declinedAt: number | null;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE;
/** A topic given in a prompt belongs to the line that comes out of it within this long. */
const GIVEN_MS = 2 * MINUTE;
const KEEP_RECENT = 20;

export class ImpulseHost {
  private readonly states = new Map<string, CharacterState>();
  private readonly knobs: ImpulseKnobs;
  private seq = 0;
  /** The last few reach decisions (tests and developer checks; memory only). */
  readonly recent: InitiativeRow[] = [];
  constructor(private readonly options: ImpulseHostOptions) { this.knobs = options.knobs ?? IMPULSE_KNOBS; }

  /** The existing one-second tick. */
  tick(): void {
    const now = this.now(), m = this.mood();
    if (!m || !Number.isFinite(now)) return;
    const st = this.state(m.characterId);
    const dt = st.lastTick === null ? 1_000 : Math.max(0, Math.min(10_000, now - st.lastTick));
    st.lastTick = now;
    this.settle(m, st, now);
    let quiet: { asleep: boolean; quiet: boolean };
    try { const q = this.options.quiet(); quiet = { asleep: q.asleep === true, quiet: q.quiet === true }; } catch { quiet = { asleep: false, quiet: true }; }
    // Asleep: she has no reach at all (and nothing is written).
    if (quiet.asleep) return;
    // A new round after each interaction: a quiet of her own (drawn, so it is never the same length).
    if (!st.round || st.round.from !== m.lastInteractionAt) {
      const from = m.lastInteractionAt;
      st.round = { from, quietUntil: (typeof from === 'number' && Number.isFinite(from) ? Math.min(from, now) : now) + drawMinutes(this.knobs.reach.quietAfter, () => this.random()) };
    }
    if (now < st.round.quietUntil || now < st.refractoryUntil) return;
    const impulse = this.impulse(m, st, now);
    if (!(this.random() < reachChance(impulse.urge, dt, this.talk(), this.knobs))) return;
    // She thought of you: whatever comes of it, the next time is a while off (drawn).
    st.refractoryUntil = now + drawMinutes(this.knobs.reach.refractory, () => this.random());
    this.decide(m, st, impulse);
  }

  /** The opening choice's factor on each candidate from her urge (the same numbers); null for another character or no mood. */
  leans(characterId: string): OpeningNow['leans'] | null {
    const m = this.mood();
    if (!m || m.characterId !== characterId) return null;
    const now = this.now(), st = this.state(characterId), leans = impulseLeans(this.impulse(m, st, now));
    // An invitation turned down a little while ago: not again soon (the invite candidate is pressed hard for the quiet hours).
    if (st.declinedAt !== null && now - st.declinedAt < this.knobs.topic.quietHours * HOUR && leans.play)
      leans.play = [...leans.play, { text: '刚说过下次', factor: 0.2 }];
    return leans;
  }

  /**
   * For one prompt where she may really speak on her own: a topic among the available real ones (or none), a rare slip (its cooldown starts
   * now, offered or not taken), and how her last few lines of her own opened.
   */
  expression(characterId: string, available: readonly TopicKind[]): { topic: TopicKind | null; slip: SlipKind | null; openings: readonly string[] } {
    const now = this.now(), st = this.state(characterId), m = this.mood();
    const topic = pickTopic(available, st.topics, now, () => this.random(), this.knobs);
    if (topic) st.topics.recent = [topic, ...st.topics.recent.filter(kind => kind !== topic)].slice(0, 3);
    st.given = { topic, at: now, ...(topic === 'plan' && st.offeredPlan ? { plan: st.offeredPlan } : {}) };
    st.offeredPlan = null;
    let slip: SlipKind | null = null;
    if (m && m.characterId === characterId) {
      slip = pickSlip({ values: m.values, baseline: m.baseline, evidence: m.evidence, A: m.A, personality: m.personality, cardSlips: m.cardSlips }, st.slip, now, () => this.random(), this.knobs);
      if (slip) st.slip = { last: slip, until: now + drawMinutes(this.knobs.slip.cooldownMinutes, () => this.random()) };
    }
    return { topic, slip, openings: [...st.openings] };
  }

  /** P-001 step 3: the words of a due plan she may open with, or '' (a topic only while there is one; offering it asks nothing of her). */
  duePlan(characterId: string): string {
    const st = this.state(characterId);
    st.offeredPlan = null;
    try {
      const m = this.mood();
      if (!m || m.characterId !== characterId) return '';
      const plan = this.options.plan?.due(characterId);
      if (!plan || !plan.id || !plan.text) return '';
      st.offeredPlan = plan.id;
      return plan.text;
    } catch { return ''; }
  }

  /** Her mood's recent reason when it was a good or warm moment (never a let-down, never the default). */
  recentEvent(): string {
    const m = this.mood();
    if (!m || (m.context !== 'positive' && m.context !== 'support')) return '';
    const reason = String(m.reason ?? '').trim();
    return reason && reason !== '安静陪伴' ? reason.slice(0, 40) : '';
  }

  /** Her own line was really shown (the inner loop's archive): wait for the user's answer. The text is read only for how it opens. */
  spoke(text: string, key?: string): void {
    const m = this.mood();
    if (!m) return;
    const now = this.now(), st = this.state(m.characterId);
    const opening = lineOpening(text);
    if (opening) st.openings = [opening, ...st.openings].slice(0, 3);
    const live = st.given && now - st.given.at >= 0 && now - st.given.at <= GIVEN_MS ? st.given : null;
    const topic = live ? live.topic : null;
    st.given = null;
    // The plan topic came out as her line: that plan is asked, once (even if she then chose not to name it: she may not ask twice).
    if (live?.plan) { try { this.options.plan?.asked(live.plan); } catch { /* nothing */ } }
    // In the quiet hours the only line she says is the night's rest reminder: no answer is expected, so nothing waits for one.
    let quiet = true;
    try { quiet = this.options.quiet().quiet === true; } catch { quiet = true; }
    if (quiet) return;
    st.spoken = { at: now, key: safeKey(key ?? `${now}-${++this.seq}`), topic, deadline: now + this.knobs.outcome.answerMinutes * MINUTE };
  }

  /** "来！" or "下次吧" on her invitation (electron/initiative/rps/host.ts respond). */
  inviteAnswered(characterId: string, accepted: boolean, key?: string): void {
    const now = this.now(), st = this.state(characterId), id = safeKey(key ?? `${now}-${++this.seq}`);
    const spoken = st.spoken;
    st.spoken = null;
    if (accepted) { this.lift('spoke-answered', characterId, spoken?.key ?? id); return; }
    st.declinedAt = now;
    this.lift('invite-declined', characterId, id);
  }

  private settle(m: ImpulseMoodRead, st: CharacterState, now: number): void {
    const spoken = st.spoken;
    if (!spoken) return;
    const seen = m.lastInteractionAt;
    if (typeof seen === 'number' && Number.isFinite(seen) && seen > spoken.at) {
      st.spoken = null;
      this.lift('spoke-answered', m.characterId, spoken.key);
    } else if (now >= spoken.deadline) {
      st.spoken = null;
      // Not taken: that kind of topic rests a few hours (she does not bring it up again soon).
      if (spoken.topic) st.topics.quietUntil[spoken.topic] = now + this.knobs.topic.quietHours * HOUR;
      this.lift('spoke-unanswered', m.characterId, spoken.key);
    }
  }

  private decide(m: ImpulseMoodRead, st: CharacterState, impulse: Impulse): void {
    const characterId = m.characterId;
    let presence: PresenceView | null = null;
    try { presence = this.options.presence(); } catch { presence = null; }
    let canExpress = false;
    try { canExpress = this.options.canExpress() === true; } catch { canExpress = false; }
    let quiet = true;
    try { quiet = this.options.quiet().quiet === true; } catch { quiet = true; }
    const floor: FloorInput = {
      asleep: false, quiet, canExpress, unanswered: m.unanswered,
      presence: !presence ? null : presence.presence === 'meeting' ? 'meeting' : presence.interrupt === 'no' ? 'no' : 'ok',
    };
    let busy = false;
    try { busy = this.options.busy ? this.options.busy() === true : presence?.presence === 'busy'; } catch { busy = false; }
    let balance: number | null = null;
    try { balance = this.options.balance?.(characterId, impulse.kinds.speak, m.primary) ?? null; } catch { balance = null; }
    let humOffered = false;
    try { humOffered = !!this.options.humNow && this.options.humOffered?.(characterId) === true; } catch { humOffered = false; }
    let decision: InitiativeDecision = regulateInitiative({ impulse, floor, balance: Number.isFinite(balance) ? balance : null, busy, humOffered }, () => this.random(), this.knobs);
    // I-085 step 2: only when she is really going to speak on her own (the floor, the balance and her own choice have all said talk):
    // one look first, then the same opportunity. The floor is not touched or postponed by it: it was read above and is read again after.
    if (decision.kind === 'talk' && this.options.lookFirst) { this.lookThenTalk(m, st, decision); return; }
    this.commit(st, characterId, decision);
  }

  private lookThenTalk(m: ImpulseMoodRead, st: CharacterState, decision: InitiativeDecision): void {
    const characterId = m.characterId;
    let pending: Promise<unknown>;
    try { pending = Promise.resolve(this.options.lookFirst?.(characterId)); } catch { pending = Promise.resolve(); }
    void pending.catch(() => undefined).then(() => {
      // The user may have started typing, hidden her, or turned in for the night meanwhile: the hard floor again, before the opportunity.
      const now = this.mood();
      let again: InitiativeFloor | null = 'not-now';
      try {
        const quiet = this.options.quiet(), presence = this.options.presence();
        again = !now || now.characterId !== characterId || quiet.asleep === true ? 'not-now' : initiativeFloor('talk', {
          asleep: false, quiet: quiet.quiet === true, canExpress: this.options.canExpress() === true, unanswered: now.unanswered,
          presence: !presence ? null : presence.presence === 'meeting' ? 'meeting' : presence.interrupt === 'no' ? 'no' : 'ok',
        });
      } catch { again = 'not-now'; }
      if (again) { this.record(st, { characterId, bucket: decision.bucket, kind: 'none', why: 'floor', floor: again }); return; }
      this.commit(st, characterId, decision);
    });
  }

  private commit(st: CharacterState, characterId: string, requested: InitiativeDecision): void {
    let decision = requested;
    if (decision.kind !== 'none') {
      let done = false;
      try {
        done = decision.kind === 'talk' ? this.options.talkNow(characterId) === true
          : decision.kind === 'glance' ? this.options.glanceNow(characterId) === true : this.options.humNow?.(characterId) === true;
      } catch { done = false; }
      // The mood clock's interval and caps (or her-life's own gates) said not yet.
      if (!done) decision = { bucket: decision.bucket, kind: 'none', why: 'cooldown' };
    }
    this.record(st, { characterId, ...decision });
  }

  private record(st: CharacterState, row: InitiativeRow): void {
    const key = `${row.kind}|${row.why ?? ''}|${row.floor ?? ''}`;
    // The same "held back" again and again (a long night, a long absence) is one row until something changes.
    const repeat = row.kind === 'none' && (row.why === 'floor' || row.why === 'cooldown') && key === st.lastRow;
    st.lastRow = key;
    this.recent.push(row);
    if (this.recent.length > KEEP_RECENT) this.recent.shift();
    if (repeat) return;
    try { this.options.journal?.(row); } catch { /* The journal never changes what she does. */ }
  }

  private impulse(m: ImpulseMoodRead, st: CharacterState, now: number): Impulse {
    const declined = st.declinedAt !== null && now - st.declinedAt >= 0 && now - st.declinedAt < this.knobs.outcome.declineHours * HOUR ? 1 : 0;
    return impulseNow({ values: m.values, baseline: m.baseline, evidence: m.evidence, boredom: m.boredom, longing: m.longing, A: m.A,
      personality: m.personality, ignored: Math.max(0, m.unanswered) + declined }, this.knobs);
  }

  private lift(kind: OutcomeMoment, characterId: string, key: string): void {
    try { this.options.lift(kind, characterId, key); } catch { /* Her mood stays as it is. */ }
  }

  private state(characterId: string): CharacterState {
    let st = this.states.get(characterId);
    if (!st) {
      st = { lastTick: null, round: null, refractoryUntil: 0, lastRow: '', topics: { recent: [], quietUntil: {} }, given: null, offeredPlan: null,
        slip: { last: null, until: 0 }, openings: [], spoken: null, declinedAt: null };
      this.states.set(characterId, st);
      while (this.states.size > 32) this.states.delete(this.states.keys().next().value!);
    }
    return st;
  }

  private mood(): ImpulseMoodRead | null {
    try { const m = this.options.mood(); return m && typeof m.characterId === 'string' && m.characterId ? m : null; } catch { return null; }
  }
  private talk(): ProactiveTalk { try { return this.options.talk?.() ?? 'normal'; } catch { return 'normal'; } }
  private random(): number { try { const value = (this.options.random ?? Math.random)(); return Number.isFinite(value) ? value : 0.5; } catch { return 0.5; } }
  private now(): number { try { return (this.options.clock ?? Date.now)(); } catch { return NaN; } }
}

const safeKey = (value: string) => String(value).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || 'x';
