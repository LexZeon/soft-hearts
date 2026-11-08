import type { ChatGestureIntent } from './chat-gesture';
import type { MoodChannel, MoodContext, MoodCue, MoodEvent, MoodLabel, MoodPhase, MoodSnapshot, MoodTendency } from './mood';

/** These identities select a host-reviewed face recipe, never a path or permission. */
export const BEHAVIOR_FACE_BINDING_IDS = Object.freeze([
  'face.smile', 'face.embarrassed-smile', 'face.happy', 'face.laugh', 'face.compassion',
  'face.in-trouble', 'face.disappointed', 'face.disgust', 'face.sentimental', 'face.sad', 'face.convinced',
] as const);
export type BehaviorFaceBindingId = typeof BEHAVIOR_FACE_BINDING_IDS[number];
export type BehaviorFaceMotionId = BehaviorFaceBindingId extends `face.${infer Motion}` ? Motion : never;
export const MAX_BEHAVIOR_FACE_STRENGTH = 0.7;
export const MAX_BEHAVIOR_CUE_LIFETIME_MS = 11_500;
export const MAX_BEHAVIOR_CUE_AGE_MS = 1_500;

type ContinuousSemantic = 'breath-idle' | 'mouse-gaze' | 'blink' | 'speech-mouth' | 'rua-follow' | 'food-mouth'
  | 'mood-micro' | 'event-impact' | 'blush' | 'system-audio-dance' | 'motion-transition';
type GateSemantic = 'manual-gesture' | 'dynamic-pose' | 'manual-expression' | 'manual-head' | 'direct-contact'
  | 'speaking' | 'music' | 'expression-off-or-zero' | 'context-or-reply-invalid' | 'hidden-or-disposed'
  | 'preview-local' | 'window-camera-input';
export type BehaviorSemantic = `mood.${MoodLabel}` | `modifier.${MoodTendency | 'wistful'}` | `context.${MoodContext}`
  | `channel.${MoodChannel}` | `trend.${MoodChannel}` | `fast.${MoodChannel}.${'up' | 'down' | 'steady'}`
  | `phase.${MoodPhase | 'rua-hover'}` | `event.${MoodEvent['type']}`
  | `cue.${MoodCue['kind']}` | `blush.${'semantic' | 'closeness'}` | 'flag.crying-candidate'
  | `continuous.${ContinuousSemantic}` | `voice.${'calm' | 'happy' | 'comfort' | 'sad' | 'firm' | 'focused'}`
  | `manual.${'pose' | 'gesture' | 'expression'}` | `gate.${GateSemantic}` | `chat.${ChatGestureIntent}`
  | 'reserved.pinch.*' | 'reserved.physics.*' | 'reserved.vision-attention-chat';

export interface BehaviorSemanticEntry {
  readonly kind: 'state' | 'reaction' | 'modifier' | 'continuous' | 'gate' | 'manual' | 'reserved';
  readonly route: 'face' | 'chat-gesture' | 'procedural' | 'voice' | 'manual' | 'none';
  /** Exact selector output set for this semantic; the host resolver and property mask remain authoritative. */
  readonly bindingIds: readonly BehaviorFaceBindingId[];
  readonly fallback: string;
}
const entry = (kind: BehaviorSemanticEntry['kind'], route: BehaviorSemanticEntry['route'], fallback: string,
  bindingIds: readonly BehaviorFaceBindingId[] = []): BehaviorSemanticEntry =>
  Object.freeze({ kind, route, fallback, bindingIds: Object.freeze([...bindingIds]) });
const modifier = () => entry('modifier', 'procedural', 'Modify the accepted main feeling only; never start another clip.');
const channel = () => entry('modifier', 'procedural', 'Use the current channel level as state evidence, never as a new reaction event.');
const trend = () => entry('modifier', 'procedural', 'Use continuous accepted-event trend evidence; natural recovery creates no new reaction.');
const fast = () => entry('modifier', 'procedural', 'Use the thresholded fast direction to modify accepted evidence, never to start another clip.');
const gate = () => entry('gate', 'none', 'Yield or consume the optional performance without resetting manual actions or private state.');

