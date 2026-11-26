/**
 * I-154 batch 3: one frame of her face and liveliness in the companion window on Unbound's engine, composed in one place so the stage
 * (window-stage.ts) only wires it and the Gene tests run exactly this: procedural life (row 15, window-proc-life.ts), her face with the
 * pinch and the snack mouth (rows 22, 23, window-face.ts), the sleep pose and the sleep body (row 35, window-sleep.ts), who she looks at
 * with pose sensing (row 16, window-gaze.ts), then her body (window-body.ts). Goals only, every one carried by the figure's springs (or,
 * for the sleep body, its own minimum-jerk progress and yield weight).
 */
import type { Bone, Object3D, PerspectiveCamera } from 'three';
import type { MoodView } from '../../../shared/mood';
import type { LifeActivity, SleepMurmur } from '../../stage';
import type { WindowBody } from './window-body';
import type { WindowFace, WindowFaceEnv, WindowFaceFrame } from './window-face';
import type { WindowFaceRig } from './window-face-rig';
import { gazeDebug, flatGazeFrame } from '../../senses';
import { WindowGaze } from './window-gaze';
import { WindowProceduralLife, withLife } from './window-proc-life';
import { talkSignal } from '../../../shared/stage';
import { WindowSleep, type WindowSleepFrame } from './window-sleep';
import type { WindowGamesFrame } from './window-games';
import type { WindowLifeOverlay } from './window-arbiter';

export interface WindowLivelyInput {
  view: MoodView | null;
  rig: WindowFaceRig | null;
  /** The face's frame environment (window-face.ts), less what this fills in (her height, the life's blush). */
  env: Omit<WindowFaceEnv, 'heightM' | 'lifeBlush'>;
  /** The keyed cursor and her eyes on the window (-1..1, y up), 「看鼠标」, a hand on her head. */
  pointer: { x: number; y: number }; eyes: { x: number; y: number } | null; follow: boolean; pat: boolean;
  /** The breath setting (0..1). */
  breath: number;
  /** A pull holds her (the doze and the sleep body yield; no drowsy action starts), a held hand, a camera adjust. */
  pulled: boolean; handHeld: boolean; adjusting: boolean;
  /** The window's camera, its lift, size and scene (for the sleep body's pose choice and its props). */
  camera: PerspectiveCamera; lift: number; width: number; height: number; scene: Object3D;
  /** The reply is still waiting for its first word. */
  thinking: boolean;
  /** I-170: you are typing to her (the stage's typing gate); with thinking, preparing and speaking it is "talking". */
  typing?: boolean;
  /** Batch 4 (window-games.ts): the game, an offer, her reach: their arms, face (her life's activity), lean, and whether the game holds her head. */
  games?: WindowGamesFrame | null;
  /**
   * Batch 5 (window-reactions.ts): her reactions to your pose over the games' face (her life's activity), the 惊喜 / 害羞 show for her life's
   * preview channel (and whether its own gate holds it), and the reaction's body writes (chest, shoulders, a waving arm) after the sleep body's.
   */
  reactions?: { activity(base: LifeActivity | null, sleepCue: (base: unknown, nowMs: number) => unknown | null): LifeActivity | null;
    show: { clip: string; elapsedMs: number; strength: number } | null; showBlocked: boolean; overlay: ((remember: (bone: Bone) => void) => void) | null } | null;
  /** Batch 6 (row 37, window-music.ts): the nod and the listening look for procedural life, and whether the dance holds her (life gives way). */
  music?: { beat: { headX: number; headZ: number; bodyZ: number } | null; dancing: boolean } | null;
  /** I-174 item 1: her own small things (window-arbiter.ts): laid over her body's goals; a glance takes the cursor's pull away (she looks at you). */
  ownLife?: WindowLifeOverlay | null;
}

export class WindowLiveliness {
  readonly gaze: WindowGaze;
  readonly life = new WindowProceduralLife();
  readonly sleep: WindowSleep;
  /** The last frame's sleep (the pace reads whether it is easing). */
  lastSleep: WindowSleepFrame | null = null;

  constructor(onGaze: (event: unknown) => void = () => {}, random: () => number = Math.random) {
    this.gaze = new WindowGaze(onGaze, random);
    this.sleep = new WindowSleep(null, random);
  }

