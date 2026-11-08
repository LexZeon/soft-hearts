// Scriptable stand-in for Claude Code's stream-json chat, for the maintainer-only source smokes
// (scripts/*-smoke.mjs other than scripts/smoke.mjs). Same isolation contract as fake-claude.mjs:
// it is not packaged, nothing under electron/ imports it, and it is started only by the smoke's own
// interposer (installClaudeInterposer in smoke-isolation.mjs) in place of the inert CLAUDE_PATH placeholder:
//   node fake-claude-relay.mjs --soft-hearts-fake-claude-relay <dir>/spawn-<n>.jsonl <the app's exact Claude Code argv...>
// Instead of a fixed reply, each turn is relayed over a local pipe (named in <dir>/relay.json) to the smoke
// runner (claude-smoke-fixture.mjs), which streams that smoke's synthetic reply back. No network, no
// account, no files except its own log. Importing this module runs nothing.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { verifyArguments } from './fake-claude.mjs';

export const FAKE_CLAUDE_RELAY_MARKER = '--soft-hearts-fake-claude-relay';
/** The file next to the spawn logs that names the runner's pipe. */
export const RELAY_FILE = 'relay.json';

/**
 * The protocol, without a process. `output()` receives stdout events for the app, `relay()` sends
 * messages to the runner, `log()` receives metadata (never prompt text), `idle()` is called when
 * stdin has ended and no turn is left (the process may then exit).
 *
 * To the runner: hello (once), turn {seq, text, images}, cancel {seq, reason}.
 * From the runner: delta {seq, text}, done {seq}, fail {seq, message}. Anything for a turn that is no
 * longer current is dropped, so nothing reaches the app after that turn's `result`.
 */
export function createRelayFakeClaude({ args, output, relay, log = () => {}, idle = () => {}, spawn = 0, pid = 0, cwdEmpty = null }) {
  const verdict = verifyArguments(args);
  const systemPrompt = verdict.ok ? args[args.indexOf('--system-prompt') + 1] : '';
  const session = `fake-relay-${Math.random().toString(16).slice(2, 10)}`;
  const queue = [];
  let seq = 0, current = null, stdinEnded = false, runnerGone = false;
  const send = event => output({ ...event, session_id: session });
  const stream = inner => send({ type: 'stream_event', event: inner });
  const end = () => {
    current = null;
    const next = queue.shift();
    if (next) start(next); else if (stdinEnded) idle();
  };
  const failCurrent = message => { send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: message }); end(); };
  function start(message) {
    const turn = ++seq;
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [{ type: 'text', text: String(message.message?.content ?? '') }];
    const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
    const images = blocks.filter(block => block?.type === 'image' && block.source?.type === 'base64')
      .map(block => ({ mediaType: String(block.source.media_type), data: String(block.source.data) }));
    log({ event: 'user', seq: turn, promptLength: text.length, imageCount: images.length });
    current = { seq: turn, text: '', started: false };
    if (!verdict.ok) { log({ event: 'refused', seq: turn }); failCurrent(`fake claude: unknown option (${verdict.reason})`); return; }
    if (runnerGone) { failCurrent('fake claude relay: the smoke runner is gone'); return; }
    // Claude Code reports init (no tools, no MCP servers) for every turn; the app checks each one.
    send({ type: 'system', subtype: 'init', model: verdict.model || 'default', tools: [], mcp_servers: [], slash_commands: [], permissionMode: 'default', apiKeySource: 'none' });
    relay({ type: 'turn', seq: turn, text, images });
  }
  function begin() {
    if (current.started) return;
    current.started = true;
    stream({ type: 'message_start', message: { id: `msg_relay_${spawn}_${current.seq}`, type: 'message', role: 'assistant', content: [] } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  }
  relay({ type: 'hello', spawn, pid, argvOk: verdict.ok, reason: verdict.ok ? null : verdict.reason, model: verdict.ok ? verdict.model : null, systemPrompt, cwdEmpty });
  log({ event: 'start', argvOk: verdict.ok, ...(verdict.ok ? { model: verdict.model, systemPromptLength: systemPrompt.length } : { reason: verdict.reason }) });
  return {
    /** One stdin line from the app. */
    line(raw) {
      if (!raw.trim()) return;
      let message;
      try { message = JSON.parse(raw); } catch { log({ event: 'unexpected', type: 'not-json' }); return; }
      if (message?.type === 'control_request') {
        const subtype = message.request?.subtype;
        send({ type: 'control_response', response: { subtype: subtype === 'interrupt' ? 'success' : 'error', request_id: message.request_id, ...(subtype === 'interrupt' ? {} : { error: 'unsupported' }) } });
        if (subtype !== 'interrupt') { log({ event: 'unexpected', type: 'control:' + String(subtype).slice(0, 40) }); return; }
        log({ event: 'interrupt', seq: current?.seq ?? null });
        if (current) { relay({ type: 'cancel', seq: current.seq, reason: 'interrupt' }); failCurrent('fake claude relay: interrupted'); }
        return;
      }
      if (message?.type !== 'user') { log({ event: 'unexpected', type: String(message?.type).slice(0, 40) }); return; }
      if (current) queue.push(message); else start(message);
    },
    /** One message from the runner. */
    fromRunner(message) {
      if (!current || message?.seq !== current.seq) return;
      if (message.type === 'delta' && typeof message.text === 'string' && message.text) {
        begin();
        current.text += message.text;
        stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.text } });
      } else if (message.type === 'done') {
        begin();
        const id = `msg_relay_${spawn}_${current.seq}`, text = current.text;
        stream({ type: 'content_block_stop', index: 0 });
        stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
        stream({ type: 'message_stop' });
        send({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
        send({ type: 'result', subtype: 'success', is_error: false, result: text });
        log({ event: 'reply', seq: current.seq, length: text.length });
        end();
      } else if (message.type === 'fail') {
        log({ event: 'fail', seq: current.seq });
        failCurrent(typeof message.message === 'string' && message.message ? message.message.slice(0, 2000) : 'fake claude relay: synthetic failure');
      }
    },
    /** stdin ended. A per-message process ends stdin right after its one message: that turn still finishes. */
    close() {
      stdinEnded = true;
      queue.length = 0;
      if (!current) idle();
    },
    /** The runner's pipe closed: the current turn fails and later ones are refused. */
    runnerClosed() {
      runnerGone = true;
      if (current) failCurrent('fake claude relay: the smoke runner is gone');
    },
    get busy() { return !!current; },
  };
}

