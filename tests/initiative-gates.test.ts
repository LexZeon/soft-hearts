// 主动的关口 (wiring rewrite step 4e, docs/claude/2026-11-16-wiring-step-4e.md): the wiring around what she starts on her own. Her mood
// cue goes to exactly one owner, asked in the cue chain's order (her hand first, then the opening choice); the one proactive-speech gate
// is the same object everywhere and every "may she speak now" check reads it; a line nobody answered comes back to her (the no-reply
// rule); the quota and the interaction budget are not skipped and an unspoken claim gives them back; the deep-night rest reminder keeps
// its night across restarts; what she keeps in her folder goes through her folder's own host with a fresh ticket; cancelling her
// proactive line cancels the other parts' work too. Each test evaluates the wiring's actual text (tests/helpers/wiring-source.ts: across
// electron/main.ts and electron/wiring/*.ts, so it follows the code when it moves) over fakes. Before this file most of these checks had
// no test that failed when the check was removed (the mutation table in the record).
// Reads as text (test-affected selects this test when they change): 'electron/main.ts', 'electron/wiring/initiative-wiring.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { claimedView } from '../electron/initiative/inner-loop/claim';
import { senseLineFree } from '../electron/senses/sense-router/free';
import { RestReminderStore } from '../electron/initiative/inner-loop/rest-reminder-store';
import { WIRING_PRELUDE, cueChainSource, moodPublishSource, wiringArgument, wiringFunction, wiringHandler, wiringOption } from './helpers/wiring-source';

/** Evaluates `body` (statements ending in a return) with the prelude and `env`'s names in scope. */
function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
const expression = <T>(text: string, env: Record<string, unknown>): T => evaluate<T>(`return (${text});`, env);
const option = <T>(variable: string, name: string, env: Record<string, unknown>): T => expression<T>(wiringOption(variable, name), env);

interface Cue { id: string; kind: 'speech' | 'motion' | 'look'; source?: unknown; until?: number }
interface Claimants { memorial(c: Cue): boolean; r20(c: Cue): boolean; vision(c: Cue): boolean; ambient(c: Cue): boolean; ambientPassed(c: Cue): void; touch(c: Cue): boolean; moment(c: Cue): unknown }

/** The mood publish (the callback CompanionService is made with) and her cue's owner as the clock reads it (moodCueOwner). */
function moodPublish(world: { hands?: (cue: Cue | null) => boolean; opening?: (cue: Cue | null, claimants: Claimants) => string | null; scopeThrows?: boolean }) {
  const log: string[] = [], openingCalls: { cue: Cue | null; claimants: Claimants }[] = [], broadcasts: { channel: string; value: unknown }[] = [];
  const env = {
    refreshSingleEmojiContext: () => { log.push('emoji'); },
    proactiveSpeechGate: { setScope: (scope: string) => { log.push(`gate.setScope ${scope}`); }, cancel: (reason: string) => { log.push(`gate.cancel ${reason}`); } },
    speechScope: () => { if (world.scopeThrows) throw new Error('changing'); return 'scope'; },
    noteVisionUserActivity: () => { log.push('vision activity'); },
    textMemorialHost: { sync: () => { log.push('memorial.sync'); }, offerOpportunity: () => false },
    r20ProactiveOffers: { sync: () => { log.push('r20.sync'); }, offerOpportunity: () => false },
    hands: { host: { claimCue: (cue: Cue | null) => { log.push('hands.claimCue'); return world.hands?.(cue) ?? false; } } },
    innerLoopHost: { opening: { claim: (cue: Cue | null, claimants: Claimants, _view: unknown) => { log.push('opening.claim'); openingCalls.push({ cue, claimants }); return world.opening?.(cue, claimants) ?? null; } } },
    visionEligible: () => true, ambientComments: { canTake: () => true, pass: () => { log.push('ambient.pass'); }, observe: () => { log.push('ambient.observe'); } },
    touchBrain: { claims: () => false }, unboundNoticedClaims: () => false, // Unbound step 4: beside the touch's claimant
    moments: { claims: () => null }, // I-188: the moments' claimant
    claimedView, companion: { mood: { cueHidden: () => {} } }, withBodyPose: (view: unknown) => view,
    broadcast: (channel: string, value: unknown) => { broadcasts.push({ channel, value }); },
    moodJudge: { watch: () => { log.push('judge.watch'); } },
  };
  const flow = evaluate<{ publish(view: unknown): void; owner(): { id: string; owner: string | null } | null }>(
    `let moodCueOwner = null;\n${cueChainSource()}\n${moodPublishSource() /* step 4f: the publish is a step list */}\nreturn { publish: (${wiringArgument('companion', 1)}), owner: () => moodCueOwner };`, env);
  const view = (cue: Cue | null) => ({ token: 't', characterId: 'her', snapshot: { phase: 'idle', cue } });
  return { flow, view, log, openingCalls, broadcasts };
}

