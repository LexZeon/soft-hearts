// the mouse is caught only by her drawn body and by
// what is visible. docs/claude/2026-11-25-click-through-tight.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { colourShows, elementPaints, paintedAt, type PaintStyle, type PaintView } from '../src/stage/hit-paint';
import { classifyPetPoint, type HitDocument } from '../src/stage/pointer-passthrough'; // no-pet-ok: existing function name
import { COARSE_MARGIN_PX, FigureCatch, figureTarget } from '../src/unbound/catch-region';
import { InteractiveToggle } from '../shared/unbound/hit-test';
import type { StageAlpha } from '../src/stage/pixel-probe';

const CLEAR: PaintStyle = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', boxShadow: 'none',
  borderTopWidth: '0px', borderTopStyle: 'none', borderLeftWidth: '0px', borderLeftStyle: 'none', borderBottomWidth: '0px', borderBottomStyle: 'none', borderRightWidth: '0px', borderRightStyle: 'none' };
interface Fake { tagName: string; id: string; parentElement: Fake | null; childNodes: { nodeType: number; textContent: string }[]; style: Partial<PaintStyle>; visible: boolean; checkVisibility(): boolean }
const el = (tagName: string, style: Partial<PaintStyle> = {}, parent: Fake | null = null, text = ''): Fake =>
  ({ tagName, id: '', parentElement: parent, childNodes: text ? [{ nodeType: 3, textContent: text }] : [], style, visible: true, checkVisibility() { return this.visible; } });
const view: PaintView = { getComputedStyle: (e: Element) => ({ ...CLEAR, ...(e as unknown as Fake).style }) };
const as = (e: Fake) => e as unknown as Element;

test('paint: a transparent box draws nothing; a background, a border, own text, a button each draw', () => {
  assert.equal(elementPaints(as(el('DIV')), view), false, 'the chat container around its form');
  assert.equal(elementPaints(as(el('DIV', { backgroundColor: 'rgba(21, 34, 44, 0.95)' })), view), true);
  assert.equal(elementPaints(as(el('DIV', { backgroundColor: 'rgba(21, 34, 44, 0)' })), view), false, 'alpha 0 is transparent');
  assert.equal(elementPaints(as(el('DIV', { borderTopWidth: '1px', borderTopStyle: 'solid' })), view), true);
  assert.equal(elementPaints(as(el('DIV', { boxShadow: '0 5px 18px rgba(0,0,0,.3)' })), view), true);
  assert.equal(elementPaints(as(el('P', {}, null, 'hello')), view), true, 'its own words');
  assert.equal(elementPaints(as(el('P', {}, null, '   ')), view), false, 'blank text is nothing');
  assert.equal(elementPaints(as(el('BUTTON')), view), true);
  assert.equal(elementPaints(as(el('TEXTAREA', { backgroundColor: 'transparent' })), view), true, 'the input box has a form around it, and is a control itself');
  assert.equal(elementPaints(as(el('DIV')), null), true, 'style unknown: stays a control (no regression)');
  assert.equal(colourShows('transparent'), false);
  assert.equal(colourShows('rgb(1, 2, 3)'), true);
  assert.equal(colourShows('rgba(1, 2, 3, 0.5)'), true);
});

test('paint: a path inside an icon inside a button counts through its ancestor; page roots never do', () => {
  const root = el('DIV'); root.id = 'app';
  const panel = el('DIV', { backgroundColor: 'rgba(20, 30, 40, 0.9)' }, root);
  const gap = el('DIV', {}, panel);
  const button = el('BUTTON', {}, root);
  const path = el('path', {}, el('svg', {}, button));
  const isRoot = (e: Element) => (e as unknown as Fake) === root;
  assert.equal(paintedAt(as(gap), view, isRoot), true, 'a gap inside a visible panel is part of the panel');
  assert.equal(paintedAt(as(path), view, isRoot), true);
  const bare = el('DIV', {}, root);
  assert.equal(paintedAt(as(bare), view, isRoot), false);
  root.style = { backgroundColor: 'rgb(255, 255, 255)' };
  assert.equal(paintedAt(as(bare), view, isRoot), false, 'the root is not a thing she shows');
});