/** Complete semantic coverage is not a claim that every entry has a VMD or a new capability. */
export const BEHAVIOR_SEMANTICS = Object.freeze({
  'mood.calm': entry('state', 'procedural', 'Keep the selected Stand/background and ordinary procedural idle.'),
  'mood.close': entry('state', 'face', 'Use the existing restrained pleasant feedback.',
    ['face.embarrassed-smile', 'face.compassion', 'face.disappointed', 'face.in-trouble', 'face.sentimental']),
  'mood.content': entry('state', 'face', 'Use the existing light smile/contact feedback.',
    ['face.smile', 'face.compassion', 'face.disappointed', 'face.in-trouble', 'face.sentimental']),
  'mood.happy': entry('state', 'face', 'Use the existing pleasant feedback without authored mouth or red tracks.',
    ['face.happy', 'face.compassion', 'face.disappointed', 'face.in-trouble', 'face.sentimental']),
  'mood.excited': entry('state', 'face', 'Use pleasant/playful feedback; never play the source body or a new chat gesture.',
    ['face.laugh', 'face.compassion', 'face.disappointed', 'face.in-trouble', 'face.sentimental']),
  'mood.concerned': entry('state', 'face', 'Keep serious feedback and suppress an unrelated broad smile.', ['face.compassion']),
  'mood.disappointed': entry('state', 'face', 'Keep the existing restrained sadness feedback.', ['face.disappointed']),
  'mood.upset': entry('state', 'face', 'Use caution unless offense is explicitly present; never infer anger from pressure alone.', ['face.disgust', 'face.in-trouble']),
  'mood.longing': entry('state', 'face', 'Keep longing feedback; no tears or embrace are implemented.', ['face.sentimental']),
  'mood.sad': entry('state', 'face', 'Keep the existing sadness feedback; no source body or tears.', ['face.sad']),
  'mood.relieved': entry('state', 'face', 'Preserve wistful or serious modifiers instead of forcing celebration.',
    ['face.smile', 'face.sentimental', 'face.compassion', 'face.disappointed', 'face.in-trouble']),
  'mood.tense-expectation': entry('state', 'face', 'Keep cautious feedback; expectation is not unconditional happiness.', ['face.in-trouble']),
  'modifier.playful': modifier(), 'modifier.close': modifier(), 'modifier.comfortable': modifier(),
  'modifier.cautious': modifier(), 'modifier.wistful': modifier(),
  'context.neutral': modifier(), 'context.positive': modifier(), 'context.support': modifier(),
  'context.concern': modifier(), 'context.disappointment': modifier(), 'context.offense': modifier(),
  'channel.D': channel(), 'channel.O': channel(), 'channel.E': channel(), 'channel.N': channel(), 'channel.C': channel(),
  'trend.D': trend(), 'trend.O': trend(), 'trend.E': trend(), 'trend.N': trend(), 'trend.C': trend(),
  'fast.D.up': fast(), 'fast.D.down': fast(), 'fast.D.steady': fast(),
  'fast.O.up': fast(), 'fast.O.down': fast(), 'fast.O.steady': fast(),
  'fast.E.up': fast(), 'fast.E.down': fast(), 'fast.E.steady': fast(),
  'fast.N.up': fast(), 'fast.N.down': fast(), 'fast.N.steady': fast(),
  'fast.C.up': fast(), 'fast.C.down': fast(), 'fast.C.steady': fast(),
  'phase.idle': entry('state', 'procedural', 'Continue the current mood/background without restarting its timeline.'),
  'phase.rua-hover': entry('continuous', 'procedural', 'Legacy compatibility marker; current input enters contact immediately and does not emit a dwell phase.'),
  'phase.rua': entry('continuous', 'procedural', 'Keep actual bounded pointer/spring and contact eyelid feedback.'),
  'phase.cheek': entry('continuous', 'procedural', 'Keep the bounded direct cheek drag and independent head/body return; no automatic clip or extra reward.'),
  'phase.food-wait': entry('continuous', 'procedural', 'Keep the current background; no receiving or eating clip exists.'),
  'phase.food-ready': entry('continuous', 'procedural', 'Use the prepared mouth channel, yielding to speaking and manual mouth tracks.'),
  'phase.food-eating': entry('reaction', 'procedural', 'Keep the accepted-image display; no chewing/swallowing animation exists.'),
  'event.rua': entry('modifier', 'procedural', 'Advance existing contact feedback; never start a clip for each measured batch.'),
  'event.food': entry('reaction', 'procedural', 'Consume the original accepted delivery once; no animation reward.'),
  'event.chat': entry('reaction', 'procedural', 'Preserve the accepted turn; do not invent completed reply semantics.'),
  'event.appraisal': entry('modifier', 'procedural', 'Update state from accepted completed semantics without another user response.'),
  'event.phase': entry('gate', 'none', 'Update the existing phase without a reward or standalone clip.'),
  'event.attention': entry('reaction', 'procedural', 'Consume only the existing host-issued cue and quota.'),
  // Acknowledgement can reflect every main feeling, plus calm's neutral confirmation.
  'cue.satisfied': entry('reaction', 'face', 'Acknowledge the actual feeling; suppress during direct interaction, never force happiness.',
    ['face.smile', 'face.embarrassed-smile', 'face.happy', 'face.laugh', 'face.compassion', 'face.in-trouble',
      'face.disappointed', 'face.disgust', 'face.sentimental', 'face.sad', 'face.convinced']),
  'cue.reunion': entry('reaction', 'face', 'Keep serious/wistful feedback; no tears or embrace resource exists.',
    ['face.smile', 'face.embarrassed-smile', 'face.happy', 'face.laugh', 'face.compassion', 'face.in-trouble',
      'face.disappointed', 'face.disgust', 'face.sentimental', 'face.sad']),
  // #11 (shared/behaviors/idle-gesture/): a look or small motion picks its own face (or none) from her mood and card.
  'cue.look': entry('reaction', 'face', 'Keep the existing attention/gaze envelope; a face only when the idle gesture picked one.',
    ['face.convinced', 'face.smile', 'face.embarrassed-smile', 'face.happy', 'face.compassion', 'face.disappointed', 'face.in-trouble', 'face.disgust', 'face.sentimental', 'face.sad']),
  'cue.motion': entry('reaction', 'face', 'Keep the existing micro attention if the restricted confirmation face is unavailable.',
    ['face.convinced', 'face.smile', 'face.embarrassed-smile', 'face.happy', 'face.compassion', 'face.disappointed', 'face.in-trouble', 'face.disgust', 'face.sentimental', 'face.sad']),
  'cue.speech': entry('reaction', 'procedural', 'Keep the existing one local bubble; no additional speech, model or vision request.'),
  'blush.semantic': entry('continuous', 'procedural', 'Keep the original accepted-event blush envelope and calibration.'),
  'blush.closeness': entry('continuous', 'procedural', 'Keep the original accepted-rua crossing and cooldown; no new blush event.'),
  'flag.crying-candidate': entry('modifier', 'none', 'State observation only; no reviewed crying/tear resource.'),
  'continuous.breath-idle': entry('continuous', 'procedural', 'Keep the original bounded breath and relaxed idle clock.'),
  'continuous.mouse-gaze': entry('continuous', 'procedural', 'Keep real pointer projection/damping; no look clip replaces input.'),
  'continuous.blink': entry('continuous', 'procedural', 'Keep natural blink/contact composition without double-writing eyelids.'),
  'continuous.speech-mouth': entry('continuous', 'procedural', 'Keep the existing speaking mouth; not phoneme synchronization.'),
  'continuous.rua-follow': entry('continuous', 'procedural', 'Keep real position/velocity feedback and manual VMD clocks.'),
  'continuous.food-mouth': entry('continuous', 'procedural', 'Keep the prepared-mouth channel; not a chewing/receiving resource.'),
  'continuous.mood-micro': entry('continuous', 'procedural', 'Remain the fallback on properties not owned by an eligible face recipe.'),
  'continuous.event-impact': entry('modifier', 'procedural', 'Use accepted event identity/age; no event for display or natural recovery.'),
  'continuous.blush': entry('continuous', 'procedural', 'Keep the host blush envelope; automatic face clips cannot bypass it.'),
  'continuous.system-audio-dance': entry('continuous', 'procedural', 'Keep explicit local loopback energy offsets; no new capture or long dance.'),
  'continuous.motion-transition': entry('continuous', 'procedural', 'Keep the existing display bridge without owning any Action clock.'),
  'voice.calm': entry('modifier', 'voice', 'Use the existing frozen completed-reply voice style; preserve voice and consent.'),
  'voice.happy': entry('modifier', 'voice', 'Use the existing frozen completed-reply voice style; preserve voice and consent.'),
  'voice.comfort': entry('modifier', 'voice', 'Use the existing frozen completed-reply voice style; preserve voice and consent.'),
  'voice.sad': entry('modifier', 'voice', 'Use the existing frozen completed-reply voice style; preserve voice and consent.'),
  'voice.firm': entry('modifier', 'voice', 'Use the existing frozen completed-reply voice style; preserve voice and consent.'),
  'voice.focused': entry('modifier', 'voice', 'Use the existing frozen completed-reply voice style; preserve voice and consent.'),
  'manual.pose': entry('manual', 'manual', 'Keep the selected pose and its original Action progress.'),
  'manual.gesture': entry('manual', 'manual', 'Keep the selected gesture and its original Action progress.'),
  'manual.expression': entry('manual', 'manual', 'Keep the selected expression and its original Action progress.'),
  'gate.manual-gesture': gate(), 'gate.dynamic-pose': gate(), 'gate.manual-expression': gate(), 'gate.manual-head': gate(),
  'gate.direct-contact': gate(), 'gate.speaking': gate(), 'gate.music': gate(), 'gate.expression-off-or-zero': gate(),
  'gate.context-or-reply-invalid': gate(), 'gate.hidden-or-disposed': gate(), 'gate.preview-local': gate(), 'gate.window-camera-input': gate(),
  'chat.none': entry('reaction', 'none', 'Keep the reply with no invented gesture or reward.'),
  'chat.explain': entry('reaction', 'chat-gesture', 'Delegate to the single existing validated M004 upper-body player.'),
  'chat.consider': entry('reaction', 'chat-gesture', 'Delegate to the single existing restrained M004 upper-body player.'),
  'chat.upbeat': entry('reaction', 'chat-gesture', 'Delegate to the single existing context-gated M004 upper-body player.'),
  'reserved.pinch.*': entry('reserved', 'none', 'Authored pinch-motion recipes remain reserved; direct cheek input and bounded procedural response use phase.cheek in the independent interaction module.'),
  'reserved.physics.*': entry('reserved', 'none', 'Reserved only; no local physics or performance setting is enabled.'),
  'reserved.vision-attention-chat': entry('reserved', 'none', 'Reserved only; no capture, idle model call or message permission.'),
} satisfies Record<BehaviorSemantic, BehaviorSemanticEntry>);