// ---------------------------------------------------------------- her mood cue: one owner, the chain's order

test('cue chain: her hand is asked first; when it takes the cue nobody else is asked, and the clock reads its owner', () => {
  const { flow, view, log, openingCalls, broadcasts } = moodPublish({ hands: () => true, opening: () => 'inner' });
  flow.publish(view({ id: 'm1', kind: 'motion' }));
  assert.deepEqual(log.filter(line => line === 'hands.claimCue' || line === 'opening.claim'), ['hands.claimCue'], 'her hand took it: the opening is never asked (one cue, one owner)');
  assert.equal(openingCalls.length, 0);
  assert.deepEqual(flow.owner(), { id: 'm1', owner: 'hands' }, 'the clock reads who owns the cue');
  const mood = broadcasts.find(b => b.channel === 'desk:mood')!.value as { snapshot: { cue: unknown } };
  assert.equal(mood.snapshot.cue, null, 'the windows do not see a cue her hand took');
});

test('cue chain: when her hand passes, the opening choice is asked exactly once, with the cue and the view; its answer is the owner', () => {
  const { flow, view, log, openingCalls } = moodPublish({ hands: () => false, opening: () => 'memorial' });
  flow.publish(view({ id: 's1', kind: 'speech' }));
  assert.deepEqual(log.filter(line => line === 'hands.claimCue' || line === 'opening.claim'), ['hands.claimCue', 'opening.claim'], 'hand first, then the opening');
  assert.equal(openingCalls.length, 1);
  assert.equal(openingCalls[0].cue?.id, 's1');
  assert.deepEqual(flow.owner(), { id: 's1', owner: 'memorial' });
  const nobody = moodPublish({ hands: () => false, opening: () => null });
  nobody.flow.publish(nobody.view({ id: 's2', kind: 'speech' }));
  assert.deepEqual(nobody.flow.owner(), { id: 's2', owner: null }, 'nobody took it: still recorded for this cue');
  const none = moodPublish({});
  none.flow.publish(none.view(null));
  assert.equal(none.flow.owner(), null, 'no cue, no owner');
});

test('cue chain: the opening is handed the memorial, R20, screen, sound, passed-sound, touch and moment claimants', () => {
  const { flow, view, openingCalls, log } = moodPublish({ hands: () => false, opening: () => null });
  flow.publish(view({ id: 's1', kind: 'speech' }));
  const claimants = openingCalls[0].claimants;
  assert.deepEqual(Object.keys(claimants).sort(), ['ambient', 'ambientPassed', 'memorial', 'moment', 'r20', 'touch', 'vision']);
  const speech: Cue = { id: 'x', kind: 'speech' }, motion: Cue = { id: 'y', kind: 'motion' }, sound: Cue = { id: 'z', kind: 'speech', source: { kind: 'pause' } };
  assert.equal(claimants.memorial(motion), false, 'the memorial only takes a speech cue');
  assert.equal(claimants.r20(motion), false, 'R20 only takes a speech cue');
  assert.equal(claimants.vision(speech), true, 'the screen chat could take a plain speech cue (switch and sharing on)');
  assert.equal(claimants.vision(sound), false, 'not a cue that came from a sound');
  assert.equal(claimants.ambient(sound), true, 'a sound line could take a cue that came from a sound');
  assert.equal(claimants.ambient(speech), false);
  claimants.ambientPassed(sound);
  assert.ok(log.includes('ambient.pass'), 'a sound cue that went elsewhere is passed back to the listen engine');
  assert.equal(claimants.touch(speech), false);
  assert.equal(claimants.moment(speech), null, 'I-188: no moment asked for this cue');
});

