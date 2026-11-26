// I-144b 单条删除也先进回收站: every single deletion of her
// memories or the user's data in its own panel, and every clear, becomes one bin entry first. For each kind:
//  - a take (`take*`): copies what the deletion is about to remove (the thing, its place, the marks the deletion adds or takes away) and
//    names it (kind, count, a label of what and when, never its content). Nothing changes; the host writes the entry, then deletes as before.
//  - a restore (ITEM_RESTORERS): puts it back where it was. What was put there meanwhile (a new nickname, songs learned since, a new assistant
//    conversation, match counts since) is kept in a new entry first ("找回时换下来的"), so nothing is lost.
// The restorers are typed from electron/foundation/data-map.ts (`recycleItems`): a kind no row names, or a named kind without a restore,
// does not compile. No Electron import: tests drive it with real stores in a temporary folder.
import type { MemoryScope } from '../../../shared/memory/memory';
import type { RecycleItemRowKind } from '../../foundation/data-map';
import type { RecycleItemKind } from '../../../shared/foundation/recycle-bin';
import { RECYCLE_ASSISTANT_OWNER } from '../../../shared/foundation/recycle-bin';
import type { KeywordRecord } from '../../../shared/memory/memory-keywords/keyword-index';
import type { MemoryRecordPart } from '../memory';
import type { MemoryNotesPart } from '../memory-notes/core';
import type { ProfileDiaryPart, ProfileEntryPart } from '../user-profile';
import { userProfileScopeId } from '../user-profile';
import type { UpcomingPart } from '../upcoming/store';
import type { ReviewPart } from '../period-review/store';
import type { NicknamePart } from '../relationship/host';
import type { TextMemorialPart } from '../text-memorial-store';
import type { RecycleSummaryView } from '../memory-recycle-bin';
import type { ListedPart } from '../../foundation/keyed-part';
import type { AmbientItemPart } from '../../senses/ambient-audio-store';
import type { ListenSegment } from '../../../shared/senses/listen-together';
import type { ListenNotePart } from '../../senses/listen-together/core';
import type { OurThingPart } from '../../initiative/give/store';
import { captureFiles, filesPort, type CapturedFiles } from './ports';
import type { RecycleStores } from '../recycle-wiring';
import { ASSISTANT_NAME } from '../../../shared/foundation/assistant-name';

/** What a take hands the host: the entry's names and the data kept in it. */
export interface ItemTake {
  kind: RecycleItemKind;
  characterId: string;
  count: number;
  /** What and when, never the content (Chinese; the agent channel shows it, the windows word their own line). */
  label: string;
  itemAt?: number;
  data: { kind: RecycleItemKind } & Record<string, unknown>;
}

/** Around a restore: the live stores, and a way to keep what is replaced in a new entry. */
export interface ItemContext {
  stores: RecycleStores;
  keep(take: ItemTake): Promise<RecycleSummaryView>;
}
export type ItemRestore = (summary: RecycleSummaryView, data: Record<string, unknown>, context: ItemContext) => Promise<RecycleSummaryView | null>;

const day = (ms: number) => { const date = new Date(ms); return `${date.getMonth() + 1}月${date.getDate()}日`; };
const dateMs = (key: string) => { const ms = new Date(`${key}T00:00:00`).getTime(); return Number.isFinite(ms) && ms >= 0 ? ms : undefined; };
const bad = () => new Error('回收站里这一项的数据不完整，原文件已保留。');
const notReady = (what: string) => new Error(`${what}还没准备好，回收站里还留着，稍后再试。`);
const scopeOf = (summary: RecycleSummaryView, data: Record<string, unknown>): MemoryScope => {
  if (typeof data.providerScope !== 'string' || !data.providerScope) throw bad();
  return { characterId: summary.characterId, providerScope: data.providerScope };
};
const movingRel = (scope: MemoryScope) => `user-profiles/moving-memory-${userProfileScopeId(scope)}.json`;

