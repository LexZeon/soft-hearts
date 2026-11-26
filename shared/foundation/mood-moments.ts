/**
 * 心情第二批 (docs/claude/2026-11-11-mood-batch2.md; audit docs/claude/2026-11-11-mood-hormone-audit.md "第二批"): moments that used
 * to read her mood and never came back to it now give a small lift.
 *
 * Pure: the table of moments, the gate that keeps each family from being farmed (a cooldown and a per-day count per character),
 * the relative scaling (a channel already far from the card's baseline in the same direction gets less, then nothing), the
 * fallback lift for a reply without a usable tail (by the current label), and three small watchers (sleep, music tier, return)
 * that turn a stream of states into one moment. electron/mood/mood-moments.ts applies them through MoodHost.lift.
 *
 * Every lift id is `moment-<kind>-…` (its own family; the mood model never applies one id twice). The amounts are a fraction of
 * one chat tail (±6) and go through applyMoodLift, so the card's sensitivity and baseline apply as for every other lift.
 */
import { moodLevel, type MoodContext, type MoodLabel, type MoodValues } from './mood';

export const MOOD_MOMENT_KINDS = ['back', 'wake', 'dance', 'song', 'special-day', 'keepsake', 'diary', 'shy', 'tailless',
  // I-077 (src/stage/music-react/): her reactions while listening come back to her mood
  'music-lift', 'music-settle', 'music-enjoy', 'music-moved', 'music-recognize',
  // I-078 第 2 步 (docs/claude/2026-11-11-i078-sleep-step2-3.md): woken before she had slept enough; patted gently without waking
  'woken', 'sleep-soothed',
  // I-086 (docs/claude/2026-11-11-i086-give-and-keep.md): you took what she handed you (a snack, the cushion)
  'gave-taken',
  // I-081 (docs/claude/2026-11-11-i081-gaze.md): she looked at you while you faced her for a few seconds (pose sensing on)
  'eye-contact',
  // I-087 (docs/claude/2026-11-11-i087-hands.md): you took her hand; a high five
  'held-hands', 'high-five',
  // 松绑 (docs/claude/2026-11-12-loosen.md): she spoke first and you answered / did not; you turned her invitation down
  'spoke-answered', 'spoke-unanswered', 'invite-declined',
  // I-085 steps 2 and 4 (docs/claude/2026-11-12-i085-steps-2-4.md): she looked at you herself and saw you there / smiling
  'look-present', 'look-smile',
  // I-104 (docs/claude/2026-11-12-unbound-peek.md): in Unbound she came up to the lens and you answered her (talked to her or clicked her)
  'peek-answered',
  // Unbound step 4 (docs/claude/2026-11-17-unbound-step4.md): in Unbound the camera saw you wave to her (sure)
  'waved',
  // I-184 (docs/claude/2026-11-22-i184-unbound-kiss.md): in full-screen Unbound she kissed you or hugged you (on her own, or pulled close)
  'kiss', 'hug'] as const;
export type MoodMomentKind = (typeof MOOD_MOMENT_KINDS)[number];

/** The fixed reason of each moment (her mood's 最近原因 when it is shown; the journal maps it to a closed source). */
export const MOOD_MOMENT_REASONS: Readonly<Record<MoodMomentKind, string>> = Object.freeze({
  back: '你回到电脑前了', wake: '睡醒了', dance: '跳完一段舞', song: '听完一首喜欢的歌', 'special-day': '说起了你的特别的日子',
  keepsake: '给你留了点东西', diary: '写完了日记', shy: '害羞了一下', tailless: '回了你一句',
  'music-lift': '歌起来了，跟着来了劲', 'music-settle': '歌慢下来，跟着放松', 'music-enjoy': '听歌听得很投入', 'music-moved': '被一首慢歌打动了', 'music-recognize': '又听到熟悉的歌了',
  woken: '没睡够就被叫醒了', 'sleep-soothed': '睡着时被你轻轻摸了摸',
  'gave-taken': '你接住了她递的东西',
  'eye-contact': '和你对视了一会儿',
  'held-hands': '和你牵了手', 'high-five': '和你击了掌',
  'spoke-answered': '她先开口，你接了她的话', 'spoke-unanswered': '她先开口，你没接', 'invite-declined': '邀你玩，你说下次',
  'look-present': '她看了你一眼，你在', 'look-smile': '她看了你一眼，你在笑',
  'peek-answered': '她凑到镜头前看你，你回应了她',
  waved: '你朝她挥了挥手',
  kiss: '她凑过来亲了你一下', hug: '她凑过来抱了抱你',
});

