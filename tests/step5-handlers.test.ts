// Wiring rewrite step 5 (docs/claude/2026-11-17-wiring-step-5.md): the handlers that were still written in electron/main.ts's registerIPC
// moved to their parts. Before the move no test looked at which window these may answer or what they stop; the mutations in
// scripts/dev/mutations/*.json (S5-*, M5-*, I5-*, D5-*, B5-*, G5-*, C5-sync-keeps-voice, K9-*) showed it. Each test evaluates the wiring's actual text
// (tests/helpers/wiring-source.ts, wherever it lives now) with fakes for what it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { isChatActionWord } from '../shared/brain';
import { controlNavigateRequest, isTakeMeThereId } from '../shared/initiative';
import { WIRING_PRELUDE, wiringCallArguments, wiringFunction, wiringHandler, wiringOption } from './helpers/wiring-source';

/** Evaluates `body` (statements ending in a return) with the prelude and `env`'s names in scope. */
function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
const expression = <T>(text: string, env: Record<string, unknown>): T => evaluate<T>(`return (${text});`, env);
const PET = 1, CONTROLS = 2;
const win = (id: number, sent: unknown[] = []) => ({ webContents: { id, send: (...args: unknown[]) => { sent.push(args); } }, isDestroyed: () => false,
  isVisible: () => true, isMinimized: () => false });

test('pet-window-only notes: the stage state, the listen-kind line, motion glitches and the colour-block log answer only the pet window', async () => {
  const pet = win(PET), controls = win(CONTROLS);
  const accepted: unknown[] = [];
  const stage = expression<(sender: number, value: unknown) => unknown>(wiringHandler('noteStageState'), { pet, stageState: { accept: (v: unknown) => { accepted.push(v); return true; } } });
  assert.equal(stage(CONTROLS, 'x'), false); assert.deepEqual(accepted, []);
  assert.equal(stage(PET, 'y'), true); assert.deepEqual(accepted, ['y']);
  const listen = expression<(sender: number) => string>(wiringHandler('readListenKind'), { pet, listenKind: { panelLine: () => 'music' } });
  assert.equal(listen(CONTROLS), ''); assert.equal(listen(PET), 'music');
  const glitches: unknown[] = [];
  const glitch = expression<(sender: number, value: unknown) => unknown>(wiringHandler('noteMotionGlitch'),
    { pet, appJournal: { motionGlitch: (v: unknown, id: unknown) => { glitches.push([v, id]); return true; } }, journalCharacterId: () => 'her' });
  assert.equal(glitch(CONTROLS, 'jump'), false); assert.deepEqual(glitches, []);
  glitch(PET, 'jump'); assert.deepEqual(glitches, [['jump', 'her']]);
  const facts: unknown[] = [];
  const fact = expression<(sender: number, kind: string, value: unknown) => unknown>(wiringHandler('noteJournalFact'),
    { pet, journalExtras: { fact: (...args: unknown[]) => { facts.push(args); return true; } }, companionFact: (_kind: unknown, fromCompanion: boolean) => fromCompanion }); // at home (tests/unbound-full-senses.test.ts covers out)
  fact(CONTROLS, 'k', 1); fact(PET, 'k', 2);
  assert.deepEqual(facts, [['k', 1, false], ['k', 2, true]], 'a fact says which window told it');
  const notes: unknown[] = [];
  const colour = expression<(sender: number, value: unknown) => Promise<unknown>>(wiringHandler('noteColorBlock'),
    { pet, colorBlockLog: Promise.resolve({ note: (...args: unknown[]) => { notes.push(args); return true; } }) });
  await colour(CONTROLS, 'v');
  assert.deepEqual(notes, [[CONTROLS, PET, 'v']], 'the log is told the pet window id, not the sender');
  void controls;
});

