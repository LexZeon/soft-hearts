import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/contracts';
import { buildCodexChatPrompt, buildCompanionPersona } from '../electron/conversation-context';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CLAUDE_FOLLOW_UP_HEADER, CLAUDE_SESSION_SYSTEM_PROMPT, sessionText } from '../electron/claude-session-prompt';
import { PersistentClaudeChat, persistentClaudeEnabled, type ClaudeTimingInfo, type CompanionClaudeTask, type PersistentClaudeOptions } from '../electron/claude-session';
import { ClaudeChatProcess } from '../electron/claude-process';
import { CLAUDE_CHAT_SYSTEM_PROMPT } from '../electron/claude';

/**
 * A fake `claude` that speaks Claude Code's multi-turn stream-json protocol:
 * one init per user message, partial deltas, an `assistant` message and a
 * `result`; the stream-json interrupt control request ends the running turn the
 * way Claude Code 2.1.316 does (control_response, partial assistant message,
 * "[Request interrupted by user]", result error_during_execution).
 * behavior.json: { processes: [ { crashOnTurn, toolsOnTurn, mcpOnTurn, initOnce, ignoreInterrupt, toolOnInterrupt } ] }
 * indexed by spawn order. It runs as `node fake-claude.cjs <claude args>` (binaryArgs), so the
 * same fake runs on Windows, where a shebang script cannot be spawned.
 * A current user message containing "#slow" streams
 * until interrupted; "#partial-crash" sends one delta and exits.
 */
const fakeSource = `
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname;
const spawnIndex = fs.existsSync(path.join(dir, "spawns.log")) ? fs.readFileSync(path.join(dir, "spawns.log"), "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(path.join(dir, "spawns.log"), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(),
  cwdEntries: fs.readdirSync(process.cwd()), env: Object.keys(process.env).filter(k => /^CLAUDE/i.test(k)) }) + "\\n");
const behavior = () => (JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8")).processes || [])[spawnIndex] || {};
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
let turn = 0, current = null, buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on("end", () => { if (!current) process.exitCode = 0; });
function finish(text) {
  out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
}
function handle(message) {
  fs.appendFileSync(path.join(dir, "input.log"), JSON.stringify({ pid: process.pid, message }) + "\\n");
  const b = behavior();
  if (message.type === "control_request") {
    if (b.ignoreInterrupt) return;
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } } });
    if (current) {
      clearInterval(current.timer);
      if (b.toolOnInterrupt) {
        out({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } } });
        out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
      }
      out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "text", text: current.text }] } });
      out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      out({ type: "result", subtype: "error_during_execution", is_error: true });
      current = null;
    }
    return;
  }
  if (message.type !== "user") return;
  turn++;
  const prompt = message.message.content.map(block => block.text || "").join("");
  // Markers apply to the current user message only, never to quoted history.
  const data = /<conversation-data>\\n([\\s\\S]*)\\n<\\/conversation-data>/.exec(prompt);
  const text = data ? JSON.parse(data[1]).currentUser : prompt;
  if ((b.crashOnTurn || []).includes(turn)) process.exit(3);
  if (!b.initOnce || turn === 1)
    out({ type: "system", subtype: "init", tools: (b.toolsOnTurn || []).includes(turn) ? ["Bash"] : [], mcp_servers: (b.mcpOnTurn || []).includes(turn) ? [{ name: "x", status: "connected" }] : [] });
  const delta = value => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } } });
  if (text.includes("#partial-crash")) { delta("半句"); setTimeout(() => process.exit(4), 20); return; }
  if (text.includes("#slow")) {
    current = { text: "第一句", timer: null };
    delta("第一句");
    current.timer = setInterval(() => { current.text += "还在"; delta("还在"); }, 15);
    return;
  }
  const reply = "第" + turn + "轮回复。";
  delta("第" + turn); delta("轮回复。");
  finish(reply);
}
`;

const green = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQ0lEQVR4AcXBAQEAAAiDMKR/5xuD7RgjJDGJSUxiEpOYxCQmMYlJTGISk5jEJCYxiUlMYhKTmMQkJjGJSUxiEpOYxB4v5AI+g+yDOgAAAABJRU5ErkJggg==';
const image = `data:image/png;base64,${green}`;

