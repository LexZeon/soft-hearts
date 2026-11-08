// Packaging-smoke stand-in for Claude Code's stream-json chat. Maintainer QA only: it is not in the
// packaged app (package.json build files/extraResources) and nothing under electron/ imports it.
// The smoke starts it only through installClaudeInterposer (scripts/lib/smoke-isolation.mjs):
//   node fake-claude.mjs --soft-hearts-fake-claude <log.jsonl> <the app's exact Claude Code argv...>
// No network, no account, no files except its own log. Importing this module runs nothing.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const FAKE_CLAUDE_MARKER = '--soft-hearts-fake-claude';
/** The streamed reply, in two deltas with a short gap (the same text the old HTTP fixture streamed). */
export const FAKE_CLAUDE_REPLY = Object.freeze(['你好，', '桌面伙伴已连接。']);
/** A current user message equal to this is held until interrupted, closed or expired. */
export const FAKE_CLAUDE_HOLD = 'WAIT';
/** The persistent session's follow-up header begins with this (electron/claude-session-prompt.ts). */
export const FOLLOW_UP_MARKER = '【同一段对话的新一轮】';

// The isolation flags electron/claude.ts claudeArguments() always sends, in order.
const fixedFlags = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt'];

/** The first words of the I-037 reaction judge system prompt (shared/behaviors/reactions/choose.ts reactionSystemPrompt). */
export const REACTION_JUDGE_OPENING = '你是桌宠角色的"反应判定员"';

/** Accepts exactly the companion chat argv: every isolation flag, a system prompt, optionally `--model <name>`. */
export function verifyArguments(args) {
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) return { ok: false, reason: 'argv is not a string list' };
  for (let index = 0; index < fixedFlags.length; index++)
    if (args[index] !== fixedFlags[index]) return { ok: false, reason: `argv[${index}] is not ${JSON.stringify(fixedFlags[index])}` };
  const systemPrompt = args[fixedFlags.length];
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) return { ok: false, reason: 'missing system prompt' };
  const rest = args.slice(fixedFlags.length + 1);
  if (rest.length === 0) return { ok: true, model: '', systemPromptLength: systemPrompt.length };
  if (rest.length === 2 && rest[0] === '--model' && rest[1] && rest[1].length <= 160) return { ok: true, model: rest[1], systemPromptLength: systemPrompt.length };
  return { ok: false, reason: 'unexpected extra arguments' };
}

/** The app's `<conversation-data>` block (electron/conversation-context.ts buildCodexChatPrompt), or null. */
export function parseConversation(text) {
  if (typeof text !== 'string') return null;
  const start = text.lastIndexOf('<conversation-data>\n'), end = text.lastIndexOf('\n</conversation-data>');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start + '<conversation-data>\n'.length, end));
    if (!data || typeof data.currentUser !== 'string' || !Array.isArray(data.history)) return null;
    return { opening: !text.startsWith(FOLLOW_UP_MARKER), currentUser: data.currentUser, historyLength: data.history.length };
  } catch { return null; }
}

/**
 * The protocol, without a process: `line()` takes one stdin line, `output()` receives stdout events,
 * `log()` receives metadata entries (never the prompt or system prompt), `timers` schedules the gap.
 */
