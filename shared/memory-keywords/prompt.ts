// I-049 step 2: the line a note writer's system prompt gets so its one JSON answer carries an optional `keywords` field. Kept apart
// from keyword.ts so the note prompts (shared/memory-notes/note.ts, shared/listen-note.ts) can import it without a cycle.

import { KEYWORD_KINDS } from './knobs';

export const KEYWORDS_FIELD_PROMPT = `另外多给一个 keywords 字段（数组，最多 8 个）：方便以后找到这一段的词，每个是 {"term":"词本身","kind":"${KEYWORD_KINDS.join('|')}","weight":0 到 1 的数（越像"这一段讲的就是它"越高）,"aliases":["同一个东西的其他叫法，可以空"]}。种类：作品名 work、人物 person、地点 place、事件 event、物品 object、话题 topic、打算 plan。term 或某个别名必须是原文里真的出现的词；不放"日常""聊天""心情"这种空泛的词；不确定就少写，可以是空数组。`;