interface Spawn { pid: number; args: string[]; cwd: string; cwdEntries: string[]; env: string[] }
interface Input { pid: number; message: any }

async function fake(processes: Record<string, unknown>[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-claude-session-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, fakeSource);
  await writeFile(path.join(root, 'behavior.json'), JSON.stringify({ processes }));
  const lines = async (name: string) => {
    try { return (await readFile(path.join(root, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  return {
    root, script,
    spawns: () => lines('spawns.log') as Promise<Spawn[]>,
    inputs: () => lines('input.log') as Promise<Input[]>,
    async userTexts(pid?: number) {
      return (await this.inputs()).filter(row => row.message.type === 'user' && (pid === undefined || row.pid === pid))
        .map(row => row.message.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''));
    },
    // Windows may still hold a just-killed fake's handle on its logs for a moment.
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
  };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * Waits for a real condition (a process gone, a spawn seen). 15 s: under a full parallel suite Windows taskkill and
 * process start can take several seconds (3 s timed out there); the condition itself is unchanged.
 */
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function collect() {
  const deltas: string[] = [];
  return { deltas, emit: (type: string, text: string) => { if (type === 'delta') deltas.push(text); } };
}

const persona = '你是测试角色小桃，说话温柔。';
let nonce = 0;
/** One ordinary chat turn as the main-process handler hands it over. */
function turn(messages: ChatMessage[], options: { key?: string; basePersona?: string; images?: string[]; id?: string } = {}): CompanionClaudeTask {
  const base = options.basePersona ?? persona;
  const composed = `${base}\n\n当前心情：平静。\n\n尾注标记 nonce-${++nonce}`;
  return {
    kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false,
    get prompt() { return buildCodexChatPrompt(composed, messages); },
    imageDataUrls: options.images ?? [],
    replyId: options.id ?? `r${nonce}`,
    session: { key: options.key ?? 'conversation-1', basePersona: base, persona: composed, messages, data: () => null },
  };
}

function manager(script: string, extra: Partial<PersistentClaudeOptions> = {}) {
  const timing: Array<[string, string, ClaudeTimingInfo?]> = [];
  const chat = new PersistentClaudeChat({
    enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }), chattedBefore: () => true,
    interruptGraceMs: 300, log: () => {},
    timing: { dispatched: (id, info) => timing.push(['dispatch', id, info]), firstDelta: id => timing.push(['first', id]) },
    ...extra,
  });
  return { chat, timing };
}

const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

test('persistent switch: on by default, SOFT_HEARTS_CLAUDE_PERSISTENT=0 goes back to one process per message', () => {
  assert.equal(persistentClaudeEnabled({}), true);
  assert.equal(persistentClaudeEnabled({ SOFT_HEARTS_CLAUDE_PERSISTENT: '0' }), false);
});

test('one isolated process serves several turns; follow-ups carry only this turn and no old persona or history', async () => {
  const f = await fake();
  const { chat, timing } = manager(f.script);
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'parent-session';
  try {
    const first = collect();
    await chat.stream(turn([u('你好')], { id: 'one' }), new AbortController().signal, first.emit);
    assert.deepEqual(first.deltas, ['第1', '轮回复。']);
    const second = collect();
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('今天有点累')], { id: 'two' }), new AbortController().signal, second.emit);
    assert.deepEqual(second.deltas, ['第2', '轮回复。'], 'the same process answered its second turn');
    const spawns = await f.spawns();
    assert.equal(spawns.length, 1);
    const args = spawns[0].args, value = (flag: string) => args[args.indexOf(flag) + 1];
    for (const flag of ['--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence'])
      assert.ok(args.includes(flag), flag);
    assert.equal(value('--tools'), '');
    assert.equal(value('--setting-sources'), '');
    assert.equal(value('--input-format'), 'stream-json');
    assert.equal(value('--model'), 'haiku');
    assert.equal(value('--system-prompt'), CLAUDE_SESSION_SYSTEM_PROMPT);
    assert.ok(!args.some(arg => arg.includes(persona)), 'no persona on the command line');
    assert.deepEqual(spawns[0].cwdEntries, []);
    assert.ok(!spawns[0].env.includes('CLAUDE_CODE_SESSION_ID'));
    const [opening, followUp] = await f.userTexts();
    assert.ok(opening.startsWith(persona), 'the opening message is today\'s full prompt');
    assert.ok(!followUp.includes(persona), 'the fixed persona is not repeated');
    assert.ok(followUp.startsWith(CLAUDE_FOLLOW_UP_HEADER));
    assert.ok(followUp.includes('当前心情：平静。') && followUp.includes('尾注标记'), 'this turn\'s context is sent');
    const data = JSON.parse(followUp.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]);
    assert.deepEqual(data, { history: [], currentUser: '今天有点累' }, 'Claude already has the earlier turn');
    assert.deepEqual(timing.filter(row => row[0] === 'dispatch').map(row => [row[1], row[2]!.process, row[2]!.sessionTurn]),
      [['one', 'cold', 1], ['two', 'warm', 2]]);
    assert.deepEqual(timing.filter(row => row[0] === 'first').map(row => row[1]), ['one', 'two']);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = previous;
    chat.dispose(); await f.cleanup();
  }
});