  /** One frame: her face (with what of her life and sleep it carries) handed to her body. Returns what her body was given. */
  frame(delta: number, body: WindowBody, face: WindowFace, input: WindowLivelyInput, physicsDelta = delta): WindowFaceFrame {
    const owners = face.owners(), view = input.view, speaking = input.env.speaking || input.env.voiced, games = input.games ?? null, reactions = input.reactions ?? null;
    const talking = talkSignal({ typing: input.typing, thinking: input.thinking, preparing: face.preparing, speaking }); // I-170: her idle head calms
    const activity = reactions ? reactions.activity(games?.activity ?? null, (base, nowMs) => this.sleep.poseCueView(base, nowMs)) : games?.activity ?? null;
    const life = this.life.frame(delta, { owner: body.figure.mesh, rig: input.rig, view, pointer: input.pointer, breath: input.breath, hasEyes: !!input.eyes,
      mouthBusy: speaking || owners.feeding, activity, show: reactions?.show ?? null, showBlocked: reactions?.showBlocked === true, gates: { contact: owners.contact, face: owners.face, head: owners.head, mouth: owners.mouth,
        adjusting: input.adjusting || input.pulled, speaking, gazeAllowed: owners.gazeAllowed, fatigueFace: owners.fatigueFace, music: input.music?.dancing === true, talking },
      beat: input.music?.beat ?? null });
    const shown = face.frame(delta, { ...input.env, heightM: body.figure.heightM, lifeBlush: life.blush });
    const sleep = this.lastSleep = this.sleep.frame(delta, { view, capable: owners.sleepCapable, headOwned: owners.head || input.pulled || games?.head === true,
      yielding: input.pulled || input.handHeld, touched: owners.touched,
      busy: owners.contact || speaking || input.adjusting || input.pulled || input.thinking || face.preparing || (!!view && view.snapshot?.phase !== 'idle'),
      camera: input.camera, lift: input.lift, width: input.width, height: input.height, scene: input.scene, preview: input.env.capability?.sleep === true });
    const look = this.gaze.frame(delta, { follow: input.follow, allowed: shown.gaze.allowed, pointer: input.pointer, eyes: input.eyes,
      thinking: input.thinking, speaking, mood: view });
    const laid = withGames(withSleep(withLife(shown, life, look?.user ?? null), sleep), games), glance = input.ownLife?.look ?? 0;
    const goals = glance > 0 ? { ...laid, gaze: { ...laid.gaze, pull: laid.gaze.pull * (1 - Math.min(1, glance)) } } : laid;
    body.figure.setBreath(input.breath * sleep.breath);
    body.frame(delta, { pointer: input.pointer, eyes: input.eyes, follow: input.follow, pat: input.pat, face: goals, aim: look?.aim ?? null,
      nextBlink: () => this.life.nextBlink(), overlay: withReaction(sleep.overlay, reactions?.overlay ?? null), talking, life: input.ownLife ?? null }, physicsDelta);
    gazeDebug(this, view?.developerMode === true)?.frame(flatGazeFrame({ dt: delta, width: input.width, height: input.height, attention: this.gaze.readout(), follow: input.follow, pointer: input.pointer, eyes: input.eyes, head: body.figure.gazeShown.head, eyesTurn: body.figure.gazeShown.eyes })); // I-169: developer mode shows where she looks (read only)
    return goals;
  }

  /** 梦话 since the last frame (bubble only). */
  takeMurmurs(): SleepMurmur[] { return this.sleep.takeMurmurs(); }
  /** Something of her sleep is easing (the pace stays at full rate). */
  get moving(): boolean { return this.lastSleep?.moving === true; }
}

/**
 * Batch 4: the games' arms over a beat's hand on the same side (a beat's hand does not start while they hold her arms; one already up
 * hands over through the reach: down first, then the game's arm), and the reach's lean added to her upper body.
 */
export function withGames(face: WindowFaceFrame, games: WindowGamesFrame | null): WindowFaceFrame {
  if (!games || (!games.hands.left && !games.hands.right && !games.torso.pitch && !games.torso.yaw)) return face;
  return {
    ...face,
    hands: { left: games.hands.left ?? face.hands?.left ?? null, right: games.hands.right ?? face.hands?.right ?? null },
    torso: { pitch: face.torso.pitch + games.torso.pitch, yaw: face.torso.yaw + games.torso.yaw, roll: face.torso.roll + games.torso.roll },
  };
}

/** Batch 5: the figure's overlay this frame: the sleep body's, then a pose reaction's chest, shoulders or waving arm (either may be absent). */
export function withReaction(sleep: ((remember: (bone: Bone) => void, delta: number) => void) | null,
  reaction: ((remember: (bone: Bone) => void) => void) | null): ((remember: (bone: Bone) => void, delta: number) => void) | null {
  if (!reaction) return sleep;
  if (!sleep) return remember => reaction(remember);
  return (remember, delta) => { sleep(remember, delta); reaction(remember); };
}

/** The sleep pose added to her goals (neck and head), its wake blink as a soft closure; the sleep body holds her: the idle steps aside. */
export function withSleep(face: WindowFaceFrame, sleep: WindowSleepFrame): WindowFaceFrame {
  const neck = face.neck ?? { pitch: 0, yaw: 0, roll: 0 };
  return {
    ...face,
    neck: { pitch: neck.pitch + sleep.neck.pitch, yaw: neck.yaw + sleep.neck.yaw, roll: neck.roll + sleep.neck.roll },
    head: { pitch: face.head.pitch + sleep.head.pitch, yaw: face.head.yaw + sleep.head.yaw, roll: face.head.roll + sleep.head.roll },
    softLids: Math.max(face.softLids, sleep.softLids),
    performing: face.performing === true || sleep.performing,
  };
}
