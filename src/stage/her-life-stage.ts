/**
 * 她自己的生活, stage side (docs/claude/2026-11-02-her-life.md). The host says what she is doing
 * (MoodView.herLife); this turns the shared table (shared/her-life.ts) into
 *  1. an eased LifeActivity for the R18 procedural life (gaze, head, sway, blink, face), and
 *  2. an optional held pose from an existing library motion (thinking: hand to chin; sleepy: a slumped upper body),
 *     written through the stage's own program layer (remembered, restored every frame).
 *
 * Motion rules (R29, how-we-work 「做事方式」 2): everything is a keyframe-like transition, never a jump.
 *  - States cross-fade over HerLifeTiming.crossfadeS (2 s) with an S-curve.
 *  - When the user is here (composing, a reply or speech, a touch or feeding, music, window or camera adjusting,
 *    a preview) her own activity gives way: the procedural offsets in 0.3 s (they are a few degrees), the held pose
 *    by a critically damped weight whose peak angular acceleration along its longest chain stays within
 *    HerLifeTiming.poseAccel (a hand at the chin starts down at once and is mostly down in about two seconds
 *    instead of snapping). Both come back gently afterwards (1.5 s; the pose slower still).
 *  - A higher body owner (a picked motion, an automatic body motion, a chat gesture, music, a head owner) takes the pose the same way.
 *  - The held pose is two keyframe poses of the library motion eased back and forth, never the clip's own
 *    timeline: its inner keys are not velocity-continuous (measured: a 0.2° kink at 60 fps).
 *  - "抬起头": an eased envelope (eyes to the user, chin up a little; 2.15 s plain), started once per host look-up id. The
 *    host's style for it (shared/her-life.ts herLifeLookUpStyle) makes it quicker or slower, more or less chin, a small
 *    tilt or a smile, on that same envelope.
 * No allocation per frame after a clip is bound.
 */
