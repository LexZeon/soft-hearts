import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bounds } from '../electron/pet-view';
import {
  PET_SETTLE_CHECKS_MS, PetPresentation, PetWindowDiagnostics, presentRecoveredPet, readPetPresentationSample,
  type PetPresentationPorts, type PetWindowLike,
} from '../electron/pet-restore';

const AREA: Bounds = { x: 0, y: 0, width: 1920, height: 1040 };
const CENTER: Bounds = { x: 760, y: 240, width: 400, height: 560 };

class FakeWindow implements PetWindowLike {
  calls: string[] = [];
  visible = false; minimized = false; maximized = false; destroyed = false;
  top = false; opacity = 1; ignoring = true;
  bounds: Bounds = { x: 5000, y: 5000, width: 400, height: 560 };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.minimized; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  isAlwaysOnTop() { return this.top; }
  getOpacity() { return this.opacity; }
  getBounds() { return { ...this.bounds }; }
  restore() { this.calls.push('restore'); this.minimized = false; this.maximized = false; }
  setBounds(bounds: Bounds) { this.calls.push('setBounds'); this.bounds = { ...bounds }; }
  setIgnoreMouseEvents(ignore: boolean) { this.calls.push(`ignore:${ignore}`); this.ignoring = ignore; }
  setAlwaysOnTop(flag: boolean) { this.calls.push(`top:${flag}`); this.top = flag; }
  setOpacity(value: number) { this.calls.push(`opacity:${value}`); this.opacity = value; }
  show() { this.calls.push('show'); this.visible = true; }
  showInactive() { this.calls.push('showInactive'); this.visible = true; }
  moveTop() { this.calls.push('moveTop'); }
}

/** Deterministic timers: tasks run in due order when time advances. */
class Clock {
  now = 0;
  private tasks: { at: number; fn: () => void; id: number }[] = [];
  private next = 0;
  schedule = (fn: () => void, ms: number) => {
    const id = ++this.next; this.tasks.push({ at: this.now + ms, fn, id });
    return () => { this.tasks = this.tasks.filter(task => task.id !== id); };
  };
  advance(ms: number, at?: Record<number, () => void>) {
    const end = this.now + ms;
    const marks = Object.keys(at ?? {}).map(Number).sort((a, b) => a - b);
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
      const task = this.tasks[0], mark = marks[0];
      const nextAt = Math.min(task && task.at <= end ? task.at : Infinity, mark !== undefined && mark <= end ? mark : Infinity);
      if (nextAt === Infinity) break;
      this.now = nextAt;
      if (mark === nextAt) { marks.shift(); at![mark](); continue; }
      this.tasks.shift(); task.fn();
    }
    this.now = end;
  }
  get pending() { return this.tasks.length; }
}

function rig(options: Partial<{ visible: boolean; top: boolean; busy: () => boolean; diagnostics: boolean }> = {}) {
  const win = new FakeWindow(), clock = new Clock();
  const intent = { visible: options.visible ?? true, alwaysOnTop: options.top ?? true };
  const gaveUp: string[] = [];
  const ports: PetPresentationPorts = {
    window: () => win,
    screen: () => ({ getAllDisplays: () => [{ workArea: AREA }], getDisplayMatching: () => ({ workArea: AREA }) }),
    intent: () => intent,
    busy: options.busy ?? (() => false),
    diagnostics: () => options.diagnostics ?? true,
    giveUp: reason => gaveUp.push(reason),
    schedule: clock.schedule,
    now: () => clock.now,
  };
  return { win, clock, intent, gaveUp, presentation: new PetPresentation(ports) };
}

test('recovery restores a lowered opacity to 1, and only then', () => {
  const win = new FakeWindow();
  win.opacity = 0.3;
  presentRecoveredPet(win, CENTER);
  assert.ok(win.calls.includes('opacity:1'), 'a lowered opacity must come back to 1 (pet-recovery-smoke contract)');
  assert.equal(win.getOpacity(), 1);
});

