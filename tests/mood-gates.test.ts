// 心情的接线 (wiring rewrite step 4f, docs/claude/2026-11-16-wiring-step-4f.md): the wiring around her mood. Each mood publish runs its
// steps once, in today's order; touches reach the touch brain from the moment main.ts is evaluated; blush calibration, the blush stage,
// direct interaction (pat, pinch, snack) and the mood parameters go through the mood host and its checks; the mood host reads 少一点 and
// keeps the busy-chat stretch (I-039); tiredness closes while she quits and only reads her current scope; the reactions and the mood judge
// wait while she is hidden or a reply runs; her automatic expression (companionCanExpress) waits for every one of its inputs. Each test
// evaluates the wiring's actual text (tests/helpers/wiring-source.ts: across electron/main.ts and electron/wiring/*.ts, so it follows the
// code when it moves) over fakes. Before this file several of these checks had no test that failed when the check was removed (the
// mutation table in the record).
// Reads as text (test-affected selects this test when they change): 'electron/main.ts', 'electron/wiring/mood-wiring.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { MoodHost } from '../electron/mood/mood';
import { speechIntervalAfterUnanswered } from '../shared/brain';
import { WIRING_PRELUDE, moodPublishSource, wiringArgument, wiringCallArguments, wiringFunction, wiringHandler, wiringNodes, wiringOption, wiringSource } from './helpers/wiring-source';

/** Evaluates `body` (statements ending in a return) with the prelude and `env`'s names in scope. */
function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
const expression = <T>(text: string, env: Record<string, unknown>): T => evaluate<T>(`return (${text});`, env);
const option = <T>(variable: string, name: string, env: Record<string, unknown>): T => expression<T>(wiringOption(variable, name), env);
const handler = <T>(name: string, env: Record<string, unknown>): T => expression<T>(wiringHandler(name), env);
const pending = (chat: boolean) => new Map<string, { kind: string }>(chat ? [['c', { kind: 'chat' }]] : []);
const petWindow = (state: { visible: boolean; minimized?: boolean; id?: number }) => ({ webContents: { id: state.id ?? 1, send: () => {} },
  isDestroyed: () => false, isVisible: () => state.visible, isMinimized: () => state.minimized === true });

// ---------------------------------------------------------------- the mood publish

/** The mood publish (the callback CompanionService is made with, and its step list once it is one) over fakes that log each step. */
function moodPublish() {
  const log: string[] = [];
  const env = {
    refreshSingleEmojiContext: () => { log.push('emoji'); },
    proactiveSpeechGate: { setScope: (scope: string) => { log.push(`gate ${scope}`); }, cancel: (reason: string) => { log.push(`gate.cancel ${reason}`); } },
    speechScope: () => 'scope',
    noteVisionUserActivity: () => { log.push('activity'); },
    textMemorialHost: { sync: () => { log.push('memorial'); } },
    r20ProactiveOffers: { sync: () => { log.push('r20'); } },
    claimMoodCue: () => { log.push('claim'); return 'inner'; },
    claimedView: (view: object, claimant: string) => ({ ...view, claimant }),
    companion: { mood: {} },
    withBodyPose: (view: object) => ({ ...view, posed: true }),
    broadcast: (channel: string, value: { claimant?: string; posed?: boolean }) => { log.push(`broadcast ${channel} ${value.claimant} ${value.posed}`); },
    ambientComments: { observe: (view: { claimant?: string }) => { log.push(`ambient ${view.claimant}`); } },
    moodJudge: { watch: (view: { claimant?: string }) => { log.push(`judge ${view.claimant ?? 'raw'}`); } },
  };
  const publish = evaluate<(view: unknown) => void>(`${moodPublishSource()}\nreturn (${wiringArgument('companion', 1)});`, env);
  return { publish, log };
}

test('mood publish: every step runs once, in today\'s order (her claim before anything sees the cue; the judge sees the raw view last)', () => {
  const { publish, log } = moodPublish();
  publish({ token: 't', snapshot: { phase: 'active', cue: null } });
  assert.deepEqual(log, ['emoji', 'gate scope:t', 'activity', 'memorial', 'r20', 'claim', 'broadcast desk:mood inner true', 'ambient inner', 'judge raw']);
  log.length = 0;
  publish({ token: 'u', snapshot: { phase: 'idle', cue: null } });
  assert.deepEqual(log, ['emoji', 'gate scope:u', 'memorial', 'r20', 'claim', 'broadcast desk:mood inner true', 'ambient inner', 'judge raw'], 'idle: no user activity noted');
});

