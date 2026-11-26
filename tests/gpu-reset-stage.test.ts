// 显卡重置后她自己回来 (docs/claude/2026-11-22-gpu-reset.md): a stage's lost WebGL context (src/stage/context-recovery.ts, wired by the desktop
// stage src/stage/mmd/context.ts and the window engine src/unbound/window-mode/window-stage.ts). The loss is always preventDefault-ed (else
// the browser never gives the context back); a quick restore shows nothing; the message waits for a context that stays lost and is cleared
// when it comes back after all; the pixel read-backs forget the old context. A forced loss through WEBGL_lose_context on the real stages:
// scripts/dev/gpu-reset-check.mjs --lose-context (numbers in the record).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_RECOVERY, StageContextRecovery } from '../src/stage/context-recovery';
import { StagePixelProbe } from '../src/stage/pixel-probe';

class FakeCanvas {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  /** Dispatches like the browser: returns whether a listener called preventDefault (the browser restores only then). */
  dispatch(type: string): boolean {
    let prevented = false;
    const event = { type, preventDefault: () => { prevented = true; } } as unknown as Event;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return prevented;
  }
  count(): number { let n = 0; for (const set of this.listeners.values()) n += set.size; return n; }
}

function clock() {
  let now = 0; const timers: { at: number; run: () => void; id: number }[] = []; let next = 1;
  return {
    setTimer: (run: () => void, ms: number) => { const id = next++; timers.push({ at: now + ms, run, id }); return id; },
    clearTimer: (id: unknown) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    advance(ms: number) { now += ms; for (const timer of timers.filter(t => t.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.run(); } },
    get pending() { return timers.length; },
  };
}

test('a lost context is restored: the loss is prevented, a quick restore shows nothing and asks the stage to drop old GL objects', () => {
  const canvas = new FakeCanvas(), time = clock(), steps: string[] = [];
  const recovery = new StageContextRecovery(canvas, { lost: () => steps.push('lost'), restored: () => steps.push('restored'), stuck: () => steps.push('stuck'),
    recovered: () => steps.push('recovered'), setTimer: time.setTimer, clearTimer: time.clearTimer });
  assert.equal(canvas.dispatch('webglcontextlost'), true, 'without preventDefault the browser never restores the context');
  assert.equal(recovery.lost, true);
  time.advance(1_200); // measured: the context came back 0.2 s after each GPU process crash
  canvas.dispatch('webglcontextrestored');
  time.advance(CONTEXT_RECOVERY.stuckMs * 2);
  assert.deepEqual(steps, ['lost', 'restored']);
  assert.equal(recovery.lost, false);
  assert.deepEqual(recovery.counts, { lost: 1, restored: 1, stuck: 0 });
  // Again and again (the 20:38 evening had three resets): each one the same.
  for (let index = 0; index < 5; index++) { canvas.dispatch('webglcontextlost'); time.advance(500); canvas.dispatch('webglcontextrestored'); }
  assert.deepEqual(recovery.counts, { lost: 6, restored: 6, stuck: 0 });
  assert.equal(time.pending, 0);
  recovery.dispose();
  assert.equal(canvas.count(), 0);
});

test('a context that stays lost says so once, and the message is cleared when it comes back after all', () => {
  const canvas = new FakeCanvas(), time = clock(), steps: string[] = [];
  new StageContextRecovery(canvas, { stuck: () => steps.push('stuck'), recovered: () => steps.push('recovered'), restored: () => steps.push('restored'),
    setTimer: time.setTimer, clearTimer: time.clearTimer });
  canvas.dispatch('webglcontextlost');
  time.advance(CONTEXT_RECOVERY.stuckMs - 1);
  assert.deepEqual(steps, []);
  time.advance(1);
  canvas.dispatch('webglcontextlost'); // a second loss event while still lost changes nothing
  time.advance(CONTEXT_RECOVERY.stuckMs * 3);
  assert.deepEqual(steps, ['stuck']);
  canvas.dispatch('webglcontextrestored');
  assert.deepEqual(steps, ['stuck', 'restored', 'recovered']);
  canvas.dispatch('webglcontextrestored'); // a stray restore without a loss: nothing
  assert.deepEqual(steps, ['stuck', 'restored', 'recovered']);
});

test('the pixel probe answers a waiting read with null and starts over on the restored context', async () => {
  const probe = new StagePixelProbe();
  const waiting = probe.request(1, 1);
  probe.forgetContext();
  assert.equal(await waiting, null);
  assert.equal(probe.idle, true);
});
