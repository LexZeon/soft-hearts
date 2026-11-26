/**
 * I-154 batch 3, row 15 程序生命: the companion's procedural life (src/stage/procedural-life.ts) on Unbound's engine in the companion
 * window. The developer switch 「程序化小动作与表情」 (setProceduralLife, on by default, as on the old stage) turns it on and off.
 *
 * The same layer, the same inputs and the same owners (gates): her gaze drifts and makes small saccades, now and then looks at you or
 * away; her head tilts a little, sometimes in a curious moment; her upper body sways with her weight; her continuous face (smiling
 * eyes, a closed smile, troubled brows, jitome when drowsy, a blush); the blink rhythm (her intervals). Each primitive fades out (0.3 s)
 * while a higher owner holds its part and back in (0.8 s): the layer's own rule.
 *
 * What is different, on purpose: nothing here writes a bone or a morph. Its `out` becomes offsets to the window's goals (head, upper body,
 * the look's pull and offset, expression slots, soft lids), which the figure's springs carry. Not used here: its breath (Unbound's figure
 * breathes itself), its shoulder rise (no shoulder goal), its expression previews (the control window's). Speaking accents stay the
 * window face's (window-face.ts), not passed here twice.
 * Batch 5 (row 38): the 惊喜 / 害羞 show plays through the layer's preview channel, as on the old stage (window-reactions.ts gives the clip and
 * its clock); its head, upper-body and eye additions come out as goals too (`show`), and the layer's other primitives yield while it plays.
 * Pure: no DOM; three.js types only through the mesh it is given as the owner.
 */
import { composeBrows, type LifeActivity, type LifeRig, type LivelinessLib, type ProceduralLife } from '../../stage';
import type { MoodView } from '../../../shared/mood';
import type { MorphSlot } from '../../../shared/actions';
import type { Rot } from '../motion/generator';
import type { WindowFaceFrame } from './window-face';
import type { WindowFaceRig } from './window-face-rig';

export interface WindowLifeGates {
  /** A pat, a hover, a snack, a pinch (with its easing back), or a mood phase that is not idle: the companion's direct contact. */
  contact: boolean;
  /** A picked expression owns her face, a picked head motion her head, a picked mouth her mouth (window-face-rig.ts faceBlocks). */
  face: boolean; head: boolean; mouth: boolean;
  /** A camera adjust or a pull. */
  adjusting: boolean;
  speaking: boolean;
  /** Tired past looking around (the fatigue frame's gazeAllowed), and whether a tired face (lids, the drowsy face) shows now. */
  gazeAllowed: boolean; fatigueFace: boolean;
  /** Batch 6 (row 37): she dances to music (or it eases out): her head and sway give way to it, as on the old stage (its gates.music). */
  music?: boolean;
  /** I-170: a talk signal is on (her idle head drift and casual tilts calm; procedural-life.ts). */
  talking?: boolean;
}

export interface WindowLifeOut {
  /** Added to her head and upper body goals (rad). */
  head: Rot; torso: Rot;
  /** The look: how much of the cursor's pull remains, an offset in the cursor's units, and how much a look-at-you moment looks at you. */
  gaze: { follow: number; x: number; y: number; toUser: number };
  /** Expression slot goals 0..1 (max with the others), soft lids (a natural blink goes on over them), the blush she would show. */
  expr: Partial<Record<MorphSlot, number>>;
  softLids: number;
  blush: number;
  /** Batch 5: the 惊喜 / 害羞 show's head, upper body (rad, added to the goals) and eyes (rad, + = her left / down). */
  show: { head: Rot; torso: Rot; eyeYaw: number; eyePitch: number };
  /** Anything of the layer shows (on, or fading out). */
  active: boolean;
}

const ZERO: Rot = Object.freeze({ pitch: 0, yaw: 0, roll: 0 }) as Rot;
export const NO_LIFE: Readonly<WindowLifeOut> = Object.freeze({ head: ZERO, torso: ZERO, gaze: Object.freeze({ follow: 1, x: 0, y: 0, toUser: 0 }),
  expr: Object.freeze({}), softLids: 0, blush: 0, show: Object.freeze({ head: ZERO, torso: ZERO, eyeYaw: 0, eyePitch: 0 }), active: false });