// ---------------------------------------------------------------- touches (I-136)

test('touch: the sink is set exactly once while electron/main.ts is evaluated (early), and hands every touch to the touch brain', () => {
  const rows = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'setTouchSink');
  assert.equal(rows.length, 1, 'one place sets where touches go');
  const { node, file } = rows[0];
  let enclosing: ts.Node | undefined;
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) { enclosing = p; break; }
  if (enclosing) {
    // inside a part's early() (wiring rewrite plan: setTouchSink stays in early()), which electron/main.ts calls at its top level
    const name = ts.isMethodDeclaration(enclosing) || ts.isFunctionDeclaration(enclosing) ? enclosing.name?.getText() : ts.isPropertyAssignment(enclosing.parent) ? enclosing.parent.name.getText() : '';
    assert.equal(name, 'early', `setTouchSink is inside ${name || 'a function'} (${file}), not early()`);
    for (let p: ts.Node | undefined = enclosing.parent; p; p = p.parent) assert.ok(!ts.isFunctionLike(p) || ts.isFunctionDeclaration(p) && /^wire[A-Z]/.test(p.name?.text ?? ''), 'early() belongs to the part\'s wire function');
    const main = wiringNodes((n): n is ts.ExpressionStatement => ts.isExpressionStatement(n) && ts.isSourceFile(n.parent) && /^\w+\.early\(\)$/.test(n.expression.getText()))
      .filter(row => row.file === 'electron/main.ts').map(row => row.node.expression.getText());
    const wired = wiringNodes((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && ts.isVariableStatement(n.parent.parent) && ts.isSourceFile(n.parent.parent.parent)
      && !!n.initializer && ts.isCallExpression(n.initializer) && /^wireMood$/.test(n.initializer.expression.getText())).filter(row => row.file === 'electron/main.ts');
    assert.equal(wired.length, 1, 'electron/main.ts wires the mood part at its top level');
    assert.ok(main.includes(`${wired[0].node.name.getText()}.early()`), 'electron/main.ts calls the mood part\'s early() at its top level');
  } else {
    assert.equal(file, 'electron/main.ts', 'a module-level setTouchSink is in electron/main.ts (evaluated after the profile folder is set)');
  }
  const touches: unknown[] = [];
  const sink = expression<(event: unknown) => void>(wiringCallArguments('setTouchSink')[0], { touchBrain: { touch: (event: unknown) => { touches.push(event); } } });
  sink({ kind: 'pat', at: 1 });
  assert.deepEqual(touches, [{ kind: 'pat', at: 1 }]);
});

test('touch brain: its reaction tendencies are this view\'s, and a touch knows whether she is out on the desktop (Unbound) or home', () => {
  const asked: unknown[] = [];
  const dispositions = option<(view: unknown) => unknown>('touchBrain', 'dispositions', { reactions: { dispositionsFor: (view: unknown) => { asked.push(view); return 'mine'; } } });
  assert.equal(dispositions({ characterId: 'her' }), 'mine');
  assert.deepEqual(asked, [{ characterId: 'her' }]);
  const place = (unbound: unknown) => option<() => string>('touchBrain', 'place', { unbound })();
  assert.equal(place(null), 'pet');
  assert.equal(place({ state: 'normal' }), 'pet');
  assert.equal(place({ state: 'out' }), 'unbound');
});

// ---------------------------------------------------------------- blush

test('blush calibration: read and saved only for the model in use; a saved one goes to the windows', async () => {
  const sent: [string, unknown][] = [], saved: unknown[] = [];
  let modelPath = 'a.pmx', switchDuring = false;
  const store = { current: { get model() { return { path: modelPath }; } } };
  const blushCalibrations = { keyForModel: async (file: string) => { const key = `key:${file}`; if (switchDuring) modelPath = 'b.pmx'; return key; },
    get: (key: string) => ({ key }), set: async (key: string, value: unknown) => { saved.push([key, value]); return { key, value }; } };
  const env = { store, blushCalibrations, mutate: <T>(operation: () => Promise<T>) => operation(), broadcast: (channel: string, value: unknown) => { sent.push([channel, value]); } };
  const set = handler<(expected: unknown, value: unknown) => Promise<unknown>>('setBlushCalibration', env);
  await assert.rejects(set('key:other.pmx', { x: 1 }), /模型已切换/u, 'another model\'s key is refused');
  assert.deepEqual(saved, []); assert.deepEqual(sent, []);
  assert.deepEqual(await set('key:a.pmx', { x: 2 }), { key: 'key:a.pmx', value: { x: 2 } });
  assert.deepEqual(saved, [['key:a.pmx', { x: 2 }]]);
  assert.deepEqual(sent, [['desk:blush-calibration', { key: 'key:a.pmx', value: { x: 2 } }]]);
  const get = handler<() => Promise<unknown>>('getBlushCalibration', env);
  assert.deepEqual(await get(), { key: 'key:a.pmx' });
  switchDuring = true;
  await assert.rejects(get(), /模型已切换/u, 'the model changed while its key was read');
});

