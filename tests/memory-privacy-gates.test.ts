// 记忆的隐私关口 (wiring rewrite step 4d, docs/claude/2026-11-16-wiring-step-4d.md): the wiring around what she remembers of the user.
// Deleting a character with her memories hands every live store over (数据地图); turning 「允许记录」 off clears every row it should; each
// single deletion goes into the recycle bin first (I-144b) with its copy taken; finding back never deletes for good; the bin's content
// stays in the host. Each test evaluates the wiring's actual text (tests/helpers/wiring-source.ts: across electron/main.ts and
// electron/wiring/*.ts, so it follows the code when it moves) over fakes. Before this file most of these checks had no test that failed
// when the check was removed (the mutation table in the record).
// Reads as text (test-affected selects this test when they change): 'electron/main.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { recordingOffRegistry, runRecordingOff } from '../electron/memory/privacy-wiring';
import { PROFILE_EXTRA_ROWS } from '../electron/memory/recoverable-forget';
import { createRecycleHost } from '../electron/memory/recycle-wiring';
import { characterProviderScopes, forgettableProviderScopes } from '../electron/cards/character-forget';
import { memoryProviderScope } from '../electron/foundation/memory-provider-scope';
import { WIRING_PRELUDE, wiringCallArguments, wiringDeclaration, wiringHandler, wiringNodes, wiringOption, wiringArgument } from './helpers/wiring-source';
import { DATA_MAP } from '../electron/foundation/data-map';

/** Evaluates `body` (statements ending in a return) with the prelude and `env`'s names in scope. */
function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
const expression = <T>(text: string, env: Record<string, unknown>): T => evaluate<T>(`return (${text});`, env);
const declared = <T>(text: string, name: string, env: Record<string, unknown>): T => evaluate<T>(`${text}\nreturn ${name};`, env);
/** A property of an object literal (its value's text), e.g. one option of the agent channel's wiring. */
function propertyOf(objectText: string, name: string): string {
  const sf = ts.createSourceFile('x.ts', `(${objectText})`, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name && ts.isObjectLiteralExpression(node.parent)
      && node.parent.parent && ts.isParenthesizedExpression(node.parent.parent)) found.push(node.initializer.getText(sf));
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === name && ts.isObjectLiteralExpression(node.parent)
      && node.parent.parent && ts.isParenthesizedExpression(node.parent.parent)) found.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found.length !== 1) throw new Error(`propertyOf(${name}): found ${found.length}`);
  return found[0];
}
/** The options object the agent channel is started with (safetyPart.startAgentChannel(recorded, ipc, options)). */
const agentOptions = () => wiringCallArguments('safetyPart.startAgentChannel')[2];
const tag = (name: string) => ({ tag: name });

/** A recycle bin that only records: take first (its copy), then the removal, the way createRecycleHost.recycled orders them. */
function recorder() {
  const log: string[] = []; const taken: unknown[] = [];
  const recycleSingle = async (take: () => unknown, remove: () => unknown) => { const item = await take(); taken.push(item); log.push('take'); const result = await remove(); log.push('remove'); return result; };
  return { log, taken, recycleSingle };
}

// ---------------------------------------------------------------- 删角色 (数据地图 / I-144): every live store is handed over

/**
 * Step 4d: each part registers the stores it owns (registerPrivacyStores(owner, …), in its own wiring; electron/main.ts for the parts whose
 * wiring has not moved). Every registration in the wiring, evaluated over `env`, and 记忆's own owned() reading them: what recycleStores()
 * and privacyStores() read.
 */
function registrationCalls() {
  return wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerPrivacyStores');
}
function ownersEnv(env: Record<string, unknown>): Record<string, unknown> {
  const registered: Record<string, unknown> = {};
  for (const { node, ast } of registrationCalls()) {
    const owner = (node.arguments[0] as ts.StringLiteral).text;
    assert.ok(!(owner in registered), `${owner} registers its stores once`);
    registered[owner] = expression(node.arguments[1].getText(ast), env);
  }
  return { ...env, registered, owned: declared(wiringDeclaration('owned'), 'owned', { registered }) };
}

