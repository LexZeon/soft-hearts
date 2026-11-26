// 舞台的接线 (wiring rewrite step 4g, docs/claude/2026-11-16-wiring-step-4g.md): what the user sees of her. Only the companion window may change its
// own pointer input, drag or resize itself, show a reply bubble or report its presentation; a stale drag finish or a stale her-life motion is
// refused; the companion's crash resets its pointer input and drag and makes old body receipts stale; the topmost guard and the taskbar listeners
// stop with the companion; the single emoji waits while she is dragged and follows the body model; the expression preview goes to every window's
// stage; a settings sync always applies the companion window's settings (with Unbound's override) and moves the reply and emoji windows along; the
// published body pose checks its receipt, its retired cues and an edit in progress; the model check's haiku stays a read-only chat call.
// Each test evaluates the wiring's actual text (tests/helpers/wiring-source.ts: across electron/main.ts and electron/wiring/*.ts, so it
// follows the code when it moves) over fakes. Before this file several of these checks had no test that failed when the check was removed
// (the mutation table in the record).
// Reads as text (test-affected selects this test when they change): 'electron/main.ts', 'electron/wiring/stage-wiring.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { companionHiddenStep } from '../electron/stage/companion-hidden';
import { leaveClearsVision, abortsWithClosedWindow } from '../shared/foundation/step-away';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { quickLineWithClaude } from '../electron/initiative/inner-loop/model';
import { WIRING_PRELUDE, windowEventsSource, wiringFunction, wiringHandler, wiringNodes, wiringOption, wiringSource } from './helpers/wiring-source';

/** Evaluates `body` (statements ending in a return) with the prelude and `env`'s names in scope. */
function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
const expression = <T>(text: string, env: Record<string, unknown>): T => evaluate<T>(`return (${text});`, env);
const handler = <T>(name: string, env: Record<string, unknown>): T => expression<T>(wiringHandler(name), env);
const option = <T>(variable: string, name: string, env: Record<string, unknown>): T => expression<T>(wiringOption(variable, name), env);
type Win = { webContents: { id: number; send: (...args: unknown[]) => void }; isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean };
function win(id: number, state: { visible?: boolean; minimized?: boolean; focused?: boolean; destroyed?: boolean; sent?: unknown[][] } = {}): Win {
  return { webContents: { id, send: (...args: unknown[]) => { state.sent?.push(args); } }, isDestroyed: () => state.destroyed === true,
    isVisible: () => state.visible !== false, isMinimized: () => state.minimized === true, isFocused: () => state.focused !== false };
}
/** The listeners the wiring registers with `<target>.on('<event>', listener)` (inline arrows only), as text. */
function listeners(target: string, event: string): string[] {
  return wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'on' && node.expression.expression.getText() === target && !!node.arguments[0]
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === event)
    .map(row => row.node.arguments[1]).filter((arg): arg is ts.ArrowFunction => !!arg && ts.isArrowFunction(arg)).map(arg => arg.getText());
}

// ---------------------------------------------------------------- pointer input, dragging, the reply bubble, presentation: the companion window only

test('pointer input (click-through only around her): only the pet window may change its own, and only while it exists', () => {
  const asked: unknown[] = [];
  const pet = win(2), controls = win(1);
  const env = { pet, controls, petPointerInput: { request: (receive: unknown) => { asked.push(receive); return `ok:${String(receive)}`; } } };
  const set = handler<(sender: number, receive: unknown) => unknown>('setPetPointerInput', env);
  assert.throws(() => set(1, true), /只有桌宠窗口/u, 'the control window cannot change the pet\'s pointer input');
  assert.throws(() => set(3, true), /只有桌宠窗口/u);
  assert.equal(set(2, true), 'ok:true');
  assert.deepEqual(asked, [true]);
  const gone = handler<(sender: number, receive: unknown) => unknown>('setPetPointerInput', { ...env, pet: win(2, { destroyed: true }) });
  assert.throws(() => gone(2, false), /只有桌宠窗口/u);
});

