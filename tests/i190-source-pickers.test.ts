// I-190:
// the source menus (what each offers, the one in use checked, "跟着系统默认" first), the one store both windows and the Unbound input box
// read, the host's screen choice, and the rules that guard them: choosing a source never turns a sense on; device names never leave the
// window; a missing device falls back to the default. docs/claude/2026-11-22-i190-source-pickers.md.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { installPetWindow, type FakeElement } from './helpers/pet-window-dom'; // no-pet-ok: the existing helper's names
import { FOLLOW_DEFAULT, chooseSource, deviceMenu, promote, screenMenu, systemAudioMenu, parseScreenSourceId, DeviceSources, createSourceChoices, type DeviceSourcePorts } from '../shared/senses';
import { localCallDeviceStorage, type DeviceInfo } from '../shared/voice';
import { ScreenSourceChoice } from '../electron/senses/screen-source';
import { screenCaptures } from '../electron/senses/screen-capture';
import { placePopup } from '../src/foundation/source-menu';
import { parseUnboundTouch } from '../shared/unbound/typing';
import { ClickReporter } from '../src/unbound/click-reporter';
import { UnboundTyping } from '../electron/unbound/typing';
import { INPUT_PANEL_SIZE } from '../shared/unbound/typing';
import { MicrophoneInput } from '../src/senses/MicrophoneInput';

// ---- fakes
class MemoryStorage { readonly data = new Map<string, string>(); getItem(key: string) { return this.data.get(key) ?? null; } setItem(key: string, value: string) { this.data.set(key, value); } }
const mic = (name: string, id = name): DeviceInfo => ({ kind: 'audioinput', deviceId: id, groupId: '', label: name });
const cam = (name: string, id = name): DeviceInfo => ({ kind: 'videoinput', deviceId: id, groupId: '', label: name });
/** Two windows on one profile: one storage, `storage` events go to the other window only (as browsers do). */
function profile() {
  const storage = new MemoryStorage();
  const watchers = new Set<{ window: number; callback: () => void }>();
  let plugged: DeviceInfo[] = [mic('Default - Array Mic', 'default'), mic('Array Mic'), mic('艾乐的 AirPods Pro', 'pods'), cam('Integrated Camera'), cam('USB Camera')];
  const windowPorts = (window: number, labels = true): DeviceSourcePorts => {
    const base = localCallDeviceStorage(storage);
    return {
      enumerate: async () => plugged.map(d => labels ? d : { ...d, label: '', deviceId: '' }),
      storage: { load: () => base.load(), save: state => { base.save(state); for (const w of watchers) if (w.window !== window) w.callback(); } },
      watch: callback => { const entry = { window, callback }; watchers.add(entry); return () => { watchers.delete(entry); }; },
      deviceChange: () => () => {},
    };
  };
  return { storage, windowPorts, plug: (next: DeviceInfo[]) => { plugged = next; } };
}

test('device menus: "跟着系统默认" first, the names plugged in now, the one in use checked; a missing device falls back to the default', () => {
  const menu = deviceMenu('microphone', ['Desk Mic', 'AirPods Pro'], ['Array Mic', 'AirPods Pro'], true);
  assert.deepEqual(menu.items.map(item => [item.label, item.checked]), [['跟着系统默认', false], ['Array Mic', false], ['AirPods Pro', true]]);
  assert.equal(menu.items[0].id, FOLLOW_DEFAULT);
  assert.ok(menu.items.slice(1).every(item => item.own), 'device names are shown as the user\'s own text');
  const gone = deviceMenu('microphone', ['Desk Mic'], ['Array Mic'], true);
  assert.equal(gone.items.find(item => item.checked)?.id, FOLLOW_DEFAULT, 'nothing in the list plugged in: the default is in use');
  assert.match(deviceMenu('camera', [], [], false).note ?? '', /开过一次摄像头后/);
  assert.match(deviceMenu('camera', [], ['USB Camera'], true).note ?? '', /姿势识别/, 'the camera menu says honestly that posture sensing keeps the default');
  assert.deepEqual(promote(['A', 'B', 'C'], 'C'), ['C', 'A', 'B']);
  assert.deepEqual(promote(['A', 'B'], null), [], '"跟着系统默认" empties the list (the default, as before)');
  const audio = systemAudioMenu();
  assert.deepEqual(audio.items.map(item => [item.label, item.checked]), [['电脑的全部声音', true]]);
  assert.match(audio.note ?? '', /选不了单个程序/, 'Electron 45 on Windows: only the whole system loopback, said honestly');
});

