/**
 * #11 的假实现：守约测试（tests/idle-gesture.test.ts）拿它和真实现跑同一组约定；以后接新实现，先拿它对一遍。
 * 不挑、不算分量：主机这一侧按给定的顺序轮着出样子；舞台这一侧只记下收到了什么，不动。
 */
import type { MoodCue } from '../../mood';
import type { BehaviorFaceBindingId } from '../../behavior-motion';
import type { IdleShapeId } from './knobs';
import { IDLE_GESTURE_REST, type IdleGestureFrame, type IdleGestureHost, type IdleGestureNow, type IdleGesturePresentation,
  type IdleGestureSource, type IdleGestureStage, type IdleGestureWhy } from './interface';
import { readIdleGesture } from './perform';

export class FakeIdleGestureHost implements IdleGestureHost {
  private readonly sources = new Map<string, IdleGestureSource>();
  private current: { characterId: string; cueId: string; presentation: IdleGesturePresentation; source: IdleGestureSource; at: number; hidden: boolean; committed: boolean } | null = null;
  private readonly log: (IdleGestureWhy & { characterId: string })[] = [];
  private next = 0;
  constructor(private readonly script: readonly { shape: IdleShapeId; bindingId: BehaviorFaceBindingId | null }[] = [{ shape: 'tilt', bindingId: null }]) {}

  note(cueId: string, source: IdleGestureSource): void { this.sources.set(cueId, source); }

  present(characterId: string, cue: MoodCue | null, now: (source: IdleGestureSource) => IdleGestureNow | null): IdleGesturePresentation | null {
    if (!cue || (cue.kind !== 'look' && cue.kind !== 'motion') || !characterId) return null;
    if (this.current?.cueId === cue.id && this.current.characterId === characterId) return this.current.hidden ? null : this.current.presentation;
    const source = this.sources.get(cue.id) ?? 'rule';
    if (!now(source)) { this.current = null; return null; }
    const step = this.script[this.next++ % this.script.length];
    const presentation: IdleGesturePresentation = { bindingId: step.bindingId,
      view: { cueId: cue.id, kind: cue.kind, shape: step.shape, side: 1, amplitude: 0.05, eyes: 1, pace: 1, smile: 1 } };
    this.current = { characterId, cueId: cue.id, presentation, source, at: cue.at, hidden: false, committed: false };
    return presentation;
  }

  hide(cueId: string): void { if (this.current?.cueId === cueId && !this.current.committed) this.current.hidden = true; }

  settle(): void {
    const c = this.current;
    if (!c || c.hidden || c.committed) return;
    c.committed = true;
    this.log.unshift({ characterId: c.characterId, at: c.at, kind: c.presentation.view.kind, source: c.source, shape: c.presentation.view.shape,
      face: c.presentation.bindingId ?? 'none', why: [`假实现：第 ${this.next} 个`], weights: '' });
  }

  recent(characterId: string): readonly IdleGestureWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, 8).map(({ characterId: _, ...entry }) => entry);
  }
}

export class FakeIdleGestureStage implements IdleGestureStage {
  readonly received: string[] = [];
  private last = '';
  frame(_dt: number, gesture: unknown): IdleGestureFrame {
    const view = gesture === undefined ? null : readIdleGesture(gesture);
    if (view && view.cueId !== this.last) { this.last = view.cueId; this.received.push(`${view.cueId}:${view.shape}`); }
    return view ? { ...IDLE_GESTURE_REST, smile: view.smile, owns: true } : IDLE_GESTURE_REST;
  }
  reset(): void { this.last = ''; }
}
