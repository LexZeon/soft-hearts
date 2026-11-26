// Unbound U1: the Unbound window's whole API is a whitelist (electron/unbound/preload-api.ts): six members, fixed `unbound:`
// channels, plain values; no general invoke/send, and listeners never see the IPC event (its sender and ports).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UNBOUND_API_KEYS, createUnboundApi, type UnboundIpc } from '../electron/unbound/preload-api';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS } from '../shared/unbound/scene';
import { unboundWindowOptions, UNBOUND_PRELOAD } from '../electron/unbound/window-options';

function fakeIpc() {
  const invoked: [string, unknown[]][] = [];
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
  const ipc: UnboundIpc = {
    invoke: async (channel, ...args) => { invoked.push([channel, args]); return { channel }; },
    on: (channel, listener) => { (listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)!).add(listener); },
    removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
  };
  const emit = (channel: string, value: unknown) => { for (const listener of listeners.get(channel) ?? []) listener({ sender: 'the IPC event', ports: [] }, value); };
  return { ipc, invoked, listeners, emit };
}

test('exactly the whitelist, frozen', () => {
  const api = createUnboundApi(fakeIpc().ipc);
  assert.deepEqual(Object.keys(api).sort(), [...UNBOUND_API_KEYS].sort());
  assert.ok(Object.isFrozen(api));
  for (const forbidden of ['invoke', 'send', 'on', 'ipcRenderer', 'require', 'process'])
    assert.equal((api as unknown as Record<string, unknown>)[forbidden], undefined, forbidden);
});

test('requests go only to the fixed unbound: channels, with checked arguments', async () => {
  const { ipc, invoked } = fakeIpc();
  const api = createUnboundApi(ipc);
  await api.getScene();
  await api.ready({ ok: true, modelHeightM: 1.6 });
  await api.setInteractive(true);
  await api.report({ toggles: 1, roundTripMs: null, fps: 60, hitTestMs: null });
  await assert.rejects(api.setInteractive('yes' as unknown as boolean), TypeError);
  await assert.rejects(api.setInteractive(1 as unknown as boolean), TypeError);
  assert.deepEqual(invoked.map(([channel]) => channel), [UNBOUND_REQUESTS.getScene, UNBOUND_REQUESTS.ready, UNBOUND_REQUESTS.interactive, UNBOUND_REQUESTS.stats]);
  assert.deepEqual(invoked[2][1], [true]);
  for (const channel of [...Object.values(UNBOUND_REQUESTS), ...Object.values(UNBOUND_EVENTS)]) assert.match(channel, /^unbound:[a-z-]+$/);
});

test('events carry the value only, and unsubscribe', () => {
  const { ipc, emit, listeners } = fakeIpc();
  const api = createUnboundApi(ipc);
  const seen: unknown[][] = [];
  const off = api.onBubble((...args: unknown[]) => seen.push(args));
  api.onScene((...args: unknown[]) => seen.push(['scene', ...args]));
  emit(UNBOUND_EVENTS.bubble, { id: 'r', type: 'delta', text: '嗯' });
  assert.deepEqual(seen, [[{ id: 'r', type: 'delta', text: '嗯' }]], 'no IPC event object reaches the page');
  off();
  emit(UNBOUND_EVENTS.bubble, { id: 'r', type: 'done', text: '' });
  assert.equal(seen.length, 1);
  assert.equal(listeners.get(UNBOUND_EVENTS.bubble)?.size, 0);
  assert.throws(() => api.onScene(undefined as unknown as () => void), TypeError);
});

test('the preload exposes nothing else, and the window is sandboxed, isolated and Node-free', () => {
  const preload = readFileSync(new URL('../electron/unbound/preload.ts', import.meta.url), 'utf8').replace(/^\/\/.*$/gm, '');
  assert.equal((preload.match(/exposeInMainWorld\(/g) ?? []).length, 1);
  assert.match(preload, /exposeInMainWorld\('unbound', createUnboundApi\(ipcRenderer\)\)/);
  const options = unboundWindowOptions({ x: 0, y: 0, width: 1536, height: 912 }, `C:/app/dist-electron/${UNBOUND_PRELOAD}`);
  assert.deepEqual({ ...options.webPreferences, preload: undefined }, { preload: undefined, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true, spellcheck: false });
  assert.equal(options.focusable, false, 'clicking her never takes focus from the user\'s window');
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.transparent, true);
  assert.equal(options.frame, false);
  assert.equal(options.show, false);
  const build = readFileSync(new URL('../scripts/build-electron.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes(`"${UNBOUND_PRELOAD.replace('.cjs', '')}": "electron/unbound/preload.ts"`), 'the build writes the preload the window loads');
});