test('dragging and resizing: only the focused, shown pet window starts one; it ends her direct contact and counts as the user being there', () => {
  const log: string[] = [];
  const make = (state: Parameters<typeof win>[1]) => {
    const drag = { active: false, start: (operation: string) => { log.push(`start ${operation}`); drag.active = true; } };
    const env = { pet: win(2, state), petWindowDrag: drag, companion: { mood: { cancelInteraction: () => { log.push('cancel contact'); } } },
      noteVisionUserActivity: () => { log.push('activity'); }, finishPetWindowOperation: async () => { log.push('finish'); } };
    return evaluate<{ op: (sender: number, operation: unknown) => unknown; revision: () => number }>(
      `let windowOperationRevision = 0; const op = (${wiringHandler('setPetWindowOperation')}); return { op, revision: () => windowOperationRevision };`, env);
  };
  const ok = make({});
  assert.throws(() => ok.op(1, 'move'), /只有桌宠窗口/u, 'the control window cannot drag the pet');
  assert.throws(() => ok.op(2, 'sideways'), /窗口操作不正确/u);
  assert.deepEqual(log, []);
  ok.op(2, 'move');
  assert.deepEqual(log, ['cancel contact', 'activity', 'start move']);
  assert.equal(ok.revision(), 1, 'a new drag makes an older finish stale');
  log.length = 0;
  for (const state of [{ focused: false }, { visible: false }, { minimized: true }]) assert.throws(() => make(state).op(2, 'move'), /请先激活桌宠窗口/u, JSON.stringify(state));
  assert.deepEqual(log, [], 'nothing starts on an unfocused, hidden or minimized pet');
});

test('a drag\'s finish that arrives after the pet was recovered or hidden is not written into the settings', async () => {
  const persisted: unknown[] = [], synced: unknown[] = [];
  const box: { queued: (() => Promise<unknown>) | null } = { queued: null };
  const store = { current: { pet: { scale: 1, size: undefined } }, persist: async (next: unknown) => { persisted.push(next); } };
  const env = { pet: win(2), store, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 100, height: 100 } }) },
    petWindowDrag: { stop: () => ({ operation: 'nw', bounds: { x: 0, y: 0, width: 50, height: 60 } }) },
    fittedPetScale: () => 0.5, sizedPetBounds: (bounds: unknown) => bounds,
    mutate: (operation: () => Promise<unknown>) => { box.queued = operation; return Promise.resolve(); }, sync: () => { synced.push(1); } };
  const api = evaluate<{ finish: () => Promise<void>; bump: () => void }>(
    `let windowOperationRevision = 0; ${wiringFunction('finishPetWindowOperation')} return { finish: finishPetWindowOperation, bump: () => { windowOperationRevision++; } };`, env);
  await api.finish();
  assert.ok(box.queued, 'the finish is queued');
  api.bump(); // a recovery (or the settings hiding her) happened while the finish waited in the queue
  await box.queued!();
  assert.deepEqual(persisted, [], 'a stale finish writes nothing');
  assert.deepEqual(synced, []);
  box.queued = null;
  await api.finish();
  await box.queued!();
  assert.equal(persisted.length, 1, 'a current finish is written');
});

test('找回桌宠 (recoverPet): a drag in progress ends and its late finish is stale; she comes back pinned on top and presented', async () => {
  const log: string[] = [], persisted: { pet: { alwaysOnTop: boolean } }[] = [];
  const pet = { ...win(2), webContents: { id: 2, send: (channel: string) => { log.push(channel); } } };
  const env = { pet, controls: null, companionCommands: { invalidate: () => { log.push('commands.invalidate'); } }, unbound: { exit: () => { log.push('unbound.exit'); } },
    petWindowDrag: { cancel: () => { log.push('drag.cancel'); } }, screen: { getDisplayNearestPoint: () => ({ workArea: {} }), getCursorScreenPoint: () => ({}) },
    petRecovery: () => ({ settings: { pet: { alwaysOnTop: false, scale: 1 } }, bounds: 'bounds' }), mutate: (operation: () => Promise<unknown>) => operation(),
    store: { current: { pet: { alwaysOnTop: false } }, persist: async (next: { pet: { alwaysOnTop: boolean } }) => { persisted.push(next); return 'saved'; } },
    noteCompanionTopmostWrite: () => {}, sync: () => { log.push('sync'); }, petPresentation: { recover: (_w: unknown, bounds: string) => { log.push(`recover ${bounds}`); } } };
  const api = evaluate<{ recover: () => Promise<unknown>; revision: () => number }>(
    `let windowOperationRevision = 0, appliedPetScale; const recover = (${wiringHandler('recoverPet')}); return { recover, revision: () => windowOperationRevision };`, env);
  assert.equal(await api.recover(), 'saved');
  assert.equal(api.revision(), 1, 'a drag finish from before the recovery is stale');
  assert.deepEqual(persisted.map(next => next.pet.alwaysOnTop), [true]);
  assert.deepEqual(log, ['commands.invalidate', 'unbound.exit', 'drag.cancel', 'sync', 'recover bounds', 'desk:pet-recovered']);
});