/** The life layer's rig from the window face's slots (an MMD model's profile slots, a VRM's standard face); it writes no bone here. */
export function windowLifeRig(lib: Pick<LivelinessLib, 'lifeRig'>, owner: object, rig: WindowFaceRig | null): LifeRig<never> {
  const morphs: Record<string, { index: number }> = {};
  for (const [slot, index] of Object.entries(rig?.slots ?? {})) if (typeof index === 'number') morphs[slot] = { index };
  return lib.lifeRig<never>(owner, { bone: () => undefined, profile: rig ? { morphs } : null, indices: { mouth: rig?.slots.a ?? -1 } });
}

export class WindowProceduralLife {
  private lib: Pick<LivelinessLib, 'ProceduralLife' | 'lifeRig'> | null = null;
  private life: ProceduralLife<never> | null = null;
  private enabled = true;
  private rig: { owner: object; face: WindowFaceRig | null; life: LifeRig<never> } | null = null;

  /** The layer's code (src/stage/procedural-life.ts), loaded on demand (src/stage/index.ts loadLivelinessForEngine); until then: none. */
  constructor(lib: Pick<LivelinessLib, 'ProceduralLife' | 'lifeRig'> | null = null) { if (lib) this.load(lib); }
  load(lib: Pick<LivelinessLib, 'ProceduralLife' | 'lifeRig'>): void { if (!this.lib) { this.lib = lib; this.life = new lib.ProceduralLife<never>(); } }

  /** 「程序化小动作与表情」: off fades back (0.3 s per primitive, the layer's own master fade) to the window's plain gaze and blink. */
  set(enabled: boolean): void { this.enabled = enabled === true; }
  get on(): boolean { return this.enabled; }
  /** Still showing (on, or fading out). */
  get active(): boolean { return this.life?.active === true; }
  getState() { return this.life?.getState() ?? null; }
  /** The layer's own JSON readout (canvas data-procedural-life, window-readouts.ts), or null before it is loaded. */
  diagnostics(nowMs: number): string | null { return this.life?.diagnostics(nowMs) ?? null; }