// ---- takes ----

/** One chat record (记忆页「删除这段记录」, or a copy of an ambient comment) and what its deletion changes beside it. */
export interface ChatRecordData {
  journal: 'conversation' | 'text-invitations';
  providerScope: string;
  record: MemoryRecordPart;
  notes: MemoryNotesPart | null;
  keyword: KeywordRecord | null;
  marks: ListedPart<string> | null;
  plans: UpcomingPart | null;
  moving: CapturedFiles | null;
  ambient: AmbientItemPart | null;
  /** 边说边演: what describes the turns of this record (older entries have none). */
  speechBeats?: unknown | null;
}

const turnIdsOf = (record: unknown): string[] => { const messages = (record as { messages?: { turnId?: unknown }[] } | null)?.messages; return Array.isArray(messages) ? messages.flatMap(message => typeof message?.turnId === 'string' ? [message.turnId] : []) : []; };

export async function chatRecordData(s: RecycleStores, scope: MemoryScope, id: string, journal: 'conversation' | 'text-invitations' = 'conversation'): Promise<ChatRecordData | null> {
  const store = journal === 'text-invitations' ? s.textInvitations : s.memory;
  if (!store) return null;
  const record = await store.recordCopy(scope, id);
  if (!record) return null;
  if (journal === 'text-invitations') return { journal, providerScope: scope.providerScope, record, notes: null, keyword: null, marks: null, plans: null, moving: null, ambient: null };
  const value = record.record.value as { origin?: { id?: unknown; sources?: unknown } };
  const ambientId = Array.isArray(value.origin?.sources) && value.origin.sources.includes('ambient') && typeof value.origin.id === 'string' ? value.origin.id : null;
  return {
    journal, providerScope: scope.providerScope, record,
    notes: s.notes?.recycleCopy([id]) ?? null,
    keyword: await s.keywords?.entry(scope.characterId, id).catch(() => null) ?? null,
    marks: s.upcoming?.marks.recycleCopy([id]) ?? null,
    plans: await s.upcomingStore?.itemsCopy?.(userProfileScopeId(scope), { from: id }).catch(() => null) ?? null,
    moving: await captureFiles(s.profileDirectory, [movingRel(scope)]),
    ambient: ambientId && s.ambient ? await s.ambient.commentCopy(scope, ambientId).catch(() => null) : null,
    speechBeats: s.speechBeats?.copyTurns(scope, turnIdsOf(record.record.value)) ?? null,
  };
}

export async function takeChatRecord(s: RecycleStores, scope: MemoryScope, id: string, journal: 'conversation' | 'text-invitations'): Promise<ItemTake | null> {
  const data = await chatRecordData(s, scope, id, journal);
  if (!data) return null;
  const createdAt = (data.record.record.value as { createdAt?: number }).createdAt ?? 0;
  return { kind: 'chat-record', characterId: scope.characterId, count: 1, label: `${day(createdAt)}那段聊天`, itemAt: createdAt, data: { kind: 'chat-record', ...data } };
}

/** One heard-sound transcript, its comments, and the chat records copied from those comments (deleted with it). */
export async function takeAmbientTranscript(s: RecycleStores, scope: MemoryScope, id: string, chatRecordIds: readonly string[]): Promise<ItemTake | null> {
  const part = s.ambient ? await s.ambient.transcriptCopy(scope, id) : null;
  if (!part) return null;
  const chats: ChatRecordData[] = [];
  for (const recordId of chatRecordIds) { const data = await chatRecordData(s, scope, recordId); if (data) chats.push(data); }
  const startedAt = ((part.records?.items[0]?.value ?? (part.reading as { records?: ListedPart<{ startedAt?: number }> } | undefined)?.records?.items[0]?.value) as { startedAt?: number } | undefined)?.startedAt;
  return { kind: 'ambient-transcript', characterId: scope.characterId, count: 1, label: `${typeof startedAt === 'number' ? day(startedAt) : ''}听到的一段声音文字`,
    ...(typeof startedAt === 'number' ? { itemAt: startedAt } : {}), data: { kind: 'ambient-transcript', providerScope: scope.providerScope, part, chats } };
}

