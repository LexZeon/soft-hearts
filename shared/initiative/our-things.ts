/**
 * I-086 我们的小东西（双向）：你喂过她的点心（名字、她当时那句话、一张小图），她递给你的点心、靠垫，和她留给你的图，按日子排着。
 * 要求：攒东西可以是双向的（喂过的点心也攒进一个文件夹），图也可以存，不大。
 *
 * 纯的部分：一条记录长什么样、怎么校验、怎么有上限地加、怎么删、写进"她的文件夹"的那份小文本。存储在
 * electron/initiative/give/store.ts（按角色存在配置目录里，原子写入；不混进她的记忆、日记或画像文件）。
 */
import { visibleLength } from './inner-loop'; // direct: this file is inside the initiative part (moved from shared/memory/, wiring rewrite step 1)

/** I-087: 'first-hold' — the first time you held hands (kept only while 「允许记录」 is on; dir 'gave', no picture, no words). */
export const OUR_THING_KINDS = ['snack', 'cushion', 'picture', 'first-hold'] as const;
export type OurThingKind = (typeof OUR_THING_KINDS)[number];
/** fed：你喂她的；gave：她给你的。 */
export type OurThingDirection = 'fed' | 'gave';

export interface OurThing {
  readonly id: string;
  readonly at: number;
  readonly dir: OurThingDirection;
  readonly kind: OurThingKind;
  /** 点心的名字（你喂的那块由认图得来；她递的是你喂过的那张时也带上）；没有就是空。 */
  readonly name: string;
  /** 她当时那句话（她自己说的，已经显示过的）；没有就是空。 */
  readonly line: string;
  /** 存着的小图文件（store 目录里的文件名，只有字母数字），和它的字节数。 */
  readonly file?: string;
  readonly bytes?: number;
  /** 她递给你的：你接了没有。 */
  readonly taken?: boolean;
  /** 你喂她的：她爱吃（认图说"爱吃"）。 */
  readonly loved?: boolean;
}

export const OUR_THINGS_MAX = 300;
export const OUR_THING_NAME_MAX = 12;
export const OUR_THING_LINE_MAX = 60;
/** 一张喂食小图（最长边 256 的 JPEG）最多这么大。 */
export const OUR_THING_THUMB_MAX_BYTES = 64 * 1024;
/** 她的一张图（PNG）最多这么大。 */
export const OUR_THING_PICTURE_MAX_BYTES = 400 * 1024;
/** 一个角色所有图加起来最多这么大：超出时从最旧的有图记录开始连图一起删。 */
export const OUR_THINGS_FILES_MAX_BYTES = 16 * 1024 * 1024;
/** 小图在主机和窗口之间的边长。 */
export const OUR_THING_THUMB_EDGE = 256;

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const FILE = /^[A-Za-z0-9_-]{1,64}\.(?:jpg|png)$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>]/gu;

export const isOurThingId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
export const isOurThingFile = (value: unknown): value is string => typeof value === 'string' && FILE.test(value);

function clip(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  const clean = text.replace(CONTROL, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join('') : clean;
}

/** One stored record, checked field by field; anything else → null. */
export function readOurThing(value: unknown): OurThing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isOurThingId(v.id) || !Number.isSafeInteger(v.at) || (v.at as number) < 0 || (v.dir !== 'fed' && v.dir !== 'gave')
    || !(OUR_THING_KINDS as readonly unknown[]).includes(v.kind)) return null;
  if (v.dir === 'fed' && v.kind !== 'snack') return null;
  const name = clip(v.name, OUR_THING_NAME_MAX), line = clip(v.line, OUR_THING_LINE_MAX);
  if (visibleLength(name) > OUR_THING_NAME_MAX) return null;
  const out: { -readonly [K in keyof OurThing]: OurThing[K] } = { id: v.id, at: v.at as number, dir: v.dir, kind: v.kind as OurThingKind, name, line };
  if (v.file !== undefined) {
    const max = v.kind === 'picture' ? OUR_THING_PICTURE_MAX_BYTES : OUR_THING_THUMB_MAX_BYTES;
    if (!isOurThingFile(v.file) || !Number.isSafeInteger(v.bytes) || (v.bytes as number) < 1 || (v.bytes as number) > max) return null;
    out.file = v.file; out.bytes = v.bytes as number;
  }
  if (v.dir === 'gave' && typeof v.taken === 'boolean') out.taken = v.taken;
  if (v.dir === 'fed' && v.loved === true) out.loved = true;
  return out;
}

