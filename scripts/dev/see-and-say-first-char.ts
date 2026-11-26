// I-166 (docs/claude/2026-11-21-i166-see-and-say.md): local numbers with the fake Claude (tests/helpers/fake-claude-stream.ts) — how soon
// her first character comes with 0, 1 or 2 small frames on every turn (kept in the warm process outside a call), how long her closer look's
// continuation takes from the marker to her next character (the capture is instant here), and how many turns / frames one process holds
// before it is replaced. The app's own PersistentClaudeChat, ClaudeChatProcess and LookContinuation; synthetic text, synthetic frames
// (no camera, no screen, no network, no profile). Fake only: the real model's numbers need the user's Claude quota (ask first).
//
//   node node_modules/tsx/dist/cli.mjs scripts/dev/see-and-say-first-char.ts [--turns N (default 12)] [--out FILE]
// Prints numbers only.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { ChatMessage } from '../../shared/foundation/chat';
import { buildCodexChatPrompt } from '../../electron/brain/conversation-context';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../../electron/brain/claude-session';
import { LookContinuation } from '../../electron/brain/look-continuation';
import { callGlanceKnobs } from '../../electron/brain/call-glances';
import { fakeClaudeStream } from '../../tests/helpers/fake-claude-stream';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const turns = Math.max(3, Math.min(60, Number(option('--turns', '12')))), out = option('--out', '');
/** A small JPEG-shaped data URL of about `kb` KB (the session checks the magic bytes only); a 320×240 JPEG at quality 0.6 is 10–20 KB. */
const frame = (n: number, kb = 14) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([255, 216, 255, 224, n & 255]), Buffer.alloc(kb * 1024, n & 255)]).toString('base64');
const BASE = '你是小桃，一个原创桌宠角色，说话温柔，喜欢短句。'.repeat(8);
const stats = (values: number[]) => { const s = [...values].sort((a, b) => a - b), at = (p: number) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]; return { n: s.length, median: at(0.5), p25: at(0.25), p75: at(0.75), max: s.at(-1) }; };

const fake = await fakeClaudeStream();
try {
  const knobs = callGlanceKnobs();
  const result: Record<string, unknown> = { knobs };
  for (const frames of [0, 1, 2]) {
    const firsts: number[] = [], pids = new Set<number>(), starts = new Map<string, number>();
    const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [fake.script], provider: () => ({ kind: 'claude', model: '' }),
      chattedBefore: () => true, log: () => {}, callGlances: knobs, maxTurns: 1000, maxChars: 10_000_000,
      timing: { dispatched: id => { starts.set(id, performance.now()); }, firstDelta: id => { const at = starts.get(id); if (at !== undefined) firsts.push(performance.now() - at); } } });
    const messages: ChatMessage[] = [];
    try {
      for (let i = 0; i < turns; i++) {
        messages.push({ role: 'user', content: `第${i + 1}句·${frames}` });
        const window = [...messages], images = Array.from({ length: frames }, (_, k) => frame(i * 2 + k));
        const task: CompanionClaudeTask = { kind: 'chat', model: '', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(BASE, window); },
          imageDataUrls: images, replyId: `f${frames}-${i}`, session: { key: `m${frames}`, basePersona: BASE, persona: BASE, messages: window, data: () => null },
          ...(frames ? { callGlance: { glanceOnly: () => true, still: () => () => true, past: () => '' } } : {}) };
        const { output } = await chat.stream(task, new AbortController().signal, () => {});
        messages.push({ role: 'assistant', content: output.replace(/<sh-state-[\s\S]*$/, '').trim() || '嗯。' });
      }
      for (const row of await fake.inputs()) if (row.user?.endsWith(`·${frames}`)) pids.add(row.pid);
    } finally { chat.dispose(); }
    result[`frames${frames}`] = { firstCharMs: stats(firsts.slice(1).map(Math.round)), processesSoFar: pids.size };
  }
  // Frames per process before it is replaced: 2 small frames a turn until the cap.
  {
    const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [fake.script], provider: () => ({ kind: 'claude', model: '' }),
      chattedBefore: () => true, log: () => {}, callGlances: knobs, maxTurns: 1000, maxChars: 10_000_000 });
    const messages: ChatMessage[] = [], before = new Set((await fake.inputs()).map(row => row.pid));
    let changedAt: number | null = null, firstPid: number | null = null;
    try {
      for (let i = 0; i < knobs.cap; i++) {
        messages.push({ role: 'user', content: `cap${i}` });
        const window = [...messages];
        const task: CompanionClaudeTask = { kind: 'chat', model: '', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(BASE, window); },
          imageDataUrls: [frame(i, 2), frame(i + 100, 2)], replyId: `cap-${i}`, session: { key: 'cap', basePersona: BASE, persona: BASE, messages: window, data: () => null },
          callGlance: { glanceOnly: () => true, still: () => () => true, past: () => '' } };
        const { output } = await chat.stream(task, new AbortController().signal, () => {});
        messages.push({ role: 'assistant', content: output.replace(/<sh-state-[\s\S]*$/, '').trim() || '嗯。' });
        const pid = (await fake.inputs()).find(row => row.user === `cap${i}` && !before.has(row.pid))?.pid ?? null;
        if (firstPid === null) firstPid = pid; else if (pid !== firstPid && changedAt === null) { changedAt = i + 1; break; }
      }
    } finally { chat.dispose(); }
    result.cap = { framesPerTurn: 2, replacedOnTurn: changedAt, framesHeldBefore: changedAt === null ? null : (changedAt - 1) * 2 };
  }
  // The closer look: marker → her next character (capture instant), on the same warm process.
  {
    const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [fake.script], provider: () => ({ kind: 'claude', model: '' }),
      chattedBefore: () => true, log: () => {}, callGlances: knobs });
    const look = new LookContinuation({ senses: () => ({ camera: true, screen: false }), capture: async () => ({ dataUrls: () => [frame(7, 60)] }), note: (_s, seen) => `CONT-${seen}` });
    const messages: ChatMessage[] = [], latencies: number[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        messages.push({ role: 'user', content: `看看${i}⟦look-camera⟧` });
        const window = [...messages];
        let shown = '';
        await look.stream(chat, { kind: 'chat', model: '', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(BASE, window); },
          imageDataUrls: [], replyId: `c-${i}`, session: { key: 'closer', basePersona: BASE, persona: BASE, messages: window, data: () => null } }, new AbortController().signal, (_t, text) => { shown += text; });
        messages.push({ role: 'assistant', content: shown.replace(/<sh-state-[\s\S]*$/, '').trim() || '嗯。' });
        if (look.stats.lastMs !== null) latencies.push(look.stats.lastMs);
      }
    } finally { chat.dispose(); }
    result.closer = { continuationMs: stats(latencies), taken: look.stats.taken };
  }
  console.log(JSON.stringify(result));
  if (out) writeFileSync(out, JSON.stringify(result, null, 1));
} finally { await fake.cleanup(); }