test('the reply bubble and the presentation samples come from the pet window only; a shown line reaches the text memorials', () => {
  const told: string[] = [], updates: unknown[] = [];
  const env = { pet: win(2), petReply: { update: (patch: unknown) => { updates.push(patch); return 'linger'; } },
    textMemorialHost: { displayTextChanged: (text: string) => { told.push(text); } }, validateReplyUpdate: (value: unknown) => value };
  const update = handler<(sender: number, value: unknown) => unknown>('updatePetReply', env);
  assert.throws(() => update(1, { state: 'complete', text: '你好' }), /只有桌宠窗口/u);
  assert.deepEqual(updates, []);
  assert.equal(update(2, { state: 'complete', text: '你好' }), 'linger');
  assert.deepEqual(told, ['你好']);
  const samples: unknown[] = [];
  const report = handler<(sender: number, sample: unknown) => unknown>('reportPetPresentation', { pet: win(2), petPresentation: { noteRenderer: (sample: unknown) => { samples.push(sample); } } });
  assert.throws(() => report(1, { shown: true }), /未授权/u);
  report(2, { shown: true });
  assert.deepEqual(samples, [{ shown: true }]);
});

test('showing her keeps the presentation armed (R37); topmost can only be set from the control window or the pet itself', async () => {
  const armed: string[] = [];
  const show = handler<(visible: unknown) => Promise<unknown>>('setPetVisible', { mutate: (operation: () => Promise<unknown>) => operation(),
    commitCompanionVisibility: async () => ({ persistence: 'committed', presentation: 'applied' }), petPresentation: { arm: (why: string) => { armed.push(why); } },
    publicSettings: () => 'settings', store: { current: {} } });
  await show(false);
  assert.deepEqual(armed, []);
  await show(true);
  assert.deepEqual(armed, ['show']);
  const controls = win(1), pet = win(2), third = win(3), persisted: unknown[] = [];
  const top = handler<(sender: number, enabled: unknown) => Promise<unknown>>('setPetAlwaysOnTop', { controls, pet, windows: () => [controls, pet, third],
    mutate: (operation: () => Promise<unknown>) => operation(), store: { current: { pet: { alwaysOnTop: false } }, persist: async (next: unknown) => { persisted.push(next); return next; } },
    publicSettings: () => 'same', noteCompanionTopmostWrite: () => {}, sync: () => {} });
  await assert.rejects(top(3, true), /未授权/u, 'a third window cannot pin her');
  assert.deepEqual(persisted, []);
  await top(2, true);
  assert.equal(persisted.length, 1);
});

// ---------------------------------------------------------------- the companion's crash, close and hide

/**
 * secureWindow's subscriber (windowEvents) on a fake window: its listeners by event, the effects logged. Step 5b: the listeners are
 * electron/main.ts's order (wireWindowEvents) and every step's actual text (tests/helpers/wiring-source.ts windowEventsSource).
 */
