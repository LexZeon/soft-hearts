import assert from 'node:assert/strict';
import test from 'node:test';
import { PetTopmostGuard, applyPetTopmost, petTopmostLevel, type TopmostLevel, type TopmostWindow } from '../electron/pet-topmost';
import { applyPetWindowSettings, type PetSettingsWindow } from '../electron/pet-window-settings';

/**
 * The always-on-top band as measured on Windows (2026-11-08, Electron 45, GetWindow z-order): 'floating' (Electron's default)
 * inserts the window directly behind the taskbar; 'pop-up-menu' puts it at the top of the band; moveTop puts it at the top.
 * Nothing here activates a window; `activations` counts any call that would.
 */
class Band {
  order: string[] = ['taskbar'];
  activations = 0;
  above(a: string, b: string): boolean { return this.order.includes(a) && this.order.indexOf(a) < this.order.indexOf(b); }
  raise(id: string): void { this.order = [id, ...this.order.filter(x => x !== id)]; }
}
class BandWin implements PetSettingsWindow {
  visible = false; minimized = false; destroyed = false; calls: string[] = [];
  constructor(private readonly band: Band, readonly id: string, top = false) { if (top) band.raise(id); }
  get top() { return this.band.order.includes(this.id); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.minimized; }
  isMinimized() { return this.minimized; }
  isAlwaysOnTop() { return this.top; }
  setAlwaysOnTop(flag: boolean, level?: TopmostLevel) {
    this.calls.push(`top:${flag}:${level ?? 'default'}`);
    const rest = this.band.order.filter(x => x !== this.id);
    if (!flag) { this.band.order = rest; return; }
    if ((level ?? 'floating') === 'floating') { const at = rest.indexOf('taskbar') + 1; this.band.order = [...rest.slice(0, at), this.id, ...rest.slice(at)]; }
    else this.band.raise(this.id);
  }
  moveTop() { this.calls.push('moveTop'); if (this.top) this.band.raise(this.id); }
  showInactive() { this.calls.push('showInactive'); this.visible = true; }
  hide() { this.calls.push('hide'); this.visible = false; }
}
const pointer = () => { const calls: boolean[] = []; return { calls, sync: (v: boolean) => { calls.push(v); } }; };

test('Windows uses the top-of-band level; other platforms keep floating', () => {
  assert.equal(petTopmostLevel('win32'), 'pop-up-menu');
  assert.equal(petTopmostLevel('darwin'), 'floating');
  assert.equal(petTopmostLevel('linux'), 'floating');
});

const windowsOnly = { skip: process.platform !== 'win32' };

test('startup: a pet created topmost but below another program\'s topmost window ends up above it, without activation', windowsOnly, () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.setAlwaysOnTop(true, 'floating'); // new BrowserWindow({ alwaysOnTop: true })
  const other = new BandWin(band, 'other', true); other.visible = true;      // another app's always-on-top window, above the taskbar
  assert.ok(band.above('other', 'pet'));
  const ptr = pointer();
  applyPetWindowSettings(pet, { visible: true, alwaysOnTop: true, clickThrough: true }, ptr);
  assert.ok(band.above('pet', 'other'), 'she is on top after startup');
  assert.ok(band.above('pet', 'taskbar'));
  assert.equal(band.activations, 0);
  assert.deepEqual(ptr.calls, [true]);
});

test('measured before: re-applying the floating level leaves her under that window (what startup and the guard did)', () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.setAlwaysOnTop(true, 'floating'); pet.visible = true;
  new BandWin(band, 'other', true);
  applyPetTopmost(pet, true, 'floating');
  assert.ok(band.above('other', 'pet'));
});

test('startup applies exactly what a toggle off and on applies', windowsOnly, () => {
  const settings = { visible: true, alwaysOnTop: true, clickThrough: false };
  const startup = new Band(), toggled = new Band();
  const a = new BandWin(startup, 'pet'); a.setAlwaysOnTop(true, 'floating'); new BandWin(startup, 'other', true);
  const b = new BandWin(toggled, 'pet'); b.setAlwaysOnTop(true, 'floating'); new BandWin(toggled, 'other', true);
  const pa = pointer(), pb = pointer();
  applyPetWindowSettings(a, settings, pa);
  applyPetWindowSettings(b, settings, pb);
  applyPetWindowSettings(b, { ...settings, alwaysOnTop: false }, pb);
  applyPetWindowSettings(b, settings, pb);
  assert.deepEqual(startup.order, toggled.order);
  assert.equal(a.isVisible(), b.isVisible());
  assert.equal(pa.calls.at(-1), pb.calls.at(-1));
});

test('order: shown first (inactive), then raised, then the mouse flag on the shown window', () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet');
  const order: string[] = [];
  const ptr = { sync: (v: boolean) => { order.push(`pointer:${v}:${pet.isVisible() ? 'shown' : 'hidden'}`); } };
  applyPetWindowSettings(pet, { visible: true, alwaysOnTop: true, clickThrough: true }, ptr);
  assert.deepEqual(pet.calls.slice(0, 2), ['showInactive', `top:true:${petTopmostLevel()}`]);
  assert.deepEqual(order, ['pointer:true:shown']);
});

test('saved hidden and not on top: hidden, out of the band, mouse flag still applied', () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.setAlwaysOnTop(true, 'floating'); pet.visible = true;
  const ptr = pointer();
  applyPetWindowSettings(pet, { visible: false, alwaysOnTop: false, clickThrough: false }, ptr);
  assert.equal(pet.isVisible(), false);
  assert.equal(pet.isAlwaysOnTop(), false);
  assert.deepEqual(ptr.calls, [false]);
});

test('guard: a topmost pet covered by a window that became topmost later is raised within one check', windowsOnly, () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.visible = true;
  applyPetTopmost(pet, true);
  const later = new BandWin(band, 'later', true);
  assert.ok(band.above('later', 'pet'));
  let wanted = true;
  const guard = new PetTopmostGuard({ window: () => pet, wanted: () => wanted });
  assert.equal(guard.check(), 'raised');
  assert.ok(band.above('pet', 'later'));
  assert.equal(band.activations, 0);
  later.setAlwaysOnTop(true, 'pop-up-menu');
  wanted = false;
  assert.equal(guard.check(), 'skipped', 'switch off: she is left where she is');
  assert.ok(band.above('later', 'pet'));
  wanted = true; pet.visible = false;
  assert.equal(guard.check(), 'skipped', 'hidden: not touched');
  assert.ok(band.above('later', 'pet'));
});

test('guard with the old floating level does not lift her (the bug)', () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.visible = true; pet.setAlwaysOnTop(true, 'floating');
  new BandWin(band, 'later', true);
  new PetTopmostGuard({ window: () => pet, wanted: () => true }, 'floating').check();
  assert.ok(band.above('later', 'pet'));
});

test('TopmostWindow fakes stay structurally compatible', () => {
  const win: TopmostWindow = new BandWin(new Band(), 'x');
  assert.equal(win.isAlwaysOnTop(), false);
});