test('messages the session has not seen (an ambient comment, a command receipt) are sent as history once', async () => {
  const f = await fake();
  const { chat } = manager(f.script);
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    await chat.stream(turn([u('你好'), a('第1轮回复。'), a('[角色主动评论] 这首歌真好听'), u('是吧')]), new AbortController().signal, () => {});
    const followUp = (await f.userTexts())[1];
    const data = JSON.parse(followUp.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]);
    assert.deepEqual(data.history, [a('[角色主动评论] 这首歌真好听')]);
    assert.equal((await f.spawns()).length, 1);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('a persona change, a new conversation or a diverged history opens a new session with the full window', async () => {
  const f = await fake();
  const { chat } = manager(f.script);
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const first = (await f.spawns())[0].pid;
    const changed = collect();
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('换个人设了')], { basePersona: '你是另一个角色阿杏。' }), new AbortController().signal, changed.emit);
    assert.deepEqual(changed.deltas, ['第1', '轮回复。'], 'a fresh process answered');
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    await until(() => !alive(first));
    const opening = (await f.userTexts(spawns[1].pid))[0];
    assert.ok(opening.startsWith('你是另一个角色阿杏。'));
    assert.deepEqual(JSON.parse(opening.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]).history, [u('你好'), a('第1轮回复。')]);
    await chat.stream(turn([u('新对话')], { key: 'conversation-2', basePersona: '你是另一个角色阿杏。' }), new AbortController().signal, () => {});
    assert.equal((await f.spawns()).length, 3, 'new conversation key');
    // The renderer cleared its history: Claude must not keep knowing more.
    await chat.stream(turn([u('从头来')], { key: 'conversation-2', basePersona: '你是另一个角色阿杏。' }), new AbortController().signal, () => {});
    assert.equal((await f.spawns()).length, 4, 'diverged history');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('tools or MCP servers in an init stop the turn before any text, on the first and on a later turn', async () => {
  const cases: { toolsOnTurn?: number[]; mcpOnTurn?: number[] }[][] = [[{ toolsOnTurn: [1] }], [{ mcpOnTurn: [1] }], [{ toolsOnTurn: [2] }]];
  for (const processes of cases) {
    const f = await fake(processes);
    const { chat } = manager(f.script);
    try {
      const later = processes[0].toolsOnTurn?.[0] === 2;
      if (later) await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
      const events = collect();
      await assert.rejects(chat.stream(turn(later ? [u('你好'), a('第1轮回复。'), u('再说')] : [u('你好')]), new AbortController().signal, events.emit), /关闭全部工具/);
      assert.deepEqual(events.deltas, []);
      const spawns = await f.spawns();
      assert.equal(spawns.length, 1, 'a safety stop is never retried');
      await until(() => !alive(spawns[0].pid));
    } finally { chat.dispose(); await f.cleanup(); }
  }
});

