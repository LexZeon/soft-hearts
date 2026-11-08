// Click-through that keeps her touchable: only the transparent space around her
// lets the mouse through. Host flag (electron/pet-pointer-input.ts), her pixels (src/stage/pixel-probe.ts)
// and the renderer's decision (src/ui/pointer-passthrough.ts), each imported and driven directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PetPointerInput, cursorInside, type PointerInputWindow } from '../electron/pet-pointer-input';
import { StagePixelProbe, probeBlock, blockAlpha, PROBE_OUTER_RADIUS, PROBE_STALE_MS, type ProbeGl, type StageAlpha } from '../src/stage/pixel-probe';
import { PointerPassthrough, classifyPetPoint, PASSTHROUGH_TIMING, PASSTHROUGH_ALPHA, type PassthroughPorts, type PointTarget, type HitDocument } from '../src/ui/pointer-passthrough';

// ---------- host ----------
class FakeWindow implements PointerInputWindow {
  calls: string[] = [];
  visible = true; minimized = false; destroyed = false;
  bounds = { x: 30, y: 30, width: 400, height: 560 };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  getBounds() { return { ...this.bounds }; }
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }) { this.calls.push(`${ignore}${options?.forward ? '+forward' : ''}`); }
}
function host(cursor = { x: 100, y: 100 }) {
  const win = new FakeWindow();
  const input = new PetPointerInput({ window: () => win, cursor: () => cursor });
  return { win, input, cursor };
}

test('host: off click-through the whole window takes the mouse, as before (every sync re-applies)', () => {
  const { win, input } = host();
  input.sync(false); input.sync(false);
  assert.deepEqual(win.calls, ['false+forward', 'false+forward']);
  assert.equal(input.request(true), true, 'the window already receives everywhere');
  assert.equal(input.request(false), true, 'a renderer cannot make a normal pet ignore the mouse');
  assert.deepEqual(win.calls, ['false+forward', 'false+forward'], 'requests change nothing off click-through');
});

test('host: click-through starts letting the mouse through and forwards moves', () => {
  const { win, input } = host();
  input.sync(true);
  assert.deepEqual(win.calls, ['true+forward']);
  assert.equal(input.ignoring, true);
});

test('host: the pet renderer can take the mouse only while the cursor is inside the shown window', () => {
  const { win, input, cursor } = host();
  input.sync(true); win.calls = [];
  assert.equal(input.request(true), true);
  assert.deepEqual(win.calls, ['false+forward']);
  assert.equal(input.request(true), true);
  assert.deepEqual(win.calls, ['false+forward'], 'a repeated wish is not re-applied');
  assert.equal(input.request(false), false);
  assert.deepEqual(win.calls, ['false+forward', 'true+forward']);
  cursor.x = 2000;
  assert.equal(input.request(true), false, 'cursor already outside: refused');
  cursor.x = 100; win.minimized = true;
  assert.equal(input.request(true), false, 'minimized: refused');
  win.minimized = false; win.visible = false;
  assert.equal(input.request(true), false, 'hidden: refused');
  assert.deepEqual(win.calls, ['false+forward', 'true+forward']);
});

test('host: only a boolean is accepted', () => {
  const { input } = host();
  input.sync(true);
  for (const bad of [1, 'true', null, undefined, { receive: true }]) assert.throws(() => input.request(bad), /鼠标接收状态不正确/);
});

test('host: turning click-through off and on, hiding, or losing the renderer forgets the wish', () => {
  const { win, input } = host();
  input.sync(true); input.request(true); win.calls = [];
  input.sync(false); input.sync(true);
  assert.deepEqual(win.calls, ['false+forward', 'true+forward'], 'a fresh click-through lets the mouse through first');
  input.request(true); win.calls = [];
  input.reset();
  assert.deepEqual(win.calls, ['true+forward']);
  input.reset();
  assert.deepEqual(win.calls, ['true+forward'], 'reset without a wish does nothing');
  input.request(true); win.calls = [];
  input.sync(true);
  assert.deepEqual(win.calls, ['false+forward'], 'an unrelated settings sync keeps a held wish');
});

