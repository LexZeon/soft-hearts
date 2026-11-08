import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { VisualSelfRuntime, type VisualSelfLease } from '../electron/visual-self-runtime';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';

const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const names = ['refreshVisualSelfContext', 'visualSelfData', 'chatContextData', 'captureSharedScreen', 'captureSharedCamera'];
const helpers = names.map(name => {
  const matches = ast.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0].getText(ast);
});
const started: ts.ArrowFunction[] = [];
function visit(n: ts.Node) {
  if (ts.isCallExpression(n) && n.expression.getText(ast) === 'scopedHost'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'chat') {
    function inside(part: ts.Node) {
      if (ts.isCallExpression(part) && part.expression.getText(ast) === 'launchTask') {
        assert.ok(ts.isArrowFunction(part.arguments[4])); started.push(part.arguments[4]);
      }
      ts.forEachChild(part, inside);
    }
    inside(n.arguments[1]);
  }
  ts.forEachChild(n, visit);
}
visit(ast); assert.equal(started.length, 1);
const compiled = ts.transpileModule(`let visualSelfIdentity = ''; let visualSelfRevision = 0;
let visualSelfScreenSourceId = null; let visualSelfCameraOwnerId = null;
${helpers.join('\n')}
return { ${names.join(',')}, onStarted(request) {
  const readoutControl = request.attachments.length === 0
    && scanStopReadoutRequest(request.messages.at(-1)?.content) !== 'none';
  const sender = 1; let profileAcceptance = null, profileCollector = null;
  let commandTicket = null, commandIntent = null, commandAdmissionFailed = false;
  let profileSourceEligible = false, visualSelfLease = null;
  let memorialInput=null, memorialIdentity='';
  (${started[0].getText(ast)})(); return visualSelfLease;
}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Frame = { source: string; dataUrl: string };
interface Api {
  refreshVisualSelfContext(scope: string, displayId?: string | null): void;
  visualSelfData(lease: VisualSelfLease | null): string | undefined;
  chatContextData(profileLease: string | null, visualLease: VisualSelfLease | null): string | undefined;
  captureSharedScreen(sourceId: string, signal: AbortSignal): Promise<Frame>;
  captureSharedCamera(owner: number, signal: AbortSignal): Promise<Frame | null>;
  onStarted(request: { id: string; messages: { role: string; content: string }[]; attachments: Frame[] }): VisualSelfLease | null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const state = { now: 1000, visible: true, minimized: false, card: 'card-a', screen: true, camera: true,
    mediaRevision: 1, windowRevision: 1, scope: 'scope-a', token: 'mood-a', captures: 0, requests: 0, profile: 'opaque profile data',
    displayId: '7', cameraOwner: 'pet' };
  const events: string[] = [], profileReads: (string | null)[] = [];
  let seq = 0;
  const runtime = new VisualSelfRuntime({ clock: () => state.now, mint: () => `r40-${++seq}` });
  const begin = runtime.beginCapture.bind(runtime), accept = runtime.accept.bind(runtime);
  runtime.beginCapture = kind => { events.push(`token:${kind}`); return begin(kind); };
  runtime.accept = (...args) => { events.push('accept'); return accept(...args); };
  const setContext = runtime.setContext.bind(runtime);
  runtime.setContext = snapshot => { events.push('refresh'); return setContext(snapshot); };
  const screenResult = ['7', '8'].map(display_id => ({ display_id,
    thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from(`synthetic-jpeg-${display_id}`) } }));
  let screenOperation = async () => screenResult;
  const cameraFrame = { source: 'camera', dataUrl: 'data:image/jpeg;base64,c3ludGhldGljLWNhbWVyYQ==' };
  let cameraOperation = async (): Promise<Frame | null> => cameraFrame;
  const pet = { webContents: { id: 1, send: () => {} }, isDestroyed: () => false,
    isVisible: () => state.visible, isMinimized: () => state.minimized, getBounds: () => ({ x: 0, y: 0, width: 400, height: 500 }) };
  const controls = { ...pet, webContents: { id: 2, send: () => {} } };
  const current = { model: null };
  let api!: Api;
  const env = {
    visualSelfRuntime: runtime, createHash, scanStopReadoutRequest, pet,
    nativeVisibility: () => ({ visible: state.visible && !state.minimized, windowId: 1, revision: state.windowRevision }),
    characterCards: { getActive: () => ({ id: state.card, name: 'Gene' }) }, store: { current },
    screen: { getDisplayMatching: () => ({ id: state.displayId }) },
    media: { get revision() { return state.mediaRevision; }, get state() { return { screenSharing: state.screen, cameraSharing: state.camera, cameraOwner: state.cameraOwner }; },
      sharesCameraFrames() { return state.camera; } }, // old sharing mode; local pose sensing is covered by tests/pose-privacy.test.ts
    windows: () => [pet, controls], ownerFor: (id: number) => id === 1 ? 'pet' : 'controls', speechScope: () => state.scope,
    companion: { mood: { get: () => ({ token: state.token }) }, currentSpeechScope: () => state.scope },
    Date: { now: () => state.now }, screenSnapshots: { state: { intervalSeconds: 5 } },
    desktopCapturer: { getSources: () => { state.captures++; events.push('screen-await'); return screenOperation(); } },
    cameraSamples: { request: () => { state.requests++; events.push('camera-await'); return cameraOperation(); } },
    userProfileContext: { read: (lease: string | null) => { profileReads.push(lease); return state.profile || undefined; } },
    userProfileSource: { observe: () => false }, acceptProfileMessage: () => null, userProfiles: null,
    UserProfileReplyCollector: { create: () => { throw Error('Profile collection outside target'); } },
    noteVisionUserActivity: () => { events.push('activity'); runtime.cancelActive(); },
    refreshVisionContext: () => { throw Error('Source2 onStarted must not configure snapshot timers'); },
    speechRuntime: { stop: () => { events.push('speech-stop'); } }, clearReplySpeech: () => {},
  };
  // Actual production declarations in the same realm; strict descriptor validation remains active.
  api = new Function(...Object.keys(env), compiled)(...Object.values(env)) as Api;
  api.refreshVisualSelfContext(`${state.scope}:${state.token}`);
  events.length = 0;
  return { api, state, runtime, events, profileReads, cameraFrame, screenResult,
    deferScreen: () => { const d = deferred<typeof screenResult>(); screenOperation = () => d.promise; return d; },
    deferCamera: () => { const d = deferred<Frame | null>(); cameraOperation = () => d.promise; return d; } };
}
function hints(data: string | undefined) {
  assert.ok(data);
  return JSON.parse(data.slice(data.indexOf('\n') + 1)).visualSelf as { source: string; avatar: unknown; selfInFrame: string; region: unknown }[];
}

test('actual screen helper captures once after token mint; metadata reads use exact receipt without recapture', async () => {
  const f = fixture();
  try {
    const frame = await f.api.captureSharedScreen('7', new AbortController().signal);
    assert.deepEqual(f.events.slice(0, 2), ['token:screen', 'screen-await']);
    const lease = f.runtime.accept('user-message', 'screen-message', [frame], 9000); assert.ok(lease);
    const result = hints(f.api.visualSelfData(lease));
    assert.equal(result[0].source, 'screen'); assert.equal(result[0].avatar, null);
    assert.equal(result[0].selfInFrame, 'UNKNOWN'); assert.equal(result[0].region, null);
    assert.equal(f.api.visualSelfData(lease), f.api.visualSelfData(lease));
    assert.equal(f.state.captures, 1); assert.equal(f.state.requests, 0);
    assert.equal(f.runtime.accept('user-message', 'relabeled', [{ ...frame, source: 'camera' }], 9000), null);
  } finally { f.runtime.dispose(); }
});

test('pre-await screen token cannot publish a late capture after role or source change', async () => {
  for (const kind of ['role', 'source'] as const) {
    const f = fixture();
    try {
      const wait = f.deferScreen();
      const result = f.api.captureSharedScreen('7', new AbortController().signal);
      assert.deepEqual(f.events.slice(0, 2), ['token:screen', 'screen-await']);
      if (kind === 'role') f.state.card = 'card-b';
      else { f.state.screen = false; f.state.mediaRevision++; }
      f.api.refreshVisualSelfContext(`${f.state.scope}:${f.state.token}`);
      wait.resolve(f.screenResult);
      if (kind === 'source') await assert.rejects(result, /Sharing changed/);
      else {
        const lateFrame = await result;
        assert.equal(f.runtime.accept('user-message', 'late-frame', [lateFrame], 9000), null);
      }
      assert.equal(f.state.captures, 1);
    } finally { f.runtime.dispose(); }
  }
});

test('final read discards cached identity on native hide, active card or shared source change', async () => {
  for (const change of ['hide', 'card', 'source'] as const) {
    const f = fixture();
    try {
      const frame = await f.api.captureSharedScreen('7', new AbortController().signal);
      const lease = f.runtime.accept('user-message', 'accepted', [frame], 9000); assert.ok(lease);
      assert.ok(f.api.visualSelfData(lease));
      if (change === 'hide') f.state.minimized = true;
      if (change === 'card') f.state.card = 'card-b';
      if (change === 'source') { f.state.screen = false; f.state.mediaRevision++; }
      assert.equal(f.api.visualSelfData(lease), undefined);
      assert.equal(f.state.captures, 1);
    } finally { f.runtime.dispose(); }
  }
});

test('camera receipt expires two seconds after request start, including delayed completion and abort', async () => {
  const f = fixture();
  try {
    const wait = f.deferCamera();
    const pending = f.api.captureSharedCamera(1, new AbortController().signal);
    assert.deepEqual(f.events.slice(0, 2), ['token:camera', 'camera-await']);
    f.state.now = 2500; wait.resolve(f.cameraFrame);
    const frame = await pending; assert.ok(frame);
    f.state.now = 2800;
    const lease = f.runtime.accept('user-message', 'camera-message', [frame], 50_000); assert.ok(lease);
    assert.equal(hints(f.api.visualSelfData(lease))[0].source, 'camera');
    f.state.now = 3000; assert.equal(f.api.visualSelfData(lease), undefined);
    assert.equal(f.state.requests, 1);
  } finally { f.runtime.dispose(); }
  for (const abort of [false, true]) {
    const g = fixture();
    try {
      const wait = g.deferCamera(), controller = new AbortController();
      const pending = g.api.captureSharedCamera(1, controller.signal);
      if (abort) controller.abort(); else g.state.now = 3001;
      wait.resolve(g.cameraFrame); const frame = await pending; assert.ok(frame);
      assert.equal(g.runtime.accept('user-message', 'late-or-aborted', [frame], 9000), null);
    } finally { g.runtime.dispose(); }
  }
});

test('profile and visual context stay separate; missing visual data preserves existing profile bytes', async () => {
  const f = fixture();
  try {
    const profile = 'Exact profile bytes\n{"untrusted":"kept as data"}'; f.state.profile = profile;
    assert.equal(f.api.chatContextData('profile-lease', null), profile);
    const frame = await f.api.captureSharedScreen('7', new AbortController().signal);
    const lease = f.runtime.accept('user-message', 'combined', [frame], 9000); assert.ok(lease);
    const visual = f.api.visualSelfData(lease); assert.ok(visual);
    assert.equal(f.api.chatContextData('profile-lease', lease), `${profile}\n\n${visual}`);
    assert.equal(f.state.profile, profile);
    f.state.profile = ''; assert.equal(f.api.chatContextData(null, lease), visual);
    f.state.visible = false; assert.equal(f.api.chatContextData(null, lease), undefined);
    assert.ok(f.profileReads.includes('profile-lease'));
  } finally { f.runtime.dispose(); }
});

test('actual chat onStarted cancels old activity first, refreshes context, then accepts the attached host receipt', async () => {
  const f = fixture();
  try {
    const frame = await f.api.captureSharedScreen('7', new AbortController().signal);
    const old = f.runtime.accept('user-message', 'old', [frame], 9000); assert.ok(old);
    f.events.length = 0;
    const current = f.api.onStarted({ id: 'new', messages: [{ role: 'user', content: 'synthetic' }], attachments: [frame] });
    assert.deepEqual(f.events, ['activity', 'refresh', 'accept', 'speech-stop']);
    assert.equal(f.runtime.read(old), undefined);
    assert.ok(current); assert.ok(f.api.visualSelfData(current));
    assert.equal(f.state.captures, 1);
  } finally { f.runtime.dispose(); }
});

test('a different existing display or an inflight display change never receives the selected display identity', async () => {
  const f = fixture();
  try {
    const other = await f.api.captureSharedScreen('8', new AbortController().signal);
    assert.equal(f.events.includes('token:screen'), false, 'Wrong existing display must not mint a capture token');
    assert.equal(f.runtime.accept('user-message', 'other-display', [other], 9000), null);
    const wait = f.deferScreen();
    const pending = f.api.captureSharedScreen('7', new AbortController().signal);
    f.state.displayId = '8';
    f.api.refreshVisualSelfContext(`${f.state.scope}:${f.state.token}`);
    wait.resolve(f.screenResult);
    const oldDisplay = await pending;
    assert.equal(f.runtime.accept('user-message', 'changed-display', [oldDisplay], 9000), null);
  } finally { f.runtime.dispose(); }
});

test('wrong or replaced camera owner cannot mint or complete a receipt for the current owner', async () => {
  const f = fixture();
  try {
    const other = await f.api.captureSharedCamera(2, new AbortController().signal); assert.ok(other);
    assert.equal(f.events.includes('token:camera'), false, 'Wrong live window must not mint a camera token');
    assert.equal(f.runtime.accept('user-message', 'wrong-owner', [other], 9000), null);
    const wait = f.deferCamera();
    const pending = f.api.captureSharedCamera(1, new AbortController().signal);
    f.state.cameraOwner = 'controls';
    f.api.refreshVisualSelfContext(`${f.state.scope}:${f.state.token}`);
    wait.resolve(f.cameraFrame);
    const late = await pending; assert.ok(late);
    assert.equal(f.runtime.accept('user-message', 'replaced-owner', [late], 9000), null);
    const nextWait = f.deferCamera();
    const current = f.api.captureSharedCamera(2, new AbortController().signal);
    nextWait.resolve(f.cameraFrame);
    const valid = await current; assert.ok(valid);
    assert.equal(hints(f.api.visualSelfData(f.runtime.accept('user-message', 'current-owner', [valid], 9000)))[0].source, 'camera');
  } finally { f.runtime.dispose(); }
});