test('a crash before any text restarts transparently, and the new process\'s init is checked again', async () => {
  const f = await fake([{ crashOnTurn: [2] }, {}]);
  const { chat, timing } = manager(f.script);
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const events = collect();
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('还在吗')], { id: 'retry' }), new AbortController().signal, events.emit);
    assert.deepEqual(events.deltas, ['第1', '轮回复。'], 'shown once, from the restarted process');
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    const opening = (await f.userTexts(spawns[1].pid))[0];
    assert.ok(opening.startsWith(persona), 'the restarted session gets the persona again');
    assert.deepEqual(JSON.parse(opening.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]).history, [u('你好'), a('第1轮回复。')]);
    assert.deepEqual(timing.filter(row => row[0] === 'dispatch' && row[1] === 'retry').map(row => row[2]!.process), ['warm', 'cold']);
  } finally { chat.dispose(); await f.cleanup(); }
  const unsafe = await fake([{ crashOnTurn: [2] }, { toolsOnTurn: [1] }]);
  const second = manager(unsafe.script).chat;
  try {
    await second.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const events = collect();
    await assert.rejects(second.stream(turn([u('你好'), a('第1轮回复。'), u('还在吗')]), new AbortController().signal, events.emit), /关闭全部工具/);
    assert.deepEqual(events.deltas, []);
  } finally { second.dispose(); await unsafe.cleanup(); }
});

test('a crash after text was shown fails the turn instead of answering twice', async () => {
  const f = await fake();
  const { chat } = manager(f.script);
  try {
    const events = collect();
    await assert.rejects(chat.stream(turn([u('#partial-crash')]), new AbortController().signal, events.emit), /意外退出|Claude/);
    assert.deepEqual(events.deltas, ['半句']);
    assert.equal((await f.spawns()).length, 1);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('stopping mid-turn interrupts through stream-json, drops late deltas and keeps the process warm', async () => {
  const f = await fake();
  const { chat, timing } = manager(f.script);
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const controller = new AbortController();
    const stopped = collect();
    const started = Date.now();
    await assert.rejects(chat.stream(turn([u('你好'), a('第1轮回复。'), u('#slow 讲个长故事')]), controller.signal, (type, text) => {
      stopped.emit(type, text);
      if (text === '第一句') controller.abort();
    }));
    assert.ok(Date.now() - started < 1000, 'the host task ends promptly');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(stopped.deltas, ['第一句'], 'nothing after the stop reaches the old turn');
    const interrupts = (await f.inputs()).filter(row => row.message.type === 'control_request');
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].message.request.subtype, 'interrupt');
    // The renderer kept the partial reply in its history, so the next turn lines up.
    const next = collect();
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('#slow 讲个长故事'), a('第一句'), u('算了，简单说')], { id: 'after' }), new AbortController().signal, next.emit);
    assert.deepEqual(next.deltas, ['第3', '轮回复。'], 'same process, and no late text from the stopped turn');
    assert.equal((await f.spawns()).length, 1);
    const last = (await f.userTexts()).at(-1)!;
    assert.deepEqual(JSON.parse(last.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]), { history: [], currentUser: '算了，简单说' });
    assert.equal(timing.find(row => row[0] === 'dispatch' && row[1] === 'after')![2]!.process, 'warm');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('an interrupt that is never answered kills the process; the next turn starts fresh and sees no late text', async () => {
  const f = await fake([{ ignoreInterrupt: true }, {}]);
  const { chat } = manager(f.script);
  try {
    const controller = new AbortController();
    await assert.rejects(chat.stream(turn([u('#slow 讲故事')]), controller.signal, (_type, text) => { if (text === '第一句') controller.abort(); }));
    const first = (await f.spawns())[0].pid;
    const next = collect();
    await chat.stream(turn([u('#slow 讲故事'), a('第一句'), u('换个话题')]), new AbortController().signal, next.emit);
    assert.deepEqual(next.deltas, ['第1', '轮回复。']);
    assert.equal((await f.spawns()).length, 2);
    await until(() => !alive(first));
  } finally { chat.dispose(); await f.cleanup(); }
});

