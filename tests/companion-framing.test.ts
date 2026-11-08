import { scanBreathRequest } from '../shared/breath-request';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { MathUtils } from 'three';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { scanFramingRequest } from '../shared/framing-request';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';
import { readPetFramingState, sameFramingCamera } from '../shared/pet-framing';
import { CompanionCommandHost, validCompanionAction } from '../electron/companion-command-host';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import { createCommandDialogueTurn } from '../electron/companion-command-dialogue';
import { PetFramingHost } from '../electron/pet-framing';
import { PetFramingController } from '../src/ui/PetFraming';
import { framingCamera, framingTopBand } from '../src/stage/stage-framing';
import { petViewSettings } from '../electron/pet-view';
import { mergeSettings } from '../src/ui/settings-merge';
import { outgoingChatMessages } from '../src/ui/reply-history';

const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const main = parse('../electron/main.ts'), renderer = parse('../src/main.ts'), stageSource = parse('../src/stage/MmdStage.ts');
function find(source: ts.SourceFile, predicate: (n: ts.Node) => boolean): ts.Node {
  const found: ts.Node[] = []; const visit = (n: ts.Node) => { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); }; visit(source);
  assert.equal(found.length, 1, 'one actual production entry'); return found[0];
}
const factory = (name: string) => find(main, n => ts.isNewExpression(n) && n.expression.getText(main) === name).getText(main);
const fn = (source: ts.SourceFile, name: string) => find(source, n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(source);
const method = (name: string) => find(stageSource, n => ts.isMethodDeclaration(n) && n.name.getText(stageSource) === name).getText(stageSource).replace(/^[^(]+/, 'function');
const callback = (name: string) => (find(renderer, n => ts.isPropertyAssignment(n) && n.name.getText(renderer) === name) as ts.PropertyAssignment).initializer.getText(renderer);
const evaluate = (text: string, context: vm.Context) => vm.runInContext(ts.transpileModule('(' + text + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const intent = (text: string) => classifyCompanionCommand({ requestId: 'human-1', contextId: 'current', text, currentValue: false });

function fixture() {
  let context = 'card-model-provider-window', id = 0, queue = Promise.resolve(), frames = 0, manualSaves = 0;
  const broadcasts: any[] = [], requests: any[] = [], writes: any[] = [], ui: Promise<void>[] = [];
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.model = { name: 'SYNTHETIC', path: 'synthetic.pmx', url: 'mmd-asset://synthetic' };
  settings.pet.visible = true; settings.camera = { yaw: 9, pitch: 4, distance: 30, targetX: 1, targetY: 6, targetZ: 0, fov: 32 };
  const original = structuredClone(settings);
  const store = { current: settings, persist: async (next: typeof settings) => { writes.push(structuredClone(next)); store.current = structuredClone(next); return structuredClone(next); } };
  const pet: any = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 11, send: (channel: string, request: any) => {
    assert.equal(channel, 'desk:pet-framing'); requests.push(request); ui.push(ctx.petFramingController.receive(request));
  } } };
  const controls: any = { isVisible: () => true, isMinimized: () => false, webContents: { id: 22 } };
  const mutate = (job: () => Promise<any>) => { const result = queue.then(job, job); queue = result.then(() => {}, () => {}); return result; };
  const ctx: any = vm.createContext({ structuredClone, MathUtils, framingCamera, framingTopBand, PetFramingHost, PetFramingController, CompanionCommandHost,
    Date, randomUUID: () => 'request-' + ++id, crypto: { randomUUID: () => 'pet-session' },
    pet, windows: () => [pet, controls], store, sameFramingCamera, petViewSettings, publicSettings: structuredClone,
    companionCommandContext: (_sender: number) => context, companionCommandTarget: () => ({ contextId: context, value: false, revision: 0 }),
    companionBreathTarget: () => null, commitCompanionBreath: () => { throw Error('unrelated breath'); },
    companionReadoutVolumeTarget: () => null, companionReadoutStopTarget: () => null,
    commitCompanionReadoutVolume: () => { throw Error('unrelated volume'); }, stopCompanionReadout: () => { throw Error('unrelated audio'); },
    commitCompanionCommand: () => { throw Error('unrelated setting'); }, classifyCompanionCommand, formatCompanionCommandReceipt,
    mutate, broadcast: (channel: string, value: any) => broadcasts.push({ channel, value: structuredClone(value) }),
    companionCommandExpiry: null, setTimeout: () => 1, clearTimeout: () => {},
    isPet: true, recoveringPetView: false, settings: structuredClone(settings), hostSettings: structuredClone(settings),
    petFramingController: null, queueMicrotask, syncCamera: () => { throw Error('controls preview'); },
    queueSave: () => { manualSaves++; }, notify: (message: string) => { throw Error(message); },
  });
  ctx.petFraming = evaluate(factory('PetFramingHost'), ctx);
  ctx.companionFramingTarget = evaluate(fn(main, 'companionFramingTarget').replace(/^function\s+\w+/, 'function'), ctx);
  const stage: any = { mesh: {}, disposed: false, modelGeneration: 1, framingRevision: 1, framingCamera: structuredClone(settings.camera),
    settings: structuredClone(settings), height: 10, width: 3, centerX: 0.2, baseY: 0, camera: { aspect: 0.8 }, container: { clientHeight: 560 },
    editing: true, pose: {}, gesture: {}, expression: {}, baseTime: 17.5, window: { x: 80, y: 60, width: 400, height: 560 },
    setCamera(camera: any) { this.framingCamera = { ...camera }; this.framingRevision++; ctx.onFramingStateChange(); },
    options: { onCameraChange: (camera: any) => ctx.onCameraChange(camera) } };
  stage.frame = (preset: any) => { frames++; return evaluate(method('frame'), ctx).call(stage, preset); };
  stage.getFramingView = () => evaluate(method('getFramingView'), ctx).call(stage);
  ctx.stage = stage; ctx.onFramingStateChange = evaluate(callback('onFramingStateChange'), ctx); ctx.onCameraChange = evaluate(callback('onCameraChange'), ctx);
  const desktop: any = { reportPetFramingState: async (state: any) => ctx.petFraming.report(11, state),
    beginPetFraming: async (requestId: string) => ctx.petFraming.begin(11, requestId),
    completePetFraming: (report: any) => ctx.petFraming.complete(11, report), noteManualCameraChange: async () => ctx.petFraming.manual(),
    onPetFramingRequest: () => () => {} };
  ctx.window = { desktop };
  const mount = find(renderer, n => ts.isIfStatement(n) && n.expression.getText(renderer) === 'isPet'
    && n.thenStatement.getText(renderer).includes('new PetFramingController')).getText(renderer);
  vm.runInContext(ts.transpileModule(mount, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const host: CompanionCommandHost = evaluate(factory('CompanionCommandHost'), ctx); ctx.companionCommands = host;
  const admit = (text: string, requestId = 'human-' + ++id, source: any = 'current-human') => host.admit({ requestId, owner: 22, window: 'controls', text, source });
  return { ctx, host, admit, store, stage, original, desktop, writes, requests, broadcasts, ui,
    counts: () => ({ frames, manualSaves }), context: (next: string) => { context = next; },
    async manual(yaw: number) { stage.setCamera({ ...stage.framingCamera, yaw }); ctx.onCameraChange(stage.framingCamera); await turn(); },
    async flushManual() { store.current = { ...store.current, camera: structuredClone(ctx.settings.camera) }; },
  };
}

test('framing literal intent is bounded, ambiguous choices name current pet, unsupported quoted/compound data cannot execute', () => {
  for (const [text, mode] of [['请把桌宠切到全身取景', 'full'], ['请把桌宠切到近景', 'portrait'], ['frame the pet portrait', 'portrait']] as const) {
    assert.equal(scanFramingRequest(text), mode); const c = intent(text); assert.equal(c.kind, 'explicit');
    if (c.kind === 'explicit') assert.deepEqual(c.action, { actionId: 'pet.frame', parameters: { value: mode } });
  }
  const c = intent('拉近点'); assert.equal(c.kind, 'clarify');
  if (c.kind === 'clarify') assert.deepEqual(c.choices.map(c => c.action.parameters.value), ['full', 'portrait']);
  for (const text of ['他说“把桌宠切到全身”', '不要把桌宠切到全身', '把桌宠切到全身并开启摄像头', '把预览切到全身', 'camera: {x:10}', '全身\n取景']) assert.equal(scanFramingRequest(text), 'none');
  assert.equal(validCompanionAction({ actionId: 'pet.frame', parameters: { value: 'portrait', camera: { distance: 2 } } }), false);
  assert.equal(validCompanionAction({ actionId: 'pet.frame', parameters: { value: 'zoom' } }), false);
});

test('actual Main factories, host ticket, real pet mounting and original frame math apply and save only camera for both presets', async () => {
  for (const mode of ['全身取景', '近景'] as const) {
    const f = fixture(), pose = f.stage.pose, gesture = f.stage.gesture, face = f.stage.expression, geometry = structuredClone(f.stage.window);
    const ticket = f.admit('请把桌宠切到' + mode)!; const view = await f.host.run(ticket); await Promise.all(f.ui);
    assert.equal(view?.receipt?.status, 'saved'); assert.equal(view?.receipt?.presentation, 'applied'); assert.equal(f.writes.length, 1);
    assert.equal(f.counts().manualSaves, 0, 'frame callback cannot queue a competing whole-view save');
    assert.equal(f.requests.length, 1); assert.equal(f.stage.editing, true); assert.equal(f.stage.baseTime, 17.5);
    assert.equal(f.stage.pose, pose); assert.equal(f.stage.gesture, gesture); assert.equal(f.stage.expression, face); assert.deepEqual(f.stage.window, geometry);
    const restored = structuredClone(f.store.current); restored.camera = f.original.camera; assert.deepEqual(restored, f.original);
    assert.equal(sameFramingCamera(f.stage.framingCamera, f.store.current.camera), true);
    assert.equal(await f.host.run(ticket), null); assert.equal(f.requests.length, 1);
  }
});

test('old ambiguous choices, cancellation and current-human authority never frame after later manual input or foreign source', async () => {
  const f = fixture();
  for (const source of ['model', 'quoted', 'screen', 'history']) assert.equal(f.admit('请把桌宠切到全身', 'foreign-' + source, source), null);
  const choice = await f.host.run(f.admit('拉近点')!); assert.equal(choice!.choices.length, 3);
  await f.manual(21);
  const result = await f.host.choose(22, { requestId: choice!.requestId, choiceId: choice!.choices[1].choiceId });
  assert.equal(result?.receipt?.status, 'conflict'); assert.equal(f.counts().frames, 0); assert.equal(f.writes.length, 0);
  const cancel = await f.host.run(f.admit('拉近点')!);
  const cancelled = await f.host.choose(22, { requestId: cancel!.requestId, choiceId: cancel!.choices.at(-1)!.choiceId });
  assert.equal(cancelled?.receipt?.status, 'cancelled'); assert.equal(f.requests.length, 0);
});

test('delayed begin cannot frame after model generation, context, or manual camera supersedes the request', async () => {
  for (const change of ['model', 'context', 'camera']) {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; }); const begin = f.desktop.beginPetFraming;
    f.desktop.beginPetFraming = async (id: string) => { await gate; return begin(id); };
    const run = f.host.run(f.admit('请把桌宠切到全身')!); await turn(); assert.equal(f.requests.length, 1);
    if (change === 'model') { f.stage.modelGeneration++; f.ctx.petFramingController.report(); }
    else if (change === 'context') { f.context('new-card'); f.ctx.petFramingController.invalidate(); f.host.refresh(); }
    else await f.manual(27);
    release(); await run; await Promise.all(f.ui);
    assert.equal(f.counts().frames, 0); assert.equal(f.writes.length, 0);
  }
});

test('a later manual camera during persistence keeps its view and suppresses a late settings broadcast', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const inside = new Promise<void>(yes => { entered = yes; });
  f.store.persist = async next => { f.writes.push(structuredClone(next)); entered(); await new Promise<void>(yes => { release = yes; }); f.store.current = structuredClone(next); return next; };
  const run = f.host.run(f.admit('请把桌宠切到近景')!); await inside;
  await f.manual(39); release(); const result = await run; await Promise.all(f.ui);
  assert.equal(result?.receipt?.presentation, 'unknown'); assert.equal(f.stage.framingCamera.yaw, 39);
  assert.equal(f.broadcasts.filter(row => row.channel === 'desk:settings').length, 0);
  assert.equal(f.counts().manualSaves, 1); await f.flushManual(); assert.equal(f.store.current.camera.yaw, 39);
});

test('unknown or failed saves never claim saved/applied success, and preview/foreign acknowledgements cannot mint an operation', async () => {
  const f = fixture();
  assert.throws(() => f.ctx.petFraming.report(22, f.ctx.petFramingController.state()));
  assert.equal(f.ctx.petFraming.begin(11, 'invented'), false);
  f.store.persist = async () => { throw Error('storage unavailable'); };
  const view = await f.host.run(f.admit('请把桌宠切到全身')!); await Promise.all(f.ui);
  assert.equal(view?.receipt?.persistence, 'unknown'); assert.equal(view?.receipt?.status, 'failed');
  assert.match(view!.receipt!.message, /取景已应用，但保存结果尚未确认/);
  assert.match(view!.receipt!.message, /未确认/); assert.doesNotMatch(view!.receipt!.message, /已应用并保存/);
  const state = f.ctx.petFramingController.state(); assert.throws(() => readPetFramingState({ ...state, shell: 'x' }));
});

test('actual no-mesh frame returns no application and current pet must be ready; controls preview is not invoked', async () => {
  const f = fixture(); f.stage.mesh = null; f.ctx.petFramingController.report();
  assert.equal(evaluate(method('frame'), f.ctx).call(f.stage, 'full'), null);
  const view = await f.host.run(f.admit('请把桌宠切到全身')!);
  assert.equal(view?.receipt?.status, 'rejected'); assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
});

test('actual renderer framing ingress submits literal text through existing local-control path without save, media, provider or action data', async () => {
  const requests: any[] = [], input = { value: '请把桌宠切到全身取景' }, forbidden = () => { throw Error('unexpected ordinary chat side effect'); };
  const ctx: any = vm.createContext({ activeChat: null, pendingReadoutControl: null, attachments: [], history: [], isPet: false,
    scanBreathRequest, scanStopReadoutRequest, scanFramingRequest, outgoingChatMessages, crypto: { randomUUID: () => 'request-frame' },
    $: () => input, window: { desktop: { chat: async (value: any) => requests.push(value), noteUserInput: forbidden } },
    save: forbidden, speech: { stop: forbidden }, notify: forbidden });
  const send = evaluate(fn(renderer, 'sendChat').replace(/^async function\s+\w+/, 'async function'), ctx);
  await send(); assert.equal(requests.length, 1); assert.deepEqual(Array.from(requests[0].attachments), []);
  assert.equal(requests[0].messages.at(-1).content, '请把桌宠切到全身取景');
  assert.deepEqual(Object.keys(requests[0]).sort(), ['attachments', 'id', 'messages']); assert.equal(input.value, '');
});

test('actual dialogue formats a framing receipt and a rejected ambiguous target without provider fallback or a forged completion', async () => {
  for (const ready of [true, false]) {
    const f = fixture(), text = ready ? '请把桌宠切到全身' : '拉近点';
    if (!ready) { f.stage.mesh = null; f.ctx.petFramingController.report(); }
    const ticket = f.admit(text, 'dialogue-frame')!, output: string[] = []; let finished = 0;
    const dialogue = createCommandDialogueTurn({ classify: classifyCompanionCommand, formatReceipt: formatCompanionCommandReceipt,
      host: async () => { const view = (await f.host.run(ticket))!; return view.receipt ?? view; },
      turn: { push: (_type, value) => output.push(value), finish: async () => { finished++; } },
      signal: new AbortController().signal, isCurrent: () => true });
    assert.equal(await dialogue.handle({ requestId: 'dialogue-frame', contextId: 'current', currentValue: false, text }), 'handled');
    assert.equal(finished, 1); assert.match(output.join(''), ready ? /已应用并保存/ : /未执行/);
    await Promise.all(f.ui);
  }
});

test('actual preload keeps fixed framing channels and actual isPet mounting excludes the controls preview', () => {
  const preload = parse('../electron/preload.ts'), calls: any[] = [];
  const ctx = vm.createContext({ invoke: (...args: unknown[]) => calls.push(args), subscribe: (...args: unknown[]) => calls.push(args) });
  for (const [name, args, expected] of [
    ['reportPetFramingState', [{ ready: false }], 'reportPetFramingState'], ['beginPetFraming', ['opaque'], 'beginPetFraming'],
    ['completePetFraming', [{ id: 'opaque' }], 'completePetFraming'], ['noteManualCameraChange', [], 'noteManualCameraChange'],
    ['onPetFramingRequest', [() => {}], 'desk:pet-framing'],
  ] as const) {
    const property = find(preload, n => ts.isPropertyAssignment(n) && n.name.getText(preload) === name) as ts.PropertyAssignment;
    evaluate(property.initializer.getText(preload), ctx)(...args); assert.equal(calls.at(-1)[0], expected);
    assert.equal(calls.at(-1).length, args.length + 1);
  }
  const mount = find(renderer, n => ts.isIfStatement(n) && n.expression.getText(renderer) === 'isPet'
    && n.thenStatement.getText(renderer).includes('new PetFramingController')).getText(renderer);
  const controls = vm.createContext({ isPet: false, PetFramingController: class { constructor() { throw Error('preview mounted pet framing'); } } });
  vm.runInContext(ts.transpileModule(mount, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, controls);
});

test('a fresh repeated explicit framing request applies once and honestly reports unchanged persistence without a second write', async () => {
  const f = fixture();
  await f.host.run(f.admit('请把桌宠切到全身')!); await Promise.all(f.ui);
  const view = await f.host.run(f.admit('请把桌宠切到全身')!); await Promise.all(f.ui);
  assert.equal(view?.receipt?.status, 'unchanged'); assert.equal(view?.receipt?.persistence, 'unchanged');
  assert.equal(view?.receipt?.presentation, 'applied'); assert.match(view!.receipt!.message, /设置无变化/);
  assert.equal(f.writes.length, 1); assert.equal(f.counts().frames, 2);
});

test('actual scoped IPC rejects subframes, foreign state publishers and extra positional framing arguments', () => {
  const f = fixture(), handlers = new Map<string, (...args: any[]) => any>();
  f.ctx.ipcMain = { handle: (key: string, handler: (...args: any[]) => any) => handlers.set(key, handler) };
  f.ctx.scopedHost = evaluate(fn(main, 'scopedHost').replace(/^function\s+\w+/, 'function'), f.ctx);
  const names = ['reportPetFramingState', 'beginPetFraming', 'completePetFraming', 'noteManualCameraChange'];
  for (const name of names) {
    const call = find(main, n => ts.isCallExpression(n) && n.expression.getText(main) === 'scopedHost'
      && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === name);
    evaluate(call.getText(main), f.ctx);
  }
  const frame = {}, pet = { sender: { id: 11, mainFrame: frame }, senderFrame: frame }, controls = { sender: { id: 22, mainFrame: frame }, senderFrame: frame };
  const state = f.ctx.petFramingController.state();
  assert.throws(() => handlers.get('desk:reportPetFramingState')!(controls, state));
  assert.throws(() => handlers.get('desk:reportPetFramingState')!({ ...pet, senderFrame: {} }, state));
  for (const name of names) assert.throws(() => handlers.get('desk:' + name)!(pet, 'one', 'extra'));
  assert.doesNotThrow(() => handlers.get('desk:reportPetFramingState')!(pet, state));
  assert.equal(handlers.get('desk:beginPetFraming')!(controls, 'invented'), false);
  assert.equal(f.writes.length, 0); assert.equal(f.requests.length, 0);
});