test('host: cursorInside allows a DIP rounding edge only', () => {
  const bounds = { x: 30, y: 30, width: 400, height: 560 };
  assert.equal(cursorInside(bounds, { x: 30, y: 30 }), true);
  assert.equal(cursorInside(bounds, { x: 29, y: 589 }), true);
  assert.equal(cursorInside(bounds, { x: 25, y: 100 }), false);
  assert.equal(cursorInside(bounds, { x: 100, y: Number.NaN }), false);
});

// ---------- her pixels ----------
const canvas = (width = 600, height = 840, rect = { left: 0, top: 0, width: 400, height: 560 }) =>
  ({ width, height, getBoundingClientRect: () => rect });

test('probe: client point maps onto the drawing buffer (device ratio, bottom-left origin, clamped block)', () => {
  const block = probeBlock(canvas(), 200, 100)!;
  assert.deepEqual({ px: block.px, py: block.py }, { px: 300, py: 840 - 1 - 150 });
  assert.deepEqual({ x0: block.x0, y0: block.y0, w: block.w, h: block.h }, { x0: 296, y0: 685, w: 9, h: 9 });
  const corner = probeBlock(canvas(), 0, 0)!;
  assert.deepEqual(corner, { x0: 0, y0: 835, w: 5, h: 5, px: 0, py: 839 });
  assert.equal(probeBlock(canvas(), -1, 10), null);
  assert.equal(probeBlock(canvas(), 400, 10), null);
  assert.equal(probeBlock(canvas(0, 0), 10, 10), null);
  assert.equal(probeBlock(canvas(), Number.NaN, 10), null);
});

test('probe: inner alpha is the pointer itself (3×3), outer the wider hold (9×9)', () => {
  const block = { x0: 0, y0: 0, w: 9, h: 9, px: 4, py: 4 };
  const rgba = new Uint8Array(9 * 9 * 4);
  rgba[(0 * 9 + 0) * 4 + 3] = 200; // a far corner of the block
  assert.deepEqual(blockAlpha(block, rgba), { inner: 0, outer: 200 });
  rgba[(5 * 9 + 3) * 4 + 3] = 90; // one pixel off the centre
  assert.deepEqual(blockAlpha(block, rgba), { inner: 90, outer: 200 });
});

class FakeGl {
  RGBA = 1; UNSIGNED_BYTE = 2; PIXEL_PACK_BUFFER = 3; STREAM_READ = 4; SYNC_GPU_COMMANDS_COMPLETE = 5; SYNC_STATUS = 6; SIGNALED = 7;
  calls: string[] = []; signaled = false; lost = false;
  /** Alpha written into the read block, by offset from the centre pixel. */
  alphaAt: (dx: number, dy: number) => number = () => 0;
  private lastRead: { x: number; y: number; w: number; h: number } | null = null;
  createBuffer() { this.calls.push('createBuffer'); return {} as WebGLBuffer; }
  deleteBuffer() { this.calls.push('deleteBuffer'); }
  bindBuffer(_target: number, buffer: unknown) { this.calls.push(buffer ? 'bind' : 'unbind'); }
  bufferData(_target: number, size: number) { this.calls.push(`bufferData:${size}`); }
  readPixels(x: number, y: number, w: number, h: number, _format: number, _type: number, offset: number) {
    this.calls.push(`readPixels:${x},${y},${w},${h}@${offset}`); this.lastRead = { x, y, w, h };
  }
  fenceSync() { this.calls.push('fenceSync'); return {} as WebGLSync; }
  getSyncParameter() { return this.signaled ? this.SIGNALED : 0; }
  deleteSync() { this.calls.push('deleteSync'); }
  getBufferSubData(_target: number, _offset: number, dst: Uint8Array, _dstOffset: number, length: number) {
    this.calls.push(`getBufferSubData:${length}`);
    const read = this.lastRead!, cx = read.x + Math.min(PROBE_OUTER_RADIUS, read.w - 1), cy = read.y + PROBE_OUTER_RADIUS;
    dst.fill(0, 0, length);
    for (let row = 0; row < read.h; row++) for (let column = 0; column < read.w; column++)
      dst[(row * read.w + column) * 4 + 3] = this.alphaAt(read.x + column - cx, read.y + row - cy);
  }
  isContextLost() { return this.lost; }
}
const asGl = (gl: FakeGl) => gl as unknown as ProbeGl;
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('probe: nothing asked, nothing read (no GPU work outside click-through)', () => {
  const gl = new FakeGl(), probe = new StagePixelProbe(() => 0);
  probe.afterRender(asGl(gl), canvas());
  assert.deepEqual(gl.calls, []);
  assert.equal(probe.idle, true);
});

