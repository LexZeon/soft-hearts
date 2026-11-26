/**
 * I-154 batch 3, row 16 姿势识别里看向你 (I-081): who she looks at in the companion window on Unbound's engine, you or the mouse.
 *
 * The companion's own layer (src/senses/gaze-attention-stage.ts StageGazeAttention: the chooser, the smoothing of where you are, her
 * attention facts) with the companion's own input. The reading is what the companion window already polls every 100 ms
 * (window.desktop.userGaze, src/wiring/stage-wiring.ts startPointerFollow): the host answers null unless the user's own pose sensing is
 * on and gives something fresh, and forgets the user when it is turned off (electron/senses/user-gaze.ts). Nothing here senses anything,
 * asks the host anything or stores anything: a reading lives in memory for 3 s of the window's clock, then she looks as before.
 *
 * What is different, on purpose: the companion splits each target into eyes and head itself; here the aim (the cursor's units, from her
 * eyes) goes to the window's look (window-life.ts), and Unbound's eye-head coordinator splits it. Without a fresh reading and once the
 * chooser has let go, she looks exactly as before (null: the cursor's aim).
 * Pure: no DOM, no three.js.
 */
import { StageGazeAttention } from '../../senses';
import { parseUserGazeReading, type UserGazeReading } from '../../../shared/senses';
import type { MoodView } from '../../../shared/mood';

/** How long a reading is used after it came (s of the window's clock), as the companion's stage (src/stage/mmd/idle.ts). */
export const USER_GAZE_FRESH_S = 3;

export interface WindowGazeOut {
  /** The look's aim in the cursor's units from her eyes (replaces cursor − eyes while pose sensing is engaged). */
  aim: { x: number; y: number };
  /** Where you are (the cursor's units from her eyes; 0, 0 while pose sensing does not know): her look-at-you moments look there. */
  user: { x: number; y: number };
}

export class WindowGaze {
  private attention: StageGazeAttention | null = null;
  private held: { reading: UserGazeReading; at: number } | null = null;
  private t = 0;

  constructor(private readonly onEvent: (event: unknown) => void = () => {}, private readonly random: () => number = Math.random) {}

  /** The companion window's latest poll: a checked reading (anything malformed is dropped), or null (sensing off, nothing fresh). */
  set(value: unknown): void {
    const reading = parseUserGazeReading(value);
    this.held = reading ? { reading, at: this.t } : null;
  }
  /** Hidden, another model, a lost scope: nothing of the user is kept. */
  forget(): void { this.held = null; }
  /** I-169, developer mode only: the chooser's readout and where you are (null before pose sensing ever gave a reading). Read only. */
  readout(): ReturnType<StageGazeAttention['readout']> | null { return this.attention?.readout() ?? null; }
  /** A reading is in memory and fresh (the developer view and tests). */
  get fresh(): boolean { return !!this.held && this.t - this.held.at <= USER_GAZE_FRESH_S; }

  /**
   * One frame. `follow`: 「看鼠标」 on; `allowed`: she may look around (not asleep, the fatigue frame); `pointer`, `eyes`: the cursor and
   * her eyes on the window (-1..1, y up). null: no reading and nothing of it still shows (the old aim, exactly).
   */
  frame(dt: number, input: { follow: boolean; allowed: boolean; pointer: { x: number; y: number } | null; eyes: { x: number; y: number } | null;
    thinking: boolean; speaking: boolean; mood: MoodView | null }): WindowGazeOut | null {
    const step = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    this.t += step;
    const reading = this.fresh ? this.held!.reading : null;
    if (!reading && !this.attention) return null;
    const attention = this.attention ??= new StageGazeAttention(this.random);
    const origin = input.eyes ?? { x: 0, y: 0 }, follow = input.follow && input.allowed && !!input.pointer;
    const mouseX = follow ? input.pointer!.x - origin.x : 0, mouseY = follow ? input.pointer!.y - origin.y : 0;
    const out = attention.frame({ delta: step, follow: input.follow, allowed: input.allowed, mouseX, mouseY, originX: origin.x, originY: origin.y,
      thinking: input.thinking, speaking: input.speaking, reading, mood: input.mood });
    for (const event of attention.takeEvents()) { try { this.onEvent(event); } catch { /* a record never changes her gaze */ } }
    return out.active || out.userX !== 0 || out.userY !== 0 ? { aim: { x: out.x, y: out.y }, user: { x: out.userX, y: out.userY } } : null;
  }
}