// What recycleStores() hands to the bin, per key: the live store of this session (null only where the store is not running).
const LIVE_STORES: Record<string, string> = {
  textInvitations: 'textInvitationMemory', notes: 'memoryNotes', keywords: 'watchTogether.keywords', semantic: 'semantic.recall', profiles: 'userProfiles',
  upcoming: 'upcoming', herNote: 'herNote.store', movingMemory: 'movingMemory', relationship: 'companion.relationship', rps: 'rps.store',
  feeding: 'feeding.store', songs: 'songMemory', listen: 'listenTogether', watch: 'watchTogether', hands: 'hands.store', ourThings: 'give.store',
  keepsakes: 'keepsake', specialDay: 'specialDay', ambient: 'ambientStore', cards: 'characterCards', responses: 'characterResponses',
  avatars: 'characterAvatars', textMemorials: 'textMemorialHost', upcomingStore: 'userProfiles.companionStores().upcoming',
  reviews: 'userProfiles.companionStores().reviews', assistant: 'recycleAssistant', memory: 'companion.memory', bin: 'recycleBin', speechBeats: 'speechBeatsArchive',
};
function storeWorld() {
  const t = tag;
  const upcomingPort = t('upcomingPort'), reviewPort = t('reviewPort'), speechBeatsArchive = t('speechBeatsArchive');
  const env = {
    speechBeatsArchive, speechBeatsFor: () => ({ archive: speechBeatsArchive }), // 边说边演: the beats file follows her chat records
    store: { directory: 'C:/profile' }, recycleBin: t('recycleBin'), textInvitationMemory: t('textInvitationMemory'), memoryNotes: t('memoryNotes'),
    watchTogether: { tag: 'watchTogether', keywords: t('watchTogether.keywords') }, semantic: { recall: t('semantic.recall') },
    userProfiles: { tag: 'userProfiles', companionStores: () => ({ upcoming: upcomingPort, reviews: reviewPort }) }, upcoming: t('upcoming'),
    herNote: { store: t('herNote.store') }, movingMemory: { tag: 'movingMemory', store: t('movingMemory.store') },
    companion: { memory: t('companion.memory'), relationship: t('companion.relationship') }, rps: { store: t('rps.store') }, feeding: { store: t('feeding.store') },
    songMemory: t('songMemory'), listenTogether: t('listenTogether'), hands: { store: t('hands.store'), host: t('hands.host') }, give: { store: t('give.store') },
    keepsake: t('keepsake'), specialDay: t('specialDay'), ambientStore: t('ambientStore'), characterCards: t('characterCards'),
    characterResponses: t('characterResponses'), characterAvatars: t('characterAvatars'), textMemorialHost: t('textMemorialHost'), recycleAssistant: t('recycleAssistant'),
  };
  const expected = (path: string): unknown => {
    if (path === 'userProfiles.companionStores().upcoming') return upcomingPort;
    if (path === 'userProfiles.companionStores().reviews') return reviewPort;
    return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], env);
  };
  return { env, expected };
}

test('删角色: recycleStores() hands every live store to the bin (a store left out would keep her memories, or come back stale)', () => {
  const { env, expected } = storeWorld();
  const stores = declared<() => Record<string, unknown>>(wiringDeclaration('recycleStores'), 'recycleStores', ownersEnv(env))();
  assert.equal(stores.profileDirectory, 'C:/profile');
  for (const [key, path] of Object.entries(LIVE_STORES)) assert.equal(stores[key], expected(path), `recycleStores().${key} is ${path}`);
  assert.deepEqual(Object.keys(stores).sort(), ['profileDirectory', ...Object.keys(LIVE_STORES)].sort(), 'no store more or less than the bin knows');
});

test('删角色: the bin host reads the same stores, under every connection she was talked to under', () => {
  const sentinel = tag('stores');
  const stores = expression<() => unknown>(wiringOption('recycleHost', 'stores'), { recycleStores: () => sentinel });
  assert.equal(stores(), sentinel, 'the host gets recycleStores itself');
  const provider = { kind: 'claude', baseUrl: '', model: 'opus' };
  const env = { store: { current: { provider } }, companion: { memory: { providerScopesOf: () => ['an-earlier-connection'] } }, characterProviderScopes, forgettableProviderScopes, memoryProviderScope };
  const scopes = declared<(id: string) => string[]>(wiringDeclaration('recycleScopes'), 'recycleScopes', env);
  const given = expression<(id: string) => string[]>(wiringOption('recycleHost', 'providerScopes'), { ...env, recycleScopes: scopes });
  const all = given('her');
  assert.ok(all.includes('an-earlier-connection'), 'a connection only the archive knows');
  for (const scope of forgettableProviderScopes(provider as never, memoryProviderScope as never)) assert.ok(all.includes(scope), 'every alias of the current connection');
});

