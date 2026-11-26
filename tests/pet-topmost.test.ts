import assert from 'node:assert/strict';
import test from 'node:test';
import { PetTopmostGuard, REPAIR_BACKOFF, applyPetTopmost, raisePet, repairDelayMs, type TopmostWindow } from '../electron/stage/pet-topmost';

/** Models what was measured on Windows: after an outside loss, the first `swallow` setAlwaysOnTop(true) calls leave the style off. */
class FakeWin implements TopmostWindow {
  top = true; visible = true; minimized = false; destroyed = false; swallow = 0; calls: string[] = [];
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.minimized; }
  isMinimized() { return this.minimized; }
  isAlwaysOnTop() { return this.top; }
  setAlwaysOnTop(flag: boolean) {
    this.calls.push(`top:${flag}`);
    if (flag && !this.top && this.swallow > 0) { this.swallow--; return; } // the call that does nothing
    this.top = flag;
  }
  moveTop() { this.calls.push('moveTop'); }
  lose(swallow = 2) { this.top = false; this.swallow = swallow; }
}
const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };

test('a single setAlwaysOnTop(true) that did not take is forced with an off/on toggle', () => {
  const win = new FakeWin(); win.lose(1);
  assert.equal(applyPetTopmost(win, true), 'forced');
  assert.equal(win.top, true);
  assert.deepEqual(win.calls, ['top:true', 'top:false', 'top:true', 'moveTop']);
});

test('the old single call leaves a window that lost its style behind', () => {
  const win = new FakeWin(); win.lose(1);
  win.setAlwaysOnTop(true);
  assert.equal(win.top, false);
});

test('apply: a missing style is one call; a present style is no call at all (no lift); off stays a plain call', () => {
  const win = new FakeWin(); win.lose(0);
  assert.equal(applyPetTopmost(win, true), 'applied');
  assert.equal(applyPetTopmost(win, true), 'unchanged');
  assert.equal(applyPetTopmost(win, false), 'unchanged');
  assert.equal(win.top, false);
  assert.deepEqual(win.calls, ['top:true', 'top:false']);
});

test('raisePet: her own moment always makes the call (the top of the band); a lost style is restored and forced if needed', () => {
  const win = new FakeWin();
  assert.equal(raisePet(win), 'raised');
  assert.deepEqual(win.calls, ['top:true']);
  win.calls = []; win.lose(1);
  assert.equal(raisePet(win), 'forced');
  assert.equal(win.top, true);
});

test('guard: the periodic check only reads a present style, puts back a lost one, and leaves the switch-off alone', () => {
  const win = new FakeWin(); let wanted = true;
  const guard = new PetTopmostGuard({ window: () => win, wanted: () => wanted });
  for (let i = 0; i < 5; i++) assert.equal(guard.check(), 'ok');
  assert.deepEqual(win.calls, [], 'no call while she has the style: she is never lifted by the timer');
  win.lose(2);
  assert.equal(guard.check(), 'forced');
  assert.equal(win.top, true);
  win.lose(0); wanted = false;
  assert.equal(guard.check(), 'skipped', 'the switch is off: leave it');
  assert.equal(win.top, false);
});

test('guard leaves a hidden, minimized or destroyed pet alone and survives a missing window', () => {
  const win = new FakeWin(); win.lose(0);
  let current: FakeWin | null = win;
  const guard = new PetTopmostGuard({ window: () => current, wanted: () => true });
  win.visible = false; assert.equal(guard.check(), 'skipped'); assert.equal(guard.ownMoment(), 'skipped');
  win.visible = true; win.minimized = true; assert.equal(guard.check(), 'skipped'); assert.equal(guard.ownMoment(), 'skipped');
  win.minimized = false; win.destroyed = true; assert.equal(guard.check(), 'skipped');
  current = null; assert.equal(guard.check(), 'skipped'); assert.equal(guard.ownMoment(), 'skipped');
  assert.deepEqual(win.calls, []);
});