test('X-087: a tool request that arrives while an interrupted turn drains still ends the process; it is not reused', async () => {
  const f = await fake([{ toolOnInterrupt: true }, {}]);
  const { chat } = manager(f.script);
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const controller = new AbortController();
    const stopped = collect();
    await assert.rejects(chat.stream(turn([u('你好'), a('第1轮回复。'), u('#slow 讲故事')]), controller.signal, (type, text) => {
      stopped.emit(type, text); if (text === '第一句') controller.abort();
    }));
    const first = (await f.spawns())[0].pid;
    await until(() => !alive(first));
    assert.deepEqual(stopped.deltas, ['第一句'], 'nothing from the drained turn is shown');
    const next = collect();
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('#slow 讲故事'), a('第一句'), u('换个话题')]), new AbortController().signal, next.emit);
    assert.deepEqual(next.deltas, ['第1', '轮回复。'], 'a fresh process answered');
    assert.equal((await f.spawns()).length, 2);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('X-087: a context change while the process is still starting ends that turn; nothing is sent under the old context', async () => {
  const f = await fake();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { chat } = manager(f.script, { startProcess: async options => { await gate; return ClaudeChatProcess.start(options); } });
  try {
    const events = collect();
    const running = chat.stream(turn([u('你好')]), new AbortController().signal, events.emit);
    await new Promise(resolve => setTimeout(resolve, 20));
    chat.close('context'); // e.g. the user switched character while Claude Code was starting
    release();
    await assert.rejects(running, /已改变/);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(events.deltas, []);
    assert.deepEqual(await f.userTexts(), [], 'the old turn never reached Claude');
    // The next message, in the new context, is answered normally.
    const next = collect();
    await chat.stream(turn([u('新角色你好')], { basePersona: '你是另一个角色阿杏。' }), new AbortController().signal, next.emit);
    assert.deepEqual(next.deltas, ['第1', '轮回复。']);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('a stop before any text, which the renderer drops from history, opens a new session', async () => {
  const f = await fake();
  const { chat } = manager(f.script);
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(chat.stream(turn([u('你好'), a('第1轮回复。'), u('等等')]), controller.signal, () => {}));
    const slow = new AbortController();
    await assert.rejects(chat.stream(turn([u('你好'), a('第1轮回复。'), u('#slow 不对')]), slow.signal, (_type, text) => { if (text === '第一句') slow.abort(); }));
    // Same process so far. Now the renderer's history has no trace of a stopped
    // message that never showed text (simulated by dropping the partial reply).
    assert.equal((await f.spawns()).length, 1);
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('重新问')]), new AbortController().signal, () => {});
    assert.equal((await f.spawns()).length, 2, 'Claude would otherwise remember a message the app does not show');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('an image turn sends the image and then retires the session; a pre-spawned process takes the next turn', async () => {
  const f = await fake();
  const { chat, timing } = manager(f.script);
  try {
    await chat.stream(turn([u('看看这张图')], { images: [image] }), new AbortController().signal, () => {});
    const inputs = await f.inputs();
    const content = inputs[0].message.message.content;
    assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: green } });
    await until(async () => (await f.spawns()).length === 2);
    await chat.stream(turn([u('看看这张图'), a('第1轮回复。'), u('图里是什么颜色')], { id: 'next' }), new AbortController().signal, () => {});
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    const second = (await f.inputs()).filter(row => row.pid === spawns[1].pid && row.message.type === 'user');
    assert.equal(second.length, 1);
    assert.ok(second[0].message.message.content.every((block: any) => block.type === 'text'), 'the old frame is not carried into later turns');
    assert.equal(timing.find(row => row[0] === 'dispatch' && row[1] === 'next')![2]!.process, 'prewarmed');
    await assert.rejects(chat.stream(turn([u('x')], { images: ['data:image/png;base64,AAAA'] }), new AbortController().signal, () => {}), /图片数据不正确/);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('关掉之后的旧帧: the frames and the turn persona are read where the message is written, so a frame dropped while the process starts never goes', async () => {
  const f = await fake();
  const { chat } = manager(f.script);
  try {
    // electron/main.ts hands these over as getters over the turn's frames (electron/look-attachments.ts TurnFrames).
    let sharing = true;
    const task = turn([u('你看看我屏幕')], { images: [image] });
    Object.defineProperty(task, 'imageDataUrls', { get: () => (sharing ? [image] : []) });
    Object.defineProperty(task.session!, 'persona', { get: () => `${persona}\n\n【此刻的感知】${sharing ? '用户叫你看屏幕，本轮附了画面。' : '用户叫你看屏幕，但屏幕共享没开。'}` });
    const done = chat.stream(task, new AbortController().signal, () => {});
    sharing = false; // the user turns screen sharing off while the process is still starting
    await done;
    const content = (await f.inputs()).find(row => row.message.type === 'user')!.message.message.content;
    assert.ok(content.every((block: any) => block.type === 'text'), 'no image block left the computer');
    const text = content.map((block: any) => block.text).join('');
    assert.match(text, /屏幕共享没开/);
    assert.doesNotMatch(text, /本轮附了画面/);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('idle and hidden timeouts close the process; pre-warming only happens for someone who has chatted', async () => {
  const f = await fake();
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const fakeTimers = { set: (callback: () => void, ms: number) => { timers.set(++next, { callback, ms }); return next; }, clear: (handle: unknown) => { timers.delete(handle as number); } };
  // Idle timers only (turn timeouts are 120 s and cleared when a turn settles).
  const idle = () => [...timers.entries()].filter(([, timer]) => timer.ms > 60_000 || timer.ms === 0)
    .map(([id, timer]) => ({ ms: timer.ms, fire: () => { timers.delete(id); timer.callback(); } }));
  let chattedBefore = false;
  const { chat } = manager(f.script, { timers: fakeTimers, chattedBefore: () => chattedBefore, idleMs: 600_000, hiddenIdleMs: 180_000 });
  try {
    chat.noteVisible(true);
    chat.prewarm();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await f.spawns()).length, 0, 'never spawned for someone who has not chatted');
    chattedBefore = true;
    chat.noteVisible(true);
    await until(async () => (await f.spawns()).length === 1);
    const spare = (await f.spawns())[0].pid;
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    assert.equal((await f.spawns()).length, 1, 'the spare served the turn');
    chat.noteVisible(false);
    const pending = idle();
    assert.equal(pending.length, 1);
    assert.ok(pending[0].ms <= 180_000, 'hidden: the shorter limit applies');
    pending[0].fire();
    await until(() => !alive(spare));
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('回来了')]), new AbortController().signal, () => {});
    assert.equal((await f.spawns()).length, 2);
    const after = (await f.spawns())[1].pid;
    chat.noteVisible(true);
    const visible = idle();
    assert.equal(visible.length, 1);
    assert.ok(visible[0].ms > 180_000 && visible[0].ms <= 600_000);
    visible[0].fire();
    await until(() => !alive(after));
  } finally { chat.dispose(); await f.cleanup(); }
});

