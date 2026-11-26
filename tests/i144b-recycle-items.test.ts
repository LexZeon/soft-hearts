// I-144b 单条删除也先进回收站 (docs/claude/2026-11-16-i144-recycle-bin.md 「I-144b 做完」): every single deletion of her memories or the user's
// data in its own panel, and every clear, goes into the recycle bin first and comes back exactly. For each kind, on real stores in a temporary
// folder, the way main.ts wires it (RecycleHost.recycled around the store's own deletion, then RecycleHost.restore):
//  - the deletion removes the thing, and the bin holds one entry whose label says what and when, never the content;
//  - finding it back makes the touched files byte for byte what they were (profile and text-memorial files: all but the revision, which only
//    moves on; the chat journal: a fresh read, as in I-144; the v2 audio sidecar: absent before = written with every list empty after);
//  - mutation: with that kind's restore replaced by a no-op, the same round trip is caught (ITEM_RESTORERS, all kinds, one by one).
// Plus: the agent channel lists and finds back the new kinds and still has no delete for good; replaced things are kept in a new entry.
// Made-up data in temporary folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRecycleHost, songsThroughBin, type RecycleHost } from '../electron/memory/recycle-wiring';
import {
  ITEM_RESTORERS, takeAmbientTranscript, takeAssistantChat, takeCardMilestone, takeObjectNote, takeChatRecord, takeDiary, takeHerNickname, takeListenRaw, takeNickname, takeOurThing, takePlans,
  takeProfileEntry, takeReview, takeTextMemorial, type ItemRestore,
} from '../electron/memory/recycle/items-wiring';
import { characterKey } from '../electron/memory/memory-keywords/store';
import { relationshipFileName } from '../electron/memory/relationship/store';
import { profileTextFingerprint, userProfileScopeId } from '../electron/memory/user-profile';
import { TextMemorialStore } from '../electron/memory/text-memorial-store';
import { AssistantStore } from '../electron/safety/assistant/store';
import { AssistantService } from '../electron/safety/assistant/service';
import { createMemoryBridge } from '../electron/safety/agent-channel/memory-bridge';
import type { AudioReadingArchive } from '../electron/voice/audio-reading-archive';
import { RECYCLE_ITEM_KINDS, type RecycleEntryKind, type RecycleItemKind } from '../shared/foundation/recycle-bin';
import { withDirectory, world, type World } from './helpers/i144-world';

const CONTENT = ['科幻电影', '拉面', '星砂书店', '听到的一句歌词', '安静的钢琴', '饼干', '阿青', '我喜欢吃拉面', '周末去爬山', '这周过得', '今天的一句', '你好助手', '歌词', ' 的日记'];

function hostFor(w: World): RecycleHost {
  return createRecycleHost({ bin: w.stores.bin, stores: () => w.stores, currentScope: () => w.scope(w.kept),
    characterName: id => id === w.doomed ? '阿澄' : '小桃', providerScopes: id => w.ports().providerScopes(id), cardExists: id => w.ports().cardExists(id),
    restoreMemoryPart: () => Promise.reject(new Error('not in this test')),
    change: (_kind: RecycleEntryKind | 'delete-character', _id: string, run: () => Promise<never>) => run() });
}

type Files = Map<string, Buffer | null>;
async function files(directory: string, rels: readonly string[]): Promise<Files> {
  const out: Files = new Map();
  for (const rel of rels) { try { out.set(rel, await readFile(path.join(directory, ...rel.split('/')))); } catch { out.set(rel, null); } }
  return out;
}
const REVISION = /^(user-profiles\/profile-|text-memorials\/text-memorial-)/;
/** The touched files that are not as they were (see the header for the three documented exceptions). */
function changed(before: Files, after: Files): string[] {
  const out: string[] = [];
  for (const [rel, a] of before) {
    const b = after.get(rel) ?? null;
    if (rel === 'audio-reading-v2.json' && !a && b) {
      const value = JSON.parse(b.toString('utf8')) as Record<string, unknown>;
      if (Object.values(value).every(item => !Array.isArray(item) || item.length === 0)) continue;
    }
    if (!a || !b) { if (a !== b) out.push(rel); continue; }
    if (REVISION.test(rel)) {
      const strip = (bytes: Buffer) => { const value = JSON.parse(bytes.toString('utf8')); delete value.revision; return value; };
      try { assert.deepEqual(strip(b), strip(a)); } catch { out.push(rel); }
    } else if (!a.equals(b)) out.push(rel);
  }
  return out.sort();
}