function windowEvents(owner: 'pet' | 'controls') {
  const log: string[] = [];
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const on = (event: string, fn: (...args: unknown[]) => void) => { handlers.set(event, [...handlers.get(event) ?? [], fn]); };
  const window = { on, webContents: { id: 2, on, send: () => {} }, isDestroyed: () => false, isVisible: () => false, isMinimized: () => false };
  const noop = () => {};
  const env: Record<string, unknown> = {
    motionWeights: null, ambientSpeakingOwners: new Set(), ambientAudio: null, ambientComments: null, audioCapture: null, suspendAmbientSpeech: noop,
    clearVisionContext: noop, media: { state: {}, dropOwner: noop, update: noop }, mediaChanged: noop, proactiveVision: { pendingId: null }, lookAttachments: { busy: false },
    codexTasks: null, surprisePreviewHost: null, voiceHost: { capture: null }, revokeVoice: noop, companion: { mood: { cancelBodyPresentation: noop, setBodyVisible: noop, invalidate: noop } },
    companionHiddenStep, leaveClearsVision, abortsWithClosedWindow, herOnScreen: () => false, cancelCompletedReply: noop, petWindowDrag: { cancel: () => { log.push('drag.cancel'); } }, petPointerInput: { reset: () => { log.push('pointer.reset'); } },
    stopSystemAudio: noop, speechRuntime: { dropOwner: noop }, dropReplySpeechOwner: noop, companionCommands: null, textMemorialHost: null,
    onScreen: () => false, nativeVisibility: () => ({}), voiceCall: { check: noop }, store: { current: { pet: { visible: true } } }, refreshVisionContext: noop,
    guardWindowNavigation: noop, languageAuthoring: null, visualAuthoring: null, bodyAuthoring: null, characterStickerHost: null, motionDownloadOwner: null,
    motionLibrary: { cancel: noop }, pending: new Map(), controls: null, queueMicrotask: noop,
  };
  const api = evaluate<{ subscribe: (win: unknown, owner: string, id: number) => void; generation: () => number }>(
    `let cameraEnabled = false, bodyModelGeneration = 0;
     function bumpBodyModelGeneration() { bodyModelGeneration++; }
     ${windowEventsSource(['guardWindowNavigation'])}
     ${wiringFunction('releaseCameraOnLeave')} // I-174: the camera step's body lives in the look wiring now
     return { subscribe: windowEvents, generation: () => bodyModelGeneration };`, env);
  api.subscribe(window, owner, 2);
  const fire = (event: string) => { for (const fn of handlers.get(event) ?? []) fn({ isMainFrame: true, isSameDocument: false }); };
  return { log, fire, generation: api.generation };
}

test('the pet\'s renderer gone: its pointer input and drag are reset and old body receipts become stale', () => {
  const pet = windowEvents('pet');
  pet.fire('render-process-gone');
  assert.ok(pet.log.includes('pointer.reset'), 'the pointer input is reset (the new page starts letting the mouse through)');
  assert.ok(pet.log.includes('drag.cancel'), 'a drag in progress ends');
  assert.ok(pet.generation() > 0, 'the body model generation moves on');
  const controls = windowEvents('controls');
  controls.fire('render-process-gone');
  assert.deepEqual(controls.log, [], 'the control window\'s crash leaves the pet alone');
  const hidden = windowEvents('pet');
  hidden.fire('hide');
  assert.ok(hidden.log.includes('pointer.reset'), 'hiding the pet resets its pointer input');
});

test('when the pet window closes, the topmost guard stops, a drag ends and the taskbar listeners are removed', () => {
  const log: string[] = [];
  const env = { petWindowDrag: { cancel: () => { log.push('drag.cancel'); } }, topmostGuard: { stop: () => { log.push('topmost.stop'); } },
    keepInArea: () => {}, screen: { removeListener: (event: string) => { log.push(`removeListener ${event}`); } }, claudeChat: { noteVisible: () => {} },
    petPresentation: { note: () => {} } };
  for (const listener of listeners('pet', 'closed')) expression<() => void>(listener, env)();
  for (const effect of ['topmost.stop', 'drag.cancel', 'removeListener display-metrics-changed', 'removeListener display-removed'])
    assert.ok(log.includes(effect), `${effect} (got ${log.join(', ')})`);
});

test('the topmost guard is started and returns her to the top of the band at her own moments: shown, restored, focused', () => {
  const text = wiringSource();
  assert.match(text, /topmostGuard\.start\(\);/);
  const own = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === 'pet.on'
    && !!node.arguments[1] && node.arguments[1].getText() === 'ownMoment').map(row => (row.node.arguments[0] as ts.StringLiteral).text).sort();
  assert.deepEqual(own, ['focus', 'restore', 'show']);
});

// ---------------------------------------------------------------- the single emoji

