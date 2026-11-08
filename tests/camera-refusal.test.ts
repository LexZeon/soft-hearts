// 2026-11-03, stable build: "摄像头共享无法打开" — the pet's camera button seemed to do nothing. In the packaged app
// the pose host was up; the refusal (component not downloaded) only showed in the control window, only the first
// time, and the pet said nothing. These keep every refused click visible where it happened, and keep the privacy rule:
// no pose host never means "send camera pictures with each message" again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaRuntime } from '../electron/runtime';
import { buildPoseSensing, poseCameraPolicy, type CameraGateHost } from '../electron/pose/camera-gate';
import { PoseSensingHost } from '../electron/pose/host';
import type { PoseComponentStore } from '../electron/pose/component-store';
import { parsePoseView, samePoseView, type PoseSensingView } from '../shared/pose-signals';
import type { RuntimeState } from '../shared/contracts';
import { cameraRefusalAction, NOTICE_ACTIONS, type NoticeAction } from '../src/notice-policy';
import { PoseSensingPanel, type PoseSensingPorts } from '../src/ui/PoseSensingPanel';
import { setUiLanguage, uiText } from '../src/ui/ui-language';

function hostWith(store: { installed: boolean; working: boolean } | null) {
  const prompts: string[] = [], published: PoseSensingView[] = [];
  const host = new PoseSensingHost({
    store: store && { get installed() { return store.installed; }, get working() { return store.working; }, downloadBytes: 85_171_644, installedBytes: 0,
      refresh: async () => store.installed } as unknown as PoseComponentStore,
    fork: () => { throw new Error('nothing is forked here'); }, channel: () => ({ worker: 1, sensor: 2 }),
    openSensor: () => { throw new Error('no camera window here'); }, fingerprint: async () => 'gpu',
    publish: view => published.push(view), disableCamera: () => {}, promptRaised: owner => prompts.push(owner),
    trayChanged: () => {}, developerMode: () => false, setTimer: () => 0, clearTimer: () => {},
  });
  return { host, prompts, published };
}

test('a refused camera request tells the window that asked why; the stored and broadcast state never carry it', () => {
  const broadcasts: RuntimeState[] = [];
  const media = new MediaRuntime(state => broadcasts.push(state), { mode: () => 'blocked', blocked: () => 'needs-component' });
  const reply = media.update({ cameraSharing: true }, 'pet');
  assert.equal(reply.cameraSharing, false);
  assert.equal(reply.cameraRefused, 'needs-component');
  assert.equal('cameraRefused' in media.state, false);
  assert.deepEqual(broadcasts, [], 'nothing changed, nothing is broadcast');
  // Mixed patch: the other switch still applies, the camera part is refused and explained.
  const mixed = media.update({ cameraSharing: true, voiceInput: true }, 'controls');
  assert.equal(mixed.voiceInput, true);
  assert.equal(mixed.cameraSharing, false);
  assert.equal(mixed.cameraRefused, 'needs-component');
  assert.equal(broadcasts.length, 1);
  assert.equal('cameraRefused' in broadcasts[0], false);
  assert.equal('cameraRefused' in media.state, false);
  // Turning things off or a camera that is allowed never carries a refusal.
  assert.equal('cameraRefused' in media.update({ voiceInput: false }, 'controls'), false);
  const open = new MediaRuntime(undefined, { mode: () => 'local' });
  assert.equal('cameraRefused' in open.update({ cameraSharing: true }, 'pet'), false);
});

test('no pose host (it could not be built): the camera is refused as unavailable, never shared per message', () => {
  const media = new MediaRuntime(undefined, poseCameraPolicy(() => null));
  const reply = media.update({ cameraSharing: true }, 'pet');
  assert.equal(reply.cameraRefused, 'unavailable');
  assert.equal(media.state.cameraSharing, false);
  assert.equal(media.sharesCameraFrames(), false);
  assert.equal(media.allowsMedia('pet', 'video'), false, 'the pet may not open the camera stream either');
  // A policy that forgets to answer is treated the same way.
  assert.equal(new MediaRuntime(undefined, { mode: () => 'blocked' }).update({ cameraSharing: true }, 'controls').cameraRefused, 'unavailable');
});

test('building the pose host never takes the app down; a failure leaves it null and is reported', () => {
  const reported: unknown[] = [];
  assert.equal(buildPoseSensing(() => { throw new TypeError('powerMonitor is not ready'); }, error => reported.push(error)), null);
  assert.equal(reported.length, 1);
  const host: CameraGateHost = { cameraMode: () => 'local', cameraBlocked: () => 'needs-component' };
  assert.equal(buildPoseSensing(() => host, () => assert.fail('no failure')), host);
});

