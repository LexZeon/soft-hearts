import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { MediaRuntime } from '../electron/senses/media-runtime';
import { PoseSensingHost } from '../electron/senses/pose/host';
import type { PoseComponentStore } from '../electron/senses/pose/component-store';
import type { PoseSensingView } from '../shared/senses/pose-signals';
// Reads as text (test-affected selects this test when they change): 'electron/main.ts' (wiring rewrite step 4c: with electron/wiring/*.ts).
import { wiringSource } from './helpers/wiring-source';
import { desktopApiSource } from './helpers/desktop-api-source';

const frame = 'data:image/jpeg;base64,aGVsbG8=';

/** Host with a stand-in component store and inference process; nothing is downloaded or forked for real. */
function hostRig(options: { installed?: boolean; supported?: boolean; developer?: boolean } = {}) {
  const state = { installed: options.installed ?? true, removed: 0, installs: 0, cleared: 0 };
  const store = {
    get installed() { return state.installed; }, working: false, downloadBytes: 170_023_451,
    get installedBytes() { return state.installed ? 132_492_252 : 0; },
    refresh: async () => state.installed,
    runtimePaths: () => state.installed ? { runtimeEntry: 'C:\\L\\soft-hearts-claude\\components\\pose-v1\\win32-arm64\\runtime\\node_modules\\onnxruntime-node',
      detector: 'C:\\L\\d.onnx', pose: 'C:\\L\\p.onnx', detectorSha256: 'a', poseSha256: 'b' } : null,
    readRoute: async () => null, writeRoute: async () => {}, clearRoute: async () => { state.cleared++; },
    install: async (_signal: AbortSignal, progress: (p: { stage: 'downloading'; done: number; total: number }) => void) => { state.installs++; progress({ stage: 'downloading', done: 50, total: 100 }); state.installed = true; },
    importFiles: async (paths: string[]) => ({ accepted: paths.length, rejected: 0, complete: true }),
    remove: async () => { state.removed++; state.installed = false; },
  };
  const forks: { posted: unknown[]; message?: (m: unknown) => void }[] = [];
  const sensors: { closed: boolean }[] = [];
  const published: PoseSensingView[] = [], prompts: string[] = [], trays: boolean[] = [];
  let disables = 0;
  const host = new PoseSensingHost({
    store: options.supported === false ? null : store as unknown as PoseComponentStore,
    fork: () => { const w = { posted: [] as unknown[] } as (typeof forks)[number]; forks.push(w); return { postMessage: m => w.posted.push(m), onMessage: l => { w.message = l; }, onExit: () => {}, kill: () => {} }; },
    channel: () => ({ worker: 1, sensor: 2 }),
    openSensor: () => { const s = { closed: false }; sensors.push(s); return { close: () => { s.closed = true; } }; },
    fingerprint: async () => 'gpu', publish: view => published.push(view), disableCamera: () => { disables++; },
    promptRaised: owner => prompts.push(owner), trayChanged: on => trays.push(on), developerMode: () => options.developer ?? false,
    // Short waits (kill grace, the pause before deleting files) run at once; restart and watchdog timers never fire here.
    setTimer: (run: () => void, ms: number) => { if (ms <= 2_000) run(); return 0; }, clearTimer: () => {},
  });
  const media = new MediaRuntime(undefined, { mode: () => host.cameraMode(), blocked: owner => host.cameraBlocked(owner) });
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return { host, media, store, state, forks, sensors, published, prompts, trays, flush, disables: () => disables };
}

test('component missing: the camera switch stays off and the control window asks once, with the size', () => {
  const r = hostRig({ installed: false });
  assert.equal(r.host.cameraMode(), 'blocked');
  const before = { ...r.media.state };
  assert.deepEqual(r.media.update({ cameraSharing: true }, 'pet'), { ...before, cameraRefused: 'needs-component' }, 'the asking window learns why');
  assert.equal(r.media.state.cameraSharing, false);
  assert.equal(r.media.allowsMedia('pet', 'video'), false);
  assert.deepEqual(r.prompts, ['pet']);
  assert.equal(r.host.view().prompt, true);
  assert.equal(r.host.view().phase, 'not-installed');
  assert.equal(r.host.view().downloadBytes, 170_023_451);
  assert.equal(r.state.installs, 0, 'asking never downloads');
  // Another switch in the same patch still applies.
  const mixed = r.media.update({ cameraSharing: true, voiceInput: true }, 'controls');
  assert.equal(mixed.voiceInput, true);
  assert.equal(mixed.cameraSharing, false, 'the camera part of a mixed patch is still refused');
  assert.equal(mixed.cameraOwner, null);
});