/** The data-map rows each store serves (electron/memory/recycle-wiring.ts recycleRegistry, electron/memory/privacy-wiring.ts). */
const STORE_ROWS: Record<string, string[]> = {
  memory: ['chat-memory', 'memory-scopes'], textInvitations: ['text-invitations'], notes: ['memory-notes', 'people-things'], keywords: ['memory-keywords'],
  semantic: ['memory-vectors'], profiles: ['user-profile'], upcoming: ['upcoming-marks'], herNote: ['her-note'], movingMemory: ['moving-memory'],
  relationship: ['relationship'], specialDay: ['special-day'], textMemorials: ['text-memorials'], upcomingStore: ['upcoming-plans'], reviews: ['period-reviews'],
  feeding: ['feeding'], songs: ['song-memory'], songMemory: ['song-memory'], listen: ['listen-together'], listenTogether: ['listen-together'],
  watch: ['watch-notes'], watchTogether: ['watch-notes'], ambient: ['ambient-transcripts'], rps: ['rps'], hands: ['hands'], ourThings: ['our-things'],
  keepsakes: ['keepsakes'], speechBeats: ['speech-beats'], cards: ['character-cards'], responses: ['character-response'], avatars: ['character-avatars'], assistant: ['assistant'],
  voiceprint: ['voiceprint'], // Unbound v1 step 3
  reminders: ['reminders'], // I-188
};
/** Where each owner registers: its own wiring (主动's since step 4e); 安全's assistant from electron/main.ts until its wiring moves. */
const REGISTERED_IN: Record<string, string> = { memory: 'electron/wiring/memory-wiring.ts', senses: 'electron/wiring/senses-wiring.ts', cards: 'electron/wiring/cards-wiring.ts',
  initiative: 'electron/wiring/initiative-wiring.ts', safety: 'electron/main.ts' };

test('数据地图 owners: each store is handed over by the part the data map says owns it, from that part\'s own wiring', () => {
  const table = (name: string) => expression<Record<string, string>>(wiringDeclaration(name).replace(/^[^=]*=\s*/, '').replace(/\s*as const satisfies[\s\S]*$/, ''), {});
  const ownerOf = (row: string) => { const found = DATA_MAP.find(r => r.id === row); assert.ok(found, row); return /^electron\/([a-z]+)\//.exec(found.owner)?.[1]; };
  for (const name of ['RECYCLE_STORE_OWNERS', 'RECORDING_OFF_STORE_OWNERS']) {
    for (const [store, owner] of Object.entries(table(name))) {
      assert.ok(STORE_ROWS[store], `${name}.${store}: which rows it serves`);
      for (const row of STORE_ROWS[store]) assert.equal(ownerOf(row), owner, `${name}.${store} (row ${row}) belongs to ${owner} as the data map says`);
    }
  }
  const calls = registrationCalls().map(({ node, file }) => [(node.arguments[0] as ts.StringLiteral).text, file]);
  assert.deepEqual(Object.fromEntries(calls), REGISTERED_IN);
  assert.equal(calls.length, Object.keys(REGISTERED_IN).length, 'each owner registers once');
});

test('数据地图 owners: a part that has not registered its stores stops the action before anything is deleted', () => {
  const owned = declared<(owner: string) => unknown>(wiringDeclaration('owned'), 'owned', { registered: { memory: {} } });
  assert.throws(() => owned('senses'), /还没登记/);
  const { env } = storeWorld();
  const partial = { ...ownersEnv(env) };
  const registered = { ...(partial.registered as Record<string, unknown>) }; delete registered.cards;
  const stores = declared<() => unknown>(wiringDeclaration('recycleStores'), 'recycleStores', { ...partial, registered, owned: declared(wiringDeclaration('owned'), 'owned', { registered }) });
  assert.throws(() => stores(), /cards 还没登记/);
});

// ---------------------------------------------------------------- 关「允许记录」: every row the data map says goes

test('关「允许记录」: the switch-off clears her note, her moving memory, plan marks, promises, match counts and what she was fed', async () => {
  const cleared: string[] = [];
  const env = {
    companion: { memory: tag('memory'), relationship: tag('relationship') }, userProfiles: tag('profiles'), songMemory: null, semantic: null, listenTogether: null, watchTogether: null,
    rps: { store: { forget: (id: string) => { cleared.push(`rps:${id}`); return true; } } }, feeding: { store: { forget: (id: string) => { cleared.push(`feeding:${id}`); return true; } } },
    herNote: { store: { clear: async () => { cleared.push('her-note'); } } }, movingMemory: { store: { clear: async () => { cleared.push('moving-memory'); } } },
    upcoming: { recordingOff: async () => { cleared.push('upcoming-marks'); } }, hands: { host: { recordingOff: () => { cleared.push('hands'); } } },
    moments: null, // I-188: the reminders are not a recording-off row
  };
  const privacyStores = declared<() => unknown>(wiringDeclaration('privacyStores'), 'privacyStores', ownersEnv(env));
  const off = expression<(scope: { characterId: string; providerScope: string }, reason: string) => void>(wiringArgument('userProfileManagement', 3),
    { ...env, privacyStores, recordingOffRegistry, runRecordingOff });
  off({ characterId: 'her', providerScope: 'p' }, 'recording-off');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cleared.sort(), ['feeding:her', 'hands', 'her-note', 'moving-memory', 'rps:her', 'upcoming-marks']);
  cleared.length = 0;
  off({ characterId: 'her', providerScope: 'p' }, 'diary-cleared');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cleared.sort(), ['feeding:her', 'rps:her'], 'clearing the diary: match counts and what she was fed only');
});

