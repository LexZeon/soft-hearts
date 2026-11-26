// 大脑的接线 (wiring rewrite step 4h, docs/claude/2026-11-17-wiring-step-4h.md): the gates every reply passes. Companion chat goes to her
// Claude chat process as a chat task without tools (kind 'chat', writable false); one reply runs at a time and finishes once ('complete' only
// when it was not stopped); a stopped, late or context-changed result writes nothing (voice history, R20, her reply's voice and emoji, the
// vision support, offers); a cancel stops only what the window may stop; a stopped reply never shows her outage line; the authoring lease
// is one lease; the module router, 停停说说 and the outage line pregeneration keep away from Claude when it is unavailable or busy; the
// speak-only judge's call ends with its reply; the listening switch off means no heard words in the turn; I-139 and I-134 stay off when
// their switches are off.
// Each test evaluates the wiring's actual text (tests/helpers/wiring-source.ts: across electron/main.ts and electron/wiring/*.ts, so it
// follows the code when it moves) over fakes. Before this file most of these checks had no test that failed when the check was removed
// (the mutation table in the record; scripts/dev/mutations/brain.json keeps them).
// Reads as text (test-affected selects this test when they change): 'electron/main.ts', 'electron/wiring/brain-wiring.ts', 'electron/wiring/brain-chat-wiring.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { relaxedPromptsActive } from '../shared/brain/prompt-switches';
import { wiringFunction, wiringHandler, wiringNodes } from './helpers/wiring-source';
import { callArguments, chatWorld, evaluate, expression, option, settle, type Task } from './helpers/chat-world'; // the chat world (moved out 2026-11-20)

// ---------------------------------------------------------------- her chat process: a chat task, no tools; one reply, finished once

test('a typed message goes to her chat process as a chat task without tools; the reply finishes once, complete, and leaves no task behind', async () => {
  const w = chatWorld();
  w.send('r1');
  await settle(() => w.settled('r1'), 'the reply settles');
  assert.equal(w.tasks.length, 1, 'one call to her chat process');
  const task = w.tasks[0];
  assert.equal(task.kind, 'chat', 'a chat task (the session refuses anything else)');
  assert.equal(task.writable, false, 'never writable');
  assert.ok(!('tools' in task) && !('allowedTools' in task), 'no tools are named');
  assert.deepEqual(w.begins, ['你好'], 'her turn began once');
  assert.deepEqual(w.finishes, ['complete'], 'finished once, complete');
  assert.deepEqual(w.events.filter(event => event.id === 'r1' && event.type !== 'status').map(event => event.type), ['done'], 'one done, no error');
  assert.equal(w.pending.size, 0, 'the finished reply leaves pending');
  assert.ok(w.log.includes('r20 r1') && w.log.includes('emoji reply-r1') && w.log.includes('speech recorded'), 'a current reply is written');
  assert.deepEqual((w.voiceHost.history as { scope: string }).scope, 'scope-1');
});

test('one chat at a time; an id already in flight (also another kind) is refused', async () => {
  const w = chatWorld({ hold: true });
  w.send('r1');
  assert.throws(() => w.send('r2'), /上一项任务仍在进行/u, 'a second chat while one runs');
  w.release();
  await settle(() => w.settled('r1'), 'the first settles');
  assert.equal(w.tasks.length, 1);
  // no chat in flight now: an id a Claude task holds is still refused (its entry would be replaced and its stop lost)
  const agent = new AbortController();
  w.pending.set('busy', { controller: agent, owner: 1, kind: 'agent' });
  assert.throws(() => w.send('busy'), /上一项任务仍在进行/u, 'the same id as a task in flight');
  assert.equal(w.pending.get('busy')?.controller, agent);
  assert.equal(w.tasks.length, 1);
});

test('a reply stopped while it streams finishes stopped, never complete; nothing of it is written; the stop is not her outage line', async () => {
  const w = chatWorld({ hold: true });
  w.send('r1');
  await settle(() => w.tasks.length === 1, 'streaming');
  w.cancel(1, 'r1');
  assert.ok(w.pending.get('r1')?.controller.signal.aborted, 'the cancel aborts the reply');
  w.release();
  await settle(() => w.settled('r1'), 'settles');
  assert.deepEqual(w.finishes, ['stopped']);
  assert.ok(!w.log.some(line => /^(r20|emoji|speech recorded|take me there offer|her folder offer)/u.test(line)), w.log.join('\n'));
  assert.equal(w.voiceHost.history, null);
  const error = w.events.find(event => event.id === 'r1' && event.type === 'error');
  assert.ok(error && error.text === '已停止。' && !('outage' in error), 'a stop is not shown as an outage');
  assert.equal(w.pending.size, 0);
});