test('mood publish: every publish sets the proactive-speech gate\'s scope (her line from an old scope is dropped); a scope that cannot be read cancels it', () => {
  const ok = moodPublish({});
  ok.flow.publish(ok.view(null));
  assert.ok(ok.log.includes('gate.setScope scope:t'), 'the gate follows the speech scope and the mood token');
  const changing = moodPublish({ scopeThrows: true });
  changing.flow.publish(changing.view(null));
  assert.ok(changing.log.includes('gate.cancel context'));
  assert.ok(!changing.log.some(line => line.startsWith('gate.setScope')));
});

// ---------------------------------------------------------------- the one proactive-speech gate

const gate = () => ({ busy: false, cancel() {}, dispose() {} });

test('the proactive-speech gate: the same object for the inner loop and R20; it reads her sleep the way the opening choice does', () => {
  const shared = gate();
  assert.equal(option('innerLoopHost', 'gate', { proactiveSpeechGate: shared }), shared, 'the inner loop uses the shared gate');
  assert.equal(option('r20ProactiveOffers', 'gate', { proactiveSpeechGate: shared }), shared, 'R20 uses the shared gate');
  let asleep = false;
  const resting = option<() => boolean>('proactiveSpeechGate', 'resting', { innerLoopHost: { loop: { asleep: () => asleep } } });
  assert.equal(resting(), false);
  asleep = true;
  assert.equal(resting(), true, 'asleep, no proactive line starts or commits (T-209)');
});

/** What "she is free to say something now" reads, all free. */
function freeWorld() {
  const world = { gate: gate(), chat: false, typingUntil: 0, speaking: false, ambient: 0, rpsActive: false, dragging: false, visible: true, asleep: false, busyUser: false, interrupt: 'yes', calls: 0, available: true, exiting: false };
  const pet = { isDestroyed: () => false, isVisible: () => world.visible, isMinimized: () => false, webContents: { id: 1 } };
  const env = {
    pet, petWindowDrag: { get active() { return world.dragging; } }, replySpeechBusy: () => world.speaking, ambientSpeakingOwners: { get size() { return world.ambient; } },
    proactiveSpeechGate: world.gate, pending: { values: () => (world.chat ? [{ kind: 'chat' }] : [])[Symbol.iterator]() }, rps: { host: { get active() { return world.rpsActive; } } },
    get userInputUntil() { return world.typingUntil; }, herOnScreen: () => world.visible, get exiting() { return world.exiting; },
    innerLoopHost: { loop: { asleep: () => world.asleep } }, userActivity: { view: () => ({ state: world.busyUser ? 'busy' : 'idle' }), presence: () => ({ interrupt: world.interrupt }) },
    claudeCallsInFlight: () => world.calls, chatAvailability: { isAvailable: () => world.available },
    senseLineFree, // 2026-11-21: the sense router's `free` is the pure rule over herOnScreen
  };
  return { world, env };
}

