// The fake Claude the prewarm tests run (shared by tests/long-chat-prewarm.test.ts and tests/start-warm-paid.test.ts): the stand-in for
// `claude -p --input-format stream-json` with a simulated prompt cache.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The stand-in for `claude -p --input-format stream-json`. Every process logs its pid and folder; every user message logs its blocks.
// Cache: a request is [ENV <cwd>, ...this process's earlier blocks and replies, ...this message's blocks]; the longest prefix that ends
// at a block boundary and was the whole of an earlier request is read from cache, the rest is created; the first character waits
// created / RATE ms. A message whose last block has no currentUser (the hidden request) answers "WARM-SECRET"; "#slow" waits 1.5 s.
export const SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), readline = require('node:readline');
const dir = __dirname, cwd = process.cwd(), RATE = 5;
fs.appendFileSync(path.join(dir, 'spawns.log'), JSON.stringify({ pid: process.pid, cwd }) + '\n');
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const cacheFile = path.join(dir, 'cache.json');
const hash = parts => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
const size = parts => parts.reduce((sum, part) => sum + part.length, 0);
let context = ['ENV ' + cwd], turns = 0;
readline.createInterface({ input: process.stdin }).on('line', raw => {
  let message; try { message = JSON.parse(raw); } catch { return; }
  if (message.type !== 'user') return;
  const blocks = message.message.content.map(block => block.text || '');
  fs.appendFileSync(path.join(dir, 'input.log'), JSON.stringify({ pid: process.pid, cwd, blocks }) + '\n');
  const request = [...context, ...blocks];
  let cache; try { cache = new Set(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))); } catch { cache = new Set(); }
  let hit = 0;
  for (let index = request.length; index > 0; index--) if (cache.has(hash(request.slice(0, index)))) { hit = index; break; }
  const read = size(request.slice(0, hit)), created = size(request) - read;
  cache.add(hash(request));
  fs.writeFileSync(cacheFile, JSON.stringify([...cache]));
  const last = blocks.at(-1);
  const data = /<conversation-data>\n([\s\S]*)\n<\/conversation-data>/.exec(last);
  const current = data ? JSON.parse(data[1]).currentUser : last;
  const id = 'msg_' + (++turns);
  const text = current === undefined ? 'WARM-SECRET 不该被任何人看到。' : '第' + turns + '轮回复。';
  let extra = 0; // a test can make the hidden request slower: the number of ms in the file "slow-warm"
  if (current === undefined) try { extra = Number(fs.readFileSync(path.join(dir, 'slow-warm'), 'utf8')) || 0; } catch {}
  const event = inner => send({ type: 'stream_event', event: inner });
  send({ type: 'system', subtype: 'init', model: 'fake', tools: [], mcp_servers: [] });
  const answer = () => setTimeout(() => {
    event({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    setTimeout(() => {
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
      event({ type: 'message_stop' });
      send({ type: 'assistant', message: { id, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
      send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: text,
        usage: { input_tokens: 0, output_tokens: text.length, cache_read_input_tokens: read, cache_creation_input_tokens: created } });
      context = [...request, text];
    }, current && current.includes('#slow') ? 1500 : 5);
  }, Math.round(created / RATE) + extra);
  // A test can also hold the hidden request until it deletes the file "hold-warm" (an event, not a guess of how long a machine takes).
  const holdFile = path.join(dir, 'hold-warm');
  const wait = () => { if (current === undefined && fs.existsSync(holdFile)) setTimeout(wait, 20); else answer(); };
  wait();
});
`;

export async function fake() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prewarm-session-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, SCRIPT);
  const lines = async (name: string) => { try { return (await readFile(path.join(root, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { root, script, holdWarm: () => writeFile(path.join(root, 'hold-warm'), ''), releaseWarm: () => rm(path.join(root, 'hold-warm'), { force: true }),
    slowWarm: (ms: number) => writeFile(path.join(root, 'slow-warm'), String(ms)), spawns: () => lines('spawns.log') as Promise<{ pid: number; cwd: string }[]>,
    inputs: () => lines('input.log') as Promise<{ pid: number; cwd: string; blocks: string[] }[]>,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) };
}