test('a stop during archiving: no offers, R20, voice history, voice or emoji after it', async () => {
  const w = chatWorld();
  w.env.onFinish = async (status: string) => { if (status === 'complete') w.cancel(1, 'r1'); };
  w.send('r1');
  await settle(() => w.settled('r1'), 'settles');
  assert.equal(w.finishes[0], 'complete');
  assert.ok(!w.log.some(line => /^(r20|emoji|speech recorded|take me there offer|her folder offer)/u.test(line)), w.log.join('\n'));
  assert.equal(w.voiceHost.history, null);
});

test('cancel: a window cannot stop another window\'s Claude task; a chat can be stopped from either window', () => {
  const w = chatWorld();
  const agent = new AbortController(), chat = new AbortController();
  w.pending.set('a1', { controller: agent, owner: 1, kind: 'agent' });
  assert.throws(() => w.cancel(2, 'a1'), /另一个窗口/u);
  assert.equal(agent.signal.aborted, false);
  w.pending.set('c1', { controller: chat, owner: 1, kind: 'chat' });
  w.cancel(2, 'c1');
  assert.equal(chat.signal.aborted, true);
  assert.throws(() => w.cancel(1, 42), /请求编号/u);
});

// ---------------------------------------------------------------- a late result writes nothing

test('the conversation changed while she replied: no voice history, R20, voice or emoji from the old reply', async () => {
  const w = chatWorld({ hold: true });
  w.send('r1');
  await settle(() => w.tasks.length === 1, 'streaming');
  w.state.scope = 'scope-2';
  w.release();
  await settle(() => w.settled('r1'), 'settles');
  assert.equal(w.voiceHost.history, null, 'no voice history for the new conversation');
  assert.ok(!w.log.includes('r20 r1'), 'R20 does not note a reply from another conversation');
  assert.ok(!w.log.includes('speech recorded') && !w.log.includes('emoji reply-r1'), 'no voice or emoji');
});

test('the single emoji\'s context changed while she replied: no emoji from the old reply (her voice still follows)', async () => {
  const w = chatWorld({ hold: true });
  w.send('r1');
  await settle(() => w.tasks.length === 1, 'streaming');
  w.state.emoji = 'emoji-2';
  w.release();
  await settle(() => w.settled('r1'), 'settles');
  assert.ok(!w.log.includes('emoji reply-r1'));
  assert.ok(w.log.includes('speech recorded'));
});

test('the provider changed while she replied with a picture: the picture support is not credited to the new one', async () => {
  const w = chatWorld({ hold: true, attachments: [{ dataUrl: 'data:image/png;base64,AA', source: 'screen' }] });
  w.send('r1');
  await settle(() => w.tasks.length === 1, 'streaming');
  w.state.provider = { kind: 'claude', model: 'sonnet' };
  w.release();
  await settle(() => w.settled('r1'), 'settles');
  assert.ok(!w.log.includes('image success'));
  assert.equal(w.voiceHost.history, null);
});

test('a companion command whose task was replaced is no longer current', async () => {
  const w = chatWorld({ command: true });
  let open: () => void = () => {};
  w.env.commandGate = new Promise<void>(resolve => { open = resolve; });
  w.send('r1', '把置顶关掉');
  await settle(() => typeof w.env.commandCurrent === 'function', 'the command dialogue ran');
  // its own task still in flight: current; the same id taken by another task: not current
  const own = w.pending.get('r1');
  assert.ok(own);
  assert.equal((w.env.commandCurrent as () => boolean)(), true);
  w.pending.set('r1', { controller: new AbortController(), owner: 1, kind: 'chat' });
  assert.equal((w.env.commandCurrent as () => boolean)(), false);
  w.pending.set('r1', own!);
  open();
  await settle(() => w.settled('r1'), 'settles');
});