/** 「清空原文」: every raw segment kept now (filed under the character on stage; each segment keeps its own character). */
export function takeListenRaw(s: RecycleStores, characterId: string): ItemTake | null {
  const part = s.listen?.rawCopy() ?? null;
  if (!part) return null;
  return { kind: 'listen-raw', characterId, count: part.items.length, label: `一起听攒着的原文 ${part.items.length} 段`, data: { kind: 'listen-raw', part } };
}

/** 「清除她记得的歌」 (and the agent channel's clear_song_memory): her file, byte for byte. */
export async function takeSongs(s: RecycleStores, characterId: string): Promise<ItemTake | null> {
  const copy = s.songs ? await s.songs.songsCopy(characterId) : null;
  if (!copy) return null;
  return { kind: 'song-memory', characterId, count: copy.count, label: `她记得的歌 ${copy.count} 首`, data: { kind: 'song-memory', file: copy.file } };
}

export function takeProfileEntry(s: RecycleStores, scope: MemoryScope, id: unknown): ItemTake | null {
  const part = s.profiles?.entryCopy(id) ?? null;
  if (!part || part.scopeId !== userProfileScopeId(scope)) return null;
  return { kind: 'profile-entry', characterId: scope.characterId, count: 1, label: '她记下的关于你的一条', itemAt: part.entry.value.createdAt,
    data: { kind: 'profile-entry', providerScope: scope.providerScope, part } };
}

/** One diary day, or the whole diary (`'*'`, which also takes her match counts and what she was fed: clearing the diary clears those, data map diaryCleared). */
export function takeDiary(s: RecycleStores, scope: MemoryScope, date: unknown): ItemTake | null {
  const part = s.profiles?.diaryCopy(date) ?? null;
  if (!part || part.scopeId !== userProfileScopeId(scope)) return null;
  if (part.kind === 'diary-day') {
    const key = part.entries[0]!.value.date;
    return { kind: 'diary-day', characterId: scope.characterId, count: 1, label: `${key}的日记`, ...(dateMs(key) !== undefined ? { itemAt: dateMs(key) } : {}),
      data: { kind: 'diary-day', providerScope: scope.providerScope, part } };
  }
  const rps = s.rps?.recycleCopy(scope.characterId) ?? null, feeding = s.feeding?.recycleCopy(scope.characterId) ?? null;
  if (!part.entries.length && !rps && !feeding) return null;
  return { kind: 'diary-all', characterId: scope.characterId, count: part.entries.length, label: `全部日记 ${part.entries.length} 天`,
    data: { kind: 'diary-all', providerScope: scope.providerScope, part, rps, feeding } };
}

export async function takeReview(s: RecycleStores, scope: MemoryScope, kind: unknown, key: unknown): Promise<ItemTake | null> {
  if ((kind !== 'week' && kind !== 'month') || typeof key !== 'string' || !s.reviews) return null;
  const part = await s.reviews.reviewCopy?.(userProfileScopeId(scope), kind, key).catch(() => null);
  if (!part) return null;
  const itemAt = dateMs(kind === 'week' ? key : `${key}-01`);
  return { kind: 'review', characterId: scope.characterId, count: 1, label: kind === 'week' ? `${key}那周的回顾` : `${key}的月回顾`, ...(itemAt !== undefined ? { itemAt } : {}),
    data: { kind: 'review', providerScope: scope.providerScope, part } };
}

