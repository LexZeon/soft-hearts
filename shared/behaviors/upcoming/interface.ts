/**
 * P-001「记得你的计划，到时候主动问起」的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 * 方案：docs/claude/2026-11-05-p001-plans-plan.md；第 1 步记录：docs/claude/2026-11-10-p001-step1.md。
 *
 * 这一步（"她记住，你看得见"）只做记和看：
 *  1. 你说一段话时，"允许记录"开着，这一段就打一个"可以记"的记号（只有段的编号，electron/memory/upcoming/marks.ts）。整段从头到尾开关都开着才算；
 *     中途关过，记号就没了，这一段不再记。
 *  2. 只有带记号的段，写笔记的那次 haiku（I-021）多问一句"你自己说的、带时间的打算，时间词照抄"，多回一个字段 `upcoming`
 *     （prompt.ts）；没有记号的段，笔记的提示词一个字不变。本机把时间词换算成"到时间"（due.ts），不是时间的词不记。
 *  3. 记下的小清单存在这个角色自己的小文件 `upcoming-<范围编号>.json` 里（和画像文件同一个目录，但不是画像文件的一部分，所以上一版软件读画像、日记不受影响；
 *     空的时候不写、变空就删），用户画像面板「她记得的事」看得见、删得掉。
 *  4. 手动关掉"允许记录"：所有角色的清单和所有记号立刻硬删除（不进回收站）。删掉聊天记忆或它的笔记：来自那一段的事跟着删。
 *     清单不进角色卡导出，不发到任何新的地方。
 *
 * 谁实现它：UpcomingBook 的真实现是 electron/memory/upcoming/book.ts（存在上面那个小文件里，electron/memory/upcoming/store.ts）；假实现是 fake.ts（内存里），
 * 守约测试在 tests/p001-upcoming-contract.test.ts：两个都要过。
 * 第 2、3 步（来找她时问起、她先开口问）还没做，这里的 `asked`、`user-said` 只是给那两步留好的状态。
 */

/** 等着（还没到问的时候，或到了还没问）／问过了／你自己先说了／过期了。 */
export const UPCOMING_STATES = ['waiting', 'asked', 'user-said', 'expired'] as const;
export type UpcomingState = (typeof UPCOMING_STATES)[number];

/** 清单里的一件事。不存你的原句：`what` 是笔记里的简写，`said` 是你说的时间词（原样）。 */
export interface UpcomingItem {
  readonly id: string;
  /** 来自哪一段聊天记忆（编号）；那一段删了，这件事跟着删。 */
  readonly from: string;
  readonly what: string;
  readonly said: string;
  /** 从这个时间起可以问起（毫秒，本机换算出来的）。 */
  readonly dueAt: number;
  /** 过了这个时间还没问到，就悄悄过期。 */
  readonly expiresAt: number;
  readonly state: UpcomingState;
  /** 记下的时间。 */
  readonly createdAt: number;
  /** 状态最后一次变化的时间（问过、过期的事从这里起算，几天后清掉）。 */
  readonly changedAt: number;
}

/** 存在文件里的样子：清单加上"删过事的那些段"（它们的笔记不再往清单里加）。 */
export interface UpcomingStored {
  readonly items: readonly UpcomingItem[];
  readonly blockedFrom: readonly string[];
}

/** 笔记里抓出来的一件事（已经按旋钮收过、换算过到时间）。 */
export interface UpcomingCandidate {
  readonly what: string;
  readonly said: string;
  readonly dueAt: number;
}

/** 画像面板看到的一行：是什么事、大概哪天、现在什么状态。 */
export interface UpcomingShown {
  readonly id: string;
  readonly what: string;
  readonly said: string;
  readonly dueAt: number;
  readonly state: UpcomingState;
}

/**
 * 一个角色的清单。所有写操作只在"允许记录"开着、画像就绪时生效，否则什么都不做并返回 0／false。
 * 实现不能抛给调用方（笔记本和面板都不该因为它出错）；返回的数是真正改动的件数。
 */
export interface UpcomingBook {
  /** 一段笔记里抓到的几件事（`scope`：那一段自己的角色的范围编号，不写就是现在显示的角色）。这一段删过事（blockedFrom）、清单满了、同一件事已经在了，就不加。返回加了几件。 */
  add(input: { from: string; items: readonly UpcomingCandidate[]; scope?: string }): Promise<number>;
  /** 现在看到的（过期的算过期，太久的已经不在了）。 */
  list(): readonly UpcomingShown[];
  /** 你删一件：它来自的那一段，以后的笔记不再往里加。 */
  remove(id: string): Promise<boolean>;
  /** 你清空：这些事来自的段都不再往里加。返回清掉几件。 */
  clear(): Promise<number>;
  /** 这些聊天记忆（或它们的笔记）删了：来自它们的事跟着删，"删过事的段"里它们也去掉。返回删了几件。 */
  dropSegments(ids: readonly string[]): Promise<number>;
  /** 只留这些段还在的：别的段来的事删掉。返回删了几件。 */
  keepSegments(ids: ReadonlySet<string>): Promise<number>;
  /** 到时间的、过了几天的、问过很久的：该过期的过期，该清的清。返回新过期几件。 */
  settle(): Promise<number>;
  /** 开发者命令用：把最早那件还等着的事挪到"现在已经到时间"。返回有没有。 */
  makeDue(): Promise<boolean>;
  /** 第 2、3 步：现在到时间了、还没问也没过期的事，最早的在前（只读，不改状态）。 */
  due(): readonly UpcomingShown[];
  /** 第 2、3 步：这些等着的事问过了／用户自己说了。只改还在"等着"的；返回改了几件。 */
  mark(ids: readonly string[], to: 'asked' | 'user-said'): Promise<number>;
}