test('blush stage: the pet window\'s blush cue goes to the mood host (it decides what the journal keeps), not straight into the journal', () => {
  const noted: unknown[] = [], recorded: unknown[] = [];
  const blushStage = option<(stage: unknown) => void>('journalExtras', 'blushStage', { companion: { noteBlushStage: (stage: unknown) => { noted.push(stage); } },
    appJournal: { record: (row: unknown) => { recorded.push(row); } } });
  blushStage('peak');
  assert.deepEqual(noted, ['peak']);
  assert.deepEqual(recorded, []);
});

// ---------------------------------------------------------------- direct interaction and the mood host's handlers

test('direct interaction (pat, pinch, snack): only the visible, undragged pet window with a model; it counts as the user being active', () => {
  const world = { visible: true, minimized: false, dragging: false, activity: 0, interactions: [] as unknown[] };
  const pet = { webContents: { id: 1 }, isVisible: () => world.visible, isMinimized: () => world.minimized };
  const env = { pet, petWindowDrag: { get active() { return world.dragging; } }, store: { current: { model: { path: 'a.pmx' } } },
    companion: { mood: { interaction: (value: unknown) => { world.interactions.push(value); return { ok: true }; } } }, noteVisionUserActivity: () => { world.activity++; } };
  const interact = handler<(sender: number, value: unknown) => unknown>('moodInteraction', env);
  assert.throws(() => interact(2, { type: 'pat' }), /只有可交互的桌宠窗口/u, 'the control window cannot pat her');
  world.visible = false; assert.throws(() => interact(1, { type: 'pat' }), /只有可交互的桌宠窗口/u, 'hidden'); world.visible = true;
  world.minimized = true; assert.throws(() => interact(1, { type: 'pat' }), /只有可交互的桌宠窗口/u, 'minimized'); world.minimized = false;
  world.dragging = true; assert.throws(() => interact(1, { type: 'pat' }), /只有可交互的桌宠窗口/u, 'while she is dragged');
  assert.deepEqual(interact(1, { type: 'phase', phase: 'idle' }), { ok: true }, 'ending a contact while dragged is still accepted'); world.dragging = false;
  assert.deepEqual(interact(1, { type: 'pat' }), { ok: true });
  assert.deepEqual(world.interactions, [{ type: 'phase', phase: 'idle' }, { type: 'pat' }]);
  assert.equal(world.activity, 2);
});

test('mood parameters: developer mode and the role they were read for are checked before anything is saved; then card, mood host, windows', async () => {
  const log: string[] = [];
  const world = { developer: true, identityOk: true };
  const env = {
    mutate: <T>(operation: () => Promise<T>) => operation(),
    validateMoodParameters: (value: unknown) => { log.push('validate'); return value; },
    characterCards: { getActive: () => ({ id: 'her' }), saveMoodParameters: async (id: string) => { log.push(`card ${id}`); return 'cards'; } },
    companion: { mood: { assertParameterIdentity: () => { if (!world.identityOk) throw new Error('角色已切换'); }, isDeveloperMode: () => world.developer,
      applyTemplate: (id: string) => { log.push(`template ${id}`); }, get: () => 'view' } },
    broadcast: (channel: string) => { log.push(`broadcast ${channel}`); },
  };
  const save = evaluate<(value: unknown, expected: unknown) => Promise<unknown>>(`${wiringFunction('saveActiveMoodParameters')}\nreturn saveActiveMoodParameters;`, env);
  world.developer = false; await assert.rejects(save({}, 'her'), /开发者模式/u); world.developer = true;
  world.identityOk = false; await assert.rejects(save({}, 'old'), /角色已切换/u); world.identityOk = true;
  assert.deepEqual(log, [], 'nothing validated or saved');
  assert.equal(await save({}, 'her'), 'view');
  assert.deepEqual(log, ['validate', 'card her', 'template her', 'broadcast desk:characters']);
});