test('one store for both windows: a choice in one window reorders the shared 「说」 list, the other window hears it and reads it', async () => {
  const p = profile();
  const companion = new DeviceSources(p.windowPorts(1)), control = new DeviceSources(p.windowPorts(2));
  let heard = 0; control.onChange(() => heard++);
  const before = await companion.menu('microphone');
  assert.deepEqual(before.items.map(item => item.label), ['跟着系统默认', 'Array Mic', 'AirPods Pro'], 'the owner name is stripped, the "Default" alias is not repeated');
  heard = 0; // reading wrote down the names plugged in (the other window heard that too)
  companion.choose('microphone', 'AirPods Pro');
  assert.equal(heard, 1, 'the other window was told');
  assert.deepEqual(control.order('microphone'), ['AirPods Pro'], 'the other window reads the same list');
  assert.equal((await control.menu('microphone')).items.find(item => item.checked)?.label, 'AirPods Pro');
  companion.choose('camera', 'USB Camera');
  assert.equal(await control.cameraDeviceId(), 'USB Camera', 'the camera list lives in the same place; the chosen camera is opened');
  p.plug([mic('Array Mic'), cam('Integrated Camera')]);
  assert.equal(await control.cameraDeviceId(), null, 'the chosen camera unplugged: the system default');
  companion.choose('microphone', null);
  assert.deepEqual(control.order('microphone'), [], '跟着系统默认');
});

test('the Unbound input box cannot read device names: it lists the names the companion window last saw plugged in', async () => {
  const p = profile();
  const companion = new DeviceSources(p.windowPorts(1)), box = new DeviceSources(p.windowPorts(3, false));
  assert.deepEqual((await box.menu('microphone')).items.map(item => item.label), ['跟着系统默认'], 'nothing seen yet');
  await companion.read();
  assert.deepEqual((await box.menu('microphone')).items.map(item => item.label), ['跟着系统默认', 'Array Mic', 'AirPods Pro']);
  box.choose('microphone', 'Array Mic');
  assert.deepEqual(companion.order('microphone'), ['Array Mic'], 'a choice in the box reaches the companion window\'s list');
  const stored = p.storage.getItem('softhearts.callDevices.v1') ?? '';
  assert.doesNotMatch(stored, /艾乐/, 'owner names are never stored');
  assert.doesNotMatch(stored, /"pods"|deviceId/, 'no device ids are stored');
});

test('a choice never turns a sense on, and device names never leave the window (only the screen\'s opaque id goes to the host)', async () => {
  const sent: unknown[] = [], switches: unknown[] = [];
  const api = {
    screenSourceMenu: async () => ({ choice: null, entries: [{ id: 'screen:1:0', kind: 'screen' as const, label: '' }, { id: 'window:42:0', kind: 'window' as const, label: '记事本' }] }),
    chooseScreenSource: async (id: string | null) => { sent.push(id); return { choice: id }; },
    setRuntimeState: async (patch: unknown) => { switches.push(patch); return {}; },
  };
  const p = profile();
  const choices = createSourceChoices(api, new DeviceSources(p.windowPorts(1)));
  await choices.choose('microphone', 'name:AirPods Pro');
  await choices.choose('camera', 'name:USB Camera');
  await choices.choose('screen', 'window:42:0');
  await choices.choose('screen', FOLLOW_DEFAULT);
  await choices.choose('systemAudio', 'loopback');
  assert.deepEqual(sent, ['window:42:0', null], 'only opaque screen ids (or null) went to the host');
  assert.deepEqual(switches, [], 'no switch was touched by any choice');
  // The dispatcher itself: a device id is never routed to the host; a made-up screen id is dropped.
  const routed: unknown[] = [];
  await chooseSource('microphone', 'name:艾乐的 AirPods', { screen: async id => { routed.push(id); }, device() {} });
  await chooseSource('screen', 'AirPods', { screen: async id => { routed.push(id); }, device() {} });
  assert.deepEqual(routed, []);
  const menu = screenMenu(await api.screenSourceMenu());
  assert.deepEqual(menu.items.map(item => [item.label, item.number ?? null, item.checked]), [['跟着系统默认', null, true], ['屏幕', 1, false], ['记事本', null, false]]);
});