/** One plan (`id`), or every plan (`'*'`). */
export async function takePlans(s: RecycleStores, scope: MemoryScope, id: unknown): Promise<ItemTake | null> {
  if (!s.upcomingStore || (id !== '*' && typeof id !== 'string')) return null;
  const part = await s.upcomingStore.itemsCopy?.(userProfileScopeId(scope), id === '*' ? { all: true } : { id: id as string }).catch(() => null);
  if (!part || !part.items.length) return null;
  if (id === '*') return { kind: 'plans-all', characterId: scope.characterId, count: part.items.length, label: `她记得的全部计划 ${part.items.length} 件`,
    data: { kind: 'plans-all', providerScope: scope.providerScope, part } };
  const createdAt = (part.items[0]!.value as { createdAt?: number }).createdAt;
  return { kind: 'plan', characterId: scope.characterId, count: 1, label: '她记得的一件计划', ...(typeof createdAt === 'number' ? { itemAt: createdAt } : {}),
    data: { kind: 'plan', providerScope: scope.providerScope, part } };
}

export async function takeNickname(s: RecycleStores, characterId: string): Promise<ItemTake | null> {
  const part = s.relationship?.nicknameCopy ? await s.relationship.nicknameCopy(characterId) : null;
  return part ? { kind: 'nickname', characterId, count: 1, label: '她叫你的称呼', data: { kind: 'nickname', part } } : null;
}

/** Unbound v1 step 3: one name the user calls her, removed from the nickname table. */
export function takeHerNickname(s: RecycleStores, characterId: string, name: unknown): ItemTake | null {
  const list = s.relationship?.herNicknames ? s.relationship.herNicknames(characterId) : [];
  const at = typeof name === 'string' ? list.findIndex(item => item.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase()) : -1;
  return at >= 0 ? { kind: 'her-nickname', characterId, count: 1, label: '你对她的一个称呼', data: { kind: 'her-nickname', name: list[at], at } } : null;
}

/** I-207: the card's milestone cleared by the user (the page confirmed); what the bin keeps is the date it had (a closed value, no words of anyone). */
export async function takeCardMilestone(s: RecycleStores, characterId: string): Promise<ItemTake | null> {
  const date = s.relationship?.ensureCardMilestone ? await s.relationship.ensureCardMilestone(characterId) : null;
  return date ? { kind: 'card-milestone', characterId, count: 1, label: '角色卡里那件事的“到了”', data: { kind: 'card-milestone', date } } : null;
}

/** I-208 step 3: one of her margin notes deleted on the archive page (the page confirmed). The bin keeps the note as it was (its words, page and date: hers, in her own file). */
export async function takeObjectNote(s: RecycleStores, characterId: string, id: string): Promise<ItemTake | null> {
  const note = s.relationship?.objectNotes ? (await s.relationship.objectNotes(characterId)).find(item => item.id === id) : undefined;
  return note ? { kind: 'object-note', characterId, count: 1, label: '她写在页边的一条批注', itemAt: Date.parse(note.date + 'T12:00:00') || 0, data: { kind: 'object-note', note } } : null;
}

export function takeTextMemorial(s: RecycleStores, id: unknown): ItemTake | null {
  const copy = s.textMemorials?.entryCopy(id) ?? null;
  if (!copy) return null;
  return { kind: 'text-memorial', characterId: copy.scope.characterId, count: 1, label: '一条文字纪念', itemAt: copy.part.entry.value.createdAt,
    data: { kind: 'text-memorial', providerScope: copy.scope.providerScope, part: copy.part } };
}

export async function takeOurThing(s: RecycleStores, characterId: string, id: unknown): Promise<ItemTake | null> {
  const part = s.ourThings ? await s.ourThings.thingCopy(characterId, id) : null;
  return part ? { kind: 'our-thing', characterId, count: 1, label: '我们的小东西里的一件', itemAt: part.item.value.at, data: { kind: 'our-thing', part } } : null;
}

