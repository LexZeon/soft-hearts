import { quickLineWithClaude } from '../inner-loop/model';
import { entryById, type TestEntryMeta } from './match';

/**
 * The only Claude-specific part of the test commands (docs/claude/brain-interface.md, 依赖登记): when no local alias
 * matched, ONE small tool-less call picks an entry from the closed list. It runs only for a "测试：…" message in
 * developer mode, with its own system prompt; ordinary chat prompts never see this list. The answer can only be an id from
 * the list (anything else is "no entry"), and every entry is local and undoable, so a confused answer can do no harm.
 */
export const TEST_PICK_SYSTEM_PROMPT = [
  '你是桌宠应用里的「测试入口选择器」，只做一件事：开发者发来一句以“测试：”开头的话，你从给定的入口清单里选出最符合这句话意思的一个。',
  '只输出一行 JSON，不要任何别的文字：{"id":"入口编号"}。清单里没有合适的入口，就输出 {"id":null}。',
  '入口编号必须原样取自清单。说法不必一字不差，意思对就行；拿不准时输出 {"id":null}，不要硬猜。',
].join('\n');

export function testPickPrompt(entries: readonly TestEntryMeta[], body: string): string {
  const list = entries.map(entry => `${entry.id} ${entry.name}：${entry.summary}`).join('\n');
  return `入口清单：\n${list}\n\n开发者说：“${body.replace(/[“”]/gu, '"')}”`;
}

/** The id in the model's answer, or null (none fits, malformed, or an id that is not in the list). */
export function parseTestPick(text: string, entries: readonly TestEntryMeta[]): string | null {
  const match = /\{[^{}]*\}/u.exec(text);
  if (!match) return null;
  let data: unknown;
  try { data = JSON.parse(match[0]); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return entryById(entries, (data as { id?: unknown }).id)?.id ?? null;
}

export type TestPick = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<{ text: string }>;

/** Asks the small model; the call is injectable for tests. */
export async function pickTestEntry(entries: readonly TestEntryMeta[], body: string, signal: AbortSignal,
  ask: TestPick = quickLineWithClaude): Promise<string | null> {
  const result = await ask(testPickPrompt(entries, body), TEST_PICK_SYSTEM_PROMPT, signal);
  return parseTestPick(result.text, entries);
}