export function createFakeClaude({ args, output, log, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle) }, holdMs = 30_000, gapMs = 50 }) {
  const verdict = verifyArguments(args);
  /** I-046 'fixed': the fixed system prompt names the one opening marker; the reply then starts with it. */
  const systemOpening = Array.isArray(args) && args.some(arg => typeof arg === 'string' && arg.includes('<sh-open>'));
  const session = `fake-${Math.random().toString(16).slice(2, 10)}`;
  let seq = 0, current = null;
  const queue = [];
  const send = event => output(event);
  const delta = text => send({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  const end = () => { current = null; const next = queue.shift(); if (next) start(next); };
  function start(message) {
    const turn = ++seq;
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [{ type: 'text', text: String(message.message?.content ?? '') }];
    const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
    const conversation = parseConversation(text);
    log({ event: 'user', seq: turn, parsed: !!conversation, opening: conversation?.opening ?? null, currentUser: conversation ? conversation.currentUser.slice(0, 200) : null,
      historyLength: conversation?.historyLength ?? null, imageCount: blocks.filter(block => block?.type === 'image').length, promptLength: text.length });
    if (!verdict.ok || !conversation) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session,
        result: verdict.ok ? 'fake claude: unrecognised prompt format' : `fake claude: unknown option (${verdict.reason})` });
      log({ event: 'refused', seq: turn });
      end();
      return;
    }
    // Claude Code reports init (no tools, no MCP servers) for every turn; the app checks each one.
    send({ type: 'system', subtype: 'init', session_id: session, model: verdict.model || 'default', tools: [], mcp_servers: [], slash_commands: [], permissionMode: 'default', apiKeySource: 'none' });
    current = { seq: turn, timer: null, hold: conversation.currentUser === FAKE_CLAUDE_HOLD };
    if (current.hold) {
      log({ event: 'hold', seq: turn });
      current.timer = timers.set(() => {
        log({ event: 'hold-expired', seq: turn });
        send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, result: 'fake claude: hold expired' });
        end();
      }, holdMs);
      return;
    }
    const id = `msg_fake_${turn}`;
    send({ type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [] } } });
    send({ type: 'stream_event', session_id: session, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    // I-046: a turn that asks for an opening marker gets it in front of the reply, as the real model is asked to write it.
    const opening = [...text.matchAll(/<sh-open-[a-f0-9]{8}>/gu)].at(-1)?.[0] ?? (systemOpening ? '<sh-open>' : '');
    delta(opening + FAKE_CLAUDE_REPLY[0]);
    current.timer = timers.set(() => {
      const text = FAKE_CLAUDE_REPLY.join('');
      delta(FAKE_CLAUDE_REPLY[1]);
      send({ type: 'stream_event', session_id: session, event: { type: 'content_block_stop', index: 0 } });
      send({ type: 'stream_event', session_id: session, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
      send({ type: 'stream_event', session_id: session, event: { type: 'message_stop' } });
      send({ type: 'assistant', session_id: session, message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
      send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: text });
      log({ event: 'reply', seq: turn, text });
      end();
    }, gapMs);
  }
  // reactionJudge: whether this process is an I-037 reaction judge (its system prompt opens the judge role); a yes/no, never the text.
  const reactionJudge = verdict.ok && String(args[fixedFlags.length]).startsWith(REACTION_JUDGE_OPENING);
  log({ event: 'start', argvOk: verdict.ok, ...(verdict.ok ? { model: verdict.model, systemPromptLength: verdict.systemPromptLength, reactionJudge } : { reason: verdict.reason }) });
  return {
    line(raw) {
      if (!raw.trim()) return;
      let message;
      try { message = JSON.parse(raw); } catch { log({ event: 'unexpected', type: 'not-json' }); return; }
      if (message?.type === 'control_request') {
        const subtype = message.request?.subtype;
        send({ type: 'control_response', response: { subtype: subtype === 'interrupt' ? 'success' : 'error', request_id: message.request_id, ...(subtype === 'interrupt' ? {} : { error: 'unsupported' }) } });
        if (subtype !== 'interrupt') { log({ event: 'unexpected', type: 'control:' + String(subtype).slice(0, 40) }); return; }
        log({ event: 'interrupt', seq: current?.seq ?? null });
        if (current) {
          timers.clear(current.timer);
          send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session });
          end();
        }
        return;
      }
      if (message?.type !== 'user') { log({ event: 'unexpected', type: String(message?.type).slice(0, 40) }); return; }
      if (current) queue.push(message); else start(message);
    },
    /** stdin ended: a held turn and queued messages are dropped; a reply already streaming still finishes. */
    close() {
      queue.length = 0;
      if (current?.hold) { timers.clear(current.timer); log({ event: 'hold-closed', seq: current.seq }); current = null; }
    },
    get busy() { return !!current; },
  };
}

/**
 * Every fake process's log under `directory` (`spawn-<n>.jsonl`, written by the fake started for
 * spawn n). A torn last line from a process still writing is ignored until it is complete.
 */
export function readFakeClaudeLogs(directory) {
  const spawns = [];
  for (const name of readdirSync(directory).filter(name => /^spawn-\d{1,3}\.jsonl$/.test(name)).sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10))) {
    const text = readFileSync(path.join(directory, name), 'utf8');
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    const entries = complete.split('\n').filter(Boolean).map(line => JSON.parse(line));
    spawns.push({ index: parseInt(name.slice(6), 10), entries });
  }
  const turns = spawns.flatMap(spawn => spawn.entries.filter(entry => entry.event === 'user').map(entry => {
    const own = spawn.entries.filter(other => other.seq === entry.seq);
    return { key: `${spawn.index}:${entry.seq}`, spawn: spawn.index, pid: spawn.entries[0]?.pid ?? null, ...entry,
      replies: own.filter(other => other.event === 'reply').length, interrupted: own.some(other => other.event === 'interrupt'),
      refused: own.some(other => other.event === 'refused') };
  }));
  return { spawns: spawns.map(spawn => ({ index: spawn.index, pid: spawn.entries[0]?.pid ?? null, cwdEmpty: spawn.entries.find(entry => entry.event === 'process')?.cwdEmpty ?? null,
    start: spawn.entries.find(entry => entry.event === 'start') ?? null, stdinEnded: spawn.entries.some(entry => entry.event === 'stdin-end'),
    unexpected: spawn.entries.filter(entry => entry.event === 'unexpected').length })), turns };
}

function main() {
  const [logFile, ...args] = process.argv.slice(3);
  const log = entry => appendFileSync(logFile, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + '\n');
  let cwdEmpty = null;
  try { cwdEmpty = readdirSync(process.cwd()).length === 0; } catch { /* Reported as unknown. */ }
  log({ event: 'process', cwdEmpty });
  const fake = createFakeClaude({ args, log, output: event => process.stdout.write(JSON.stringify(event) + '\n') });
  // Never outlive the smoke, even if the app keeps the pipe open.
  setTimeout(() => process.exit(3), 10 * 60_000).unref();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8_000_000) process.exit(4);
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); fake.line(line); }
  });
  // A finished per-message turn still sends its reply; then nothing keeps the process alive.
  process.stdin.on('end', () => { if (buffer.trim()) fake.line(buffer); buffer = ''; log({ event: 'stdin-end' }); fake.close(); });
}
if (process.argv[2] === FAKE_CLAUDE_MARKER && process.argv.length > 3) main();