/** desktopCapturer as the host sees it: screens and windows, ids, names, thumbnails (empty for a minimized window). */
function fakeCapturer(sources: Array<{ id: string; name: string; display_id?: string; empty?: boolean }>) {
  const asked: unknown[] = [];
  return {
    asked,
    sources,
    getSources: async (options: { types: string[] }) => {
      asked.push(options.types);
      return sources.filter(s => options.types.includes(s.id.split(':')[0])).map(s => ({ id: s.id, name: s.name, display_id: s.display_id ?? '', appIcon: null,
        thumbnail: { isEmpty: () => !!s.empty, getSize: () => ({ width: 320, height: 200 }), resize: () => null, toJPEG: () => Buffer.from('jpg') } })) as never;
    },
  };
}

test('the host\'s screen choice: listed ids only, never our own windows, never a switch; a window that closed goes back to the default and says so', async () => {
  const capturer = fakeCapturer([{ id: 'screen:1:0', name: 'Screen 1', display_id: '11' }, { id: 'screen:2:0', name: 'Screen 2', display_id: '22' },
    { id: 'window:7:0', name: 'soft hearts' }, { id: 'window:42:0', name: '记事本' }]);
  const told: unknown[] = [];
  const media = { state: { screenSharing: false } };
  const choice = new ScreenSourceChoice({ capturer, ownWindows: () => ['window:7:0'], changed: view => told.push(view) });
  assert.throws(() => choice.choose('window:42:0'), /重新点开/, 'an id not listed yet is refused');
  const menu = await choice.menu();
  assert.deepEqual(menu.entries.map(entry => entry.id), ['screen:1:0', 'screen:2:0', 'window:42:0'], 'our own window is never offered');
  assert.throws(() => choice.choose('艾乐的 AirPods'), /格式/, 'a name is not an id');
  assert.equal(parseScreenSourceId('window:42:0'), 'window:42:0');
  choice.choose('window:42:0');
  assert.deepEqual(told, [{ choice: 'window:42:0' }]);
  assert.equal(media.state.screenSharing, false, 'choosing did not turn sharing on');
  const picked = await choice.source('11', { width: 320, height: 200 });
  assert.equal(picked?.id, 'window:42:0', 'reads use the chosen window');
  capturer.sources.splice(3, 1); // the window closed
  const fallback = await choice.source('11', { width: 320, height: 200 });
  assert.equal(fallback?.id, 'screen:1:0', 'back to the screen she is on');
  assert.equal(choice.current, null);
  assert.match(String((told.at(-1) as { note?: string }).note), /不在了/);
  choice.choose(null);
});

test('every read of the shared screen goes through the choice; a chosen window that gives no picture gives nothing, never the whole screen', async () => {
  const capturer = fakeCapturer([{ id: 'screen:1:0', name: 'Screen 1', display_id: '11' }, { id: 'window:42:0', name: '记事本', empty: true }]);
  const choice = new ScreenSourceChoice({ capturer, ownWindows: () => [], changed() {} });
  await choice.menu(); choice.choose('window:42:0');
  const media = { state: { screenSharing: true }, openings: { screen: 1 } };
  const captures = screenCaptures({ media: media as never, companion: () => ({}) as never, onScreen: () => true, capturer, displayOf: () => ({ id: 11 }),
    visualSelf: () => ({ runtime: { beginCapture: () => null, completeCapture() {} }, sourceId: null }), intervalSeconds: () => 10, pick: (id, size) => choice.source(id, size) });
  assert.equal(await captures.glance(new AbortController().signal), null, 'the minimized window: no picture');
  await assert.rejects(captures.shared('11', new AbortController().signal), /unavailable/);
  choice.choose(null);
  assert.match(String(await captures.glance(new AbortController().signal)), /^data:image\/jpeg/, 'the default: the screen she is on, as before');
});

