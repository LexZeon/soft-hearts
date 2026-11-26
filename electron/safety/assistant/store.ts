// I-071 v2 第二步 Claude 助手: its own two small files in the profile, nothing anywhere else.
//   <profile>/assistant/prefs.json    model and thinking effort (only the assistant's; her chat model is untouched)
//   <profile>/assistant/history.json  the last messages of this conversation, for after a restart; 「清空」 deletes it
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../../foundation/atomic-file';
import { ASSISTANT_NOTICE_LIMIT, readAssistantPrefs, type AssistantAction, type AssistantMessage, type AssistantPart, type AssistantPrefs } from '../../../shared/safety/assistant';
import { CONVERSION_LEFT_OUT_KINDS, CONVERSION_LEFT_OUT_REASONS, CONVERSION_STEPS, MAX_LEFT_OUT_LISTED, type ConversionJobView } from '../../../shared/cards';

const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
/** I-071 v2 第三步: a conversion line as stored (names, states and counts only). One still running at a restart did not finish. */
function cleanConversion(value: unknown): ConversionJobView | null {
  const job = value as Record<string, any> | null;
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || (job.target !== 'en' && job.target !== 'zh-CN')
    || !['running', 'done', 'failed', 'cancelled'].includes(job.state) || !Array.isArray(job.steps)) return null;
  const steps = CONVERSION_STEPS.map(id => {
    const step = job.steps.find((item: any) => item?.id === id);
    const status = ['waiting', 'running', 'done', 'skipped'].includes(step?.status) ? step.status : 'waiting';
    return { id, status, ...(Number.isSafeInteger(step?.done) && Number.isSafeInteger(step?.total) ? { done: step.done, total: step.total } : {}) };
  });
  const interrupted = job.state === 'running';
  return { id: job.id.slice(0, 64), sourceId: text(job.sourceId, 256), sourceName: text(job.sourceName, 80), target: job.target,
    state: interrupted ? 'failed' : job.state, steps, startedAt: Number.isFinite(job.startedAt) ? job.startedAt : 0,
    ...(Number.isFinite(job.finishedAt) ? { finishedAt: job.finishedAt } : {}), cancellable: false,
    ...(typeof job.newCardId === 'string' ? { newCardId: job.newCardId.slice(0, 64) } : {}), ...(typeof job.newName === 'string' ? { newName: job.newName.slice(0, 80) } : {}),
    ...(Array.isArray(job.lint) ? { lint: job.lint.filter((item: unknown) => typeof item === 'string').slice(0, 3).map((item: string) => item.slice(0, 300)) } : {}),
    ...(interrupted ? { error: '软件关闭时还没转完；下次打开时已经撤回，原角色没有任何改动。' } : typeof job.error === 'string' ? { error: job.error.slice(0, 300) } : {}),
    ...(job.carried && typeof job.carried === 'object' ? { carried: { notes: Number(job.carried.notes) || 0, profileEntries: Number(job.carried.profileEntries) || 0,
      diaryDays: Number(job.carried.diaryDays) || 0, voice: text(job.carried.voice, 300) } } : {}),
    // Fix 5: the items left out, titles and closed reasons only.
    ...(Array.isArray(job.leftOut) && job.leftOut.length ? { leftOut: job.leftOut.slice(0, MAX_LEFT_OUT_LISTED).flatMap((item: any) => {
      const reasons = Array.isArray(item?.reasons) ? item.reasons.filter((reason: unknown) => CONVERSION_LEFT_OUT_REASONS.includes(reason as never)) : [];
      // Every kind a conversion can list (the shared list, so a new kind is kept after a restart too: 'review' and 'persona' were dropped).
      const kind = CONVERSION_LEFT_OUT_KINDS.includes(item?.kind) ? item.kind : null;
      return typeof item?.title === 'string' && kind && reasons.length ? [{ title: item.title.slice(0, 40), kind, reasons }] : [];
    }), leftOutCount: Number.isSafeInteger(job.leftOutCount) && job.leftOutCount > 0 ? Math.min(job.leftOutCount, 10_000) : job.leftOut.length } : {}) };
}

export const ASSISTANT_HISTORY_LIMIT = 80;
const MAX_TEXT = 20_000;

