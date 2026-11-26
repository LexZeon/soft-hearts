/**
 * I-154 batch 5 (rows 30–32, docs/claude/2026-11-20-unbound-window-batch5.md): her one-shot clips on Unbound's figure in the companion
 * window, at the mixer's level (UnboundFigure.setMotionLayer): the chat gesture (ChatGesturePlayer), her body actions (HerActionPlayer),
 * the automatic body motion (BodyMotionController with BehaviorBodyPlayer, inside the figure's own mixer) and the behaviour faces
 * (BehaviorMotionPlayer). The same players as the companion's own stage, the same rules; what differs is where they sit:
 *  - they write right after the figure's mixer (and its clip-switch bridge), so the figure's residuals (breath, the look, the idle's
 *    springs, the arm reach), her feet and IK, the grants (付与) and physics all ride on what they show;
 *  - her actions' grant children are left to the figure (it solves the grants after this layer, from the final arm), so the action player
 *    gets the skeleton without its grant table (otherwise the children would turn twice);
 *  - the companion's stage has a display guard behind every writer that catches a cut; this engine has none, so nothing here may cut on
 *    screen: a chat gesture or an automatic body motion that must give way hands the pose it showed last back to the running base through
 *    one bridge (the companion's MotionTransition, sized by the correction, R29c/R29d), exactly as the old stage's handOffToBase does. The
 *    bridge leaves at the speed the pose had (ShownRates over what this layer showed on its last two frames; the old stage reads its display
 *    guard's), so a gesture that gives way while its wrist turns 2–3° a frame no longer stops dead (2026-11-21-motion-handback-velocity.md).
 *    Her actions give way by their own smooth yield. Only a hidden window or a model going away stops at once (nothing is on screen).
 * Every frame: restore() (the bridge, then the players, last written first) → beforeUpdate() (the body motion's mixer weights) → the
 * figure's mixer → frame() (the players over the base, then the bridge over them) → the figure's residuals.
 */
import type { SkinnedMesh } from 'three';
import { ChatGesturePlayer, MotionTransition, ShownRates, handoffDurationMs, type BehaviorMotionPlayer, type BodyMotionController, type BodyStageGates,
  type MotionPoseSnapshot, type PoseRates } from '../../stage';
import { HerActionPlayer } from '../../initiative';
import type { FigureMotionLayer } from '../figure';

/** The automatic body motion's gates while nothing has been told yet: closed. */
export const CLOSED_BODY_GATES: BodyStageGates = Object.freeze({ ready: false, enabled: false, visible: false, manualPose: false, manualGesture: false,
  manualExpression: false, manualHead: false, dynamicPose: false, cameraOrWindow: false, inputBlocked: false, directContact: false, music: false,
  speaking: false, waitingForReply: false, chatGesture: false });

/** The skeleton as the action player sees it here: the bones, no grant table (the figure solves the grants after this layer). */
export function withoutGrants(mesh: SkinnedMesh): SkinnedMesh {
  return { skeleton: mesh.skeleton, geometry: { userData: {} } } as unknown as SkinnedMesh;
}

export class WindowClips implements FigureMotionLayer {
  readonly chat: ChatGesturePlayer;
  readonly action: HerActionPlayer;
  /** Row 32: the behaviour faces and the automatic body motion (made by window-motions.ts once the model is known). */
  behavior: BehaviorMotionPlayer | null = null;
  body: BodyMotionController | null = null;
  /** The automatic body motion's track names now (its player's), for what may have to be handed back. */
  bodyTracks: () => readonly string[] = () => [];
  bodyGates: BodyStageGates = CLOSED_BODY_GATES;
  /** Her action this frame: give way (smoothly), or stop at once (hidden). */
  actionGate = { yield: false, cut: false };
  private readonly bridge: MotionTransition;
  private readonly bridged = new Set<string>();
  /** What the layer showed at the end of its last frame, for every track that may be handed back (and what the bridge carries). */
  private shown = new Map<string, number[]>();
  /** How fast each of those was moving (its last two frames): the bridge starts at that speed. */
  private readonly rates = new ShownRates();
  private queued: { shown: MotionPoseSnapshot; tracks: readonly string[]; rates: PoseRates }[] = [];
  private inFrame = false;
  private chatYield = false;
  private disposed = false;

  /** `now`: the wall clock the automatic body motion's cue times are on (Date.now; a test's own clock). */
  constructor(private readonly mesh: SkinnedMesh, private readonly now: () => number = Date.now) {
    this.chat = new ChatGesturePlayer(mesh);
    this.action = new HerActionPlayer(withoutGrants(mesh));
    this.bridge = new MotionTransition(mesh);
  }

