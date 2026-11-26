/**
 * I-154: what the wiring tells her (the pointer, speaking, a touch, the window shown or hidden, where you are, her procedural life and 睡相,
 * her mood and its scope, you away, the physics switches) and the seven 拉她 members, for the Unbound window stage, between her face's
 * members (window-stage-face.ts) and the stage (window-stage.ts). Moved out of window-stage.ts unchanged on 2026-11-20 (batch 7 step 0),
 * so the stage file stays a wiring file well under 32 KB. The state these members keep (the pointer, the speaking sources, the last touch,
 * the mood view, the host's shown flag) lives here; the stage reads it.
 */
import type { StageOptions, StageSurface } from '../../stage';
import { clamp } from '../../stage';
import { WindowStageFace } from './window-stage-face';
import type { WindowLiveliness } from './window-liveliness';
import type { WindowPhysics } from './window-physics';
import type { WindowPull } from './window-pull';
import { SpeechOwner } from '../her/speech-owner';
import { WindowArbiter } from './window-arbiter';

type S = StageSurface;

export abstract class WindowStageInputs extends WindowStageFace {
  protected abstract readonly options: StageOptions;
  protected abstract readonly lively: WindowLiveliness;
  protected abstract readonly physics: WindowPhysics;
  protected abstract readonly pull: WindowPull;
  protected abstract disposed: boolean;

  protected pointer = { x: 0, y: 0 };
  protected pat = false;
  protected contactNow: Parameters<S['setMoodContact']>[0] | null = null;
  protected readonly speakingSources = new Set<string>();
  /** I-174 item 8: the held "she is speaking" her motion gates read (../her/speech-owner.ts; full-screen reads the same). */
  protected readonly speechOwner = new SpeechOwner();
  /** I-174 item 1: her own small things through full-screen's scheduler, arbiter and player (window-arbiter.ts). */
  protected readonly arbiter = new WindowArbiter({ quickBusy: () => this.body?.idle.quickBusy === true });
  private fillerShape: number | null = null;
  protected hostVisible = true;
  /** Her mood as the wiring last told it: read by the pull (her attitude, asleep) and the pace (asleep); her face has its own copy (window-face.ts). */
  protected moodView: Parameters<S['setMood']>[0] | null = null;

  setPointer(pointer: Parameters<S['setPointer']>[0]): void {
    const x = clamp(pointer.x, -1, 1), y = clamp(pointer.y, -1, 1);
    if (x !== this.pointer.x || y !== this.pointer.y) this.pace.wake('pointer'); // her eyes follow it: full pace
    this.pointer = { x, y };
  }
  setSpeaking(active: boolean, source: Parameters<S['setSpeaking']>[1] = 'local', shape?: number): void {
    if (active) this.speakingSources.add(String(source)); else this.speakingSources.delete(String(source));
    this.speechOwner.note(active);
    if (String(source) === 'filler') this.fillerShape = active ? shape ?? 0.5 : null; // 2026-11-20: her short sounds in a call: the mouth only (a second source of its own)
    if (active) this.pace.wake('speaking');
    this.body?.setSpeaking(this.speakingSources.size - (this.speakingSources.has('filler') ? 1 : 0) > 0, this.fillerShape);
  }
  setMoodContact(contact: Parameters<S['setMoodContact']>[0]): void {
    const pat = contact?.contact === true;
    if (pat && !this.pat) this.arbiter.touched(); // I-174: you touched her: her own small thing eases out, nothing new for a while
    if (pat || this.pat || contact?.pinch?.pinching || contact?.feeding || (contact?.hover ?? 0) > 0) this.pace.wake('touch'); // a touch and its release
    this.pat = pat;
    this.face.setContact(contact ?? null);
    // Batch 5 (the companion's setMoodContact): a touch stops new automatic motions; a pat, a snack or a hover hands a chat gesture back.
    this.contactNow = contact ?? null;
    const touching = pat || contact?.feeding === true || (contact?.hover ?? 0) > 0;
    this.motions.gatesChanged(touching || contact?.pinch?.pinching === true, touching);
  }
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.hostVisible = visible;
    if (!visible) { this.options.onFaceAnchor?.({ x: 0, y: 0, visible: false }); this.face.hide(); this.lively.gaze.forget(); }
    this.visibilityChanged(visible);
  }
  /** Batch 7: the host shown flag changed (the preview pauses, its previews and 试一下 stop); nothing in the companion window by default. */
  protected visibilityChanged(_visible: boolean): void {}
  /** I-081 (row 16): the host's reading of where you are (null unless your own pose sensing gives something); memory only, 3 s. */
  setUserGaze(value: unknown): void { if (!this.disposed) this.lively.gaze.set(value); }
  /** 「程序化小动作与表情」 (row 15): her procedural life on or off (it fades either way). */
  setProceduralLife(enabled: boolean): void { this.lively.life.set(enabled); }
  /** I-078 第 3 步 (row 35): the active card's 睡相. */
  setSleepHabit(value: unknown): void { this.lively.sleep.setHabit(value); }
  /** Her mood view: her face (window-face.ts), the pull (her attitude; no pull while asleep) and the pace (asleep). */
  setMood(view: Parameters<S['setMood']>[0]): void {
    const was = this.moodView;
    // P1 舞台少画: her face eases to a new mood, a phase or a gesture starts: full pace (as the companion's stage-pace.ts).
    if (!was || was.snapshot?.primary !== view?.snapshot?.primary || was.snapshot?.phase !== view?.snapshot?.phase
      || (!!view?.gesture && view.gesture !== was.gesture) || was.fatigue?.phase !== view?.fatigue?.phase) this.pace.wake('expression');
    this.moodView = view ?? null;
    this.face.setMood(this.moodView);
    this.motions.setMood(this.moodView); // batch 5: a granted chat gesture, the automatic body motion's plan, the behaviour faces
    if (view?.gesture && view.gesture !== was?.gesture) this.pace.wake('chat-gesture');
  }
  /** Trusted host scope loss: no mood view, nothing of it comes back; what her face shows eases away. */
  invalidateMoodScope(): void { if (this.disposed) return; this.moodView = null; this.face.invalidate(); this.motions.setMood(null); this.pace.wake('expression'); }
  /** P1 舞台少画: the host says the user is away or the screen is locked (window-pace.ts). */
  setUserAway(away: boolean): void { this.pace.setAway(away); }
  /** The control window's hair / chest switches and the physics lab's live values (window-physics.ts). */
  setPhysicsSettings(settings: Parameters<S['setPhysicsSettings']>[0]): void { if (!this.disposed) void this.physics.set(settings); }

  // ---- 拉她 (window-pull.ts; the companion's own pull input in src/mood/ calls these) ---------------------------------------
  pullHit(x: number, y: number): ReturnType<S['pullHit']> { return this.pull.hit(x, y); }
  pullStart(hit: Parameters<S['pullStart']>[0]): boolean { const started = this.pull.start(hit); if (started) { this.pace.wake('touch'); this.arbiter.pulled('start'); } return started; }
  pullTo(x: number, y: number): void { this.pull.to(x, y); }
  pullEnd(): void { this.pull.end(); this.arbiter.pulled('end'); }
  setPullStance(stance: Parameters<S['setPullStance']>[0]): void { this.pull.setStance(stance); }
  pullStillAllowed(group: Parameters<S['pullStillAllowed']>[0]): boolean { return this.pull.stillAllowed(group); }
  pullMood(): ReturnType<S['pullMood']> { return this.pull.mood(); }
}
