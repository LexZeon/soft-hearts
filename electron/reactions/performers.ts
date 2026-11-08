import type { MoodValues } from '../../shared/mood';
import type { MoodView } from '../../shared/mood-runtime';
import { isChatActionWord, type ChatActionWord } from '../../shared/chat-actions';
import { REACTION_KNOBS, type ReactionKnobs, type ReactionLevel } from '../../shared/behaviors/reactions/knobs';
import type { ReactionBlock, ReactionPerformed, ReactionPerformer } from '../../shared/behaviors/reactions/interface';
import type { ReactionStageAnswer, ReactionStageCue } from '../../shared/behaviors/reactions/stage';

/** What the performers use (electron/main.ts supplies closures; tests fakes). */
export interface ReactionPerformerPorts {
  /** The mood host (electron/mood.ts MoodHost), or null before it exists. */
  mood(): {
    get(): MoodView;
    reactionBlush(characterId: string, id: string, strength: number, floor?: number): ReactionPerformed;
    lift(lift: { id: string; delta: Partial<MoodValues>; reason: string }, characterId?: string): void;
  } | null;
  /** Her small actions (electron/chat-actions-host.ts): the words this model can do now (sync, cached) and one played by its rules. */
  actions(): { offered(): ChatActionWord[]; perform(word: ChatActionWord): Promise<{ played: boolean; status: string }> } | null;
  /**
   * One cue to the pet window's stage (src/stage/reaction-performers.ts plays it); false when the pet is not on screen. A promise is the
   * stage's own answer (electron/reactions/wiring.ts waits for desk:reactionResult); plain true means "sent" and is taken as done.
   */
  stage(cue: ReactionStageCue): boolean | Promise<ReactionStageAnswer>;
  knobs?: Partial<ReactionKnobs>;
}

const SLEEPING = new Set(['asleep', 'micro-awake']);
/** The mood host's own "can she do anything now" gates, shared by every performer. */
function moodGate(view: MoodView | null): ReactionBlock | null {
  if (!view?.characterId) return 'stale';
  if (!view.expressions) return 'off';
  if (SLEEPING.has(view.fatigue?.phase ?? '')) return 'asleep';
  return null;
}
/** She is in a pat, a pinch or a snack (the stage would fade a show out at once). */
const inContact = (view: MoodView) => view.snapshot.phase !== 'idle';

/** The happy lift's reason (kept as the mood's reason; fixed text). */
export const REACTION_HAPPY_REASON = '她一下子开心起来';

/**
 * I-037 的表现 (the `performer` keys of shared/behaviors/reactions/knobs.ts REACTION_TABLE). Each one says whether she can do it now
 * (gate: asked when scoring and again right before playing) and plays it. A new kind of reaction usually reuses one of these with
 * another row; a new performer is one more entry here (and, for a stage one, one more kind in src/stage/reaction-performers.ts).
 *
 * - blush: MoodHost.reactionBlush (the card's blush settings and #26's look; one at a time).
 * - happy: MoodHost.lift of D and E (knobs.happyLift by level, times the card's sensitivity): the face follows her mood.
 * - shy: a stage cue (desk:reaction); the pet window plays the model-agnostic shy show. It waits for her to be free of a pat or a
 *   snack (the host retries a 'busy' one for knobs.freeWaitMs).
 * - action: one of her seven small actions by the same rules as her own reply's pick (this model can do it, her mood lets it).
 */