test('may she speak now: her automatic expression, the sense router\'s line, her snack line, a keepsake and a special day all wait while the gate is busy', () => {
  const checks: [string, (env: Record<string, unknown>) => () => boolean][] = [
    ['companionCanExpress', env => evaluate<() => boolean>(`${wiringFunction('companionCanExpress')}\nreturn companionCanExpress;`, env)],
    ['senseRouter free', env => option('senseRouter', 'free', env)],
    ['feeding free', env => option('feeding', 'free', env)],
    ['keepsake calm', env => option('keepsake', 'calm', env)],
    ['specialDay calm', env => option('specialDay', 'calm', env)],
  ];
  for (const [name, make] of checks) {
    const { world, env } = freeWorld();
    const free = make(env);
    assert.equal(free(), true, `${name}: free when nothing is going on`);
    Object.defineProperty(world.gate, 'busy', { value: true, configurable: true });
    assert.equal(free(), false, `${name}: another proactive line holds the gate`);
    Object.defineProperty(world.gate, 'busy', { value: false, configurable: true });
    world.chat = true; assert.equal(free(), false, `${name}: a chat reply is running`); world.chat = false;
  }
});

test('the chat turn cancels a proactive line still out before her reply (the user spoke)', () => {
  assert.match(wiringHandler('chat'), /proactiveSpeechGate\.cancel\('user'\);/u);
});

// ---------------------------------------------------------------- a line nobody answered comes back to her

test('no reply: her prompt hears how many of her lines went unanswered; what she said first and an invite she got an answer to reach her urge', async () => {
  const context = option<{ unanswered(): number }>('innerLoopHost', 'context', { companion: { mood: { unansweredSpeech: () => 3 } }, proactiveChatFor: () => () => '' /* I-178 */ });
  assert.equal(context.unanswered(), 3, 'I-039: the unanswered count is one line in her prompt');
  const spoke: unknown[] = [], delivered: string[] = [], archived: unknown[] = [];
  const archive = option<(message: unknown) => Promise<void>>('innerLoopHost', 'archive', {
    keepsake: { noteDelivered: (id: string) => { delivered.push(`keepsake:${id}`); } }, specialDay: { noteDelivered: (id: string) => { delivered.push(`special:${id}`); } },
    impulse: { spoke: (...args: unknown[]) => { spoke.push(args); } }, companion: { currentScope: () => ({ characterId: 'her' }), ownerScope: (owner?: string) => ({ characterId: owner ?? 'her' }) /* I-209 step 2 */, memory: { appendInitiative: async (...args: unknown[]) => { archived.push(args); } } },
    speechScope: () => 's', broadcast: () => {},
  });
  await archive({ id: 'm1', text: '在吗', origin: { at: 5 } });
  assert.deepEqual(spoke, [['在吗', 'm1']], 'she spoke first: whether the user answers comes back to her mood (松绑)');
  assert.deepEqual(delivered, ['keepsake:m1', 'special:m1']);
  assert.equal(archived.length, 1);
  const answered: unknown[] = [];
  const journal = option<(id: string, entry: Record<string, unknown>) => void>('rps', 'journal', {
    appJournal: { rps: () => {} }, impulse: { inviteAnswered: (...args: unknown[]) => { answered.push(args); } }, moodJudge: { host: { note: () => {} } }, hands: { host: { gameEnded: () => {} } },
  });
  journal('her', { event: 'decline' }); journal('her', { event: 'accept' }); journal('her', { event: 'throw' });
  assert.deepEqual(answered, [['her', false], ['her', true]], 'an invite she was declined or accepted reaches her urge; nothing else does');
});

// ---------------------------------------------------------------- the quota, the cooldown and the interaction budget