test('explicit recovery presents a centered, top-most, interactive pet without touching window opacity', () => {
  const win = new FakeWindow();
  win.minimized = true;
  presentRecoveredPet(win, CENTER);
  assert.deepEqual(win.calls, ['restore', 'setBounds', 'ignore:false', 'top:true', 'show', 'moveTop']);
  assert.ok(!win.calls.some(call => call.startsWith('opacity')),
    'setOpacity turns the transparent pet into a WS_EX_LAYERED/LWA_ALPHA window on Windows; recovery must never call it');
  assert.equal(win.isVisible(), true);
  assert.deepEqual(win.getBounds(), CENTER);
  assert.equal(win.top, true);
  assert.equal(win.ignoring, false);
});

test('recovery does not natively restore a pet that is merely hidden', () => {
  const win = new FakeWindow();
  presentRecoveredPet(win, CENTER);
  assert.equal(win.calls[0], 'setBounds', 'restore() on a hidden HWND shows it without an Electron show event');
});

test('a late native hide after recovery is repaired while the saved intent still wants the pet', () => {
  const { win, clock, presentation } = rig();
  presentation.recover(win, CENTER);
  assert.equal(win.isVisible(), true);
  // Something asynchronous hides the window 300 ms after the restore (the reported "flash, then gone").
  clock.advance(PET_SETTLE_CHECKS_MS.at(-1)! + 10, { 300: () => { win.visible = false; } });
  assert.equal(win.isVisible(), true, 'the restored pet must stay visible');
  assert.ok(win.calls.lastIndexOf('show') > win.calls.indexOf('moveTop'), 'repair shows the pet again');
  const repairs = presentation.view().entries.filter(entry => entry.event === 'repair');
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].detail.problems, 'hidden');
  assert.equal(repairs[0].detail.reason, 'restore');
  assert.equal(clock.pending, 0, 'the settle window ends');
});

test('a late minimize or move off every display is pulled back to the recovered position', () => {
  const { win, clock, presentation } = rig();
  presentation.recover(win, CENTER);
  clock.advance(5000, { 200: () => { win.minimized = true; }, 900: () => { win.bounds = { x: -9000, y: 40, width: 400, height: 560 }; } });
  assert.equal(win.isVisible(), true);
  assert.deepEqual(win.getBounds(), CENTER);
  const problems = presentation.view().entries.filter(entry => entry.event === 'repair').map(entry => entry.detail.problems);
  assert.deepEqual(problems, ['minimized', 'off-screen']);
});

test('a lost top-most state is re-applied only when the saved setting wants it', () => {
  const kept = rig();
  kept.presentation.recover(kept.win, CENTER);
  kept.clock.advance(5000, { 100: () => { kept.win.top = false; } });
  assert.equal(kept.win.top, true);
  const off = rig({ top: false });
  off.win.visible = true; off.win.bounds = { ...CENTER };
  off.presentation.arm('show');
  off.clock.advance(5000);
  assert.ok(!off.win.calls.includes('top:true'));
});

test('the guard never fights an explicit hide', () => {
  const { win, clock, intent, presentation } = rig();
  presentation.recover(win, CENTER);
  const before = win.calls.length;
  clock.advance(5000, { 250: () => { intent.visible = false; win.visible = false; } });
  assert.equal(win.isVisible(), false);
  assert.deepEqual(win.calls.slice(before), []);
});

test('a user drag owns geometry; checks wait instead of snapping the pet back', () => {
  let dragging = true;
  const { win, clock, presentation } = rig({ busy: () => dragging });
  presentation.recover(win, CENTER);
  win.bounds = { x: -9000, y: 0, width: 400, height: 560 };
  clock.advance(1300);
  assert.equal(win.getBounds().x, -9000);
  dragging = false;
  clock.advance(5000);
  assert.deepEqual(win.getBounds(), CENTER);
});