export function isBehaviorFaceBindingId(value: unknown): value is BehaviorFaceBindingId {
  return typeof value === 'string' && (BEHAVIOR_FACE_BINDING_IDS as readonly string[]).includes(value);
}
export function isBehaviorSemantic(value: unknown): value is BehaviorSemantic {
  return typeof value === 'string' && Object.hasOwn(BEHAVIOR_SEMANTICS, value);
}

export interface BehaviorMotionCue {
  id: string;
  kind: 'state' | 'reaction';
  bindingId: BehaviorFaceBindingId;
  semantic: BehaviorSemantic;
  at: number;
  expiresAt: number;
  strength: number;
  stateKey: string;
}
export interface BehaviorMotionPlan { state: BehaviorMotionCue | null; reaction: BehaviorMotionCue | null }
export interface BehaviorMotionResource {
  cueId: string;
  bindingId: BehaviorFaceBindingId;
  packId: 'gene';
  motionId: BehaviorFaceMotionId;
  sha256: string;
  durationMs: number;
  url: string;
  recipe: 'emotion-face';
}
export interface BehaviorStateSelection {
  bindingId: BehaviorFaceBindingId | null;
  /** Qualitative identity only; numeric intensity, revision and time never restart a state. */
  key: string;
  semantic: BehaviorSemantic;
  strength: number;
  reason: string;
}
/** #11: the face the idle gesture (shared/behaviors/idle-gesture/) picked for one look or motion cue; null = no face clip. */
export interface BehaviorIdleFace { cueId: string; bindingId: BehaviorFaceBindingId | null }
export interface BehaviorReactionSelection extends BehaviorStateSelection {
  bindingId: BehaviorFaceBindingId;
  sourceEventId: string;
  at: number;
  expiresAt: number;
}