import { MathUtils, Quaternion, type AnimationClip, type Bone, type Interpolant, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { HER_LIFE_NEUTRAL_PRESENTATION, HER_LIFE_TABLE, isHerLifeActivity, readHerLifeLookUpStyle, type HerLifeActivity, type HerLifeLookUpStyle,
  type HerLifeMotion, type HerLifeMotionId, type HerLifeMotionResource, type HerLifePresentation, type HerLifeView } from '../../shared/her-life';
import { isHerNeedId, scaledHerNeedPresentation, type HerNeedView } from '../../shared/her-needs';
import { LIFE_LOOK_UP_LIFT, type LifeActivity } from './procedural-life';
import { watchDirection, watchGaze, type ScreenRect } from '../../shared/behaviors/watch-along/direction';
import { WATCH_ALONG_KNOBS } from '../../shared/behaviors/watch-along/knobs';
import { createVmdParser, type VmdDataTransform } from './vmd';
import { withKeyframeInterpolation } from './keyframe-interpolation';

export interface HerLifeStageGates {
  /** "自动表现" on. */
  expressive: boolean;
  /** The user is here: typing, chat or speech, a touch or feeding, music, window/camera adjusting, a preview. */
  engaged: boolean;
  /** A higher owner holds the body: a picked pose or gesture, an automatic body motion, a chat gesture, music, a head owner. */
  bodyOwned: boolean;
  /** The sleep flow owns her. */
  asleep: boolean;
  /** Card posture intensity (0..100): 0 means no held pose. */
  posture: number;
}
export interface HerLifeStageInput {
  /** The mesh: a new owner starts from neutral and drops its clips. */
  owner: object | null;
  view: HerLifeView | null | undefined;
  gates: HerLifeStageGates;
  /** Wall clock (ms), for the look-up's freshness. */
  nowMs: number;
  /**
   * 她也会需要你 (shared/her-needs.ts, MoodView.herNeed): a small feeling of hers, or the warmth after she was soothed. While it is
   * there it is shown instead of her own activity (same offsets, same cross-fade, same giving way); null or absent: her own activity.
   */
  need?: HerNeedView | null;
  /** How plainly the need shows on this card in this mood (shared/her-needs.ts herNeedVisibility); 1 when absent. */
  needVisibility?: number;
  /**
   * I-006 step 3: where her window is and the display it is on (the browser's own numbers, both in the same coordinates), for looking at
   * the middle of that screen while she follows a video. Absent or unreadable: straight ahead, a little down.
   */
  screen?: { window: ScreenRect; display: ScreenRect } | null;
}
/** The stage's program-layer writer: remember the bone, then slerp it toward `target` by `weight`. */
export interface HerLifeMotionPort { blend(bone: Bone, target: Quaternion, weight: number): void }
export type HerLifeClipLoader = (id: HerLifeMotionId) => Promise<AnimationClip | null>;

export interface HerLifeTiming {
  /** Seconds her procedural offsets take to give way, and to come back. */
  yieldS: number;
  returnS: number;
  /** Seconds between two states. */
  crossfadeS: number;
  /** "抬起头" envelope (s). */
  lookUp: { rise: number; hold: number; fall: number };
  /** Peak angular acceleration (°/s²) of the held pose along its longest bone chain: entering, and giving way. Infinity = instant. */
  poseAccel: { enter: number; yield: number };
}
export const HER_LIFE_TIMING: Readonly<HerLifeTiming> = Object.freeze({ yieldS: 0.3, returnS: 1.5, crossfadeS: 2,
  lookUp: Object.freeze({ rise: 0.35, hold: 1, fall: 0.8 }), poseAccel: Object.freeze({ enter: 300, yield: 800 }) });

const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const clamp01 = (value: number) => clamp(value, 0, 1);
const smoothstep = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const KEYS = Object.keys(HER_LIFE_NEUTRAL_PRESENTATION) as (keyof HerLifePresentation)[];
const FRAME_RATE = 30;

interface BoundTrack { bone: Bone; from: Quaternion; to: Quaternion; parent: number; finger: boolean }
interface PoseSlot {
  id: HerLifeMotionId;
  motion: HerLifeMotion;
  tracks: BoundTrack[];
  /** Largest chain angle (degrees) between the base and the held pose; measured on the first frame shown. */
  span: number | null;
  weight: number;
  velocity: number;
  phase: number;
}
interface ClipEntry { state: 'loading' | 'ready' | 'failed'; clip: AnimationClip | null; retryAt: number }
const CLIP_RETRY_S = 20;
/** The strength of a need changes over minutes; the stage follows it with this time constant (s), so a pat's progress never steps. */
const NEED_STRENGTH_TAU_S = 1.5;
const POSE_UNDERSHOOT = 0.02;

export interface HerLifeStageState {
  activity: HerLifeActivity;
  presence: number;
  blend: number;
  lookUp: number;
  pose: { id: HerLifeMotionId; weight: number; span: number | null; phase: number } | null;
  clips: Partial<Record<HerLifeMotionId, ClipEntry['state']>>;
  /** I-006 step 3: how much she is following the screen, 0..1. */
  watch: number;
  /** The need shown now ("need:lonely" / "glow" / "low"), or null. */
  need: string | null;
}

export class HerLifeStage {
  private owner: object | null = null;
  private time = 0;
  private activity: HerLifeActivity = 'company';
  /** What the cross-fade is toward: her activity, "need:<id>" or "glow". */
  private cross = 'company';
  private needStrength = 0;
  private needShown = false;
  private readonly needTo: HerLifePresentation = { ...HER_LIFE_NEUTRAL_PRESENTATION };
  private readonly from: HerLifePresentation = { ...HER_LIFE_NEUTRAL_PRESENTATION };
  private readonly shown: HerLifePresentation = { ...HER_LIFE_NEUTRAL_PRESENTATION };
  private blend = 1;
  private presence = 0;
  private expressiveWeight = 0;
  private beatPhase = 0;
  private lookUpId: string | null = null;
  private lookUpTime = Infinity;
  /** How she looks up this time (shared/her-life.ts herLifeLookUpStyle); null: the plain look-up. */
  private lookUpStyle: HerLifeLookUpStyle | null = null;
  /** I-006 step 3: how much she is following the screen (0..1, eased), and the eased direction to the middle of her screen (x right, y up). */
  private watchWeight = 0;
  private watchX = 0;
  private watchY = 0;
  private slot: PoseSlot | null = null;
  private readonly clips = new Map<HerLifeMotionId, ClipEntry>();
  private readonly target = new Quaternion();
  private diagnosticsAt = -Infinity;
  private diagnosticsText = 'null';
  private lastGates: HerLifeStageGates | null = null;
  /** This frame's activity for procedural life (never reallocated). */
  readonly life: LifeActivity = { gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0, sway: 1, bodyZ: 0,
    blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0, lookUp: 0 };

  constructor(private loader: HerLifeClipLoader | null = null, private readonly timing: Readonly<HerLifeTiming> = HER_LIFE_TIMING) {}

  reset(owner: object | null = null): void {
    this.owner = owner; this.activity = 'company'; this.cross = 'company'; this.needStrength = 0; this.needShown = false; this.blend = 1; this.presence = 0; this.expressiveWeight = 0; this.beatPhase = 0;
    Object.assign(this.from, HER_LIFE_NEUTRAL_PRESENTATION); Object.assign(this.shown, HER_LIFE_NEUTRAL_PRESENTATION);
    this.lookUpTime = Infinity; this.lookUpStyle = null; this.watchWeight = 0; this.watchX = 0; this.watchY = 0; this.slot = null; this.clips.clear();
    this.write(0, 0);
  }

  frame(delta: number, input: HerLifeStageInput): LifeActivity {
    if (input.owner !== this.owner) this.reset(input.owner);
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0, view = input.view, gates = input.gates;
    this.lastGates = gates;
    this.time += dt;
    // A new state cross-fades from whatever is shown now.
    // "跟着看" needs what she follows to be still there (the host also says so); without it she is simply with the user.
    const next = view && isHerLifeActivity(view.activity) && (view.activity !== 'watching' || view.watch) ? view.activity : 'company';
    this.activity = next;
    // A small feeling of hers replaces what she is doing while it lasts; the glow after she was soothed looks the same whatever soothed her.
    const need = input.need && isHerNeedId(input.need.id) && (input.need.mode === 'need' || input.need.mode === 'glow' || input.need.mode === 'low') && input.need.strength > 0 ? input.need : null;
    // The glow after she was soothed and the quiet look of 低落 are the same whatever the need was.
    const key = need ? (need.mode === 'need' ? `need:${need.id}` : need.mode) : next;
    const visibility = Number.isFinite(input.needVisibility) ? clamp(input.needVisibility!, 0, 1.5) : 1;
    if (key !== this.cross) { Object.assign(this.from, this.shown); this.cross = key; this.blend = 0; if (need) this.needStrength = clamp01(need.strength) * visibility; }
    this.needShown = need !== null;
    const timing = this.timing;
    this.blend = Math.min(1, this.blend + dt / timing.crossfadeS);
    let to: HerLifePresentation = HER_LIFE_TABLE[next].presentation;
    if (need) {
      // The card and her mood size it (visibility); a change in either eases in like the need's own strength, never a step.
      this.needStrength += (clamp01(need.strength) * visibility - this.needStrength) * (1 - Math.exp(-dt / NEED_STRENGTH_TAU_S));
      to = scaledHerNeedPresentation(need, this.needStrength, this.needTo);
    }
    const k = smoothstep(this.blend);
    for (const key of KEYS) this.shown[key] = this.from[key] + (to[key] - this.from[key]) * k;
    const present = gates.expressive && !gates.engaged && !gates.asleep;
    this.presence = present ? Math.min(1, this.presence + dt / timing.returnS) : Math.max(0, this.presence - dt / timing.yieldS);
    this.expressiveWeight = gates.expressive ? Math.min(1, this.expressiveWeight + dt / timing.yieldS) : Math.max(0, this.expressiveWeight - dt / timing.yieldS);
    this.beatPhase = (this.beatPhase + 2 * Math.PI * Math.max(0, this.shown.beatHz) * dt) % (2 * Math.PI);
    // I-006 step 3: the eyes turn toward the middle of her screen as she starts following, and follow when the window is dragged (eased, never a step).
    const direction = watchDirection(input.screen?.window, input.screen?.display), follow = 1 - Math.exp(-dt / Math.max(0.05, WATCH_ALONG_KNOBS.gaze.followSeconds));
    this.watchWeight += ((next === 'watching' && !need ? 1 : 0) - this.watchWeight) * (1 - Math.exp(-dt / 1.2));
    this.watchX += (direction.x - this.watchX) * follow; this.watchY += (direction.y - this.watchY) * follow;
    // "抬起头": once per host look-up, while it is fresh.
    const lookUp = view?.lookUp;
    if (lookUp && lookUp.id !== this.lookUpId) {
      this.lookUpId = lookUp.id;
      const age = input.nowMs - lookUp.at;
      if (Number.isFinite(age) && age >= -1_000 && age <= 5_000) { this.lookUpTime = 0; this.lookUpStyle = readHerLifeLookUpStyle(lookUp.style); }
    }
    this.lookUpTime += dt;
    // Her own way of looking up this time: slower or quicker, held longer or shorter (the same eased envelope).
    const style = this.lookUpStyle, pace = style?.pace ?? 1, t = this.lookUpTime;
    const rise = timing.lookUp.rise * pace, hold = timing.lookUp.hold * (style?.hold ?? 1), fall = timing.lookUp.fall * pace;
    const envelope = t < rise + hold + fall ? smoothstep(t / rise) * (1 - smoothstep((t - rise - hold) / fall)) : 0;
    this.write(smoothstep(this.presence), envelope * smoothstep(this.expressiveWeight));
    this.framePose(dt, present, gates);
    return this.life;
  }

  /** The held pose through the stage's program layer; call after procedural life's own body writes. */
  applyPose(port: HerLifeMotionPort): void {
    const slot = this.slot;
    if (!slot) return;
    // Eased between the motion's two keyframe poses: zero speed at both ends, so it never kinks or loops with a seam.
    const wave = (1 - Math.cos(2 * Math.PI * slot.phase)) / 2, measuring = slot.span === null;
    let span = 0;
    const local = measuring ? new Float64Array(slot.tracks.length) : null;
    for (let index = 0; index < slot.tracks.length; index++) {
      const track = slot.tracks[index];
      this.target.slerpQuaternions(track.from, track.to, wave);
      if (local) {
        // Chain angle: this bone plus its overlaid ancestors (they turn the same limb together). Fingers are too small to count.
        local[index] = (track.finger ? 0 : MathUtils.radToDeg(track.bone.quaternion.angleTo(this.target))) + (track.parent >= 0 ? local[track.parent] : 0);
        span = Math.max(span, local[index]);
      }
      if (slot.weight > 1e-6) port.blend(track.bone, this.target, slot.weight);
    }
    if (measuring) slot.span = Math.max(5, span);
  }

  /** The owners as of the last frame: P1's reactions (pose-reaction-stage.ts) give way to exactly the same ones. */
  get gates(): Readonly<HerLifeStageGates> | null { return this.lastGates; }

  getState(): HerLifeStageState {
    const round = (value: number) => Math.round(value * 1e4) / 1e4, slot = this.slot;
    const clips: HerLifeStageState['clips'] = {};
    for (const [id, entry] of this.clips) clips[id] = entry.state;
    return { activity: this.activity, presence: round(this.presence), blend: round(this.blend), lookUp: round(this.life.lookUp),
      watch: round(this.watchWeight),
      pose: slot ? { id: slot.id, weight: round(slot.weight), span: slot.span === null ? null : round(slot.span), phase: round(slot.phase % 1) } : null, clips,
      need: this.cross === 'glow' || this.cross === 'low' || this.cross.startsWith('need:') ? this.cross : null };
  }
  /** `data-her-life` text, refreshed at most every 250 ms of the caller's clock (ms). */
  diagnostics(nowMs: number): string {
    if (!(nowMs - this.diagnosticsAt < 250)) { this.diagnosticsAt = nowMs; this.diagnosticsText = JSON.stringify(this.getState()); }
    return this.diagnosticsText;
  }

  private write(presence: number, lookUp: number): void {
    const s = this.shown, life = this.life, beat = Math.sin(this.beatPhase), style = this.lookUpStyle;
    // The look-up's own amount: more or less chin than the plain lift (procedural life adds LIFE_LOOK_UP_LIFT × lookUp), a
    // small tilt and a smile, all on the look-up's envelope (zero outside it, so a plain look-up is exactly as before).
    const lift = style && lookUp > 0 ? LIFE_LOOK_UP_LIFT * (style.lift - 1) * lookUp : 0;
    const tilt = style && lookUp > 0 ? style.tilt * lookUp : 0, smile = style && lookUp > 0 ? style.smile * lookUp : 0;
    life.gazeX = s.gazeX * presence; life.gazeY = s.gazeY * presence;
    life.pointerFollow = 1 + (s.pointerFollow - 1) * presence; life.saccade = 1 + (s.saccade - 1) * presence; life.lookAtUser = 1 + (s.lookAtUser - 1) * presence;
    life.headX = s.headX * presence - lift + 0; life.headY = s.headY * presence; life.headZ = (s.headZ + s.beatHead * beat) * presence + tilt;
    life.sway = 1 + (s.sway - 1) * presence; life.bodyZ = s.beatBody * beat * presence;
    life.blinkInterval = 1 + (s.blinkInterval - 1) * presence;
    life.lidSoft = s.lidSoft * presence; life.smileEyes = Math.max(s.smileEyes * presence, smile); life.mouthSmile = Math.max(s.mouthSmile * presence, smile * 0.6);
    life.lookUp = lookUp;
    const follow = this.watchWeight * presence, gaze = watchGaze({ x: this.watchX, y: this.watchY });
    life.gazeFixedX = gaze.x * follow + 0; life.gazeFixedY = gaze.y * follow + 0;
  }

  private framePose(dt: number, present: boolean, gates: HerLifeStageGates): void {
    const motion = this.needShown ? undefined : HER_LIFE_TABLE[this.activity].motion;
    const wanted = motion && present && !gates.bodyOwned && gates.posture > 0 ? motion : null;
    if (wanted) this.request(wanted.id);
    let slot = this.slot;
    // One held pose at a time: another one waits until this one has fully given way.
    if (slot && slot.id !== wanted?.id && slot.weight <= 1e-4 && Math.abs(slot.velocity) < 1e-3) this.slot = slot = null;
    if (!slot && wanted) slot = this.slot = this.bind(wanted);
    if (!slot) return;
    const target = slot.id === wanted?.id ? clamp01(slot.motion.weight * Math.min(1, gates.posture / 50)) : 0;
    if (slot.span === null) { slot.weight = slot.velocity = 0; return; } // measured by the first applyPose
    if (target > 0 || slot.weight > 0) slot.phase = (slot.phase + dt / Math.max(1, slot.motion.periodS)) % 2;
    // Critically damped weight: continuous speed through every reversal; ω keeps the chain's peak acceleration in budget.
    const accel = target > slot.weight ? this.timing.poseAccel.enter : this.timing.poseAccel.yield;
    if (!Number.isFinite(accel)) { slot.weight = target; slot.velocity = 0; return; }
    const omega = clamp(Math.sqrt(accel / slot.span), 0.8, 6);
    // Giving way aims a hair below zero, so it lands at exactly zero (at a crawl) instead of creeping toward it forever.
    const aim = target > 0 ? target : -POSE_UNDERSHOOT;
    slot.velocity += (omega * omega * (aim - slot.weight) - 2 * omega * slot.velocity) * dt;
    slot.weight += slot.velocity * dt;
    if (slot.weight <= 0) { slot.weight = 0; slot.velocity = 0; }
    if (slot.weight >= 1) { slot.weight = 1; if (slot.velocity > 0) slot.velocity = 0; }
  }

  private request(id: HerLifeMotionId): void {
    const previous = this.clips.get(id);
    // A refusal (no grant, the scope changed while loading, an unfit model) is retried after a while, never per frame.
    if (!this.loader || previous && (previous.state !== 'failed' || this.time < previous.retryAt)) return;
    const owner = this.owner, entry: ClipEntry = { state: 'loading', clip: null, retryAt: Infinity };
    this.clips.set(id, entry);
    const fail = () => { if (this.clips.get(id) === entry) { entry.state = 'failed'; entry.retryAt = this.time + CLIP_RETRY_S; } };
    let pending: Promise<AnimationClip | null>;
    try { pending = this.loader(id); } catch { fail(); return; }
    void pending.then(clip => {
      if (this.owner !== owner || this.clips.get(id) !== entry) return;
      if (clip) { entry.clip = clip; entry.state = 'ready'; } else fail();
    }, fail);
  }

  private bind(motion: HerLifeMotion): PoseSlot | null {
    const entry = this.clips.get(motion.id), mesh = this.owner as SkinnedMesh | null;
    if (entry?.state !== 'ready' || !entry.clip || !mesh?.skeleton) return null;
    const bones = new Map<string, Bone>(), ambiguous = new Set<string>();
    for (const bone of mesh.skeleton.bones) { if (bones.has(bone.name)) ambiguous.add(bone.name); else bones.set(bone.name, bone); }
    const allowed = new RegExp(motion.bones, 'u'), tracks: BoundTrack[] = [];
    const sample = (interpolant: Interpolant, frame: number, out: Quaternion): boolean => {
      const values = interpolant.evaluate(frame / FRAME_RATE);
      out.set(values[0], values[1], values[2], values[3]);
      return out.lengthSq() > 1e-12 && [out.x, out.y, out.z, out.w].every(Number.isFinite) && !!out.normalize();
    };
    for (const track of entry.clip.tracks) {
      const match = /^\.bones\[([^\]]+)\]\.quaternion$/u.exec(track.name);
      if (!match || !allowed.test(match[1]) || ambiguous.has(match[1]) || track.getValueSize() !== 4) continue;
      const bone = bones.get(match[1]);
      if (!bone || tracks.some(value => value.bone === bone)) continue;
      // The two keyframe poses, sampled once with MMDLoader's own interpolant (its Bezier curves); the track is never rebuilt.
      try {
        const interpolant = track.createInterpolant(), from = new Quaternion(), to = new Quaternion();
        if (sample(interpolant, motion.fromFrame, from) && sample(interpolant, motion.toFrame, to))
          tracks.push({ bone, from, to, parent: -1, finger: /指/u.test(match[1]) });
      } catch { /* That bone stays as it is. */ }
    }
    if (!tracks.length) { entry.state = 'failed'; return null; }
    // Parents first, so a chain angle can add its ancestors'.
    const depth = (bone: Bone) => { let d = 0; for (let node = bone.parent; node; node = node.parent) d++; return d; };
    tracks.sort((a, b) => depth(a.bone) - depth(b.bone));
    for (const track of tracks) {
      for (let node = track.bone.parent; node; node = node.parent) {
        const index = tracks.findIndex(value => value.bone === node);
        if (index >= 0) { track.parent = index; break; }
      }
    }
    return { id: motion.id, motion, tracks, span: null, weight: 0, velocity: 0, phase: 0 };
  }
}