test('probe: a read is copied behind a fence and picked up on a later frame without stalling', async () => {
  const gl = new FakeGl(), probe = new StagePixelProbe(() => 0);
  gl.alphaAt = (dx, dy) => (dx === 0 && dy === 0 ? 255 : 0);
  let result: StageAlpha | null | undefined;
  void probe.request(200, 100).then(value => { result = value; });
  probe.afterRender(asGl(gl), canvas());
  assert.deepEqual(gl.calls, ['createBuffer', 'bind', `bufferData:${9 * 9 * 4}`, 'unbind', 'bind', 'readPixels:296,685,9,9@0', 'unbind', 'fenceSync']);
  gl.calls = [];
  probe.afterRender(asGl(gl), canvas());
  await settle();
  assert.equal(result, undefined, 'not signalled yet: the frame goes on, no read-back');
  assert.deepEqual(gl.calls, []);
  gl.signaled = true;
  probe.afterRender(asGl(gl), canvas());
  await settle();
  assert.deepEqual(result, { inner: 255, outer: 255 });
  assert.deepEqual(gl.calls, ['deleteSync', 'bind', `getBufferSubData:${9 * 9 * 4}`, 'unbind']);
  assert.equal(probe.idle, true);
  assert.deepEqual({ started: probe.stats.started, finished: probe.stats.finished }, { started: 1, finished: 1 });
});

test('probe: only the newest request is kept; a point off the canvas costs no read', async () => {
  const gl = new FakeGl(), probe = new StagePixelProbe(() => 0);
  const first = probe.request(10, 10), second = probe.request(-5, 10);
  assert.equal(await first, null);
  probe.afterRender(asGl(gl), canvas());
  assert.deepEqual(await second, { inner: 0, outer: 0 });
  assert.deepEqual(gl.calls, []);
});

test('probe: a read the GPU never signals is dropped; a lost context resolves everything', async () => {
  let now = 0;
  const gl = new FakeGl(), probe = new StagePixelProbe(() => now);
  const stale = probe.request(200, 100);
  probe.afterRender(asGl(gl), canvas());
  now = PROBE_STALE_MS + 1;
  probe.afterRender(asGl(gl), canvas());
  assert.equal(await stale, null);
  assert.equal(probe.stats.dropped, 1);
  const lost = probe.request(200, 100);
  gl.lost = true;
  probe.afterRender(asGl(gl), canvas());
  assert.equal(await lost, null);
});

// ---------- the renderer's decision ----------
interface Timer { due: number; callback: () => void; id: number }
function rig(options: { enabled?: boolean; target?: PointTarget; alpha?: StageAlpha | null; host?: (receive: boolean) => boolean } = {}) {
  let now = 0, nextId = 1;
  const timers: Timer[] = [];
  const state = { enabled: options.enabled ?? true, holds: false, target: options.target ?? ('stage' as PointTarget), alpha: options.alpha ?? ({ inner: 0, outer: 0 } as StageAlpha | null) };
  const requests: boolean[] = [], probes: { x: number; y: number }[] = [];
  let pendingProbe: ((value: StageAlpha | null) => void) | null = null;
  let autoProbe = true;
  const ports: PassthroughPorts = {
    enabled: () => state.enabled, holds: () => state.holds, classify: () => state.target,
    probe: (x, y) => { probes.push({ x, y }); return new Promise(resolve => { if (autoProbe) resolve(state.alpha); else pendingProbe = resolve; }); },
    request: receive => { requests.push(receive); return Promise.resolve(options.host ? options.host(receive) : receive); },
    now: () => now,
    setTimer: (callback, ms) => { const timer = { due: now + ms, callback, id: nextId++ }; timers.push(timer); return timer.id; },
    clearTimer: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
  };
  const controller = new PointerPassthrough(ports);
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await settle();
      timers.sort((a, b) => a.due - b.due);
      const next = timers[0];
      if (!next || next.due > end) break;
      timers.shift(); now = next.due; next.callback();
    }
    now = end; await settle();
  };
  return { controller, state, requests, probes, advance, timers,
    manual() { autoProbe = false; }, answer(value: StageAlpha | null) { const resolve = pendingProbe; pendingProbe = null; resolve?.(value); } };
}
const SOLID: StageAlpha = { inner: 255, outer: 255 };
const EMPTY: StageAlpha = { inner: 0, outer: 0 };

