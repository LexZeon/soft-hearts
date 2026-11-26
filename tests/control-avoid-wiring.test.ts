// T-253 option 1's wiring (electron/wiring/stage-avoid-wiring.ts), evaluated with fake windows and fake timers: the bubble reads the
// control window only while it is shown; she never steps while the user drags her or while she is out in Unbound; control window events
// re-place the bubble at once. docs/claude/2026-11-19-control-window-avoid.md.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as stepAsideModule from '../electron/stage/companion-step-aside';

type Rect = { x: number; y: number; width: number; height: number };
const area = { x: 0, y: 0, width: 1920, height: 1040 };

function wiring(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'wiring', 'stage-avoid-wiring.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  class Win extends EventEmitter {
    visible = true; minimized = false; destroyed = false; calls: string[] = [];
    constructor(public bounds: Rect) { super(); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    getBounds() { return { ...this.bounds }; } getContentBounds() { return { x: this.bounds.x + 8, y: this.bounds.y + 31, width: this.bounds.width - 16, height: this.bounds.height - 39 }; }
    setBounds(next: Rect) { this.calls.push('setBounds'); this.bounds = { ...next }; this.emit('move'); }
  }
  const controls = new Win({ x: 300, y: 100, width: 1260, height: 850 }); // content bottom band: y 742..942
  const companion = new Win({ x: 1000, y: 470, width: 400, height: 560 }); // her body covers the band
  const stage = { needs: { controls, store: { current: { pet: { clickThrough: true } } } }, petWindowDrag: { active: false } }; // no-pet-ok: the stage wiring's export and settings names
  const unboundWiring = { held: false, petHeld() { return unboundWiring.held; } }; // no-pet-ok: the Unbound wiring's export name
  const stubs: Record<string, unknown> = {
    electron: { screen: { getDisplayMatching: () => ({ workArea: { ...area } }) } },
    '../stage': stepAsideModule, './stage-wiring': stage, './unbound-wiring': unboundWiring,
  };
  const module = { exports: {} as { startControlAvoidance(companion: unknown, reply: unknown): void } };
  new Function('require', 'module', 'exports', js)((name: string) => { if (!(name in stubs)) throw new Error(`unexpected import ${name}`); return stubs[name]; }, module, module.exports);
  let source: (() => Rect[] | null) | null = null;
  const reply = { syncs: 0, setAvoidSource(fn: () => Rect[] | null) { source = fn; }, sync() { reply.syncs++; } };
  module.exports.startControlAvoidance(companion, reply);
  t.after(() => companion.emit('closed'));
  return { controls, companion, stage, unboundWiring, reply, source: () => source!(), run: (ms: number) => { for (let at = 0; at < ms; at += 4) t.mock.timers.tick(4); } }; // small ticks: the clock moves with the timers
}

test('the bubble reads the control window only while it is shown and not minimized; its events re-place the bubble at once', t => {
  const w = wiring(t);
  // The whole window first, then its input / send / stop band (content y 131..942: the bottom 200).
  assert.deepEqual(w.source(), [{ x: 300, y: 100, width: 1260, height: 850 }, { x: 308, y: 742, width: 1244, height: 200 }]);
  w.controls.minimized = true; assert.equal(w.source(), null);
  w.controls.minimized = false; w.controls.visible = false; assert.equal(w.source(), null);
  w.controls.visible = true;
  for (const event of ['show', 'hide', 'minimize', 'restore', 'move', 'resize']) { const before = w.reply.syncs; w.controls.emit(event); assert.equal(w.reply.syncs, before + 1, event); }
});

test('she steps aside from the band when the control window shows, and walks back when it hides', t => {
  const w = wiring(t);
  const home = w.companion.getBounds();
  w.controls.emit('show');
  w.run(1200);
  assert.ok(w.companion.calls.length > 5);
  assert.equal(stepAsideModule.coversRegion(w.companion.bounds, stepAsideModule.protectedRegion(w.controls)!, true), false);
  w.controls.visible = false; w.controls.emit('hide');
  w.run(1200);
  assert.deepEqual(w.companion.bounds, home);
});

test('never while the user drags her', t => {
  const w = wiring(t);
  w.stage.petWindowDrag.active = true; // no-pet-ok: the stage wiring's export name
  w.controls.emit('show');
  w.run(3000);
  assert.equal(w.companion.calls.length, 0);
});

test('never while she is out in Unbound (her window is held)', t => {
  const w = wiring(t);
  w.unboundWiring.held = true;
  w.controls.emit('show');
  w.run(3000);
  assert.equal(w.companion.calls.length, 0);
});