test('repairs are bounded, and a failed startup falls back once', () => {
  const { win, clock, gaveUp, presentation } = rig();
  win.show = () => { win.calls.push('show'); };          // The OS refuses to show it.
  win.showInactive = () => { win.calls.push('showInactive'); };
  presentation.arm('startup');
  clock.advance(10_000);
  assert.ok(win.calls.filter(call => call === 'showInactive').length <= 3);
  assert.ok(!win.calls.includes('show'), 'startup repair never steals focus');
  assert.deepEqual(gaveUp, ['startup']);
});

test('a newer request supersedes the older settle checks', () => {
  const { win, clock, presentation } = rig();
  presentation.recover(win, CENTER);
  clock.advance(100);
  const second: Bounds = { x: 100, y: 100, width: 400, height: 560 };
  presentation.recover(win, second);
  // The first request's 1200 ms check would snap to CENTER; only the newer request's 1300 ms check may act.
  clock.advance(5000, { 1150: () => { win.bounds = { x: -9000, y: 0, width: 400, height: 560 }; } });
  assert.deepEqual(win.getBounds(), second);
});

test('a native call that throws inside a settle check ends the watch instead of escaping the timer', () => {
  const { win, clock, presentation } = rig();
  presentation.recover(win, CENTER);
  win.getBounds = () => { throw new Error('Object has been destroyed'); };
  assert.doesNotThrow(() => clock.advance(5000));
  assert.equal(clock.pending, 0);
  assert.ok(presentation.view().entries.some(entry => entry.event === 'check-failed'));
});

test('diagnostics stay off by default, are bounded when on, and keep only window facts', () => {
  let enabled = false, t = 0;
  const lines: string[] = [];
  const log = new PetWindowDiagnostics(() => enabled, () => t, 5, line => lines.push(line));
  log.record('show', { visible: true });
  assert.deepEqual(log.view(), { enabled: false, entries: [] });
  enabled = true;
  for (let i = 0; i < 9; i++) { t = i; log.record('check', { index: i, nested: { secret: 'x' } as unknown as number, text: 'y'.repeat(500) }); }
  const view = log.view();
  assert.equal(view.entries.length, 5);
  assert.deepEqual(view.entries.map(entry => entry.detail.index), [4, 5, 6, 7, 8]);
  assert.equal(view.entries[0].detail.nested, undefined, 'non-primitive detail values are dropped');
  assert.ok(String(view.entries[0].detail.text).length <= 80);
  assert.equal(lines.length, 9);
  enabled = false;
  assert.deepEqual(log.view().entries, [], 'turning developer mode off hides the log again');
});

test('renderer presentation reports are strictly shaped', () => {
  const sample = { reason: 'restore', visibility: 'visible', hostVisible: true, canvasWidth: 400, canvasHeight: 560,
    clientWidth: 400, clientHeight: 560, devicePixelRatio: 1.5, contextLost: false, frameAdvanced: true };
  assert.deepEqual(readPetPresentationSample(sample), sample);
  assert.deepEqual(readPetPresentationSample({ ...sample, contextLost: null }).contextLost, null);
  for (const bad of [null, [], { ...sample, extra: 1 }, { ...sample, visibility: 'peek' }, { ...sample, canvasWidth: -1 },
    { ...sample, canvasWidth: Number.NaN }, { ...sample, hostVisible: 'yes' }, { ...sample, reason: 'other' }])
    assert.throws(() => readPetPresentationSample(bad), /桌宠呈现/);
});

test('renderer reports and native events land in the same developer log', () => {
  const { win, presentation } = rig();
  presentation.note('close');
  presentation.noteRenderer({ reason: 'startup', visibility: 'hidden', hostVisible: false, canvasWidth: 0, canvasHeight: 0,
    clientWidth: 0, clientHeight: 0, devicePixelRatio: 1, contextLost: true, frameAdvanced: false });
  const [close, renderer] = presentation.view().entries;
  assert.equal(close.event, 'close');
  assert.equal(close.detail.visible, win.isVisible());
  assert.equal(renderer.event, 'renderer');
  assert.equal(renderer.detail.contextLost, true);
});
