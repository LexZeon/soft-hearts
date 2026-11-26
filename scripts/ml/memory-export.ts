// Embedding comparison (I-127), step 1: read a THROWAWAY COPY of a profile's chat memory with the app's own MemoryStore and write
// every ordinary chat segment (the same NoteSegmentInfo the semantic recall uses) plus the exact text the app embeds for it
// (shared/memory/memory-semantic/score.ts memoryEmbedText) to one JSON file. No data lives in this script; the output holds private text and
// belongs in the private folder only.
//
//   node node_modules/tsx/dist/cli.mjs scripts/ml/memory-export.ts --profile <copy dir> --out <file.json>
//
// MemoryStore.load() may append "interrupted" finishes to the journal it reads, so --profile must be a copy made for this run; the
// script refuses any path under a real soft-hearts profile folder.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from '../../electron/memory/memory';
import { memoryEmbedText } from '../../shared/memory/memory-semantic/score';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

const profile = path.resolve(arg('profile'));
const out = path.resolve(arg('out'));
if (/[\\/]AppData[\\/]Roaming[\\/]soft-hearts/i.test(profile)) throw new Error('refusing to open a real profile folder: pass a copy');

const store = new MemoryStore(profile);
await store.load();
const now = Date.now();
const records = (store as unknown as { records: Map<string, { id: string; scopeKey: string; title: string; tags: string[]; origin?: unknown;
  messages: { role: 'user' | 'assistant'; content: string; createdAt: number; updatedAt: number; status: string }[] }> }).records;
const segments = store.noteSegments(now).map(info => {
  const record = records.get(info.id)!;
  const messages = record.messages.filter(m => m.content.trim()).map(m => ({ role: m.role, content: m.content, at: m.createdAt }));
  return { id: info.id, scope: info.scope, title: record.title, tags: record.tags, createdAt: info.createdAt, lastAt: info.lastAt,
    ended: info.ended, source: info.source, embedText: memoryEmbedText(messages.filter(m => m.role === 'user').map(m => m.content)), messages };
});
const scopes: Record<string, number> = {};
for (const s of segments) scopes[s.scope] = (scopes[s.scope] ?? 0) + 1;
await writeFile(out, JSON.stringify({ exportedAt: now, scopes, segments }), 'utf8');
console.log(JSON.stringify({ segments: segments.length, scopes, withText: segments.filter(s => s.embedText).length }));
