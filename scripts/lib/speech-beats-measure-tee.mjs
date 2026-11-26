// 边说边演第 5 步的量法（docs/claude/2026-11-20-speech-beats-measure.md）：夹在应用的常驻进程和 Claude Code 之间的一层薄壳，做两件事：
//   1. 请求数硬上限：每转发一条用户消息先在账本里记一行；账本里已经有 cap 条，就不转发、结束（第 cap+1 条请求永远发不出去）。
//   2. 记账：每个 result 事件的用量（只有数字和模型名）写进账本，用来算"边说边演多用了多少词元"。
// 用法（由 scripts/dev/speech-beats-measure.ts 当 binary 的参数传进来）：
//   node speech-beats-measure-tee.mjs --ledger FILE --cap N -- <真的 claude 或假的> [它的参数……]
// 账本每行一个 JSON：{kind:'request'|'result'|'refused', pid, at, ...}。不记任何对话文字。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const flag = name => { const i = argv.indexOf(name); return i >= 0 && i < dash ? argv[i + 1] : undefined; };
const ledger = flag('--ledger'), cap = Number(flag('--cap'));
if (dash < 0 || !ledger || !Number.isInteger(cap) || cap < 0 || dash === argv.length - 1) { console.error('usage: --ledger FILE --cap N -- command [args]'); process.exit(2); }
const [command, ...rest] = argv.slice(dash + 1);

const write = row => appendFileSync(ledger, JSON.stringify({ pid: process.pid, at: Date.now(), ...row }) + '\n');
const requestsSoFar = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(line => line.includes('"kind":"request"')).length : 0;

const child = spawn(command, rest, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
child.on('error', error => { console.error(String(error)); process.exit(1); });
child.on('exit', code => process.exit(code ?? 0));

let model = '';
let outBuffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  outBuffer += chunk;
  let at;
  while ((at = outBuffer.indexOf('\n')) >= 0) {
    const line = outBuffer.slice(0, at); outBuffer = outBuffer.slice(at + 1);
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') model = event.model;
      if (event.type === 'result') {
        const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
        const count = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
        write({ kind: 'result', model, error: event.is_error === true, subtype: String(event.subtype ?? ''), inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
          cacheRead: count(usage.cache_read_input_tokens), cacheCreation: count(usage.cache_creation_input_tokens), costUsd: count(event.total_cost_usd) });
      }
    } catch { /* not a JSON line: passed on as it is */ }
    process.stdout.write(line + '\n');
  }
});

let inBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inBuffer += chunk;
  let at;
  while ((at = inBuffer.indexOf('\n')) >= 0) {
    const line = inBuffer.slice(0, at); inBuffer = inBuffer.slice(at + 1);
    let isUser = false;
    try { isUser = JSON.parse(line)?.type === 'user'; } catch { /* forwarded untouched */ }
    if (isUser) {
      if (requestsSoFar() >= cap) { write({ kind: 'refused' }); console.error(`request cap ${cap} reached: this message was not sent`); child.kill(); process.exit(3); }
      write({ kind: 'request' });
    }
    child.stdin.write(line + '\n');
  }
});
process.stdin.on('end', () => child.stdin.end());