test('decision: off click-through nothing is probed or requested, however the pointer moves', async () => {
  const r = rig({ enabled: false, target: 'ui' });
  r.controller.start();
  await settle();
  const before = r.requests.length;
  for (let i = 0; i < 20; i++) { r.controller.move(i * 10, 50, 0); await r.advance(16); }
  r.controller.leave(); await r.advance(1000);
  assert.equal(r.requests.length, before, 'no requests beyond the one start-up reset');
  assert.deepEqual(r.probes, []);
  assert.equal(r.timers.length, 0, 'and no timers left running');
  assert.equal(r.controller.state.active, false);
});

test('decision: a visible control takes the mouse at once; her empty surroundings never do', async () => {
  const r = rig({ target: 'ui' });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(380, 20, 0); await settle();
  assert.deepEqual(r.requests, [true]);
  assert.equal(r.controller.state.receiving, true);
  r.state.target = 'stage'; r.state.alpha = EMPTY;
  r.controller.move(200, 300, 0); await r.advance(PASSTHROUGH_TIMING.releaseDelayMs + 60);
  assert.deepEqual(r.requests, [true, false], 'empty space hands the mouse back');
  assert.equal(r.controller.state.receiving, false);
});

test('decision: her pixels take the mouse; empty pixels let it through', async () => {
  const r = rig({ alpha: SOLID });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(200, 200, 0); await settle();
  assert.equal(r.probes.length, 1);
  assert.deepEqual(r.requests, [true]);
  const e = rig({ alpha: EMPTY });
  e.controller.start(); await settle(); e.requests.length = 0;
  e.controller.move(20, 500, 0); await e.advance(1000);
  assert.deepEqual(e.requests, [], 'nothing to take: the click goes to the window behind');
});

test('decision: entering needs a solid pixel, staying only a faint wider one (no edge flicker)', async () => {
  const r = rig({ alpha: { inner: PASSTHROUGH_ALPHA.enter - 1, outer: 255 } });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(100, 100, 0); await r.advance(100);
  assert.deepEqual(r.requests, [], 'a faint edge does not grab the mouse');
  r.state.alpha = SOLID; r.controller.move(101, 100, 0); await r.advance(60);
  assert.deepEqual(r.requests, [true]);
  r.state.alpha = { inner: 0, outer: PASSTHROUGH_ALPHA.stay };
  for (let i = 0; i < 10; i++) { r.controller.move(102 + i, 100, 0); await r.advance(60); }
  assert.deepEqual(r.requests, [true], 'her outline within a few pixels keeps it');
});

test('decision: misses hand the mouse back only after the release delay', async () => {
  const r = rig({ alpha: SOLID });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(200, 200, 0); await settle();
  r.state.alpha = EMPTY;
  r.controller.move(205, 200, 0); await r.advance(60);
  assert.deepEqual(r.requests, [true], 'one miss right after a hit is not enough');
  await r.advance(PASSTHROUGH_TIMING.releaseDelayMs);
  assert.deepEqual(r.requests, [true, false]);
});

test('decision: a pressed button (drag, pinch) never hands the mouse back mid-gesture', async () => {
  const r = rig({ alpha: SOLID });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(200, 200, 0); await settle();
  r.state.alpha = EMPTY; r.state.target = 'outside';
  for (let i = 0; i < 20; i++) { r.controller.move(200 + i * 30, 200, 1); await r.advance(50); }
  assert.deepEqual(r.requests, [true], 'held through the whole drag, even past her edge');
  r.controller.move(900, 200, 0); await r.advance(PASSTHROUGH_TIMING.releaseDelayMs + 60);
  assert.deepEqual(r.requests, [true, false], 'released button: back to passing through');
});

