// I-190 and the toolbar foundation pass:
// the companion toolbar's ▾ source menus (open, mark the one in use, a pick only chooses, Esc and folding close them), the camera panel's
// source section, a switch that waits for the host showing it is busy, and the tooltip that a mouse click no longer brings back.
// docs/claude/2026-11-22-i190-source-pickers.md.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { installPetWindow, type FakeElement } from './helpers/pet-window-dom'; // no-pet-ok: the existing helper's names
import { PetUI, renderPet } from '../src/stage/PetUI'; // no-pet-ok: the existing file and class names
import type { RuntimeState } from '../shared/foundation/runtime-state';
import type { ToolbarSourceKind } from '../src/stage/toolbar-sources';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const MIC = 'pet-voice-input', MIC_CARET = 'pet-voice-input-sources', SCREEN_CARET = 'pet-screen-sharing-sources'; // no-pet-ok: existing element ids
const runtime = (patch: Partial<RuntimeState> = {}): RuntimeState => ({ voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null, ...patch });

function companion(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // no-pet-ok: the existing helper's and host calls' names
  const dom = installPetWindow(t, { openControls: async () => {}, updatePetReply: async () => undefined, setPetWindowOperation: async () => undefined });
  renderPet(dom.app as unknown as HTMLElement); // no-pet-ok: the existing function name
  const calls: unknown[] = [];
  let answer: (() => void) | null = null;
  const ui = new PetUI({ // no-pet-ok: the existing class name
    edit: value => calls.push(['edit', value]),
    feature: feature => { calls.push(['feature', feature]); return new Promise<void>(resolve => { answer = resolve; }); },
    camera: async patch => { calls.push(['camera', patch]); return runtime(); },
    systemAudio: () => calls.push('audio'), watchTogether: () => calls.push('watch'),
    popups: { 'screen-sharing-options': { isOpen: () => false, close() {} }, 'mood-companion': { isOpen: () => false, close() {} } },
    send: () => calls.push('send'), stop: () => calls.push('stop'), error: message => { throw Error(message); },
  });
  dom.beforeClose(() => ui.dispose());
  const chosen: Array<[ToolbarSourceKind, string]> = [];
  let current = 'default';
  const listeners = new Set<() => void>();
  const ports = {
    menu: async (kind: ToolbarSourceKind) => ({ kind, title: kind === 'camera' ? '用哪个摄像头' : '用哪个麦克风', items: [
      { id: 'default', label: '跟着系统默认', checked: current === 'default' }, { id: 'name:USB Mic', label: 'USB Mic', checked: current === 'name:USB Mic', own: true }] }),
    choose: async (kind: ToolbarSourceKind, id: string) => { chosen.push([kind, id]); current = id; for (const l of listeners) l(); },
    onChange: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
  return { ...dom, ui, calls, chosen, ports, answer: () => answer?.() };
}

test('the ▾ menus: disabled until the lists arrive, open with the one in use checked, a pick only chooses, Esc closes and gives focus back', async t => {
  const c = companion(t);
  const caret = c.byId(MIC_CARET);
  assert.equal(caret.disabled, true, 'no lists yet: the ▾ cannot open an empty menu');
  c.ui.setSources(c.ports);
  assert.equal(caret.disabled, false);
  assert.equal(c.byId(SCREEN_CARET).disabled, false);
  caret.click(); await flush();
  const popup = c.document.querySelector('.source-popup')!;
  assert.ok(popup, 'the menu opened'); assert.equal(caret.getAttribute('aria-expanded'), 'true');
  const items = popup.querySelectorAll('.source-list-item');
  assert.deepEqual(items.map(item => [item.textContent, item.getAttribute('role'), item.getAttribute('aria-checked')]),
    [['跟着系统默认', 'menuitemradio', 'true'], ['USB Mic', 'menuitemradio', 'false']]);
  assert.equal(c.document.activeElement, items[0], 'focus lands on the one in use (keyboard users start there)');
  items[1].click(); await flush();
  assert.deepEqual(c.chosen, [['microphone', 'name:USB Mic']]);
  assert.equal(c.document.querySelector('.source-popup'), null, 'a pick closes the menu');
  assert.equal(c.document.activeElement, caret, 'focus goes back to the ▾');
  assert.deepEqual(c.calls, [], 'choosing a source never touched a switch (no feature, no camera request)');
  caret.click(); await flush();
  const again = c.document.querySelector('.source-popup')!;
  assert.equal(again.querySelector('.source-list-item[aria-checked="true"]')?.textContent, 'USB Mic', 'the new choice is the one checked');
  again.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  assert.equal(c.document.querySelector('.source-popup'), null); assert.equal(caret.getAttribute('aria-expanded'), 'false');
  caret.click(); await flush();
  c.byId('pet-toolbar-toggle').click(); // no-pet-ok: an existing element id
  assert.equal(c.document.querySelector('.source-popup'), null, 'folding the toolbar closes the menu too (I-028)');
});

test('the camera panel shows which camera, from the same lists; a pick there never turns a camera switch', async t => {
  const c = companion(t);
  c.ui.setSources(c.ports);
  c.byId('pet-camera-sharing').click(); await flush(); // no-pet-ok: an existing element id
  const section = c.document.querySelector('.camera-sharing-sources')!;
  assert.ok(section, 'the camera panel has its source section');
  const items = section.querySelectorAll('.source-list-item');
  assert.deepEqual(items.map(item => item.textContent), ['跟着系统默认', 'USB Mic']);
  items[1].click(); await flush();
  assert.deepEqual(c.chosen, [['camera', 'name:USB Mic']]);
  assert.deepEqual(c.calls.filter(call => Array.isArray(call) && call[0] === 'camera'), [], 'no camera switch request');
});

test('a switch clicked here shows it is waiting for the host, and stops when the host answers or its state changes', async t => {
  const c = companion(t);
  c.ui.applyRuntime(runtime());
  const button = c.byId(MIC);
  button.click();
  assert.equal(button.dataset.pending, 'true'); assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.match(button.dataset.tooltip ?? '', /正在打开/);
  c.ui.applyRuntime(runtime({ voiceInput: true }));
  assert.equal(button.dataset.pending, undefined, 'the host said it is on: not busy');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.dataset.tooltip ?? '', /已开启/);
  button.click(); assert.equal(button.dataset.pending, 'true');
  c.answer(); await flush();
  assert.equal(button.dataset.pending, undefined, 'the request settled (refused, or the same state): not busy');
});

test('a mouse click no longer brings the tooltip straight back; every button renders from the one state', async t => {
  const c = companion(t);
  const tip = c.byId('pet-tooltip'); // no-pet-ok: an existing element id
  const button = c.byId('pet-screen-sharing') as FakeElement; // no-pet-ok: an existing element id
  button.dispatchEvent(new Event('pointerenter'));
  assert.equal(tip.classList.contains('hidden'), false, 'hover shows it');
  button.dispatchEvent(new Event('pointerdown'));
  button.dispatchEvent(new Event('focus')); // the click focuses the button: not keyboard focus
  assert.equal(tip.classList.contains('hidden'), true, 'the click hid it and the mouse focus did not bring it back');
  c.ui.setSystemAudioState({ active: true }, '');
  c.ui.applyRuntime(runtime({ screenSharing: true }));
  assert.equal(c.byId('pet-system-audio-sharing').getAttribute('aria-pressed'), 'true', 'an unrelated update keeps the listening button as it was'); // no-pet-ok: an existing element id
  c.ui.setAudioDanceState(false, '');
  assert.equal(c.byId('pet-system-audio-sharing').getAttribute('aria-pressed'), 'true'); // no-pet-ok: an existing element id
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});
