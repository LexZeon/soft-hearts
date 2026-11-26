// I-139 B (docs/claude/2026-11-15-i139-defences.md): the leaked-draft detectors learned the words the new instructions use ("这个人",
// "对方"), which she also says in ordinary replies ("你这个人真是的"). This replays every one of her real replies from a private
// read-only snapshot through both detectors and reports only counts and rule names, never any text:
//   * ReplyDraftGuard (the streaming filter), Chinese chat, five ways of cutting each reply into chunks;
//   * isLeakedDraft (electron/brain/long-chat/history.ts, what the long-chat window leaves out).
// No model calls, nothing written except --save / --against files (hashes only).
//   node node_modules/tsx/dist/cli.mjs scripts/lib/i139-draft-replay.ts --snapshot <profile copy> [--save <hashes.json>] [--against <hashes.json>]
// --listener on|off chooses the guard's listener-word option (absent: the code's default, the I-139 switch). --user-too adds the user's
// own messages, replayed as if she had said them (a harder test: people say "这个人"/"对方" about others all the time).
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../../electron/memory/memory';
import { ReplyDraftGuard } from '../../electron/brain/reply-draft-guard';
import { isLeakedDraft } from '../../electron/brain/long-chat/history';

const option = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 139;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 7)), pieces(n => n === 0 ? 1 : 1 + Math.floor(random() * 25))];
}

function guardOutcome(text: string, listener: boolean | undefined): { shown: string[]; kinds: string[] } {
  const shown: string[] = [], kinds = new Set<string>();
  for (const chunks of chunkings(text)) {
    const guard = new ReplyDraftGuard([], { chinese: true, ...(listener === undefined ? {} : { listenerWords: listener }) });
    let out = '';
    for (const chunk of chunks) out += guard.push(chunk);
    out += guard.finish();
    shown.push(out);
    for (const drop of guard.dropped) kinds.add(drop.kind);
  }
  return { shown, kinds: [...kinds].sort() };
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

async function main(): Promise<void> {
  const snapshot = option('snapshot');
  if (!snapshot) throw new Error('--snapshot <dir> is required');
  const listenerArg = option('listener');
  const listener = listenerArg === 'on' ? true : listenerArg === 'off' ? false : undefined;
  // --user-too: the user's own messages are replayed as if she had said them, a harder test of "这个人"/"对方" in speech.
  const userToo = process.argv.includes('--user-too');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-i139-replay-'));
  try {
    await copyFile(path.join(snapshot, 'memories.jsonl'), path.join(scratch, 'memories.jsonl'));
    await copyFile(path.join(snapshot, 'memory-scopes.json'), path.join(scratch, 'memory-scopes.json')).catch(() => {});
    const store = new MemoryStore(scratch);
    await store.load();
    const scopes = (JSON.parse(await readFile(path.join(scratch, 'memory-scopes.json'), 'utf8').catch(() => '{"scopes":[]}')) as { scopes?: Array<{ characterId: string; providerScope: string }> }).scopes ?? [];
    const replies: string[] = [];
    for (const scope of scopes) for (const message of store.conversationMessages(scope, 0, Number.MAX_SAFE_INTEGER))
      if ((message.role === 'assistant' || (userToo && message.role === 'user')) && typeof message.content === 'string' && message.content.trim()) replies.push(message.content);
    const unique = [...new Set(replies)];
    const result: Record<string, string> = {};
    let guardCut = 0, leaked = 0, mentions = 0, mentionsNoYou = 0;
    const kinds: Record<string, number> = {};
    for (const reply of unique) {
      const key = hash(reply);
      const guard = guardOutcome(reply, listener);
      const flagged = isLeakedDraft({ role: 'assistant', content: reply }, listener === undefined ? {} : { listenerWords: listener });
      if (guard.shown.some(shown => shown !== reply)) guardCut++;
      for (const kind of guard.kinds) kinds[kind] = (kinds[kind] ?? 0) + 1;
      if (flagged) leaked++;
      if (/这个人|对方/u.test(reply)) { mentions++; if (!/你这个人|您这个人/u.test(reply)) mentionsNoYou++; }
      result[key] = hash({ shown: guard.shown, flagged });
    }
    console.log(JSON.stringify({ scopes: scopes.length, replies: replies.length, unique: unique.length, listener: listener ?? 'default', guardChanged: guardCut, guardKinds: kinds, leakedDraft: leaked, mentionsListenerWord: mentions, mentionsNotYouThisPerson: mentionsNoYou }));
    const save = option('save');
    if (save) await writeFile(save, JSON.stringify(result));
    const against = option('against');
    if (against) {
      const before = JSON.parse(await readFile(against, 'utf8')) as Record<string, string>;
      let changed = 0, missing = 0;
      for (const [key, value] of Object.entries(result)) { if (!(key in before)) missing++; else if (before[key] !== value) changed++; }
      console.log(JSON.stringify({ compared: Object.keys(result).length - missing, missing, changedVsBaseline: changed }));
    }
  } finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