test('decision: a button held for some other window does not grab the mouse', async () => {
  const r = rig({ alpha: EMPTY });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(20, 20, 1); await r.advance(500);
  assert.deepEqual(r.requests, []);
});

test('decision: camera editing or window adjusting owns the whole window until it ends', async () => {
  const r = rig({ alpha: EMPTY });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.state.holds = true; r.controller.refresh(); await settle();
  assert.deepEqual(r.requests, [true]);
  r.controller.move(10, 10, 0); await r.advance(1000);
  assert.deepEqual(r.requests, [true]);
  r.state.holds = false; r.controller.refresh();
  await r.advance(PASSTHROUGH_TIMING.releaseDelayMs + 60);
  assert.deepEqual(r.requests, [true, false]);
});

test('decision: probes are rate-limited while moving, with a trailing probe at the last point', async () => {
  const r = rig({ alpha: EMPTY });
  r.controller.start(); await settle();
  for (let i = 0; i < 10; i++) { r.controller.move(100 + i, 100, 0); await r.advance(4); }
  assert.equal(r.probes.length, 1, '10 moves in 40 ms: one probe');
  await r.advance(PASSTHROUGH_TIMING.probeIntervalMs);
  assert.equal(r.probes.length, 2);
  assert.deepEqual(r.probes[1], { x: 109, y: 100 }, 'the trailing probe reads the latest point');
});

test('decision: under a still pointer she is re-checked, slowly (she moves; a hold expires)', async () => {
  const r = rig({ alpha: EMPTY });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(150, 150, 0); await settle();
  const first = r.probes.length;
  r.state.alpha = SOLID; // her arm swings under the resting pointer
  await r.advance(PASSTHROUGH_TIMING.idleProbeMs + 10);
  assert.deepEqual(r.requests, [true]);
  await r.advance(1000);
  assert.ok(r.probes.length - first <= Math.ceil(1250 / PASSTHROUGH_TIMING.idleProbeMs) + 1, `idle re-checks stay slow (${r.probes.length - first})`);
});

test('decision: leaving the window lets go after the release delay (a stray leave cannot flap); nothing runs while away', async () => {
  const r = rig({ alpha: SOLID });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(200, 200, 0); await settle();
  r.controller.leave(); await r.advance(20);
  r.controller.move(201, 200, 0); await r.advance(PASSTHROUGH_TIMING.releaseDelayMs + 20);
  assert.deepEqual(r.requests, [true], 'a leave followed by a move keeps the mouse');
  r.controller.leave(); await r.advance(PASSTHROUGH_TIMING.releaseDelayMs + 20);
  assert.deepEqual(r.requests, [true, false]);
  const probes = r.probes.length;
  await r.advance(5000);
  assert.equal(r.probes.length, probes);
  assert.equal(r.timers.length, 0);
});

test('decision: turning click-through off while holding the mouse tells the host; on again starts passing through', async () => {
  const r = rig({ target: 'ui' });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(380, 20, 0); await settle();
  r.state.enabled = false; r.controller.refresh(); await settle();
  assert.deepEqual(r.requests, [true, false]);
  r.state.enabled = true; r.state.target = 'stage'; r.state.alpha = EMPTY; r.controller.refresh(); await r.advance(500);
  assert.deepEqual(r.requests, [true, false], 'a fresh click-through asks for nothing until something is under the pointer');
  assert.equal(r.controller.state.receiving, false);
});

test('decision: the host answer is the truth (cursor already gone: refused)', async () => {
  const r = rig({ target: 'ui', host: () => false });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(380, 20, 0); await settle();
  assert.equal(r.controller.state.receiving, false);
  r.controller.move(381, 20, 0); await settle();
  assert.deepEqual(r.requests, [true, true], 'asks again on the next sample instead of believing it holds the mouse');
});

