// I-056: while her folder has never been turned on, a message
// asking her to write or keep something (shared/initiative/her-folder.ts asksHerToKeepSomething) adds one line to that turn's private
// context, so she may mention the folder once in her own words. Only when her reply really mentions it does the host add the
// 「带我去：她的文件夹」 button and count it as done. Per character; at most HER_FOLDER_HINT_MAX turns get the line, so a topic she
// judged unrelated does not keep coming back. No model call of its own, nothing written to the folder, the switch is not touched.

/** How many turns may carry the line, per character (her one mention ends it earlier). */
export const HER_FOLDER_HINT_MAX = 3;

/** The line for her private context on such a turn (data for her, not shown). */
export const HER_FOLDER_HINT_LINE = '（这一轮可选）用户还没打开「她的文件夹」：在设置里打开、选一个文件夹给你以后，你就能把写的东西（信、清单、小礼物这类文字）放进去替用户留着。'
  + '如果和用户这句话有关，可以用你自己的口气顺口提一句，比如有个文件夹你就能替他收着；只提一次，别催，别说已经保存了，也别解释怎么设置。和这句话无关就不提。';

export interface HerFolderMention { hints: number; done: boolean }
export type HerFolderMentions = Record<string, HerFolderMention>;

const MAX_CHARACTERS = 50;

/** The saved record read back: anything malformed is dropped (an empty record means she may still mention it). */
export function readMentions(raw: unknown): HerFolderMentions {
  const out: HerFolderMentions = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_CHARACTERS)) {
    if (!id || id.length > 100 || !value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const hints = typeof item.hints === 'number' && Number.isInteger(item.hints) ? Math.max(0, Math.min(HER_FOLDER_HINT_MAX, item.hints)) : 0;
    out[id] = { hints, done: item.done === true };
  }
  return out;
}

/** May this character's turn carry the line? */
export const mayHint = (mention: HerFolderMention | undefined): boolean =>
  !mention || (!mention.done && mention.hints < HER_FOLDER_HINT_MAX);

/** Did her reply mention the folder (what makes the button appear and ends the hints)? */
export const mentionedInReply = (reply: unknown): boolean => typeof reply === 'string' && /文件夹/u.test(reply);