/**
 * I-006 step 3: where this window is and the display it is on, from the browser's own numbers (window.screenX/Y and size; the display's
 * work area: screen.availLeft/Top/Width/Height, which Chromium gives for the display the window is on, so a second screen or a negative
 * origin needs nothing special). Null where any of it is missing.
 */
export function readScreenPlace(globals: unknown = globalThis): { window: ScreenRect; display: ScreenRect } | null {
  try {
    const w = (globals as { window?: Record<string, unknown> }).window ?? (globals as Record<string, unknown>);
    const s = (w.screen ?? null) as Record<string, unknown> | null;
    const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const rect = { x: n(w.screenX), y: n(w.screenY), width: n(w.outerWidth), height: n(w.outerHeight) };
    const display = { x: n(s?.availLeft), y: n(s?.availTop), width: n(s?.availWidth), height: n(s?.availHeight) };
    if ([...Object.values(rect), ...Object.values(display)].some(value => value === null)) return null;
    return { window: rect as ScreenRect, display: display as ScreenRect };
  } catch { return null; }
}

/**
 * The stage's clip loader: the host's pinned grant for this motion (window.desktop.resolveHerLifeMotion), the
 * stage's own VMD parser and retarget transform, and its fit check. Any refusal, a model or scope change while
 * loading, or a missing bridge is "no held pose" (the procedural part stays).
 */
export function herLifeStageLoader(source: {
  mesh(): SkinnedMesh | null;
  token(): string | null;
  transform(): VmdDataTransform | undefined;
  unfit(sha256: string): boolean;
}): HerLifeClipLoader {
  return async id => {
    const mesh = source.mesh(), token = source.token();
    const resolve = (globalThis as { window?: { desktop?: { resolveHerLifeMotion?: (motionId: string, token: string) => Promise<HerLifeMotionResource> } } }).window?.desktop?.resolveHerLifeMotion;
    if (!mesh || !token || typeof resolve !== 'function') return null;
    const current = () => source.mesh() === mesh && source.token() === token;
    try {
      const resource = await resolve(id, token);
      if (!current() || resource?.motionId !== id || typeof resource.url !== 'string' || source.unfit(resource.sha256)) return null;
      const loader = withKeyframeInterpolation(new MMDLoader());
      (loader as unknown as { parser: object }).parser = createVmdParser(undefined, source.transform());
      const clip = await new Promise<AnimationClip>((resolve, reject) => loader.loadAnimation(resource.url, mesh, value => resolve(value as AnimationClip), undefined, reject));
      return current() ? clip : null;
    } catch { return null; }
  };
}