test('single emoji: never while she is dragged or hidden, and a new body model or a hidden pet drops a waiting one', () => {
  const available = (pet: Win, active: boolean) => option<() => boolean>('singleEmojiCues', 'available', { pet, store: { current: { model: {} } }, petWindowDrag: { active } })();
  assert.equal(available(win(2), false), true);
  assert.equal(available(win(2), true), false, 'not while she is dragged');
  assert.equal(available(win(2, { visible: false }), false), false);
  assert.equal(available(win(2, { minimized: true }), false), false);
  let invalidated = 0;
  for (const event of ['hide', 'minimize']) {
    const before = invalidated;
    for (const listener of listeners('pet', event)) {
      try { expression<() => void>(listener, { singleEmojiCues: { invalidate: () => { invalidated++; } }, petPresentation: { note: () => {} }, claudeChat: { noteVisible: () => {} } })(); } catch { /* other listeners' fakes */ }
    }
    assert.ok(invalidated > before, `a waiting emoji is dropped on ${event}`);
  }
  const context = (generation: number) => evaluate<string>(`const bodyModelGeneration = ${generation}; ${wiringFunction('singleEmojiContext')} return singleEmojiContext();`,
    { speechScope: () => 's', store: { current: { model: { url: 'u' } } }, companion: { mood: { get: () => ({ token: 't' }) } } });
  assert.notEqual(context(1), context(2), 'the context follows the body model generation');
});

test('a user\'s message drops a waiting single emoji (only a readout control does not)', () => {
  const chat = wiringHandler('chat');
  const ast = ts.createSourceFile('chat.ts', `const chat = ${chat};`, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === '!readoutControl' && ts.isBlock(node.thenStatement)
      && node.thenStatement.statements.some(st => st.getText(ast) === 'singleEmojiCues?.invalidate();')) found = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, 'the chat turn invalidates the single emoji unless it is a readout control');
});

// ---------------------------------------------------------------- the model check (I-024) and its 试一下

test('试一下 goes only to a shown pet, and only the pet\'s answer counts', () => {
  const sent: unknown[][] = [];
  const send = (pet: Win) => option<(request: unknown) => boolean>('capabilityPreview', 'send', { pet })({ id: 'r' });
  assert.equal(send(win(2, { sent })), true);
  assert.deepEqual(sent, [['desk:model-capability-preview', { id: 'r' }]]);
  sent.length = 0;
  for (const state of [{ visible: false }, { minimized: true }, { destroyed: true }]) assert.equal(send(win(2, { ...state, sent })), false, JSON.stringify(state));
  assert.deepEqual(sent, []);
  const petSender = option<() => number | null>('capabilityPreview', 'petSender', { pet: win(2), controls: win(1) });
  assert.equal(petSender(), 2);
});

test('the model check\'s haiku is a read-only chat call (no writing, no tools) and waits while Claude is unavailable', async () => {
  const calls: unknown[][] = [];
  const ask = option<(prompt: string, system: string, signal: AbortSignal) => unknown>('modelCapabilities', 'ask', {
    quickLineWithClaude: (...args: unknown[]) => { calls.push(args); return 'line'; },
    streamClaude: () => { throw new Error('the model check calls Claude only through quickLineWithClaude'); } });
  const signal = new AbortController().signal;
  assert.equal(ask('names', 'system', signal), 'line');
  assert.deepEqual(calls, [['names', 'system', signal]], 'no stream of its own: quickLineWithClaude\'s read-only default');
  // quickLineWithClaude's own call: a chat call, not writable, no tools.
  const tasks: Record<string, unknown>[] = [];
  await quickLineWithClaude('p', 's', signal, async task => { tasks.push(task as unknown as Record<string, unknown>); return null; });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, 'chat');
  assert.equal(tasks[0].writable, false);
  assert.ok(!('tools' in tasks[0]) && !('allowedTools' in tasks[0]));
  const available = (on: boolean) => option<() => boolean>('modelCapabilities', 'available', { chatAvailability: { isAvailable: () => on } })();
  assert.equal(available(false), false);
  assert.equal(available(true), true);
});

