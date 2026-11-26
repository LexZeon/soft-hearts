// I-139 B (docs/claude/2026-11-15-i139-defences.md): the recorded evaluation replies (synthetic cards, .local/fidelity etc., the corpus of
// scripts/lib/draft-leak-corpus.ts) through isLeakedDraft with and without the listener words. Counts only.
//   node node_modules/tsx/dist/cli.mjs scripts/lib/i139-corpus-leak-count.ts <dir>...
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isLeakedDraft } from '../../electron/brain/long-chat/history';
import { sessionText } from '../../electron/brain/claude-session-prompt';

async function files(target: string): Promise<string[]> {
  if (!(await stat(target)).isDirectory()) return target.endsWith('.json') ? [target] : [];
  const out: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...await files(full));
    else if (entry.name.endsWith('.json') && !entry.name.includes('ledger')) out.push(full);
  }
  return out;
}

function collect(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) collect(item, out); return; }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.chunks) && typeof record.nonce === 'string' && typeof record.user === 'string') {
    out.push(sessionText((record.chunks as Array<[number, string]>).map(([, text]) => text).join(''))); return;
  }
  for (const child of Object.values(record)) collect(child, out);
}

async function main(): Promise<void> {
  const texts: string[] = [];
  for (const target of process.argv.slice(2)) for (const file of await files(target)) {
    try { collect(JSON.parse(await readFile(file, 'utf8')), texts); } catch { /* not a run file */ }
  }
  const unique = [...new Set(texts)];
  let mentions = 0, off = 0, on = 0, onlyOn = 0;
  for (const content of unique) {
    if (/这个人|对方/u.test(content)) mentions++;
    const a = isLeakedDraft({ role: 'assistant', content }, { listenerWords: false }), b = isLeakedDraft({ role: 'assistant', content }, { listenerWords: true });
    if (a) off++; if (b) on++; if (b && !a) onlyOn++;
  }
  console.log(JSON.stringify({ replies: unique.length, mentionsListenerWord: mentions, leakedOff: off, leakedOn: on, newlyFlagged: onlyOn }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
