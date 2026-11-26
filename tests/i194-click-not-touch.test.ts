// I-194:
// in full-screen Unbound a click on her that opens the "对她说" box is wanting to talk, never a touch (no touch record, no reaction, no touch line,
// no mood touch event). A touch is only (1) a click on her while the box is already open, or (2) a press held still on her (inside the stick's dead zone)
// for the hold time. Not a double click, not "nothing typed in 4 s". A press that moves out of the dead zone is the joystick pull (I-196), never a touch.
// The page (pointer-router.ts → click-reporter.ts, pull-input.ts) and the host (electron/unbound/typing.ts) with fake ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { PressJudge, STICK_KNOBS } from '../shared/unbound/pull-stick';
import { parseUnboundTouch, type UnboundTouchReport } from '../shared/unbound/typing';
import { clampFollowDepth, parsePullAnswer, type UnboundPullMessage } from '../shared/unbound/pull';
import { ClickReporter } from '../src/unbound/click-reporter';
import { routePointer } from '../src/unbound/pointer-router';
import { UnboundPull, type StagePullHit, type UnboundPullFigure } from '../src/unbound/pull-input';
import { UNITS_PER_M } from '../src/unbound/figure';
import { UnboundTyping, type InputBoxPort, type TypingPorts } from '../electron/unbound/typing';
import type { UnboundState } from '../shared/unbound/scene';
import type { Rect } from '../shared/unbound/world';

const K = STICK_KNOBS;
const answer = parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// ---- the judge: the dead zone and the time ----------------------------------------------------------------------------------------

test('one press is a click, a touch or a pull, by the dead zone and the time only', () => {
  const quick = new PressJudge(); quick.down(100, 100, 0);
  assert.equal(quick.tick(K.holdTouchMs - 1), null); assert.equal(quick.up(), 'click', 'released inside the dead zone before the hold time');
  const held = new PressJudge(); held.down(100, 100, 0);
  assert.equal(held.move(100 + K.deadZonePx, 100), 'pending', 'shaking inside the dead zone changes nothing');
  assert.equal(held.tick(K.holdTouchMs), 'touch'); assert.equal(held.tick(K.holdTouchMs + 100), null, 'a touch once');
  assert.equal(held.move(300, 300), 'touched', 'after a touch, moving on does not turn it into a pull'); assert.equal(held.up(), 'touched');
  const pulled = new PressJudge(); pulled.down(100, 100, 0);
  assert.equal(pulled.move(100 + K.deadZonePx + 1, 100), 'started'); assert.equal(pulled.move(400, 400), 'stick');
  assert.equal(pulled.tick(60_000), null, 'a pull is never also a touch, however long it is held');
  assert.equal(pulled.up(), 'stick');
  const idle = new PressJudge(); assert.equal(idle.up(), 'none'); idle.down(NaN, 1, 0); assert.equal(idle.phase, 'idle');
});

// ---- the page: pointer events through the router ----------------------------------------------------------------------------------