test('personalize authoring\'s Claude calls are chat calls that never write', async () => {
  const tasks: Record<string, unknown>[] = [];
  const env = { store: { directory: 'd', current: { provider: { kind: 'claude', model: 'm' } } }, path: { join: (...parts: string[]) => parts.join('/') },
    app: { getPath: () => 't' }, PROFILE_FOLDER: 'p', streamClaude: async (task: Record<string, unknown>) => { tasks.push(task); } };
  const signal = new AbortController().signal;
  await option<(prompt: string, signal: AbortSignal, append: (text: string) => void) => Promise<void>>('visualAuthoring', 'streamText', env)('x', signal, () => {});
  await option<(prompt: string, image: string, signal: AbortSignal, append: (text: string) => void) => Promise<void>>('visualAuthoring', 'stream', env)('x', 'data:', signal, () => {});
  await option<(prompt: string, image: string, signal: AbortSignal, append: (text: string) => void) => Promise<void>>('bodyAuthoring', 'stream', env)('x', 'data:', signal, () => {});
  assert.equal(tasks.length, 3);
  for (const task of tasks) { assert.equal(task.kind, 'chat'); assert.equal(task.writable, false); }
});

// ---------------------------------------------------------------- her-life motions (only the one pinned to the state she is in now)

test('her-life motion: refused for another token, a motion the state does not pin, or a state that changed while it was being resolved', async () => {
  let token = 't1';
  const allowed = new Set(['walk']);
  const make = (changeAt: 'resolve' | 'register' | null) => handler<(motionId: string, token: unknown) => Promise<Record<string, unknown>>>('resolveHerLifeMotion', {
    companion: { mood: { get: () => ({ token }) } }, herLifeMotionAllowed: (id: string) => allowed.has(id), motionLibrary: {},
    resolveHerLifeMotionResource: async () => { if (changeAt === 'resolve') token = 't2'; return { id: 'walk', path: '/local/walk.vmd', sha256: 'x' }; },
    assets: { register: async () => { if (changeAt === 'register') token = 't2'; return { url: 'mmd-asset://walk' }; } } });
  const ok = await make(null)('walk', 't1');
  assert.deepEqual(ok, { id: 'walk', sha256: 'x', url: 'mmd-asset://walk' }, 'the window gets the asset url, never the local path');
  await assert.rejects(make(null)('walk', 'old'), /已结束/u, 'another token');
  await assert.rejects(make(null)('run', 't1'), /已结束/u, 'a motion this state does not pin');
  await assert.rejects(make('resolve')('walk', 't1'), /已结束/u, 'the state changed while the motion was resolved');
  token = 't1';
  await assert.rejects(make('register')('walk', 't1'), /已结束/u, 'the state changed while the asset was registered');
});

// ---------------------------------------------------------------- the expression preview (E1)

test('the expression preview goes to every window\'s stage, and says whether the pet could show it', () => {
  const sent: unknown[][] = [], broadcasts: unknown[][] = [];
  let ports: { send(value: unknown): void; petVisible(): boolean } | null = null;
  const env = (pet: Win) => ({ pet, broadcast: (...args: unknown[]) => { broadcasts.push(args); },
    relayExpressionPreview: (_recipe: unknown, given: typeof ports) => { ports = given; return { petVisible: given!.petVisible() }; } });
  const play = (pet: Win) => evaluate<(recipe: unknown) => { petVisible: boolean }>(`${wiringFunction('playExpressionPreview')} return playExpressionPreview;`, env(pet));
  assert.equal(play(win(2, { sent }))({}).petVisible, true);
  ports!.send({ recipe: 1 });
  assert.deepEqual(broadcasts, [['desk:expression-preview', { recipe: 1 }]], 'every window (broadcast), not one');
  assert.deepEqual(sent, []);
  assert.equal(play(win(2, { visible: false }))({}).petVisible, false);
  assert.equal(play(win(2, { minimized: true }))({}).petVisible, false);
});

// ---------------------------------------------------------------- the settings sync's companion window step