  /**
   * One frame. `owner`: the mesh (a new one restarts from neutral); null: no model. `pointer`: the cursor (-1..1). `mouthBusy`: speech or a
   * snack owns the mouth (her closed smile and small "o" step aside; the slot springs ease them).
   */
  frame(dt: number, input: { owner: object | null; rig: WindowFaceRig | null; view: MoodView | null; pointer: { x: number; y: number }; breath: number;
    hasEyes: boolean; gates: WindowLifeGates; mouthBusy: boolean; activity?: LifeActivity | null;
    /** Batch 5: the show playing (its clip, clock and strength; window-reactions.ts) and whether its own gate holds it (hidden, a window move, a touch). */
    show?: { clip: string; elapsedMs: number; strength: number } | null; showBlocked?: boolean;
    /** Batch 6 (row 37): the music nod and the listening look this frame (window-music.ts), or null. */
    beat?: { headX: number; headZ: number; bodyZ: number } | null }): WindowLifeOut {
    const owner = input.owner, life = this.life, lib = this.lib;
    if (!owner || !life || !lib) { this.rig = null; return NO_LIFE; }
    if (this.rig?.owner !== owner || this.rig.face !== input.rig) this.rig = { owner, face: input.rig, life: windowLifeRig(lib, owner, input.rig) };
    const view = input.view, g = input.gates, s = view?.snapshot;
    life.frame(dt, { enabled: this.enabled, owner, seedKey: view?.characterId ?? '', rig: this.rig.life, mood: s, fatigue: view?.fatigue,
      pointerX: input.pointer.x, pointerY: input.pointer.y, breathStrength: input.breath, hasEyes: input.hasEyes, blush: view?.parameters.blush,
      previewClip: input.show?.clip ?? null, previewElapsedMs: input.show?.elapsedMs, previewStrength: input.show?.strength,
      previewBlocked: input.show ? input.showBlocked === true : true, activity: input.activity ?? null, beat: input.beat ?? null, accent: null, // batch 4: the games' faces; batch 6: the music nod
      gates: { expressive: view?.expressions === true, contact: g.contact || (!!s && s.phase !== 'idle'), manualPose: false, manualGesture: false,
        manualHead: g.head, manualExpression: g.face, manualMouth: g.mouth, chatGesture: false, music: g.music === true, bodyMotion: false, headOwned: g.head,
        authoredFace: !!view?.behavior?.state || !!view?.behavior?.reaction, preview: !!input.show, adjusting: g.adjusting, speaking: g.speaking,
        gazeAllowed: g.gazeAllowed, fatigueFace: g.fatigueFace, talking: g.talking === true } });
    if (!life.active) return NO_LIFE;
    const o = life.out, expr: Partial<Record<MorphSlot, number>> = {};
    const put = (slot: MorphSlot, value: number) => { if (value > 0) expr[slot] = Math.min(1, value); };
    put('smileEyes', o.smileEyes); put('jitome', o.jitome); put('browUp', o.browUp); put('surprise', o.eyeWide);
    const brows = composeBrows(o.sad, o.angry, { sad: 0, angry: 0 });
    put('sad', brows.sad); put('angry', brows.angry);
    if (!input.mouthBusy) { put('mouthSmile', o.mouthSmile); put('o', o.mouthOpen); }
    return {
      // The companion's automatic-head Euler (x pitch, y yaw, z roll) and upper-body sway (y twist, z roll), roll as window-face.ts maps it.
      head: { pitch: o.headX, yaw: o.headY, roll: -o.headZ }, torso: { pitch: 0, yaw: o.swayY, roll: -o.swayZ },
      gaze: { follow: Math.max(0, Math.min(1, (1 - o.gazeBlend) * o.pointerFollow)), x: o.gazeX, y: o.gazeY, toUser: o.gazeBlend },
      expr, softLids: o.lidSoft, blush: o.blush, active: true,
      show: { head: { pitch: o.previewHeadX, yaw: o.previewHeadY, roll: -o.previewHeadZ }, torso: { pitch: o.previewBodyX, yaw: 0, roll: -o.previewBodyZ },
        eyeYaw: o.previewEyeYaw, eyePitch: o.previewEyePitch },
    };
  }

  /** A natural blink starts: her own interval (s) to the next one while the layer shows, else null (the window's rhythm). */
  nextBlink(): number | null { return this.life?.active ? this.life.beginBlink() : null; }
}

/**
 * Her procedural life added to the window face's goals (head, upper body, the look, expression slots by max, soft lids). `user`: where
 * pose sensing says you are (cursor units), for her look-at-you moments; without it they look straight ahead, as on the old stage.
 */
export function withLife(face: WindowFaceFrame, life: WindowLifeOut, user: { x: number; y: number } | null = null): WindowFaceFrame {
  if (!life.active) return face;
  const expr = { ...face.expr };
  for (const [slot, value] of Object.entries(life.expr) as [MorphSlot, number][]) expr[slot] = Math.max(expr[slot] ?? 0, value);
  return {
    ...face, expr,
    head: { pitch: face.head.pitch + life.head.pitch + life.show.head.pitch, yaw: face.head.yaw + life.head.yaw + life.show.head.yaw,
      roll: face.head.roll + life.head.roll + life.show.head.roll },
    torso: { pitch: face.torso.pitch + life.torso.pitch + life.show.torso.pitch, yaw: face.torso.yaw + life.torso.yaw, roll: face.torso.roll + life.torso.roll + life.show.torso.roll },
    gaze: { ...face.gaze, pull: face.gaze.pull * life.gaze.follow, eyeYaw: face.gaze.eyeYaw + life.show.eyeYaw, eyePitch: face.gaze.eyePitch + life.show.eyePitch,
      x: face.gaze.x + life.gaze.x + (user?.x ?? 0) * life.gaze.toUser, y: face.gaze.y + life.gaze.y + (user?.y ?? 0) * life.gaze.toUser },
    softLids: Math.max(face.softLids, life.softLids),
  };
}