test('repair delays: 2, 4, 8, 16, 32, then 60 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 40].map(n => repairDelayMs(n) / 1000), [2, 4, 8, 16, 32, 60, 60, 60]);
  assert.equal(REPAIR_BACKOFF.quietMs, 300_000);
});

/** Another program that takes her style away every time she has it (the worst case of fighting). Ticks every 2 s for `seconds`. */
function fight(guard: PetTopmostGuard, win: FakeWin, c: { t: number }, seconds: number): number[] {
  const repairs: number[] = [];
  const start = c.t;
  for (let s = 0; s <= seconds; s += 2) {
    c.t = start + s * 1000;
    if (win.top) win.lose(0);
    const outcome = guard.check();
    if (outcome === 'applied' || outcome === 'forced' || outcome === 'failed') repairs.push(s);
  }
  return repairs;
}

test('a style that keeps getting lost is repaired with back-off: at most 15 repairs in 10 minutes, never a 2 s ping-pong', () => {
  const win = new FakeWin(); const c = clock();
  const guard = new PetTopmostGuard({ window: () => win, wanted: () => true, now: c.now });
  const repairs = fight(guard, win, c, 600);
  assert.deepEqual(repairs.slice(0, 7), [0, 2, 6, 14, 30, 62, 122]);
  assert.ok(repairs.length <= 15, `${repairs.length} repairs`);
  const gaps = repairs.slice(1).map((s, i) => s - repairs[i]);
  assert.ok(gaps.slice(5).every(gap => gap === 60), 'capped at 60 s');
});

test('back-off resets after five quiet minutes; a single loss later is repaired at once with a 2 s wait again', () => {
  const win = new FakeWin(); const c = clock();
  const guard = new PetTopmostGuard({ window: () => win, wanted: () => true, now: c.now });
  fight(guard, win, c, 120);
  assert.equal(guard.check(), 'waiting');
  // The other program goes away: she keeps the style through the quiet stretch.
  const quietFrom = c.t + 1000;
  c.t = quietFrom;
  assert.equal(guard.ownMoment(), 'applied');
  for (let s = 2; s <= 300; s += 2) { c.t = quietFrom + s * 1000; assert.equal(guard.check(), 'ok'); }
  c.t += 2000; win.lose(0);
  assert.equal(guard.check(), 'applied', 'first loss after the quiet stretch: repaired at once');
  win.lose(0); c.t += 1000;
  assert.equal(guard.check(), 'waiting');
  c.t += 1000;
  assert.equal(guard.check(), 'applied', 'and the next one waits only 2 s');
});

test('her own moment is never held back by the back-off', () => {
  const win = new FakeWin(); const c = clock();
  const guard = new PetTopmostGuard({ window: () => win, wanted: () => true, now: c.now });
  fight(guard, win, c, 40);
  win.lose(0);
  assert.equal(guard.check(), 'waiting');
  assert.equal(guard.ownMoment(), 'applied');
  assert.equal(win.top, true);
});

test('startup: her show event sets the style without a "lost topmost" journal line; a real loss later is journaled', () => {
  const win = new FakeWin(); win.lose(0); // created without the style
  const lines: string[] = [];
  const guard = new PetTopmostGuard({ window: () => win, wanted: () => true, journal: outcome => { lines.push(outcome); } });
  assert.equal(guard.ownMoment(), 'applied');
  assert.deepEqual(lines, []);
  win.lose(0);
  assert.equal(guard.check(), 'applied');
  assert.deepEqual(lines, ['applied']);
});

test('the periodic guard repairs a lost topmost on its own and stops when told', async () => {
  const win = new FakeWin(); const guard = new PetTopmostGuard({ window: () => win, wanted: () => true });
  guard.start(10);
  win.lose(2);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(win.top, true);
  guard.stop(); win.lose(0);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(win.top, false);
});