// ---------------------------------------------------------------- I-144b: single deletions go into the bin first, with their copy

const SCOPE = { characterId: 'her', providerScope: 'p' };
const STORES = tag('recycleStores()');
/** take<Name>(stores, ...args) fakes: each returns what it was given, so the test sees the copy was taken from the live stores. */
const takes = Object.fromEntries(['takeChatRecord', 'takeTextMemorial', 'takeProfileEntry', 'takeDiary', 'takePlans', 'takeReview', 'takeNickname', 'takeListenRaw',
  'takeAmbientTranscript', 'takeOurThing', 'takeAssistantChat'].map(name => [name, (...args: unknown[]) => ({ take: name, args })]));
function binWorld(extra: Record<string, unknown> = {}) {
  const r = recorder();
  const field = declared<(value: unknown, name: string) => unknown>(wiringDeclaration('field'), 'field', {});
  const profiles = Object.fromEntries(['delete', 'deleteDiary', 'clearDiary', 'deleteUpcoming', 'clearUpcoming', 'deleteReview'].map(name => [name, (request: unknown) => { r.log.push(`profiles.${name}`); return { done: name, request }; }]));
  return { r, env: { ...takes, recycleSingle: r.recycleSingle, recycleStores: () => STORES, field, companion: { currentScope: () => SCOPE }, userProfileManagement: profiles, ...extra } };
}

const PROFILE_DELETIONS: [string, string, unknown, unknown[]][] = [
  ['deleteUserProfile', 'takeProfileEntry', { id: 'e1' }, [STORES, SCOPE, 'e1']],
  ['deleteUserDiary', 'takeDiary', { date: '2026-11-10' }, [STORES, SCOPE, '2026-11-10']],
  ['clearUserDiary', 'takeDiary', {}, [STORES, SCOPE, '*']],
  ['deleteUserUpcoming', 'takePlans', { id: 'plan-1' }, [STORES, SCOPE, 'plan-1']],
  ['clearUserUpcoming', 'takePlans', {}, [STORES, SCOPE, '*']],
  ['deleteUserReview', 'takeReview', { kind: 'week', key: '2026-W45' }, [STORES, SCOPE, 'week', '2026-W45']],
];
for (const [handler, take, request, args] of PROFILE_DELETIONS) {
  test(`I-144b ${handler}: into the bin first, its copy taken from the live stores, then deleted`, async () => {
    const { r, env } = binWorld();
    const run = expression<(sender: number, request: unknown) => unknown>(wiringHandler(handler), env);
    await run(1, request);
    assert.deepEqual(r.taken, [{ take, args }], 'the copy');
    assert.deepEqual(r.log, ['take', `profiles.${({ deleteUserProfile: 'delete', deleteUserDiary: 'deleteDiary', clearUserDiary: 'clearDiary', deleteUserUpcoming: 'deleteUpcoming', clearUserUpcoming: 'clearUpcoming', deleteUserReview: 'deleteReview' } as Record<string, string>)[handler]}`, 'remove']);
  });
}