function page() {
  const reports: UnboundTouchReport[] = [], messages: UnboundPullMessage[] = [];
  let clock = 0, holds = 0;
  const root = { x: 0, z: -8 };
  const figure: UnboundPullFigure = {
    pullHit: () => ({ part: 'torso', side: null, group: 'torso', heightPx: 400 } as StagePullHit), pullStart: () => true, pullTo: () => {}, pullEnd: () => {},
    setPullStance: () => {}, pullShownM: () => ({ x: 0, z: 0 }), rootM: root, followTo: () => {}, setStance: () => {}, heightM: 1.5, get report() { return { steps: 0 }; },
  };
  const cam = new PerspectiveCamera(30, 1.6, 0.05 * UNITS_PER_M, 100 * UNITS_PER_M); cam.position.set(0, 1.25 * UNITS_PER_M, 0.55 * UNITS_PER_M); cam.updateMatrixWorld(true);
  const clicks = new ClickReporter({ nearest: () => ({ bone: undefined, distance: 0 }), names: () => [], head: () => ({ x: 600, y: 300, r: 60 }), eligible: () => true, send: r => reports.push(r), clock: () => clock });
  const pulls = new UnboundPull({
    figure: () => figure, view: () => ({ camera: cam, width: 1600, height: 1000 }), eligible: () => true,
    send: async m => { messages.push(m); return m.phase === 'start' ? answer : undefined; }, clampX: x => x, clampDepth: d => clampFollowDepth(d, null), clock: () => clock,
    holdTouch: () => { holds++; clicks.hold(); },
  });
  const parts = { clicks, pulls, pagePress: (run: () => void) => run(), pressTaken: () => {} };
  const event = (type: string, x: number, y: number, button = 0) => routePointer({ type, button, clientX: x, clientY: y, target: null } as unknown as MouseEvent, parts);
  return {
    reports, messages, holds: () => holds,
    down: (x = 500, y = 400) => event('mousedown', x, y), move: (x: number, y: number) => event('mousemove', x, y), up: (x = 500, y = 400) => event('mouseup', x, y),
    menu: () => event('mousedown', 500, 400, 2),
    /** Time passes in frames of 50 ms. */
    wait: async (ms: number) => { for (let t = 0; t < ms; t += 50) { clock += 50; pulls.frame(); await flush(); } },
    at: (ms: number) => { clock = ms; },
  };
}

test('a quick click on her reports once and opens the box (no hold flag): that is chatting, the host does not take it as a touch', async () => {
  const p = page();
  p.at(1000); p.down(); await p.wait(100); p.up();
  assert.equal(p.reports.length, 1); assert.equal(p.reports[0].hold, undefined); assert.equal(p.holds(), 0);
  assert.equal(p.messages.length, 0, 'and no pull');
});

test('a press held still on her for the hold time is one touch (flagged hold); releasing it afterwards reports nothing more', async () => {
  const p = page();
  p.down(); await p.wait(K.holdTouchMs - 50); assert.equal(p.reports.length, 0, 'not yet');
  await p.wait(150);
  assert.equal(p.reports.length, 1); assert.equal(p.reports[0].hold, true); assert.equal(p.holds(), 1);
  await p.wait(2000); p.up();
  assert.equal(p.reports.length, 1, 'a touch once; the release is not a click');
  assert.equal(p.messages.length, 0, 'and not a pull');
});

test('shaking inside the dead zone while holding is still a hold; a click with a shaky hand is still a click', async () => {
  const p = page();
  p.down(); p.move(504, 403); await p.wait(300); p.move(497, 398); await p.wait(300);
  assert.equal(p.reports.length, 1); assert.equal(p.reports[0].hold, true);
  p.up();
  const q = page();
  q.at(0); q.down(); await q.wait(100); q.move(503, 404); await q.wait(100); q.up(503, 404);
  assert.equal(q.reports.length, 1); assert.equal(q.reports[0].hold, undefined);
});

test('a press that moves out of the dead zone is a pull and never a touch: no hold, no click, however long it is held, and the report is the stick\'s', async () => {
  const p = page();
  p.down(); await p.wait(100); p.move(500, 400 + K.deadZonePx + 20); await p.wait(3000); p.up(500, 428);
  assert.equal(p.reports.length, 0, 'no touch report at all');
  assert.equal(p.holds(), 0);
  assert.equal(p.messages[0].phase, 'start');
  const ends = p.messages.filter(m => m.phase === 'report') as Extract<UnboundPullMessage, { phase: 'report' }>[];
  assert.ok(ends.length >= 1 && ends.every(m => m.stick === true));
});

test('a touch already made is the press\'s: moving on afterwards does not start a pull', async () => {
  const p = page();
  p.down(); await p.wait(K.holdTouchMs + 100);
  p.move(500, 600); await p.wait(500); p.up(500, 600);
  assert.equal(p.reports.length, 1);
  assert.equal(p.messages.length, 0, 'the host is never asked for a pull');
});

