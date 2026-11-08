/**
 * I-021「让她把记忆整理起来，想得起以前的事」的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 * 记录：docs/claude/2026-11-04-memory-notes.md。
 *
 * 三方，各管一件事：
 *  1. 聊天记忆（electron/memory.ts 的 MemoryStore，memories.jsonl）照旧保存原文，这个功能**一个字节都不写它**。它只多给三样
 *     只读的东西：`NoteArchive`（哪些段聊完了、每段的原文）、`noteScope`（当前角色和连接的不透明编号），以及两个挂钩：
 *     回忆时问一句 `MemoryRecallHints`（笔记帮着找到哪几段），删掉记忆时通知一声（笔记跟着删）。
 *  2. 笔记本（electron/memory-notes/：core.ts 决定什么时候写、写哪段、删除和迟到结果；store.ts 存 `memory-notes.json`；
 *     host.ts 接线）。每段聊完后、你不忙的时候，用你自己的 Claude Code（haiku 档位，和聊天同一条路）写一条笔记；旧对话
 *     也按同样的节奏慢慢补。
 *  3. 回忆（MemoryStore.retrieve）：先按原来的字面规则打分，再加上笔记给的分；交给模型的仍是**原文摘录**，笔记只帮着找到它，
 *     标题可以换成笔记的一句标题（不超过原来自动标题的 20 字）。`<private-memory-data>` 的条数、字数上限和固定说明文字都不变。
 *
 * 写笔记的提示词和严格解析在 note.ts，本机回忆比对在 recall.ts，旋钮在 knobs.ts，假实现在 fake.ts；
 * 守约测试在 tests/memory-notes.test.ts：换一种实现，先过那组测试。
 */

/** 一条笔记的正文：haiku 写的严格 JSON，各项有长度上限（note.ts NOTE_CAPS）。 */
export interface MemoryNoteBody {
  /** 一句话标题。 */
  readonly title: string;
  /** 发生了什么（已经做了的事也写在这里）。 */
  readonly summary: string;
  /** 提到的人（名字要在原文里出现过，note.ts faithfulNote）。 */
  readonly people: readonly string[];
  /** 提到的事、地方、店、东西。 */
  readonly things: readonly string[];
  /** 用户当时的心情；看不出来是 ''。 */
  readonly mood: string;
  /** 对话里明说了要做、约好了、还没做的事（不推测）。 */
  readonly plans: readonly string[];
  /** 方便以后找到的词：人名、地名、店名、事件、近义说法。 */
  readonly tags: readonly string[];
}

/** 主机存下的一条：和一段聊天记忆（一个 MemoryStore 记录）一一对应。 */
export interface MemoryNote {
  readonly recordId: string;
  /** 写笔记时那段原文的指纹（NoteSegmentInfo.source）；原文后来又长了，就是旧笔记，会重写。 */
  readonly source: string;
  /** 那段对话开始的时间。 */
  readonly segmentAt: number;
  readonly writtenAt: number;
  readonly body: MemoryNoteBody;
}

/** 控制窗口「聊天记忆」里一段记忆的笔记状态（只读显示）。 */
export type MemoryNoteStatus =
  /** 有笔记。 */
  | 'written'
  /** 还没有，她会在你不忙的时候写（包括还没聊完的一段）。 */
  | 'waiting'
  /** 你删掉了这条笔记：不会再写，原文还在。 */
  | 'deleted'
  /** 不写：太短、是她主动说的话、或者写了两次都没写成。 */
  | 'none';

export interface MemoryNotesProgress {
  /** 当前角色和连接下，已经有笔记的段数。 */
  readonly noted: number;
  /** 还在等着整理的段数（聊完了、够长、没删过笔记）。 */
  readonly waiting: number;
}

export interface MemoryNoteState {
  readonly status: MemoryNoteStatus;
  readonly note: MemoryNoteBody | null;
  readonly writtenAt: number | null;
  readonly progress: MemoryNotesProgress;
}

/** 回忆时笔记给一段记忆的提示（本机比对，不调模型）。 */
export interface MemoryNoteHint {
  /** 加到原来字面分数上的分。 */
  readonly score: number;
  /** 用户这句话像是在提以前的事（"还记得""那家店去了吗""周末那件事"）：排在前面。 */
  readonly explicit: boolean;
  /** 对上的词，用来在原文里找摘录的位置。 */
  readonly terms: readonly string[];
  /** 笔记的一句标题（≤ 20 字）。 */
  readonly title: string;
}

/** MemoryStore.retrieve 用的回忆挂钩：对用户这一句准备一次，再按记录编号查。实现不能抛错、不能等待。 */
export interface MemoryRecallHints {
  prepare(text: string): (recordId: string) => MemoryNoteHint | null;
  /**
   * 收回过笔记就变（删了一条笔记、记忆被删走、删笔记没存上又放回）：在这之前做的回忆作废，正在准备的那轮聊天重新回忆一次
   * （MemoryStore.recallRevision、CompanionService.begin）。
   */
  readonly revision?: number;
}

/** 删掉记忆时通知笔记本的方式（MemoryStore.onRecordsRemoved）。 */
export interface RecordsRemoval {
  /** 进了回收站、还可能找回来（不是永久删除）：你单独删过的笔记，找回以后仍然算删过。 */
  readonly recoverable: boolean;
}

/** 一段聊天（一个普通记录）的样子；不含原文。 */
export interface NoteSegmentInfo {
  readonly id: string;
  /** 不透明的角色和连接编号（MemoryStore.noteScope），只比相等。 */
  readonly scope: string;
  readonly createdAt: number;
  /** 她最后一句回复结束的时间。 */
  readonly lastAt: number;
  /** 原文定了：没有正在流式的回复，下一句话会开新的一段（封存了、隔了 segmentGapMinutes、或满了 segmentTurns 轮）。 */
  readonly ended: boolean;
  /** 原文的指纹：原文一变它就变。 */
  readonly source: string;
  /** 用户说的字数（去掉首尾空白）。 */
  readonly userChars: number;
  /** 她有字的回复条数。 */
  readonly replies: number;
}

export interface NoteSegmentMessage { readonly role: 'user' | 'assistant'; readonly content: string }

export interface NoteSegmentText {
  readonly info: NoteSegmentInfo;
  /** 有字的消息，按原来的顺序。 */
  readonly messages: readonly NoteSegmentMessage[];
}

/** 笔记本读聊天记忆用的（MemoryStore 实现；假实现 fake.ts FakeNoteArchive）。只读。 */
export interface NoteArchive {
  /** 所有角色和连接的普通聊天段（她主动说的话不算）。 */
  noteSegments(now: number): readonly NoteSegmentInfo[];
  /** 一段的原文；不存在或不是普通聊天段时为 null。 */
  noteSegment(id: string, now: number): NoteSegmentText | null;
}

/** 写一条笔记：一次单次无工具调用（electron/inner-loop/model.ts quickLineWithClaude，haiku）。返回模型的原话。 */
export type MemoryNoteWriter = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>;

/** 只有数和时长，没有笔记内容（开发者模式写一行到控制台）。 */
export interface MemoryNotesEvent {
  readonly kind: 'written' | 'invalid' | 'failed' | 'dropped' | 'aborted';
  readonly ms: number;
}