test('I-144b deleteTextMemorial and the nickname: into the bin first, with their copy', async () => {
  const { r, env } = binWorld({ textMemorialHost: { delete: (value: unknown) => { r.log.push('memorials.delete'); return value; } } });
  await expression<(value: unknown) => unknown>(wiringHandler('deleteTextMemorial'), env)({ id: 'm1' });
  assert.deepEqual(r.taken, [{ take: 'takeTextMemorial', args: [STORES, 'm1'] }]);
  assert.deepEqual(r.log, ['take', 'memorials.delete', 'remove']);
  const nick = binWorld({ companion: { mood: { get: () => ({ characterId: 'her' }) }, relationship: { setNickname: (id: string, value: unknown) => { nick.r.log.push(`setNickname:${id}:${value}`); return value; } } } });
  await expression<(value: unknown) => unknown>(wiringHandler('setRelationshipNickname'), nick.env)(null);
  assert.deepEqual(nick.r.taken, [{ take: 'takeNickname', args: [STORES, 'her'] }]);
  assert.deepEqual(nick.r.log, ['take', 'setNickname:her:null', 'remove']);
  await expression<(value: unknown) => unknown>(wiringHandler('setRelationshipNickname'), nick.env)('小名');
  assert.equal(nick.r.taken.length, 1, 'setting a new nickname deletes nothing');
});

function chatWorld(extra: Record<string, unknown> = {}) {
  const w = binWorld();
  const calls: string[] = w.r.log;
  const note = (name: string) => () => { calls.push(name); };
  const record = { id: 'r1', origin: null };
  const env = { ...w.env, mutate: (op: () => unknown) => op(), exiting: false, speechScope: () => 'scope', textMemorialHost: null,
    managedMemory: (id: string) => ({ id, invitation: false, memory: { read: () => record, edit: async () => { calls.push('edit'); } } }),
    companion: { currentScope: () => SCOPE, removeMemory: () => { calls.push('removeMemory'); return Promise.resolve(); }, newConversation: () => { calls.push('newConversation'); return Promise.resolve(); },
      memory: { findInitiative: () => ({ recordId: 'c1' }), delete: async () => { calls.push('memory.delete'); } } },
    stopSystemAudio: note('stopSystemAudio'), proactiveSpeechGate: { cancel: note('gate.cancel') }, clearVisionContext: note('clearVision'), refreshVisionContext: note('refreshVision'),
    speechRuntime: { stop: note('speech.stop') }, clearReplySpeech: note('clearReplySpeech'), pending: new Map(), broadcast: () => {},
    movingMemory: { prune: (scope: unknown) => { calls.push(`prune:${JSON.stringify(scope)}`); } },
    userProfileManagement: { cancelPending: note('cancelPending') }, ambientComments: null,
    ambientStore: { comments: () => [{ id: 'k1' }], delete: async () => { calls.push('ambient.delete'); return { deleted: true }; } }, ...extra };
  return { r: w.r, env, calls };
}

test('I-144b deleteMemory: into the bin first (the copy from the live stores), and her bookmark does not outlive the record', async () => {
  const { r, env, calls } = chatWorld();
  await expression<(id: string) => Promise<unknown>>(wiringHandler('deleteMemory'), env)('r1');
  assert.deepEqual(r.taken, [{ take: 'takeChatRecord', args: [STORES, SCOPE, 'r1', 'conversation'] }]);
  assert.equal(calls[0], 'take', 'the copy is in the bin before anything is deleted');
  assert.ok(calls.indexOf('removeMemory') > 0 && calls.at(-1) === 'remove');
  assert.ok(calls.includes(`prune:${JSON.stringify(SCOPE)}`), 'I-139 A3: the bookmark quoting it is re-checked');
});

test('I-139 A3 editMemory: an edited record re-checks the bookmark that quotes it', async () => {
  const { env, calls } = chatWorld();
  await expression<(id: string, edit: unknown) => Promise<unknown>>(wiringHandler('editMemory'), env)('r1', { text: 'x' });
  assert.deepEqual(calls.filter(c => c === 'edit' || c.startsWith('prune:')), ['edit', `prune:${JSON.stringify(SCOPE)}`]);
});

test('I-144b deleteAmbientTranscript: into the bin first, with the comments she archived from it', async () => {
  const { r, env, calls } = chatWorld();
  const outcome = await expression<(id: string) => Promise<unknown>>(wiringHandler('deleteAmbientTranscript'), env)('t1');
  assert.deepEqual(outcome, { deleted: true });
  assert.deepEqual(r.taken, [{ take: 'takeAmbientTranscript', args: [STORES, SCOPE, 't1', ['c1']] }]);
  assert.equal(calls[0], 'take');
  assert.ok(calls.includes('ambient.delete') && calls.at(-1) === 'remove');
});