export function createReactionPerformers(ports: ReactionPerformerPorts): Readonly<Record<string, ReactionPerformer>> {
  const knobs = { ...REACTION_KNOBS, ...ports.knobs };
  const view = (): MoodView | null => { try { return ports.mood()?.get() ?? null; } catch { return null; } };
  const current = (characterId: string): MoodView | null => { const v = view(); return v?.characterId === characterId ? v : null; };
  /** Shy attempts per reaction key (the last 32 keys). */
  const shyTries = new Map<string, number>();
  return Object.freeze({
    blush: {
      stage: false,
      gate: (_row, { characterId }) => {
        const v = current(characterId), blocked = moodGate(v);
        if (blocked || !v) return blocked ?? 'stale';
        if (!v.parameters.blush.enabled || !(v.parameters.blush.intensity > 0)) return 'card-off';
        if (v.snapshot.blush && v.snapshot.blush.until > v.snapshot.blush.at + v.snapshot.blush.ageMs) return 'showing';
        return null;
      },
      perform: (_row, level, { characterId, key }) => {
        const mood = ports.mood();
        if (!mood) return { done: false, why: 'stale' };
        return mood.reactionBlush(characterId, `reaction-blush-${key}`.slice(0, 160), knobs.blushStrength[level] ?? 0.8, knobs.blushFloor);
      },
    },
    happy: {
      stage: false,
      gate: (_row, { characterId }) => moodGate(current(characterId)),
      perform: (_row, level: ReactionLevel, { characterId, key }) => {
        const mood = ports.mood(), lift = knobs.happyLift[level];
        if (!mood || !lift) return { done: false, why: 'stale' };
        mood.lift({ id: `reaction-happy-${key}`.slice(0, 160), delta: { D: lift.D, E: lift.E }, reason: REACTION_HAPPY_REASON }, characterId);
        return { done: true };
      },
    },
    shy: {
      stage: true, durationMs: 3_000,
      gate: (_row, { characterId }) => {
        const v = current(characterId), blocked = moodGate(v);
        if (blocked || !v) return blocked ?? 'stale';
        if (!(v.snapshot.intensity.expression > 0) && !(v.snapshot.intensity.posture > 0)) return 'card-off';
        return inContact(v) ? 'busy' : null;
      },
      perform: async (_row, level, { characterId, key }) => {
        const v = current(characterId);
        if (!v) return { done: false, why: 'stale' };
        let answer: boolean | ReactionStageAnswer;
        // Each attempt its own cue id (the host retries a busy shy with the same key): a late answer to an earlier attempt can never
        // settle a later one (Codex X-345). The first attempt keeps the plain id.
        const tries = (shyTries.get(key) ?? 0) + 1;
        shyTries.set(key, tries);
        if (shyTries.size > 32) shyTries.delete(shyTries.keys().next().value!);
        const id = `reaction-shy-${key}`.slice(0, 150) + (tries > 1 ? `-r${tries}` : '');
        try { answer = await ports.stage({ id, kind: 'shy', level }); } catch { return { done: false, why: 'failed' }; }
        // What the stage really did: 'busy' (another show or a pat is on; the host retries) and 'unsupported' (this model has nothing to show) are not done.
        if (answer === true || answer === 'played') return { done: true };
        if (answer === false) return { done: false, why: 'hidden' };
        return { done: false, why: answer === 'busy' ? 'busy' : answer === 'unsupported' ? 'model' : 'failed' };
      },
    },
    action: {
      stage: true, durationMs: 1_600,
      gate: (row, { characterId }) => {
        const v = current(characterId), blocked = moodGate(v);
        if (blocked || !v) return blocked ?? 'stale';
        if (!isChatActionWord(row.arg)) return 'no-performer';
        let offered: ChatActionWord[] = [];
        try { offered = ports.actions()?.offered() ?? []; } catch { offered = []; }
        if (!offered.includes(row.arg)) return 'model';
        return inContact(v) ? 'busy' : null;
      },
      perform: async row => {
        const actions = ports.actions();
        if (!actions || !isChatActionWord(row.arg)) return { done: false, why: 'no-performer' };
        let result: { played: boolean; status: string };
        try { result = await actions.perform(row.arg); } catch { return { done: false, why: 'failed' }; }
        if (result.played || result.status === 'waiting') return { done: true };
        const why: ReactionBlock = result.status === 'cannot' ? 'model' : result.status === 'busy' || result.status === 'yielded' ? 'busy'
          : result.status === 'no-pet' ? 'hidden' : 'failed';
        return { done: false, why };
      },
    },
  } satisfies Record<string, ReactionPerformer>);
}
