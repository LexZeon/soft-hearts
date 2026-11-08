import assert from 'node:assert/strict';
import { MutationQueue } from '../electron/mutation-queue';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { PersonalizeVisualAuthoring } from '../electron/personalize-visual-authoring';
import { VisualBehaviorStore } from '../electron/visual-behavior-store';
import type { SelectedVisualImage } from '../electron/selected-visual-image';
import { BEHAVIOR_RECIPES } from '../shared/behavior-recipes';
import { VISUAL_GENE_SHA, VISUAL_MASK, VISUAL_PURPOSE, visualChoices,
  type VisualAuthoringState, type VisualPreview, type VisualResearchRequest } from '../shared/personalize-visual';

const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
function find<T extends ts.Node>(predicate: (n: ts.Node) => n is T, root: ts.Node = tree): T[] {
  const rows: T[] = [];
  function visit(n: ts.Node) { if (predicate(n)) rows.push(n); ts.forEachChild(n, visit); }
  visit(root); return rows;
}
function fn(name: string): string {
  const rows = tree.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(rows.length, 1, name); return rows[0].getText(tree);
}
function variable(name: string, ast = tree): string {
  const rows = ast.statements.filter((n): n is ts.VariableStatement => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
  assert.equal(rows.length, 1, name); return rows[0].getText(ast);
}
function evaluate<T>(code: string, env: Record<string, unknown>): T {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env)) as T;
}
const constructors = find((n): n is ts.NewExpression => ts.isNewExpression(n) && n.expression.getText(tree) === 'PersonalizeVisualAuthoring');
assert.equal(constructors.length, 1);
const ports = ['getVisualAuthoring', 'chooseVisualMaterial', 'researchVisual', 'previewVisualBinding',
  'visualPreviewReceipt', 'resolveVisualPreview', 'saveVisualBehavior', 'changeVisualBehavior', 'cancelVisualAuthoring'] as const;
