// I-190 follow-up in the full-screen input box's senses panel: the eye button's look
// (pressed, the "台词没在听" mark and its reason) and its one click from the host side, through the user's own switch paths. While she is
// out the permission bundle holds the screen on, so off stops only the dialogue. docs/claude/2026-11-22-i190-source-pickers.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPetWindow, type FakeElement } from './helpers/pet-window-dom'; // no-pet-ok: the existing helper's names
import { inputWatchTogether } from '../electron/unbound/input-watch';
import { createAudioReadingView } from '../shared/voice/audio-reading-toggles';
import { createSourceChoices, DeviceSources, type WatchTogetherLook } from '../shared/senses';
import { localCallDeviceStorage } from '../shared/voice';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function host(out: boolean) {
  const view = createAudioReadingView('watch-1');
  const state = { screen: false, calls: [] as string[] };
  const watch = inputWatchTogether({
    screen: () => state.screen, view: () => view, screenHeld: () => out,
    setScreen: async on => { state.calls.push(`screen:${on}`); state.screen = on; },
    setDialogue: async on => { state.calls.push(`dialogue:${on}`); view.sources['system-audio'].movie.intent = on; },
  });
  return { state, view, watch };
}

test('the panel\'s 一起看 is the eye button\'s one click: screen and dialogue on together; while she is out, off stops only the dialogue', async () => {
  const out = host(true);
  out.state.screen = true; // the permission bundle holds it while she is out
  let look = await out.watch.toggle();
  assert.deepEqual(out.state.calls, ['dialogue:true'], 'on: the dialogue (the screen is already on), nothing else');
  assert.equal(look.on, true);
  out.state.calls.length = 0;
  look = await out.watch.toggle();
  assert.deepEqual(out.state.calls, ['dialogue:false'], 'off while she is out: only the dialogue stops; the screen is not switched off to be switched back on');
  assert.equal(out.state.screen, true);
  const home = host(false);
  await home.watch.toggle(); home.state.calls.length = 0;
  await home.watch.toggle();
  assert.deepEqual(home.state.calls, ['dialogue:false', 'screen:false'], 'at home: both off, the dialogue first (as the eye button)');
});

test('the look says when she sees the screen but the dialogue does not reach her, with the eye button\'s words', () => {
  const h = host(true);
  h.state.screen = true;
  h.view.sources['system-audio'].movie.intent = true;
  const starting = h.watch.look();
  assert.equal(starting.notHeard, true); assert.match(starting.tooltip, /台词还没听到/);
  h.view.sources['system-audio'].capture = { ...h.view.sources['system-audio'].capture, phase: 'ready' } as never;
  const hearing = h.watch.look();
  assert.equal(hearing.on, true); assert.equal(hearing.notHeard, false);
});

test('the full-screen panel shows 一起看 with the mark and its reason, and a click goes to the host\'s one click', async t => {
  const dom = installPetWindow(t); // no-pet-ok: the existing helper's name
  const { document } = dom;
  const root = document.createElement('section'); root.id = 'panel'; const button = document.createElement('button');
  document.body.append(button, root);
  let look: WatchTogetherLook = { on: false, seeing: true, dialogue: false, hearing: 'off', notHeard: true, tooltip: '和她一起看：只在看画面，台词没在听。点一下也听台词' };
  let clicks = 0;
  const api = { senses: async () => ({ camera: true, microphone: true, screen: true, audio: true }), panel: async () => {},
    screenSourceMenu: async () => ({ choice: null, entries: [] }), chooseScreenSource: async () => ({ choice: null }),
    watchTogether: async () => look,
    toggleWatchTogether: async () => { clicks++; look = { ...look, on: true, dialogue: true, hearing: 'starting', notHeard: true, tooltip: '和她一起看：开着，在看画面；台词还没听到，正在准备…' }; return look; } };
  const storage = localCallDeviceStorage({ getItem: () => null, setItem() {} });
  const { SensesPanel } = await import('../src/unbound/input-senses');
  const panel = new SensesPanel(document as unknown as Document, root as unknown as HTMLElement, button as unknown as HTMLElement, api,
    createSourceChoices(api, new DeviceSources({ enumerate: async () => [], storage, watch: () => () => {}, deviceChange: () => () => {} })));
  dom.beforeClose(() => panel.dispose());
  await panel.show(); await flush();
  const row = root.querySelector('.senses-row[data-sense="watch"]')!;
  assert.ok(row, 'the 一起看 row is there');
  assert.ok(row.querySelector('.senses-mark'), 'the "台词没在听" mark, as on the eye button');
  assert.match(root.querySelector('.senses-reason.not-heard')?.textContent ?? '', /台词没在听/);
  assert.match(root.querySelectorAll('.senses-reason').map(p => p.textContent).join(' '), /这里关掉只停台词/);
  (row.querySelector('[data-action="watch"]') as FakeElement).click(); await flush();
  assert.equal(clicks, 1);
  const after = root.querySelector('.senses-row[data-sense="watch"]')!;
  assert.equal(after.querySelector('[data-action="watch"]')?.getAttribute('aria-pressed'), 'true');
  assert.match(root.querySelector('.senses-reason.not-heard')?.textContent ?? '', /正在准备/);
});