test('settings sync: the pet window always takes its settings (with Unbound\'s override and the pointer input), the reply and emoji windows follow', () => {
  const log: string[] = [];
  const make = (dragging: boolean) => evaluate<{ sync: (s: unknown) => void; revision: () => number }>(
    `let appliedPetScale = 1, appliedPetSize = 'null', windowOperationRevision = 0; ${wiringFunction('syncPetWindow')} return { sync: syncPetWindow, revision: () => windowOperationRevision };`, {
      pet: { ...win(2), getBounds: () => ({ x: 0, y: 0, width: 400, height: 560 }), setBounds: () => { log.push('setBounds'); } },
      petWindowDrag: { active: dragging, cancel: () => { log.push('drag.cancel'); } }, screen: { getDisplayMatching: () => ({ workArea: {} }) },
      sizedPetBounds: () => ({}), scaledPetBounds: () => ({ scale: 1, bounds: {} }),
      unbound: { petSettings: (pet: { visible: boolean }) => ({ ...pet, unbound: true }) }, petPointerInput: { pointer: true },
      applyPetWindowSettings: (_win: unknown, settings: { unbound?: boolean }, pointer: { pointer?: boolean }) => { log.push(`apply unbound=${settings.unbound} pointer=${pointer?.pointer}`); },
      keepPetInWorkArea: () => { log.push('keepInArea'); }, petReply: { sync: () => { log.push('reply.sync'); } }, singleEmojiWindow: { sync: () => { log.push('emoji.sync'); } } });
  const settings = (visible: boolean) => ({ pet: { visible, scale: 1 } });
  make(false).sync(settings(true));
  assert.deepEqual(log, ['apply unbound=true pointer=true', 'keepInArea', 'reply.sync', 'emoji.sync']);
  log.length = 0;
  const dragged = make(true);
  dragged.sync(settings(false));
  assert.deepEqual(log, ['drag.cancel', 'apply unbound=true pointer=true', 'reply.sync', 'emoji.sync'], 'hiding her ends a drag; no taskbar move mid-drag');
  assert.equal(dragged.revision(), 1, 'the ended drag\'s finish is stale');
});

test('settings sync: every window is told its own visibility', () => {
  const sent: unknown[][] = [];
  const windows = () => [win(1, { sent }), win(2, { sent })];
  const sync = evaluate<() => void>(`${wiringFunction('publishWindowVisibility')}\n${wiringFunction('syncWindowVisibility')} return syncWindowVisibility;`,
    { windows, nativeVisibility: (w: Win) => ({ of: w.webContents.id }) });
  sync();
  assert.deepEqual(sent, [['desk:visibility', { of: 1 }], ['desk:visibility', { of: 2 }]]);
});

// ---------------------------------------------------------------- her body pose in the published view

test('a window reading her mood gets the view with her body pose (withBodyPose), as the published one does', () => {
  const get = handler<() => unknown>('getMood', { companion: { mood: { get: () => ({ token: 't' }) } }, withBodyPose: (view: object) => ({ ...view, posed: true }) });
  assert.deepEqual(get(), { token: 't', posed: true });
});

test('body pose: only with a current Gene receipt, never a retired cue, never while an edit is being applied', () => {
  const calls: unknown[][] = [];
  const pose = (state: { generation?: number; retired?: string[]; blocked?: boolean }) => evaluate<{ bodyPose: unknown }>(
    `const bodyModelGeneration = 3, bodyPosePublishingBlocked = ${state.blocked === true}; const retiredBodyPoseCues = new Set(${JSON.stringify(state.retired ?? [])});
     const visualGeneReceipt = { path: 'p', url: 'u', generation: ${state.generation ?? 3} };
     ${wiringFunction('withBodyPose')} return withBodyPose({ characterId: 'c', token: 't', behavior: 'b' });`, {
      store: { current: { model: { path: 'p', url: 'u' } } }, bodyBehaviors: { effectiveProfile: () => ({ bindingId: 'x' }) }, VISUAL_GENE_SHA: 'gene',
      bodyBindingForProfile: () => 'binding', bodyPoseBinding: () => 'raw',
      selectBodyPosePresentation: (...args: unknown[]) => { calls.push(args); return args[1] ? { cueId: 'cue' } : null; } });
  assert.deepEqual(pose({}).bodyPose, { cueId: 'cue' });
  assert.equal(pose({ generation: 2 }).bodyPose, null, 'a receipt from an older body model generation verifies nothing');
  assert.equal(pose({ retired: ['t:cue'] }).bodyPose, null, 'a cue retired by an edit is not sent again');
  assert.equal(pose({ blocked: true }).bodyPose, null, 'not while an edit is being applied');
});

// ---------------------------------------------------------------- what is on screen