test('the song memory is cleared (into the recycle bin) only from the control window; the pet window only notes', async () => {
  const pet = win(PET), controls = win(CONTROLS);
  const cleared: unknown[] = [], handled: unknown[] = [];
  const field = (value: unknown, name: string) => value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;
  const songs = expression<(sender: number, request: unknown) => unknown>(wiringHandler('songMemory'), { pet, controls, field,
    songsBin: { clear: async () => { cleared.push('bin'); return { count: 2 }; } }, songMemory: { handle: (who: string, request: unknown) => { handled.push([who, request]); return null; } } });
  await songs(PET, { op: 'clear' });
  assert.deepEqual(cleared, [], 'the pet window cannot clear');
  assert.deepEqual(handled, [['pet', { op: 'clear' }]]);
  assert.deepEqual(await songs(CONTROLS, { op: 'clear' }), { cleared: 2 });
  assert.deepEqual(cleared, ['bin']);
});

test('playChatAction plays only her own small-action words', () => {
  const played: unknown[] = [];
  const play = expression<(word: unknown) => unknown>(wiringHandler('playChatAction'), { isChatActionWord, chatActions: { perform: (w: unknown) => { played.push(w); return true; } } });
  assert.throws(() => play('rm -rf'), /小动作/); assert.throws(() => play(42), /小动作/); assert.deepEqual(played, []);
});

test('openControls navigates only to a 「带我去」 page; anything else just shows the window', () => {
  const sent: unknown[] = [];
  let shown = 0;
  const open = expression<(page?: unknown, focus?: unknown) => void>(wiringHandler('openControls'), { controls: win(CONTROLS, sent), showControls: () => { shown++; }, controlNavigateRequest });
  open('not-a-page'); open({ destination: 'x' }); open();
  assert.equal(shown, 3); assert.deepEqual(sent, []);
  // I-173: a real page goes through, with only a plain element id and a card id to flash (a selector or anything else is dropped).
  open('fish-key', { anchor: 'tts-fish-key', character: '../x', extra: 1 }); open('mic', '#runtime-voice');
  assert.deepEqual(sent, [['desk:control-navigate', { destination: 'fish-key', anchor: 'tts-fish-key' }], ['desk:control-navigate', { destination: 'mic' }]]);
  assert.ok(isTakeMeThereId('fish-key'));
});

test('the surprise preview belongs to the control window that asked for it', () => {
  const controls = win(CONTROLS);
  const store = { current: { model: { path: 'gene.pmx', url: 'mmd-asset://gene' } } };
  const context = expression<(owner: number) => unknown>(wiringOption('surprisePreviewHost', 'context'), { store, controls, bodyModelGeneration: 3 });
  assert.equal(context(PET), null, 'another window owns no preview');
  assert.deepEqual(context(CONTROLS), { modelKey: JSON.stringify([3, 'gene.pmx', 'mmd-asset://gene']), modelUrl: 'mmd-asset://gene', visible: true });
});

test('removing the local recognizer turns voice input off (the window that had it keeps nothing)', () => {
  const changed: unknown[] = [];
  const media = { state: { voiceInput: true, voiceOwner: 'pet' } as Record<string, unknown>, update(patch: Record<string, unknown>, owner: string) { this.state = { ...this.state, ...patch, by: owner }; } };
  const off = expression<() => void>(wiringCallArguments('registerLocalAsrControls')[3], { media, mediaChanged: (previous: unknown) => changed.push(previous) });
  off();
  assert.equal(media.state.voiceInput, false); assert.equal(media.state.by, 'pet'); assert.equal(changed.length, 1);
});