test('classify (small window): a hidden control and a transparent container are the stage; visible ones are ui', () => {
  const stageRoot = { contains: (n: unknown) => n === canvas, id: 'stage' } as unknown as Element;
  const canvas = el('CANVAS');
  const html = { id: '' } as Element, body = { id: '' } as Element;
  const chat = el('DIV'); // .pet-chat is-visible: pointer-events auto, drawn nothing of its own // no-pet-ok: CSS class name
  const form = el('FORM', { backgroundColor: 'rgba(21, 34, 44, 0.95)' }, chat);
  const hidden = el('BUTTON'); hidden.visible = false;
  let under: Fake | null = chat;
  const doc: HitDocument = { elementFromPoint: () => under as unknown as Element | null, documentElement: html, body, defaultView: { innerWidth: 400, innerHeight: 560, ...view } };
  const at = (e: Fake | null) => { under = e; return classifyPetPoint(doc, 10, 10, stageRoot); }; // no-pet-ok: existing function name
  assert.equal(at(chat), 'stage', 'the blank box around the chat form lets her pixels (or the desktop) decide');
  assert.equal(at(form), 'ui', 'the input box');
  assert.equal(at(el('BUTTON', {}, chat)), 'ui', 'a visible button');
  assert.equal(at(hidden), 'stage', 'hidden UI stops catching');
});

test('figure target: a control of hers is ui; near her is a question for the frame; far is nothing', () => {
  assert.equal(figureTarget(500, 0), 'ui');
  assert.equal(figureTarget(0, Infinity), 'stage');
  assert.equal(figureTarget(COARSE_MARGIN_PX, Infinity), 'stage');
  assert.equal(figureTarget(COARSE_MARGIN_PX + 1, Infinity), 'outside');
  assert.equal(figureTarget(Infinity, Infinity), 'outside');
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const live: FigureCatch[] = [];
test.afterEach(() => { for (const region of live.splice(0)) region.dispose(); });
function rig(options: { alpha: StageAlpha | null; body?: number; other?: number }) {
  const toggle = new InteractiveToggle(() => {});
  const pointer = { inside: true, buttons: 0 };
  const state = { alpha: options.alpha, body: options.body ?? 0, other: options.other ?? Infinity, probes: 0 };
  const region = new FigureCatch({ toggle, pointer, available: () => true,
    bodyDistance: () => state.body, otherDistance: () => state.other,
    probe: async () => { state.probes++; return state.alpha; } });
  live.push(region);
  return { toggle, pointer, state, region };
}
const SOLID: StageAlpha = { inner: 255, outer: 255 }, EMPTY: StageAlpha = { inner: 0, outer: 0 };

test('figure catch: inside her fat capsule but on empty pixels does not catch (bounding shape is not her silhouette)', async () => {
  const r = rig({ alpha: EMPTY, body: -30 });
  r.region.move(100, 100, 0); await sleep(30);
  assert.equal(r.state.probes >= 1, true, 'the frame was asked');
  assert.equal(r.toggle.interactive, false);
});

test('figure catch: on her drawn pixels catches; clicking, head pat, hands, pull all start from this catch', async () => {
  const r = rig({ alpha: SOLID, body: -5 });
  r.region.move(100, 100, 0); await sleep(30);
  assert.equal(r.toggle.interactive, true);
});

test('figure catch: far from every capsule nothing is read and nothing is caught', async () => {
  const r = rig({ alpha: SOLID, body: 400 });
  r.region.move(100, 100, 0); await sleep(30);
  assert.equal(r.state.probes, 0, 'no per-move GPU read away from her');
  assert.equal(r.toggle.interactive, false);
});

test('figure catch: her light or a game control takes the mouse directly, whatever the frame says', async () => {
  const r = rig({ alpha: EMPTY, body: 400, other: -2 });
  r.region.move(100, 100, 0); await sleep(10);
  assert.equal(r.toggle.interactive, true);
  assert.equal(r.state.probes, 0);
});

test('figure catch: a press held after catching keeps her (pull) even over empty pixels; letting go and leaving frees the mouse', async () => {
  const r = rig({ alpha: SOLID, body: -5 });
  r.region.move(100, 100, 0); await sleep(30);
  assert.equal(r.toggle.interactive, true);
  r.state.alpha = EMPTY; r.state.body = 90; r.pointer.buttons = 1;
  r.region.move(300, 300, 1); await sleep(300);
  assert.equal(r.toggle.interactive, true, 'a drag started on her stays hers');
  r.pointer.buttons = 0; r.pointer.inside = false; r.region.reset(); await sleep(10);
  assert.equal(r.toggle.interactive, false);
});

test('figure catch: when she walks off from under a still pointer the mouse is given back', async () => {
  const r = rig({ alpha: SOLID, body: -5 });
  r.region.move(100, 100, 0); await sleep(30);
  assert.equal(r.toggle.interactive, true);
  r.state.alpha = EMPTY;
  await sleep(700);
  r.region.refresh(); await sleep(300);
  assert.equal(r.toggle.interactive, false);
});