interface Case {
  kind: RecycleItemKind;
  /** Adds what the fixture lacks; returns the files this deletion touches. */
  prepare(w: World, host: RecycleHost): Promise<string[]>;
  /** The deletion, the way main.ts wires it. */
  remove(w: World, host: RecycleHost): Promise<unknown>;
  /** The chat journals are compared through a fresh read. */
  journals?: boolean;
  owner?(w: World): string;
}

const sid = (w: World) => userProfileScopeId(w.scope(w.kept));
const profileRel = (w: World) => `user-profiles/profile-${sid(w)}.json`;
const profileRevision = (w: World) => w.stores.profiles!.view().revision;

const CASES: Case[] = [
  {
    kind: 'memory-note',
    prepare: async w => ['memory-notes.json', `memory-keywords/${characterKey(w.kept)}.json`],
    remove: async (w, host) => host.deleteMemoryNote(w.stores.memory.recordIds(w.scope(w.kept))[0]!),
  },
  {
    kind: 'moving-memory',
    prepare: async w => [`user-profiles/moving-memory-${sid(w)}.json`],
    remove: async (w, host) => host.deleteMovingMemory(w.scope(w.kept), w.stores.movingMemory!.store.current(w.scope(w.kept))!.chosenAt),
  },
  {
    kind: 'listen-note',
    prepare: async () => ['listen-together.json'],
    remove: async (_w, host) => host.deleteListenNote('ln-s1'),
  },
  {
    kind: 'chat-record', journals: true,
    prepare: async w => ['memory-notes.json', `memory-keywords/${characterKey(w.kept)}.json`, 'user-profiles/upcoming-marks.json', `user-profiles/moving-memory-${sid(w)}.json`],
    remove: async (w, host) => {
      const scope = w.scope(w.kept), id = w.stores.memory.recordIds(scope)[0]!;
      assert.equal(w.stores.notes!.state(id).status, 'written', 'fixture: the record has a note');
      return host.recycled(() => takeChatRecord(w.stores, scope, id, 'conversation'), () => w.stores.memory.delete(scope, id), deleted => deleted);
    },
  },
  {
    kind: 'ambient-transcript', journals: true,
    prepare: async w => {
      const scope = w.scope(w.kept);
      await (w.stores.ambient as unknown as AudioReadingArchive).appendComment(scope, { id: 'cm-1', sessionId: 'session', recordIds: [`t-${w.kept}`], text: '这段歌词让我想起夏天', createdAt: 2_500 });
      await w.stores.memory.appendInitiative(scope, { id: 'cm-1', text: '这段歌词让我想起夏天', at: 2_500,
        origin: { kind: 'proactive', id: 'cm-1', at: 2_500, sources: ['ambient'], labels: ['外部音频资料'] } });
      return ['system-audio-transcripts.json', 'audio-reading-v2.json'];
    },
    remove: async (w, host) => {
      const scope = w.scope(w.kept), id = `t-${w.kept}`, ambient = w.stores.ambient as unknown as AudioReadingArchive;
      const copies = ambient.comments(scope, id).flatMap(comment => { const handle = w.stores.memory.findInitiative(scope, comment.id); return handle ? [handle.recordId] : []; });
      assert.equal(copies.length, 1, 'fixture: the comment has its chat copy');
      return host.recycled(() => takeAmbientTranscript(w.stores, scope, id, copies), async () => {
        for (const recordId of copies) await w.stores.memory.delete(scope, recordId);
        return ambient.delete(scope, id);
      }, result => result.deleted);
    },
  },
  {
    kind: 'listen-raw',
    prepare: async () => ['listen-together.json'],
    remove: async (w, host) => host.recycled(() => takeListenRaw(w.stores, w.kept), () => w.stores.listen!.clearRaw()),
  },
  {
    kind: 'song-memory',
    prepare: async w => {
      const print = { bpm: 96, bands: [0.5, 0.3, 0.2], bright: 0.4, pluck: 0.6, dens: 2.5, sec: [12, 40], id: '0a1b2c3d', plays: 3, last: 20_000 };
      await writeFile(path.join(w.directory, `song-memory-${w.kept}.json`), JSON.stringify({ version: 1, songs: [print] }));
      await w.stores.songs!.reload(w.kept);
      return [`song-memory-${w.kept}.json`];
    },
    remove: async w => songsThroughBin(() => hostFor(w), () => w.stores, () => w.kept).clear(),
  },
  {
    kind: 'profile-entry',
    prepare: async w => {
      const file = path.join(w.directory, ...profileRel(w).split('/'));
      const stored = JSON.parse(await readFile(file, 'utf8'));
      const quote = '我喜欢吃拉面';
      stored.entries = [{ id: 'e1', kind: 'fact', text: quote, manual: false, source: { requestId: 'r1', messageId: 'm1', quote }, createdAt: 5, updatedAt: 5,
        key: profileTextFingerprint(quote), fingerprint: profileTextFingerprint(quote) }];
      await writeFile(file, JSON.stringify(stored) + '\n');
      w.stores.profiles!.deactivate(); await w.stores.profiles!.activate(w.scope(w.kept));
      return [profileRel(w)];
    },
    remove: async (w, host) => host.recycled(() => takeProfileEntry(w.stores, w.scope(w.kept), 'e1'), () => w.stores.profiles!.deleteEntry('e1', profileRevision(w))),
  },
  {
    kind: 'diary-day',
    prepare: async w => [profileRel(w)],
    remove: async (w, host) => host.recycled(() => takeDiary(w.stores, w.scope(w.kept), '2026-11-14'), () => w.stores.profiles!.deleteDiary('2026-11-14', profileRevision(w))),
  },
  {
    kind: 'diary-all',
    prepare: async w => [profileRel(w), 'rps.json', 'feed-recognition.json'],
    remove: async (w, host) => host.recycled(() => takeDiary(w.stores, w.scope(w.kept), '*'), async () => {
      const view = await w.stores.profiles!.clearDiary(profileRevision(w));
      w.stores.rps!.forget(w.kept); w.stores.feeding!.forget(w.kept); // UserProfileManagement's 'diary-cleared' (data map diaryCleared)
      await w.stores.rps!.flush(); await w.stores.feeding!.flush();
      return view;
    }),
  },
  {
    kind: 'review',
    prepare: async w => {
      const reviews = w.stores.reviews as unknown as { load(id: string): Promise<void>; change(id: string, run: (state: object) => object, by: 'user'): Promise<boolean> };
      await writeFile(path.join(w.directory, 'user-profiles', `review-${sid(w)}.json`), JSON.stringify({ version: 1, scopeId: sid(w), data: {
        items: [{ kind: 'week', key: '2026-11-09', text: '这周过得很充实', words: ['充实'], writtenAt: 7 }], blocked: ['month:2026-09'], tries: [{ id: 'week:2026-11-09', count: 1 }], opening: null } }) + '\n');
      await reviews.load(sid(w));
      assert.equal(await reviews.change(sid(w), state => ({ ...state }), 'user'), true, 'fixture: written as the store writes it');
      return [`user-profiles/review-${sid(w)}.json`];
    },
    remove: async (w, host) => host.recycled(() => takeReview(w.stores, w.scope(w.kept), 'week', '2026-11-09'),
      () => (w.stores.reviews as unknown as { remove(id: string, kind: 'week', key: string): Promise<boolean> }).remove(sid(w), 'week', '2026-11-09'), ok => ok),
  },
  {
    kind: 'plan',
    prepare: async w => { await addPlans(w); return [`user-profiles/upcoming-${sid(w)}.json`]; },
    remove: async (w, host) => host.recycled(() => takePlans(w.stores, w.scope(w.kept), 'p1'), () => upcoming(w).remove(sid(w), 'p1'), ok => ok),
  },
  {
    kind: 'plans-all',
    prepare: async w => { await addPlans(w); return [`user-profiles/upcoming-${sid(w)}.json`]; },
    remove: async (w, host) => host.recycled(() => takePlans(w.stores, w.scope(w.kept), '*'), () => upcoming(w).clear(sid(w)), count => count > 0),
  },
  {
    kind: 'nickname',
    prepare: async w => { await (w.stores.relationship as unknown as { flush?(): Promise<void> }).flush?.(); return [`relationship/${relationshipFileName(w.kept)}`]; },
    remove: async (w, host) => host.recycled(() => takeNickname(w.stores, w.kept), async () => {
      const value = await (w.stores.relationship as unknown as { setNickname(id: string, value: null): Promise<unknown> }).setNickname(w.kept, null);
      await (w.stores.relationship as unknown as { flush?(): Promise<void> }).flush?.(); return value;
    }),
  },
  {
    kind: 'her-nickname', // Unbound v1 step 3: one name you call her, from the middle of the table
    prepare: async w => { const r = w.stores.relationship as unknown as { noteHerNickname(id: string, name: string): Promise<unknown>; flush?(): Promise<void> };
      for (const name of ['小青', '青青', '阿青']) await r.noteHerNickname(w.kept, name); await r.flush?.(); return [`relationship/${relationshipFileName(w.kept)}`]; },
    remove: async (w, host) => host.recycled(() => takeHerNickname(w.stores, w.kept, '青青'), async () => {
      const value = await (w.stores.relationship as unknown as { removeHerNickname(id: string, name: string): Promise<unknown> }).removeHerNickname(w.kept, '青青');
      await (w.stores.relationship as unknown as { flush?(): Promise<void> }).flush?.(); return value;
    }),
  },
  {
    kind: 'card-milestone', // I-207: the card's milestone reached, then cleared by the user
    prepare: async w => { const r = w.stores.relationship as unknown as { reachCardMilestone(id: string): Promise<unknown>; flush?(): Promise<void> };
      await r.reachCardMilestone(w.kept); await r.flush?.(); return [`relationship/${relationshipFileName(w.kept)}`]; },
    remove: async (w, host) => host.recycled(() => takeCardMilestone(w.stores, w.kept), async () => {
      const value = await (w.stores.relationship as unknown as { clearCardMilestone(id: string): Promise<unknown> }).clearCardMilestone(w.kept);
      await (w.stores.relationship as unknown as { flush?(): Promise<void> }).flush?.(); return value;
    }),
  },
  {
    kind: 'object-note', // I-208 step 3: one of her margin notes deleted on the archive page
    prepare: async w => { const r = w.stores.relationship as unknown as { addObjectNotes(id: string, markers: string[]): Promise<unknown>; flush?(): Promise<void> };
      await r.addObjectNotes(w.kept, ['note|12|搭档说灯会灭']); await r.flush?.(); return [`relationship/${relationshipFileName(w.kept)}`]; },
    remove: async (w, host) => {
      const relationship = w.stores.relationship as unknown as { objectNotes(id: string): Promise<{ id: string }[]>; removeObjectNote(id: string, note: string): Promise<unknown>; flush?(): Promise<void> };
      const id = (await relationship.objectNotes(w.kept))[0]!.id;
      return host.recycled(() => takeObjectNote(w.stores, w.kept, id), async () => { const value = await relationship.removeObjectNote(w.kept, id); await relationship.flush?.(); return value; });
    },
  },
  {
    kind: 'text-memorial',
    prepare: async w => {
      const store = new TextMemorialStore(path.join(w.directory, 'text-memorials')), scope = w.scope(w.kept);
      await store.activate(scope);
      assert.ok(await store.saveConfirmed({ eventKey: 'a'.repeat(64), invitationId: 'i1', requestId: 'r1', messageId: 'm1', consentMessageId: 'c1',
        text: '今天的一句', purpose: '纪念', confirmedAt: 9 }, () => true));
      memorials.set(w, store);
      w.stores.textMemorials = { entryCopy: (id: unknown) => { const part = store.entryCopy(id); return part ? { scope, part } : null; }, restoreEntry: (target: Parameters<TextMemorialStore['restoreEntry']>[0], part: Parameters<TextMemorialStore['restoreEntry']>[1]) => store.restoreEntry(target, part) } as never;
      const key = store.view()!.scopeId;
      return [`text-memorials/text-memorial-${key}.json`];
    },
    remove: async (w, host) => {
      const store = memorials.get(w)!, view = store.view()!, id = view.entries[0]!.id;
      return host.recycled(() => takeTextMemorial(w.stores, id), () => store.delete({ scopeId: view.scopeId, generation: view.generation, revision: view.revision, id }));
    },
  },
  {
    kind: 'our-thing',
    prepare: async w => {
      await w.stores.ourThings!.load(w.kept);
      assert.equal(await w.stores.ourThings!.setLedger(w.kept, w.stores.ourThings!.ledger(w.kept)!), true, 'fixture: written as the store writes it');
      return [`our-things/${w.kept}.json`, `our-things/${w.kept}/a1.jpg`];
    },
    remove: async (w, host) => host.recycled(() => takeOurThing(w.stores, w.kept, 'a1'), () => w.stores.ourThings!.remove(w.kept, 'a1'), ok => ok),
  },
  {
    kind: 'assistant-chat', owner: () => 'claude-assistant',
    prepare: async w => {
      const store = new AssistantStore(w.directory);
      await store.saveHistory([{ id: 'u1', role: 'user', at: 1, parts: [{ kind: 'text', text: '你好助手' }] }, { id: 'a1', role: 'assistant', at: 2, parts: [{ kind: 'text', text: '你好，我在。' }], status: 'done' }]);
      const service = new AssistantService({ registry: () => ({ revoke() {} }) as never, store, shim: { command: process.execPath, args: [] }, emit: () => {}, undo: async () => {} });
      assistants.set(w, service);
      w.stores.assistant = service;
      return ['assistant/history.json'];
    },
    remove: async (w, host) => { const service = assistants.get(w)!; return host.recycled(() => takeAssistantChat(w.stores), () => service.clear()); },
  },
];
const memorials = new WeakMap<World, TextMemorialStore>();
const assistants = new WeakMap<World, AssistantService>();
const upcoming = (w: World) => w.stores.profiles!.companionStores().upcoming as unknown as { remove(id: string, item: string): Promise<boolean>; clear(id: string): Promise<number> };
async function addPlans(w: World): Promise<void> {
  const store = w.stores.profiles!.companionStores().upcoming as unknown as { load(id: string): Promise<void>; change(id: string, run: (state: object) => object): Promise<boolean> };
  const item = (id: string, from: string) => ({ id, from, what: '周末去爬山', said: '周末想去爬山', dueAt: 9e12, expiresAt: 9.1e12, state: 'waiting', createdAt: 11, changedAt: 11 });
  await writeFile(path.join(w.directory, 'user-profiles', `upcoming-${sid(w)}.json`), JSON.stringify({ version: 1, scopeId: sid(w),
    upcoming: { items: [item('p1', 'seg-1'), item('p2', 'seg-2')], blockedFrom: ['seg-0'] } }) + '\n');
  await store.load(sid(w));
  assert.equal(await store.change(sid(w), state => ({ ...state })), true, 'fixture: plans written as the store writes them');
}

