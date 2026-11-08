import assert from 'node:assert/strict';
import test from 'node:test';
import { ShellUiHold, onShellStrip, SHELL_HOLD_MS, type HoldDisplay } from '../electron/pet-shell-hold';
import { PetTopmostGuard, type TopmostLevel, type TopmostWindow } from '../electron/pet-topmost';
import { keepPetInWorkArea } from '../electron/pet-window-settings';

// This machine's screen: 1536×960, taskbar 912–960.
const display: HoldDisplay = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 } };

/** The always-on-top band: a raise puts the window first; `popup` stands for a tray menu the shell opened later. */
class Band { order: string[] = ['taskbar']; raise(id: string) { this.order = [id, ...this.order.filter(x => x !== id)]; } above(a: string, b: string) { return this.order.indexOf(a) < this.order.indexOf(b); } }
class Pet implements TopmostWindow {
  visible = true; activations = 0;
  constructor(private readonly band: Band) { band.raise('pet'); }
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  isAlwaysOnTop() { return this.band.order.includes('pet'); }
  setAlwaysOnTop(flag: boolean, _level?: TopmostLevel) { if (flag) this.band.raise('pet'); else this.band.order = this.band.order.filter(x => x !== 'pet'); }
  moveTop() { this.band.raise('pet'); }
}

function rig() {
  let now = 0; let cursor = { x: 700, y: 400 };
  const hold = new ShellUiHold({ cursor: () => cursor, displays: () => [display], active: () => true, now: () => now });
  const band = new Band(); const pet = new Pet(band);
  const guard = new PetTopmostGuard({ window: () => pet, wanted: () => true, shellHeld: () => hold.held() });
  return { band, pet, guard, hold, at: (ms: number) => { now = ms; }, move: (x: number, y: number) => { cursor = { x, y }; } };
}

test('the taskbar strip is the display outside its work area', () => {
  assert.equal(onShellStrip([display], { x: 1500, y: 930 }), true);
  assert.equal(onShellStrip([display], { x: 1500, y: 900 }), false);
  assert.equal(onShellStrip([display], { x: 2000, y: 930 }), false, 'off every display');
  assert.equal(onShellStrip([display], { x: Number.NaN, y: 930 }), false);
});

test('a tray menu opened from the taskbar is not covered by the periodic raise; she is raised again after the hold', () => {
  const r = rig();
  r.move(1450, 935); r.hold.sample();              // the user goes to the tray icons
  r.band.raise('popup');                            // the shell opens a tray menu above everything, over her
  r.move(1400, 700); r.at(2000);                    // and moves into the menu (inside the work area)
  assert.equal(r.guard.check(), 'held');
  assert.ok(r.band.above('popup', 'pet'), 'the menu stays above her');
  r.at(SHELL_HOLD_MS - 1); assert.equal(r.guard.check(), 'held');
  r.at(SHELL_HOLD_MS + 1); assert.equal(r.guard.check(), 'raised');
  assert.ok(r.band.above('pet', 'popup'));
  assert.equal(r.pet.activations, 0);
});

test('without the hold (the shipped 0cfd05e9 guard) the next tick covers the tray menu', () => {
  const band = new Band(); const pet = new Pet(band);
  band.raise('popup');
  new PetTopmostGuard({ window: () => pet, wanted: () => true }).check();
  assert.ok(band.above('pet', 'popup'));
});

test('another program\'s always-on-top window is still put under her when the taskbar was not touched', () => {
  const r = rig();
  r.band.raise('other-app');
  r.at(2000);
  assert.equal(r.guard.check(), 'raised');
  assert.ok(r.band.above('pet', 'other-app'));
});

test('her own show/restore raise at once, even during the hold', () => {
  const r = rig();
  r.move(1450, 935); r.hold.sample(); r.band.raise('popup'); r.at(1000);
  assert.equal(r.guard.check(true), 'raised');
});

test('a short visit to the taskbar between two guard ticks is still seen (250 ms sampling)', async () => {
  let cursor = { x: 1450, y: 935 }; let reads = 0;
  const hold = new ShellUiHold({ cursor: () => { reads++; return cursor; }, displays: () => [display], active: () => true });
  hold.start(10);
  await new Promise(resolve => setTimeout(resolve, 40));
  cursor = { x: 700, y: 400 };
  hold.stop();
  assert.ok(reads > 0);
  assert.equal(hold.held(), true);
});

test('sampling stops while she is hidden or the switch is off', async () => {
  let reads = 0;
  const hold = new ShellUiHold({ cursor: () => { reads++; return { x: 0, y: 0 }; }, displays: () => [display], active: () => false });
  hold.start(5); await new Promise(resolve => setTimeout(resolve, 30)); hold.stop();
  assert.equal(reads, 0);
});

class BoundsWin { calls: unknown[] = []; constructor(public b: { x: number; y: number; width: number; height: number }) {}
  isDestroyed() { return false; } getBounds() { return { ...this.b }; } setBounds(b: typeof this.b) { this.calls.push(b); this.b = { ...b }; } }
const screen = { getDisplayMatching: () => ({ workArea: display.workArea }) };

test('her window is moved off the taskbar strip, never overlapping it', () => {
  const win = new BoundsWin({ x: 1100, y: 380, width: 400, height: 560 }); // bottom 940 > 912
  assert.equal(keepPetInWorkArea(win, screen), true);
  assert.deepEqual(win.b, { x: 1100, y: 352, width: 400, height: 560 });
  assert.ok(win.b.y + win.b.height <= 912);
});

test('a window taller than the work area shrinks to it; one already inside is left untouched', () => {
  const tall = new BoundsWin({ x: 10, y: 0, width: 400, height: 1000 });
  keepPetInWorkArea(tall, screen);
  assert.deepEqual(tall.b, { x: 10, y: 0, width: 400, height: 912 });
  const fine = new BoundsWin({ x: 1106, y: 322, width: 400, height: 560 });
  assert.equal(keepPetInWorkArea(fine, screen), false);
  assert.deepEqual(fine.calls, []);
});
