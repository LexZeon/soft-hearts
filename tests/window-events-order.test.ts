// Wiring rewrite step 5b (docs/claude/2026-11-17-wiring-step-5b.md): what a window's events do is one ordered list electron/main.ts gives
// (wireWindowEvents), registered by the trunk's dispatcher (electron/wiring/window-events-wiring.ts windowEvents); each step is its part's.
// The wiring golden pins the list's text; this runs it: the real dispatcher, the real list and every step's actual text
// (tests/helpers/wiring-source.ts windowEventsSource) on two fake windows whose window and page are separate event emitters, with every
// part's object logging what it is asked. A step dropped, two steps swapped, a listener on the wrong emitter, steps run backwards, a
// closed window's task left running or the camera permission left on after the control window is gone: the logs below change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { WIRING_PRELUDE, windowEventOrder, windowEventsSource, wiringFunction } from './helpers/wiring-source';
import { companionHiddenStep } from '../electron/stage/companion-hidden';
import { abortsWithClosedWindow, leaveClearsVision } from '../shared/foundation/step-away';

class FakeContents extends EventEmitter {
  readonly sent: unknown[] = [];
  constructor(readonly id: number) { super(); }
  send(...args: unknown[]): void { this.sent.push(args); }
  setWindowOpenHandler(): void {}
}
class FakeWindow extends EventEmitter {
  visible = true; minimized = false; destroyed = false;
  readonly webContents: FakeContents;
  constructor(id: number) { super(); this.webContents = new FakeContents(id); }
  isVisible(): boolean { return this.visible; }
  isMinimized(): boolean { return this.minimized; }
  isDestroyed(): boolean { return this.destroyed; }
}
const CONTROLS = 1, PET = 2;
// The order and every step's text, read once (each fixture evaluates its own copy).
// I-174: the camera step's body (releaseCameraOnLeave) lives in the look wiring now; read with the order.
const ORDER_SOURCE = ts.transpileModule(`${WIRING_PRELUDE}\nlet cameraEnabled = true;\n${windowEventsSource()}\n${wiringFunction('releaseCameraOnLeave')}\n`
  + 'return { secure: (win, owner) => windowEvents(win, owner, win.webContents.id), camera: () => cameraEnabled, republish: () => republishPetVisibility };',
{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture() {
  const log: string[] = [];
  const note = (label: string) => (...args: unknown[]) => { log.push([label, ...args.filter(a => typeof a !== 'object' && typeof a !== 'function')].join(' ')); };
  const controls = new FakeWindow(CONTROLS), pet = new FakeWindow(PET);
  const her = { on: false }; // I-171: she is on screen (herOnScreen)
  const task = (id: string, owner: number, source: string) => [id, { owner, kind: 'chat', source, controller: { abort: () => log.push(`task.abort ${id}`) } }] as const;
  const pending = new Map([task('chat-controls', CONTROLS, 'chat'), task('research-controls', CONTROLS, 'language-authoring'), task('chat-pet', PET, 'chat')]);
  let camera: () => boolean = () => true;
  const env: Record<string, unknown> = {
    controls, pet, pending, store: { current: { pet: { visible: true } } },
    motionWeights: { dropOwner: note('motion-weights.drop') }, motionDownloadOwner: CONTROLS, motionLibrary: { cancel: note('motion-download.cancel') },
    ambientSpeakingOwners: { delete: note('ambient-speaking.delete') }, ambientAudio: { dropOwner: note('ambient-audio.drop') },
    ambientComments: { clear: note('ambient-comments.clear') }, suspendAmbientSpeech: note('ambient.suspend'), queueMicrotask: (fn: () => void) => fn(),
    audioCapture: { dropOwner: note('capture.drop'), revokeOwner: note('capture.revoke') },
    clearVisionContext: note('vision.clear'), refreshVisionContext: note('vision.refresh'),
    media: { state: { screenSharing: false, cameraSharing: false }, dropOwner: (owner: string) => log.push(`media.drop ${owner} camera=${camera()}`), update: note('media.update') },
    mediaChanged: note('media.changed'), proactiveVision: { pendingId: null }, lookAttachments: { busy: false },
    voiceHost: { capture: { sender: CONTROLS } }, revokeVoice: note('voice.revoke'), stopSystemAudio: note('system-audio.stop'),
    onScreen: (win: FakeWindow) => win.visible && !win.minimized,
    codexTasks: { list: async () => { log.push('tasks.list'); return [{ id: 'run', status: 'running' }, { id: 'done', status: 'done' }]; }, interrupt: async (id: string) => { log.push(`tasks.interrupt ${id}`); } },
    surprisePreviewHost: { stop: note('surprise.stop') }, speechRuntime: { dropOwner: note('speech.drop') }, dropReplySpeechOwner: note('reply-speech.drop'),
    voiceCall: { check: note('call.check') }, bumpBodyModelGeneration: note('body.generation'),
    companion: { mood: { cancelBodyPresentation: note('mood.cancel-body'), setBodyVisible: note('mood.body-visible'), invalidate: note('mood.invalidate') } },
    companionHiddenStep, leaveClearsVision, abortsWithClosedWindow, herOnScreen: () => her.on, cancelCompletedReply: note('reply.cancel'), petWindowDrag: { cancel: note('drag.cancel') }, petPointerInput: { reset: note('pointer.reset') },
    visualAuthoring: { close: note('visual-authoring.close') }, bodyAuthoring: { close: note('body-authoring.close') }, characterStickerHost: { cancel: note('stickers.cancel') },
    nativeVisibility: (win: FakeWindow) => ({ visible: win.visible }), languageAuthoring: { close: note('language-authoring.close') },
    companionCommands: { refresh: note('commands.refresh'), invalidate: note('commands.invalidate') }, textMemorialHost: { cancel: note('memorial.cancel') },
  };
  const api = new Function(...Object.keys(env), ORDER_SOURCE)(...Object.values(env)) as { secure(win: FakeWindow, owner: string): void; camera(): boolean; republish(): (() => void) | null };
  camera = api.camera;
  api.secure(controls, 'controls'); api.secure(pet, 'pet');
  const take = () => log.splice(0);
  return { log, take, controls, pet, pending, api, her };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the listeners: each on the window or its page as the order says, as many as it lists', () => {
  const f = fixture();
  const count = (emitter: EventEmitter) => Object.fromEntries(emitter.eventNames().map(name => [String(name), emitter.listenerCount(name)]));
  assert.deepEqual(count(f.controls), { hide: 3, closed: 1, show: 1, minimize: 2, restore: 1 });
  assert.deepEqual(count(f.controls.webContents), { 'render-process-gone': 6, destroyed: 2, 'did-start-navigation': 2, 'did-finish-load': 1, 'will-navigate': 1, 'will-attach-webview': 1 });
  const order = windowEventOrder();
  assert.equal(order.listeners.length, 19, 'the order lists 19 listeners (and runs the navigation guard and the pet\'s republish once per window)');
});

test('I-171: the control window closes while she is on screen: her chat reply keeps going; authoring still ends', () => {
  const f = fixture();
  f.her.on = true;
  f.controls.webContents.emit('destroyed');
  const log = f.take();
  assert.ok(!log.includes('task.abort chat-controls'), 'the reply made from the control window is not aborted');
  assert.ok(log.includes('task.abort research-controls'), 'authoring still ends with its window');
  assert.deepEqual([...f.pending.keys()], ['chat-controls', 'research-controls', 'chat-pet'],'the chat entry stays until it settles itself'); // no-pet-ok: the fixture's task id
});

test('the control window closes: its tasks in flight are aborted (authoring keeps its lease entry), the camera permission ends before its media goes, every step in order', async () => {
  const f = fixture();
  f.controls.webContents.emit('destroyed');
  assert.deepEqual(f.take(), [
    // releaseAmbientOwner (感知)
    'capture.drop controls', 'ambient-speaking.delete 1', 'ambient-audio.drop 1', 'ambient.suspend',
    // the destroyed step list
    'surprise.stop 1', 'language-authoring.close 1', 'visual-authoring.close 1', 'body-authoring.close 1', 'vision.clear', 'speech.drop 1', 'reply-speech.drop 1',
    'tasks.list', 'motion-download.cancel', 'task.abort chat-controls', 'task.abort research-controls', 'media.drop controls camera=false', 'media.changed',
  ]);
  assert.deepEqual([...f.pending.keys()], ['research-controls', 'chat-pet'], 'the chat entry goes now; authoring keeps the shared lease until it settles; the pet window\'s task stays');
  assert.equal(f.api.camera(), false);
  await settle();
  assert.deepEqual(f.take(), ['tasks.interrupt run'], 'only the running Claude task is interrupted');
});

test('the pet window closes: her mood view and reply end, the computer\'s sound stops; the camera permission and the control window\'s tasks stay', () => {
  const f = fixture();
  f.pet.webContents.emit('destroyed');
  assert.deepEqual(f.take(), [
    'capture.drop pet', 'ambient-speaking.delete 2', 'ambient-audio.drop 2', 'ambient-comments.clear', 'ambient.suspend',
    'language-authoring.close 2', 'visual-authoring.close 2', 'body-authoring.close 2', 'vision.clear', 'speech.drop 2', 'reply-speech.drop 2',
    'mood.invalidate', 'reply.cancel window', 'system-audio.stop', 'task.abort chat-pet', 'media.drop pet camera=true', 'media.changed',
  ]);
  assert.deepEqual([...f.pending.keys()], ['chat-controls', 'research-controls']);
  assert.equal(f.api.camera(), true);
});

test('a page gone: each listener in registration order, each step in list order', () => {
  const f = fixture();
  f.pet.webContents.emit('render-process-gone');
  assert.deepEqual(f.take(), [
    'motion-weights.drop 2',
    'capture.drop pet', 'ambient-speaking.delete 2', 'ambient-audio.drop 2', 'ambient-comments.clear', 'ambient.suspend',
    'vision.clear', 'media.drop pet camera=true', 'media.changed', 'speech.drop 2', 'reply-speech.drop 2',
    'body.generation', 'mood.cancel-body', 'drag.cancel', 'pointer.reset', 'system-audio.stop', 'reply.cancel window',
    'commands.invalidate', 'memorial.cancel',
  ]);
  f.controls.webContents.emit('render-process-gone');
  assert.deepEqual(f.take(), [
    'motion-weights.drop 1', 'capture.drop controls', 'ambient-speaking.delete 1', 'ambient-audio.drop 1', 'ambient.suspend', 'tasks.list',
    'surprise.stop 1', 'voice.revoke scope-change', 'vision.clear', 'media.drop controls camera=true', 'media.changed', 'speech.drop 1', 'reply-speech.drop 1',
    'commands.invalidate',
  ]);
});

test('a new main-frame document runs the navigation steps; an in-page one only ends the command choices', () => {
  const f = fixture();
  f.pet.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.deepEqual(f.take(), ['commands.invalidate']);
  f.pet.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  assert.deepEqual(f.take(), ['commands.invalidate']);
  f.pet.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(f.take(), [
    'vision.clear', 'media.drop pet camera=true', 'media.changed', 'body.generation', 'mood.cancel-body', 'reply.cancel window', 'drag.cancel',
    'speech.drop 2', 'reply-speech.drop 2', 'capture.revoke pet', 'ambient-speaking.delete 2', 'ambient-audio.drop 2', 'ambient-comments.clear', 'ambient.suspend',
    'system-audio.stop', 'commands.invalidate',
  ]);
});

test('the control window hidden: annotations, then visibility (the camera permission ends off the screen), then its open tools close', () => {
  const f = fixture();
  f.controls.visible = false;
  f.controls.emit('hide');
  assert.deepEqual(f.take(), [
    'motion-weights.drop 1',
    'commands.refresh', 'voice.revoke hide', 'call.check', 'vision.refresh',
    'surprise.stop 1', 'visual-authoring.close 1', 'body-authoring.close 1', 'stickers.cancel',
  ]);
  assert.equal(f.api.camera(), false, 'the camera permission ends when the control window leaves the screen');
  assert.deepEqual(f.controls.webContents.sent, [['desk:visibility', { visible: false }]]);
});

test('the pet window: minimized she is invisible but her reply goes on (I-171); a hide ends it; Unbound republishes the pet window\'s own visibility', () => {
  const f = fixture();
  f.pet.minimized = true;
  f.pet.emit('minimize');
  // I-171 (docs/claude/2026-11-21-i171-minimize-keeps-her.md): 'reply.cancel' used to be here; a minimize is a step away and keeps the reply.
  assert.deepEqual(f.take(), ['commands.refresh', 'call.check', 'mood.body-visible false', 'mood.invalidate', 'system-audio.stop', 'pointer.reset', 'vision.refresh']);
  const tray = fixture();  // no-pet-ok: the fixture's companion window is named pet
  tray.pet.visible = false;  // no-pet-ok: the fixture's companion window is named pet
  tray.pet.emit('hide');  // no-pet-ok: same
  assert.ok(tray.take().includes('reply.cancel hidden'), 'a hide to the tray still ends the reply');
  assert.equal(f.api.camera(), true);
  f.pet.minimized = false;
  f.api.republish()!();
  assert.deepEqual(f.take(), ['commands.refresh', 'call.check', 'mood.body-visible true', 'vision.refresh']);
  assert.deepEqual(f.pet.webContents.sent.at(-1), ['desk:visibility', { visible: true }]);
  f.pet.destroyed = true;
  f.pet.emit('show');
  assert.deepEqual(f.take(), ['commands.refresh'], 'a destroyed window only refreshes the command choices');
});
