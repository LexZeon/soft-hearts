/**
 * I-154 follow-up (docs/claude/2026-11-20-unbound-full-shares.md): her mood, out in full-screen Unbound, exactly as the companion window has
 * it. Only what the companion window already uses: the mood view (desk:mood, getMood) her face reads, the direct-touch mood input
 * (moodInteraction) a pat, a pinch or a snack at her mouth sends, and the model's capability record (getModelCapabilities,
 * desk:model-capabilities; read only) so her face follows your choices on the character page. No sense, no permission, no setting: the
 * views are what the companion window is told, and an input goes to the same mood host the companion window's goes to.
 *
 * The rules (the host's `handle` has already checked the request came from the current Unbound window's own top frame):
 *  - the views are read only by that window, and relayed to it whenever the companion windows get new ones (no other broadcast);
 *  - a touch's input is taken only from the window she is shown in, while it is visible (a full-screen program never hides her, I-199) and
 *    not forced click-through by a peek (the same as a click, electron/unbound/host.ts touch); the end of a session ("idle") only needs
 *    the window she is shown in, so a session she was hidden in still closes;
 *  - without the ports (tests, an older wiring) the requests are refused.
 * Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): the shown model's blush calibration (getBlushCalibration, desk:blush-calibration;
 * read only), and her voice's facts for her speaking face (a heard segment starts, its loudness, a stop): the window that plays her voice
 * hands them to the host (relaySpeechFace), they are checked by the companion's own rule (shared/voice/speech-face-cue.ts) and relayed
 * here only. Nothing of a sense: these are facts about her own voice, the same ones the companion windows tell each other.
 * Batches D, F (docs/claude/2026-11-21-unbound-full-D.md): her senses' readings out here (where pose says you are, the music samples), each
 * only while its source is on and only to the window she is shown in, and her facts about them back (sense-bridge.ts); 惊喜 / 害羞 from the
 * character page's preview buttons (desk:expression-preview, the closed recipe only).
 */
import { UNBOUND_EVENTS, UNBOUND_REQUESTS } from '../../shared/unbound/scene';
import { sanitizeSpeechFaceCue } from '../../shared/voice';
import { UnboundMotionBridge, type UnboundMotionPorts } from './motion-bridge';
import { UnboundSenseBridge, type UnboundSensePorts } from './sense-bridge';
import { UNBOUND_SENSE_EVENTS } from '../../shared/unbound/sense-relay';
import { isExpressionRecipe } from '../../shared/stage';

export interface UnboundMoodPorts {
  /** Her mood view now (the companion window's getMood). */
  get(): unknown;
  /** One direct-touch mood input (the companion window's moodInteraction; the mood host parses it); returns the new view. */
  interaction(input: unknown): unknown;
  /** The current model's capability record (the companion window's getModelCapabilities); absent: refused. */
  card?(): unknown;
  /** Batch A: the shown model's blush calibration (the companion window's getBlushCalibration); absent: refused. */
  blush?(): unknown;
  /** Batch C: her motions' reads and her answer (electron/unbound/motion-bridge.ts), once the actions part connected them; absent: refused. */
  motions?(): UnboundMotionPorts | null;
  /** Batches D, F: where her facts about your pose and the music go (electron/unbound/sense-bridge.ts); absent: refused. */
  senses?(): UnboundSensePorts | null;
}
/** The window as this bridge needs it (electron/unbound/host.ts UnboundWindowLike). */
export interface MoodBridgeWindow { isVisible(): boolean }
export interface MoodBridgeHost<W extends MoodBridgeWindow> {
  /** The current Unbound window (made, maybe still loading), or null. */
  current(): W | null;
  /** The window she is shown in now, or null. */
  shown(): W | null;
  /** She may be touched there now: not forced click-through by a peek (a full-screen program never hides her, I-199). */
  touchable(): boolean;
  send(win: W, channel: string, value: unknown): void;
}
type Handle<W> = (channel: string, operation: (win: W, ...args: unknown[]) => unknown) => void;

