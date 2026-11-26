import assert from 'node:assert/strict';
import test from 'node:test';
import { PetTopmostGuard, applyPetTopmost, petTopmostLevel, raisePet, type TopmostLevel, type TopmostWindow } from '../electron/stage/pet-topmost';
import { applyPetWindowSettings, type PetSettingsWindow } from '../electron/stage/pet-window-settings';

/**
 * The always-on-top band as measured on Windows (2026-11-08 and 2026-11-10, Electron 45, GetWindow z-order;
 * scripts/dev/topmost-probe): 'floating' (Electron's default) inserts the window directly behind the taskbar; 'pop-up-menu'
 * puts it at the top of the band, also when it already has the style; moveTop puts it at the top. Ordinary windows are never in
 * the band, so anything in the band is above them. Nothing here activates a window; `activations` counts any call that would.
 *
 * The rule (I-062): with the switch on she stays above ordinary windows and never fights a topmost window shown after her; she
 * goes to the top of the band only at her own moments.
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
const on = { visible: true, alwaysOnTop: true, clickThrough: true };

test('Windows uses the top-of-band level; other platforms keep floating', () => {
  assert.equal(petTopmostLevel('win32'), 'pop-up-menu');
  assert.equal(petTopmostLevel('darwin'), 'floating');
  assert.equal(petTopmostLevel('linux'), 'floating');
});

const windowsOnly = { skip: process.platform !== 'win32' };

test('startup: the pet (created without the style) goes on top of the band when shown, without activation', windowsOnly, () => {
  const band = new Band();
  const other = new BandWin(band, 'other', true); other.visible = true; // already there before she starts
  const pet = new BandWin(band, 'pet');
  const ptr = pointer();
  assert.equal(applyPetWindowSettings(pet, on, ptr), 'applied');
  assert.ok(band.above('pet', 'other'));
  assert.ok(band.above('pet', 'taskbar'));
  assert.equal(band.activations, 0);
  assert.deepEqual(ptr.calls, [true]);
});

test('measured before: re-applying the floating level leaves her under a later window (what startup and the guard did before 11-08)', () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.setAlwaysOnTop(true, 'floating'); pet.visible = true;
  new BandWin(band, 'other', true);
  pet.setAlwaysOnTop(true, 'floating');
  assert.ok(band.above('other', 'pet'));
});

test('startup applies exactly what a toggle off and on applies', windowsOnly, () => {
  const startup = new Band(), toggled = new Band();
  const a = new BandWin(startup, 'pet'); new BandWin(startup, 'other', true);
  const b = new BandWin(toggled, 'pet'); new BandWin(toggled, 'other', true);
  const settings = { ...on, clickThrough: false };
  const pa = pointer(), pb = pointer();
  applyPetWindowSettings(a, settings, pa);
  applyPetWindowSettings(b, settings, pb);
  applyPetWindowSettings(b, { ...settings, alwaysOnTop: false }, pb);
  applyPetWindowSettings(b, settings, pb);
  assert.deepEqual(startup.order, toggled.order);
  assert.equal(a.isVisible(), b.isVisible());
  assert.equal(pa.calls.at(-1), pb.calls.at(-1));
});

test('order: shown first (inactive), then the style, then the mouse flag on the shown window', () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet');
  const order: string[] = [];
  const ptr = { sync: (v: boolean) => { order.push(`pointer:${v}:${pet.isVisible() ? 'shown' : 'hidden'}`); } };
  applyPetWindowSettings(pet, on, ptr);
  assert.deepEqual(pet.calls.slice(0, 2), ['showInactive', `top:true:${petTopmostLevel()}`]);
  assert.deepEqual(order, ['pointer:true:shown']);
});

test('saved hidden and not on top: hidden, out of the band, mouse flag still applied', () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.setAlwaysOnTop(true, 'pop-up-menu'); pet.visible = true;
  const ptr = pointer();
  applyPetWindowSettings(pet, { visible: false, alwaysOnTop: false, clickThrough: false }, ptr);
  assert.equal(pet.isVisible(), false);
  assert.equal(pet.isAlwaysOnTop(), false);
  assert.deepEqual(ptr.calls, [false]);
});

test('a settings change while she is on top leaves a topmost window shown after her above her', windowsOnly, () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet');
  applyPetWindowSettings(pet, on, pointer());
  const later = new BandWin(band, 'later', true);
  pet.calls = [];
  for (const clickThrough of [false, true, false]) applyPetWindowSettings(pet, { ...on, clickThrough }, pointer());
  assert.ok(band.above('later', 'pet'));
  assert.deepEqual(pet.calls, [], 'no z-order call at all');
});

/** Ten seconds of 2 s checks (fake clock). */
function tenSeconds(guard: PetTopmostGuard, clock: { t: number }): string[] {
  const seen: string[] = [];
  for (let s = 0; s <= 10; s += 2) { clock.t += 2000; seen.push(guard.check()); }
  return seen;
}