test('component missing: every refused click raises the question again and says so; still downloading says that', () => {
  const store = { installed: false, working: false };
  const r = hostWith(store);
  const media = new MediaRuntime(undefined, poseCameraPolicy(() => r.host));
  assert.equal(media.update({ cameraSharing: true }, 'pet').cameraRefused, 'needs-component');
  const first = r.published.at(-1)!;
  assert.equal(first.prompt, true);
  assert.equal(first.asked, 1);
  // Second click from the pet (the control window is already on another page): published again, raised again.
  assert.equal(media.update({ cameraSharing: true }, 'pet').cameraRefused, 'needs-component');
  assert.equal(r.published.at(-1)!.asked, 2);
  assert.equal(samePoseView(first, r.published.at(-1)!), false);
  assert.deepEqual(r.prompts, ['pet', 'pet']);
  store.working = true;
  assert.equal(media.update({ cameraSharing: true }, 'controls').cameraRefused, 'preparing');
  assert.equal(media.state.cameraSharing, false);
  // The renderer guard accepts the counter and nothing else new.
  assert.equal(parsePoseView(r.published.at(-1))?.asked, 3);
  assert.equal(parsePoseView({ ...r.published.at(-1), asked: -1 }), null);
  assert.equal(parsePoseView({ ...r.published.at(-1), asked: 'x' }), null);
  // Platforms without a component never count (the old sharing applies there).
  assert.equal('asked' in hostWith(null).host.view(), false);
});

test('each refusal has one fixed line, short enough for the toast, in plain words and in English', () => {
  for (const [reply, action] of [[{ cameraRefused: 'needs-component' }, 'camera-needs-component'], [{ cameraRefused: 'preparing' }, 'camera-preparing'],
    [{ cameraRefused: 'unavailable' }, 'camera-unavailable']] as const)
    assert.equal(cameraRefusalAction(reply), action);
  for (const value of [null, undefined, {}, { cameraRefused: 'share' }, { cameraRefused: '<b>x</b>' }, 'needs-component'])
    assert.equal(cameraRefusalAction(value), null);
  const camera = Object.keys(NOTICE_ACTIONS).filter(key => key.startsWith('camera-')) as NoticeAction[];
  assert.equal(camera.length, 3);
  try {
    for (const language of ['zh-CN', 'en'] as const) {
      setUiLanguage(language);
      for (const action of camera) {
        const text = uiText(NOTICE_ACTIONS[action]);
        assert.ok(text.length > 10 && text.length <= 160, `${language} ${action}: the toast only takes up to 160 characters (${text.length})`);
        assert.ok(!/DirectML|onnx|DLL|error|pose|utility/i.test(text), 'no technical words');
        if (language === 'en') assert.ok(!/[一-鿿]/.test(text), `${action} has English copy`);
      }
    }
    setUiLanguage('zh-CN');
    assert.match(uiText(NOTICE_ACTIONS['camera-needs-component']), /下载/);
    // I-036: 「发图片」 is the user's own switch; a refused 「姿势识别」 says it does not turn that on instead.
    assert.match(uiText(NOTICE_ACTIONS['camera-unavailable']), /不会自动改成发图片/, 'says the picture is not sent instead');
    assert.match(uiText(NOTICE_ACTIONS['camera-needs-component']), /「发图片」不用下载/);
  } finally { setUiLanguage('zh-CN'); }
});

// ------------------------------------------------------------------ control-window panel (minimal fake DOM)
class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = ''; disabled = false; hidden = false; open = false;
  onclick: (() => void) | null = null; scrolled = 0;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = [...children]; }
  addEventListener() {}
  querySelector() { return null; }
  scrollIntoView() { this.scrolled++; }
}

test('control panel: a new refused request brings the question into view again, not only the first time', async () => {
  (globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
  setUiLanguage('zh-CN');
  const base: PoseSensingView = { phase: 'not-installed', prompt: false, downloadBytes: 85_171_644, installedBytes: 0, progress: null, route: null, level: null, componentVersion: 1, notice: '' };
  let push: (view: PoseSensingView) => void = () => {};
  let reveals = 0;
  const ports: PoseSensingPorts = {
    get: async () => base, changed: callback => { push = callback; return () => {}; },
    download: async () => base, cancel: async () => {}, dismiss: async () => base, importFiles: async () => base,
    remove: async () => base, redetect: async () => base, diagnostics: async () => ({}), reveal: () => { reveals++; }, error: () => {},
  };
  const root = new Element('div');
  new PoseSensingPanel(root as unknown as HTMLElement, ports);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reveals, 0, 'opening the page does not jump anywhere');
  push({ ...base, prompt: true, asked: 1 });
  assert.equal(reveals, 1);
  push({ ...base, prompt: true, asked: 1 }); // the same view again (e.g. another window's broadcast)
  assert.equal(reveals, 1);
  push({ ...base, prompt: true, asked: 2 }); // second click from the pet while the control window shows the chat page
  assert.equal(reveals, 2, 'the second refused click shows the question again');
  push({ ...base, phase: 'downloading', progress: 0.3, prompt: true, asked: 3 });
  assert.equal(reveals, 3, 'while downloading, a refused click shows the progress line');
  assert.equal(root.scrolled, 3);
});
