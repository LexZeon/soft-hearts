// 她的文件夹 (I-050, docs/claude/2026-11-08-i050-her-folder.md): a folder the user gives her. Her chat stays tool-free; on a turn
// about the folder she may add one nonce-protected "put a file" block after her reply, and the host checks it and writes it.
// This module is the shared vocabulary only: limits, the plain views the windows get, and the cheap "is this message about her
// folder" test. Nothing here touches the disk.

/** Each file she writes (after an append too): at most 200 KB of UTF-8. */
export const HER_FOLDER_FILE_MAX_BYTES = 200 * 1024;
/** Everything she has there (her files plus the copies kept because of her changes): at most 20 MB. */
export const HER_FOLDER_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
/** Her own earlier versions and whatever she moved to her recycle bin are kept this long, then removed. */
export const HER_FOLDER_KEEP_DAYS = 30;
export const HER_FOLDER_KEEP_MS = HER_FOLDER_KEEP_DAYS * 86_400_000;
/** Hidden subfolders the host makes inside her folder. */
export const HER_FOLDER_VERSIONS_DIR = '.她的旧版本';
export const HER_FOLDER_TRASH_DIR = '.她的回收站';
/** A file name (with its extension) is at most this many characters. */
export const HER_FOLDER_NAME_MAX = 80;
/** Only text. */
export const HER_FOLDER_EXTENSIONS = ['.md', '.txt'] as const;
/** The control page lists at most this many recent actions. */
export const HER_FOLDER_RECENT = 50;

export const HER_FOLDER_ACTIONS = ['created', 'changed', 'appended', 'trashed', 'restored'] as const;
export type HerFolderActionKind = (typeof HER_FOLDER_ACTIONS)[number];

/** Why a block wrote nothing (journal and tests; never shown as her words). */
export const HER_FOLDER_REFUSALS = ['off', 'stale', 'malformed', 'name', 'extension', 'size', 'total', 'link', 'outside', 'missing', 'not-file', 'moved', 'failed'] as const;
export type HerFolderRefusal = (typeof HER_FOLDER_REFUSALS)[number];

/** One thing that happened in her folder, for the control page (names and sizes only, never content). */
export interface HerFolderActionView {
  id: string;
  at: number;
  kind: HerFolderActionKind;
  name: string;
  /** Size of the file after the action (for 'trashed': the size of what was moved). */
  bytes: number;
  /** The file was the user's (not one she wrote), so its original was kept before she changed it. */
  userFile: boolean;
  /** What the user can bring back from this action: the version from before it, or the file from her recycle bin. */
  restore: 'version' | 'trash' | null;
}

export interface HerFolderView {
  enabled: boolean;
  /** The chosen folder, shown like the Claude task folder; null before one was chosen. */
  folder: string | null;
  actions: HerFolderActionView[];
  usedBytes: number;
  limitBytes: number;
}

/** Host → the window that owns her reply: a small note under it ("已放进她的文件夹：…" with a button), or its removal. */
export interface HerFolderNoteView {
  kind: 'her-folder-note';
  version: 1;
  noteId: string;
  action: HerFolderActionKind;
  name: string;
  state: 'open' | 'gone';
}

export const isHerFolderActionKind = (value: unknown): value is HerFolderActionKind =>
  typeof value === 'string' && (HER_FOLDER_ACTIONS as readonly string[]).includes(value);

// Words that make a message "about her folder": the folder itself, a text file, or asking her to write, keep or record something.
// A miss only means she answers in words this turn; a false hit only costs this turn's extra lines.
const FOLDER_WORDS = new RegExp([
  '文件夹', '文件', '\\.(?:md|txt)\\b',
  '写(?:一|封|首|篇|份|段|个|点|下|给)', '(?:帮我|给我|替我)[^，。！？\\n]{0,6}(?:写|记|存|留|放)',
  '记(?:一下|下来|在|着)', '存(?:起来|下来|一下|着|进)', '留(?:着|下来|给我|一份)', '收(?:着|好)', '放(?:进|到|在)', '放着',
  '礼物', '封信', '写信', '情书', '日记', '笔记', '清单', '备忘',
  '\\b(?:folder|file|write (?:me|it|this|down|a)|keep (?:it|this|a)|note (?:it|this) down|save (?:it|this))\\b',
].join('|'), 'iu');

/** Cheap gate: does this message plausibly concern her folder (only read while the folder is on)? */
export function mentionsHerFolder(text: unknown): boolean {
  return typeof text === 'string' && FOLDER_WORDS.test(text.slice(0, 4000));
}

// I-056: narrower than FOLDER_WORDS, read only while the folder has never been turned on: the user asks her to write or keep
// something for them, or asks about her folder. A plain "文件" or "放在桌上" is not enough; a false hit only spends one of her
// few chances to mention it (she still decides whether it fits).
const KEEP_WORDS = new RegExp([
  '(?:你|她)的(?:小)?文件夹', '给(?:你|她)[^，。！？\\n]{0,6}文件夹',
  '写(?:一|封|首|篇|份|段)', '(?:帮我|给我|替我)[^，。！？\\n]{0,6}(?:写|记|存|留)',
  '存(?:起来|下来)', '留(?:下来|给我|一份)', '收(?:着|好)',
  '礼物', '封信', '写信', '情书', '清单', '备忘',
].join('|'), 'u');

/** I-056: does this message ask her to write or keep something (or ask about her folder)? */
export function asksHerToKeepSomething(text: unknown): boolean {
  return typeof text === 'string' && KEEP_WORDS.test(text.slice(0, 4000));
}
