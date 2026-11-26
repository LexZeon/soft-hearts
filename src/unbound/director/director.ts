/**
 * Unbound U2, layer 1 in the page (docs/claude/2026-11-12-unbound-peek.md): the director plays what the host decided, live, beat
 * by beat, from her actual body. Each frame it asks the current performance for this frame's intent, asks the generator (layer
 * 2) for pose targets for it, and hands those to the figure (layer 3). It never writes a bone.
 *
 * Actions plug in as `DirectorAction`s (today only peek-lens, peek-lens.ts): each one turns a host command into a Performance.
 * Cancelling is the director's job, at any beat (shared/unbound/action-ends): never the mouse moving, typing or
 * the keys; a large pull on her (`yieldTo`: it ends the performance and the pull owns where she stands from then on), a game (the host's
 * cancel), a full-screen program, or the host's timeout. A reply starting never backs her off ("撑了1.5秒左右"). A cancel never stops her
 * where she is: the performance goes on to its own way back ("禁止只是不开始新的动作，不是定住").
 */
import { QUIET_CUE, type ChatCue, type DirectorActionId, type PeekCancelReason, type PeekCommand, type PeekPhase, type PeekReport } from '../../../shared/unbound/director';
import { REST_TARGETS, type BodySense, type MotionGenerator, type MotionIntent, type PoseTargets } from '../motion/generator';
import type { LensView } from '../motion/lens-align';
import type { SpeechBeat } from './speech-beat';

/** What the director knows of the world each frame. `home`: where the scene wants her (she goes back there afterwards). */
export interface DirectorWorld { lens: LensView; home: { x: number; z: number } }
export interface DirectorBody { readonly sense: BodySense | null; setPoseTargets(targets: PoseTargets): void; readonly intentIdle: boolean }

/** One running action. */
export interface Performance {
  readonly id: string;
  readonly phase: PeekPhase;
  /** The intent for this frame (advances the performance's own clock by `dt`). */
  next(dt: number, world: DirectorWorld, sense: BodySense | null, body: DirectorBody): { intent: MotionIntent; t: number };
  cancel(reason: PeekCancelReason): void;
  readonly cancelled: PeekCancelReason | null;
  /** 2026-11-23: a large pull took her: from now on she is not walked anywhere by this performance (the pull owns where she stands). */
  yieldPlace?(): void;
  /** I-192 follow-up: what the host should know of what played (whether her arms can move here), sent with each report. */
  readonly extra?: Pick<PeekReport, 'arms'>;
  /** I-203: a frame her reply reached (a kiss or a hug from her reply only: close-moment.ts). */
  frame?(word: 'let-go' | 'pause', seconds: number): void;
}
export interface DirectorAction {
  readonly id: DirectorActionId;
  begin(command: Extract<PeekCommand, { type: 'start' }>, world: DirectorWorld, sense: BodySense | null): Performance;
}

export class Director {
  private performance: Performance | null = null;
  private lastPhase: PeekPhase | null = null;
  private clock = 0;
  private cue: ChatCue = { ...QUIET_CUE };
  private resting = true;
  /** The last peek's id (a click on her after it still counts as answering it). */
  lastId: string | null = null;
  /** E3: her body was measured and standing on the last frame (the opening beat waits for neither a walk nor a missing body). */
  private body = { ready: false, moving: false };

  /** `speech`: E3's opening beat (speech-beat.ts), when the page has one; it only plays while its own switch is on. */
  constructor(private readonly actions: readonly DirectorAction[], private readonly generator: MotionGenerator, private readonly report: (report: PeekReport) => void,
    readonly speech: SpeechBeat | null = null) {}

  get active(): boolean { return !!this.performance; }
  get phase(): PeekPhase | null { return this.performance?.phase ?? null; }
  /** I-203: how far the running performance asks the viewer's eye (the camera) to dip (m, ≥ 0; the kiss only). The floor framing eases it. */
  get cameraDipM(): number { const dip = (this.performance as { cameraDipM?: number } | null)?.cameraDipM; return typeof dip === 'number' && dip > 0 ? dip : 0; }
  get cancelled(): PeekCancelReason | null { return this.performance?.cancelled ?? null; }

  /** The host's commands (already parsed and bounded by the caller). */
  command(command: PeekCommand, world: DirectorWorld): void {
    if (command.type === 'cancel') { if (this.performance?.id === command.id) this.cancel(command.reason); return; }
    if (command.type === 'frame') { if (this.performance?.id === command.id) this.performance.frame?.(command.frame, command.seconds); return; } // I-203
    if (this.performance) return; // one at a time; the host never sends a second
    const action = this.actions.find(a => a.id === command.plan.action);
    if (!action) return;
    this.speech?.interrupt('peek');
    this.generator.reset();
    this.performance = action.begin(command, world, null);
    this.lastId = command.id;
    this.resting = false;
    this.lastPhase = null;
  }

  /** Live cues from the chat side. I-192: a reply starting mid-peek no longer backs her off (she holds while she speaks, up to the cap). */
  setCue(cue: ChatCue): void {
    const starting = cue.speaking && !this.cue.speaking;
    this.cue = { ...cue };
    // E3: a reply's first words start the opening beat (when its switch is on, she is standing, and no peek is on: then she just speaks).
    if (starting && this.speech && this.speech.begin(cue.replyId ?? null, this.body, !!this.performance)) { this.generator.reset(); this.resting = false; }
  }
  get currentCue(): ChatCue { return this.cue; }

  /**
   * 2026-11-23: a large pull on her (the interruption arbiter: shared/unbound/action-ends) ends what plays and hands her to the pull: the
   * performance is cancelled ('pull', reported: she is told next turn) and stops placing her, wherever it is (its way back eases her face
   * and body back while the pull walks her).
   */
  yieldTo(reason: 'pull'): void {
    const p = this.performance;
    if (!p) return;
    p.yieldPlace?.();
    this.cancel(reason);
  }

  cancel(reason: PeekCancelReason): void {
    const p = this.performance;
    if (!p || p.cancelled || p.phase === 'back' || p.phase === 'settle' || p.phase === 'done') return;
    p.cancel(reason);
    this.send();
  }

  /** One frame: the performance's intent → the generator's targets → the figure. Nothing while idle (her own life goes on). */
  frame(dt: number, world: DirectorWorld, body: DirectorBody): void {
    this.clock += Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    const p = this.performance;
    const measured = body.sense;
    this.body = { ready: !!measured, moving: !!measured?.moving };
    if (!p) {
      const intent = this.speech?.next(dt, this.cue.speaking, world.lens, measured) ?? null; // E3: the opening beat, while it plays
      if (intent && measured) { body.setPoseTargets(this.generator.generate({ intent, t: this.speech!.clock, dt, sense: measured })); this.resting = false; return; }
      if (!this.resting) { body.setPoseTargets({ ...REST_TARGETS }); this.resting = true; }
      return;
    }
    const sense = body.sense;
    const { intent, t } = p.next(dt, world, sense, body);
    if (sense) body.setPoseTargets(this.generator.generate({ intent, t, dt, sense }));
    if (p.phase !== this.lastPhase) this.send();
    if (p.phase === 'done') { this.performance = null; body.setPoseTargets({ ...REST_TARGETS }); this.resting = true; }
  }

  private send(): void {
    const p = this.performance;
    if (!p) return;
    this.lastPhase = p.phase;
    try { this.report({ id: p.id, phase: p.phase, ...(p.cancelled ? { cancelled: p.cancelled } : {}), ...(p.extra ?? {}) }); } catch { /* the host may be gone */ }
  }
}