test('her automatic expression switched off counts as user activity; the music tier is the pet window\'s alone', () => {
  let activity = 0;
  const setExpressions = handler<(enabled: boolean) => { expressions: boolean }>('setMoodExpressions',
    { companion: { mood: { setExpressions: (enabled: boolean) => ({ expressions: enabled }) } }, noteVisionUserActivity: () => { activity++; } });
  setExpressions(true); assert.equal(activity, 0);
  setExpressions(false); assert.equal(activity, 1);
  const tiers: unknown[] = [];
  const tier = handler<(sender: number, value: unknown) => unknown>('noteMusicTier', { pet: { webContents: { id: 1 } },
    companion: { mood: { moments: { musicTier: (value: unknown) => { tiers.push(value); } } } }, appJournal: { musicTier: () => true }, journalCharacterId: () => 'her',
    companionFact: (_kind: unknown, fromCompanion: boolean) => fromCompanion }); // batch F: at home (unbound-senses-wiring.ts; tests/unbound-full-senses.test.ts covers out)
  assert.equal(tier(2, 'dance'), false);
  assert.deepEqual(tiers, []);
  assert.equal(tier(1, 'dance'), true);
  assert.deepEqual(tiers, ['dance']);
});

// ---------------------------------------------------------------- her speech interval (I-039)

