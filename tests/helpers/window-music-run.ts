/**
 * The real Gene frame loop with the window engine's music (src/unbound/window-mode/window-music.ts), through the code the companion window
 * runs: WindowOwnLife (her choice, the dance, the nod), WindowMotions' gates, WindowLiveliness (procedural life carries the nod, her face,
 * her body). Per frame: every tracked bone's world rotation, the head's pitch against her upper body, and what the music says it shows.
 * Shared by the music-nod tests (docs/claude/2026-11-24-music-nod-window.md).
 */
import { Euler, Quaternion, Scene } from 'three';
import type { BodyMotionPlan } from '../../shared/actions';
import type { MoodView } from '../../shared/mood';
import type { MusicSettings } from '../../shared/senses';
import { WindowMotions, loadLibraryClip, type WindowMotionEnv } from '../../src/unbound/window-mode/window-motions';
import { WindowLiveliness } from '../../src/unbound/window-mode/window-liveliness';
import { WindowFace } from '../../src/unbound/window-mode/window-face';
import { WindowGames } from '../../src/unbound/window-mode/window-games';
import { NO_MOTION_BLOCKS, slotBindings, windowFaceRig } from '../../src/unbound/window-mode/window-face-rig';
import { WindowOwnLife } from '../../src/unbound/window-mode/window-own-life';
import type { WindowStageHost } from '../../src/unbound/window-mode/host-ports';
import { loadLivelinessForEngine, loadMusicForEngine, type MusicEnergySample } from '../../src/stage';
import { StageModelProfile } from '../../src/stage/model-profile';
import { card, faceView } from './window-face-fixture';
import { windowGene, WINDOW } from './unbound-window';
import { standClip } from './unbound-gene';
import { TRACKED_BONES } from './frame-stats';

export const DEG = 180 / Math.PI;

export const musicBaseEnv = (over: Partial<WindowMotionEnv> = {}): WindowMotionEnv => ({ shown: true, typing: false, behaviorBlocked: false, inputBlocked: false,
  adjusting: false, pat: false, feeding: false, hover: false, pinch: false, pulled: false, asleep: false, rps: false, give: false, hands: false, speaking: false,
  preparing: false, thinking: false, view: faceView(), blocks: NO_MOTION_BLOCKS, showing: false, reacting: false, lidsHeld: 0, blink: 0, mouthOff: false,
  eyesOff: false, ...over });

const host: WindowStageHost = { isBehaviorModelSupported: async () => true,
  resolveChatGesture: async () => { throw Error('none'); }, resolveHerAction: async () => { throw Error('none'); }, reportHerAction: async () => {},
  getBehaviorBodyPlan: async () => ({ mode: 'closed', reason: 'normal-pool-closed', cue: null }) as BodyMotionPlan, resolveBehaviorBody: async () => { throw Error('none'); },
  resolveBehaviorMotion: async () => { throw Error('none'); }, resolveHerLifeMotion: async () => { throw Error('none'); } };

/** A clean song: a kick every half second (120 BPM) on a steady bed, as the capture reports it at 30 Hz. */
export function beatSong(frame: number, rate = 30): MusicEnergySample {
  const beat = Math.round(rate / 2), kick = frame % beat === 0, after = frame % beat === 1;
  return { time: frame / rate, rms: kick ? 0.4 : after ? 0.22 : 0.14, low: kick ? 0.8 : after ? 0.3 : 0.1, mid: 0.2 + Math.sin(frame / 20) * 0.1, high: 0.1 };
}
/** The times of the kicks in beatSong (s from the start of the samples). */
export const BEAT_PERIOD_S = 0.5;

export interface MusicCtx {
  view: MoodView; env: WindowMotionEnv; own: WindowOwnLife;
  /** The 和她一起听 switch: samples flow only while it is on. */
  hearing: boolean;
  /** Seconds of samples since the switch (the song's own clock). */
  song: (frame: number) => MusicEnergySample;
  /** procedural life's 「程序化小动作与表情」 switch. */
  life: boolean;
}

export interface MusicFrame {
  t: number;
  /** Her head's pitch against her upper body (°, + chin down), and the music's own nod offset (rad). */
  headPitch: number; nodX: number;
  tier: string | null; presence: string;
  /** Procedural life's head-tilt weight (what the nod rode on before 2026-11-24). */
  tiltWeight: number;
  /** How much of the nod is on her (MusicNod.shownShare) and why the music yields this frame. */
  nodShown: number; reason: string | null;
}

/** The beat-locked part of `values` (°): averaged over the beats from `from` to `to` by their phase after the first kick at `t0`, top to bottom. */
export function beatFold(frames: readonly MusicFrame[], pick: (f: MusicFrame) => number, t0: number, from: number, to: number, bins = 15): { amp: number; peak: number } {
  const sum = new Array<number>(bins).fill(0), n = new Array<number>(bins).fill(0);
  for (const f of frames) {
    if (f.t < from || f.t >= to) continue;
    const phase = (((f.t - t0) / BEAT_PERIOD_S) % 1 + 1) % 1, b = Math.min(bins - 1, Math.floor(phase * bins));
    sum[b] += pick(f); n[b]++;
  }
  const avg = sum.map((s, i) => s / Math.max(1, n[i]));
  const top = Math.max(...avg);
  // The peak as a phase from the kick, -0.5..0.5 (bin centre).
  const at = (avg.indexOf(top) + 0.5) / bins;
  return { amp: top - Math.min(...avg), peak: at > 0.5 ? at - 1 : at };
}