test('a double click is a click and nothing else: the first opens the box, the second is not reported (no touch by itself)', async () => {
  const p = page();
  p.at(2000); p.down(); await p.wait(50); p.up();
  await p.wait(100); p.down(); await p.wait(50); p.up();
  assert.equal(p.reports.length, 1); assert.equal(p.reports[0].hold, undefined);
});

test('a right click on her is the senses panel, not a touch', () => {
  const p = page(); p.menu();
  assert.equal(p.reports.length, 1); assert.equal(p.reports[0].menu, true); assert.equal(p.reports[0].hold, undefined);
});

// ---- the host: what a report does ----------------------------------------------------------------------------------------------------

function host() {
  const touches: unknown[] = [], opened: Rect[] = [];
  let state: UnboundState = 'unbound', open = false;
  const input: InputBoxPort = { open: rect => { opened.push(rect); open = true; }, close: () => { open = false; }, destroy: () => {}, isOpen: () => open };
  const ports: TypingPorts = {
    touch: value => { touches.push(value); return true; }, say: () => 'sent', shortcut: { register: () => true, unregister: () => {} },
    input, state: () => state, window: () => ({ x: 0, y: 0, width: 1536, height: 912 }), askHead: () => Promise.resolve(null), said: () => {}, clock: () => 7,
  };
  return { typing: new UnboundTyping(ports), touches, opened, close: () => { open = false; }, set state(value: UnboundState) { state = value; } };
}
const report = (extra: Partial<UnboundTouchReport> = {}): UnboundTouchReport => ({ part: 'torso', side: null, head: { x: 600, y: 300, r: 60 }, ...extra });

test('host: a click that opens the box is never a touch; a click while the box is open is; closing the box makes the next click a chat again', () => {
  const h = host();
  h.typing.click(report());
  assert.deepEqual(h.touches, [], 'no touch record, so no reaction, no touch line and no mood touch event can follow');
  assert.equal(h.opened.length, 1, 'and the box opens');
  h.typing.click(report());
  assert.equal(h.touches.length, 1, 'the box is open: this click is touching her');
  assert.deepEqual(h.touches[0], { kind: 'click', part: 'torso', side: null, where: 'unbound', at: 7 });
  h.close(); h.typing.click(report());
  assert.equal(h.touches.length, 1, 'the box was closed: a chat click again');
  assert.equal(h.opened.length, 3);
});

test('host: a press held still is a touch even with the box closed, and does not open the box; with the box open it does not move it either', () => {
  const h = host();
  h.typing.click(report({ hold: true }));
  assert.equal(h.touches.length, 1); assert.equal(h.opened.length, 0);
  h.typing.click(report()); // opens the box
  h.typing.click(report({ hold: true }));
  assert.equal(h.touches.length, 2); assert.equal(h.opened.length, 1);
});

test('host: the senses panel click is no touch; nothing counts unless she is out', () => {
  const h = host();
  h.typing.click(report({ menu: true }));
  assert.equal(h.touches.length, 0); assert.equal(h.opened.length, 1);
  const away = host(); away.state = 'normal'; away.typing.click(report({ hold: true }));
  assert.deepEqual([away.touches.length, away.opened.length], [0, 0]);
});

test('the report is parsed strictly: hold is a plain true and not with menu', () => {
  const head = { x: 1, y: 2, r: 3 };
  assert.deepEqual(parseUnboundTouch({ part: 'torso', side: null, head, hold: true }), { part: 'torso', side: null, head, hold: true });
  assert.deepEqual(parseUnboundTouch({ part: 'torso', side: null, head }), { part: 'torso', side: null, head });
  for (const bad of [{ hold: 'yes' }, { hold: false }, { hold: 1 }, { hold: true, menu: true }]) assert.equal(parseUnboundTouch({ part: 'torso', side: null, head, ...bad }), null, JSON.stringify(bad));
});