export interface MoodMomentSpec {
  /** The lift before relative scaling (tailless: by label, MOOD_TAILLESS_BY_LABEL). */
  readonly delta: Partial<MoodValues>;
  /** Moments of one group share the cooldown and the day's count (a song she nodded to and then danced to is one moment). */
  readonly group: string;
  readonly cooldownMs: number;
  readonly perDay: number;
  /**
   * An after-effect of something that already set her reason (a blush after warm words, a reply's missing tail, saying something
   * out): the numbers move, the reason and its context stay (so 害怕, 关切… keep their cause). Otherwise the moment is the reason.
   */
  readonly keepReason: boolean;
  /** The context the lift sets when it is the reason (absent: applyMoodLift's own rule, positive with a gain). */
  readonly context?: MoodContext;
  /** I-085: M points of longing this moment eases (MoodState.longingEase); it applies even when the delta scales to nothing. */
  readonly longingEase?: number;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE;
/**
 * The table. Amounts (before the card's sensitivity): a chat tail moves up to ±6 per channel; these stay at 1–3.
 *  - back: you came back after a real absence: closeness and a little reward (O, D).
 *  - wake: a real sleep is over: rested (E up), unburdened (C down), and arousal starts low (N down).
 *  - dance / song: a dance segment or a song she nodded along to ended: reward and ease (D, E), a short N bump (N decays in minutes).
 *  - special-day: she spoke of your birthday or anniversary: reward and closeness (D, O).
 *  - keepsake / diary: she said it out or wrote it down: a little less burden (C down).
 *  - shy: after a blush, a small warm ease (E up); N untouched.
 *  - music-* (I-077, docs/claude/2026-11-11-i077-music-reactions.md): a reaction she had while listening. lift: a short N bump (N decays
 *    in minutes); settle: ease (E); enjoy: reward and ease (D, E), in the same group as dance / song, so a song she enjoyed and then
 *    danced to is one moment, never two; moved by a slow dark song: a little closer (O up) and a little wistful (E down).
 *  - woken / sleep-soothed (I-078 第 2 步): see the entries.
 *  - music-recognize (I-077 step 2, docs/claude/2026-11-11-i077-step2.md): the intro of a song she has heard several times: a small D (reward),
 *    its own family with a long cooldown (the song's own enjoy moment is a different happening and is not counted against it).
 */
export const MOOD_MOMENTS: Readonly<Record<Exclude<MoodMomentKind, 'tailless'>, MoodMomentSpec>> = Object.freeze({
  back: { delta: { O: 2, D: 2 }, group: 'back', cooldownMs: 45 * MINUTE, perDay: 4, keepReason: false, context: 'positive' },
  wake: { delta: { E: 3, C: -3, N: -3 }, group: 'wake', cooldownMs: 3 * HOUR, perDay: 3, keepReason: false, context: 'neutral' },
  dance: { delta: { D: 2, E: 2, N: 3 }, group: 'music', cooldownMs: 20 * MINUTE, perDay: 6, keepReason: false, context: 'positive' },
  song: { delta: { D: 1.5, E: 2, N: 1.5 }, group: 'music', cooldownMs: 20 * MINUTE, perDay: 6, keepReason: false, context: 'positive' },
  'special-day': { delta: { D: 3, O: 3 }, group: 'special-day', cooldownMs: 20 * HOUR, perDay: 1, keepReason: false, context: 'positive' },
  keepsake: { delta: { C: -2 }, group: 'keepsake', cooldownMs: 2 * HOUR, perDay: 3, keepReason: true },
  diary: { delta: { C: -2 }, group: 'diary', cooldownMs: 12 * HOUR, perDay: 1, keepReason: true },
  shy: { delta: { E: 1.5 }, group: 'shy', cooldownMs: 10 * MINUTE, perDay: 12, keepReason: true },
  'music-lift': { delta: { N: 1.5 }, group: 'music-lift', cooldownMs: 8 * MINUTE, perDay: 12, keepReason: true },
  'music-settle': { delta: { E: 1.5 }, group: 'music-settle', cooldownMs: 10 * MINUTE, perDay: 10, keepReason: true },
  'music-enjoy': { delta: { D: 1.5, E: 1.5 }, group: 'music', cooldownMs: 20 * MINUTE, perDay: 6, keepReason: false, context: 'positive' },
  'music-moved': { delta: { O: 1, E: -1 }, group: 'music-moved', cooldownMs: 30 * MINUTE, perDay: 4, keepReason: false, context: 'neutral' },
  // I-078 第 2 步: woken before she had slept enough (her sleep pressure still above restedA): a little burdened and less settled
  // ("没睡够有点迷糊"; never the natural wake's lift for the same sleep). Gently patted while asleep without waking: sleeps more soundly.
  woken: { delta: { C: 1.5, E: -1.5 }, group: 'woken', cooldownMs: 45 * MINUTE, perDay: 4, keepReason: false, context: 'neutral' },
  'sleep-soothed': { delta: { E: 1 }, group: 'sleep-soothed', cooldownMs: 15 * MINUTE, perDay: 8, keepReason: true },
  'music-recognize': { delta: { D: 1 }, group: 'music-recognize', cooldownMs: 30 * MINUTE, perDay: 4, keepReason: false, context: 'positive' },
  // I-086: you took the snack or the cushion she held out to you: a little closer (O) and a little reward (D). Not taken: nothing at all
  // (no guilt, no dip). Its own family; the cooldown and the day's count keep it to the two or three offers a day.
  'gave-taken': { delta: { O: 1.5, D: 1.5 }, group: 'gave-taken', cooldownMs: 60 * MINUTE, perDay: 3, keepReason: false, context: 'positive' },
  // I-081: an eye contact (she looked at you, you faced her, a few seconds; only while pose sensing says you are there): a little
  // closer (O). Its own family with a cooldown, so looking at each other all afternoon is a few small lifts, not a stream.
  'eye-contact': { delta: { O: 1 }, group: 'eye-contact', cooldownMs: 12 * MINUTE, perDay: 10, keepReason: true },
  // I-087: you took her hand: a little closer (O), a little less burdened (C down: calm) and a small ease (E). A high five: a small
  // reward (D). Not taken, let go: nothing at all (no guilt). Each its own family with a cooldown, so holding hands all evening is a
  // few small lifts, not a stream; the pinky promise writes nothing here (it goes into her plan memory).
  'held-hands': { delta: { O: 1.5, C: -1, E: 0.5 }, group: 'held-hands', cooldownMs: 30 * MINUTE, perDay: 6, keepReason: false, context: 'positive' },
  'high-five': { delta: { D: 1.5 }, group: 'high-five', cooldownMs: 15 * MINUTE, perDay: 8, keepReason: false, context: 'positive' },
  // 松绑 (user-approved plan 2026-11-11, part 4): she spoke first and you answered within the window: a little closer and a little reward
  // (O, D). Nobody answered: a little let-down (D down) and a little tension (C up). Both keep her reason (the numbers move, her 最近原因 and its
  // face stay): the dip is never something she is told to bring up, so it can never turn into a guilt lever (principle 6). Your 'next
  // time' to her invitation: a small D dip, same. The dips are smaller than the lift, and each family has its cooldown and day count.
  'spoke-answered': { delta: { O: 1.5, D: 1.5 }, group: 'spoke-answered', cooldownMs: 20 * MINUTE, perDay: 8, keepReason: false, context: 'positive' },
  'spoke-unanswered': { delta: { D: -1, C: 1 }, group: 'spoke-unanswered', cooldownMs: 30 * MINUTE, perDay: 6, keepReason: true },
  'invite-declined': { delta: { D: -1 }, group: 'invite-declined', cooldownMs: 60 * MINUTE, perDay: 3, keepReason: true },
  // I-085 steps 2 and 4: she looked at you herself (from haiku's closed tag, shared/initiative/self-look.ts selfLookEffects). Saw you there: a little
  // closer (O). Saw you smiling or relaxed: a little ease (E). Both only up, only O and E: never C (your looking tired is not a burden on her),
  // never A, never a dip (an empty seat or an unclear look writes nothing). They keep her reason (numbers only: no "最近原因" she could bring up).
  // The looks are already capped (10 minutes apart, 4 an hour); these gates cap the mood the same way every other moment is capped.
  // Seeing you there also eases her longing by 4 M points (about four hours of its growth). Not an interaction.
  'look-present': { delta: { O: 1 }, group: 'look-present', cooldownMs: 30 * MINUTE, perDay: 6, keepReason: true, longingEase: 4 },
  'look-smile': { delta: { E: 1 }, group: 'look-smile', cooldownMs: 30 * MINUTE, perDay: 6, keepReason: true },
  // I-104 (Unbound U2, docs/claude/2026-11-12-unbound-peek.md): she came up to the lens and you answered her within the window (talked to
  // her or clicked her): a little closer (O). Ignored: nothing. It is the same kind of happening as 松绑's spoke-answered (a bid of hers you
  // answered), so it shares that family's cooldown and day count: one answered bid per 20 minutes, never both for the same answer (Codex
  // T-246a: the O reward belongs to the interaction, not a second lift). Your words themselves still get their reply's own judgment as always.
  // Only O, only up; never A, B or M. Keeps her reason (numbers only).
  'peek-answered': { delta: { O: 1 }, group: 'spoke-answered', cooldownMs: 20 * MINUTE, perDay: 8, keepReason: true },
  // Unbound step 4 (afternoon addition C): the camera saw you wave to her, sure: a little closer (O), like facing her a while (I-081's
  // eye-contact), and in that same family (one cooldown and day count for both), so waving all afternoon is a few small lifts. A
  // "maybe" wave writes nothing. Only O, only up; keeps her reason (numbers only).
  waved: { delta: { O: 1 }, group: 'eye-contact', cooldownMs: 12 * MINUTE, perDay: 10, keepReason: true },
  // I-184: she kissed you (closeness and a little reward: O, D, a small ease E) or hugged you (closeness and calm, like held hands: O, C down,
  // E). Each its own family with a cooldown and a day count (her own ones are already rare: shared/unbound/close-moments/knobs.ts); they are
  // the reason (her 最近原因 says what happened, so her next turn sees it in her state as well as in its own line).
  kiss: { delta: { O: 2, D: 1, E: 0.5 }, group: 'kiss', cooldownMs: 20 * MINUTE, perDay: 6, keepReason: false, context: 'positive' },
  hug: { delta: { O: 1.5, C: -1, E: 1 }, group: 'hug', cooldownMs: 20 * MINUTE, perDay: 6, keepReason: false, context: 'positive' },
});

/**
 * A reply whose tail could not be used (missing, malformed, unconfident) used to leave her mood untouched. Now a tiny lift by the
 * label she has: the talk itself (a little O) and her mood's own direction, never more than 1. It stands in for Opus's share only
 * (the tail and this are never both applied for one message: one id per message).
 */
export const MOOD_TAILLESS_BY_LABEL: Readonly<Record<MoodLabel, Partial<MoodValues>>> = Object.freeze({
  calm: { O: 1 }, close: { O: 1, E: 0.5 }, content: { E: 1 }, happy: { D: 1, E: 0.5 }, excited: { D: 1, N: 0.5 },
  concerned: { O: 0.5 }, disappointed: { D: 0.5, O: 0.5 }, upset: { C: -0.5 }, longing: { O: 1 }, sad: { O: 0.5, E: 0.5 },
  relieved: { O: 0.5, E: 0.5 }, 'tense-expectation': { D: 0.5 }, afraid: { E: 0.5, C: -0.5 },
});
export const MOOD_TAILLESS: MoodMomentSpec = Object.freeze({ delta: {}, group: 'tailless', cooldownMs: MINUTE, perDay: 200, keepReason: true });

export const MOOD_MOMENT_KNOBS = Object.freeze({
  /** A return counts after at least this long away (I-066 awayMinutes, or the camera's absence). */
  backAwayMinutes: 10,
  /** A sleep counts when she slept (asleep or a micro-wake inside it) at least this long. */
  wakeMinSleepMs: 10 * MINUTE,
  /**
   * I-078 第 2 步: the user woke her (words, or touches and messages adding up) after at least this much real sleep, while her sleep
   * pressure A was still above restedA: "没睡够" (the woken lift). Woken at or below restedA she had slept enough: the ordinary wake lift.
   */
  wokenMinSleepMs: 2 * MINUTE,
  restedA: 0.3,
  /** A dance segment counts from this long; a nod-along from this long. */
  danceMinMs: 20_000,
  songMinMs: 45_000,
  /**
   * Relative to the card's baseline (moodLevel: 50 = at the baseline): a gain on a channel whose level is already at `soft` or
   * more is reduced linearly to nothing at `hard`; a drop mirrors it below the baseline (100 − soft, 100 − hard).
   */
  soft: 65,
  hard: 85,
  /** I-077 step 2: the factor her music taste may put on a music moment (the stage sends 0.7–1.3; the host holds it to this range). */
  tasteScale: [0.6, 1.4] as const,
});

/** The lift a moment gives now, read relative to the card's baseline (see MOOD_MOMENT_KNOBS.soft / hard). Channels at 0 are left out. */
export function relativeMomentDelta(delta: Partial<MoodValues>, values: MoodValues, baseline: MoodValues, evidence = 1,
  knobs: { soft: number; hard: number } = MOOD_MOMENT_KNOBS): Partial<MoodValues> {
  const out: Partial<MoodValues> = {};
  for (const [key, amount] of Object.entries(delta) as [keyof MoodValues, number][]) {
    if (!Number.isFinite(amount) || amount === 0) continue;
    const level = moodLevel(values[key], baseline[key], evidence);
    // How far past the soft line this channel already is, in the lift's own direction.
    const past = amount > 0 ? level - knobs.soft : (100 - knobs.soft) - level;
    const factor = past <= 0 ? 1 : Math.max(0, 1 - past / (knobs.hard - knobs.soft));
    const scaled = Math.round(amount * factor * 1000) / 1000;
    if (scaled !== 0) out[key] = scaled;
  }
  return out;
}

/** Local day key (the gate's per-day count). */
export function momentDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Each family's cooldown and per-day count, per character. Memory only (a restart starts the cooldowns again; ids still dedupe). */
export class MoodMomentGate {
  private readonly last = new Map<string, number>();
  private readonly days = new Map<string, { day: string; count: number }>();
  /** Whether this moment may happen now (no change). */
  allows(characterId: string, spec: MoodMomentSpec, now: number): boolean {
    const key = `${characterId}|${spec.group}`, last = this.last.get(key), day = this.days.get(key);
    if (last !== undefined && now >= last && now - last < spec.cooldownMs) return false;
    return !(day && day.day === momentDay(now) && day.count >= spec.perDay);
  }
  /** Takes the moment (true) or refuses it (false). */
  take(characterId: string, spec: MoodMomentSpec, now: number): boolean {
    if (!this.allows(characterId, spec, now)) return false;
    const key = `${characterId}|${spec.group}`, today = momentDay(now), day = this.days.get(key);
    this.last.set(key, now);
    this.days.set(key, day && day.day === today ? { day: today, count: day.count + 1 } : { day: today, count: 1 });
    return true;
  }
}

const SLEEPING = new Set(['asleep', 'micro-awake']);
/** Sleep → awake, once per real sleep: how long she slept (from the first sleeping phase seen, minus its age), or null. */
export class SleepWatch {
  private readonly since = new Map<string, number>();
  see(characterId: string, phase: string, phaseAgeMs: number, now: number): number | null {
    if (SLEEPING.has(phase)) {
      if (!this.since.has(characterId)) this.since.set(characterId, now - (phase === 'asleep' && Number.isFinite(phaseAgeMs) ? Math.max(0, phaseAgeMs) : 0));
      return null;
    }
    const from = this.since.get(characterId);
    if (from === undefined) return null;
    this.since.delete(characterId);
    return Math.max(0, now - from);
  }
}

/** The stage's music tier stream (none / nod / dance), one character at a time: a dance or a nod-along that ended. */
export class MusicWatch {
  private current: { characterId: string; tier: string; since: number } | null = null;
  see(characterId: string, tier: string, now: number, knobs = MOOD_MOMENT_KNOBS): { kind: 'dance' | 'song'; ms: number } | null {
    const held = this.current;
    if (held && held.characterId === characterId && held.tier === tier) return null;
    this.current = { characterId, tier, since: now };
    if (!held || held.characterId !== characterId) return null;
    const ms = Math.max(0, now - held.since);
    if (held.tier === 'dance' && ms >= knobs.danceMinMs) return { kind: 'dance', ms };
    if (held.tier === 'nod' && tier === 'none' && ms >= knobs.songMinMs) return { kind: 'song', ms };
    return null;
  }
}

/** I-066 presence: the first 'back' view of one return (not a pretended one) after at least backAwayMinutes. */
export class BackWatch {
  private wasBack = false;
  see(view: { presence?: string; awayMinutes?: number; pretended?: boolean } | null | undefined, knobs = MOOD_MOMENT_KNOBS): number | null {
    const back = view?.presence === 'back';
    const first = back && !this.wasBack;
    this.wasBack = back;
    if (!first || view?.pretended === true || typeof view?.awayMinutes !== 'number' || !(view.awayMinutes >= knobs.backAwayMinutes)) return null;
    return view.awayMinutes;
  }
}
