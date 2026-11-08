/**
 * I-021 的假实现：守约测试（tests/memory-notes.test.ts）拿它们和真实现跑同一组约定；以后接新实现，先拿它们对一遍。
 *  - FakeNoteArchive：内存里的几段聊天（不碰 memories.jsonl），可以加话、封存、删掉，看笔记本怎么跟着走。
 *  - FakeNoteWriter：不调模型，按提示词里的原文挑一条写好的回答；可以让它卡住（迟到的结果）、出错或写坏。
 */
import type { MemoryNoteBody, NoteArchive, NoteSegmentInfo, NoteSegmentMessage, NoteSegmentText } from './interface';

interface FakeSegment { id: string; scope: string; createdAt: number; lastAt: number; sealed: boolean; messages: NoteSegmentMessage[] }

export class FakeNoteArchive implements NoteArchive {
  private readonly segments = new Map<string, FakeSegment>();
  /** How long after her last reply a segment counts as finished (like segmentGapMinutes). */
  constructor(private readonly gapMs = 15 * 60_000) {}

  add(id: string, scope: string, at: number, messages: readonly NoteSegmentMessage[], sealed = true): this {
    this.segments.set(id, { id, scope, createdAt: at, lastAt: at + messages.length, sealed, messages: messages.map(message => ({ ...message })) });
    return this;
  }
  say(id: string, message: NoteSegmentMessage, at: number): void {
    const segment = this.segments.get(id);
    if (segment) { segment.messages.push({ ...message }); segment.lastAt = at; }
  }
  seal(id: string): void { const segment = this.segments.get(id); if (segment) segment.sealed = true; }
  remove(id: string): boolean { return this.segments.delete(id); }

  noteSegments(now: number): NoteSegmentInfo[] { return [...this.segments.values()].map(segment => this.info(segment, now)); }
  noteSegment(id: string, now: number): NoteSegmentText | null {
    const segment = this.segments.get(id);
    return segment ? { info: this.info(segment, now), messages: segment.messages.filter(message => message.content.trim()).map(message => ({ ...message })) } : null;
  }
  private info(segment: FakeSegment, now: number): NoteSegmentInfo {
    const chars = segment.messages.reduce((sum, message) => sum + message.content.length, 0);
    return { id: segment.id, scope: segment.scope, createdAt: segment.createdAt, lastAt: segment.lastAt,
      ended: segment.sealed || now - segment.lastAt >= this.gapMs, source: `${segment.messages.length}.${chars}.${segment.lastAt}`,
      userChars: segment.messages.filter(message => message.role === 'user').reduce((sum, message) => sum + Array.from(message.content.trim()).length, 0),
      replies: segment.messages.filter(message => message.role === 'assistant' && message.content.trim()).length };
  }
}

type Answer = string | Error | { wait: Promise<string> };

/** Answers by the first rule whose word appears in the prompt; a rule with no match answers `otherwise`. Counts every call. */
export class FakeNoteWriter {
  readonly calls: { prompt: string; systemPrompt: string; signal: AbortSignal }[] = [];
  private readonly rules: { word: string; answer: Answer }[] = [];
  constructor(private readonly otherwise: Answer = '不是 JSON') {}

  when(word: string, answer: Answer | MemoryNoteBody): this {
    this.rules.push({ word, answer: typeof answer === 'object' && !(answer instanceof Error) && !('wait' in answer) ? JSON.stringify(answer) : answer as Answer });
    return this;
  }
  readonly write = (prompt: string, systemPrompt: string, signal: AbortSignal): Promise<string> => {
    this.calls.push({ prompt, systemPrompt, signal });
    const answer = this.rules.find(rule => prompt.includes(rule.word))?.answer ?? this.otherwise;
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === 'string') return Promise.resolve(answer);
    return answer.wait;
  };
}

/** A note body for tests (every field filled, inside the caps). */
export function fakeNoteBody(overrides: Partial<MemoryNoteBody> = {}): MemoryNoteBody {
  return { title: '学校旁边新开的拉面店', summary: '用户说学校旁边新开了一家拉面店，想周末和朋友去尝尝。', people: [], things: ['拉面店', '学校'],
    mood: '期待', plans: ['周末和朋友去学校旁边的拉面店'], tags: ['拉面店', '拉面', '面馆', '学校', '周末'], ...overrides };
}
