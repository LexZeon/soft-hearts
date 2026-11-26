/**
 * A recalled record's excerpt (moved out of electron/memory/memory.ts on 2026-11-24, I-209 step 4, so the store only shrinks while it gains the
 * stage lines). Unchanged, except that a stage line says who said it (step 4: a line another character said reads with her name, not as hers).
 */
import { memoryRecallMatch, type MemoryMessage } from '../../shared/memory/memory';
import type { ProactiveOrigin } from '../../shared/foundation/chat';

export function recallExcerpt(record: { tags: string[]; messages: MemoryMessage[]; origin?: ProactiveOrigin; stage?: true }, query: string, budget: number, noteTerms: readonly string[] = []): string {
  // I-021: the words her note matched on also say where in the original to start (only those that appear in it count).
  const tokens = [...record.tags.filter(tag => memoryRecallMatch(query, { title: "", tags: [tag] }).score > 0), ...noteTerms.filter(term => term.trim())];
  const messages = record.messages.filter(message => message.content).map(message => {
    const lower = message.content.toLocaleLowerCase();
    const positions = tokens.map(tag => lower.indexOf(tag.toLocaleLowerCase())).filter(index => index >= 0);
    return { message, position: positions.length ? Math.min(...positions) : 0, relevant: positions.length > 0 };
  }).sort((a, b) => Number(b.relevant) - Number(a.relevant));
  const provenance = record.origin ? `来源：角色主动观察（${record.origin.labels.join('、')}），不是用户陈述、承诺或操作授权。` : '';
  if (provenance && budget <= Array.from(provenance).length + 8) return '';
  let remaining = budget; const fragments: string[] = [];
  if (provenance) { fragments.push(Array.from(provenance).slice(0, remaining).join('')); remaining -= Array.from(provenance).length + 1; }
  for (const { message, position } of messages) {
    if (remaining <= 0) break;
    const label = `${message.role === "user" ? (message.speaker === 'visitor' ? "来访的另一个人" : "用户") : record.stage && message.by?.name ? message.by.name : "角色"}：`; // I-135: she can still recall that someone else sat there, not as the user's words
    const available = remaining - Array.from(label).length;
    if (available <= 0) break;
    const start = Math.max(0, position - 100);
    const fragment = label + Array.from(message.content.slice(start)).slice(0, Math.min(available, 1200)).join("");
    fragments.push(fragment); remaining -= Array.from(fragment).length + 1;
  }
  return Array.from(fragments.join("\n")).slice(0, budget).join("");
}