test('quota: the inner loop, her urge and the game invite all read the interaction budget; an unspoken claim gives the quota and the spend back', () => {
  const budget = { tag: 'budget' };
  const companion = { budget };
  const opening = option<{ get(): unknown }>('innerLoopHost', 'budget', { companion, openingBudget: (get: () => unknown) => ({ get }) });
  assert.equal(opening.get(), budget, 'the opening choice asks the interaction budget for room (I-010)');
  assert.equal(option<() => unknown>('impulse', 'budget', { companion })(), budget, 'her urge reads the same budget');
  assert.equal(option<() => unknown>('rps', 'budget', { companion })(), budget, 'the game invite reads the same budget');
  const calls: unknown[] = [];
  const release = option<(claim: Record<string, unknown>) => void>('innerLoopHost', 'releaseSpeech', {
    companion: { mood: { releaseSpeech: (...args: unknown[]) => { calls.push(['quota', ...args]); } }, budget: { refund: (...args: unknown[]) => { calls.push(['budget', ...args]); } } } });
  release({ id: 'c1', at: 7, characterId: 'her', kind: 'speech' });
  assert.deepEqual(calls, [['quota', { id: 'c1', at: 7 }, 'her'], ['budget', 'her', 'c1']], 'the hourly and unanswered quota, then the budget spend, go back');
  const events: unknown[] = [];
  const realize = option<(claim: Record<string, unknown>, kind: string, id: string) => void>('innerLoopHost', 'realize', { companion: { mood: { event: (...args: unknown[]) => { events.push(args); } } } });
  realize({ id: 'c2', kind: 'look', at: 9, characterId: 'her' }, 'look', 'e1');
  assert.deepEqual(events, [[{ type: 'attention', id: 'e1', kind: 'look', claimed: { id: 'c2', kind: 'look', at: 9 } }, 'her']], 'a realized look carries its claim (the claim\'s own cooldown check)');
});

test('quota: the inner loop and her urge only act while she can express herself and Claude is available; the inner loop only while she is idle and free', () => {
  let can = true, available = true;
  const env = { companionCanExpress: () => can, chatAvailability: { isAvailable: () => available } };
  for (const variable of ['innerLoopHost', 'impulse']) {
    const canExpress = option<() => boolean>(variable, 'canExpress', env);
    can = true; available = true; assert.equal(canExpress(), true, variable);
    can = false; assert.equal(canExpress(), false, `${variable}: hidden, typing, a chat or her speech running`);
    can = true; available = false; assert.equal(canExpress(), false, `${variable}: Claude unavailable`);
  }
  // A sandbox name is passed by value: each case evaluates the option again over its own world.
  const current = (change: (world: ReturnType<typeof freeWorld>['world'], phase: { value: string }) => void) => {
    const { world, env } = freeWorld(); const phase = { value: 'idle' };
    change(world, phase);
    return option<() => boolean>('innerLoopHost', 'current', { ...env, userInputUntil: world.typingUntil, store: {}, companion: { mood: { get: () => ({ snapshot: { phase: phase.value } }) } } })();
  };
  assert.equal(current(() => {}), true);
  assert.equal(current(world => { world.typingUntil = Date.now() + 60_000; }), false, 'the user is typing');
  assert.equal(current(world => { world.dragging = true; }), false, 'she is being dragged');
  assert.equal(current((_world, phase) => { phase.value = 'pat'; }), false, 'not idle');
  assert.equal(current(world => { world.chat = true; }), false, 'a chat reply is running');
  assert.equal(current(world => { world.visible = false; }), false, 'she is not on the screen');
});

// ---------------------------------------------------------------- the deep-night rest reminder: once a night, across restarts