test('I-144b the listening raw text, our small things and the Claude assistant: into the bin first, with their copy', async () => {
  const listenArgs = wiringCallArguments('registerListenTogetherIpc');
  const raw = binWorld({ listenTogether: { clearRaw: () => { raw.r.log.push('clearRaw'); return 'cleared'; } } });
  raw.env.companion = { currentScope: () => SCOPE } as never;
  assert.equal(await expression<() => Promise<unknown>>(listenArgs[3], raw.env)(), 'cleared');
  assert.deepEqual(raw.r.taken, [{ take: 'takeListenRaw', args: [STORES, 'her'] }]);
  assert.deepEqual(raw.r.log, ['take', 'clearRaw', 'remove']);

  const things = binWorld();
  const through = expression<(characterId: string, id: string, remove: () => Promise<unknown>) => Promise<unknown>>(wiringOption('give', 'removeThroughBin'), things.env);
  await through('her', 'thing-1', async () => { things.r.log.push('give.remove'); return { items: [] }; });
  assert.deepEqual(things.r.taken, [{ take: 'takeOurThing', args: [STORES, 'her', 'thing-1'] }]);
  assert.deepEqual(things.r.log, ['take', 'give.remove', 'remove']);

  const assistant = binWorld();
  const wire = expression<(assistant: { clear(): unknown }) => () => Promise<unknown>>(propertyOf(agentOptions(), 'assistantRecycle'), { ...assistant.env, recycleAssistant: null, setRecycleAssistant: () => {} }); // step 4d: the setter of 记忆's binding
  await wire({ clear: () => { assistant.r.log.push('assistant.clear'); return 'ok'; } })();
  assert.deepEqual(assistant.r.taken, [{ take: 'takeAssistantChat', args: [STORES] }]);
  assert.deepEqual(assistant.r.log, ['take', 'assistant.clear', 'remove']);
});

test('I-144 a listening note, a memory note, her moving memory: through the bin host, never straight from their stores', async () => {
  const used: string[] = [];
  const recycleHost = { deleteListenNote: async (id: string) => { used.push(`bin.listen:${id}`); }, deleteMemoryNote: async (id: string) => { used.push(`bin.note:${id}`); },
    deleteMovingMemory: async (_scope: unknown, at: number) => { used.push(`bin.moving:${at}`); return { active: true, versions: [] }; } };
  const stores = { listenTogether: { deleteNote: () => { used.push('listen.deleteNote'); } }, memoryNotes: { deleteNote: () => { used.push('notes.deleteNote'); } } };
  await expression<(id: string) => Promise<unknown>>(wiringCallArguments('registerListenTogetherIpc')[2], { recycleHost, ...stores })('n1');
  await expression<(id: string) => Promise<unknown>>(wiringCallArguments('registerMemoryNotesIpc')[2], { recycleHost, ...stores })('m1');
  await assert.rejects(expression<(id: string) => Promise<unknown>>(wiringCallArguments('registerListenTogetherIpc')[2], { recycleHost: null, ...stores })('n2'));
  await assert.rejects(expression<(id: string) => Promise<unknown>>(wiringCallArguments('registerMemoryNotesIpc')[2], { recycleHost: null, ...stores })('m2'));
  const moving = { view: () => ({ active: true, versions: [] }), store: { deleteCurrent: async () => { used.push('moving.deleteCurrent'); return true; } } };
  await expression<(sender: number, at: unknown) => Promise<unknown>>(wiringHandler('deleteMovingMemory'),
    { recycleHost, movingMemory: moving, userProfileManagement: { get: () => ({}) }, companion: { currentScope: () => SCOPE } })(1, 42);
  assert.deepEqual(used, ['bin.listen:n1', 'bin.note:m1', 'bin.moving:42']);
});

test('I-144b her songs: 「清除她记得的歌」 and Claude\'s clear_song_memory both go through the bin', async () => {
  const used: string[] = [];
  const songsBin = { clear: async () => { used.push('bin.clear'); return { count: 3 }; } };
  const songMemory = { clear: async () => { used.push('songs.clear'); return { count: 3 }; }, handle: () => { used.push('songs.handle'); } };
  const controls = { webContents: { id: 2 } };
  const field = declared<(value: unknown, name: string) => unknown>(wiringDeclaration('field'), 'field', {});
  const handler = expression<(sender: number, request: unknown) => Promise<unknown>>(wiringHandler('songMemory'), { controls, pet: { webContents: { id: 1 } }, songsBin, songMemory, field, journalCharacterId: () => 'her' });
  assert.deepEqual(await handler(2, { op: 'clear' }), { cleared: 3 });
  assert.deepEqual(used, ['bin.clear']);
  assert.equal(propertyOf(agentOptions(), 'songs'), 'songsBin', 'the agent channel clears through the same bin');
  const made: unknown[][] = [];
  const recycleHost = tag('host');
  declared(wiringDeclaration('songsBin'), 'songsBin', { songsThroughBin: (...args: unknown[]) => { made.push(args); return {}; }, recycleHost, recycleStores: () => STORES, companion: null });
  const [host, stores] = made[0] as [() => unknown, () => unknown];
  assert.equal(host(), recycleHost); assert.equal(stores(), STORES);
});