test('the popup stays inside the window near its edges', () => {
  const view = { width: 400, height: 560 };
  const low = placePopup({ left: 360, top: 520, bottom: 549, width: 13 }, { width: 240, height: 200 }, view);
  assert.ok(low.top + Math.min(200, low.maxHeight) <= 560 - 6 + 0.5 && low.top >= 6, 'near the bottom it opens upward');
  assert.ok(low.left + 240 <= 400 - 6 && low.left >= 6, 'near the right edge it is pulled in');
  const tiny = placePopup({ left: 10, top: 7, bottom: 36, width: 13 }, { width: 240, height: 900 }, { width: 260, height: 300 });
  assert.ok(tiny.maxHeight <= 300 - 36 && tiny.left >= 6 && tiny.left + 240 <= 260 - 6, 'a tall list scrolls inside the room it has');
});

test('a microphone already open moves to a new choice without a new grant or an acknowledgement; a closed one is not opened', async (t: TestContext) => {
  const opened: Array<string | null> = [], stopped: string[] = [], acks: unknown[] = [];
  const track = (id: string) => ({ id, stop: () => stopped.push(id), addEventListener() {}, removeEventListener() {} });
  const stream = (id: string) => ({ getTracks: () => [track(id)], getAudioTracks: () => [track(id)] });
  const nodes: string[] = [];
  const context = { state: 'running', sampleRate: 48000, destination: {}, resume: async () => {}, close: async () => {},
    createMediaStreamSource: (s: { getTracks(): Array<{ id: string }> }) => { const id = s.getTracks()[0].id; return { id, connect: (n: { name: string }) => nodes.push(`${id}->${n.name}`), disconnect: () => nodes.push(`${id} off`) }; },
    createScriptProcessor: () => ({ name: 'processor', connect() {}, disconnect() {}, onaudioprocess: null }), createGain: () => ({ name: 'gain', gain: { value: 1 }, connect() {}, disconnect() {} }) };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async (c: { audio: { deviceId?: { exact: string } } }) => { const id = c.audio.deviceId?.exact ?? 'default'; opened.push(id); return stream(id); } } } });
  (globalThis as { AudioContext?: unknown }).AudioContext = function () { return context; };
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'navigator', saved); delete (globalThis as { AudioContext?: unknown }).AudioContext; });
  let chosen: string | null = null;
  // no-pet-ok: the existing owner word
  const input = new MicrophoneInput({ owner: 'pet', acknowledge: async value => { acks.push(value); return true; }, onPcm() {}, onError: message => { throw Error(message); },
    micChoice: async () => ({ deviceId: chosen, labelsKnown: true }) });
  assert.equal(await input.reselect(), false, 'closed: nothing opens');
  assert.deepEqual(opened, []);
  // no-pet-ok: the existing owner word
  await input.apply({ id: 'm1', revision: 1, source: 'microphone', owner: 'pet', chat: true, ambient: false, dance: false } as never);
  assert.deepEqual(opened, ['default']);
  const acksBefore = acks.length;
  chosen = 'usb-mic';
  assert.equal(await input.reselect(), true);
  assert.deepEqual(opened, ['default', 'usb-mic']);
  assert.deepEqual(stopped, ['default'], 'the old stream is stopped after the new one feeds the same consumers');
  assert.ok(nodes.includes('usb-mic->processor'), 'chat\'s processor now hears the chosen microphone');
  assert.equal(acks.length, acksBefore, 'no acknowledgement: the host\'s capture did not change');
  assert.equal(await input.reselect(), false, 'the same choice again changes nothing');
  await input.dispose();
});

