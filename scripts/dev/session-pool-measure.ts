// I-186 step 0 (docs/claude/2026-11-22-i186-step0-session-pool.md): local numbers with the fake Claude (tests/helpers/fake-claude-stream.ts),
// real child processes, the app's own ClaudeChatProcess, PersistentClaudeChat and ClaudeSessionPool; synthetic text, no profile, no network.
//   1. Switching back: One and Gene take turns (6 turns). Before = one PersistentClaudeChat whose key changes on every switch (today's
//      app: the speech scope carries the context generation); after = the pool. Per turn: process kind, reuse, first delta ms.
//   2. Memory: 1 and 3 warm characters, the working set of the fake processes (Windows Get-Process). A fake is a small node script, so this
//      is the pool's own overhead per process, not Claude Code's (a real Claude Code process is a much larger node program; measuring it
//      would start the user's own Claude Code, which this script never does).
//
//   node node_modules/tsx/dist/cli.mjs scripts/dev/session-pool-measure.ts [--out FILE]
// Prints numbers only.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { ChatMessage } from '../../shared/foundation/chat';
import { buildCodexChatPrompt } from '../../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask, type PersistentClaudeOptions } from '../../electron/brain/claude-session';
import { ClaudeSessionPool, chatSessionKey } from '../../electron/brain/session-pool';
import { fakeClaudeStream } from '../../tests/helpers/fake-claude-stream';

const args = process.argv.slice(2);
const out = (() => { const index = args.indexOf('--out'); return index >= 0 ? args[index + 1] ?? '' : ''; })();
const BASE = (id: string) => `你是${id}，一个原创桌宠角色，说话温柔，喜欢短句。`.repeat(8);

interface Turn { character: string; process: string; reuse: string; firstMs: number }

async function scenario(fake: { script: string }, pooled: boolean): Promise<Turn[]> {
  let generation = 0, active = 'One';
  const starts = new Map<string, number>(), rows: Turn[] = [], infos = new Map<string, ClaudeTimingInfo>();
  const options: PersistentClaudeOptions = { enabled: true, binary: async () => process.execPath, binaryArgs: [fake.script], provider: () => ({ kind: 'claude', model: '' }),
    chattedBefore: () => true, log: () => {},
    timing: { dispatched: (id, info) => { infos.set(id, info); starts.set(id, performance.now()); }, firstDelta: id => { const at = starts.get(id); if (at !== undefined) starts.set(id, performance.now() - at); } } };
  const accepted = () => `${active}|${generation}`;
  const chat = pooled
    ? new ClaudeSessionPool({ ...options, turn: () => ({ characterId: active, providerScope: 'p', accepted: accepted(), chat: chatSessionKey(active, 'p', `c-${active}`) }),
      stage: () => ({ characterId: active, providerScope: 'p' }) })
    : new PersistentClaudeChat(options);
  const histories = new Map<string, ChatMessage[]>();
  try {
    let n = 0;
    for (const character of ['One', 'Gene', 'One', 'Gene', 'One', 'Gene']) {
      if (character !== active || n === 0) { active = character; generation++; chat.close('context'); }
      await new Promise(resolve => setTimeout(resolve, 400)); // a natural pause: a spare started at the switch is ready, as it would be
      const history = histories.get(character) ?? [], text = `第${++n}句`, id = `t${n}`, messages = [...history, { role: 'user' as const, content: text }];
      const persona = `${BASE(character)}\n\n当前心情：平静。\n\n尾注标记 nonce-${n}`;
      const task: CompanionClaudeTask = { kind: 'chat', model: '', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(persona, messages); },
        imageDataUrls: [], replyId: id, session: { key: accepted(), basePersona: BASE(character), persona, messages } };
      let reply = '';
      await chat.stream(task, new AbortController().signal, (type, value) => { if (type === 'delta') reply += value; });
      histories.set(character, [...messages, { role: 'assistant', content: reply }]);
      const info = infos.get(id);
      rows.push({ character, process: info?.process ?? '?', reuse: info?.reuse ?? '?', firstMs: Math.round(starts.get(id) ?? -1) });
    }
  } finally { chat.dispose(); }
  return rows;
}

function workingSetKb(pids: number[]): number {
  if (!pids.length) return 0;
  const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`], { encoding: 'utf8' });
  return Math.round(Number(text.trim() || 0) / 1024);
}

async function memory(characters: number): Promise<{ characters: number; processes: number; workingSetKb: number; perProcessKb: number }> {
  const fake = await fakeClaudeStream();
  let active = 'c0';
  const pool = new ClaudeSessionPool({ enabled: true, binary: async () => process.execPath, binaryArgs: [fake.script], provider: () => ({ kind: 'claude', model: '' }),
    chattedBefore: () => false, log: () => {}, maxWarm: 3,
    turn: () => ({ characterId: active, providerScope: 'p', accepted: active, chat: chatSessionKey(active, 'p', 'c') }), stage: () => ({ characterId: active, providerScope: 'p' }) });
  try {
    for (let i = 0; i < characters; i++) {
      active = `c${i}`; pool.close('context');
      const messages: ChatMessage[] = [{ role: 'user', content: '你好' }];
      await pool.stream({ kind: 'chat', model: '', workingDirectory: os.tmpdir(), writable: false, prompt: buildCodexChatPrompt(BASE(active), messages), imageDataUrls: [],
        session: { key: active, basePersona: BASE(active), persona: BASE(active), messages } }, new AbortController().signal, () => {});
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    const pids = (await fake.spawns()).map(row => row.pid);
    const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const kb = workingSetKb(alive);
    return { characters, processes: alive.length, workingSetKb: kb, perProcessKb: alive.length ? Math.round(kb / alive.length) : 0 };
  } finally { pool.dispose(); await new Promise(resolve => setTimeout(resolve, 300)); await fake.cleanup().catch(() => {}); }
}

const fake = await fakeClaudeStream();
try {
  const before = await scenario(fake, false);
  const after = await scenario(fake, true);
  const result = { switching: { before, after }, memory: [await memory(1), await memory(3)] };
  const text = JSON.stringify(result, null, 1);
  console.log(text);
  if (out) writeFileSync(out, text + '\n');
} finally { await fake.cleanup().catch(() => {}); }
