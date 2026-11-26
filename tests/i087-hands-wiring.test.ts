/**
 * I-087 牵手、拉钩、击掌, wiring: the companion window's overlay (fake DOM: the offer starts the stage, the target follows her hand, the pat's
 * emoji hint over her hand and while holding, a click is the touch, interruptions, the resting mouse asks the host once), the cue claim
 * ('hands' hides the cue from the renderer), 我们的小东西's first hold (words, the give host's record), the plan memory's recent ids.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HandsOverlay, type HandsOverlayStage } from '../src/initiative/HandsOverlay';
import type { HandsAnswer, HandsEvent } from '../shared/behaviors/hands/interface';
import { HANDS_KNOBS, NEUTRAL_HAND_STYLE } from '../shared/behaviors/hands/knobs';
import type { HandsStageCommand } from '../shared/behaviors/hands/session';
import type { HandReachState } from '../src/initiative/hand-reach';
import { claimedView } from '../electron/initiative/inner-loop/claim';
import { ourThing, ourThingView, ourThingsText } from '../shared/initiative/our-things';
import { ourThingWords } from '../src/memory/OurThingsPanel';
import { GiveHost } from '../electron/initiative/give/host';
import { UpcomingStore } from '../electron/memory/upcoming/store';
import { ProfileUpcomingBook } from '../electron/memory/upcoming/book';

class FakeElement {
  className = ''; hidden = false; textContent = ''; type = ''; title = '';
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: FakeElement[] = []; attributes: Record<string, string> = {};
  listeners: Record<string, ((event: any) => void)[]> = {};
  onclick: (() => void) | null = null; onpointerenter: ((event: any) => void) | null = null; onpointerleave: (() => void) | null = null;
  removed = false;
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  addEventListener(type: string, listener: (event: any) => void) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners[type] = (this.listeners[type] ?? []).filter(l => l !== listener); }
  dispatch(type: string, event: any) { for (const l of this.listeners[type] ?? []) l(event); }
  remove() { this.removed = true; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function overlayHarness() {
  const answers: HandsAnswer[] = [], requests: unknown[] = [], commands: HandsStageCommand[] = [], started: unknown[] = [], shown: string[] = [];
  let listener: ((event: HandsEvent) => void) | null = null, touches = 0, now = 0, blocked = false, startOk = true, near = true;
  let reading: { x: number; y: number } | null = { x: -0.3, y: -0.1 };
  const state: HandReachState = { active: false, phase: 'idle', use: null, presence: 0, arrived: false, far: false, reachRatio: 0, arm: true, fingers: 15, side: 'right' };
  let anchor: { x: number; y: number; r: number } | null = null;
  const stage: HandsOverlayStage = {
    startHands: cue => { if (!startOk) return false; started.push(cue); state.active = true; state.phase = 'reach'; return true; },
    handsCommand: command => { commands.push(command); if (command === 'release') { state.phase = 'back'; } },
    handsAnchor: () => anchor, handsState: () => ({ ...state }), handsNear: () => near,
    handInput: { touch: () => { touches++; }, takeTouch: () => { const t = touches > 0; touches = 0; return t; }, read: () => reading },
  };
  const parent = new FakeElement(), frames: (() => void)[] = [];
  const overlay = new HandsOverlay(parent as unknown as HTMLElement, {
    onHands: callback => { listener = callback; return () => { listener = null; }; },
    handsAnswer: async answer => { answers.push(answer); return true; }, handsRequest: async request => { requests.push(request); return true; },
  }, stage, { blocked: () => blocked, now: () => now, random: () => 0, frame: callback => { frames.push(callback); return frames.length; }, cancelFrame: () => {},
    document: { createElement: () => new FakeElement() as unknown as HTMLElement }, restEveryMs: 0,
    cursor: { show: (_x, _y, emoji) => { shown.push(emoji); }, hide: () => { shown.push('-'); } } });
  overlay.init();
  return { overlay, parent, target: parent.children[0], answers, requests, commands, started, shown, state, frames,
    send: (event: HandsEvent) => listener!(event), set: { now: (n: number) => { now = n; }, blocked: (b: boolean) => { blocked = b; }, startOk: (b: boolean) => { startOk = b; },
      anchor: (a: typeof anchor) => { anchor = a; }, near: (b: boolean) => { near = b; }, reading: (r: typeof reading) => { reading = r; } } };
}
const offer = (extra: Partial<Extract<HandsEvent, { type: 'offer' }>> = {}): HandsEvent => ({ type: 'offer', id: 'hands-1', use: 'hold', why: ['rest'], waitMs: 5000, style: NEUTRAL_HAND_STYLE, ...extra });

test('the hand target draws no focus ring (the mint circle the user saw 2026-11-21); the emoji hint is the only sign', () => {
  const h = overlayHarness();
  assert.equal(h.target.style.outline, 'none');
  assert.equal(h.target.style.border, 'none');
});

test('pet overlay: an offer starts her reach; the target sits on her hand (a pet control, never a pat); the pat’s emoji over her hand; a click holds', async () => {
  const h = overlayHarness();
  h.send(offer());
  assert.equal(h.started.length, 1);
  h.frames.shift()!();
  assert.equal(h.target.hidden, true, 'not out yet: no target');
  h.set.anchor({ x: 120, y: 300, r: 30 }); h.state.arrived = true; h.state.phase = 'out'; h.set.now(800);
  h.frames.shift()!();
  assert.equal(h.target.title, '', 'no hover tooltip on the invisible target: a lone 牵手 popped up');
  assert.equal(h.target.hidden, false); assert.equal(h.target.style.left, '90px'); assert.equal(h.target.dataset.moodUi, 'true');
  assert.equal(h.shown.at(-1), '-', 'not over her hand: no hint');
  h.target.onpointerenter!({ clientX: 125, clientY: 305 });
  h.frames.shift()!();
  assert.equal(h.shown.at(-1), '🫱', 'over her hand: the hint, like the pat’s');
  h.target.onclick!();
  h.set.now(1500); h.frames.shift()!();
  await flush();
  assert.deepEqual(h.commands, ['hold']); assert.deepEqual(h.answers, [{ id: 'hands-1', outcome: 'taken' }]);
  h.target.onpointerleave!();
  h.parent.dispatch('pointermove', { clientX: 200, clientY: 100 });
  h.frames.shift()!();
  assert.equal(h.shown.at(-1), '🤝', 'holding: the hint follows your pointer anywhere in her window');
  h.overlay.interrupt();
  h.frames.shift()!();
  await flush();
  assert.deepEqual(h.commands, ['hold', 'release']); assert.deepEqual(h.answers.at(-1), { id: 'hands-1', outcome: 'interrupted' }, 'a pat: she lets go');
  assert.equal(h.shown.at(-1), '-');
  h.state.active = false; h.frames.shift()!();
  assert.equal(h.frames.length, 0, 'done: the loop stops');
  h.overlay.dispose();
});

test('pet overlay: blocked or no stage → interrupted and nothing starts; the host cancels → back; a click before the reach is not its touch', async () => {
  const h = overlayHarness();
  h.set.blocked(true);
  h.send(offer({ id: 'hands-2' }));
  await flush();
  assert.equal(h.started.length, 0); assert.deepEqual(h.answers, [{ id: 'hands-2', outcome: 'interrupted' }]);
  h.set.blocked(false); h.set.startOk(false);
  h.send(offer({ id: 'hands-3' }));
  await flush();
  assert.deepEqual(h.answers.at(-1), { id: 'hands-3', outcome: 'interrupted' });
  h.set.startOk(true);
  (h.overlay as any).stage.handInput.touch(); // a stray click before
  h.send(offer({ id: 'hands-4', use: 'pinky' }));
  h.frames.shift()!();
  assert.deepEqual(h.commands, [], 'the stray click is not a touch of this reach');
  h.send({ type: 'cancel', id: 'hands-4' });
  await flush();
  assert.deepEqual(h.commands, ['release']); assert.deepEqual(h.answers.at(-1), { id: 'hands-4', outcome: 'interrupted' });
  h.overlay.dispose();
});

test('pet overlay: your mouse resting within her reach asks the host once (after a random 2.5–4.5 s, at most every 40 s); moving resets', async () => {
  const h = overlayHarness();
  const tick = (t: number) => { h.set.now(t); h.overlay.watchRest(); };
  tick(0); tick(1000); tick(HANDS_KNOBS.restAsk.stillMs[0] - 1);
  await flush();
  assert.equal(h.requests.length, 0);
  h.set.reading({ x: 0.1, y: 0 });
  tick(HANDS_KNOBS.restAsk.stillMs[0] + 10);
  tick(HANDS_KNOBS.restAsk.stillMs[0] + 20);
  await flush();
  assert.equal(h.requests.length, 0, 'it moved: the rest starts again');
  tick(2 * HANDS_KNOBS.restAsk.stillMs[0] + 20);
  await flush();
  assert.deepEqual(h.requests, [{ use: 'hold' }]);
  tick(2 * HANDS_KNOBS.restAsk.stillMs[0] + 30); tick(20_000); tick(30_000);
  await flush();
  assert.equal(h.requests.length, 1, 'not again so soon');
  h.set.near(false);
  tick(HANDS_KNOBS.restAsk.everyMs + 50_000); tick(HANDS_KNOBS.restAsk.everyMs + 60_000);
  await flush();
  assert.equal(h.requests.length, 1, 'out of her reach: nothing');
  h.overlay.dispose();
});

test('the cue claim: a cue she took for her hand ("hands") is hidden from the renderer like the inner loop’s', () => {
  const view = { snapshot: { cue: { id: 'c1', kind: 'motion' } }, behavior: null } as any;
  assert.equal(claimedView(view, 'hands').snapshot.cue, null);
  assert.equal(claimedView(view, null).snapshot.cue?.id, 'c1');
});

test('我们的小东西: the first time you held hands — a record with no picture and no words; the page and her folder’s list name it', async () => {
  const thing = ourThing({ id: 'hold-1', at: new Date(2026, 10, 11, 21, 0).getTime(), dir: 'gave', kind: 'first-hold' })!;
  assert.ok(thing);
  assert.deepEqual(ourThingWords(ourThingView(thing), s => s), { who: '你们俩', what: '第一次牵手', how: '', line: '' });
  assert.match(ourThingsText([thing]), /- 我们第一次牵手/u);
  assert.match(ourThingsText([thing], 'en'), /- The first time we held hands/u);
  const added: unknown[] = [];
  const host = new GiveHost({ store: { load: async () => {}, loaded: () => true, list: () => [], ledger: () => null, setLedger: async () => true,
    add: async (_c: string, t: any) => { added.push(t); return t; }, remove: async () => false, mark: async () => false, picture: async () => null } as any,
    enabled: () => true, mood: () => null, user: () => ({ localMinute: 0, tired: false, stillMinutes: null }), specialDay: () => false, send: () => true,
    moment: () => {}, recording: () => true, thumb: () => null });
  assert.equal(await host.keepFirstHold('gene', 5), true);
  assert.equal((added[0] as any).kind, 'first-hold');
});

test('plan memory: the plans noted just now are the ones a pinky promise marks (recent ids, waiting only, the current character)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'i087-plans-'));
  try {
    let now = 1_000_000_000_000;
    const scope = 'a'.repeat(64);
    const store = new UpcomingStore(dir, { recording: () => true, now: () => now } as any);
    let n = 0;
    const book = new ProfileUpcomingBook(store, () => scope, () => now, () => `id-${++n}`);
    await book.add({ from: 'seg-1', items: [{ what: '面试', said: '明天', dueAt: now + 86_400_000 }] });
    now += 5 * 60_000;
    await book.add({ from: 'seg-2', items: [{ what: '交报告', said: '后天', dueAt: now + 2 * 86_400_000 }] });
    assert.deepEqual(book.recentIds(now - 60_000), ['id-2']);
    assert.deepEqual(book.recentIds(0), ['id-1', 'id-2']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