  /** 0..1: how much of her arms the clips hold (the figure keeps the arms it would lower itself up by as much). */
  get armsHeld(): number {
    const action = this.action.getState();
    return Math.max(this.chat.getState().weight, action.mode === 'arms' ? action.weight : 0);
  }
  /** A clip or the hand-back bridge is showing (the frame pace stays full). */
  get moving(): boolean { return this.chat.getState().active || this.action.active || this.bridge.getState().active || this.bodyTracks().length > 0; }
  get bridging(): boolean { return this.bridge.getState().active; }
  /** The hand-back bridge's state (the developer readout, window-readouts.ts). */
  bridgeState() { return this.bridge.getState(); }

  /** The chat gesture gives way on the next frame: the pose it showed is handed back to the base (never a cut). */
  yieldChat(): void { if (this.chat.getState().active) this.chatYield = true; }

  /**
   * Hands back what `tracks` showed on the last frame to whatever runs under them now: `stop` ends the owner at once (synchronously, as
   * the body motion's controller requires), the bridge carries the shown pose to the base. Between frames the bridge starts on the next one.
   */
  handOff(tracks: readonly string[], stop: () => void): void {
    const shown = this.snapshot(tracks), rates = this.rates.lookup(shown?.values.keys() ?? []);
    stop();
    if (!shown || this.disposed) return;
    if (this.inFrame) this.startBridge(shown, tracks, rates); else this.queued.push({ shown, tracks: [...tracks], rates });
  }

  restore(): void {
    this.inFrame = true;
    this.bridge.restore();
    this.behavior?.restore(); this.action.restore(); this.chat.restore();
    for (const next of this.queued.splice(0)) this.startBridge(next.shown, next.tracks, next.rates);
  }

  beforeUpdate(delta: number): void { this.body?.beforeUpdate(delta, this.now(), this.bodyGates); }

  frame(delta: number): void {
    if (this.chatYield) {
      this.chatYield = false;
      const state = this.chat.getState();
      if (state.active) this.handOff(state.trackNames, () => this.chat.cancel({ immediate: true }));
    }
    this.chat.frame(delta, { blocked: false });
    this.action.frame(delta, this.actionGate);
    this.behavior?.frame(delta);
    this.bridge.frame(delta);
    if (!this.bridge.getState().active) this.bridged.clear();
    this.remember(delta);
    this.inFrame = false;
  }

  /** Hidden, or the model goes away: everything stops at once (nothing is on screen to cut). */
  stopAll(): void {
    this.chat.cancel({ immediate: true });
    this.action.cancel({ immediate: true });
    this.behavior?.stop();
    this.body?.cancel(true);
    this.bridge.restore(); this.bridge.start({ mesh: this.mesh, values: new Map() }, [], 0);
    this.bridged.clear(); this.queued = []; this.shown.clear(); this.rates.clear(); this.chatYield = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopAll();
    this.disposed = true;
    this.chat.dispose(); this.action.dispose(); this.behavior?.dispose(); this.body?.dispose(); this.bridge.dispose();
    this.behavior = null; this.body = null;
  }

  private startBridge(shown: MotionPoseSnapshot, tracks: readonly string[], rates: PoseRates): void {
    // What the bridge carries already comes along, from what it showed (start() rebuilds every property from this snapshot).
    const names = [...new Set([...this.bridged, ...tracks])].filter(name => shown.values.has(name));
    if (!names.length) return;
    if (this.bridge.start(shown, names, handoffDurationMs, rates)) for (const name of names) this.bridged.add(name);
  }

  private snapshot(tracks: readonly string[]): MotionPoseSnapshot | null {
    const values = new Map<string, readonly number[]>();
    for (const name of new Set([...tracks, ...this.bridged])) { const value = this.shown.get(name); if (value) values.set(name, value); }
    return values.size ? { mesh: this.mesh, values } : null;
  }

  /** The tracks that may be handed back next, as shown now (only while something could be), and how fast they move. */
  private remember(delta: number): void {
    const names = new Set<string>([...this.chat.getState().trackNames, ...this.bodyTracks(), ...this.bridged]);
    this.shown.clear();
    for (const name of names) {
      const match = /^\.bones\[(.+)\]\.(quaternion|position)$/.exec(name);
      const bone = match ? this.boneOf(match[1]) : null;
      if (bone && match) this.shown.set(name, bone[match[2] as 'quaternion' | 'position'].toArray());
    }
    this.rates.record(this.shown, delta);
  }
  private bones: Map<string, SkinnedMesh['skeleton']['bones'][number]> | null = null;
  private boneOf(name: string) {
    if (!this.bones) { this.bones = new Map(); for (const bone of this.mesh.skeleton.bones) if (!this.bones.has(bone.name)) this.bones.set(bone.name, bone); }
    return this.bones.get(name) ?? null;
  }
}