export async function windowMusicRun(fps: number, seconds: number, script: (t: number, c: MusicCtx) => void,
  options: { settings?: Partial<MusicSettings>; view?: MoodView } = {}) {
  const g = await windowGene();
  let clock = 1_000_000, sampleFrame = 0, songFrame = 0, songStart = -1;
  const now = () => clock;
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  g.figure.setClips({ pose: await standClip(mesh), gesture: null, expression: null }, false);
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); g.body.bindFace(slotBindings(rig, face.blushMorph()));
  face.setCard(card(['closeEyes', 'blush', 'mouth', 'drowsyFace']));
  const lively = new WindowLiveliness(() => {}, () => 0.5), scene = new Scene(), games = new WindowGames(scene);
  scene.add(mesh);
  const lib = await loadLivelinessForEngine(); lively.life.load(lib); lively.sleep.load(lib);
  lively.sleep.attach({ mesh, profile, baseY: 0, hasNeck: true });
  const c: MusicCtx = { view: options.view ?? faceView({ primary: 'calm', companion: null }), env: musicBaseEnv(), own: null as never, hearing: false, song: beatSong, life: true };
  const motions = new WindowMotions(host, () => c.env, now);
  motions.attach({ figure: g.figure, mesh, reviewed: true, retarget: null, transform: undefined, profile, standard: false });
  const own = c.own = new WindowOwnLife({ face: () => face.musicFace(), hasFace: () => face.hasSpeechFace, now, wall: now, danceStarts: () => motions.gatesChanged(true, false) });
  own.herLife.load(lib); own.music.load(await loadMusicForEngine());
  if (options.settings) own.music.setSettings(options.settings);
  own.attach({ figure: g.figure, clips: motions.clips, resolve: () => { throw Error('none'); }, token: () => c.view.token,
    load: (url, owner) => loadLibraryClip(url, owner, undefined), unfit: () => false });
  const bones = TRACKED_BONES.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const head = g.figure.head!, upper = mesh.skeleton.bones.find(b => b.name === '上半身2')!;
  const frames: Quaternion[][] = [], shown: MusicFrame[] = [];
  const rel = new Quaternion(), euler = new Euler();
  try {
    for (let i = 0; i <= Math.round(fps * seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      clock += dt * 1000;
      script(t, c);
      if (!c.hearing) songFrame = 0; else if (songStart < 0) songStart = t;
      // The capture's samples at 30 Hz, only while the switch is on (the wiring's AudioReadingClient).
      if (c.hearing) while (sampleFrame < Math.floor(t * 30) + 1) { own.music.setSample({ ...c.song(songFrame), time: 1000 + sampleFrame / 30 }); sampleFrame++; songFrame++; }
      else sampleFrame = Math.floor(t * 30) + 1;
      lively.life.set(c.life);
      const env = c.env = { ...c.env, view: c.view, music: own.music.moving };
      face.setMood(c.view);
      motions.frame();
      const ownFrame = own.frame(dt, { owner: mesh, env, lifeGates: motions.lifeGates(env), reactionHoldsBody: false, armsHeld: games.armsHeld(false), nowMs: clock });
      const gamesFrame = games.frame(dt, { mesh, pointer: { x: 0.2, y: 0.05 }, follow: true, camera: g.camera, base: ownFrame.activity });
      lively.frame(dt, g.body, face, { view: c.view, rig, env: { shown: true, adjusting: false, voiced: false, speaking: env.speaking, armsHeld: false },
        pointer: { x: 0.2, y: 0.05 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: env.pat, breath: 0.5, pulled: false, handHeld: false, adjusting: false,
        thinking: false, camera: g.camera, lift: g.figure.floorUnits, width: WINDOW.width, height: WINDOW.height, scene, games: gamesFrame, music: ownFrame.music });
      motions.afterBody(dt);
      mesh.updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      rel.copy(upper.getWorldQuaternion(new Quaternion())).invert().multiply(head.getWorldQuaternion(new Quaternion()));
      euler.setFromQuaternion(rel, 'XYZ');
      const st = own.music.getState(), life = lively.life.getState() as { primitives?: { tilt?: { weight: number } } } | null;
      shown.push({ t, headPitch: euler.x * DEG, nodX: st.nod?.headX ?? 0, tier: st.tier, presence: own.music.presence().music,
        tiltWeight: life?.primitives?.tilt?.weight ?? 0, nodShown: st.nod?.shown ?? 0, reason: own.music.yieldReason });
    }
  } finally { motions.dispose(); own.music.dispose(); g.close(); }
  return { frames, shown, songStart };
}