test('Unbound: a right click on her opens the input box with the senses panel, and is not a touch', () => {
  assert.deepEqual(parseUnboundTouch({ part: 'head', side: null, head: null, menu: true }), { part: 'head', side: null, head: null, menu: true });
  assert.equal(parseUnboundTouch({ part: 'head', side: null, head: null, menu: 'yes' }), null, 'strict');
  const sent: unknown[] = [];
  const reporter = new ClickReporter({ nearest: () => ({ bone: undefined, distance: 0 }), names: () => [], head: () => ({ x: 100, y: 80, r: 30 }), eligible: () => true, send: report => sent.push(report), clock: () => 0 });
  assert.equal(reporter.menu(100, 200), true);
  assert.deepEqual(sent, [{ part: 'other', side: null, head: { x: 100, y: 80, r: 30 }, menu: true }]);
  const offHer = new ClickReporter({ nearest: () => ({ bone: undefined, distance: 40 }), names: () => [], head: () => null, eligible: () => true, send: report => (sent as unknown[]).push(report), clock: () => 0 });
  assert.equal(offHer.menu(5, 5), false, 'beside her: nothing');
  const touches: unknown[] = [], opens: unknown[][] = [];
  const typing = new UnboundTyping({ touch: value => { touches.push(value); return true; }, say: () => 'sent', shortcut: { register: () => true, unregister() {} },
    input: { open: (...args: unknown[]) => { opens.push(args); }, close() {}, destroy() {} }, state: () => 'unbound', window: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    askHead: async () => null, said() {}, clock: () => 0 });
  typing.click(sent[0] as never);
  assert.deepEqual(touches, [], 'no touch is reported for a right click');
  assert.equal(opens.length, 1); assert.equal(opens[0][1], true, 'opened with the panel');
  assert.equal((opens[0][0] as { height: number }).height, INPUT_PANEL_SIZE.height, 'placed at the taller size');
});

test('Unbound senses panel: opens from its button and from a right click, mirrors the senses and shares the toolbar\'s store', async t => {
  const dom = installPetWindow(t); // no-pet-ok: the existing helper's name
  const { document } = dom;
  const root = document.createElement('section'); root.id = 'panel'; const button = document.createElement('button'); button.id = 'senses';
  document.body.append(button, root);
  const p = profile();
  await new DeviceSources(p.windowPorts(1)).read(); // the companion window wrote down what is plugged in
  const sizes: boolean[] = [], switches: unknown[] = [];
  let senses = { camera: true, microphone: true, screen: false, audio: true };
  const api = { senses: async () => senses, panel: async (open: boolean) => { sizes.push(open); },
    screenSourceMenu: async () => ({ choice: null, entries: [] }), chooseScreenSource: async () => ({ choice: null }), setRuntimeState: async (x: unknown) => { switches.push(x); } };
  const { SensesPanel } = await import('../src/unbound/input-senses');
  const panel = new SensesPanel(document as unknown as Document, root as unknown as HTMLElement, button as unknown as HTMLElement, api,
    createSourceChoices(api, new DeviceSources(p.windowPorts(3, false))));
  dom.beforeClose(() => panel.dispose());
  (button as FakeElement).click(); await flush();
  assert.equal(panel.isOpen, true); assert.deepEqual(sizes, [true], 'the box grows before the panel shows');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const rows = root.querySelectorAll('.senses-row');
  assert.deepEqual(rows.map(row => [row.dataset.sense, row.querySelector('.senses-state')?.textContent]), [['microphone', '开着'], ['camera', '开着'], ['screen', '关着'], ['audio', '开着']]);
  assert.match(root.querySelector('.senses-note')?.textContent ?? '', /一直开着/, 'out here there is no switch; the line says how to turn one off');
  (root.querySelector('.senses-pick[data-kind="microphone"]') as FakeElement).click(); await flush();
  const items = root.querySelectorAll('.senses-list[data-kind="microphone"] .source-list-item');
  assert.deepEqual(items.map(item => [item.textContent, item.getAttribute('aria-checked')]), [['跟着系统默认', 'true'], ['Array Mic', 'false'], ['AirPods Pro', 'false']]);
  items[2].click(); await flush();
  assert.deepEqual(new DeviceSources(p.windowPorts(1)).order('microphone'), ['AirPods Pro'], 'the toolbar\'s store has the choice');
  assert.deepEqual(switches, [], 'the panel never touched a switch');
  senses = { ...senses, screen: true };
  await panel.refresh();
  assert.equal(root.querySelector('.senses-row[data-sense="screen"] .senses-state')?.textContent, '开着', 'a sense turned on elsewhere shows');
  await panel.close();
  assert.deepEqual(sizes, [true, false]); assert.equal(root.hidden, true);
  await panel.show(); // what the host's "open the panel" (a right click) does
  assert.equal(panel.isOpen, true);
});

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