/** Batch A: the name the host relays her voice's facts under (never a broadcast: electron/wiring/unbound-wiring.ts relaySpeechFace). */
export const SPEECH_FACE_RELAY = 'unbound-relay:speech-face';
/** The broadcasts her window gets too: her mood view, a capability record that changed, the blush calibration, her voice's facts (read only; nothing else). */
const RELAYED: Readonly<Record<string, string>> = Object.freeze({ 'desk:mood': UNBOUND_EVENTS.mood, 'desk:model-capabilities': UNBOUND_EVENTS.modelCard,
  'desk:blush-calibration': UNBOUND_EVENTS.blushCalibration, [SPEECH_FACE_RELAY]: UNBOUND_EVENTS.speechFace,
  'desk:expression-preview': UNBOUND_SENSE_EVENTS.expressionPreview }); // batch D: 惊喜 / 害羞 from the character page's preview buttons

/** A session's end: never a reward, so it closes even after she was hidden. */
export const isTouchEnding = (value: unknown): boolean =>
  !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'phase' && (value as { phase?: unknown }).phase === 'idle';

export class UnboundMoodBridge<W extends MoodBridgeWindow> {
  private last: unknown = null;
  /** Batch C: her motions out here, by the same window rules (motion-bridge.ts). */
  private readonly motions: UnboundMotionBridge<W>;
  /** Batches D, F: where pose says you are and the music samples, while each is on, to the window she is shown in (sense-bridge.ts). */
  readonly senses: UnboundSenseBridge<W>;
  /** `ports` is read when a request comes (the wiring may give it after the host was made). */
  constructor(private readonly ports: () => UnboundMoodPorts | undefined, private readonly host: MoodBridgeHost<W>) {
    this.motions = new UnboundMotionBridge(() => this.ports()?.motions?.(), host);
    this.senses = new UnboundSenseBridge(() => this.ports()?.senses?.(), host);
  }

  register(handle: Handle<W>): void {
    this.motions.register(handle);
    this.senses.register(handle);
    handle(UNBOUND_REQUESTS.getModelCard, () => {
      const card = this.ports()?.card;
      if (!card) throw new Error('模型体检尚未接入。');
      return card();
    });
    handle(UNBOUND_REQUESTS.getBlushCalibration, () => {
      const blush = this.ports()?.blush;
      if (!blush) throw new Error('红晕校准尚未接入。');
      return blush();
    });
    handle(UNBOUND_REQUESTS.getMood, () => {
      const ports = this.ports();
      if (!ports) throw new Error('心情尚未接入。');
      return this.last ?? ports.get();
    });
    handle(UNBOUND_REQUESTS.moodInteraction, (win, value) => {
      const ports = this.ports();
      if (!ports) throw new Error('心情尚未接入。');
      if (!this.accepts(win, value)) throw new Error('只有正在显示、可以碰的 Unbound 窗口可以提交直接互动。');
      return ports.interaction(value);
    });
  }

  /** Whether a touch's input from `win` is taken now (exported for the test of each rule). */
  accepts(win: W, value: unknown): boolean {
    if (this.host.shown() !== win) return false;
    if (isTouchEnding(value)) return true;
    return win.isVisible() && this.host.touchable();
  }

  /** Every broadcast the windows get: a new mood view goes to the Unbound window too (and is what getMood answers next). */
  relay(channel: string, value: unknown): void {
    this.motions.relay(channel, value); // batch C: one of her actions
    if (this.senses.relay(channel, value)) return; // batches D, F: a sense relay never goes anywhere else
    const event = RELAYED[channel];
    if (event === UNBOUND_SENSE_EVENTS.expressionPreview) { if (isExpressionRecipe(value)) this.toCurrent(event, value); return; } // batch D: only the closed recipe
    if (!event || !value || typeof value !== 'object') return;
    if (event === UNBOUND_EVENTS.speechFace) { value = sanitizeSpeechFaceCue(value); if (!value) return; } // batch A: only a well-formed fact
    if (event === UNBOUND_EVENTS.mood) this.last = value;
    this.toCurrent(event, value);
  }
  private toCurrent(event: string, value: unknown): void {
    const win = this.host.current();
    if (win) this.host.send(win, event, value);
  }
}
