/**
 * I-176 step 3 (docs/claude/2026-11-23-i176-delete.md): the window engine's canvas readouts. The old stage wrote about forty `dataset` fields on its
 * canvas for developer mode, the pretrial and the real-Electron smokes (scripts/*-smoke.mjs, scripts/pretrial/); the window engine wrote only
 * `interactionRegion` and `windowEngine`. Deleting the old stage meant those scripts had nothing to read, so the window writes the fields they
 * poll, in the shape they read (the old names and keys), from its own parts:
 *  - always: `presence` (the canvas opacity: 1 once she is fully there);
 *  - developer mode only (the moodView's developerMode, as the old stage's diagnostics): `frameClock` (the frame heartbeat, what the pace
 *    decided, speaking / waiting / blocked), `poseContinuity` (the visible-bone jump watch, window-diagnostics.ts: this engine has no display
 *    guard, so "jumps" is what the guard would have caught), `moodFeedback`, `cheekPinch`, `chatGesture`, `behaviorMotion`, `bodyMotion`,
 *    `motionTransition` (the hand-back bridge), `modelPhysics`, `crying`, `proceduralLife`, `herLife`, `rps` (while the game shows; `null` after).
 * Numbers and closed words only; nothing here reads or writes anything but the canvas. Text through JSON only.
 */
import { FrameHeartbeat } from '../../stage';
import type { WindowFrame } from './window-pace';

/** What the stage lends the readouts (getters: each is read only when developer mode is on). */
export interface ReadoutSources {
  presence(): number;
  /** speaking, waiting for a reply, input blocked, and the pace's own state. */
  clock(): { speaking: boolean; waitingForReply: boolean; inputBlocked: boolean; pace: unknown };
  guard(): { jumps: number; maxAngleDeg: number; lastJump: { property: string; size: number } | null };
  mood(): Record<string, unknown> | null;
  /** The shown blink morph's influence (0 without one), and how shut her eyes are as shown (the blink plus the lid shapes that share the lid: smile eyes, tired eyes; at most 1). */
  blink(): number;
  closure(): number;
  pinch(): Record<string, unknown> | null;
  clips(): { chat: Record<string, unknown> | null; behavior: unknown; body: unknown; bridge: unknown };
  /** The hair / chest physics' own readout, or null. */
  physics(): Record<string, unknown> | null;
  crying(): { frame: Record<string, unknown> | null; support: string; surface: unknown };
  /** The figure's own clock (s), the window's stand-in for the old pose layer's time. */
  poseTime(): number | null;
  /** The layers' own JSON readouts (strings, as the old stage wrote them), or null before they are loaded; the game's state while it shows. */
  proceduralLife(): string | null;
  herLife(): string | null;
  rps(): unknown;
}

export class WindowReadouts {
  private readonly heartbeat = new FrameHeartbeat();
  private lastPresence = '';
  private rpsShown = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly developer: () => boolean, private readonly sources: ReadoutSources) {}

  /** Every display callback, drawn or not: the heartbeat records what the pace decided. */
  decided(frame: WindowFrame, now: number): void {
    this.heartbeat.record(frame, now);
    if (this.developer()) this.set('frameClock', { ...this.heartbeat.getState(), ...this.sources.clock() });
  }

  /** After a drawn frame: the presence always, the rest in developer mode. */
  drawn(): void {
    const presence = this.sources.presence(), shown = presence >= 1 ? '1' : presence.toFixed(4);
    if (shown !== this.lastPresence) { this.lastPresence = shown; this.canvas.dataset.presence = shown; }
    if (!this.developer()) return;
    const s = this.sources, clips = s.clips(), mood = s.mood(), pose = s.poseTime();
    this.set('poseContinuity', s.guard());
    this.set('moodFeedback', mood ? { ...mood, blink: s.blink(), closure: s.closure() } : null);
    this.set('cheekPinch', s.pinch());
    this.set('chatGesture', clips.chat);
    this.set('behaviorMotion', clips.behavior);
    this.set('bodyMotion', clips.body);
    this.set('motionTransition', { ...(clips.bridge as object), layerTimes: { pose, gesture: null, expression: null } });
    this.set('modelPhysics', s.physics());
    const life = s.proceduralLife(), her = s.herLife(), rps = s.rps();
    if (life !== null) this.canvas.dataset.proceduralLife = life;
    if (her !== null) this.canvas.dataset.herLife = her;
    if (rps) { this.set('rps', rps); this.rpsShown = true; } else if (this.rpsShown) { this.rpsShown = false; this.canvas.dataset.rps = 'null'; }
    const crying = s.crying();
    this.set('crying', crying.frame ? { ...crying.frame, support: crying.support, surface: crying.surface } : { phase: 'idle', amount: 0, support: crying.support, surface: crying.surface });
  }

  private set(key: string, value: unknown): void {
    try { this.canvas.dataset[key] = JSON.stringify(value ?? null); } catch { /* a readout only */ }
  }
}
