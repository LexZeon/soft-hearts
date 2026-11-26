/**
 * 边说边演的拍子文件描述的是她的回复，所以它跟着聊天记录走（的隐私规矩：删掉的回复，什么都不留）。
 * 聊天记录管理（MemoryStore）删一段记录、或忘掉一个角色和连接的全部记录时，告诉这里被删的轮次编号，这里把那些轮次的拍子和灰色小字一起删掉。
 * 进回收站和找回走数据地图的行 'speech-beats'（electron/memory/recycle-wiring.ts 的登记）、单条聊天记录的回收站条目、Claude 删除记忆的条目；
 * 这里只管"删"这一半，而且只有这一处接线，测试和接线用的是同一个函数。
 */
import type { SpeechBeatArchive } from './archive';

/** The chat store's removal hook (MemoryStore.onTurnsRemoved), as much of it as is needed here. */
export interface TurnsRemovedSource {
  onTurnsRemoved(listener: ((scopeKey: string, turnIds: readonly string[]) => void) | null): void;
}

/** From now on a chat record's deletion drops the beats of its turns (the archive's own scope key is the chat store's). */
export function followChatDeletions(memory: TurnsRemovedSource, archive: Pick<SpeechBeatArchive, 'removeTurns'>): void {
  memory.onTurnsRemoved((scopeKey, turnIds) => { void archive.removeTurns(scopeKey, turnIds).catch(() => undefined); });
}