function cleanPart(value: unknown): AssistantPart | null {
  if (!value || typeof value !== 'object') return null;
  const part = value as Record<string, any>;
  if (part.kind === 'text' && typeof part.text === 'string') return { kind: 'text', text: part.text.slice(0, MAX_TEXT) };
  if (part.kind === 'action' && part.action && typeof part.action.title === 'string' && typeof part.action.outcome === 'string') {
    const action = part.action as AssistantAction;
    // An undo slot does not survive a restart: the button is not offered again.
    return { kind: 'action', action: { tool: String(action.tool).slice(0, 64), title: action.title.slice(0, 60), tier: action.tier, outcome: action.outcome,
      ...(typeof action.detail === 'string' ? { detail: action.detail.slice(0, 80) } : {}), ...(typeof action.message === 'string' ? { message: action.message.slice(0, 160) } : {}),
      ...(action.undone ? { undone: true } : {}) } };
  }
  if (part.kind === 'choices' && part.choices && Array.isArray(part.choices.options)) {
    const choices = part.choices;
    return { kind: 'choices', choices: { id: String(choices.id).slice(0, 64), question: String(choices.question ?? '').slice(0, 200),
      options: choices.options.filter((item: unknown) => typeof item === 'string').slice(0, 6).map((item: string) => item.slice(0, 60)),
      // A question left unanswered before the restart is not answerable any more.
      answered: typeof choices.answered === 'string' ? choices.answered.slice(0, 60) : '' } };
  }
  if (part.kind === 'conversion') { const job = cleanConversion(part.job); return job ? { kind: 'conversion', job } : null; }
  if (part.kind === 'notice' && typeof part.text === 'string' && part.text.trim()) return { kind: 'notice', text: part.text.slice(0, ASSISTANT_NOTICE_LIMIT) };
  return null;
}

export function cleanHistory(value: unknown): AssistantMessage[] {
  const list = Array.isArray(value) ? value : Array.isArray((value as any)?.messages) ? (value as any).messages : [];
  return list.slice(-ASSISTANT_HISTORY_LIMIT).flatMap((item: any): AssistantMessage[] => {
    if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.id !== 'string' || !Array.isArray(item.parts)) return [];
    const parts = item.parts.map(cleanPart).filter((part: AssistantPart | null): part is AssistantPart => !!part);
    const status = item.status === 'streaming' ? 'stopped' : ['done', 'stopped', 'failed'].includes(item.status) ? item.status : undefined;
    return [{ id: item.id.slice(0, 64), role: item.role, at: Number.isFinite(item.at) ? item.at : 0, parts, ...(status ? { status } : {}),
      ...(typeof item.error === 'string' ? { error: item.error.slice(0, 300) } : {}),
      // Fix 4: the refused tools' names only, as plain tool-name characters.
      ...(Array.isArray(item.refusedTools) ? { refusedTools: item.refusedTools.filter((name: unknown) => typeof name === 'string' && (/^[A-Za-z0-9_.:-]{1,80}$/u.test(name) || name === '(不可读的名字)')).slice(0, 8) } : {}) }];
  });
}

export class AssistantStore {
  readonly directory: string;
  constructor(profileDirectory: string) { this.directory = path.join(profileDirectory, 'assistant'); }
  private file(name: string) { return path.join(this.directory, name); }

  async loadPrefs(): Promise<AssistantPrefs> {
    try { return readAssistantPrefs(JSON.parse(await readFile(this.file('prefs.json'), 'utf8'))); } catch { return readAssistantPrefs(null); }
  }
  async savePrefs(prefs: AssistantPrefs): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await atomicWriteFile(this.file('prefs.json'), JSON.stringify(prefs, null, 2));
  }
  async loadHistory(): Promise<AssistantMessage[]> {
    try { return cleanHistory(JSON.parse(await readFile(this.file('history.json'), 'utf8'))); } catch { return []; }
  }
  async saveHistory(messages: readonly AssistantMessage[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await atomicWriteFile(this.file('history.json'), JSON.stringify({ version: 1, messages: cleanHistory([...messages]) }));
  }
  async clearHistory(): Promise<void> { await rm(this.file('history.json'), { force: true }); }
}