test('local sensing on: no window may take camera frames, chat attaches none, 「拍一张」 still can', () => {
  const r = hostRig();
  const on = r.media.update({ cameraSharing: true }, 'controls');
  assert.equal(on.cameraSharing, true);
  assert.equal(on.cameraLocal, true);
  assert.equal(r.media.sharesCameraFrames(), false);
  assert.equal(r.media.allowsMedia('controls', 'video'), false, 'the owner window does not open the camera stream');
  assert.equal(r.media.allowsMedia('pet', 'video'), false);
  assert.throws(() => r.media.publishCamera('controls', frame), 'no frame can be handed to the host for chat');
  assert.equal(r.media.cameraAttachment(), null);
  assert.equal(r.media.allowsMedia('controls', 'video', true), true, 'the explicit one-shot snapshot keeps working');
  const off = r.media.update({ cameraSharing: false }, 'controls');
  assert.equal('cameraLocal' in off, false);
});

test('platforms without a component keep the old sharing behaviour', () => {
  const r = hostRig({ supported: false });
  assert.equal(r.host.cameraMode(), 'share');
  r.media.update({ cameraSharing: true }, 'pet');
  assert.equal(r.media.state.cameraLocal, undefined);
  assert.equal(r.media.sharesCameraFrames(), true);
  r.media.publishCamera('pet', frame);
  assert.deepEqual(r.media.cameraAttachment(), { source: 'camera', dataUrl: frame });
  assert.equal(r.host.view().phase, 'unsupported');
});

test('switch on starts sensing (tray mark); switch off stops it at once and closes the camera window', async () => {
  const r = hostRig();
  r.host.syncCamera(r.media.update({ cameraSharing: true }, 'controls'));
  await r.flush();
  assert.equal(r.forks.length, 1);
  r.forks[0].message!({ type: 'ready', route: 'cpu', level: 'normal', p90: { dml: null, cpu: 45 }, dmlBad: true });
  assert.equal(r.host.view().phase, 'running');
  assert.equal(r.host.view().route, 'cpu');
  assert.deepEqual(r.trays, [true]);
  assert.equal(r.sensors.length, 1);
  r.host.syncCamera(r.media.update({ cameraSharing: false }, 'controls'));
  assert.equal(r.sensors[0].closed, true);
  assert.equal(r.host.view().phase, 'idle');
  assert.deepEqual(r.trays, [true, false]);
  assert.ok(r.forks[0].posted.some(m => (m as { type: string }).type === 'stop'));
  // Old sharing mode on the same switch never starts local sensing.
  r.host.syncCamera({ voiceInput: false, screenSharing: false, cameraSharing: true, voiceOwner: null, cameraOwner: 'pet' });
  await r.flush();
  assert.equal(r.forks.length, 1);
});

test('download only from the button; delete turns the camera off first; diagnostics only in developer mode', async () => {
  const r = hostRig({ installed: false });
  r.media.update({ cameraSharing: true }, 'controls');
  const done = await r.host.download();
  assert.equal(r.state.installs, 1);
  assert.equal(done.phase, 'idle');
  assert.equal(done.prompt, false);
  assert.equal(r.media.state.cameraSharing, false, 'downloading does not switch the camera on by itself');
  assert.ok(r.published.some(view => view.phase === 'downloading' && view.progress === 0.5));
  r.host.syncCamera(r.media.update({ cameraSharing: true }, 'controls'));
  await r.flush();
  r.forks[0].message!({ type: 'ready', route: 'dml', level: 'normal', p90: { dml: 15, cpu: 45 }, dmlBad: false });
  const removed = await r.host.remove();
  assert.equal(r.disables(), 1);
  assert.equal(r.sensors[0].closed, true);
  assert.equal(r.state.removed, 1);
  assert.equal(removed.phase, 'not-installed');
  assert.equal(removed.notice, 'removed');
  assert.deepEqual(r.host.diagnostics(), {});
  const dev = hostRig({ developer: true });
  dev.host.syncCamera(dev.media.update({ cameraSharing: true }, 'controls'));
  await dev.flush();
  dev.forks[0].message!({ type: 'ready', route: 'dml', level: 'normal', p90: { dml: 15, cpu: 45 }, dmlBad: false });
  dev.forks[0].message!({ type: 'signal', signal: { present: true, confidence: 0.9, facing: 'toward', facingConfidence: 0.9, posture: 'sitting', postureConfidence: 0.9, energy: 0.1, rhythm: false, tempo: null, events: ['stretch'], eventConfidence: { stretch: 0.8 }, hand: null, capability: 'full', face: null, points: [], head: null } });
  assert.deepEqual(dev.host.diagnostics(), { present: 1, stretch: 1 });
  for (const view of [...r.published, ...dev.published]) assert.ok(!JSON.stringify(view).includes('\\'), 'no path in any published state');
});