/** One round trip; `mutate`: that kind's restore is a no-op. Returns what is not back as it was. */
async function roundTrip(directory: string, c: Case, mutate = false): Promise<{ notBack: string[]; journalsBack: boolean; label: string; deletedSomething: boolean }> {
  const w = await world(directory);
  const original = ITEM_RESTORERS[c.kind];
  try {
    w.stores.upcomingStore = w.stores.profiles!.companionStores().upcoming as never;
    w.stores.reviews = w.stores.profiles!.companionStores().reviews as never;
    const host = hostFor(w);
    const rels = await c.prepare(w, host);
    await w.flush();
    const before = await files(directory, rels), journalsBefore = c.journals ? await w.journals() : null;
    const owner = c.owner?.(w) ?? w.kept;
    const already = new Set(w.stores.bin.summaries(owner).map(entry => entry.id));
    await c.remove(w, host);
    await w.flush();
    const afterDelete = await files(directory, rels), journalsGone = c.journals ? JSON.stringify(await w.journals()) !== JSON.stringify(journalsBefore) : false;
    const entries = w.stores.bin.summaries(owner).filter(entry => !already.has(entry.id));
    assert.equal(entries.length, 1, `${c.kind}: one entry`);
    const [entry] = entries;
    assert.equal(entry!.part, c.kind);
    if (mutate) (ITEM_RESTORERS as Record<string, ItemRestore>)[c.kind] = async () => null;
    await host.restore(entry!.id);
    await w.flush();
    assert.equal(w.stores.bin.summaries(owner).some(item => item.id === entry!.id), false, `${c.kind}: the entry left the bin`);
    const after = await files(directory, rels);
    return { notBack: changed(before, after), journalsBack: c.journals ? JSON.stringify(await w.journals()) === JSON.stringify(journalsBefore) : true,
      label: entry!.label, deletedSomething: changed(before, afterDelete).length > 0 || journalsGone };
  } finally {
    (ITEM_RESTORERS as Record<string, ItemRestore>)[c.kind] = original;
    await assistants.get(w)?.dispose().catch(() => {});
    await w.dispose();
  }
}