const registrations = ports.map(name => {
  const rows = find((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(tree) === 'scopedHost'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === name);
  assert.equal(rows.length, 1, name); return `${rows[0].getText(tree)};`;
}).join('\n');
const study = { observations: [{ region: 'eye', visibility: 'ambiguous', description: '合成眼部资料，不能作真实识别结论' }],
  inferences: [], questions: ['是否保留这项候选？'], insufficient: '合成图不验证真实观察质量' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const selection = () => ({ ...visualChoices()[0], label: '合成眉眼候选', strength: 0.34 });
function request(state: VisualAuthoringState): VisualResearchRequest {
  assert.ok(state.material); assert.ok(state.submitNonce);
  return { sessionId: state.id, revision: state.revision, materialId: state.material.id,
    submitNonce: state.submitNonce, purpose: VISUAL_PURPOSE, refinement: '仅研究这张合成材料' };
}

async function make() {
  const tempRoot = await realpath(os.tmpdir()), prefix = 'soft-hearts-visual-host-';
  const directory = await mkdtemp(path.join(tempRoot, prefix)), characterId = randomUUID();
  const visualBehaviors = new VisualBehaviorStore(directory, () => [characterId]); await visualBehaviors.load();
  const frames = { controls: {}, pet: {} }, sent: any[][] = [], dialogCalls: any[][] = [], readCalls: any[][] = [];
  const controls = { webContents: { id: 1, send: (...args: any[]) => sent.push([1, ...args]) } };
  const pet = { webContents: { id: 2, send: (...args: any[]) => sent.push([2, ...args]) } };
  const pending = new Map<string, any>(), requests: any[] = [], changes: string[] = [], ordinary: string[] = [];
  const images: { image: SelectedVisualImage; initialDataUrl: string; releases: number }[] = [];
  const configuredPath = path.join(directory, 'synthetic-configured-gene.pmx');
  const store: any = { directory, current: { provider: { kind: 'claude', model: 'synthetic-visual-model' },
    model: { path: configuredPath, url: 'mmd-asset://synthetic/configured-gene.pmx' } } };
  const state = { scope: 'synthetic-scope', syncs: 0,
    dialog: { canceled: false, filePaths: [path.join(directory, 'synthetic-selected.png')] },
    stream: async (_task: any, signal: AbortSignal, emit: (kind: string, text: string) => void) => {
      assert.equal(signal.aborted, false); emit('status', '状态不得混入分析');
      const raw = JSON.stringify(study); emit('delta', raw.slice(0, 30)); emit('delta', raw.slice(30)); emit('done', '不得成为分析');
    },
    key: async (file: string) => { assert.equal(file, configuredPath); return VISUAL_GENE_SHA; },
  };
  const cold = (name: string) => (..._args: unknown[]): never => { ordinary.push(name); throw Error(`Unexpected cold port: ${name}`); };
  const env: Record<string, unknown> & { motionLibrary: { fixture: boolean } } = {
    PersonalizeVisualAuthoring, visualBehaviors, createHash, path, store, VISUAL_GENE_SHA, PROFILE_FOLDER: 'soft-hearts-claude',
    characterCards: { getActive: () => ({ id: characterId }) }, speechScope: () => state.scope,
    compileCharacterPersona: () => '合成角色卡', visionSupported: true,
    blushCalibrations: { keyForModel: (file: string) => state.key(file) },
    exiting: false, pending, asrTask: null, foregroundAsr: { foregroundBusy: false }, readingInputSpeech: false,
    voiceHost: { busy: false }, proactiveVision: { pendingId: null }, replySpeechBusy: () => false,
    ambientSpeakingOwners: new Set(), syncFatigueActivity: () => { state.syncs++; },
    controls, windows: () => [controls, pet], dialog: { showOpenDialog: async (...args: any[]) => { dialogCalls.push(args); return state.dialog; } },
    readSelectedVisualImage: async (file: string, signal: AbortSignal, transform: unknown) => {
      assert.equal(file, state.dialog.filePaths[0]); assert.equal(signal.aborted, false); assert.equal(typeof transform, 'function');
      readCalls.push([file, signal]);
      // This explicit seam substitutes image decoding. No NativeImage codec or source image is opened.
      const bytes = Buffer.from('synthetic-owned-transformed-material'), dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
      const row = { releases: 0, initialDataUrl: dataUrl, image: undefined as unknown as SelectedVisualImage };
      row.image = { dataUrl, previewDataUrl: 'data:image/jpeg;base64,c3ludGhldGljLXRodW1i', width: 640, height: 360,
        sha256: createHash('sha256').update(bytes).digest('hex'), release() { row.releases++; bytes.fill(0);
          this.dataUrl = ''; this.previewDataUrl = ''; this.sha256 = ''; } };
      images.push(row); return row.image;
    },
    nativeImage: { createFromBuffer: cold('native-codec') },
    app: { getPath: (name: string) => { assert.equal(name, 'temp'); return path.join(directory, 'synthetic-os-temp'); } },
    streamClaude: async (task: any, signal: AbortSignal, emit: (kind: string, text: string) => void) => {
      requests.push(structuredClone(task)); await state.stream(task, signal, emit);
    },
    streamChat: cold('other-provider'), launchTask: cold('ordinary-task'), send: cold('ordinary-stream'), broadcast: cold('ordinary-broadcast'),
    speechRuntime: new Proxy({}, { get: () => cold('TTS') }), reward: cold('reward'),
    companion: { memory: new Proxy({}, { get: () => cold('history') }), mood: { visualBehaviorChanged: (id: string) => changes.push(id) } },
    motionLibrary: { fixture: true },
    resolveBehaviorMotionResource: async (library: unknown, cue: VisualPreview['cue']) => {
      assert.equal(library, env.motionLibrary); const recipe = BEHAVIOR_RECIPES[cue.bindingId];
      return { cueId: cue.id, bindingId: cue.bindingId, packId: 'gene', motionId: recipe.motionId, sha256: recipe.sha256,
        durationMs: recipe.durationMs, recipe: 'emotion-face', path: path.join(directory, 'synthetic-reviewed-face.vmd') };
    },
    assets: { register: async (file: string) => { assert.equal(file, path.join(directory, 'synthetic-reviewed-face.vmd'));
      return { url: 'mmd-asset://synthetic/reviewed-face.vmd' }; } },
  };
  const api = evaluate<{ service: PersonalizeVisualAuthoring; reserve: reserve;
    setGeneration(value: number): void; receipt(): unknown }>(`
    let bodyModelGeneration=1,visualGeneReceipt=null;
    ${fn('reserveCompanionAuthoring')}
    ${fn('verifyVisualGeneTarget')}
    ${fn('verifyModelTarget')}
    const service=${constructors[0].getText(tree)};
    return {service,reserve:reserveCompanionAuthoring,setGeneration:value=>{bodyModelGeneration=value;},receipt:()=>visualGeneReceipt};`, env);
  const handlers = new Map<string, (event: any, ...args: any[]) => any>();
  evaluate(`${fn('scopedHost')}\n${variable('mutations')}\n${variable('mutate')}\n${registrations}`, {
    MutationQueue, controls, windows: () => [controls, pet], visualAuthoring: api.service,
    ipcMain: { handle: (key: string, handler: any) => handlers.set(key, handler) },
  });
  const event = { sender: { id: 1, mainFrame: frames.controls }, senderFrame: frames.controls };
  return { ...api, directory, characterId, controls, pet, frames, event, handlers, sent, state, store,
    pending, requests, changes, ordinary, images, dialogCalls, readCalls, visualBehaviors,
    invoke: (name: typeof ports[number], ...args: any[]) => handlers.get(`desk:${name}`)!(event, ...args),
    async close() {
      api.service.invalidate(); assert.equal(pending.size, 0, 'provider lease must settle before fixture cleanup');
      assert.deepEqual(ordinary, [], 'no ordinary provider, history, reward or TTS port was used');
      assert.equal(path.dirname(path.resolve(directory)), tempRoot); assert.ok(path.basename(directory).startsWith(prefix));
      assert.equal((await lstat(directory)).isSymbolicLink(), false); assert.equal(await realpath(directory), directory);
      await rm(directory, { recursive: true, force: false });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof make>>;
type reserve = (owner: number, id: string, controller: AbortController, source: 'language-authoring' | 'visual-authoring') => () => void;
async function fixture(run: (f: Fixture) => Promise<void>) { const f = await make(); try { await run(f); } finally { await f.close(); } }

test('actual Main constructor requires explicit single-image selection, then uses one fixed read-only Claude image request', async () => fixture(async f => {
  let current = await f.invoke('getVisualAuthoring', f.characterId) as VisualAuthoringState;
  assert.equal(f.dialogCalls.length, 0); assert.equal(f.requests.length, 0); assert.equal(current.material, null);
  for (const choice of [{ canceled: true, filePaths: ['synthetic-ignored'] }, { canceled: false, filePaths: [] },
    { canceled: false, filePaths: ['synthetic-one', 'synthetic-two'] }]) {
    f.state.dialog = choice; current = await f.invoke('chooseVisualMaterial', current.id, current.revision);
    assert.equal(current.material, null); assert.equal(f.readCalls.length, 0); assert.equal(f.requests.length, 0);
  }
  f.state.dialog = { canceled: false, filePaths: [path.join(f.directory, 'synthetic-selected.png')] };
  current = await f.invoke('chooseVisualMaterial', current.id, current.revision);
  assert.ok(current.material); assert.equal(current.material.source, 'selected-image'); assert.equal(f.requests.length, 0);
  assert.equal(f.visualBehaviors.get(f.characterId).revision, 0);
  await assert.rejects(readFile(path.join(f.directory, 'personalize-visual.json')), { code: 'ENOENT' });
  const [owner, options] = f.dialogCalls.at(-1)!; assert.equal(owner, f.controls);
  assert.deepEqual(options.properties, ['openFile']); assert.deepEqual(options.filters[0].extensions, ['png', 'jpg', 'jpeg', 'webp']);
  const researched = await f.invoke('researchVisual', request(current)) as VisualAuthoringState;
  assert.deepEqual(researched.study, study); assert.equal(f.requests.length, 1); assert.equal(f.pending.size, 0); assert.equal(f.state.syncs, 2);
  const task = f.requests[0];
  assert.deepEqual(Object.keys(task).sort(), ['kind', 'model', 'workingDirectory', 'writable', 'prompt', 'imageDataUrls', 'imageTemporaryRoot'].sort());
  assert.equal(task.kind, 'chat'); assert.equal(task.model, 'synthetic-visual-model'); assert.equal(task.writable, false);
  assert.deepEqual(task.imageDataUrls, [f.images[0].initialDataUrl]); assert.equal(task.workingDirectory, path.join(f.directory, 'chat'));
  assert.equal(task.imageTemporaryRoot, path.join(f.directory, 'synthetic-os-temp', 'soft-hearts-claude', 'selected-image-authoring'));
  assert.ok(task.prompt.includes('<selected-image-authoring-data>')); assert.equal(task.prompt.includes(f.state.dialog.filePaths[0]), false);
  assert.deepEqual(f.changes, []); assert.deepEqual(f.ordinary, []); assert.equal(f.visualBehaviors.get(f.characterId).revision, 0);
  await f.invoke('cancelVisualAuthoring', current.id); assert.equal(f.images[0].releases, 1);
}));

test('actual reserve rejects every busy source without aborting, queuing or changing existing work', () => {
  const cases: { name: string; change(env: any): void }[] = [
    { name: 'exit', change: e => { e.exiting = true; } }, { name: 'pending', change: e => { e.pending.set('old', { controller: new AbortController() }); } },
    { name: 'ASR task', change: e => { e.asrTask = {}; } }, { name: 'foreground ASR', change: e => { e.foregroundAsr.foregroundBusy = true; } },
    { name: 'reading input', change: e => { e.readingInputSpeech = true; } }, { name: 'voice group', change: e => { e.voiceHost.busy = true; } },
    { name: 'proactive vision', change: e => { e.proactiveVision.pendingId = 'old'; } }, { name: 'reply speech', change: e => { e.replySpeechBusy = () => true; } },
    { name: 'ambient speech', change: e => { e.ambientSpeakingOwners.add(2); } },
  ];
  for (const row of cases) {
    let syncs = 0; const env: any = { exiting: false, pending: new Map(), asrTask: null, foregroundAsr: { foregroundBusy: false },
      readingInputSpeech: false, voiceHost: { busy: false }, proactiveVision: { pendingId: null }, replySpeechBusy: () => false,
      ambientSpeakingOwners: new Set(), syncFatigueActivity: () => { syncs++; } };
    row.change(env); const before = [...env.pending.entries()], controller = new AbortController();
    const reserve = evaluate<reserve>(`${fn('reserveCompanionAuthoring')}\nreturn reserveCompanionAuthoring;`, env);
    assert.throws(() => reserve(1, 'new', controller, 'visual-authoring'), /不会打断或排队/, row.name);
    assert.deepEqual([...env.pending.entries()], before, row.name); assert.equal(controller.signal.aborted, false); assert.equal(syncs, 0);
  }
});

test('cancel aborts the actual research but retains its shared lease until the adapter really settles', async () => fixture(async f => {
  const begun = deferred<AbortSignal>(), settle = deferred<void>();
  f.state.stream = async (_task, signal, emit) => { begun.resolve(signal); await settle.promise; emit('delta', JSON.stringify(study)); };
  let current = await f.service.get(1, f.characterId); current = await f.service.choose(1, current.id, current.revision);
  const task = f.service.research(1, request(current)).then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    const activeSignal = await begun.promise; assert.equal(f.pending.size, 1);
    const [id, entry] = [...f.pending][0]; assert.equal(entry.owner, 1); assert.equal(entry.kind, 'chat'); assert.equal(entry.source, 'visual-authoring');
    assert.equal(entry.controller.signal, activeSignal);
    await f.invoke('cancelVisualAuthoring', current.id); assert.equal(activeSignal.aborted, true); assert.equal(f.images[0].releases, 1);
    assert.equal(f.pending.get(id), entry); assert.equal(f.state.syncs, 1);
    assert.throws(() => f.reserve(1, 'other', new AbortController(), 'visual-authoring'), /不会打断或排队/);
  } finally { settle.resolve(); await task; }
  const result = await task; assert.equal(result.value, null); assert.ok(result.error instanceof Error); assert.match(result.error.message, /研究已停止/);
  assert.equal(f.pending.size, 0); assert.equal(f.state.syncs, 2); assert.equal(f.visualBehaviors.get(f.characterId).revision, 0);
}));

test('actual scoped visual handlers deny pet, foreign and unknown senders and complete controls-only preview/save/disable/undo', async () => fixture(async f => {
  for (const name of ports) {
    const handler = f.handlers.get(`desk:${name}`)!;
    for (const event of [{ sender: { id: 2, mainFrame: f.frames.pet }, senderFrame: f.frames.pet },
      { ...f.event, senderFrame: {} }, { sender: { id: 999, mainFrame: {} }, senderFrame: {} }]) {
      assert.throws(() => handler(event, 'untrusted'), /未授权/, name);
    }
  }
  assert.equal(f.dialogCalls.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.visualBehaviors.get(f.characterId).revision, 0);
  let current = await f.invoke('getVisualAuthoring', f.characterId) as VisualAuthoringState;
  current = await f.invoke('chooseVisualMaterial', current.id, current.revision);
  current = await f.invoke('researchVisual', request(current));
  const preview = await f.invoke('previewVisualBinding', current.id, current.revision, selection()) as VisualPreview;
  assert.equal(preview.scope, 'personalize-visual-controls'); assert.equal(preview.mask, VISUAL_MASK); assert.equal(preview.modelUrl, f.store.current.model.url);
  const save = { sessionId: current.id, revision: preview.revision, savedRevision: 0, previewId: preview.id, previewToken: preview.token };
  await assert.rejects(f.invoke('saveVisualBehavior', save), /观看/);
  f.invoke('visualPreviewReceipt', { phase: 'bind', id: preview.id, token: preview.token, stageGeneration: 3 });
  const resource = await f.invoke('resolveVisualPreview', preview.id, preview.token, 3);
  assert.equal(Object.hasOwn(resource, 'path'), false); assert.equal(resource.url, 'mmd-asset://synthetic/reviewed-face.vmd');
  assert.equal(resource.cueId, preview.id); assert.equal(resource.bindingId, preview.selection.bindingId);
  f.invoke('visualPreviewReceipt', { phase: 'ready', id: preview.id, token: preview.token, stageGeneration: 3 });
  current = await f.invoke('saveVisualBehavior', save);
  assert.equal(current.saved.revision, 1); assert.equal(current.saved.profile.enabled, true);
  assert.deepEqual(f.changes, [f.characterId]);
  assert.deepEqual(f.sent, [[1, 'desk:visual-preview-cancelled', { id: preview.id, token: preview.token }]]);
  const persisted = JSON.parse(await readFile(path.join(f.directory, 'personalize-visual.json'), 'utf8'));
  assert.equal(persisted.entries.length, 1); assert.equal(persisted.entries[0].characterId, f.characterId);
  assert.equal(JSON.stringify(persisted).includes('synthetic-owned-transformed-material'), false);
  assert.equal(JSON.stringify(persisted).includes('data:image'), false);
  current = await f.invoke('changeVisualBehavior', { sessionId: current.id, revision: current.revision, kind: 'disable' });
  assert.equal(current.saved.profile.enabled, false); assert.equal(current.saved.revision, 2);
  current = await f.invoke('changeVisualBehavior', { sessionId: current.id, revision: current.revision, kind: 'undo' });
  assert.equal(current.saved.profile.enabled, true); assert.equal(current.saved.revision, 3);
  await f.invoke('cancelVisualAuthoring', current.id); assert.equal(f.images[0].releases, 1);
  await assert.rejects(f.invoke('resolveVisualPreview', preview.id, preview.token, 3), /失效/);
}));

test('actual constructor never substitutes another provider or probes a connection after Claude is unavailable', async () => fixture(async f => {
  f.store.current.provider = { kind: 'openai', model: 'synthetic-other-model' };
  let current = await f.service.get(1, f.characterId); assert.equal(current.imageSupported, false);
  current = await f.service.choose(1, current.id, current.revision);
  await assert.rejects(f.service.research(1, request(current)), /不会切换或探测/);
  assert.equal(f.requests.length, 0); assert.equal(f.pending.size, 0); assert.equal(f.state.syncs, 0);
  assert.deepEqual(f.store.current.provider, { kind: 'openai', model: 'synthetic-other-model' });
}));

test('actual preload exposes fixed visual data routes and removes the exact cancellation listener', async () => {
  const raw = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('preload.ts', raw, ts.ScriptTarget.Latest, true);
  const subscribe = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'subscribe'); assert.ok(subscribe);
  const calls: any[][] = [], listeners = new Map<string, (event: unknown, data: unknown) => void>();
  const api = evaluate<any>(`${variable('invoke', ast)}\n${subscribe.getText(ast)}\n${variable('api', ast)}\nreturn api;`, {
    ipcRenderer: { invoke: (...args: any[]) => { calls.push(args); return Promise.resolve(null); },
      on: (key: string, callback: any) => listeners.set(key, callback),
      removeListener: (key: string, callback: any) => { assert.equal(listeners.get(key), callback); listeners.delete(key); } },
  });
  const args: any[][] = [['card'], ['session', 2], [{ synthetic: 'research' }], ['session', 3, selection()],
    [{ phase: 'bind', id: 'preview', token: 'token', stageGeneration: 4 }], ['preview', 'token', 4],
    [{ synthetic: 'save' }], [{ synthetic: 'change' }], ['session']];
  for (let i = 0; i < ports.length; i++) await api[ports[i]](...args[i]);
  assert.deepEqual(calls, ports.map((name, i) => [`desk:${name}`, ...args[i]]));
  let received: unknown; const unsubscribe = api.onVisualPreviewCancelled((value: unknown) => { received = value; });
  const value = { id: 'preview', token: 'token' }; listeners.get('desk:visual-preview-cancelled')!({}, value);
  assert.equal(received, value); unsubscribe(); assert.equal(listeners.size, 0);
});

function targetFixture() {
  const store: any = { current: { model: { path: 'synthetic-configured-gene.pmx', url: 'mmd-asset://synthetic/gene' } } };
  let checks = 0; const waiting = deferred<string>();
  const target = evaluate<{ verify(): Promise<boolean>; generation(value: number): void; receipt(): unknown }>(`
    let bodyModelGeneration=7,visualGeneReceipt=null;
    ${fn('verifyVisualGeneTarget')}
    return {verify:verifyVisualGeneTarget,generation:value=>{bodyModelGeneration=value;},receipt:()=>visualGeneReceipt};`, {
    store, VISUAL_GENE_SHA, blushCalibrations: { keyForModel: (file: string) => { checks++; assert.equal(file, 'synthetic-configured-gene.pmx'); return waiting.promise; } },
  });
  return { ...target, store, waiting, checks: () => checks };
}
test('actual Gene target verifier accepts only the configured content result and stores exact path/url/generation', async () => {
  const f = targetFixture(), pending = f.verify(); assert.equal(f.checks(), 1); assert.equal(f.receipt(), null);
  f.waiting.resolve(VISUAL_GENE_SHA); assert.equal(await pending, true);
  assert.deepEqual(f.receipt(), { path: 'synthetic-configured-gene.pmx', url: 'mmd-asset://synthetic/gene', generation: 7 });
});
for (const reason of ['path', 'url', 'generation', 'removed-model', 'wrong-hash'] as const) {
  test(`actual Gene target verifier rejects ${reason} changing during its asynchronous check`, async () => {
    const f = targetFixture(), pending = f.verify();
    if (reason === 'path') f.store.current.model.path = 'synthetic-different-gene.pmx';
    if (reason === 'url') f.store.current.model.url = 'mmd-asset://synthetic/different-gene';
    if (reason === 'generation') f.generation(8);
    if (reason === 'removed-model') f.store.current.model = null;
    f.waiting.resolve(reason === 'wrong-hash' ? '0'.repeat(64) : VISUAL_GENE_SHA);
    assert.equal(await pending, false);
    // I-038: another model's content still gets the receipt (pose and brow/eye picks map onto it); it is just not Gene.
    if (reason === 'wrong-hash') assert.deepEqual(f.receipt(), { path: 'synthetic-configured-gene.pmx', url: 'mmd-asset://synthetic/gene', generation: 7 });
    else assert.equal(f.receipt(), null);
  });
}
test('actual Gene target verifier refuses absent models without calibration and generalizes lookup failure', async () => {
  const missing = targetFixture(); missing.store.current.model = null;
  assert.equal(await missing.verify(), false); assert.equal(missing.checks(), 0); assert.equal(missing.receipt(), null);
  const failure = evaluate<() => Promise<boolean>>(`let bodyModelGeneration=1,visualGeneReceipt=null;${fn('verifyVisualGeneTarget')}\nreturn verifyVisualGeneTarget;`, {
    store: { current: { model: { path: 'synthetic-private-path', url: 'mmd-asset://synthetic/private' } } }, VISUAL_GENE_SHA,
    blushCalibrations: { keyForModel: async () => { throw Error('synthetic internal failure'); } },
  });
  assert.equal(await failure(), false);
});
