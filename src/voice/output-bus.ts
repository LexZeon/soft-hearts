/**
 * I-177 batch 2 (plan item 4 "先侧耳听，再判断"): one gain stage in front of the window's output, so her voice can be made quieter and
 * louder again without touching any player. Her cloud reading (./EmotionalVoice.ts) connects to `input(context)` instead of the
 * destination; the I-150 wake tone does not (it must keep the output awake whatever the volume).
 *
 * `set(level, ms)` moves the level along a smoothstep curve (an eased start and an eased end, like a key-framed transition: the speed is
 * continuous, never a jump; user's motion rule, R29). A new target taken mid-way starts from where the curve is at that moment. The level
 * only ever scales the sound; nothing here stops, cuts or mutes a player (the duck alone never stops her: src/voice/voice-call/call-duck.ts).
 * Pure scheduling over an AudioParam; tests use a fake one.
 */

export interface BusClock { currentTime: number }
interface Ramp { from: number; to: number; at: number; seconds: number }

/** The eased curve's value at progress x in [0, 1]. */
export const smoothstep = (x: number): number => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

export class OutputBus {
  private context: AudioContext | null = null;
  private node: GainNode | null = null;
  private ramp: Ramp = { from: 1, to: 1, at: 0, seconds: 0 };

  /** The level at context time `t` (seconds) on the curve set last. */
  levelAt(t: number): number {
    const r = this.ramp;
    if (!(r.seconds > 0) || t >= r.at + r.seconds) return r.to;
    if (t <= r.at) return r.from;
    return r.from + (r.to - r.from) * smoothstep((t - r.at) / r.seconds);
  }
  /** Where the level is going (1 = her normal volume). */
  get target(): number { return this.ramp.to; }

  /** The node her voice connects to on `context` (made once per context, at the current level). Falls back to the destination. */
  input(context: AudioContext): AudioNode {
    if (this.context === context && this.node) return this.node;
    this.detach();
    try {
      const node = context.createGain();
      const level = this.ramp.to; // a new context starts where the level was going
      node.gain.value = level;
      node.connect(context.destination);
      this.context = context; this.node = node;
      this.ramp = { from: level, to: level, at: context.currentTime, seconds: 0 };
      return node;
    } catch { return context.destination; }
  }

  /** Move to `level` (0..1) over `ms`, eased. Without a context yet, only the level is remembered. */
  set(level: number, ms: number): void {
    const to = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 1));
    const context = this.context, node = this.node;
    const now = context ? context.currentTime : 0;
    const from = context ? this.levelAt(now) : this.ramp.to;
    const seconds = Math.max(0, ms) / 1000;
    this.ramp = { from, to, at: now, seconds: context ? seconds : 0 };
    if (!context || !node) return;
    const param = node.gain as Partial<AudioParam> & { value: number };
    try {
      param.cancelScheduledValues?.(now);
      if (seconds > 0 && from !== to && typeof param.setValueCurveAtTime === 'function') {
        const steps = Math.max(8, Math.min(256, Math.ceil(seconds * 240)));
        const curve = new Float32Array(steps);
        for (let i = 0; i < steps; i++) curve[i] = from + (to - from) * smoothstep(i / (steps - 1));
        param.setValueCurveAtTime(curve, now, seconds);
        return;
      }
      if (typeof param.setValueAtTime === 'function') { param.setValueAtTime(to, now); return; }
    } catch { /* an automation clash: take the value now */ }
    param.value = to;
  }

  /** The context went away (replaced or closed): the next input() makes a new node at the remembered level. */
  detach(): void {
    const node = this.node;
    this.node = null; this.context = null;
    this.ramp = { from: this.ramp.to, to: this.ramp.to, at: 0, seconds: 0 };
    try { node?.disconnect(); } catch { /* gone */ }
  }
}
