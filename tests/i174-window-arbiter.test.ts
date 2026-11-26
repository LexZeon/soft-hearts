// I-174 item 1 (docs/claude/2026-11-21-i174-parity-fixes.md): her own small things in the companion window go through full-screen's own
// scheduler, arbiter and player (shared/unbound/life/host.ts, arbiter.ts, src/unbound/life/player.ts) via window-arbiter.ts. Walking and the
// peek are never satisfied in the window; idle pauses and small moves keep full-screen's order and spacing; you interacting makes what runs
// ease out first. Measured on the real window body (public Gene) at 60 and 30 fps: the hand-over never jumps.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Quaternion } from 'three';
import { WindowArbiter } from '../src/unbound/window-mode/window-arbiter';
import { faceView } from './helpers/window-face-fixture';
import { frameSteps, surprises, windowGene } from './helpers/unbound-window';

const view = () => faceView({ primary: 'calm', companion: null }) as never;
function arbiter(start = 1_000_000) {
  const clock = { now: start }; let beat: (() => void) | null = null; let seed = 3;
  const a = new WindowArbiter({ clock: () => clock.now, random: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }, every: (_ms, run) => { beat = run; return () => { beat = null; }; } });
  const base = { shown: true, typing: false, waiting: false, speaking: false, playing: false, view: view() };
  a.situation(base); a.start();
  const tick = (seconds = 1) => { for (let i = 0; i < seconds; i++) { clock.now += 1_000; beat?.(); } };
  return { a, clock, tick, base };
}

test('the window runs full-screen\'s arbiter: walking somewhere never starts; idle pauses and small moves do, one at a time with the shared gap', () => {
  const { a, tick } = arbiter();
  const started: string[] = [];
  const command = a.player.command.bind(a.player);
  a.player.command = (value: unknown) => { const c = value as { type: string; plan?: { action: string } }; if (c.type === 'start') started.push(c.plan!.action); command(value); };
  for (let s = 0; s < 3 * 3600; s++) { tick(); for (let f = 0; f < 4; f++) a.frame(0.25, { sense: null, heightM: 1.55 }, false); }
  const place = a.host.view().actions.find(action => action.id === 'place');
  assert.equal(place?.notNow, '还不知道她站在哪', 'the place action says why: the window never knows a spot to walk to');
  assert.ok(!started.includes('place'), 'she never walks in the window');
  assert.ok(started.some(id => id === 'shift' || id === 'glance'), `small moves come (${started.length} in three hours: ${[...new Set(started)].join(', ')})`);
  assert.ok(started.includes('pause'), 'idle pauses come');
});

test('you interacting (waiting for her, her voice, a game, a touch) makes what runs ease out; nothing new starts until a while after you; typing never ends it (2026-11-23)', () => {
  {
    const { a, tick, base } = arbiter();
    assert.equal(a.host.trial('shift'), true);
    for (let f = 0; f < 30; f++) a.frame(1 / 60, { sense: null, heightM: 1.55 }, false);
    a.situation({ ...base, typing: true }); tick();
    assert.equal(a.player.stage, 'playing', 'typing: she goes on (the arbiter: typing never ends an action)');
  }
  for (const cause of ['waiting', 'speaking', 'playing', 'touch'] as const) {
    const { a, tick, base } = arbiter();
    assert.equal(a.host.trial('shift'), true);
    for (let f = 0; f < 30; f++) a.frame(1 / 60, { sense: null, heightM: 1.55 }, false);
    assert.equal(a.player.stage, 'playing');
    if (cause === 'touch') a.touched(); else a.situation({ ...base, [cause]: true });
    tick();
    assert.equal(a.player.stage, 'easing', `${cause}: it eases out (from where it is, never cut)`);
    for (let f = 0; f < 120; f++) a.frame(1 / 60, { sense: null, heightM: 1.55 }, false);
    assert.equal(a.active, false);
    tick(); // the next beat: nothing new starts while you are at it (a touch: for its hold; then the after-you wait)
    assert.ok(/你/.test(a.host.view().why ?? ''), `${cause}: waits for you (${a.host.view().why})`);
  }
});

for (const fps of [60, 30]) {
  test(`a weight shift and a pause on the real window body at ${fps} fps: in, held, out and a cut mid-way never jump`, async () => {
    const g = await windowGene(9);
    try {
      const run = (mode: 'none' | 'shift' | 'cut', seconds: number) => {
        const { a, base } = arbiter();
        const frames: Quaternion[][] = [];
        if (mode !== 'none') assert.equal(a.host.trial('shift'), true);
        for (let k = 0; k < seconds * fps; k++) {
          if (mode === 'cut' && k === Math.round(1.2 * fps)) { a.situation({ ...base, waiting: true }); a.host.tick(); }
          const life = a.frame(1 / fps, { sense: null, heightM: g.figure.heightM }, false);
          g.body.frame(1 / fps, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, life });
          frames.push(g.rotations());
        }
        a.halt();
        return { step: Math.max(...frameSteps(frames)), surprise: Math.max(...surprises(frames).perFrame) };
      };
      run('none', 2); // settle her idle first
      const idle = run('none', 6), shift = run('shift', 6), cut = run('cut', 6);
      console.log(`${fps} fps: idle step ${idle.step.toFixed(3)}° surprise ${idle.surprise.toFixed(3)}°; shift ${shift.step.toFixed(3)}° / ${shift.surprise.toFixed(3)}°; cut at 1.2 s ${cut.step.toFixed(3)}° / ${cut.surprise.toFixed(3)}°`);
      const perFrame = 60 / fps;
      assert.ok(shift.step <= Math.max(idle.step * 1.5, 0.6 * perFrame), `the shift's largest step ${shift.step.toFixed(3)}° (idle ${idle.step.toFixed(3)}°)`);
      assert.ok(cut.step <= Math.max(idle.step * 1.5, 0.6 * perFrame), `a cut eases out: largest step ${cut.step.toFixed(3)}°`);
      assert.ok(shift.surprise <= Math.max(idle.surprise * 1.5, 0.2 * perFrame) && cut.surprise <= Math.max(idle.surprise * 1.5, 0.2 * perFrame),
        `unexpected step: shift ${shift.surprise.toFixed(3)}°, cut ${cut.surprise.toFixed(3)}° (idle ${idle.surprise.toFixed(3)}°)`);
    } finally { g.close(); }
  });
}

test('the shift reaches her body in the window: two identical windows, one with her own small things laid over, one without', async () => {
  const [g, twin] = [await windowGene(9), await windowGene(9)];
  try {
    const { a } = arbiter();
    assert.equal(a.host.trial('shift'), true);
    let most = 0;
    for (let k = 0; k < 6 * 60; k++) {
      const life = a.frame(1 / 60, { sense: null, heightM: g.figure.heightM }, false), input = { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false };
      g.body.frame(1 / 60, { ...input, life }); twin.body.frame(1 / 60, { ...input, life: null });
      most = Math.max(most, Math.abs(g.screenOf('上半身').x - twin.screenOf('上半身').x));
    }
    console.log('the shift moves her upper body up to ' + most.toFixed(2) + ' px on the window');
    assert.ok(most > 1, 'her weight goes over one foot: ' + most.toFixed(2) + ' px');
  } finally { g.close(); twin.close(); }
});