const STATE_BINDINGS = Object.freeze({
  calm: null, close: 'face.embarrassed-smile', content: 'face.smile', happy: 'face.happy', excited: 'face.laugh',
  concerned: 'face.compassion', disappointed: 'face.disappointed', upset: 'face.in-trouble', longing: 'face.sentimental',
  sad: 'face.sad', relieved: 'face.smile', 'tense-expectation': 'face.in-trouble',
} satisfies Record<MoodLabel, BehaviorFaceBindingId | null>);
const SERIOUS = new Set<MoodLabel>(['concerned', 'disappointed', 'upset', 'longing', 'sad', 'tense-expectation']);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
export function expressionStrength(snapshot: MoodSnapshot, reaction = false): number {
  const intensity = snapshot.intensity.expression;
  if (!Number.isFinite(intensity) || intensity <= 0) return 0;
  const modifier = snapshot.companion === 'wistful' ? 0.8 : snapshot.companion === 'cautious' ? 0.9 : 1;
  return clamp((reaction ? 0.4 : 0.34) * clamp(intensity, 0, 100) / 50 * modifier, 0, MAX_BEHAVIOR_FACE_STRENGTH);
}

/** One pass through original source timing, then procedural fallback. No held frame or loop. */
export function selectBehaviorState(snapshot: MoodSnapshot): BehaviorStateSelection {
  const primary: MoodLabel = Object.hasOwn(STATE_BINDINGS, snapshot.primary) ? snapshot.primary : 'calm';
  const semantic: BehaviorSemantic = `mood.${primary}`;
  let bindingId: BehaviorFaceBindingId | null = STATE_BINDINGS[primary];
  let reason = bindingId ? 'One original-timing restricted face pass; then existing procedural feedback.'
    : 'Calm keeps the selected background and procedural idle; no reset clip.';
  if (bindingId) {
    if (snapshot.context === 'concern' && !SERIOUS.has(primary)) bindingId = 'face.compassion';
    else if (snapshot.context === 'disappointment' && !SERIOUS.has(primary)) bindingId = 'face.disappointed';
    else if (snapshot.context === 'offense') bindingId = primary === 'upset' ? 'face.disgust' : SERIOUS.has(primary) ? bindingId : 'face.in-trouble';
    if (primary === 'upset' && snapshot.context === 'offense') bindingId = 'face.disgust';
    if (snapshot.companion === 'wistful' && !SERIOUS.has(primary)
      && !['concern', 'disappointment', 'offense'].includes(snapshot.context)) bindingId = 'face.sentimental';
  }
  const strength = expressionStrength(snapshot);
  if (!strength) { bindingId = null; reason = 'Expression intensity is zero or invalid; keep existing non-emotional channels.'; }
  return { bindingId, key: `${semantic}|${bindingId ?? 'procedural'}|${snapshot.companion ?? 'none'}`,
    semantic, strength: bindingId ? strength : 0, reason };
}