test('another character revokes her voice input before any model I/O (syncCharacter, now in 角色卡\'s wiring)', async () => {
  const log: string[] = [];
  const card = (id: string) => ({ id, name: id, greeting: '', modelPath: undefined, mood: undefined });
  let active = card('b');
  const env = {
    characterCards: { getActive: () => active, presetGeneId: async () => 'gene', publicState: () => ({ cards: [] }) },
    companion: { currentScope: () => ({ characterId: 'a', providerScope: 'p' }), context: async () => { log.push('context'); } },
    store: { current: { provider: {}, persona: 'same', model: null }, persist: async () => { log.push('persist'); } }, moodModel: null,
    userProfileManagement: undefined, voiceHost: { history: 'old' }, ambientComments: null, proactiveSpeechGate: { cancel: () => log.push('gate') },
    speechRuntime: { stop: () => log.push('speech') }, pending: new Map(), bundledAssets: {}, assets: {}, motionLibrary: { cancel() {} }, appJournal: { characters() {} },
    revokeVoice: (reason: string) => log.push(`voice:${reason}`), stopSystemAudio: () => log.push('audio'), clearVisionContext: () => log.push('vision'),
    setVisionSupported: () => {}, clearReplySpeech: () => log.push('reply'), noteModelSelection: () => {}, sync: () => log.push('sync'),
    activateUserProfile: async () => {}, refreshVisionContext: () => {}, publishVisionState: () => {},
    compileCharacterPersona: () => 'same', effectiveCharacterMood: () => ({}), memoryProviderScope: () => 'p', broadcast: () => {},
  };
  const sync = evaluate<(apply: boolean, previous: unknown) => Promise<unknown>>(`${wiringFunction('syncCharacter')}\nreturn syncCharacter;`, env);
  await sync(false, card('a'));
  assert.ok(log.includes('voice:scope-change'), 'the old character\'s voice input is revoked');
  assert.equal(env.voiceHost.history, null);
  assert.ok(log.indexOf('voice:scope-change') < log.indexOf('context'), 'before her new context is loaded');
});

test('恢复默认设置 stops what runs before writing the factory settings: replies and tasks aborted, camera permission off', async () => {
  const log: string[] = [];
  const aborted: string[] = [];
  const pending = new Map([['r1', { controller: { abort: () => aborted.push('r1') } }], ['t1', { controller: { abort: () => aborted.push('t1') } }]]);
  let cameraEnabled = true;
  const env = {
    mutate: (op: () => Promise<unknown>) => op(), voiceHost: { history: 'old' }, clearVisionContext: () => log.push('vision'), setVisionSupported: () => log.push('supported'),
    stopSystemAudio: () => log.push('audio'), speechRuntime: { stop: () => log.push('speech') }, clearReplySpeech: () => log.push('reply'),
    noteModelSelection: () => log.push('selection'), motionLibrary: { cancel: () => log.push('motion') }, pending, setCameraEnabled: (v: boolean) => { cameraEnabled = v; },
    media: { state: {}, reset: () => log.push('media') }, mediaChanged: () => log.push('changed'), forgetScreenSelection: () => log.push('screen'),
    bundledAssets: { getDefaultAssets: async () => ({ model: null, motion: null }) }, assets: { clear: () => log.push('assets') }, userProfileManagement: { suspendScope: () => log.push('profile') },
    characterCards: { getActive: () => ({ id: 'gene' }) }, adoptCharacterForModel: async () => undefined, companion: { context: async () => { log.push('context'); } },
    store: { current: { provider: {}, persona: '' }, persist: async () => { log.push('persist'); } }, fitSettingsScale: (s: unknown) => s, DEFAULT_SETTINGS: {},
    compileCharacterPersona: () => '', broadcast: () => {}, sync: () => log.push('sync'), publicSettings: () => ({}), activateUserProfile: async () => { log.push('activate'); },
  };
  await expression<() => Promise<unknown>>(wiringHandler('resetSettings'), env)();
  assert.deepEqual(aborted, ['r1', 't1'], 'every reply and task in flight is stopped');
  assert.equal(cameraEnabled, false, 'the camera permission goes off');
  assert.equal(env.voiceHost.history, null);
  assert.ok(log.indexOf('audio') < log.indexOf('persist') && log.indexOf('media') < log.indexOf('persist'), 'stopped before the factory settings are written');
  assert.equal(log.at(-1), 'activate');
});
