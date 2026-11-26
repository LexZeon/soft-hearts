/**
 * The pointer never vanishes in the companion window (2026-11-15, docs/claude/2026-11-15-pet-cursor-scrollbars.md): the hands target hides
 * the system cursor only while the emoji hint is shown at the pointer, and both come back together when the pointer leaves the
 * target or her window, the window loses focus, or the reach ends; the target and the emoji stay inside the window; the root of the
 * companion page never scrolls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HandsOverlay, clampBox, type HandsOverlayStage } from '../src/initiative/HandsOverlay';
import { clampInto } from '../src/mood/PetInteractionCursor';
import { NEUTRAL_HAND_STYLE } from '../shared/behaviors/hands/knobs';
import type { HandReachState } from '../src/initiative/hand-reach';

class FakeElement {
  className = ''; hidden = false; textContent = ''; type = ''; title = '';
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: FakeElement[] = [];
  listeners: Record<string, ((event: any) => void)[]> = {};
  onclick: (() => void) | null = null; onpointerenter: ((event: any) => void) | null = null; onpointerleave: (() => void) | null = null;
  clientWidth = 400; clientHeight = 560;
  ownerDocument: { defaultView: FakeElement } | undefined;
  setAttribute() {}
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  addEventListener(type: string, listener: (event: any) => void) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners[type] = (this.listeners[type] ?? []).filter(l => l !== listener); }
  dispatch(type: string, event: any = {}) { for (const l of this.listeners[type] ?? []) l(event); }
  remove() {}
}

function harness() {
  const shown: string[] = [], frames: (() => void)[] = [];
  let listener: ((event: any) => void) | null = null, now = 0;
  const state: HandReachState = { active: true, phase: 'out', use: 'hold', presence: 1, arrived: true, far: false, reachRatio: 1, arm: true, fingers: 15, side: 'right' };
  const stage: HandsOverlayStage = {
    startHands: () => true, handsCommand: () => {}, handsAnchor: () => ({ x: 380, y: 540, r: 150 }), handsState: () => ({ ...state }), handsNear: () => false,
    handInput: { touch() {}, takeTouch: () => false, read: () => null },
  };
  const parent = new FakeElement(), view = new FakeElement();
  parent.ownerDocument = { defaultView: view };
  const overlay = new HandsOverlay(parent as unknown as HTMLElement, {
    onHands: callback => { listener = callback; return () => {}; }, handsAnswer: async () => true, handsRequest: async () => true,
  }, stage, { now: () => now, random: () => 0, frame: callback => { frames.push(callback); return frames.length; }, cancelFrame: () => {},
    document: { createElement: () => new FakeElement() as unknown as HTMLElement }, restEveryMs: 0,
    cursor: { show: (_x, _y, emoji) => { shown.push(emoji); }, hide: () => { shown.push('-'); } } });
  overlay.init();
  const target = parent.children[0];
  const step = () => { frames.shift()?.(); };
  listener!({ type: 'offer', id: 'hands-1', use: 'hold', why: [], waitMs: 30_000, style: NEUTRAL_HAND_STYLE });
  step(); now = 800; step();
  return { overlay, parent, view, target, shown, step, frames, state, done: () => { state.active = false; now += 100_000; step(); step(); } };
}

test('the target covers her hand only inside the window; its box never reaches past the edges', () => {
  const h = harness();
  assert.equal(h.target.hidden, false);
  const right = Number.parseInt(h.target.style.left) + Number.parseInt(h.target.style.width), bottom = Number.parseInt(h.target.style.top) + Number.parseInt(h.target.style.height);
  assert.ok(right <= 400 && bottom <= 560, `target ends at ${right}x${bottom}`);
  assert.deepEqual(clampBox({ x: -10, y: 5, r: 30 }, 400, 560), { left: 0, top: 0, width: 20, height: 35 });
  assert.deepEqual(clampBox({ x: 10, y: 10, r: 5 }, Number.NaN, 0), { left: 5, top: 5, width: 10, height: 10 }, 'unknown window size: as is');
  h.overlay.dispose();
});

test('the system cursor is hidden over the target only while the emoji is shown, and comes back when the pointer leaves', () => {
  const h = harness();
  assert.equal(h.target.style.cursor ?? '', '', 'idle target: the normal pointer');
  h.target.onpointerenter!({ clientX: 300, clientY: 400 }); // enters at once (no frame needed)
  assert.equal(h.shown.at(-1), '🫱'); assert.equal(h.target.style.cursor, 'none');
  h.parent.dispatch('pointermove', { clientX: 310, clientY: 410 });
  assert.equal(h.shown.at(-1), '🫱');
  h.target.onpointerleave!();
  assert.equal(h.shown.at(-1), '-'); assert.equal(h.target.style.cursor, '');
  h.overlay.dispose();
});

test('the pointer comes back when the pointer leaves her window, the window loses focus, or the reach ends', () => {
  for (const how of ['pointerleave', 'blur', 'end'] as const) {
    const h = harness();
    h.target.onpointerenter!({ clientX: 300, clientY: 400 });
    assert.equal(h.target.style.cursor, 'none', how);
    if (how === 'pointerleave') h.parent.dispatch('pointerleave');
    else if (how === 'blur') h.view.dispatch('blur');
    else h.done();
    assert.equal(h.target.style.cursor, '', `${how}: cursor restored`);
    assert.equal(h.shown.at(-1), '-', `${how}: emoji hidden`);
    h.overlay.dispose();
  }
});

test('the emoji is kept inside the window, so a hidden system cursor is never replaced by something out of sight', () => {
  assert.equal(clampInto(-15, 400, 36), 0);
  assert.equal(clampInto(395, 400, 36), 364);
  assert.equal(clampInto(100, 400, 36), 100);
  assert.equal(clampInto(-15, undefined, 36), -15, 'no window size known: unchanged');
});

test('the pet page root is clipped, so it can never show scrollbars', () => {
  const css = readFileSync(new URL('../src/settings/style.css', import.meta.url), 'utf8');
  assert.match(css, /html\.pet-root,\s*body\.pet-mode\s*\{\s*overflow:\s*hidden;/u);
});