test('I-144b · every single-deletion kind has a round trip here', () => {
  assert.deepEqual(CASES.map(c => c.kind).sort(), [...RECYCLE_ITEM_KINDS].sort());
});

for (const c of CASES) {
  test(`I-144b · ${c.kind}: into the bin (a label without content), then back exactly; with its restore a no-op the round trip is caught`, async () => {
    const real = await withDirectory(directory => roundTrip(directory, c));
    assert.equal(real.deletedSomething, true, `${c.kind}: the deletion removed something`);
    assert.deepEqual(real.notBack, [], `${c.kind}: files not back as they were`);
    assert.equal(real.journalsBack, true, `${c.kind}: the chat journals read as before`);
    for (const word of CONTENT) assert.equal(real.label.includes(word), false, `${c.kind}: the label "${real.label}" carries content`);
    const mutated = await withDirectory(directory => roundTrip(directory, c, true));
    assert.ok(mutated.notBack.length > 0 || !mutated.journalsBack, `${c.kind}: a no-op restore must be caught`);
  });
}

test('I-144b · something put there since is kept: a new nickname goes into its own entry when the old one is found back', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w), relationship = w.stores.relationship as unknown as { setNickname(id: string, value: string | null): Promise<string | null>; nickname(id: string): string | null };
    await host.recycled(() => takeNickname(w.stores, w.kept), () => relationship.setNickname(w.kept, null));
    await relationship.setNickname(w.kept, '小青');
    const [entry] = w.stores.bin.summaries(w.kept).filter(item => item.part === 'nickname');
    const outcome = await host.restore(entry!.id);
    assert.equal(relationship.nickname(w.kept), '阿青');
    assert.ok(outcome.replaced, 'the newer one was kept');
    const [kept] = w.stores.bin.summaries(w.kept).filter(item => item.part === 'nickname');
    assert.equal(kept?.label, '找回时换下来的称呼');
    await host.restore(kept!.id);
    assert.equal(relationship.nickname(w.kept), '小青', 'and it comes back too');
  } finally { await w.dispose(); }
}));

