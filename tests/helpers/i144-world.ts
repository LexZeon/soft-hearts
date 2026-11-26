// I-144 回收站: the two-character world the recycle-bin tests share (tests/i144-recycle-bin.test.ts, tests/i144-recycle-host.test.ts): something in every
// store the bin keeps, real stores in a temporary folder; and the byte comparison of the kept rows' files. Made-up data only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../../electron/cards/character-cards';
import { CharacterResponseService, CharacterResponseStore } from '../../electron/cards/character-response';
import { characterProviderScopes, forgettableProviderScopes } from '../../electron/cards/character-forget';
import { CompanionService, memoryProviderScope } from '../../electron/brain/companion';
import { SpeechBeatArchive } from '../../electron/brain/speech-beats/archive';
import { followChatDeletions } from '../../electron/brain/speech-beats/follow-chat';
import { DATA_MAP, recycleIds, type RecycleId } from '../../electron/foundation/data-map';
import { RpsStore } from '../../electron/initiative/rps/store';
import { KeepsakeHost } from '../../electron/initiative/her-folder/keepsake';
import { HandsStore } from '../../electron/initiative/hands/store';
import { OurThingsStore } from '../../electron/initiative/give/store';
import { HerNoteStore } from '../../electron/memory/her-note/store';
import { characterKey } from '../../electron/memory/memory-keywords/store';
import { MemoryStore } from '../../electron/memory/memory';
import { MemoryNotes } from '../../electron/memory/memory-notes/host';
import { MemoryRecycleBin } from '../../electron/memory/memory-recycle-bin';
import { MovingMemoryStore } from '../../electron/memory/moving-memory/store';
import { ReviewStore } from '../../electron/memory/period-review/store';
import { recycleRegistry, type RecycleStores } from '../../electron/memory/recycle-wiring';
import { recycleCharacter, restoreCharacterEntry, restoreOrder, CARD_ROWS, type CharacterRecyclePorts } from '../../electron/memory/recycle/character';
import type { RecycleRegistry } from '../../electron/memory/recycle/ports';
import { SpecialDayHost } from '../../electron/memory/special-day/host';
import { UpcomingMarks } from '../../electron/memory/upcoming/marks';
import { UpcomingStore } from '../../electron/memory/upcoming/store';
import { UserProfileStore, userProfileScopeId } from '../../electron/memory/user-profile';
import { FeedRecognitionStore } from '../../electron/senses/feed-recognition/store';
import { ListenTogether } from '../../electron/senses/listen-together/host';
import { SongMemoryHost } from '../../electron/senses/song-memory';
import { WatchTogether } from '../../electron/senses/watch-notes/wiring';
import { AudioReadingArchive } from '../../electron/voice/audio-reading-archive';
import { validateProvider } from '../../electron/settings/validation';
import { CHARACTER_RESPONSE_MOODS, defaultCharacterResponseRule, type CharacterResponseProfile } from '../../shared/cards/character-response';
import { defaultCharacterMoodTemplate } from '../../shared/cards/character-cards';
import type { MemoryScope } from '../../shared/memory/memory';
import { MEMORY_NOTES_KNOBS } from '../../shared/memory/memory-notes/knobs';
import { FakeNoteWriter, fakeNoteBody } from '../../shared/memory/memory-notes/fake';
import { dayStamp } from '../../shared/memory/special-day';


export const provider = validateProvider({ kind: 'claude', baseUrl: '', model: 'sonnet' });
export const providerScope = memoryProviderScope(provider);
export const HOUR = 3_600_000;
export const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
export const reactions = (scale: number): CharacterResponseProfile => {
  const rule = defaultCharacterResponseRule({ mood: CHARACTER_RESPONSE_MOODS[0] });
  rule.intensityScale.expression = scale;
  return { version: 1, rules: [rule] };
};

export async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i144-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

/** Every file under the profile, relative ('/'), with its bytes. */
export async function snapshot(directory: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
    const full = path.join(entry.parentPath, entry.name);
    out.set(path.relative(directory, full).split(path.sep).join('/'), await readFile(full));
  }
  return out;
}

