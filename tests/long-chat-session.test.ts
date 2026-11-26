// I-134 new chat in the conversation-scoped Claude process (electron/brain/claude-session.ts) with its knobs on and off: no 12-turn retire,
// the character budget reopens clean, her note in the opening message only, and step 4 (a refusal or an empty answer: keep what was
// shown, or answer again at once with the short window). The real persistent process and per-message process run a scripted fake;
// the CompanionService part checks that the turn is archived once with what the user saw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { CLAUDE_FOLLOW_UP_HEADER, OPENING_NOTE_HEADER, withOpeningNote } from '../electron/brain/claude-session-prompt';
import { PersistentClaudeChat, type CompanionClaudeTask, type PersistentClaudeOptions, type RefusalFallback } from '../electron/brain/claude-session';
import { LONG_CHAT_KNOBS, type LongChatKnobs } from '../shared/behaviors/long-chat/knobs';
import { CompanionService } from '../electron/brain/companion';
import { ChatAvailability } from '../electron/brain/chat-availability';
import { sanitizeChatIncident } from '../shared/brain/chat-incident';

// A stand-in for `claude -p --input-format stream-json` (both the long-lived and the one-shot use). The current user message picks:
//   #refuse-long        refuse unless this is the host's short-window retry (its prompt says SHORTWINDOW), which answers "短窗口回复。"
//   #refuse-after-text  stream "我想想" and then refuse
//   #refuse / #empty    refuse with no text / finish with no text
//   #hidden-draft       stream "（草稿）" and refuse (the host says nothing was visible), except on the short-window retry
//   anything else       "第<n>轮回复。" (n counts this process's turns)
const SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const dir = __dirname;
fs.appendFileSync(path.join(dir, 'spawns.log'), JSON.stringify({ pid: process.pid }) + '\n');
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
let turns = 0;
readline.createInterface({ input: process.stdin }).on('line', raw => {
  let message; try { message = JSON.parse(raw); } catch { return; }
  if (message.type !== 'user') return;
  const prompt = message.message.content.map(block => block.text || '').join('');
  fs.appendFileSync(path.join(dir, 'input.log'), JSON.stringify({ pid: process.pid, prompt }) + '\n');
  const data = /<conversation-data>\n([\s\S]*)\n<\/conversation-data>/.exec(prompt);
  const current = data ? JSON.parse(data[1]).currentUser : prompt;
  const id = 'msg_' + (++turns);
  const event = inner => send({ type: 'stream_event', event: inner });
  const delta = text => event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  const finish = (reason, text) => {
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: reason } });
    event({ type: 'message_stop' });
    send({ type: 'assistant', message: { id, role: 'assistant', stop_reason: reason, content: [{ type: 'text', text }] } });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: reason, result: text });
  };
  send({ type: 'system', subtype: 'init', model: 'fake', tools: [], mcp_servers: [] });
  event({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const refuse = current.includes('#refuse-long') ? !prompt.includes('SHORTWINDOW') : current.includes('#refuse');
  if (current.includes('#refuse-after-text')) { delta('我想想'); finish('refusal', '我想想'); return; }
  if (current.includes('#hidden-draft') && !prompt.includes('SHORTWINDOW')) { delta('（草稿）'); finish('refusal', '（草稿）'); return; }
  if (refuse) { finish('refusal', ''); return; }
  if (current.includes('#empty')) { finish('end_turn', ''); return; }
  const text = current.includes('#refuse-long') ? '短窗口回复。' : '第' + turns + '轮回复。';
  delta(text); finish('end_turn', text);
});
`;

async function fake() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-long-chat-session-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, SCRIPT);
  const lines = async (name: string) => { try { return (await readFile(path.join(root, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { root, script, spawns: () => lines('spawns.log') as Promise<{ pid: number }[]>, inputs: () => lines('input.log') as Promise<{ pid: number; prompt: string }[]>,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) };
}

const LONG_ON: LongChatKnobs = { ...LONG_CHAT_KNOBS, enabled: true };
const LONG_OFF: LongChatKnobs = { ...LONG_CHAT_KNOBS, enabled: false };
const persona = '你是测试角色小桃，说话温柔。';
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const historyOf = (prompt: string) => JSON.parse(prompt.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]) as { history: ChatMessage[]; currentUser: string };

function manager(script: string, extra: Partial<PersistentClaudeOptions> = {}) {
  return new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, ...extra });
}

let count = 0;
function task(messages: ChatMessage[], options: { note?: string; opening?: string; fallback?: RefusalFallback; short?: ChatMessage[] } = {}): CompanionClaudeTask {
  const composed = [persona, options.opening, '当前心情：平静。'].filter(Boolean).join('\n\n');
  return {
    kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false,
    get prompt() { return buildCodexChatPrompt(composed, messages); }, imageDataUrls: [], replyId: `r${++count}`,
    session: { key: 'conversation-1', basePersona: persona, persona: composed, messages, data: () => null,
      ...(options.opening ? { openingContext: options.opening } : {}), ...(options.note ? { openingNote: options.note } : {}) },
    ...(options.fallback ? { refusalFallback: options.fallback } : {}),
  };
}
const collect = () => { const deltas: string[] = []; return { deltas, emit: (type: string, text: string) => { if (type === 'delta') deltas.push(text); } }; };

test('knob off: the 12-turn cap (here 2) still retires the session exactly as before', async () => {
  const f = await fake();
  const chat = manager(f.script, { maxTurns: 2, longChat: LONG_OFF });
  try {
    const messages: ChatMessage[] = [];
    for (let index = 1; index <= 3; index++) {
      messages.push(u(`第${index}句`));
      const events = collect();
      await chat.stream(task([...messages]), new AbortController().signal, events.emit);
      messages.push(a(events.deltas.join('')));
    }
    assert.equal((await f.spawns()).length, 2);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('knob on: no turn cap for ordinary chat; the character budget retires the session and the next turn opens clean with the host window', async () => {
  const f = await fake();
  // maxTurns 2 is ignored with new chat on; the budget is 1 500 characters of what the process was told and wrote.
  const chat = manager(f.script, { maxTurns: 2, longChat: { ...LONG_ON, sessionMaxChars: 1_500 } });
  try {
    const messages: ChatMessage[] = [];
    const replies: string[] = [];
    for (let index = 1; index <= 6; index++) {
      messages.push(u(`第${index}句`));
      const events = collect();
      await chat.stream(task([...messages]), new AbortController().signal, events.emit);
      replies.push(events.deltas.join(''));
      messages.push(a(replies.at(-1)!));
    }
    const spawns = await f.spawns();
    const inputs = await f.inputs();
    const first = inputs.filter(row => row.pid === spawns[0].pid);
    assert.ok(first.length > 2, `the first process served more than 2 turns (${first.length})`);
    assert.ok(spawns.length >= 2, 'the budget retired it');
    const reopened = inputs.find(row => row.pid === spawns[1].pid)!;
    assert.ok(!reopened.prompt.startsWith(CLAUDE_FOLLOW_UP_HEADER) && reopened.prompt.startsWith(persona), 'a fresh opening message');
    const data = historyOf(reopened.prompt);
    assert.deepEqual(data.history, messages.slice(0, first.length * 2), 'every message so far, no chat lost');
    assert.ok(!reopened.prompt.includes('nonce'), 'no old per-turn context');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('knob on: a call still retires at callMaxTurns', async () => {
  const f = await fake();
  const chat = manager(f.script, { longChat: LONG_ON, callMaxTurns: 2 });
  try {
    chat.holdWarm(true);
    const messages: ChatMessage[] = [];
    for (let index = 1; index <= 3; index++) {
      messages.push(u(`第${index}句`));
      const events = collect();
      await chat.stream(task([...messages]), new AbortController().signal, events.emit);
      messages.push(a(events.deltas.join('')));
    }
    assert.equal((await f.spawns()).length, 2);
  } finally { chat.holdWarm(false); chat.dispose(); await f.cleanup(); }
});

test('her note: in the opening message after the persona and the relationship lines, never in a follow-up, and a new note does not restart the session', async () => {
  assert.equal(withOpeningNote('P\n\nR\n\nM', 'P', 'R', ' 他喜欢猫 '), `P\n\nR\n\n${OPENING_NOTE_HEADER}\n他喜欢猫\n\nM`);
  assert.equal(withOpeningNote('P\n\nM', 'P', null, '他喜欢猫'), `P\n\n${OPENING_NOTE_HEADER}\n他喜欢猫\n\nM`);
  assert.equal(withOpeningNote('其他写法', 'P', null, '他喜欢猫'), `其他写法\n\n${OPENING_NOTE_HEADER}\n他喜欢猫`);
  assert.equal(withOpeningNote('P\n\nM', 'P', null, '  '), 'P\n\nM');
  const f = await fake();
  const chat = manager(f.script, { longChat: LONG_ON });
  try {
    await chat.stream(task([u('你好')], { opening: '你们认识三天了。', note: '他喜欢猫。' }), new AbortController().signal, () => {});
    await chat.stream(task([u('你好'), a('第1轮回复。'), u('在吗')], { opening: '你们认识三天了。', note: '他其实更喜欢狗。' }), new AbortController().signal, () => {});
    const [opening, followUp] = (await f.inputs()).map(row => row.prompt);
    assert.ok(opening.startsWith(`${persona}\n\n你们认识三天了。\n\n${OPENING_NOTE_HEADER}\n他喜欢猫。\n\n当前心情：平静。`));
    assert.ok(followUp.startsWith(CLAUDE_FOLLOW_UP_HEADER) && !followUp.includes(OPENING_NOTE_HEADER) && !followUp.includes('喜欢'));
    assert.equal((await f.spawns()).length, 1);
  } finally { chat.dispose(); await f.cleanup(); }
});

/** The host's side of step 4, as electron/main.ts builds it. */
function fallbackFor(short: ChatMessage[], state: { visible: () => boolean; current?: () => boolean }, noted: string[]): RefusalFallback {
  return { prompt: () => buildCodexChatPrompt(`${persona}\n\nSHORTWINDOW`, short), visible: state.visible, current: state.current ?? (() => true), noted: kind => noted.push(kind) };
}

for (const mode of ['persistent', 'per-message'] as const) {
  test(`${mode}: a refusal with nothing shown is answered again at once with the short window; no failure, and the warm session stays`, async () => {
    const f = await fake();
    const failures: unknown[] = [], quiet: unknown[] = [];
    const chat = manager(f.script, { enabled: mode === 'persistent', longChat: LONG_ON,
      availability: { success: () => {}, failure: error => failures.push(error), quietFailure: error => { quiet.push(error); return error; } } });
    try {
      const long = [u('LONGWINDOW 很早以前的话'), a('嗯'), u('第一句')];
      await chat.stream(task(long), new AbortController().signal, () => {});
      const noted: string[] = [];
      const events = collect();
      const window = [...long, a('第1轮回复。'), u('那件事 #refuse-long')];
      const outcome = await chat.stream(task(window, { fallback: fallbackFor([u('那件事 #refuse-long')], { visible: () => events.deltas.join('').length > 0 }, noted) }),
        new AbortController().signal, events.emit);
      assert.equal(outcome.output, '短窗口回复。');
      assert.deepEqual(events.deltas, ['短窗口回复。']);
      assert.deepEqual(noted, ['refusal-fallback']);
      assert.deepEqual([failures.length, quiet.length], [0, 0]);
      const inputs = await f.inputs();
      const retry = inputs.at(-1)!;
      assert.ok(!retry.prompt.includes('LONGWINDOW'), 'the retry carries the short window only');
      assert.deepEqual(historyOf(retry.prompt).history, []);
      // The next turn: the same warm process (persistent), and the reply that replaced the refusal is sent as new history.
      await chat.stream(task([...window, a('短窗口回复。'), u('谢谢')]), new AbortController().signal, () => {});
      if (mode === 'persistent') {
        const spawns = await f.spawns();
        const last = (await f.inputs()).at(-1)!;
        assert.equal(last.pid, spawns[0].pid, 'the refusal did not close the warm session');
        assert.deepEqual(historyOf(last.prompt).history, [a('短窗口回复。')]);
      }
    } finally { chat.dispose(); await f.cleanup(); }
  });

  test(`${mode}: a refusal after text was shown keeps that text; the turn completes, nothing is asked again`, async () => {
    const f = await fake();
    const quiet: unknown[] = [];
    const chat = manager(f.script, { enabled: mode === 'persistent', longChat: LONG_ON,
      availability: { success: () => {}, failure: () => {}, quietFailure: error => { quiet.push(error); return error; } } });
    try {
      const noted: string[] = [];
      const events = collect();
      const outcome = await chat.stream(task([u('说说看 #refuse-after-text')], { fallback: fallbackFor([u('说说看 #refuse-after-text')], { visible: () => events.deltas.join('').length > 0 }, noted) }),
        new AbortController().signal, events.emit);
      assert.deepEqual([outcome.output, events.deltas.join('')], ['我想想', '我想想']);
      assert.deepEqual(noted, ['refusal-kept']);
      assert.equal(quiet.length, 0);
      assert.equal((await f.inputs()).length, 1, 'no second request');
    } finally { chat.dispose(); await f.cleanup(); }
  });

  test(`${mode}: a stale turn (stopped or another conversation meanwhile) gets no retry; the refusal fails quietly as before`, async () => {
    const f = await fake();
    const quiet: unknown[] = [];
    const chat = manager(f.script, { enabled: mode === 'persistent', longChat: LONG_ON,
      availability: { success: () => {}, failure: () => {}, quietFailure: error => { quiet.push(error); return error; } } });
    try {
      const noted: string[] = [];
      await assert.rejects(chat.stream(task([u('#refuse')], { fallback: fallbackFor([u('#refuse')], { visible: () => false, current: () => false }, noted) }),
        new AbortController().signal, () => {}), (error: any) => error.incident === 'refusal');
      assert.deepEqual(noted, []);
      assert.equal(quiet.length, 1);
      assert.equal((await f.inputs()).length, 1);
    } finally { chat.dispose(); await f.cleanup(); }
  });
}

test('a refusal after text the window held back (a draft): answered again, and the refused draft leaves the warm session\'s record', async () => {
  const f = await fake();
  const chat = manager(f.script, { longChat: LONG_ON, availability: { success: () => {}, failure: () => {}, quietFailure: error => error } });
  try {
    await chat.stream(task([u('你好')]), new AbortController().signal, () => {});
    const noted: string[] = [];
    const window = [u('你好'), a('第1轮回复。'), u('那个 #hidden-draft')];
    // The host showed nothing of '（草稿）' (its reply protocol held it back), so it says nothing is visible.
    const outcome = await chat.stream(task(window, { fallback: fallbackFor([u('那个 #hidden-draft')], { visible: () => false }, noted) }), new AbortController().signal, () => {});
    assert.equal(outcome.output, '第1轮回复。'); // the one-shot retry process's first turn
    assert.deepEqual(noted, ['refusal-fallback']);
    await chat.stream(task([...window, a(outcome.output), u('嗯')]), new AbortController().signal, () => {});
    const spawns = await f.spawns(), last = (await f.inputs()).at(-1)!;
    assert.equal(last.pid, spawns[0].pid, 'still the warm session');
    assert.deepEqual(historyOf(last.prompt).history, [a(outcome.output)], 'the reply she gave instead is sent as new; the draft is not taken for it');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('both answers refused: her quiet line as before (one retry only)', async () => {
  const f = await fake();
  const quiet: unknown[] = [];
  const chat = manager(f.script, { longChat: LONG_ON, availability: { success: () => {}, failure: () => {}, quietFailure: error => { quiet.push(error); return error; } } });
  try {
    await assert.rejects(chat.stream(task([u('#refuse')], { fallback: fallbackFor([u('#refuse')], { visible: () => false }, []) }), new AbortController().signal, () => {}));
    assert.equal(quiet.length, 1);
    assert.equal((await f.inputs()).length, 2);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('knob off: a refusal never retries (even with a fallback on the task) and closes the warm session, as today', async () => {
  const f = await fake();
  const chat = manager(f.script, { longChat: LONG_OFF, availability: { success: () => {}, failure: () => {}, quietFailure: error => error } });
  try {
    await chat.stream(task([u('你好')]), new AbortController().signal, () => {});
    const noted: string[] = [];
    await assert.rejects(chat.stream(task([u('你好'), a('第1轮回复。'), u('#refuse')], { fallback: fallbackFor([u('#refuse')], { visible: () => false }, noted) }), new AbortController().signal, () => {}));
    assert.deepEqual(noted, []);
    await chat.stream(task([u('你好'), a('第1轮回复。'), u('还在吗')]), new AbortController().signal, () => {});
    assert.equal((await f.spawns()).length, 2, 'the refusal closed the session');
    assert.equal((await f.inputs()).length, 3);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('the incident log accepts the two recoveries as categories', () => {
  assert.deepEqual(sanitizeChatIncident({ category: 'refusal-fallback', text: 'x' }), { category: 'refusal-fallback' });
  assert.deepEqual(sanitizeChatIncident({ category: 'refusal-kept' }), { category: 'refusal-kept' });
});

test('archive once: with the fallback, the turn is archived once as the reply the user saw; a kept partial reply is archived as shown', async () => {
  const f = await fake();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-long-chat-archive-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  await service.context('gene', { kind: 'claude', baseUrl: 'https://long-chat.invalid/v1', model: 'fixture' }, '角色名称：Gene');
  const availability = new ChatAvailability({ line: () => '唔，我刚刚走神了。', cardKey: () => 'gene' });
  const chat = manager(f.script, { longChat: LONG_ON, availability });
  try {
    for (const [index, text, expected] of [[1, '那件事 #refuse-long', '短窗口回复。'], [2, '说说看 #refuse-after-text', '我想想']] as const) {
      let shown = '';
      const id = `turn-${index}`;
      const turn = await service.begin(id, text, '角色名称：Gene', (type, value) => { if (type === 'delta') shown += value; });
      const fallback: RefusalFallback = { prompt: () => buildCodexChatPrompt(turn.persona + '\n\nSHORTWINDOW', [u(text)]), visible: () => shown.trim().length > 0, current: () => true };
      const long = [u('LONGWINDOW 很早以前的话'), a('嗯'), u(text)];
      await chat.stream({ kind: 'chat', model: '', workingDirectory: directory, writable: false, get prompt() { return buildCodexChatPrompt(turn.persona, long); }, replyId: id,
        session: { key: `conversation-${index}`, basePersona: '角色名称：Gene', persona: turn.persona, messages: long, data: () => null, shown: () => turn.shownReply?.() ?? null },
        refusalFallback: fallback }, new AbortController().signal, turn.push);
      await turn.finish('complete');
      await turn.finish('complete'); // a second finish changes nothing
      assert.equal(shown, expected);
      const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
      const mine = record.messages.filter(message => message.turnId === id);
      assert.deepEqual(mine.map(message => [message.role, message.content, message.status]), [['user', text, 'complete'], ['assistant', expected, 'complete']]);
    }
    assert.equal(availability.view().state, 'ok');
  } finally { chat.dispose(); await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); await f.cleanup(); }
});
