/**
 * #11 舞台这一侧的真实现：按主机挑中的样子演"动一动""看你一眼"（接口见 interface.ts）。
 *
 * 每种样子是头（俯仰 x、左右 y、歪 z）和眼睛的几条关键帧曲线，关键帧之间单调三次插值（速度连续、不冲过头），两端
 * 速度为零；幅度、快慢、方向由主机定。输出交给 MoodFeedback，再经过它原有的弹簧和 12° 上限，所以只能更平滑。
 * 一旦开始就演完（时机 3 秒就结束也一样）；自动头部动作不可以动时（身体动作占着头、睡着），按临界阻尼平滑让开。
 * 只动头和眼睛：所有 MMD 模型都有（R18 的呼吸、视线漂移、小歪头、重心轻摆、眨眼不动，这里只是叠加）。
 */
import { IDLE_SHAPE_IDS, type IdleShapeId } from './knobs';
import { IDLE_GESTURE_REST, type IdleGestureFrame, type IdleGestureStage, type IdleGestureView } from './interface';

type Keys = readonly (readonly [number, number])[];
interface Timeline {
  /** 秒（快慢 = 1 时），所有通道到这时都回到 0。 */
  readonly duration: number;
  /** 头：x 俯仰（> 0 低头）、y 左右、z 歪；值 × 幅度。 */
  readonly x?: Keys; readonly y?: Keys; readonly z?: Keys;
  /** 眼睛：弧度（× 眼睛倍数），pitch < 0 往上看你。 */
  readonly eyeYaw?: Keys; readonly eyePitch?: Keys;
  /** 这几条按方向（side）翻转。 */
  readonly sided: readonly ('y' | 'z' | 'eyeYaw')[];
}

/** 每种样子的曲线（内部常数；幅度和快慢在 knobs.ts）。 */
export const IDLE_GESTURE_TIMELINES: Readonly<Record<IdleShapeId, Timeline>> = Object.freeze({
  // 歪头：歪过去，停一停，再回来；眼睛微微抬起看你。
  tilt: { duration: 2.6, z: [[0, 0], [0.7, 1], [1.8, 0.92], [2.6, 0]], eyePitch: [[0, 0], [0.4, -0.01], [2.0, -0.01], [2.6, 0]], sided: ['z'] },
  // 轻轻点头：低一下，稍停，抬回来；眼睛留在你身上。
  nod: { duration: 1.7, x: [[0, 0], [0.45, 1], [0.8, 0.85], [1.7, 0]], eyePitch: [[0, 0], [0.3, -0.012], [1.2, -0.012], [1.7, 0]], sided: [] },
  // 看向一边再看回来：眼睛先走，头跟上，再一起回来。
  glance: { duration: 2.3, y: [[0, 0], [0.5, 1], [1.3, 0.95], [2.3, 0]], eyeYaw: [[0, 0], [0.25, 0.05], [1.25, 0.05], [1.9, 0]], sided: ['y', 'eyeYaw'] },
  // 抬眼看你：下巴微抬，眼睛往上看你。
  lift: { duration: 2.6, x: [[0, 0], [0.55, -1], [1.9, -0.9], [2.6, 0]], eyePitch: [[0, 0], [0.3, -0.03], [2.0, -0.028], [2.6, 0]], sided: [] },
  // 伸伸脖子：慢慢仰头带一点歪，停一下，再慢慢回来。
  stretch: { duration: 2.9, x: [[0, 0], [1.0, -1], [1.7, -0.95], [2.9, 0]], z: [[0, 0], [1.0, 0.5], [1.7, 0.5], [2.9, 0]], sided: ['z'] },
  // 轻轻晃一下头：原来那个轻摆头（左右各一下），眼睛微抬。
  sway: { duration: 3.0, z: [[0, 0], [0.75, 1], [1.5, 0], [2.25, -1], [3.0, 0]], eyePitch: [[0, 0], [0.4, -0.015], [2.6, -0.015], [3.0, 0]], sided: ['z'] },
});

