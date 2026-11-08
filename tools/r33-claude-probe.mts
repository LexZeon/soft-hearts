// R33 probe (maintainer only, run by hand; it uses YOUR Claude Code login and quota, 2 turns per run).
// What does a persistent `claude -p --input-format stream-json` process do with a user message
// written while a turn is still generating, and with Claude Code's interrupt control request?
// Same flags, environment and empty working folder as electron/claude-process.ts: it imports the
// app's own builders. Nothing in the app imports this file.
//
//   node node_modules/tsx/dist/cli.mjs tools/r33-claude-probe.mts <scenario> [--replay] [--out <dir>]
//   scenario: mid | early | interrupt | early-interrupt | idle-interrupt
//
// Results of 2026-11-02 (Claude Code 2.1.316, haiku): docs/claude/2026-11-02-R33-continuous-voice.md
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeArguments, claudeEnvironment, claudeInput, findClaude } from '../electron/claude';
import { CLAUDE_SESSION_SYSTEM_PROMPT } from '../electron/claude-session-prompt';

const scenario = process.argv[2] ?? '';
const replay = process.argv.includes('--replay');
const outIndex = process.argv.indexOf('--out');
const outDirectory = outIndex > 0 ? process.argv[outIndex + 1] : null;
if (!['mid', 'early', 'interrupt', 'early-interrupt', 'idle-interrupt'].includes(scenario)) {
  console.error('scenario: mid | early | interrupt | early-interrupt | idle-interrupt'); process.exit(2);
}
const binary = await findClaude();
const directory = await mkdtemp(path.join(os.tmpdir(), 'r33-probe-'));
const args = [...claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT), ...(replay ? ['--replay-user-messages'] : [])];
const child = spawn(binary, args, { cwd: directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnvironment() });
const t0 = Date.now();
const raw: string[] = [], log: string[] = [];
const note = (text: string) => { const line = `${String(Date.now() - t0).padStart(6)}ms ${text}`; log.push(line); console.log(line); };
const listeners: ((event: any) => void)[] = [];
let results = 0, deltas = 0, buffer = '';
const write = (label: string, line: string) => { note(`>>> WRITE ${label}`); child.stdin.write(line); };
const user = (text: string) => claudeInput({ prompt: text });
const interrupt = () => JSON.stringify({ type: 'control_request', request_id: 'probe-int', request: { subtype: 'interrupt' } }) + '\n';
const text = (blocks: any[] = []) => blocks.map(block => block.text ?? `[${block.type}]`).join('');
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => note(`STDERR ${String(chunk).slice(0, 300).replace(/\s+/g, ' ')}`));
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    raw.push(`${Date.now() - t0}\t${line}`);
    let event: any; try { event = JSON.parse(line); } catch { note(`NONJSON ${line.slice(0, 120)}`); continue; }
    if (event.type === 'system' && event.subtype === 'init') note(`init tools=${event.tools?.length} mcp=${event.mcp_servers?.length} model=${event.model}`);
    else if (event.type === 'system') note(`system/${event.subtype}`);
    else if (event.type === 'stream_event') {
      const inner = event.event ?? {};
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') { deltas++; note(`delta ${JSON.stringify(inner.delta.text)}`); }
      else if (inner.type === 'message_start' || inner.type === 'message_stop') note(`stream ${inner.type}`);
      else if (inner.type === 'content_block_start') note(`stream block_start ${inner.content_block?.type}`);
    } else if (event.type === 'assistant') note(`assistant text=${JSON.stringify(text(event.message?.content)).slice(0, 400)}`);
    else if (event.type === 'user') note(`user(echo) replay=${event.isReplay} text=${JSON.stringify(typeof event.message?.content === 'string' ? event.message.content : text(event.message?.content)).slice(0, 200)}`);
    else if (event.type === 'result') { results++; note(`RESULT #${results} subtype=${event.subtype} is_error=${event.is_error} result=${JSON.stringify(String(event.result ?? '')).slice(0, 400)}`); }
    else if (event.type === 'control_response') note(`control_response ${JSON.stringify(event.response).slice(0, 200)}`);
    else note(`other type=${event.type}`);
    for (const listener of [...listeners]) listener(event);
  }
});
const waitFor = (match: (event: any) => boolean, ms: number) => new Promise<boolean>(resolve => {
  const listener = (event: any) => { if (match(event)) { clearTimeout(timer); listeners.splice(listeners.indexOf(listener), 1); resolve(true); } };
  const timer = setTimeout(() => { listeners.splice(listeners.indexOf(listener), 1); resolve(false); }, ms);
  listeners.push(listener);
});
const isDelta = (event: any) => event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event?.delta?.type === 'text_delta';
const isResult = (event: any) => event.type === 'result';
const quiet = async (ms: number) => { let last = raw.length; for (;;) { await new Promise(done => setTimeout(done, ms)); if (raw.length === last) return; last = raw.length; } };

const COUNT = '请从1数到80，只输出阿拉伯数字，用中文逗号分隔，不要任何其他内容。';
const ADD = '补充：数完以后另起一行，写上“收到补充”四个字。';
const FIX = '补充：不是数到80，是只数到5；数完另起一行写“收到补充”。';
try {
  if (scenario === 'mid' || scenario === 'early') {
    write('msg1 (count)', user(COUNT));
    if (scenario === 'mid') await waitFor(isDelta, 60_000);
    write(`msg2 (supplement) ${scenario === 'mid' ? 'after the first text delta' : 'immediately'}`, user(ADD));
    await waitFor(isResult, 60_000);
    note(`second result within 30s: ${await waitFor(isResult, 30_000)}`);
  } else if (scenario === 'interrupt' || scenario === 'early-interrupt') {
    write('msg1 (count)', user(COUNT));
    if (scenario === 'interrupt') await waitFor(isDelta, 60_000);
    write('interrupt', interrupt());
    await waitFor(isResult, 20_000);
    write('msg2 (only the new part)', user(FIX));
    await waitFor(isResult, 60_000);
  } else {
    write('msg1 (short)', user('只回复“好”一个字。'));
    await waitFor(isResult, 60_000);
    write('interrupt (idle)', interrupt());
    await waitFor(event => event.type === 'control_response', 5_000);
    await quiet(500);
    write('msg2', user('只回复“收到”两个字。'));
    await waitFor(isResult, 60_000);
  }
  await quiet(1500);
} finally {
  note(`summary: results=${results} deltas=${deltas}`);
  child.stdin.end();
  await new Promise(done => { child.once('close', done); setTimeout(done, 5000); });
  if (child.exitCode === null) child.kill();
  if (outDirectory) {
    await mkdir(outDirectory, { recursive: true });
    const base = path.join(outDirectory, `${scenario}${replay ? '-replay' : ''}`);
    await writeFile(base + '.raw.jsonl', raw.join('\n') + '\n');
    await writeFile(base + '.log.txt', log.join('\n') + '\n');
  }
  await rm(directory, { recursive: true, force: true });
}