test('the profile context\'s abort stops only its own reply', async () => {
  const w = chatWorld({ profile: true, hold: true });
  w.send('r1');
  await settle(() => typeof w.env.profileAbort === 'function', 'the profile context began');
  const own = w.pending.get('r1')!, other = new AbortController();
  w.pending.set('r1', { controller: other, owner: 1, kind: 'chat' });
  assert.equal((w.env.profileAbort as () => boolean)(), false, 'a replaced task is not aborted through it');
  assert.equal(own.controller.signal.aborted, false); assert.equal(other.signal.aborted, false);
  w.pending.set('r1', own);
  assert.equal((w.env.profileAbort as () => boolean)(), true, 'its own reply is');
  w.release();
  await settle(() => w.settled('r1'), 'settles');
});

test('I-134 on: the refusal fallback runs only for a current, unstopped reply', async () => {
  const w = chatWorld({ longChat: true, hold: true });
  w.send('r1');
  await settle(() => w.tasks.length === 1, 'streaming');
  const fallback = w.tasks[0].refusalFallback as { current(): boolean };
  assert.equal(fallback.current(), true);
  w.state.scope = 'scope-2';
  assert.equal(fallback.current(), false, 'another conversation');
  w.state.scope = 'scope-1';
  w.cancel(1, 'r1');
  assert.equal(fallback.current(), false, 'stopped');
  w.release();
  await settle(() => w.settled('r1'), 'settles');
});

// ---------------------------------------------------------------- privacy: the listening switch off means no heard words

test('listening off (no session): the turn carries no heard words; on, only its own session\'s', async () => {
  const off = chatWorld();
  off.send('r1');
  await settle(() => off.settled('r1'), 'settles');
  assert.ok(!String(off.tasks[0].prompt).includes('external-audio-data'), 'no transcript while listening is off');
  const asked: unknown[] = [];
  const on = chatWorld({ audioSession: { scope: { characterId: 'c1' }, sessionId: 's-7' } });
  (on.env.ambientStore as { context: unknown }).context = (_scope: unknown, query: unknown) => { asked.push(query); return [{ id: 'h', text: 'HEARD' }]; };
  on.send('r1');
  await settle(() => on.settled('r1'), 'settles');
  assert.ok(String(on.tasks[0].prompt).includes('HEARD'));
  assert.deepEqual(asked, [{ sessionId: 's-7' }], 'only the current session\'s words');
});

// ---------------------------------------------------------------- a new conversation, a new context

test('a new conversation stops her reply in flight; a context change closes her chat process', async () => {
  const log: string[] = [];
  const chat = new AbortController(), agent = new AbortController();
  const pending = new Map<string, Task>([['c', { controller: chat, owner: 1, kind: 'chat' }], ['a', { controller: agent, owner: 1, kind: 'agent' }]]);
  const env = { pending, companionCommands: null, userProfileManagement: null, voiceHost: { history: 'old' }, revokeVoice() {}, stopSystemAudio() {},
    proactiveSpeechGate: { cancel() {} }, clearVisionContext() {}, speechRuntime: { stop() {} }, clearReplySpeech() {}, refreshVisionContext() {},
    companion: { newConversation: async () => { log.push(`new conversation; chat stopped ${chat.signal.aborted}`); } } };
  await expression<() => Promise<void>>(wiringHandler('newConversation'), env)();
  assert.deepEqual(log, ['new conversation; chat stopped true']);
  assert.equal(agent.signal.aborted, false, 'a Claude task goes on');
  assert.equal(env.voiceHost.history, null);
  const closed: string[] = [];
  const listener = expression<() => void>(callArguments('companion.onContextChange')[0], { claudeChat: { close: (why: string) => { closed.push(why); } },
    chatSettings: { invalidate() { closed.push('settings'); } }, takeMeThere: { invalidate() { closed.push('go'); } } });
  listener();
  assert.deepEqual(closed, ['context', 'settings', 'go']);
});

// ---------------------------------------------------------------- the authoring lease