function main() {
  const [logFile, ...args] = process.argv.slice(3);
  const directory = path.dirname(logFile), name = path.basename(logFile);
  const spawn = /^spawn-(\d{1,3})\.jsonl$/.test(name) ? parseInt(name.slice(6), 10) : -1;
  const log = entry => appendFileSync(logFile, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + '\n');
  let cwdEmpty = null;
  try { cwdEmpty = readdirSync(process.cwd()).length === 0; } catch { /* Reported as unknown. */ }
  log({ event: 'process', cwdEmpty });
  const { pipe } = JSON.parse(readFileSync(path.join(directory, RELAY_FILE), 'utf8'));
  const socket = net.createConnection(pipe);
  socket.setEncoding('utf8');
  const write = event => process.stdout.write(JSON.stringify(event) + '\n');
  const relay = message => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };
  const fake = createRelayFakeClaude({ args, output: write, relay, log, spawn, pid: process.pid, cwdEmpty,
    // Nothing left to do: let the event loop drain (stdout flushes) and exit on its own.
    idle: () => { log({ event: 'idle' }); socket.end(); } });
  // Never outlive the smoke, even if the app keeps the pipe open.
  setTimeout(() => process.exit(3), 10 * 60_000).unref();
  let fromRunner = '';
  socket.on('data', chunk => {
    fromRunner += chunk;
    let boundary;
    while ((boundary = fromRunner.indexOf('\n')) >= 0) {
      const line = fromRunner.slice(0, boundary); fromRunner = fromRunner.slice(boundary + 1);
      try { fake.fromRunner(JSON.parse(line)); } catch { log({ event: 'unexpected', type: 'runner-not-json' }); }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => { log({ event: 'runner-closed' }); fake.runnerClosed(); });
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8_000_000) process.exit(4);
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); fake.line(line); }
  });
  process.stdin.on('end', () => { if (buffer.trim()) fake.line(buffer); buffer = ''; log({ event: 'stdin-end' }); fake.close(); });
}
if (process.argv[2] === FAKE_CLAUDE_RELAY_MARKER && process.argv.length > 3) main();