/** The files of the rows the bin keeps (their path patterns in the data map). */
export const KEPT_PATTERNS = DATA_MAP.filter(row => row.recycle === 'take').flatMap(row => row.paths.map(pattern => ({ row: row.id, regex: new RegExp(`^${pattern.split('/').map(part =>
  part === '**' ? '.*' : part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('/')}$`) })));
export const rowOf = (rel: string) => KEPT_PATTERNS.find(pattern => pattern.regex.test(rel))?.row ?? null;
/** Rewritten whole by their own stores (compaction; a revision counter): compared by content. */
export const BY_CONTENT = new Set(['memories.jsonl', 'text-invitations.jsonl', 'characters.json', 'character-response-settings.json']);

export interface World {
  directory: string; doomed: string; kept: string; doomedName: string; scope(id: string): MemoryScope;
  speechBeats: SpeechBeatArchive; stores: RecycleStores; ports(registry?: RecycleRegistry): CharacterRecyclePorts; flush(): Promise<void>; dispose(): Promise<void>;
  journals(): Promise<unknown>;
}

export async function world(directory: string): Promise<World> {
  const profilesDir = path.join(directory, 'user-profiles');
  const cards = new CharacterCardStore(directory, 'legacy');
  await cards.load({});
  const draft = (name: string) => ({ name, description: `${name}的介绍`, personality: '温柔', scenario: '', greeting: '你好', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() });
  await cards.save(draft('小桃')); await cards.save(draft('阿澄')); await cards.save(draft('小葵'));
  const byName = (name: string) => cards.publicState().cards.find(card => card.name === name)!.id;
  const doomed = byName('阿澄'), kept = byName('小桃');
  await cards.bindModel(doomed, path.join(directory, 'models', 'acheng.pmx'), 'acheng.pmx');
  await cards.activate(kept);
  const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id)); await responses.load();
  await responses.save(kept, reactions(1.2)); await responses.save(doomed, reactions(1.4)); await responses.save(byName('小葵'), reactions(1.6));
  const cardService = new CharacterResponseService(cards, responses);

  const service = new CompanionService(directory, () => {});
  await service.load();
  const memory = service.memory;
  const scope = (id: string): MemoryScope => ({ characterId: id, providerScope });
  let t = Date.UTC(2026, 10, 10, 2);
  const chat = async (id: string, turn: string, user: string, seal = true) => {
    await memory.beginTurn(scope(id), { id: turn, userText: user, at: t, conversationId: `c-${turn}` });
    await memory.appendAssistant(scope(id), turn, '嗯，我记着呢。', t + 1_000);
    await memory.finishTurn(scope(id), turn, 'complete', t + 2_000);
    if (seal) await memory.seal(scope(id));
    t += 4 * HOUR;
  };
  // Hers come first and in between (so the index of connections lists her first), and her last conversation is still open.
  await chat(doomed, 'd1', '昨天看了一部科幻电影，特效很震撼');
  await chat(kept, 'k1', '学校旁边新开了一家拉面店，周末我想和朋友去尝尝');
  await chat(doomed, 'd2', '下午路过星砂书店，进去看了看', false);
  await chat(kept, 'k2', '晚上吃什么好呢，有点饿了');
  for (const id of [doomed, kept]) await service.relationship.setNickname(id, id === doomed ? '小蓝' : '阿青');

  // 边说边演: each of those replies had beats (and the open one of hers too); the wiring's own hook drops them with their records.
  const speechBeats = new SpeechBeatArchive(directory);
  followChatDeletions(memory, speechBeats);
  for (const [n, [id, turn]] of ([[doomed, 'd1'], [kept, 'k1'], [doomed, 'd2'], [kept, 'k2']] as const).entries())
    await speechBeats.record(scope(id), turn, { beats: [{ word: 'smile-warm', at: 0 }, { word: n % 2 ? 'tilt' : 'shy', at: 3 }], line: n === 0 ? '她害羞地笑了' : '', performanceOnly: n === 0 }, 1_000 + n);

  const textInvitations = new MemoryStore(directory, 'text-invitations'); await textInvitations.load();
  for (const [n, id] of [kept, doomed].entries()) await textInvitations.appendInitiative(scope(id), { id: `inv-${n}`, text: '要不要把今天这句留下来？', at: t,
    origin: { kind: 'proactive', id: `inv-${n}`, at: t, sources: ['text'], labels: ['本次文字纪念邀请'] } });

  const watch = new WatchTogether({ directory, characterId: () => kept, conditions: () => ({}) as never, capture: async () => null, prepare: () => null, readListenNote: () => null });
  const clock = { t: t + 10 * HOUR };
  const writer = new FakeNoteWriter(JSON.stringify(fakeNoteBody({ title: '一段聊天', things: ['拉面'], plans: [], tags: ['聊天', '吃饭', '周末'] })));
  const notes = new MemoryNotes({ directory, archive: memory, write: writer.write, userBusy: () => false, modelBusy: () => false, lastActivityAt: () => null,
    scope: () => scope(kept), now: () => clock.t, tickMs: 3_600_000, keywords: watch.keywords });
  await notes.start();
  clock.t += MEMORY_NOTES_KNOBS.pace.startDelaySeconds * 1000;
  for (let i = 0; i < 8; i++) { clock.t += MEMORY_NOTES_KNOBS.pace.spacingSeconds * 1000; notes.core.tick(); await settle(); }
  await notes.core.flush();
  const doomedRecords = memory.recordIds(scope(doomed));
  assert.ok(notes.recycleCopy(doomedRecords)?.notes?.items.length, 'fixture: her chats have notes');
  // The user deleted one of her notes: that mark comes back too.
  await notes.core.deleteNote(doomedRecords[0]!, memory.noteScope(scope(doomed)));

  const marks = new UpcomingMarks(profilesDir); await marks.load();
  for (const id of [...memory.recordIds(scope(kept)), ...doomedRecords]) marks.add(id);
  await marks.flush();

  const upcomingStore = new UpcomingStore(profilesDir, { recording: () => true });
  const reviews = new ReviewStore(profilesDir, { recording: () => true });
  const profiles = new UserProfileStore(profilesDir, { upcoming: upcomingStore, reviews });
  for (const id of [kept, doomed]) {
    await profiles.activate(scope(id)); profiles.setEnabled(true);
    assert.equal(await profiles.saveDiary(profiles.diaryTicket()!, '2026-11-14', `${id} 的日记`), true);
    const sid = userProfileScopeId(scope(id));
    await writeFile(path.join(profilesDir, `upcoming-${sid}.json`), `{"version":1,"scopeId":"${sid}","upcoming":[]}\n`);
    await writeFile(path.join(profilesDir, `review-${sid}.json`), `{"version":1,"scopeId":"${sid}","data":{}}\n`);
  }
  await profiles.activate(scope(kept));
  const herNote = new HerNoteStore(profilesDir), movingStore = new MovingMemoryStore(profilesDir);
  for (const id of [kept, doomed]) {
    assert.equal(await herNote.add(scope(id), { text: `${id} 的笔记`, writtenAt: 1, cutoffAt: 1 }), true);
    assert.equal(await movingStore.add(scope(id), { date: '2026-11-14', text: `${id} 的那件事`, quoteRef: { at: 1, role: 'user' }, chosenAt: 1 }), true);
  }

  const rps = new RpsStore({ file: () => path.join(directory, 'rps.json') }); await rps.load();
  const feeding = new FeedRecognitionStore({ file: () => path.join(directory, 'feed-recognition.json') }); await feeding.load();
  for (const id of [kept, doomed, byName('小葵')]) {
    rps.finish(id, { at: Date.now(), origin: 'user', result: 'her', rounds: [{ her: 'rock', user: 'scissors', outcome: 'her' }] }, true);
    feeding.note(id, { edible: true, name: '草莓', category: '水果', liking: '喜欢', summary: '草莓' } as never, Date.now(), true);
  }
  await rps.flush(); await feeding.flush();

  const songs = new SongMemoryHost({ directory: () => directory, characterId: () => kept });
  const listen = new ListenTogether({ directory, kinds: { current: () => ({}) as never }, characterId: () => kept, listening: () => false, quick: async () => '' });
  const segment = (characterId: string, id: string, at: number) => ({ id, characterId, kind: 'music' as const, startedAt: at, lastHeardAt: at + 1, endedAt: at + 2, pieces: [], notedUpTo: at + 2, notedAt: at + 2 });
  const note = (characterId: string, segmentId: string, at: number) => ({ id: `ln-${segmentId}`, characterId, segmentId, kind: 'music' as const, startedAt: at, endedAt: at + 2, local: true, languages: [],
    createdAt: at, updatedAt: at, rolls: 0, talkedAt: null, what: '一首歌', gist: '安静的钢琴', mood: '平静', points: [], mention: '', hook: '' });
  listen.core.load({ version: 1, segments: [segment(kept, 's1', 1), segment(doomed, 's2', 2), segment(kept, 's3', 3)] as never,
    notes: [note(doomed, 's2', 2), note(kept, 's1', 1)] as never, deletedNotes: ['ln-long-ago'] });
  listen.recycleRestore('nobody', { segments: null, notes: null, marks: [] }); // written as the store writes it
  await listen.core.flush();

  const ambient = new AudioReadingArchive(directory); await ambient.load();
  for (const id of [kept, doomed]) await ambient.append(scope(id), { id: `t-${id}`, sessionId: 'session', mode: 'music', startedAt: 1_000, endedAt: 2_000,
    text: `${id} 听到的一句歌词`, language: { status: 'unknown', source: 'unverified' } });

  const today = dayStamp(Date.now());
  await writeFile(path.join(directory, 'special-day.json'), JSON.stringify({ v: 1, records: Object.fromEntries([kept, doomed].map(id => [`${id}|${today}`,
    { kind: 'birthday', hints: 1, spoke: false, done: false, first: null, closed: false }])) }));
  const specialDay = new SpecialDayHost({ file: () => path.join(directory, 'special-day.json'), characterId: () => kept } as never); await specialDay.load();
  await specialDay.forgetCharacter('nobody'); // written as the store writes it
  const year = new Date().getFullYear();
  await writeFile(path.join(directory, 'her-keepsakes.json'), JSON.stringify({ v: 1,
    specials: Object.fromEntries([kept, doomed].map(id => [`${id}|birthday-05-01|${year}`, { attempts: 1, lastAttemptAt: 5, done: true, told: false }])),
    characters: Object.fromEntries([kept, doomed].map(id => [id, { nextAt: 9, lastForm: 'note', special: 1, occasional: 2, tell: null }])) }));
  const keepsakes = new KeepsakeHost({ file: () => path.join(directory, 'her-keepsakes.json'), characterId: () => kept } as never); await keepsakes.load();
  await keepsakes.forgetCharacter('nobody');

  const hands = new HandsStore({ directory: () => directory }), ourThings = new OurThingsStore({ directory: () => directory });
  const picture = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37) % 256));
  for (const id of [kept, doomed]) {
    const put = async (rel: string, bytes: string | Buffer) => { const file = path.join(directory, ...rel.split('/')); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); };
    await put(`song-memory-${id}.json`, '{"version":1,"songs":[]}');
    await put(`memory-vectors/${characterKey(id)}.json`, `{"version":1,"model":"m","records":[["${id}-seg","s","sig","AAAA"]]}`);
    await put(`watch-notes/${characterKey(id)}.json`, `{"version":1,"notes":[{"id":"w-${id}","at":1,"text":"一起看的一段"}]}`);
    await put(`hands/${id}.json`, '{"v":1,"ledger":{"day":"2026-11-14","reached":2}}\n');
    await put(`our-things/${id}.json`, `{"v":1,"items":[{"id":"a1","at":1,"dir":"fed","kind":"snack","name":"饼干","line":"","file":"a1.jpg","bytes":600}],"ledger":{}}`);
    await put(`our-things/${id}/a1.jpg`, picture);
    await put(`people-things/${id}.json`, `{"v":1,"joined":[["${id}-朋友","小李"]]}`);
    await put(`character-avatars/${id}.png`, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), picture]));
  }

  const bin = new MemoryRecycleBin(directory); await bin.load();
  // Each has an earlier entry (Claude deleted a chat before): hers rides along and comes back as it was.
  for (const id of [kept, doomed]) await bin.put({ characterId: id, characterName: id === doomed ? '阿澄' : '小桃', part: 'chat', count: 1, label: '聊天记忆 1 段' },
    { kind: 'chat', providerScope, records: [{ id: `old-${id}` }] });

  const stores: RecycleStores = { profileDirectory: directory, bin, memory, textInvitations, notes, keywords: watch.keywords, semantic: null, profiles,
    speechBeats, upcoming: { marks } as never, herNote, movingMemory: { store: movingStore, view: (shown: MemoryScope | null) => { const current = shown ? movingStore.current(shown) : null;
      return { active: true, versions: current ? [{ date: current.date, text: current.text, why: null, chosenAt: current.chosenAt, current: true }] : [] }; } } as never, relationship: service.relationship,
    rps, feeding, songs, listen, watch, hands, ourThings, keepsakes, specialDay, ambient, cards, responses, avatars: null };
  const flush = async () => {
    await memory.flush(); await speechBeats.flush(); await textInvitations.flush(); await notes.core.flush(); await marks.flush(); await upcomingStore.settled(); await reviews.settled();
    await service.relationship.flush?.(); await rps.flush(); await feeding.flush(); await listen.core.flush(); await ambient.flush(); await specialDay.idle(); await keepsakes.idle();
    await hands.settled(); await settle();
  };
  await flush();
  return {
    directory, doomed, kept, doomedName: '阿澄', speechBeats, stores, flush, scope,
    ports: registry => ({ bin, registry: registry ?? recycleRegistry(stores), providerScopes: id => characterProviderScopes(id, forgettableProviderScopes(provider, memoryProviderScope), x => memory.providerScopesOf(x)),
      removeCard: async () => { await cardService.remove(doomed); }, cardExists: id => cards.publicState().cards.some(card => card.id === id) }),
    dispose: async () => { await flush(); await notes.dispose().catch(() => {}); profiles.dispose(); await service.flush().catch(() => {}); },
    journals: async () => {
      // A fresh read of both journals: each scope's records, in archive order, with its recall episode (what recycleCopy hands over).
      const out: Record<string, unknown> = {};
      for (const journal of ['conversation', 'text-invitations'] as const) {
        const fresh = new MemoryStore(directory, journal); await fresh.load();
        for (const id of [kept, doomed]) out[`${journal}:${id}`] = await fresh.recycleCopy(scope(id));
      }
      return out;
    },
  };
}