test('rest reminder: its night is kept in the profile (inner-loop-state.json, not the diagnostics file), so a restart the same night does not remind again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'initiative-rest-'));
  try {
    const env = { store: { directory: dir }, path };
    const file = option<() => string | null>('innerLoopHost', 'restReminderFile', env);
    assert.equal(file(), path.join(dir, 'inner-loop-state.json'));
    assert.notEqual(file(), option<() => string | null>('innerLoopHost', 'diagnosticsFile', env)(), 'not the developer log');
    assert.equal(option<() => string | null>('innerLoopHost', 'restReminderFile', { store: undefined, path })(), null, 'nothing before the profile is known');
    const first = new RestReminderStore(option<() => string | null>('innerLoopHost', 'restReminderFile', env));
    await first.load();
    assert.equal(first.used('2026-11-16'), false);
    first.remember('2026-11-16'); await first.flush();
    const restarted = new RestReminderStore(option<() => string | null>('innerLoopHost', 'restReminderFile', env));
    await restarted.load();
    assert.equal(restarted.used('2026-11-16'), true, 'the same night after a restart: no second reminder');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- her folder: only through its own host

test('her folder: what she gives and keeps is written by her folder\'s host with a fresh ticket; the keepsakes and special days use that host; its state stays in the profile', async () => {
  const writes: unknown[] = []; let tickets = 0; let enabled = false;
  const herFolder = { enabled: () => enabled, beginKeepsake: () => ({ ticket: ++tickets, real: 'C:/her' }),
    syncText: async (...args: unknown[]) => { writes.push(['text', ...args]); return { ok: true }; }, keepPicture: async (...args: unknown[]) => { writes.push(['picture', ...args]); return { ok: true }; } };
  const folder = option<{ enabled(): boolean; syncText(name: string, content: string): Promise<unknown>; keepPicture(stem: string, png: Uint8Array): Promise<unknown> }>('give', 'folder', {
    herFolder, characterCards: { getActive: () => ({}) }, cardLanguageOf: () => 'zh-CN' });
  assert.equal(folder.enabled(), false, 'off while her folder is off');
  enabled = true; assert.equal(folder.enabled(), true);
  await folder.syncText('我们的小东西.md', 'x');
  const png = new Uint8Array([1]);
  await folder.keepPicture('pic', png);
  assert.deepEqual(writes, [['text', { ticket: 1, real: 'C:/her' }, '我们的小东西.md', 'x'], ['picture', { ticket: 2, real: 'C:/her' }, 'pic', png]], 'each write has its own ticket from her folder');
  assert.equal(option('keepsake', 'folder', { herFolder }), herFolder, 'a keepsake is written by her folder\'s host');
  assert.equal(option('specialDay', 'folder', { herFolder }), herFolder, 'a special-day line reads her folder\'s host');
  const profile = option<() => string | null>('herFolder', 'profileDirectory', { store: { directory: 'C:/profile' } });
  assert.equal(profile(), 'C:/profile', 'her folder\'s own state is kept in the profile');
  assert.equal(option<() => string | null>('herFolder', 'profileDirectory', { store: undefined })(), null);
});

// ---------------------------------------------------------------- cancelling her proactive line cancels the other parts' work

test('cancelProactiveVision: her line, the memorial, her hand, what she holds out and R20 go back; input-only keeps the four', () => {
  const run = (inputOnly: boolean) => {
    const log: string[] = [];
    const env = {
      textMemorialHost: { cancel: () => { log.push('memorial'); } }, hands: { host: { cancel: () => { log.push('hands'); } } }, give: { host: { cancel: () => { log.push('give'); } } },
      r20ProactiveOffers: { cancel: () => { log.push('r20'); } }, visionPresentation: { clear: () => { log.push('presentation'); } },
      speechRuntime: { cancelReply: (owner: number, id: string) => { log.push(`readout ${owner}:${id}`); } }, cancelReplyStyle: (id: string) => { log.push(`style ${id}`); },
      broadcast: (channel: string, value: { id: string }) => { log.push(`${channel} ${value.id}`); }, proactiveSpeechGate: { cancel: () => { log.push('gate'); } },
      proactiveVision: { cancel: () => { log.push('vision'); } }, cameraSamples: { cancel: () => { log.push('samples'); } },
    };
    const flow = evaluate<{ cancel(inputOnly: boolean): void; last(): unknown }>(`let lastVisionSpeech = { owner: 4, id: 'v1' };\n${wiringFunction('cancelProactiveVision')}\nreturn { cancel: cancelProactiveVision, last: () => lastVisionSpeech };`, env);
    flow.cancel(inputOnly);
    return { log, last: flow.last() };
  };
  const all = run(false);
  assert.deepEqual(all.log, ['memorial', 'hands', 'give', 'r20', 'presentation', 'readout 4:v1', 'style v1', 'desk:vision-initiative v1', 'gate', 'vision', 'samples']);
  assert.equal(all.last, null);
  const input = run(true);
  assert.deepEqual(input.log, ['presentation', 'readout 4:v1', 'style v1', 'desk:vision-initiative v1', 'gate', 'vision', 'samples'], 'typing only stops her line, not the others\' work');
});

test('ackVisionInitiative: only the pet window, and an inner-loop line only when it is still current', async () => {
  const world = { generation: 1, scope: 's', owns: true, ack: true, canSpeak: true };
  const started: unknown[] = [];
  const env = {
    pet: { webContents: { id: 1 } }, get visionGeneration() { return world.generation; }, speechScope: () => world.scope,
    innerLoopHost: { loop: { owns: () => world.owns, ack: async () => { world.generation += 0; return world.ack; } }, presentation: { canSpeak: () => world.canSpeak } },
    beginInitiativeSpeech: (...args: unknown[]) => { started.push(args); }, visionEligible: () => false,
    proactiveVision: { ack: async () => false }, visionPresentation: { canSpeak: () => false },
  };
  const ack = evaluate<(sender: number, id: unknown) => Promise<boolean>>(`let lastVisionSpeech = null;\n${wiringFunction('ackInnerInitiative')}\nreturn (${wiringHandler('ackVisionInitiative')});`, env);
  assert.equal(await ack(2, 'line'), false, 'another window cannot acknowledge her line');
  assert.equal(started.length, 0);
  world.canSpeak = false;
  assert.equal(await ack(1, 'line'), false, 'a line whose presentation is no longer current does not start reading');
  world.canSpeak = true;
  assert.equal(await ack(1, 'line'), true);
  assert.deepEqual(started, [[1, 'line']]);
});

// The user's own message (and a context change) ends the vision context, and that cancels the proactive line still outside.
// Gap G9 of the mutation lists (docs/claude/2026-11-16-dev-tools-size-mutate.md): when this line moved from electron/main.ts into the
// senses wiring no test read it any more.
test('clearVisionContext cancels the proactive vision line that is still outside, and everything else the context owned', () => {
  const log: string[] = [];
  const ping = (name: string) => () => { log.push(name); };
  const env = {
    cancelProactiveVision: (inputOnly?: boolean, keepLine?: boolean) => { log.push(`cancelProactiveVision(${inputOnly === true ? 'inputOnly' : 'all'},${keepLine === true ? 'keepLine' : 'dropLine'})`); },
    surprisePreviewHost: { invalidate: ping('surprise') }, languageAuthoring: { invalidate: ping('language') },
    visualAuthoring: { invalidate: ping('visual') }, bodyAuthoring: { invalidate: ping('body') },
    visualSelfRuntime: { clear: ping('visualSelf.clear') }, lookAttachments: { abort: ping('lookAttachments.abort') },
    lookTurns: { clear: ping('lookTurns.clear') }, selfLook: { cancel: ping('selfLook.cancel') }, media: { clearCamera: ping('camera.clear') },
    screenSnapshots: { configure: ping('screen.configure') }, broadcast: (channel: string) => { log.push(`broadcast ${channel}`); },
    forgetCallFrames: ping('forgetCallFrames'), // I-161 A: a call's small frames go with the context
  };
  const clear = evaluate<() => void>(`let visionGeneration = 0, visionContextIdentity = '', visualSelfIdentity = '', visualSelfScreenSourceId = null, visualSelfCameraOwnerId = null;
${wiringFunction('clearVisionContext')}\nreturn clearVisionContext;`, env);
  clear();
  assert.ok(log.includes('cancelProactiveVision(all,dropLine)'), 'the proactive line that is still outside is cancelled (not only the input-only cancel)');
  for (const step of ['lookAttachments.abort', 'forgetCallFrames', 'lookTurns.clear', 'selfLook.cancel', 'camera.clear', 'broadcast desk:vision-context-cleared'])
    assert.ok(log.includes(step), `${step} still runs`);
});