test('I-144b while the bin is not ready nothing is deleted', async () => {
  let removed = 0;
  const single = declared<(take: () => unknown, remove: () => unknown) => Promise<unknown>>(wiringDeclaration('recycleSingle'), 'recycleSingle', { recycleHost: null });
  await assert.rejects(single(() => null, () => { removed++; }), /回收站还没准备好/);
  assert.equal(removed, 0);
  const through = declared<(take: () => unknown, remove: () => unknown) => Promise<unknown>>(wiringDeclaration('recycleSingle'), 'recycleSingle',
    { recycleHost: { recycled: (_take: unknown, remove: () => unknown) => remove() } });
  await through(() => null, () => { removed++; });
  assert.equal(removed, 1);
});

// ---------------------------------------------------------------- the bin's content stays in the host; finding back never deletes for good

test('I-144 a bin change goes to the control window only, as the bin host\'s view (names, kinds, counts, times)', () => {
  const view = { days: 7, entries: [], ready: true };
  const sent: unknown[][] = [];
  const window = (id: number) => ({ isDestroyed: () => false, webContents: { id, send: (...args: unknown[]) => { sent.push([id, ...args]); } } });
  const controls = window(2), pet = window(1);
  let refreshed = 0;
  const changed = declared<() => void>(wiringDeclaration('recycleChanged'), 'recycleChanged',
    { recycleHost: { view: () => view }, recycleBin: tag('the bin itself'), controls, pet, windows: () => [controls, pet], agentChannelRefresh: () => { refreshed++; } });
  changed();
  assert.deepEqual(sent, [[2, 'desk:recycle-bin', view]]);
  assert.equal(sent[0][2], view);
  assert.equal(refreshed, 1, 'the agent channel reads the bin again');
});

test('I-014 / I-144 finding back (the agent channel, the bin host) restores; it never deletes for good', async () => {
  const used: string[] = [];
  const recycleHost = { restore: async (id: string) => { used.push(`restore:${id}`); return { restored: id }; }, deleteForGood: async (id: string) => { used.push(`deleteForGood:${id}`); } };
  const recycleBin = { deleteForGood: async (id: string) => { used.push(`bin.deleteForGood:${id}`); } };
  const provider = { kind: 'claude', baseUrl: '', model: 'opus' };
  const registry = Object.fromEntries(PROFILE_EXTRA_ROWS.map(row => [row, tag(row)]));
  const env = { PROFILE_EXTRA_ROWS, recycleHost, recycleBin, store: { current: { provider } }, forgettableProviderScopes, memoryProviderScope, companion: { memory: tag('chat') }, userProfiles: tag('profiles'),
    watchTogether: { recyclePort: () => tag('watch port') }, recycleRegistry: (stores: unknown) => { assert.equal(stores, STORES); return registry; }, recycleStores: () => STORES, mutations: { run: (op: () => unknown) => op() } };
  const recoverable = declared<Record<string, (...args: unknown[]) => unknown>>(wiringDeclaration('recoverable'), 'recoverable', env);
  await recoverable.restoreOther('e1');
  assert.deepEqual(recoverable.profileExtras(), registry, 'Claude deleting the profile takes her plans, look-backs, note and moving memory with it');
  assert.deepEqual(recoverable.watch(), tag('watch port'), 'her watch notes ride in the chat entry');
  assert.deepEqual(recoverable.providerScopes(), forgettableProviderScopes(provider as never, memoryProviderScope as never));
  const bridge: unknown[] = [];
  const restorePart = expression<(id: string) => Promise<unknown>>(wiringOption('recycleHost', 'restoreMemoryPart'),
    { ...env, recoverable, createMemoryBridge: (bin: unknown, wiring: unknown) => ({ restore: async (id: string) => { bridge.push([bin, wiring, id]); used.push(`bridge.restore:${id}`); } }) });
  await restorePart('e2');
  assert.deepEqual(bridge, [[recycleBin, recoverable, 'e2']]);
  assert.deepEqual(used, ['restore:e1', 'bridge.restore:e2']);
});

