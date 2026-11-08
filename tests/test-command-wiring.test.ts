/**
 * D2 / I-008: the wiring (electron/test-commands/wiring.ts) against the REAL companion service, mood host, her-life host and
 * user-state store: a "测试：…" message in developer mode changes exactly what its entry says, and in normal mode changes nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { createTestCommands, type TestCommandPorts } from '../electron/test-commands/wiring';
import { CUE_BLOCKERS, cueBlocker, type CueGateState } from '../electron/test-commands/cue-gate';
import type { TestCommandNote, TestEffect } from '../shared/test-command';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));
/** Waits for something that needs real time (the waiting entry's poll, the log file's appends); a busy machine just waits longer. */
async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) assert.fail('timed out waiting'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const open: CueGateState = { petVisible: true, dragging: false, userTyping: false, speaking: false, chatting: false, playing: false, claudeAvailable: true, idle: true };

async function withWiring(run: (h: {
  service: CompanionService; commands: ReturnType<typeof createTestCommands>; notes: TestCommandNote[]; effects: TestEffect[]; calls: string[];
  gate: { state: CueGateState }; settings: { innerLoopOn: boolean }; directory: string;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-test-wiring-'));
  const service = new CompanionService(directory, () => {});
  const notes: TestCommandNote[] = [], effects: TestEffect[] = [], calls: string[] = [];
  const gate = { state: { ...open } }, settings = { innerLoopOn: true };
  const ports: TestCommandPorts = {
    companion: () => service,
    innerLoop: () => ({ resetPacing: () => { calls.push('innerLoop.resetPacing'); } }) as never,
    rps: () => ({ testInvite: () => { calls.push('rps.testInvite'); return true; }, testStart: () => { calls.push('rps.testStart'); return false; } }) as never,
    diary: () => ({ writeNow: () => { calls.push('diary.writeNow'); return 'recording-off'; } }) as never,
    innerLoopOn: () => settings.innerLoopOn,
    gate: () => gate.state,
    note: (_owner, note) => { notes.push(note); },
    effect: effect => { effects.push(effect); },
    expression: recipe => { calls.push(`expression:${recipe}`); return true; },
    action: async id => { calls.push(`action:${id}`); return { status: 'played', missing: [], detail: '' }; },
    directory: () => directory,
  };
  const commands = createTestCommands(ports);
  try { await run({ service, commands, notes, effects, calls, gate, settings, directory }); }
  finally { commands.dispose(); await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const last = (notes: TestCommandNote[]) => notes.at(-1)?.text ?? '';

test('normal mode: a "测试：…" message is not a command and nothing at all changes', async () => withWiring(async ({ service, commands, notes, effects, calls }) => {
  service.mood.activate('gene');
  const before = JSON.stringify(service.mood.get().snapshot.values);
  for (const text of ['测试：发呆', '测试：开心', '测试：我累了', '测试：想不想跳', '测试：帮助'])
    assert.deepEqual(commands.accept(7, text), { handled: false, id: '' });
  await settle();
  assert.deepEqual(notes, []); assert.deepEqual(effects, []); assert.deepEqual(calls, []);
  assert.equal(service.herLife.view('gene'), null);
  assert.equal(JSON.stringify(service.mood.get().snapshot.values), before);
  assert.equal(service.userState.view('gene'), null);
}));

test('developer mode: each message changes what its entry says, through the real objects', async () => withWiring(async ({ service, commands, notes, effects, calls, directory }) => {
  service.mood.activate('gene');
  service.mood.setDeveloperMode(true);
  const ask = async (text: string) => { const outcome = commands.accept(7, text); assert.equal(outcome.handled, true, text); await settle(); return last(notes); };

  assert.match(await ask('测试：发呆'), /已让她开始发呆/u);
  assert.equal(service.herLife.view('gene')!.activity, 'daydream');
  assert.equal(service.mood.get().herLife?.activity, 'daydream', 'the mood view (the stage) carries it');
  assert.match(await ask('测试：去忙自己的事'), /她按自己的心情和性格/u);
  assert.notEqual(service.herLife.view('gene')!.activity, 'drowsy');

  assert.match(await ask('测试：开心'), /已把她的心情设成“愉快”/u);
  assert.equal(service.mood.get().snapshot.primary, 'happy');
  assert.match(await ask('测试：难过'), /“伤感”/u);
  assert.equal(service.mood.get().snapshot.primary, 'sad');
  assert.match(await ask('测试：困了'), /明显困倦/u);
  assert.equal(service.mood.get().fatigue?.phase, 'drowsy');
  assert.match(await ask('测试：恢复心情'), /心情已放回基线/u);
  assert.equal(service.mood.get().snapshot.primary, 'calm');
  assert.equal(service.mood.get().fatigue?.phase, 'awake');

  assert.match(await ask('测试：我累了'), /你现在很累，约 90 分钟/u);
  assert.equal(service.userState.current('gene')?.state, 'tired');
  assert.equal(service.mood.get().userState?.state, 'tired', 'the developer panel shows it');
  assert.match(await ask('测试：清除状态'), /已清除/u);
  assert.equal(service.userState.current('gene'), null);

  assert.match(await ask('测试：熟悉度老朋友'), /熟悉度临时设成“老朋友”.*没开“慢慢熟起来”/su, 'the plain card is told it will show no difference');
  assert.match(await ask('测试：有点闷'), /她现在有点闷/u);
  assert.equal(service.herNeeds.view('gene')?.id, 'lonely');
  assert.equal(service.herNeeds.view('gene')?.usedToday, 0, 'the day\'s counts are untouched');
  assert.match(await ask('测试：想不想跳'), /重新判一次/u);
  assert.deepEqual(effects, ['music-rejudge']);
  assert.match(await ask('测试：邀请猜拳'), /递出了猜拳邀请/u);
  assert.match(await ask('测试：猜拳'), /现在不行/u);
  assert.match(await ask('测试：写日记'), /先打开“允许记录”/u);
  assert.deepEqual(calls, ['rps.testInvite', 'rps.testStart', 'diary.writeNow']);

  const logFile = path.join(directory, 'dev', 'test-commands.jsonl');
  const lines = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  await until(async () => (await lines()).length >= 14);
  const diagnostics = (await lines()).map(line => JSON.parse(line));
  assert.equal(diagnostics.length, 14, 'one line per command');
  for (const line of diagnostics) {
    assert.deepEqual(Object.keys(line).sort(), ['at', 'entry', 'via']);
    assert.equal(line.via, 'local');
    assert.match(line.entry, /^[A-Z0-9]+\.[a-z-]+$/u, 'an entry id only, never the user\'s words');
  }
}));

test('developer mode: the inner loop entries wait for the gate, then force the cue in the mood model and reset the loop\'s pacing', async () => withWiring(async ({ service, commands, notes, calls, gate, settings }) => {
  service.mood.activate('gene');
  service.mood.setDeveloperMode(true);
  gate.state = { ...open, userTyping: true };
  commands.accept(7, '测试：小动作');
  await settle();
  assert.match(notes.map(note => note.text).join('\n'), /现在不方便（你刚刚还在和她聊天）/u);
  assert.equal(service.mood.get().snapshot.cue, null, 'nothing is forced while she is not free');
  gate.state = { ...open };
  await until(() => /已给她一次小动作的时机/u.test(last(notes)));
  assert.match(last(notes), /已给她一次小动作的时机/u);
  assert.equal(service.mood.get().snapshot.cue?.kind, 'motion');
  assert.ok(calls.includes('innerLoop.resetPacing'));
  settings.innerLoopOn = false;
  commands.accept(7, '测试：说话时机');
  await settle();
  assert.match(last(notes), /“内心循环”开关是关的/u);
}));

test('before the companion exists, or before any character is active, nothing is handled and nothing throws', async () => {
  const none = createTestCommands({ companion: () => undefined, innerLoop: () => { throw new Error('unused'); }, rps: () => { throw new Error('unused'); },
    diary: () => undefined, innerLoopOn: () => true, gate: () => open, note: () => assert.fail('no note'), effect: () => assert.fail('no effect'), expression: () => assert.fail('no expression'), action: () => assert.fail('no action'), directory: () => null });
  assert.deepEqual(none.accept(7, '测试：发呆'), { handled: false, id: '' });
  none.dispose();
  await withWiring(async ({ commands, notes }) => {
    // A fresh companion: developer mode is off, so the message is ordinary chat.
    assert.deepEqual(commands.accept(7, '测试：发呆'), { handled: false, id: '' });
    await settle();
    assert.deepEqual(notes, []);
  });
});

test('the cue gate names why she is busy, the way the automatic expressions are gated', () => {
  assert.equal(cueBlocker(open), null);
  const cases: [Partial<CueGateState>, string][] = [
    [{ petVisible: false }, CUE_BLOCKERS.hidden], [{ dragging: true }, CUE_BLOCKERS.dragging], [{ userTyping: true }, CUE_BLOCKERS.typing],
    [{ speaking: true }, CUE_BLOCKERS.speaking], [{ chatting: true }, CUE_BLOCKERS.chatting], [{ playing: true }, CUE_BLOCKERS.playing],
    [{ claudeAvailable: false }, CUE_BLOCKERS.unavailable], [{ idle: false }, CUE_BLOCKERS.busy],
  ];
  for (const [patch, reason] of cases) assert.equal(cueBlocker({ ...open, ...patch }), reason, reason);
});

/**
 * The window's side, with the real `sendChat` declaration from src/main.ts (the same way tests/message-expectation.test.ts runs it; no app or
 * browser is launched): developer mode on + "测试：…" asks the host; "handled" shows the user's line and sends no chat at all; "not handled"
 * falls through to the ordinary chat request carrying the literal text; developer mode off never asks.
 */
async function sendWith(options: { developer: boolean; content: string; handled?: boolean; attachments?: unknown[]; rejects?: boolean }) {
  const { readFileSync } = await import('node:fs');
  const ts = (await import('typescript')).default;
  const { transformSync } = await import('esbuild');
  const { asksTestCommand } = await import('../shared/test-command');
  const { lookHint, turnAttachments } = await import('../src/look-send');
  const { pauseCutForSend } = await import('../src/ui/pause-talk-send');
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sendChat');
  assert.ok(declaration);
  const js = transformSync(declaration.getText(ast), { loader: 'ts', target: 'es2022' }).code;
  const log: string[] = [], requests: unknown[] = [], shown: unknown[] = [], notices: string[] = [];
  const input = { value: options.content };
  const wrapper = `const claudeTasksOffered=()=>false;let activeChat=null,pendingReadoutControl=null,attachments=initialAttachments,history=[],reply='',activeUser=null,assistantNode=null;`
    + `const isPet=false,settings={provider:{kind:'claude'},voice:{}},characterState=null;const replyPresentation={interrupt(){throw new Error('F7: off, the reveal is never touched')}};const crypto={randomUUID:()=>'guard-id'};const $=()=>input;const speech={stop(){},prewarm(){}};`
    + `const syncBodyInputGate=()=>{},setChatBusy=()=>{},renderAttachments=()=>{};const userProfilePanel={messageExpectation:()=>null};const save=async()=>true;`
    + `const onStream=event=>log.push('stream:'+event.type);const window={desktop:{noteUserInput:async()=>{log.push('noteUserInput')},sharedAttachments:async()=>[],`
    + `runTestCommand:async text=>{log.push('runTestCommand');if(rejects)throw new Error('ipc down');return {handled,id:'cmd-1'}},chat:async value=>{requests.push(value)}}};${js};return {send:()=>sendChat(true),pending:()=>pendingReadoutControl};`;
  const api = new Function('input', 'log', 'requests', 'initialAttachments', 'handled', 'rejects', 'immersiveDeveloperMode', 'asksTestCommand', 'testNotes', 'notify',
    'outgoingChatMessages', 'scanStopReadoutRequest', 'scanFramingRequest', 'scanBreathRequest', 'lookHint', 'turnAttachments', 'pauseCutForSend', wrapper)(
    input, log, requests, options.attachments ?? [], options.handled === true, options.rejects === true, options.developer, asksTestCommand,
    { begin: (id: string, text: string) => shown.push([id, text]) }, (message: string) => notices.push(message),
    (history: unknown[], user: unknown) => [...history, user], () => 'none', () => 'none', () => ({ kind: 'none' }), lookHint, turnAttachments, pauseCutForSend);
  await api.send();
  return { log, requests, shown, notices, input, pending: api.pending() };
}

test('the window: developer mode + a command the host handles shows the user\'s line and sends no chat, no input note, nothing to the model', async () => {
  const r = await sendWith({ developer: true, content: '测试：发呆', handled: true });
  assert.deepEqual(r.log, ['runTestCommand']);
  assert.deepEqual(r.shown, [['cmd-1', '测试：发呆']]);
  assert.deepEqual(r.requests, []);
  assert.equal(r.input.value, '', 'the box is cleared');
  assert.equal(r.pending, null, 'the double-send guard is released');
});

test('the window: a text the host says is not a command goes on as an ordinary chat request with the literal text; developer mode off never asks', async () => {
  const notHandled = await sendWith({ developer: true, content: '测试：发呆', handled: false });
  assert.deepEqual(notHandled.log.slice(0, 2), ['runTestCommand', 'noteUserInput']);
  assert.equal(notHandled.requests.length, 1);
  assert.equal((notHandled.requests[0] as { messages: { content: string }[] }).messages.at(-1)!.content, '测试：发呆');
  assert.deepEqual(notHandled.shown, []);
  const off = await sendWith({ developer: false, content: '测试：发呆' });
  assert.equal(off.log.includes('runTestCommand'), false, 'developer mode off: the host is never asked');
  assert.equal(off.requests.length, 1);
  assert.equal((off.requests[0] as { messages: { content: string }[] }).messages.at(-1)!.content, '测试：发呆');
  const ordinary = await sendWith({ developer: true, content: '你好呀' });
  assert.equal(ordinary.log.includes('runTestCommand'), false);
  assert.equal(ordinary.requests.length, 1);
  const withPicture = await sendWith({ developer: true, content: '测试：发呆', attachments: [{ source: 'screen', dataUrl: 'data:image/png;base64,AA==' }] });
  assert.equal(withPicture.log.includes('runTestCommand'), false, 'a message with a picture is never a command');
});

test('the window: if asking the host fails, the user is told and nothing is sent as chat', async () => {
  const r = await sendWith({ developer: true, content: '测试：发呆', rejects: true });
  assert.equal(r.requests.length, 0);
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /ipc down/u);
  assert.equal(r.pending, null);
  assert.equal(r.input.value, '测试：发呆', 'the text stays so it can be sent again');
});

test('the process wiring: one IPC for the window\'s ask, the host decides; the windows get only note and effect events', async () => {
  const { readFile: read } = await import('node:fs/promises');
  const main = await read(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const preload = await read(new URL('../electron/preload.ts', import.meta.url), 'utf8');
  // A test command also answers her "要我凑近看看吗" (Codex T-112 round 030; electron/look-turns.ts userTurn).
  assert.match(main, /scopedHost\('runTestCommand', \(sender, text\) => \{ lookTurns\.userTurn\(\); return testCommands\.accept\(sender, text\); \}, false\)/u);
  assert.match(main, /webContents\.send\('desk:test-note', note\)/u);
  assert.match(main, /broadcast\('desk:test-effect', effect\)/u);
  assert.match(preload, /runTestCommand: text => invoke\('runTestCommand', text\)/u);
  assert.match(preload, /onTestNote: callback => subscribe\('desk:test-note', callback\)/u);
  assert.match(preload, /onTestEffect: callback => subscribe\('desk:test-effect', callback\)/u);
  // The chat handler is not touched: it does not know the test commands.
  const chat = main.slice(main.indexOf('scopedHost(\r\n    "chat"'), main.indexOf('"cancel"'));
  assert.ok(chat.length > 1000);
  assert.equal(/testCommands|test-command|TestCommand/u.test(chat), false);
});