/**
 * Snapshot cues are already filtered by the host clock. This selector only copies
 * that accepted identity/window; the host must recheck expiry and consume cues
 * even when local interaction or renderer occupancy prevents their playback.
 */
export function selectBehaviorReaction(snapshot: MoodSnapshot, idle?: BehaviorIdleFace | null): BehaviorReactionSelection | null {
  const cue = snapshot.cue;
  // #11: the face the idle gesture picked for exactly this look or motion cue (null: no face clip this time).
  const picked = !!idle && !!cue && (cue.kind === 'look' || cue.kind === 'motion') && idle.cueId === cue.id
    && (idle.bindingId === null || isBehaviorFaceBindingId(idle.bindingId));
  if (!cue || snapshot.phase !== 'idle' || typeof cue.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(cue.id)
    || !Number.isFinite(cue.at) || !Number.isFinite(cue.until) || cue.at < 0 || cue.until <= cue.at
    || !(['satisfied', 'reunion', 'motion'].includes(cue.kind) || picked)) return null;
  const strength = expressionStrength(snapshot, true);
  if (!strength) return null;
  if (picked) {
    if (idle!.bindingId === null) return null;
    return { bindingId: idle!.bindingId, key: `cue.${cue.kind}|${cue.id}`, semantic: `cue.${cue.kind}` as BehaviorSemantic, strength,
      reason: 'One accepted cue only; the idle gesture picked this face from her mood and card (shared/behaviors/idle-gesture/).',
      sourceEventId: cue.id, at: cue.at, expiresAt: cue.until };
  }
  const state = selectBehaviorState(snapshot);
  let bindingId = state.bindingId ?? 'face.convinced';
  if (cue.kind === 'reunion') {
    if (snapshot.context === 'concern') bindingId = 'face.compassion';
    else if (snapshot.context === 'disappointment') bindingId = 'face.disappointed';
    else if (snapshot.context === 'offense') bindingId = snapshot.primary === 'upset' ? 'face.disgust' : 'face.in-trouble';
    else if (SERIOUS.has(snapshot.primary)) bindingId = state.bindingId ?? 'face.in-trouble';
    else bindingId = snapshot.companion === 'wistful' ? 'face.sentimental' : state.bindingId ?? 'face.smile';
  } else if (cue.kind === 'motion') {
    bindingId = SERIOUS.has(snapshot.primary) || ['concern', 'disappointment', 'offense'].includes(snapshot.context)
      ? state.bindingId ?? 'face.in-trouble' : 'face.convinced';
  } else if (!state.bindingId && ['concern', 'disappointment', 'offense'].includes(snapshot.context)) {
    bindingId = snapshot.context === 'concern' ? 'face.compassion'
      : snapshot.context === 'disappointment' ? 'face.disappointed' : 'face.in-trouble';
  }
  return { bindingId, key: `cue.${cue.kind}|${cue.id}`, semantic: `cue.${cue.kind}`, strength,
    reason: 'One accepted cue only; no new reward, speech, body gesture, held frame or loop.',
    sourceEventId: cue.id, at: cue.at, expiresAt: cue.until };
}