test('decision: a probe that never answers counts as a miss and does not wedge later probes', async () => {
  const r = rig({ alpha: SOLID });
  r.manual();
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(200, 200, 0); await settle();
  await r.advance(PASSTHROUGH_TIMING.probeTimeoutMs + 10);
  assert.deepEqual(r.requests, [], 'no answer is no hit');
  await r.advance(PASSTHROUGH_TIMING.idleProbeMs);
  assert.equal(r.probes.length, 2, 'the next re-check starts a fresh probe');
  r.answer(SOLID); await settle();
  assert.deepEqual(r.requests, [true]);
});

test('classify: shown controls are hits; the stage, page roots and faded controls are not', () => {
  const stageRoot = { contains: (node: unknown) => node === canvasElement || node === stageRoot, id: 'stage' } as unknown as Element;
  const canvasElement = { id: '' } as Element;
  const html = { id: '' } as Element, body = { id: '' } as Element, app = { id: 'app' } as Element;
  const button = { id: 'open-controls', checkVisibility: () => true } as unknown as Element;
  const faded = { id: 'pet-toolbar', checkVisibility: () => false } as unknown as Element;
  let under: Element | null = canvasElement;
  const doc: HitDocument = { elementFromPoint: () => under, documentElement: html, body, defaultView: { innerWidth: 400, innerHeight: 560 } };
  const at = (element: Element | null, x = 10, y = 10) => { under = element; return classifyPetPoint(doc, x, y, stageRoot); };
  assert.equal(at(canvasElement), 'stage');
  assert.equal(at(stageRoot), 'stage');
  assert.equal(at(html), 'stage');
  assert.equal(at(body), 'stage');
  assert.equal(at(app), 'stage');
  assert.equal(at(button), 'ui');
  assert.equal(at(faded), 'stage', 'opacity 0 is not a control');
  assert.equal(at(null), 'outside');
  assert.equal(at(button, 400, 10), 'outside');
  assert.equal(at(button, -1, 10), 'outside');
  assert.equal(at(button, Number.NaN, 10), 'outside');
});

// ---------- Codex T-112 round 031 (fixed 2a534c8) ----------
// F01 / R05: a drag (or a pressed button while the window holds the mouse) owns the whole window; a pixel result that
// comes back during it must not hand the mouse back (Codex saw request(false) at 225 ms, mid-drag, for 35 ms).
test('round 031: during a drag hold, a late transparent result never hands the mouse back', async () => {
  const r = rig({ alpha: EMPTY });
  r.manual();
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(200, 200, 0); await settle();
  assert.equal(r.probes.length, 1, 'a read is out');
  await r.advance(10);
  r.state.holds = true; r.controller.refresh(); await settle();
  assert.deepEqual(r.requests, [true], 'the drag takes the whole window');
  await r.advance(215);
  r.answer(EMPTY); await r.advance(100);
  assert.deepEqual(r.requests, [true], 'the late empty result changes nothing while the drag lasts');
  assert.equal(r.controller.state.receiving, true);
  r.state.holds = false; r.controller.refresh();
  r.answer(EMPTY); await r.advance(PASSTHROUGH_TIMING.releaseDelayMs + 300); r.answer(EMPTY); await r.advance(100);
  assert.deepEqual(r.requests, [true, false], 'after the drag the next fresh miss lets go as usual');
});

test('round 031: with a button pressed while she holds the mouse, a result asked before the press is ignored', async () => {
  const r = rig({ alpha: SOLID });
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(200, 200, 0); await settle();
  assert.deepEqual(r.requests, [true]);
  r.manual();
  await r.advance(PASSTHROUGH_TIMING.probeIntervalMs);
  r.controller.move(201, 200, 0); await settle();
  r.controller.move(201, 200, 1); await settle(); // pressed (a pat or a drag starts)
  await r.advance(PASSTHROUGH_TIMING.releaseDelayMs + 25);
  r.answer(EMPTY); await r.advance(50);
  assert.deepEqual(r.requests, [true], 'held while pressed');
});