/** Files of the kept rows that differ between two snapshots (by content for the four rewritten whole). */
export function differences(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  const out: string[] = [];
  const names = new Set([...before.keys(), ...after.keys()].filter(rel => rowOf(rel) && !rel.startsWith('recycle-bin/settings')));
  for (const rel of names) {
    const a = before.get(rel), b = after.get(rel);
    if (!a || !b) { out.push(`${rel} ${a ? 'missing after' : 'new after'}`); continue; }
    if (BY_CONTENT.has(rel)) {
      if (rel.endsWith('.jsonl')) continue; // compared through a fresh read (World.journals)
      const strip = (bytes: Buffer) => { const value = JSON.parse(bytes.toString('utf8')); delete value.revision; return value; };
      try { assert.deepEqual(strip(b), strip(a)); } catch { out.push(rel); }
    } else if (!a.equals(b)) out.push(rel);
  }
  return out.sort();
}

export async function roundTrip(directory: string, mutate?: RecycleId): Promise<{ world: World; before: Map<string, Buffer>; afterDelete: Map<string, Buffer>; after: Map<string, Buffer>;
  journalsBefore: unknown; journalsAfter: unknown; failed: RecycleId[]; binAfterDelete: [string, string, boolean | undefined][] }> {
  const w = await world(directory);
  const before = await snapshot(directory), journalsBefore = await w.journals();
  let registry = recycleRegistry(w.stores);
  if (mutate) registry = { ...registry, [mutate]: { ...registry[mutate]!, restore: async () => {} } } as RecycleRegistry;
  const { entry, failed: removeFailed } = await recycleCharacter(w.doomed, w.doomedName, true, w.ports(registry));
  assert.deepEqual(removeFailed, []);
  await w.flush();
  const afterDelete = await snapshot(directory);
  const binAfterDelete = w.stores.bin.summaries(w.doomed).map(item => [item.part, item.label, item.memories] as [string, string, boolean | undefined]);
  const outcome = await restoreCharacterEntry(entry.id, w.ports(registry));
  await w.flush();
  return { world: w, before, afterDelete, after: await snapshot(directory), journalsBefore, journalsAfter: await w.journals(), failed: outcome.failed, binAfterDelete };
}
