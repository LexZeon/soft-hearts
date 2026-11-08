import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A fake `claude -p --input-format stream-json` that reproduces what the real
 * Claude Code 2.1.316 did in the R33 probe (docs/claude/2026-11-02-R33-continuous-voice.md):
 *
 * - user messages are queued first-in first-out; each one is its own turn
 *   (init, deltas, assistant, result), never merged into the running turn and
 *   never batched with another queued message;
 * - the interrupt control request answers `control_response success` with
 *   `still_queued`; a running turn then ends with its partial `assistant`
 *   message, a "[Request interrupted by user]" user echo and
 *   `result error_during_execution`; on an idle process nothing else happens;
 *   an interrupt that arrives while a message is queued but not started stops
 *   that turn right after its init.
 *
 * The reply is "收到，<current user text>" plus a mood tail that uses the nonce
 * in this turn's prompt (it was "回应：…" until 2026-11-04: in a Chinese chat a
 * label and a colon at the very start are now held until the line shows it is
 * not a plan, docs/claude/2026-11-04-draft-leak-plan-block.md). Markers in the current user text steer timing so tests
 * can hit exact races (release with `release(name)`):
 *   #hold:<name>   stream the first delta, then wait for release (or interrupt);
 *   #wait:<name>   wait before any delta;
 *   #tail:<name>   stream the body and half of the tail, then wait;
 *   #late          on interrupt, one more delta arrives before the turn ends;
 *   #first:<name>  hold; an interrupt finds the turn already finished (its
 *                  result comes first, the control_response after it);
 *   #deaf:<name>   hold; an interrupt is answered "success" but the turn never ends;
 *   #draft         the body is a synthetic internal note (X-237's sentence) instead of "收到，…", so the
 *                  draft filter empties the whole reply (docs/claude/2026-11-03-draft-first-char.md).
 * It runs as `node <script> <claude args>` (binaryArgs), like the other fakes.
 */
const source = String.raw`
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname;
fs.appendFileSync(path.join(dir, "spawns.log"), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwdEntries: fs.readdirSync(process.cwd()) }) + "\n");
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const log = value => fs.appendFileSync(path.join(dir, "input.log"), JSON.stringify({ pid: process.pid, ...value }) + "\n");
const queue = [];
let current = null, interruptNext = false, turns = 0, buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on("end", () => { if (!current && !queue.length) process.exit(0); });
const delta = text => { out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }); if (current) current.sent += text; };
function userText(message) {
  const prompt = message.message.content.map(block => block.text || "").join("");
  const start = prompt.lastIndexOf("<conversation-data>\n"), end = prompt.lastIndexOf("\n</conversation-data>");
  let text = prompt;
  if (start >= 0 && end > start) { try { text = JSON.parse(prompt.slice(start + 20, end)).currentUser; } catch {} }
  const nonce = [...prompt.matchAll(/<sh-state-([a-f0-9]+)>/g)].map(match => match[1]).at(-1) || "";
  return { prompt, text, nonce };
}
function handle(message) {
  if (message.type === "control_request") {
    log({ control: message.request && message.request.subtype, id: message.request_id });
    const turn = current;
    const respond = () => out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: queue.map(() => ({})) } } });
    if (turn && turn.mode === "first") { finishTurn(turn); respond(); return; }
    respond();
    if (turn && turn.mode === "deaf") return;
    if (turn) stopTurn(turn);
    else if (queue.length) interruptNext = true;
    return;
  }
  if (message.type !== "user") return;
  const parsed = userText(message);
  log({ user: parsed.text, prompt: parsed.prompt });
  queue.push(parsed);
  if (!current) setImmediate(next);
}
function next() {
  if (current || !queue.length) return;
  const item = queue.shift();
  turns++;
  out({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "fake" });
  if (interruptNext) {
    interruptNext = false;
    out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
    setImmediate(next); return;
  }
  const body = item.text.includes("#draft") ? "这一轮回复短些，语气带点傲娇。" : "收到，" + item.text;
  const tail = item.nonce ? "\n<sh-state-" + item.nonce + ">{\"context\":\"support\",\"delta\":{\"O\":1},\"reason\":\"合成\",\"confidence\":0.9}</sh-state-" + item.nonce + ">" : "";
  const mark = /#(hold|wait|tail|first|deaf):([A-Za-z0-9_-]+)/.exec(item.text);
  current = { item, body, tail, sent: "", mode: mark ? mark[1] : "plain", name: mark ? mark[2] : "", late: item.text.includes("#late"), timer: null };
  const turn = current;
  if (turn.mode === "plain") { finishTurn(turn); return; }
  if (turn.mode === "hold" || turn.mode === "first" || turn.mode === "deaf") delta(body.slice(0, 3));
  if (turn.mode === "tail") { delta(body); delta(tail.slice(0, 20)); }
  turn.timer = setInterval(() => {
    if (current !== turn || !fs.existsSync(path.join(dir, "release-" + turn.name))) return;
    finishTurn(turn);
  }, 5);
}
function finishTurn(turn) {
  if (current !== turn) return;
  clearInterval(turn.timer);
  const full = turn.body + turn.tail;
  if (full.length > turn.sent.length) delta(full.slice(turn.sent.length));
  out({ type: "assistant", message: { id: "m" + turns, role: "assistant", content: [{ type: "text", text: full }] } });
  out({ type: "result", subtype: "success", is_error: false, result: full });
  current = null; setImmediate(next);
}
function stopTurn(turn) {
  clearInterval(turn.timer);
  if (turn.late) delta("（迟到的半句）");
  out({ type: "assistant", message: { id: "m" + turns, role: "assistant", content: [{ type: "text", text: turn.sent }] } });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
  current = null; setImmediate(next);
}
`;

export interface FakeClaudeInput { pid: number; user?: string; prompt?: string; control?: string; id?: string }

export async function fakeClaudeStream() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-r33-claude-'));
  const script = path.join(root, 'fake-claude-stream.cjs');
  await writeFile(script, source);
  const lines = async (name: string) => {
    try { return (await readFile(path.join(root, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  return {
    root, script,
    spawns: () => lines('spawns.log') as Promise<{ pid: number; args: string[]; cwdEntries: string[] }[]>,
    inputs: () => lines('input.log') as Promise<FakeClaudeInput[]>,
    /** The current user text of every message written, in order. */
    async users() { return (await this.inputs()).filter(row => row.user !== undefined).map(row => row.user!); },
    async controls() { return (await this.inputs()).filter(row => row.control !== undefined).map(row => row.control!); },
    release: (name: string) => writeFile(path.join(root, 'release-' + name), ''),
    released: async (name: string) => access(path.join(root, 'release-' + name)).then(() => true, () => false),
    cleanup: async () => {
      if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('soft-r33-claude-')) throw Error('unexpected fake root');
      // Windows may still hold a just-exited child's handle for a moment.
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}