// F02 / R03: a read queued inside the window, then the pointer leaves before the next frame: the read must not happen.
function pixelRig() {
  const probe = new StagePixelProbe(() => 0), gl = new FakeGl();
  let now = 0;
  const timers: Timer[] = [];
  let nextId = 1;
  const requests: boolean[] = [];
  const state = { target: 'stage' as PointTarget };
  const controller = new PointerPassthrough({ enabled: () => true, holds: () => false, classify: () => state.target,
    probe: (x, y, signal) => probe.request(x, y, signal), request: receive => { requests.push(receive); return Promise.resolve(receive); },
    now: () => now, setTimer: (callback, ms) => { const timer = { due: now + ms, callback, id: nextId++ }; timers.push(timer); return timer.id; },
    clearTimer: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); } });
  return { probe, gl, controller, requests, state, frame: () => probe.afterRender(asGl(gl), canvas()), reads: () => gl.calls.filter(call => call.startsWith('readPixels')).length };
}
test('round 031: leaving the window (or pointing outside it) withdraws a pixel read that was queued but not yet submitted', async () => {
  const left = pixelRig();
  left.controller.start(); await settle();
  left.controller.move(200, 100, 0);
  assert.equal(left.probe.idle, false, 'queued for the next frame');
  left.controller.leave();
  assert.equal(left.probe.idle, true, 'withdrawn at once');
  left.frame(); await settle();
  assert.equal(left.reads(), 0, 'no readPixels after the pointer left');
  const outside = pixelRig();
  outside.controller.start(); await settle();
  outside.controller.move(200, 100, 0);
  outside.state.target = 'outside'; outside.controller.move(420, 100, 0);
  outside.frame(); await settle();
  assert.equal(outside.reads(), 0, 'an explicit point outside the window withdraws it too');
  // Still inside: the read goes out on the next frame as before.
  const inside = pixelRig();
  inside.controller.start(); await settle();
  inside.controller.move(200, 100, 0); inside.frame(); await settle();
  assert.equal(inside.reads(), 1);
});

test('round 031: probe — an aborted request is resolved with null and costs no read; a newer request still replaces an older one', async () => {
  const gl = new FakeGl(), probe = new StagePixelProbe(() => 0);
  const controller = new AbortController();
  const asked = probe.request(200, 100, controller.signal);
  controller.abort();
  assert.equal(await asked, null);
  probe.afterRender(asGl(gl), canvas());
  assert.deepEqual(gl.calls, [], 'nothing read');
  const already = new AbortController(); already.abort();
  assert.equal(await probe.request(200, 100, already.signal), null, 'already aborted: no request at all');
  assert.equal(probe.idle, true);
  // Aborting an older request that a newer one already replaced does not touch the newer one.
  const older = new AbortController(), first = probe.request(10, 10, older.signal), second = probe.request(200, 100);
  assert.equal(await first, null);
  older.abort();
  assert.equal(probe.idle, false, 'the newer request is still waiting');
  probe.afterRender(asGl(gl), canvas());
  assert.equal((gl.calls as string[]).filter(call => call.startsWith('readPixels')).length, 1);
  void second;
});

// R08 / F03: the pointer moves inside the window from A (her) to B (empty) while A's read is out; A's opaque result must
// not take the mouse for B (Codex saw B receive for 210 ms). A result applies only near the point it was read for.
test('round 031: a result read for an earlier point does not take the mouse for where the pointer is now', async () => {
  const r = rig({ alpha: EMPTY });
  r.manual();
  r.controller.start(); await settle(); r.requests.length = 0;
  r.controller.move(100, 100, 0); await settle();
  await r.advance(25);
  r.controller.move(300, 300, 0); await settle();
  await r.advance(35);
  r.answer(SOLID); await settle();
  assert.deepEqual(r.requests, [], 'A was her, but the pointer is at B now');
  assert.equal(r.probes.length, 2, 'B is read at once instead');
  assert.deepEqual(r.probes[1], { x: 300, y: 300 });
  r.answer(EMPTY); await r.advance(500);
  assert.deepEqual(r.requests, [], 'B is empty: the click goes through');
  // A small move (within the read block) still counts: moving slowly onto her takes the mouse at once.
  const near = rig({ alpha: SOLID });
  near.manual();
  near.controller.start(); await settle(); near.requests.length = 0;
  near.controller.move(100, 100, 0); await settle();
  near.controller.move(102, 101, 0); await settle();
  near.answer(SOLID); await settle();
  assert.deepEqual(near.requests, [true]);
});