// ---- The hot files: the camera-frame paths in electron/main.ts go through the local-mode check (AST, no eval).
const mainSource = wiringSource();
const main = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
test('main process: every camera capture path is closed while local sensing owns the camera', () => {
  // Wiring rewrite step 4c: `main` is the whole wiring (electron/main.ts and electron/wiring/*.ts); the function is found at any depth, exactly once.
  const captures: ts.FunctionDeclaration[] = [];
  const find = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'captureSharedCamera') captures.push(node); node.forEachChild(find); };
  find(main);
  assert.equal(captures.length, 1);
  const capture = captures[0];
  assert.ok(capture.body);
  const first = capture.body.statements[0];
  assert.ok(ts.isIfStatement(first) && first.expression.getText(main) === '!media.sharesCameraFrames()'
    && ts.isReturnStatement(first.thenStatement) && first.thenStatement.expression?.getText(main) === 'null', 'the capture itself refuses first');
  const callers: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(main) === 'captureSharedCamera') {
      let guard: ts.Node | undefined = node.parent;
      while (guard && !ts.isIfStatement(guard)) guard = guard.parent;
      callers.push(guard && ts.isIfStatement(guard) ? guard.expression.getText(main) : '');
    }
    node.forEachChild(visit);
  };
  visit(main);
  assert.equal(callers.length, 5, 'per-message attachments, proactive topics, I-040\'s one look (electron/senses/sense-router/), I-085\'s own look (electron/initiative/self-look/) and I-166\'s small frame taken again out in full-screen (electron/wiring/see-and-say-wiring.ts)');
  for (const condition of callers) assert.ok(condition.startsWith('media.sharesCameraFrames()'), condition);
  assert.match(mainSource, /scopedHost\('publishCameraSample'[\s\S]{0,200}!media\.sharesCameraFrames\(\)/);
  // poseCameraPolicy: no pose host ⇒ refused as 'unavailable', never silently shared (tests/camera-refusal.test.ts).
  // (The voice policy of the local speech recognizer, electron/senses/asr/voice-route.ts, follows as the third argument.)
  // (Wiring rewrite step 4c: the switches and the pose host are both made in electron/wiring/senses-wiring.ts.)
  assert.match(mainSource, /new MediaRuntime\(\(\) => syncAudioCapture\(\), poseCameraPolicy\(\(\) => poseSensing\), voiceRoute\.policy\)/,
    'before (or without) the pose host the camera switch is refused, never silently shared');
  assert.match(mainSource, /poseSensing = createPoseSensingOrNull\(/, 'a pose-sensing failure cannot end the whole app');
  assert.match(mainSource, /poseSensing\?\.syncCamera\(next\);/);
});