export async function takeAssistantChat(s: RecycleStores): Promise<ItemTake | null> {
  const messages = s.assistant ? await s.assistant.historyCopy() : [];
  return messages.length ? { kind: 'assistant-chat', characterId: RECYCLE_ASSISTANT_OWNER, count: messages.length, label: `和 ${ASSISTANT_NAME} 助手的对话 ${messages.length} 条`,
    data: { kind: 'assistant-chat', messages } } : null;
}

// ---- restores ----

async function restoreChatRecord(characterId: string, data: ChatRecordData, s: RecycleStores): Promise<void> {
  if (!data || (data.journal !== 'conversation' && data.journal !== 'text-invitations') || typeof data.providerScope !== 'string') throw bad();
  const scope = { characterId, providerScope: data.providerScope };
  const store = data.journal === 'text-invitations' ? s.textInvitations : s.memory;
  if (!store) throw notReady('聊天记忆');
  if (data.ambient) { if (!s.ambient) throw notReady('听到的声音文字'); await s.ambient.restoreItem(scope, data.ambient); }
  await store.recordRestore(scope, data.record);
  if (data.journal !== 'conversation') return;
  if (data.notes) { if (!s.notes) throw notReady('聊天小记'); await s.notes.recycleRestore(data.notes); }
  if (data.keyword) await s.keywords?.restoreEntry(characterId, data.keyword).catch(() => false);
  if (data.marks) await s.upcoming?.marks.recycleRestore(data.marks);
  // Plans come back only while 「允许记录」 is on (off, there are no plans at all); she notes them again from the chat otherwise.
  if (data.plans && data.plans.items.length + data.plans.removed.length) await s.upcomingStore?.restoreItems?.(data.plans).catch(() => 0);
  if (data.moving) await restoreMovingIfUnchanged(s, scope, data.moving);
  if (data.speechBeats) await s.speechBeats?.restore(scope, data.speechBeats).catch(() => undefined); // only the grey lines and markers of her long window: a failure never blocks the record
}

/**
 * The moving memory dropped when the record it quoted was deleted comes back, but only when nothing new was chosen since (every version
 * there now was there before, and no new handoff ran): then its file is written back byte for byte.
 */
async function restoreMovingIfUnchanged(s: RecycleStores, scope: MemoryScope, before: CapturedFiles): Promise<void> {
  const rel = movingRel(scope), was = before.files?.[rel];
  if (typeof was !== 'string') return;
  const now = await captureFiles(s.profileDirectory, [rel]);
  const parse = (base64: string | undefined) => { try { return base64 ? JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as { versions?: { chosenAt?: number }[]; lastHandoffDay?: string } : null; } catch { return null; } };
  const old = parse(was), current = parse(now?.files[rel]);
  if (!old || now?.files[rel] === was) return;
  const known = new Set((old.versions ?? []).map(version => version.chosenAt));
  if (current && ((current.versions ?? []).some(version => !known.has(version.chosenAt)) || current.lastHandoffDay !== old.lastHandoffDay)) return;

  await filesPort<'scope', MemoryScope>('scope', { root: () => s.profileDirectory, rels: target => [movingRel(target)],
    remove: async target => { await s.movingMemory?.store.reload(target); }, reloaded: target => s.movingMemory?.store.reload(target) }).restore(scope, before);
}

