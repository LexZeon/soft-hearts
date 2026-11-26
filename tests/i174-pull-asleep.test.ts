// I-174 item 6 (docs/claude/2026-11-21-i174-parity-fixes.md): pressing on her while she sleeps. The window refused up front (no pull
// starts); full-screen wrote `asleep: false` on the page, let the press start and only the host said no after the round trip. Both now
// ask shared/behaviors/pull/gates.ts pullGatesOf with the same mood view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pullGatesOf, pullRefusal } from '../shared/stage';
import { HerOut } from '../src/unbound/her/out-page';
import { WindowPull } from '../src/unbound/window-mode/window-pull';

const view = (phase: string | null) => (phase ? { fatigue: { phase } } : {}) as never;

test('pullGatesOf: asleep and micro-awake refuse; awake, drowsy and no view do not; the hand stays its own gate', () => {
  for (const [phase, asleep] of [['asleep', true], ['micro-awake', true], ['drowsy', false], ['awake', false], [null, false]] as const) {
    assert.equal(pullGatesOf(view(phase), false).asleep, asleep, String(phase));
  }
  assert.equal(pullGatesOf(null, false).asleep, false);
  assert.equal(pullRefusal(pullGatesOf(view('awake'), true), 'arm'), 'hand-busy');
  assert.equal(pullRefusal(pullGatesOf(view('awake'), true), 'torso'), null);
});

test('full-screen refuses a press on her while she sleeps up front, exactly as the window does (same view, same answer)', () => {
  const her = new HerOut({} as HTMLElement, null, { camera: null as never, pixels: () => 0, canTouch: () => true });
  let mood: unknown = view('awake');
  const pull = new WindowPull({ figure: () => null, view: () => ({ camera: null as never, width: 1, height: 1 }), shown: () => true, mood: () => mood as never, handBusy: () => false });
  const windowSays = (group: 'torso' | 'arm') => pullRefusal((pull as unknown as { gates(): never }).gates(), group) !== null;
  for (const phase of ['awake', 'drowsy', 'asleep', 'micro-awake']) {
    mood = view(phase);
    (her as unknown as { view: unknown }).view = mood;
    for (const group of ['torso', 'arm'] as const) assert.equal(her.pullRefused(group), windowSays(group), `${phase} ${group}`);
  }
  (her as unknown as { view: unknown }).view = view('asleep');
  assert.equal(her.pullRefused('torso'), true, 'asleep: the page does not start a pull (before: only the host refused, after the press)');
});