test('I-139 A3: Claude forgetting her chat re-checks her bookmarks under every connection of hers', async () => {
  const pruned: unknown[] = [];
  const provider = { kind: 'claude', baseUrl: '', model: 'opus' };
  const noop = () => {};
  const env = { store: { current: { provider } }, forgettableProviderScopes, memoryProviderScope, characterProviderScopes, mutations: { run: (op: () => unknown) => op() },
    companion: { currentScope: () => ({ characterId: 'other', providerScope: 'p' }), memory: { providerScopesOf: () => ['old-connection'] } },
    movingMemory: { prune: (scope: unknown) => { pruned.push(scope); } }, broadcast: noop, userProfileManagement: null, activateUserProfile: async () => {},
    stopSystemAudio: noop, proactiveSpeechGate: { cancel: noop }, clearVisionContext: noop, speechRuntime: { stop: noop }, clearReplySpeech: noop, pending: new Map(), refreshVisionContext: noop };
  const recoverable = declared<{ change(...args: unknown[]): Promise<unknown> }>(wiringDeclaration('recoverable'), 'recoverable', env);
  await recoverable.change('her', ['chat'], 'forget', null, async () => 'done');
  const scopes = characterProviderScopes('her', forgettableProviderScopes(provider as never, memoryProviderScope as never), () => ['old-connection']);
  assert.deepEqual(pruned, scopes.map(providerScope => ({ characterId: 'her', providerScope })));
  assert.ok(scopes.includes('old-connection'));
});

// The recycle bin host's three single deletions each check the bin is ready before they take anything (gaps C-memoryNote-ready,
// C-listenNote-ready, C-movingMemory-ready of the mutation lists): a bin that is not ready means nothing is written, nothing deleted.
test('I-144 the bin host: a chat note, a listening note and her moving memory are not deleted while the bin is not ready', async () => {
  const calls: string[] = [];
  let ready = false;
  const SCOPE_OF = { characterId: 'her', providerScope: 'scope-a' };
  const bin = { ready: false as boolean, retentionDays: 7, finalize: undefined as unknown,
    put: async () => { calls.push('bin.put'); return { id: 'e1' }; }, discard: async () => { calls.push('bin.discard'); } };
  Object.defineProperty(bin, 'ready', { get: () => ready });
  const stores = {
    bin,
    notes: { noteCopy: () => ({ notes: { items: [{ value: { recordId: 'r1', segmentAt: 1 } }] } }), deleteNote: async () => { calls.push('notes.deleteNote'); return { status: 'deleted' }; } },
    keywords: { entry: async () => null },
    listen: { noteCopy: () => ({ characterId: 'her', part: { item: { value: { id: 'n1', startedAt: 1 } } } }), deleteNote: () => { calls.push('listen.deleteNote'); return {}; } },
    movingMemory: { view: () => ({ versions: [{ current: true, chosenAt: 5, date: '2026-11-14' }] }), store: { deleteCurrent: async () => { calls.push('moving.deleteCurrent'); return true; } } },
  };
  const host = createRecycleHost({ bin: bin as never, stores: () => stores as never, currentScope: () => SCOPE_OF as never, characterName: () => '她', providerScopes: () => [],
    cardExists: () => true, restoreMemoryPart: () => Promise.reject(new Error('unused')), change: (_kind, _id, run) => run() });
  const attempt = async () => {
    await assert.rejects(host.deleteMemoryNote('r1'), /回收站还没准备好/);
    await assert.rejects(host.deleteListenNote('n1'), /回收站还没准备好/);
    await assert.rejects(host.deleteMovingMemory(SCOPE_OF as never, 5), /回收站还没准备好/);
  };
  await attempt();
  assert.deepEqual(calls, [], 'nothing is written to the bin and nothing is deleted from the notebook, the listening notes or her list');
  ready = true;
  await host.deleteMemoryNote('r1'); await host.deleteListenNote('n1'); await host.deleteMovingMemory(SCOPE_OF as never, 5);
  assert.deepEqual(calls.filter(call => call !== 'bin.discard'), ['bin.put', 'notes.deleteNote', 'bin.put', 'listen.deleteNote', 'bin.put', 'moving.deleteCurrent'], 'ready: each goes through the bin first');
});
