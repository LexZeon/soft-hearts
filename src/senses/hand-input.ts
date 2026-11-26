/**
 * I-087 牵手、拉钩、击掌的输入（docs/claude/2026-11-11-i087-hands.md「以后兼容姿势识别」）。互动只认两样抽象的东西：
 *  - "你的手在哪儿"：她窗口里的一个点，和鼠标视线同一个单位（x 向右、y 向上，窗口边上是 ±1；姿势识别的点可以在窗口外）；
 *  - "碰了一下"：现在是点她的手，以后可以是你对着镜头伸过来的手。
 * 现在来自鼠标（主机每 100 毫秒读一次的屏幕光标，和"看向鼠标"是同一份读数）和点击。以后 I-081 把身体各点的坐标传过来，换一个来源
 * （PoseHandSource）就行，伸手、牵着、松开这些互动一行都不用改。
 *
 * Pure (no DOM, no three.js), allocation-free per frame.
 */

/** "你的手在哪儿" in her window's pointer units. */
export interface HandReading { readonly x: number; readonly y: number }

export interface HandSource {
  readonly kind: 'mouse' | 'pose';
  /** Where your hand is now, or null when this source knows nothing. */
  read(): HandReading | null;
}

/** The screen cursor, as the host reads it every 100 ms (the same reading the gaze follows). */
export class MouseHandSource implements HandSource {
  readonly kind = 'mouse' as const;
  private readonly value = { x: 0, y: 0 };
  private known = false;
  /** The latest reading; `follow` false (the 跟随鼠标 setting off): no reading at all (she reaches toward you, not a stale point). */
  set(pointer: Readonly<{ x: number; y: number }> | null, follow = true): void {
    if (!follow || !pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) { this.known = false; return; }
    this.value.x = Math.max(-1, Math.min(1, pointer.x)); this.value.y = Math.max(-1, Math.min(1, pointer.y)); this.known = true;
  }
  read(): HandReading | null { return this.known ? this.value : null; }
}

/**
 * Pose sensing (later): a body point of yours (a wrist, a fingertip) already mapped into her window's pointer units by I-081's geometry.
 * Points may lie outside the window (|x| or |y| > 1): she then reaches toward the edge and it counts as far away.
 */
export class PoseHandSource implements HandSource {
  readonly kind = 'pose' as const;
  private readonly value = { x: 0, y: 0 };
  private known = false;
  update(point: Readonly<{ x: number; y: number }> | null): void {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { this.known = false; return; }
    this.value.x = Math.max(-8, Math.min(8, point.x)); this.value.y = Math.max(-8, Math.min(8, point.y)); this.known = true;
  }
  read(): HandReading | null { return this.known ? this.value : null; }
}

/** The interaction's input: one source at a time for "where", and touches ("碰了一下") from whoever reports them. */
export class HandInput {
  readonly mouse = new MouseHandSource();
  private source: HandSource = this.mouse;
  private touches = 0;

  /** Swap the source (mouse ↔ pose); the interaction does not change. */
  use(source: HandSource | null): void { this.source = source ?? this.mouse; }
  get kind(): HandSource['kind'] { return this.source.kind; }

  /** One display frame: the mouse source gets the latest cursor reading; the active source answers. */
  frame(pointer: Readonly<{ x: number; y: number }> | null, follow: boolean): HandReading | null {
    this.mouse.set(pointer, follow);
    return this.source.read();
  }
  read(): HandReading | null { return this.source.read(); }

  /** "碰了一下" (a click on her hand; later a pose touch). */
  touch(): void { this.touches++; }
  /** Was there a touch since the last call? (Several in one frame are one.) */
  takeTouch(): boolean { const touched = this.touches > 0; this.touches = 0; return touched; }
}