test('on screen: the pet held while she is out in Unbound still counts; her line can show in her Unbound bubble; one display proof', () => {
  const onScreen = (pet: Win, held: boolean, target: Win = pet) => expression<(w: Win) => boolean>(wiringNodes((node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && node.name.getText() === 'onScreen' && !!node.initializer)[0].node.initializer!.getText(), { pet, petHeld: () => held })(target);
  const hidden = win(2, { visible: false });
  assert.equal(onScreen(hidden, true), true, 'held while she is out');
  assert.equal(onScreen(hidden, false), false);
  const other = win(1, { visible: false });
  assert.equal(onScreen(hidden, true, other), false, 'only the pet window is held');
  const herOnScreen = (pet: Win | null, canShow: boolean) => evaluate<boolean>(`${wiringFunction('herOnScreen')} return herOnScreen();`, { pet, unbound: { readAloud: { canShow: () => canShow } } });
  assert.equal(herOnScreen(hidden, true), true);
  assert.equal(herOnScreen(hidden, false), false);
  const surface = (state: string) => evaluate<unknown>(`${wiringFunction('replySurface')} return replySurface();`, { petReply: 'pet-bubble', unbound: { state, readAloud: 'unbound-bubble' } });
  assert.equal(surface('unbound'), 'unbound-bubble');
  assert.equal(surface('normal'), 'pet-bubble');
  const visibility = handler<(sender: number) => unknown>('getWindowVisibility', { windows: () => [win(1), win(2)], nativeVisibility: () => 'state' });
  assert.equal(visibility(2), 'state');
  assert.throws(() => visibility(9), /尚未就绪/u);
});

test('follow the mouse: the pointer is reported only while the setting is on', () => {
  const pointer = (follow: boolean) => handler<() => { x: number; y: number }>('pointer', { store: { current: { pet: { followMouse: follow } } },
    pet: { getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) }, screen: { getCursorScreenPoint: () => ({ x: 100, y: 0 }) } })();
  assert.deepEqual(pointer(false), { x: 0, y: 0 });
  assert.deepEqual(pointer(true), { x: 1, y: 1 });
});

test('show / hide her: a click-through pet comes back clickable', async () => {
  const persisted: { pet: { visible: boolean; clickThrough: boolean } }[] = [];
  const toggle = evaluate<(recover?: boolean) => Promise<void>>(`${wiringFunction('togglePet')} return togglePet;`, {
    unbound: null, mutate: (operation: () => Promise<unknown>) => operation(), sync: () => {},
    store: { current: { pet: { visible: true, clickThrough: true } }, persist: async (next: { pet: { visible: boolean; clickThrough: boolean } }) => { persisted.push(next); } } });
  await toggle(true);
  assert.deepEqual(persisted.map(next => next.pet), [{ visible: true, clickThrough: false }]);
});

// ---------------------------------------------------------------- the stage wiring module itself (after the move)

test('the stage wiring, evaluated with stubbed imports: after wireStage its mood publish step and sync step refresh the single emoji', (t) => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'wiring', 'stage-wiring.ts');
  if (!fs.existsSync(file)) { t.skip('before the move (step 4g) the stage wiring was electron/main.ts'); return; }
  const calls: string[] = [];
  /** Every import is a module whose every export is a recording class (constructible and callable). */
  const stubModule = () => new Proxy({}, { get: (_target, key) => {
    if (key === '__esModule') return true;
    const name = String(key);
    return function Stub() { return new Proxy({}, { get: (_t, method) => (..._args: unknown[]) => { calls.push(`${name}.${String(method)}`); return method === 'emojiExclusions' ? [] : undefined; } }); };
  } });
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> };
  new Function('require', 'module', 'exports', js)(() => stubModule(), module, module.exports);
  const stage = module.exports;
  let token = 't1';
  stage.wireStage({ speechScope: () => 's', store: { current: { model: { url: 'u' } } }, companion: { mood: { get: () => ({ token }) } } });
  stage.startStageWindows({ on: () => {} }, { setEmojiLayoutListener: () => {}, emojiExclusions: () => [] });
  stage.publishEmojiContext(); // the first context is only observed
  calls.length = 0;
  token = 't2';
  stage.publishEmojiContext();
  assert.deepEqual(calls.filter(call => call.startsWith('SingleEmojiCues.')), ['SingleEmojiCues.invalidate'], 'a new context drops a waiting emoji (mood publish step)');
  calls.length = 0;
  token = 't3';
  stage.syncSingleEmoji();
  assert.deepEqual(calls.filter(call => call.startsWith('SingleEmojiCues.')), ['SingleEmojiCues.invalidate'], 'the same through the sync step');
});
