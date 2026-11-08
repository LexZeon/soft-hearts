import assert from 'node:assert/strict';
import test from 'node:test';
import { PetTopmostGuard, applyPetTopmost, type TopmostWindow } from '../electron/pet-topmost';

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

test('an ordinary apply is one call; an already-topmost window is unchanged; off stays a plain call', () => {
  const win = new FakeWin(); win.lose(0);
  assert.equal(applyPetTopmost(win, true), 'applied');
  assert.equal(applyPetTopmost(win, true), 'unchanged');
  assert.equal(applyPetTopmost(win, false), 'unchanged');
  assert.equal(win.top, false);
  assert.deepEqual(win.calls, ['top:true', 'top:true', 'top:false']);
});

test('guard puts back a lost topmost while the pet is shown and the setting is on', () => {
  const win = new FakeWin(); let wanted = true;
  const guard = new PetTopmostGuard({ window: () => win, wanted: () => wanted });
  assert.equal(guard.check(), 'raised', 'still topmost: only raised back to the top of the band (tests/pet-topmost-band.test.ts)');
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
  win.visible = false; assert.equal(guard.check(), 'skipped');
  win.visible = true; win.minimized = true; assert.equal(guard.check(), 'skipped');
  win.minimized = false; win.destroyed = true; assert.equal(guard.check(), 'skipped');
  current = null; assert.equal(guard.check(), 'skipped');
  assert.deepEqual(win.calls, []);
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