/** 单调三次插值（Fritsch–Butland 斜率）：关键帧之间速度连续、不冲过头，两端速度为零。 */
export function sampleIdleKeys(keys: Keys, t: number): number {
  const n = keys.length;
  if (!n) return 0;
  if (!(t > keys[0][0])) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0;
  while (i < n - 2 && t >= keys[i + 1][0]) i++;
  const [t0, v0] = keys[i], [t1, v1] = keys[i + 1], h = t1 - t0;
  const slope = (j: number): number => {
    if (j <= 0 || j >= n - 1) return 0;
    const a = (keys[j][1] - keys[j - 1][1]) / (keys[j][0] - keys[j - 1][0]), b = (keys[j + 1][1] - keys[j][1]) / (keys[j + 1][0] - keys[j][0]);
    if (a * b <= 0) return 0;
    const h0 = keys[j][0] - keys[j - 1][0], h1 = keys[j + 1][0] - keys[j][0], w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const m0 = slope(i), m1 = slope(i + 1), s = (t - t0) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * m1;
}

const within = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** 舞台读主机给的样子：缺了或超出范围就当没有（原来的轻摆头接着用）。 */
export function readIdleGesture(value: unknown): IdleGestureView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.cueId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(v.cueId) || (v.kind !== 'look' && v.kind !== 'motion')
    || !(IDLE_SHAPE_IDS as readonly unknown[]).includes(v.shape) || (v.side !== 1 && v.side !== -1)
    || !within(v.amplitude, 0, 0.2) || !within(v.eyes, 0, 3) || !within(v.pace, 0.5, 2) || !within(v.smile, 0, 1.5)) return null;
  return { cueId: v.cueId, kind: v.kind, shape: v.shape as IdleShapeId, side: v.side, amplitude: v.amplitude, eyes: v.eyes, pace: v.pace, smile: v.smile };
}

/** 一个样子此刻（开始后 `age` 秒）的头和眼睛偏移。 */
export function sampleIdleGesture(view: IdleGestureView, age: number): { x: number; y: number; z: number; eyeYaw: number; eyePitch: number; done: boolean } {
  const line = IDLE_GESTURE_TIMELINES[view.shape], t = age / view.pace;
  const sign = (channel: 'y' | 'z' | 'eyeYaw') => line.sided.includes(channel) ? view.side : 1;
  const head = (keys: Keys | undefined) => keys ? sampleIdleKeys(keys, t) * view.amplitude : 0;
  const eyes = (keys: Keys | undefined) => keys ? sampleIdleKeys(keys, t) * view.eyes : 0;
  return { x: head(line.x), y: head(line.y) * sign('y'), z: head(line.z) * sign('z'),
    eyeYaw: eyes(line.eyeYaw) * sign('eyeYaw'), eyePitch: eyes(line.eyePitch), done: t >= line.duration };
}

/** 让开 / 回来的快慢（临界阻尼的 ω）。 */
const GATE_OMEGA = 8;

export class IdleGesturePerformer implements IdleGestureStage {
  private playing: { view: IdleGestureView; age: number }[] = [];
  private lastCue = '';
  private gate = 0;
  private gateVelocity = 0;

  reset(): void { this.playing = []; this.lastCue = ''; this.gate = 0; this.gateVelocity = 0; }

  frame(delta: number, gesture: unknown, allowed: boolean): IdleGestureFrame {
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    const view = gesture === undefined ? null : readIdleGesture(gesture);
    if (view && view.cueId !== this.lastCue) {
      this.lastCue = view.cueId;
      // A new one rides on top of one still finishing (both are smooth, so their sum is too).
      this.playing = [...this.playing.slice(-2), { view, age: 0 }];
    }
    // Critically damped toward allowed every frame (exact for any frame time): giving way never cuts, and a new
    // gesture finds the gate already where it should be.
    const target = allowed ? 1 : 0, error = this.gate - target, decay = Math.exp(-GATE_OMEGA * dt), carry = this.gateVelocity + GATE_OMEGA * error;
    this.gateVelocity = (this.gateVelocity - GATE_OMEGA * carry * dt) * decay;
    this.gate = target + (error + carry * dt) * decay;
    if (Math.abs(this.gate - target) < 1e-6 && Math.abs(this.gateVelocity) < 1e-6) { this.gate = target; this.gateVelocity = 0; }
    if (!this.playing.length) return view ? { ...IDLE_GESTURE_REST, smile: view.smile, owns: true } : IDLE_GESTURE_REST;
    let x = 0, y = 0, z = 0, eyeYaw = 0, eyePitch = 0;
    for (const item of this.playing) {
      item.age += dt;
      const sample = sampleIdleGesture(item.view, item.age);
      x += sample.x; y += sample.y; z += sample.z; eyeYaw += sample.eyeYaw; eyePitch += sample.eyePitch;
    }
    const latest = this.playing[this.playing.length - 1].view;
    this.playing = this.playing.filter(item => !sampleIdleGesture(item.view, item.age).done);
    const g = this.gate;
    return { x: x * g, y: y * g, z: z * g, eyeYaw: eyeYaw * g, eyePitch: eyePitch * g, smile: latest.smile, owns: true };
  }
}