/** A new record from what the host has (texts are cleaned and clipped here). */
export function ourThing(input: { id: string; at: number; dir: OurThingDirection; kind: OurThingKind; name?: string; line?: string; file?: string; bytes?: number;
  taken?: boolean; loved?: boolean }): OurThing | null {
  return readOurThing({ id: input.id, at: Math.floor(input.at), dir: input.dir, kind: input.kind, name: input.name ?? '', line: input.line ?? '',
    ...(input.file !== undefined ? { file: input.file, bytes: input.bytes } : {}),
    ...(input.taken !== undefined ? { taken: input.taken } : {}), ...(input.loved ? { loved: true } : {}) });
}

/**
 * Adds one record (newest last) within the bounds: at most OUR_THINGS_MAX records, and the files together at most
 * OUR_THINGS_FILES_MAX_BYTES (the oldest records that carry a file go first, with their file). Returns the new list and the
 * records that were dropped (the store deletes their files). A record with an id already there replaces nothing (ignored).
 */
export function addOurThing(list: readonly OurThing[], thing: OurThing, limits = { max: OUR_THINGS_MAX, bytes: OUR_THINGS_FILES_MAX_BYTES }): { list: OurThing[]; dropped: OurThing[] } {
  if (list.some(item => item.id === thing.id)) return { list: [...list], dropped: [] };
  const next = [...list, thing].sort((a, b) => a.at - b.at);
  const dropped: OurThing[] = [];
  while (next.length > limits.max) dropped.push(next.shift()!);
  let total = next.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  for (let i = 0; total > limits.bytes && i < next.length;) {
    if (next[i].file && next[i] !== thing) { total -= next[i].bytes ?? 0; dropped.push(next.splice(i, 1)[0]); } else i++;
  }
  return { list: next, dropped };
}

/** Removes one record by id (the store deletes its file). */
export function removeOurThing(list: readonly OurThing[], id: unknown): { list: OurThing[]; removed: OurThing | null } {
  const removed = list.find(item => item.id === id) ?? null;
  return { list: removed ? list.filter(item => item !== removed) : [...list], removed };
}

/** Marks her offer taken / not taken (only her own 'gave' records). */
export function markOurThing(list: readonly OurThing[], id: string, taken: boolean): OurThing[] {
  return list.map(item => item.id === id && item.dir === 'gave' ? { ...item, taken } : item);
}

/** What the control page shows (no file names, no paths; a picture is fetched by id). */
export interface OurThingView {
  readonly id: string; readonly at: number; readonly dir: OurThingDirection; readonly kind: OurThingKind;
  readonly name: string; readonly line: string; readonly picture: boolean; readonly taken?: boolean;
}
export interface OurThingsView { readonly characterId: string; readonly items: readonly OurThingView[] }

export function ourThingView(item: OurThing): OurThingView {
  return { id: item.id, at: item.at, dir: item.dir, kind: item.kind, name: item.name, line: item.line, picture: !!item.file,
    ...(item.taken !== undefined ? { taken: item.taken } : {}) };
}

const TEXT = {
  'zh-CN': { title: '我们的小东西', fed: '你喂我的', gave: '我给你的', snack: '点心', cushion: '靠垫', picture: '一张图', 'first-hold': '我们第一次牵手', taken: '你接住了', missed: '你没顾上接',
    note: '（这份是应用替我记的；图存在应用里，可以在"我们的小东西"那页另存。）' },
  en: { title: 'Our little things', fed: 'You fed me', gave: 'I gave you', snack: 'a snack', cushion: 'the cushion', picture: 'a picture', 'first-hold': 'The first time we held hands', taken: 'you took it', missed: 'you were busy',
    note: '(The app keeps this list for me; the pictures stay in the app and can be saved from the "Our little things" page.)' },
} as const;

/** The small text file in her folder (when it is on): the same list by date, words only (no picture, no path). */
export function ourThingsText(list: readonly OurThing[], language: 'zh-CN' | 'en' = 'zh-CN'): string {
  const t = TEXT[language] ?? TEXT['zh-CN'];
  const day = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const lines = [`# ${t.title}`, ''];
  let current = '';
  for (const item of [...list].sort((a, b) => a.at - b.at)) {
    const date = day(item.at);
    if (date !== current) { if (current) lines.push(''); lines.push(`## ${date}`); current = date; }
    const what = item.kind === 'snack' ? (item.name ? `${t.snack}（${item.name}）` : t.snack) : t[item.kind];
    const parts = [item.kind === 'first-hold' ? `- ${what}` : `- ${item.dir === 'fed' ? t.fed : t.gave}：${what}`];
    if (item.dir === 'gave' && item.taken !== undefined && item.kind !== 'first-hold') parts.push(item.taken ? t.taken : t.missed);
    if (item.line) parts.push(`"${item.line}"`);
    lines.push(parts.join(language === 'en' ? ' — ' : ' · '));
  }
  lines.push('', t.note, '');
  return lines.join('\n');
}