test('the authoring lease: one at a time, refused while anything is in flight; a late release frees only its own lease', () => {
  const pending = new Map<string, Task>();
  const env = { pending, exiting: false, asrTask: null, foregroundAsr: { foregroundBusy: false }, readingInputSpeech: false, voiceHost: { busy: false },
    proactiveVision: { pendingId: null }, replySpeechBusy: () => false, ambientSpeakingOwners: new Set(), syncFatigueActivity() {} };
  const reserve = evaluate<(owner: number, id: string, controller: AbortController, source: string) => () => void>(
    `${wiringFunction('reserveCompanionAuthoring')}\nreturn reserveCompanionAuthoring;`, env);
  const first = new AbortController();
  const release = reserve(1, 'x', first, 'language-authoring');
  assert.equal(pending.get('x')?.controller, first);
  assert.throws(() => reserve(1, 'y', new AbortController(), 'visual-authoring'), /仍在进行/u, 'a second authoring shares no lease');
  release();
  assert.equal(pending.size, 0);
  const second = new AbortController();
  reserve(1, 'x', second, 'visual-authoring');
  release(); // the first lease's release, late
  assert.equal(pending.get('x')?.controller, second, 'the newer lease stays');
  for (const busy of [{ replySpeechBusy: () => true }, { exiting: true }]) {
    const other = evaluate<typeof reserve>(`${wiringFunction('reserveCompanionAuthoring')}\nreturn reserveCompanionAuthoring;`, { ...env, pending: new Map(), ...busy });
    assert.throws(() => other(1, 'z', new AbortController(), 'language-authoring'), /仍在进行/u, JSON.stringify(Object.keys(busy)));
  }
});

// ---------------------------------------------------------------- Claude only while it is available, not busy, and not after a stop

test('the module router and 停停说说 call haiku only while Claude is available; the outage line is not prepared while a chat runs', () => {
  const down = { chatAvailability: { isAvailable: () => false } }, up = { chatAvailability: { isAvailable: () => true } };
  for (const variable of ['moduleRouter', 'pauseTalk']) {
    assert.equal(option<() => boolean>(variable, 'available', down)(), false, `${variable}: unavailable`);
    assert.equal(option<() => boolean>(variable, 'available', up)(), true, `${variable}: available`);
  }
  const pending = new Map<string, Task>();
  const busy = option<() => boolean>('chatOutage', 'chatBusy', { pending });
  assert.equal(busy(), false);
  pending.set('r', { controller: new AbortController(), owner: 1, kind: 'chat' });
  assert.equal(busy(), true, 'a chat in flight');
  pending.set('r', { controller: new AbortController(), owner: 1, kind: 'agent' });
  assert.equal(busy(), false, 'a Claude task is not a chat');
});

test('the speak-only judge\'s haiku call ends with its reply (the reply\'s signal goes through)', async () => {
  const judge = callArguments('companion.setSpeakOnly')[0];
  let oneShot: ((prompt: string, system: string, signal: AbortSignal) => Promise<string>) | null = null;
  const signals: unknown[] = [];
  expression(judge, { SPEAK_ONLY_ON: true, speakOnlyAppJudge: (_on: boolean, ask: typeof oneShot) => { oneShot = ask; return null; },
    quickLineWithClaude: async (_prompt: string, _system: string, signal?: AbortSignal) => { signals.push(signal); return { text: 'ok' }; },
    reactions: { speakOnlyWarm: () => null } });
  const controller = new AbortController();
  assert.equal(await oneShot!('p', 's', controller.signal), 'ok');
  assert.deepEqual(signals, [controller.signal]);
});

// ---------------------------------------------------------------- switches off stay off

test('I-139 stays off unless speak-only is on too; I-134\'s greeting archive is off with the new chat', () => {
  // the prompt switch block (wireBrain / main.ts): whatever the channel defaults say, relaxed needs speak-only
  const call = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === 'setPromptSwitches');
  assert.equal(call.length, 1);
  let block: ts.Node = call[0].node;
  while (!ts.isBlock(block.parent)) block = block.parent;
  const text = block.parent.getText(call[0].ast);
  for (const [speakOnly, expected] of [[false, false], [true, true]] as const) {
    const set: unknown[] = [];
    evaluate(`${text}\nreturn null;`, { promptSwitchesFromEnv: () => ({ relaxed: true, situation: true }), promptSwitchDefaults: () => ({}), installedDesktopChannel: null,
      app: { isPackaged: true }, process: { env: {} }, relaxedPromptsActive, SPEAK_ONLY_ON: speakOnly, setPromptSwitches: (value: unknown) => { set.push(value); } });
    assert.equal((set[0] as { relaxed: boolean }).relaxed, expected, `speak-only ${speakOnly}`);
  }
  assert.equal(option<boolean>('greetingArchive', 'enabled', { LONG_CHAT: { enabled: false } }), false);
  assert.equal(option<boolean>('greetingArchive', 'enabled', { LONG_CHAT: { enabled: true } }), true);
});