// ---- Preloads: the companion/control renderer gets enums and counts only; the sensor window exposes nothing.
const preloadSource = readFileSync(new URL('../electron/safety/preload.ts', import.meta.url), 'utf8');
const contractSource = desktopApiSource(); // DesktopAPI across its per-part slices (shared/contracts.ts extends shared/<part>/desktop-api.ts)
const sensorSource = readFileSync(new URL('../electron/senses/pose/sensor-preload.ts', import.meta.url), 'utf8');
test('renderer API: fixed pose channels without arguments; no frame, port or path ever crosses', () => {
  const preload = ts.createSourceFile('preload.ts', preloadSource, ts.ScriptTarget.Latest, true);
  const contracts = ts.createSourceFile('contracts.ts', contractSource, ts.ScriptTarget.Latest, true);
  const expected: Record<string, [string, string]> = {
    getPoseSensing: ['invoke', 'getPoseSensing'], onPoseSensing: ['subscribe', 'desk:pose-sensing'], downloadPoseComponents: ['invoke', 'downloadPoseComponents'],
    cancelPoseDownload: ['invoke', 'cancelPoseDownload'], dismissPosePrompt: ['invoke', 'dismissPosePrompt'], importPoseComponents: ['invoke', 'importPoseComponents'],
    removePoseComponents: ['invoke', 'removePoseComponents'], redetectPoseHardware: ['invoke', 'redetectPoseHardware'], getPoseDiagnostics: ['invoke', 'getPoseDiagnostics'],
  };
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && /Pose/.test(node.name.getText(preload))) {
      const name = node.name.getText(preload);
      found.push(name);
      assert.ok(ts.isArrowFunction(node.initializer) && ts.isCallExpression(node.initializer.body), name);
      const call = node.initializer.body as ts.CallExpression;
      const [helper, channel] = expected[name] ?? [];
      assert.equal(call.expression.getText(preload), helper, name);
      assert.ok(ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === channel, name);
      assert.equal(call.arguments.length, name.startsWith('on') ? 2 : 1, `${name} passes nothing from the renderer`);
    }
    node.forEachChild(visit);
  };
  visit(preload);
  assert.deepEqual(found.sort(), Object.keys(expected).sort());
  let api: ts.InterfaceDeclaration | undefined;
  contracts.forEachChild(node => { if (ts.isInterfaceDeclaration(node) && node.name.text === 'DesktopAPI') api = node; });
  for (const name of Object.keys(expected)) {
    const member = api!.members.find(m => ts.isMethodSignature(m) && m.name.getText(contracts) === name) as ts.MethodSignature;
    assert.ok(member, name);
    assert.equal(member.parameters.length, name.startsWith('on') ? 1 : 0, name);
  }
  assert.ok(!/MessagePort|pose:port|frame/i.test(Object.keys(expected).join()), 'no frame or port API exists');
});

test('sensor window preload: nothing exposed to its page; only the port and three fixed statuses', () => {
  const sensor = ts.createSourceFile('sensor-preload.ts', sensorSource, ts.ScriptTarget.Latest, true);
  assert.ok(!/contextBridge|exposeInMainWorld|window\.\w+\s*=/.test(sensorSource));
  const imports = sensor.statements.filter(ts.isImportDeclaration).map(node => node.getText(sensor));
  assert.deepEqual(imports, ["import { ipcRenderer } from 'electron';"]);
  const sends = [...sensorSource.matchAll(/ipcRenderer\.(\w+)\('([^']+)'/g)].map(m => `${m[1]}:${m[2]}`);
  assert.deepEqual(sends.sort(), ['once:pose:port', 'send:pose:sensor-status']);
  assert.match(sensorSource, /getUserMedia\(\{ audio: false,/, 'video only, never the microphone');
});

test('control-window IPC answers carry the fixed view only (the chosen file paths stay in the host)', async () => {
  const { registerPoseControls } = await import('../electron/senses/pose/control-ipc');
  const handlers = new Map<string, { run: (...args: unknown[]) => unknown; controlOnly: boolean }>();
  const imported: string[][] = [];
  const view: PoseSensingView = { phase: 'idle', prompt: false, downloadBytes: 1, installedBytes: 2, progress: null, route: null, level: null, componentVersion: 1, notice: 'import-done' };
  const fake = { view: () => view, download: async () => view, cancelDownload: () => {}, dismissPrompt: () => view, remove: async () => view, redetect: async () => view,
    diagnostics: () => ({ present: 2 }), importFiles: async (paths: string[]) => { imported.push(paths); return { ...view, result: { accepted: 3, rejected: 0, complete: true } }; } };
  registerPoseControls((name, run, controlOnly = true) => handlers.set(name, { run, controlOnly }), () => fake as never,
    async () => ['C:\\Users\\me\\Downloads\\rtmpose-cpu.zip', 'D:\\usb\\onnxruntime-node-1.31.1.tgz']);
  const reply = await handlers.get('importPoseComponents')!.run();
  assert.deepEqual(imported, [['C:\\Users\\me\\Downloads\\rtmpose-cpu.zip', 'D:\\usb\\onnxruntime-node-1.31.1.tgz']]);
  assert.deepEqual(reply, view, 'no path, no import details');
  for (const [name, handler] of handlers) assert.ok(!JSON.stringify(await handler.run() ?? null).includes('\\'), name);
  assert.deepEqual([...handlers].filter(([, h]) => !h.controlOnly).map(([name]) => name).sort(), ['dismissPosePrompt', 'getPoseSensing'],
    'only reading the state and closing the question are open to the pet window');
});
