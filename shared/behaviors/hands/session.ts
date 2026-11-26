/**
 * I-087 一次伸手的经过（纯状态机，桌宠窗口每一帧推一下；没有 DOM、没有舞台）：
 *
 *   reaching ─(伸到位)→ waiting ─(碰一下)→ held（牵手）/ touched（拉钩、击掌）
 *       │                  └─(等够了没碰)→ back：她自己悄悄收回（not-taken，不说你、不内疚）
 *       └─(碰一下)→ 同上（手已经伸出来一大半时也算）
 *   held ─(再碰一下 / 你的手走远了一会儿)→ back（let-go）· 偶尔轻轻回握一下（squeeze）
 *   touched ─(碰完那一下)→ back
 *   任何时候被打断（摸头、喂食、拖窗口、窗口藏起来、主机取消）→ back（interrupted）
 *   back ─(舞台收回到位)→ done
 *
 * 输入只有抽象的两样：`touch`（碰了一下：现在是点击，以后可以是姿势识别里你伸过来的手）和 `far`（你的手走远了）。
 * 输出：给舞台的命令、给主机的回答（每次伸手：点上一次；牵手再加结束一次），和 emoji 提示该不该显示（和摸头一样：在她手上时显示）。
 */
import { HAND_DONE_EMOJI, HAND_EMOJI, HANDS_KNOBS, type HandEmoji, type HandOutcome, type HandStyle, type HandUse } from './knobs';

export type HandsSessionPhase = 'reaching' | 'waiting' | 'held' | 'touched' | 'back' | 'done';
export type HandsStageCommand = 'hold' | 'touch' | 'squeeze' | 'release';

export interface HandsSessionInput {
  readonly now: number;
  /** The stage: her hand has arrived (the reach is done). */
  readonly arrived: boolean;
  /** "碰了一下": a click on her hand (later: a pose touch). */
  readonly touch: boolean;
  /** "你的手走远了": out of her reach, or out of her window. */
  readonly far: boolean;
  /** A pat, a snack, a drag, the window hidden. */
  readonly blocked: boolean;
  /** The stage has nothing of this reach left (after a release). */
  readonly stageIdle: boolean;
}
export interface HandsSessionStep {
  readonly commands: readonly HandsStageCommand[];
  readonly answers: readonly HandOutcome[];
}

const NOTHING: HandsSessionStep = Object.freeze({ commands: [], answers: [] });

export class HandsSession {
  private phaseValue: HandsSessionPhase = 'reaching';
  private readonly started: number;
  private waitSince = 0;
  private touchSince = 0;
  private farSince: number | null = null;
  private nextSqueeze = Infinity;
  private finished = false;

  constructor(readonly offer: { readonly id: string; readonly use: HandUse; readonly waitMs: number; readonly style: HandStyle }, now: number,
    private readonly random: () => number = Math.random, private readonly knobs = HANDS_KNOBS) {
    this.started = now;
  }

  get phase(): HandsSessionPhase { return this.phaseValue; }
  get done(): boolean { return this.phaseValue === 'done'; }
  /** The answers are over (the host heard how it ended); the stage may still be bringing her hand back. */
  get answered(): boolean { return this.finished; }

  /** The emoji hint (the head pat's): over her hand while she reaches and waits; while holding and at the touch, wherever you are. */
  emoji(hovered: boolean): HandEmoji | null {
    const phase = this.phaseValue;
    if (phase === 'held' || phase === 'touched') return HAND_DONE_EMOJI[this.offer.use]; // taken: the "done" emoji (a hold keeps it until let-go)
    if ((phase === 'reaching' || phase === 'waiting') && hovered) return HAND_EMOJI[this.offer.use];
    return null;
  }

  /** The host took it back (cancel), or the window is going away: back, and the end answer if one is still owed. */
  cancel(): HandsSessionStep {
    if (this.phaseValue === 'back' || this.phaseValue === 'done') return NOTHING;
    return this.back(this.finished ? null : 'interrupted');
  }

  step(input: HandsSessionInput): HandsSessionStep {
    const now = input.now;
    switch (this.phaseValue) {
      case 'reaching':
      case 'waiting': {
        if (input.blocked) return this.back('interrupted');
        if (input.touch) return this.take(now);
        if (this.phaseValue === 'reaching') {
          // Arrived, or a reach that never reports arriving (no arm on this model): the wait starts anyway.
          if (input.arrived || now - this.started > 6_000) { this.phaseValue = 'waiting'; this.waitSince = now; }
          return NOTHING;
        }
        if (now - this.waitSince >= this.offer.waitMs) return this.back('not-taken');
        return NOTHING;
      }
      case 'held': {
        if (input.blocked) return this.back('interrupted');
        if (input.touch) return this.back('let-go');
        if (input.far) {
          this.farSince ??= now;
          if (now - this.farSince >= this.knobs.farMs) return this.back('let-go');
        } else this.farSince = null;
        if (now >= this.nextSqueeze) { this.scheduleSqueeze(now); return { commands: ['squeeze'], answers: [] }; }
        return NOTHING;
      }
      case 'touched':
        if (input.blocked || now - this.touchSince >= this.knobs.touchMs) return this.back(null);
        return NOTHING;
      case 'back':
        if (input.stageIdle) this.phaseValue = 'done';
        return NOTHING;
      default: return NOTHING;
    }
  }

  private take(now: number): HandsSessionStep {
    if (this.offer.use === 'hold') {
      this.phaseValue = 'held'; this.farSince = null;
      this.scheduleSqueeze(now);
      return { commands: ['hold'], answers: ['taken'] };
    }
    this.phaseValue = 'touched'; this.touchSince = now; this.finished = true;
    return { commands: ['touch'], answers: ['taken'] };
  }

  private back(outcome: HandOutcome | null): HandsSessionStep {
    this.phaseValue = 'back';
    const owed = outcome && !this.finished ? [outcome] : [];
    this.finished = true;
    return { commands: ['release'], answers: owed };
  }

  /** The next gentle squeeze while holding: random within the knob's range; sooner when she squeezes back (O high); none when sleepy. */
  private scheduleSqueeze(now: number): void {
    if (this.offer.style.sleepy) { this.nextSqueeze = Infinity; return; }
    const [low, high] = this.knobs.squeezeEveryMs, scale = this.offer.style.squeezeBack ? this.knobs.squeezeBack : 1;
    this.nextSqueeze = now + (low + (high - low) * Math.min(1, Math.max(0, this.random()))) * scale;
  }
}