test('guard: a topmost window shown after her stays above her (10 s of checks); she stays above ordinary windows', windowsOnly, () => {
  const band = new Band(); const clock = { t: 0 };
  const pet = new BandWin(band, 'pet'); pet.visible = true;
  applyPetTopmost(pet, true);
  const later = new BandWin(band, 'later', true);
  const guard = new PetTopmostGuard({ window: () => pet, wanted: () => true, now: () => clock.t });
  assert.deepEqual(tenSeconds(guard, clock), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.ok(band.above('later', 'pet'));
  assert.ok(pet.top, 'still in the band: above every ordinary window');
  assert.equal(band.activations, 0);
});

test('guard: a full-screen topmost overlay (the screenshot overlay) shown after her is never covered', windowsOnly, () => {
  const band = new Band(); const clock = { t: 0 };
  const pet = new BandWin(band, 'pet'); pet.visible = true;
  applyPetWindowSettings(pet, on, pointer());
  const guard = new PetTopmostGuard({ window: () => pet, wanted: () => true, now: () => clock.t });
  const overlay = new BandWin(band, 'screenshot-overlay', true);
  tenSeconds(guard, clock);
  assert.ok(band.above('screenshot-overlay', 'pet'));
  overlay.setAlwaysOnTop(false); // the overlay closes
  assert.ok(band.above('pet', 'taskbar'), 'she is where she was');
});

test('the old guard (raise every check) covered that window within one check: the bug', windowsOnly, () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.visible = true;
  applyPetTopmost(pet, true);
  new BandWin(band, 'later', true);
  raisePet(pet); // what every 2 s check did when she still had the style
  assert.ok(band.above('pet', 'later'));
});

test('her own moments lift her to the top of the band, without activation; not while hidden or with the switch off', windowsOnly, () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.visible = true;
  applyPetTopmost(pet, true);
  const later = new BandWin(band, 'later', true);
  let wanted = true;
  const guard = new PetTopmostGuard({ window: () => pet, wanted: () => wanted });
  assert.equal(guard.ownMoment(), 'raised');
  assert.ok(band.above('pet', 'later'));
  assert.equal(band.activations, 0);
  later.setAlwaysOnTop(true, 'pop-up-menu');
  wanted = false;
  assert.equal(guard.ownMoment(), 'skipped');
  assert.ok(band.above('later', 'pet'));
  wanted = true; pet.visible = false;
  assert.equal(guard.ownMoment(), 'skipped');
  assert.ok(band.above('later', 'pet'));
});

test('a lost style is put back by the next check (the top of the band, like turning the switch on)', windowsOnly, () => {
  const band = new Band();
  const pet = new BandWin(band, 'pet'); pet.visible = true;
  applyPetTopmost(pet, true);
  pet.setAlwaysOnTop(false); // lost from outside
  const guard = new PetTopmostGuard({ window: () => pet, wanted: () => true });
  assert.equal(guard.check(), 'applied');
  assert.ok(band.above('pet', 'taskbar'));
});

test('TopmostWindow fakes stay structurally compatible', () => {
  const win: TopmostWindow = new BandWin(new Band(), 'x');
  assert.equal(win.isAlwaysOnTop(), false);
});