/** I-144 / I-144b: how each single deletion comes back. Typed from the data map's rows (a kind without a restore does not compile). */
export const ITEM_RESTORERS: { readonly [K in RecycleItemRowKind]: ItemRestore } = {
  'memory-note': async (summary, data, { stores: s }) => {
    if (!s.notes || typeof data.providerScope !== 'string') throw new Error('聊天笔记还没准备好，稍后再试。');
    const back = await s.notes.restoreNote(data.part as MemoryNotesPart, { characterId: summary.characterId, providerScope: data.providerScope });
    if (!back) throw new Error('那段聊天已经不在了，这条笔记放不回去。');
    if (data.keyword) await s.keywords?.restoreEntry(summary.characterId, data.keyword as KeywordRecord).catch(() => false);
    return null;
  },
  'moving-memory': async (summary, data, { stores: s }) => {
    const moving = s.movingMemory;
    if (!moving || typeof data.providerScope !== 'string' || typeof data.chosenAt !== 'number') throw new Error('现在还不能找回这一件，稍后再试。');
    if (!await moving.store.restore({ characterId: summary.characterId, providerScope: data.providerScope }, data.chosenAt)) throw new Error('那一件已经不在了（它引用的聊天可能删掉了）。');
    return null;
  },
  'listen-note': async (summary, data, { stores: s }) => {
    if (!s.listen) throw new Error('一起听还没准备好，稍后再试。');
    if (!s.listen.restoreNote(summary.characterId, data.part as ListenNotePart)) throw new Error('这条笔记已经在了。');
    await s.listen.core.flush();
    if (data.keyword) await s.keywords?.restoreEntry(summary.characterId, data.keyword as KeywordRecord).catch(() => false);
    return null;
  },
  'chat-record': async (summary, data, { stores: s }) => { await restoreChatRecord(summary.characterId, data as unknown as ChatRecordData, s); return null; },
  'ambient-transcript': async (summary, data, { stores: s }) => {
    const scope = scopeOf(summary, data);
    if (!s.ambient) throw notReady('听到的声音文字');
    if (!Array.isArray(data.chats)) throw bad();
    await s.ambient.restoreItem(scope, data.part as AmbientItemPart);
    for (const chat of data.chats as ChatRecordData[]) await restoreChatRecord(summary.characterId, chat, s);
    return null;
  },
  'listen-raw': async (_summary, data, { stores: s }) => {
    if (!s.listen) throw notReady('一起听');
    s.listen.restoreRaw(data.part as ListedPart<ListenSegment>);
    await s.listen.core.flush();
    return null;
  },
  'song-memory': async (summary, data, context) => {
    const songs = context.stores.songs;
    if (!songs) throw notReady('她记得的歌');
    if (typeof data.file !== 'string') throw bad();
    const replaced = await songs.restoreSongs(summary.characterId, data.file);
    return replaced ? context.keep({ kind: 'song-memory', characterId: summary.characterId, count: 0, label: '找回时换下来的歌', data: { kind: 'song-memory', file: replaced } }) : null;
  },
  'profile-entry': async (summary, data, { stores: s }) => {
    if (!s.profiles) throw notReady('用户画像');
    await s.profiles.restorePart(scopeOf(summary, data), data.part as ProfileEntryPart);
    return null;
  },
  'diary-day': async (summary, data, { stores: s }) => {
    if (!s.profiles) throw notReady('日记');
    await s.profiles.restorePart(scopeOf(summary, data), data.part as ProfileDiaryPart);
    return null;
  },
  'diary-all': async (summary, data, context) => {
    const s = context.stores;
    if (!s.profiles) throw notReady('日记');
    const scope = scopeOf(summary, data);
    // Her match counts and what she was fed since the diary was cleared go into a new entry first, then the old ones come back.
    const rpsNow = data.rps ? s.rps?.recycleCopy(summary.characterId) ?? null : null, feedingNow = data.feeding ? s.feeding?.recycleCopy(summary.characterId) ?? null : null;
    let replaced: RecycleSummaryView | null = null;
    if (rpsNow || feedingNow) replaced = await context.keep({ kind: 'diary-all', characterId: summary.characterId, count: 0, label: '找回时换下来的猜拳和喂食记录',
      data: { kind: 'diary-all', providerScope: scope.providerScope, part: { kind: 'diary-all', scopeId: userProfileScopeId(scope), entries: [], attempts: [], marks: [] }, rps: rpsNow, feeding: feedingNow } });
    await s.profiles.restorePart(scope, data.part as ProfileDiaryPart);
    if (data.rps) { if (!s.rps) throw notReady('猜拳记录'); s.rps.recycleRestore(summary.characterId, data.rps as never); await s.rps.flush(); }
    if (data.feeding) { if (!s.feeding) throw notReady('喂食记录'); s.feeding.recycleRestore(summary.characterId, data.feeding as never); await s.feeding.flush(); }
    return replaced;
  },
  review: async (_summary, data, { stores: s }) => {
    if (!s.reviews?.restoreReview) throw notReady('回顾');
    await s.reviews.restoreReview(data.part as ReviewPart);
    return null;
  },
  plan: async (_summary, data, { stores: s }) => {
    if (!s.upcomingStore?.restoreItems) throw notReady('她记得的计划');
    await s.upcomingStore.restoreItems(data.part as UpcomingPart);
    return null;
  },
  'plans-all': async (_summary, data, { stores: s }) => {
    if (!s.upcomingStore?.restoreItems) throw notReady('她记得的计划');
    await s.upcomingStore.restoreItems(data.part as UpcomingPart);
    return null;
  },
  nickname: async (summary, data, context) => {
    const relationship = context.stores.relationship;
    if (!relationship?.restoreNickname) throw notReady('称呼');
    const replaced = await relationship.restoreNickname(summary.characterId, data.part as NicknamePart);
    return replaced ? context.keep({ kind: 'nickname', characterId: summary.characterId, count: 1, label: '找回时换下来的称呼',
      data: { kind: 'nickname', part: { nickname: replaced, nicknameAsked: true } } }) : null;
  },
  'her-nickname': async (summary, data, { stores: s }) => {
    if (!s.relationship?.restoreHerNickname) throw notReady('称呼表');
    if (typeof data.name !== 'string') throw bad();
    await s.relationship.restoreHerNickname(summary.characterId, data.name, data.at);
    return null;
  },
  'card-milestone': async (summary, data, context) => {
    const relationship = context.stores.relationship;
    if (!relationship?.restoreCardMilestone) throw notReady('里程碑');
    const replaced = await relationship.restoreCardMilestone(summary.characterId, data.date);
    return replaced ? context.keep({ kind: 'card-milestone', characterId: summary.characterId, count: 1, label: '找回时换下来的里程碑', data: { kind: 'card-milestone', date: replaced } }) : null;
  },
  'object-note': async (summary, data, { stores: s }) => {
    if (!s.relationship?.restoreObjectNote) throw notReady('页边批注');
    await s.relationship.restoreObjectNote(summary.characterId, data.note);
    return null;
  },
  'text-memorial': async (summary, data, { stores: s }) => {
    if (!s.textMemorials) throw notReady('文字纪念');
    await s.textMemorials.restoreEntry(scopeOf(summary, data), data.part as TextMemorialPart);
    return null;
  },
  'our-thing': async (summary, data, { stores: s }) => {
    if (!s.ourThings) throw notReady('我们的小东西');
    await s.ourThings.restoreThing(summary.characterId, data.part as OurThingPart);
    return null;
  },
  'assistant-chat': async (_summary, data, context) => {
    const assistant = context.stores.assistant;
    if (!assistant) throw notReady(`${ASSISTANT_NAME} 助手`);
    if (!Array.isArray(data.messages)) throw bad();
    const replaced = await assistant.restoreHistory(data.messages);
    return replaced.length ? context.keep({ kind: 'assistant-chat', characterId: RECYCLE_ASSISTANT_OWNER, count: replaced.length, label: `找回时换下来的助手对话 ${replaced.length} 条`,
      data: { kind: 'assistant-chat', messages: replaced } }) : null;
  },
};

/** The kinds whose restore goes through ITEM_RESTORERS (every single deletion). */
export const isItemKind = (kind: string): kind is RecycleItemRowKind => Object.hasOwn(ITEM_RESTORERS, kind);