test('a context change closes the session (even mid-turn, without retry) and keeps a blank spare for the next message', async () => {
  const f = await fake();
  let provider = { kind: 'claude', model: 'haiku' };
  const { chat } = manager(f.script, { provider: () => provider });
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const first = (await f.spawns())[0].pid;
    const running = chat.stream(turn([u('你好'), a('第1轮回复。'), u('#slow 讲故事')]), new AbortController().signal, () => {});
    await until(async () => (await f.userTexts()).length === 2);
    chat.close('context');
    await assert.rejects(running, /已改变/);
    await until(() => !alive(first));
    await until(async () => (await f.spawns()).length === 2);
    assert.equal((await f.userTexts()).length, 2, 'the interrupted turn was not replayed');
    provider = { kind: 'openai', model: 'x' };
    const spare = (await f.spawns())[1].pid;
    chat.close('context');
    await until(() => !alive(spare));
  } finally { chat.dispose(); await f.cleanup(); }
});

test('a long session is retired after its budget so each turn stays near today\'s window size', async () => {
  const f = await fake();
  const { chat } = manager(f.script, { maxTurns: 2 });
  try {
    const messages: ChatMessage[] = [];
    for (let index = 1; index <= 3; index++) {
      messages.push(u(`第${index}句`));
      const events = collect();
      await chat.stream(turn([...messages]), new AbortController().signal, events.emit);
      messages.push(a(events.deltas.join('')));
    }
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    const opening = (await f.userTexts(spawns[1].pid))[0];
    assert.ok(opening.startsWith(persona));
    assert.equal(JSON.parse(opening.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]).history.length, 4);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('evaluation seam: an explicit system prompt replaces the fixed one for the persistent process; the app never sets it', async () => {
  const f = await fake();
  const { chat } = manager(f.script, { systemPrompt: '对照用的系统提示词' });
  try {
    await chat.stream(turn([u('你好')], { id: 'seam' }), new AbortController().signal, collect().emit);
    const [spawned] = await f.spawns();
    assert.equal(spawned.args[spawned.args.indexOf('--system-prompt') + 1], '对照用的系统提示词');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('fallback: with the persistent process off, every message is its own one-shot process exactly as before', async () => {
  const f = await fake();
  const { chat, timing } = manager(f.script, { enabled: false });
  try {
    const one = collect(), two = collect();
    await chat.stream(turn([u('你好')], { id: 'p1' }), new AbortController().signal, one.emit);
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('再说')], { id: 'p2' }), new AbortController().signal, two.emit);
    assert.deepEqual(one.deltas, ['第1', '轮回复。']);
    assert.deepEqual(two.deltas, ['第1', '轮回复。']);
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    assert.notEqual(spawns[0].args[spawns[0].args.indexOf('--system-prompt') + 1], CLAUDE_SESSION_SYSTEM_PROMPT, 'the old per-message system prompt');
    assert.equal(spawns[0].args[spawns[0].args.indexOf('--system-prompt') + 1], CLAUDE_CHAT_SYSTEM_PROMPT, 'the per-message system prompt plus the companion rules');
    assert.equal(spawns[1].args[spawns[1].args.indexOf('--system-prompt') + 1], CLAUDE_CHAT_SYSTEM_PROMPT);
    const texts = await f.userTexts();
    assert.ok(texts[1].startsWith(persona), 'the old path sends persona and full history every time');
    assert.deepEqual(JSON.parse(texts[1].split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]).history, [u('你好'), a('第1轮回复。')]);
    assert.deepEqual(timing.filter(row => row[0] === 'dispatch').map(row => row[2]!.mode), ['per-message', 'per-message']);
    assert.deepEqual(timing.filter(row => row[0] === 'first').map(row => row[1]), ['p1', 'p2']);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('two process failures in a row switch the rest of the run back to one process per message', async () => {
  const f = await fake([{ crashOnTurn: [1] }, { crashOnTurn: [1] }, { crashOnTurn: [1] }, { crashOnTurn: [1] }]);
  const { chat, timing } = manager(f.script);
  try {
    await assert.rejects(chat.stream(turn([u('一')]), new AbortController().signal, () => {}));
    assert.equal(chat.active, true);
    await assert.rejects(chat.stream(turn([u('二')]), new AbortController().signal, () => {}));
    assert.equal(chat.active, false);
    assert.equal((await f.spawns()).length, 4, 'each failing turn was retried once');
    const events = collect();
    await chat.stream(turn([u('三')], { id: 'fallback' }), new AbortController().signal, events.emit);
    assert.deepEqual(events.deltas, ['第1', '轮回复。']);
    assert.equal(timing.find(row => row[0] === 'dispatch' && row[1] === 'fallback')![2]!.mode, 'per-message');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('a CLI that reports init only once still accepts later turns of the same verified process', async () => {
  const f = await fake([{ initOnce: true }]);
  const { chat } = manager(f.script);
  try {
    await chat.stream(turn([u('你好')]), new AbortController().signal, () => {});
    const events = collect();
    await chat.stream(turn([u('你好'), a('第1轮回复。'), u('再说')]), new AbortController().signal, events.emit);
    assert.deepEqual(events.deltas, ['第2', '轮回复。']);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('熟悉度: the relationship lines sit right after the persona in a session\'s opening message only; a changed switch, stage or nickname opens a new session, a new day number does not', async () => {
  const f = await fake();
  const { chat } = manager(f.script);
  const withLines = (messages: ChatMessage[], openingContext: string, openingKey: string, id: string) => {
    const task = turn(messages, { id });
    const session = task.session!;
    // The host puts the lines right after the persona, inside the composed text.
    session.persona = session.persona.replace(`${persona}\n\n`, `${persona}\n\n${openingContext}\n\n`);
    Object.assign(session, { openingContext, openingKey });
    return task;
  };
  const day3 = '【你们的关系】你们认识第 3 天。', day4 = '【你们的关系】你们认识第 4 天。', stage = '【你们的关系】你们认识第 4 天，现在的关系：熟起来。';
  try {
    await chat.stream(withLines([u('你好')], day3, 'off|', 'one'), new AbortController().signal, () => {});
    await chat.stream(withLines([u('你好'), a('第1轮回复。'), u('今天有点累')], day3, 'off|', 'two'), new AbortController().signal, () => {});
    const [opening, followUp] = await f.userTexts();
    assert.ok(opening.startsWith(`${persona}\n\n${day3}\n\n当前心情：平静。`), 'after the persona, before this turn\'s own context');
    assert.ok(!followUp.includes('你们认识第'), 'follow-up turns carry nothing about the relationship (R28: no per-turn cost)');
    assert.ok(followUp.includes('当前心情：平静。'));
    // The next day, same chat: the day number alone does not restart the session.
    await chat.stream(withLines([u('你好'), a('第1轮回复。'), u('今天有点累'), a('第2轮回复。'), u('晚安')], day4, 'off|', 'three'), new AbortController().signal, () => {});
    assert.equal((await f.spawns()).length, 1);
    // The card's switch was turned on: a new session opens with the new lines and the whole window.
    await chat.stream(withLines([u('你好'), a('第1轮回复。'), u('今天有点累'), a('第2轮回复。'), u('晚安'), a('第3轮回复。'), u('早')], stage, 'warming|', 'four'), new AbortController().signal, () => {});
    const spawns = await f.spawns();
    assert.equal(spawns.length, 2);
    const reopened = (await f.userTexts(spawns[1].pid))[0];
    assert.ok(reopened.startsWith(`${persona}\n\n${stage}\n\n`));
    assert.equal(JSON.parse(reopened.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]).history.length, 6);
  } finally { chat.dispose(); await f.cleanup(); }
});

// Opt-in: the real, signed-in Claude Code on this machine (uses your own quota: 6 short turns).
// Prints send→first-delta for per-message (cold) and persistent (cold / prewarmed / warm) turns,
// and checks that every persistent turn ends with *its own* state-tail nonce.
test('live: persistent session vs one process per message, first-delta timing', { skip: process.env.SOFT_HEARTS_CLAUDE_LIVE === '1' ? false : 'set SOFT_HEARTS_CLAUDE_LIVE=1' }, async () => {
  const model = process.env.SOFT_HEARTS_CLAUDE_LIVE_MODEL ?? 'haiku';
  const base = '你是桌宠小桃，说话温柔简短，每次只说一两句话。';
  const live = (options: Partial<PersistentClaudeOptions>) => new PersistentClaudeChat({ provider: () => ({ kind: 'claude', model }), chattedBefore: () => true, log: () => {}, ...options });
  const run = async (chat: PersistentClaudeChat, messages: ChatMessage[], key: string) => {
    const protocol = new MoodReplyProtocol(() => {});
    const composed = buildCompanionPersona({ persona: base, stateContext: '当前心情：平静。', memories: [], protocolInstruction: protocol.instruction() });
    let raw = '', first = -1;
    const started = performance.now();
    await chat.stream({ kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(composed, messages); },
      session: { key, basePersona: base, persona: composed, messages, data: () => null } }, new AbortController().signal,
    (type, text) => { if (type === 'delta') { if (first < 0) first = Math.round(performance.now() - started); raw += text; } });
    const ownTail = raw.includes(protocol.start) && raw.includes(protocol.end);
    const foreignTail = /<sh-state-[a-f0-9]+>/u.test(raw.split(protocol.start).join(''));
    return { first, raw, ownTail, foreignTail, visible: sessionText(raw) };
  };
  const oneShot = live({ enabled: false });
  const persistent = live({ enabled: true });
  const cold = live({ enabled: true });
  const rows: string[] = [];
  try {
    for (const n of [1, 2]) rows.push(`per-message #${n}: ${(await run(oneShot, [u('你好呀')], 'p')).first} ms`);
    rows.push(`persistent cold: ${(await run(cold, [u('你好呀')], 'c')).first} ms`);
    persistent.prewarm();
    await new Promise(resolve => setTimeout(resolve, 2500));
    const history: ChatMessage[] = [];
    for (const [index, line] of ['你好呀', '今天有点累', '那我去休息啦'].entries()) {
      history.push(u(line));
      const result = await run(persistent, [...history], 'live');
      history.push(a(result.visible));
      rows.push(`persistent ${index ? 'warm' : 'prewarmed'} #${index + 1}: ${result.first} ms (own nonce ${result.ownTail ? 'yes' : 'NO'}${result.foreignTail ? ', FOREIGN tail' : ''})`);
      assert.ok(result.visible.trim());
      assert.equal(result.foreignTail, false, 'an old turn\'s nonce would leak the tail into the reply');
    }
    console.info(`[live ${model}, ${process.platform}] ${rows.join(' | ')}`);
  } finally { oneShot.dispose(); persistent.dispose(); cold.dispose(); }
});