test('the mood host reads 少一点 from the settings as they are now, and stretches her speech interval after unanswered lines by default', () => {
  const talk = expression<() => unknown>(wiringCallArguments('companion.mood.setProactiveTalkSource')[0], { store: { current: { proactiveTalk: 'less' } } });
  assert.equal(talk(), 'less');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-hearts-mood-gates-'));
  try {
    const host = new MoodHost(dir, () => {});
    assert.equal((host as unknown as { speechStretch: unknown }).speechStretch, speechIntervalAfterUnanswered, 'the busy-chat stretch (shared/behaviors/busy-chat/unanswered.ts) is passed to the gate');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- tiredness and sleep

test('tiredness: the activity closes while she quits, and is marked ready only after the handlers are registered', () => {
  let current: { initialized: boolean } | null = null;
  const env = { fatigueActivityReady: true, exiting: true, userInputUntil: 0, pending: pending(false), asrTask: null, readingInputSpeech: false,
    foregroundAsr: { foregroundBusy: false }, replySpeechBusy: () => false, ambientSpeakingOwners: new Set(), speechScope: () => 's', companion: {}, store: {},
    speechPlaybackActivity: { busy: false, setScope: () => {} }, fatigueActivity: { setActivity: (value: { initialized: boolean }) => { current = value; } } };
  evaluate<() => void>(`${wiringFunction('syncFatigueActivity')}\nreturn syncFatigueActivity;`, env)();
  assert.equal(current!.initialized, false, 'quitting: closed');
  const source = wiringSource();
  const ready = source.indexOf('fatigueActivityReady = true'), handlers = source.indexOf('registerIPC();');
  assert.ok(handlers > 0 && ready > handlers, 'renderer playback reports its own lifetime only once the handlers are there (2026-11-09)');
  // Step 5b: the flag is 心情's (electron/wiring/mood-wiring.ts), opened by its ready step; the ready chain calls that step right after registerIPC.
  // Step 7: the step is its unit's start (mood/fatigue-activity, through the part runner); the flag is still its first line.
  assert.match(wiringFunction('startFatigueActivity'), /\{\s*startUnitSync\('mood', 'fatigue-activity', \(\) => \{[^\n]*\n\s*fatigueActivityReady = true;/);
  assert.match(source, /registerIPC\(\);\s*\n\s*startFatigueActivity\(store\);/);
});

test('her completed tiredness is read only for the scope and card she is speaking in', () => {
  const env = { speechScope: () => 'now', characterCards: { getActive: () => ({ id: 'her' }) },
    companion: { mood: { get: () => ({ characterId: 'her', fatigue: { phase: 'drowsy' } }) } } };
  const feeling = evaluate<(scope: string, card: string) => unknown>(`${wiringFunction('completedFatigueFeeling')}\nreturn completedFatigueFeeling;`, env);
  assert.deepEqual(feeling('now', 'her'), { phase: 'drowsy' });
  assert.equal(feeling('before', 'her'), undefined);
  assert.equal(feeling('now', 'other'), undefined);
});

// ---------------------------------------------------------------- reactions and the mood judge

test('reactions: nothing while she is hidden, and her warm haiku is not rebuilt while a reply runs', () => {
  const sent: unknown[] = [];
  for (const state of [{ visible: false }, { visible: true, minimized: true }]) {
    const pet = { ...petWindow(state), webContents: { id: 1, send: (...args: unknown[]) => { sent.push(args); } } };
    assert.equal(option<() => boolean>('reactions', 'petVisible', { pet })(), false);
    assert.equal(option<(cue: unknown) => boolean>('reactions', 'stage', { pet })({ id: 'r' }), false);
  }
  assert.equal(sent.length, 0, 'no reaction reaches a hidden pet');
  const pet = { ...petWindow({ visible: true }), webContents: { id: 1, send: (...args: unknown[]) => { sent.push(args); } } };
  assert.equal(option<() => boolean>('reactions', 'petVisible', { pet })(), true);
  assert.equal(option<(cue: unknown) => boolean>('reactions', 'stage', { pet })({ id: 'r' }), true);
  assert.deepEqual(sent, [['desk:reaction', { id: 'r' }]]);
  assert.equal(option<() => boolean>('reactions', 'chatBusy', { pending: pending(true) })(), true);
  assert.equal(option<() => boolean>('reactions', 'chatBusy', { pending: pending(false) })(), false);
});

test('the mood judge: waits while she is hidden or a reply runs, and leaves the user\'s message to the reactions while they are on', () => {
  // 2026-11-21: "seen" is herOnScreen (the companion window shown, or out in Unbound with her bubble able to show)
  assert.equal(option<() => boolean>('moodJudge', 'petVisible', { herOnScreen: () => false })(), false);
  assert.equal(option<() => boolean>('moodJudge', 'petVisible', { herOnScreen: () => true })(), true);
  assert.equal(option<() => boolean>('moodJudge', 'busy', { pending: pending(true) })(), true);
  assert.equal(option<() => boolean>('moodJudge', 'busy', { pending: pending(false) })(), false);
  assert.equal(option<() => boolean>('moodJudge', 'skipMessages', { reactions: { on: () => true } })(), true);
  assert.equal(option<() => boolean>('moodJudge', 'skipMessages', { reactions: { on: () => false } })(), false);
});

// ---------------------------------------------------------------- her automatic expression (the mood tick's gate)

test('companionCanExpress: each of its inputs closes it on its own', () => {
  // The sandbox takes each name's value once, so what changes is read through objects (and the clock, against a fixed userInputUntil).
  const world = { onScreen: true, dragging: false, now: 2_000, replying: false, ambient: 0, gateBusy: false, chat: false, playing: false };
  const env = { herOnScreen: () => world.onScreen, petWindowDrag: { get active() { return world.dragging; } }, userInputUntil: 1_000, Date: { now: () => world.now },
    replySpeechBusy: () => world.replying, ambientSpeakingOwners: { get size() { return world.ambient; } }, proactiveSpeechGate: { get busy() { return world.gateBusy; } },
    pending: { values: () => pending(world.chat).values() }, rps: { host: { get active() { return world.playing; } } } };
  const can = evaluate<() => boolean>(`${wiringFunction('companionCanExpress')}\nreturn companionCanExpress;`, env);
  assert.equal(can(), true);
  const closes: [string, () => void, () => void][] = [
    ['not on screen', () => { world.onScreen = false; }, () => { world.onScreen = true; }],
    ['dragged', () => { world.dragging = true; }, () => { world.dragging = false; }],
    ['the user is typing', () => { world.now = 500; }, () => { world.now = 2_000; }],
    ['her reply is read aloud', () => { world.replying = true; }, () => { world.replying = false; }],
    ['an ambient line is spoken', () => { world.ambient = 1; }, () => { world.ambient = 0; }],
    ['another proactive line holds the gate', () => { world.gateBusy = true; }, () => { world.gateBusy = false; }],
    ['a chat reply runs', () => { world.chat = true; }, () => { world.chat = false; }],
    ['a game of 猜拳 is on (G1)', () => { world.playing = true; }, () => { world.playing = false; }],
  ];
  for (const [why, close, open] of closes) { close(); assert.equal(can(), false, why); open(); assert.equal(can(), true, `${why}: open again`); }
});