test('I-144b · the agent channel lists the new kinds and finds them back; it still has no delete for good', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w);
    await host.recycled(() => takeOurThing(w.stores, w.kept, 'a1'), () => w.stores.ourThings!.remove(w.kept, 'a1'));
    const bridge = createMemoryBridge(w.stores.bin, { providerScopes: () => [], chat: () => w.stores.memory, profiles: () => null, restoreOther: id => host.restore(id),
      change: (_c, _p, _m, _g, run) => run() });
    const listed = bridge.list().find(item => item.part === 'our-thing');
    assert.ok(listed);
    assert.deepEqual(Object.keys(listed).filter(key => !['id', 'characterId', 'characterName', 'part', 'count', 'label', 'deletedAt', 'expiresAt', 'itemAt'].includes(key)), []);
    assert.equal('deleteForGood' in bridge, false);
    await bridge.restore(listed.id, () => {});
    assert.equal(w.stores.ourThings!.list(w.kept).some(item => item.id === 'a1'), true);
  } finally { await w.dispose(); }
}));

test('I-144b · the bin not ready: nothing is deleted', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w);
    await w.stores.ourThings!.load(w.kept);
    Object.defineProperty(w.stores.bin, 'ready', { get: () => false, configurable: true });
    await assert.rejects(host.recycled(() => takeOurThing(w.stores, w.kept, 'a1'), () => w.stores.ourThings!.remove(w.kept, 'a1')), /回收站还没准备好/);
    assert.equal(w.stores.ourThings!.list(w.kept).some(item => item.id === 'a1'), true);
  } finally { await w.dispose(); }
}));

test('I-144b · a deletion that fails takes its entry out again; one that removed nothing leaves no entry', async () => withDirectory(async directory => {
  const w = await world(directory);
  try {
    const host = hostFor(w), before = w.stores.bin.summaries().length;
    await assert.rejects(host.recycled(() => takeOurThing(w.stores, w.kept, 'a1'), async () => { throw new Error('disk full'); }), /disk full/);
    assert.equal(w.stores.bin.summaries().length, before);
    await host.recycled(() => takeOurThing(w.stores, w.kept, 'a1'), async () => false, ok => ok);
    assert.equal(w.stores.bin.summaries().length, before);
  } finally { await w.dispose(); }
}));
