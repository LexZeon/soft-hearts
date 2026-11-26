// How long does starting and ending the brain's Claude Code process hold the calling thread? (docs/claude/2026-11-23-unbound-step6.md,
// section "聊天起 Claude 进程挪出主线程"). In the app the calling thread is Electron's main process, which is also the UI thread: every
// millisecond it is held, mouse events and window frames wait.
//   node node_modules/tsx/dist/cli.mjs scripts/dev/claude-launch-block.ts [--rounds 20] [--json <file>]
// Uses the app's own ClaudeChatProcess and streamClaude with the packaging-smoke fake Claude Code (scripts/lib/fake-claude.mjs, through
// node): no network, no account, no profile. Per round: start a persistent process, one turn, close it; then one one-shot call.
// Measured with a setImmediate ticker (the loop turns as fast as it can; the longest gap between two turns, reset at each phase, is the
// longest stretch the thread could run nothing else; a timer histogram cannot see below Windows' 15.6 ms timer step).
// Also the synchronous time of the close() call itself (the old code started taskkill.exe in it).
// Light (a few seconds); safe to run while the app is open (it never touches it).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeChatProcess } from '../../electron/brain/claude-process';
import { claudeInput, streamClaude } from '../../electron/brain/claude';
import { CLAUDE_SESSION_SYSTEM_PROMPT } from '../../electron/brain/claude-session-prompt';
import { FAKE_CLAUDE_MARKER } from '../lib/fake-claude.mjs';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const rounds = Math.min(200, Math.max(1, Number(option('--rounds')) || 20));
const jsonOut = option('--json');
const fake = path.resolve('scripts/lib/fake-claude.mjs');
const logs = mkdtempSync(path.join(os.tmpdir(), 'soft-hearts-launch-block-'));
let last = performance.now(), longest = 0, ticking = true;
const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (ticking) setImmediate(tick); };
setImmediate(tick);
const ticker = { reset() { last = performance.now(); longest = 0; } };
const phaseMax = () => Math.max(longest, performance.now() - last);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const opening = (text: string) => `人设\n\n以下JSON是普通聊天输入\n<conversation-data>\n${JSON.stringify({ currentUser: text, history: [] })}\n</conversation-data>`;

const rows: { start: number; turn: number; closeCall: number; close: number; oneShot: number }[] = [];
try {
  for (let round = 0; round < rounds; round++) {
    await pause(150);
    ticker.reset();
    const chat = await ClaudeChatProcess.start({ binary: process.execPath, binaryArgs: [fake, FAKE_CLAUDE_MARKER, path.join(logs, `spawn-${round}.jsonl`)],
      model: 'haiku', systemPrompt: CLAUDE_SESSION_SYSTEM_PROMPT });
    await pause(120); // the process comes up (the old code held the thread inside start(); the new one only after it, in a worker)
    const start = phaseMax();
    ticker.reset();
    await chat.run(claudeInput({ prompt: opening('你好') }), new AbortController().signal, () => {});
    const turn = phaseMax();
    await pause(50);
    ticker.reset();
    const t0 = performance.now();
    chat.close();
    const closeCall = performance.now() - t0;
    await pause(400); // taskkill (Windows) runs and ends
    const close = phaseMax();
    ticker.reset();
    await streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: '', writable: false, prompt: opening('你好') }, new AbortController().signal, () => {},
      process.execPath, [fake, FAKE_CLAUDE_MARKER, path.join(logs, `oneshot-${round}.jsonl`)]);
    await pause(100);
    const oneShot = phaseMax();
    rows.push({ start, turn, closeCall, close, oneShot });
  }
} finally {
  ticking = false;
  rmSync(logs, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0], median: sorted[sorted.length >> 1], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) }; };
const fmt = (s: ReturnType<typeof stats>) => `min ${s.min!.toFixed(1)} / median ${s.median!.toFixed(1)} / p90 ${s.p90!.toFixed(1)} / max ${s.max!.toFixed(1)} ms`;
const summary = Object.fromEntries((['start', 'turn', 'closeCall', 'close', 'oneShot'] as const).map(key => [key, stats(rows.map(row => row[key]))]));
console.log(`${rounds} rounds, ${process.platform} ${process.arch}, node ${process.version}`);
console.log(`start a persistent process  (longest block): ${fmt(summary.start)}`);
console.log(`one turn on it              (longest block): ${fmt(summary.turn)}`);
console.log(`close() call itself       (sync time): ${fmt(summary.closeCall)}`);
console.log(`close and its taskkill      (longest block): ${fmt(summary.close)}`);
console.log(`one-shot call, start to end (longest block): ${fmt(summary.oneShot)}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ rounds, platform: process.platform, arch: process.arch, summary, rows }, null, 1));
