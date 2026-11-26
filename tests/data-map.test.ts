// 数据地图 (electron/foundation/data-map.ts, handbook/data-map.md, docs/claude/2026-11-16-data-map.md): the table of everything the app keeps, and the privacy actions
// that follow it. (i) every file or folder name the code writes is in the table; (ii) "删除角色" with "同时删除她的记忆" removes every
// 'delete' row from real stores, only for her; "允许记录" off clears its rows; (iii) a card export carries nothing private; (iv, now in tests/experience-backup-data-map.test.ts: the maintainer's
// profile backup carries every row marked "in backup") and the Chinese record shows exactly this table.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { forgetCharacterMemories, forgettableProviderScopes } from '../electron/cards/character-forget';
import { CharacterResponseService, CharacterResponseStore } from '../electron/cards/character-response';
import { CompanionService, memoryProviderScope } from '../electron/brain/companion';
import { DATA_MAP, characterForgetIds, recordingOffIds, recycleIds, renderDataMapMarkdown, type DataStoreRow } from '../electron/foundation/data-map';
import type { RecycleRegistry } from '../electron/memory/recycle/ports';
import { FeedRecognitionStore } from '../electron/senses/feed-recognition/store';
import { HerNoteStore } from '../electron/memory/her-note/store';
import { characterKey } from '../electron/memory/memory-keywords/store';
import { MovingMemoryStore } from '../electron/memory/moving-memory/store';
import { ReviewStore } from '../electron/memory/period-review/store';
import { characterForgetRegistry, recordingOffRegistry, runRecordingOff, type PrivacyStores } from '../electron/memory/privacy-wiring';
import { RpsStore } from '../electron/initiative/rps/store';
import { SongMemoryHost } from '../electron/senses/song-memory';
import { UpcomingStore } from '../electron/memory/upcoming/store';
import { UserProfileStore, userProfileScopeId } from '../electron/memory/user-profile';
import { defaultCharacterMoodTemplate } from '../shared/cards/character-cards';

const ROOT = path.resolve(import.meta.dirname, '..');
const rows: readonly DataStoreRow[] = DATA_MAP;

// ---- (i) the scan: every persisted name in the code is in the table ----

/** Names the scan finds that are not data under the profile (or sit inside a row's folder), exactly as the scan prints them, each with
 *  why. A name the code no longer has fails the test, so the list cannot hide anything. */
const NOT_PROFILE_DATA: Readonly<Record<string, string>> = {
  '../dist': 'the built app', '../dist/index.html': 'the built app', 'build-info.json': 'the built app', 'preload.cjs': 'the built app',
  'reply-preload.cjs': 'the built app', 'single-emoji-preload.cjs': 'the built app', 'assets/bundled': 'bundled assets (read only)',
  'assistant-docs': 'packaged docs (resources)', 'resources/app.asar': 'the installed bundle', 'release': 'the workspace release folder',
  '*-manifest.json': 'desktop channel manifests (workspace)', '.local/desktop-entry-maintenance': 'workspace maintenance folder', 'receipt-*.json': 'workspace maintenance receipts',
  '.local': 'the app folder\'s own .local folder (workspace)', 'first-language.txt': 'I-219: the install-time language hint in the app folder (.local), read once and deleted; not profile data',
  'desktop-profile.json': 'workspace release file', 'desktop-development-profile.json': 'workspace release file',
  'soft-hearts-claude': 'the profile folder name itself', 'soft-hearts-claude-dev': 'the profile folder name itself',
  'soft-hearts-claude/assistant': 'OS temp folder of the assistant', 'soft-hearts-claude/components': 'components (outside the profile: row components)',
  'soft-hearts-diagnostics': 'outside the profile: row color-block-log',
  'near-misses.jsonl': 'row color-block-log (outside)', 'started.json': 'row color-block-log (outside)', 'README.txt': 'row color-block-log (outside)',
  'asr': 'component folder (outside)', 'asr/asr-v*': 'component folder (outside)', 'pose-v*': 'component folder (outside)', 'face': 'component folder (outside)',
  'semantic': 'component folder (outside)', 'semantic/semantic-v*': 'component folder (outside)', 'voiceprint': 'component folder (outside)', 'face/face-v*': 'component folder (outside)',
  'models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx': 'component file (outside)', 'installed.json': 'component marker (outside)', 'route.json': 'component route (outside)',
  'licenses': 'component licenses (outside)', '.done': 'component staging (outside)', '.download': 'component staging (outside)',
  '*-v*': 'component version folder (outside)', '*.*': 'component archive (outside)', 'source.json': 'component manifest (outside)',
  'asr.response.json': 'component file (outside)', 'System32/WindowsPowerShell/v1.0/powershell.exe': 'Windows system tools',
  'mcp.json': 'OS temp folder of a running task', 'a.sock': 'OS temp socket', 'p.sock': 'OS temp socket',
  'shn-assistant-': 'OS temp folder prefix', 'shn-task-': 'OS temp folder prefix', 'session-': 'OS temp folder prefix', 'turn-': 'OS temp folder prefix', 'vision-': 'OS temp folder prefix',
  '.tool-free-': 'OS temp folder prefix', '.mcp.json': 'OS temp file of a running turn', 'frame-*.*': 'OS temp images of a turn', 'pet.frame': 'in-memory frame name',
  '*.pcm': 'row voice-call-fillers (inside its folder)', '*.wav': 'row voice-keep (inside its day folders)', '*.data.json': 'row recycle-bin (inside its folder)', '*_*.frame': 'row watch-screens (inside its folder)',
  'index.json': 'row character-stickers (inside its folder)',
  'models.json': 'the codex provider cache (legacy, not written in the Claude fork)', 'job.json': 'row character-convert', 'bundle.json': 'row character-convert', 'commit.json': 'row character-convert',
  'backups': 'row character-convert', 'staging': 'row character-convert', 'mmdagent-ex': 'row model-data (library/motions)', '.old.jsonl': 'row experience-journal rotation',
  '.json': 'a file-type filter (agent channel import)', '.data.json': 'the suffix of row recycle-bin files',
  'characters.before-update-2026-11-03T06-25-30Z.json': 'an example in a comment (row card-backups)',
  'claude-chat': 'OS temp folder of a chat turn', 'selected-image-authoring': 'OS temp folder of an image turn',
  'agent-channel/soft-hearts-mcp.mjs': 'packaged MCP shim (resources)', 'agent-channel/soft-hearts-assistant-mcp.mjs': 'packaged MCP shim (resources)',
  'agent-channel/soft-hearts-task-mcp.mjs': 'packaged MCP shim (resources)', 'scripts/soft-hearts-mcp.mjs': 'the app\'s own script',
  'scripts/soft-hearts-assistant-mcp.mjs': 'the app\'s own script', 'scripts/soft-hearts-task-mcp.mjs': 'the app\'s own script',
  'System32/taskkill.exe': 'Windows system tools', 'release/desktop-development-profile.json': 'workspace release file',
  '.*.tmp': 'a temporary file in the folder the user chose for her (outside the profile)', '.*.restore.tmp': 'a temporary file in the folder the user chose for her',
  '.staging-*-v*-*': 'component staging (outside)',
  'soft-hearts-wait': 'OS temp folder of a launch waiting for a quitting instance (I-182; its own Chromium data, never the profile)',
};

function globRegex(pattern: string): RegExp {
  const body = pattern.split('').map(c => c === '*' ? '[^/]*' : c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${body}$`);
}
/**
 * A scanned name (segments, `*` = a part made at run time) is covered when it fits a window of a pattern's segments: each segment the
 * same as the pattern's (`her-note-*.json` = `her-note-${scopeId}.json`), or a whole-segment `*` taking a name made at run time. So a new
 * fixed name (`secret-diary.json`) or a new made-up one (`her-secret-${id}.json`) is never covered by accident.
 */
function covers(pattern: string, name: string): boolean {
  const p = pattern.split('/'), n = name.split('/');
  // A window starts at a segment of the very same name: a whole-segment `*` or `**` covers what is below a named folder, never a name by itself.
  const fits = (seg: string, scanned: string, first: boolean) => seg === scanned || (!first && seg === '*' && scanned.includes('*'));
  for (let k = 0; k < p.length; k++) {
    let ok = true;
    for (let i = 0; i < n.length && ok; i++) {
      const seg = p[k + i];
      if (seg === '**') { if (i > 0) return true; ok = false; break; }
      if (seg === undefined || !fits(seg, n[i], i === 0)) ok = false;
    }
    if (ok) return true;
  }
  return false;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (/\.(ts|mts)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}
const literal = /^\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*$/s;
/** `${…}` (nested braces too) → `*`. */
function normalize(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 0, j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) break; }
      out += '*'; i = j;
    } else out += text[i];
  }
  return out;
}
function topLevelArgs(src: string, open: number): string[] {
  const args: string[] = []; let depth = 0, start = open + 1, quote: string | null = null;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) { args.push(src.slice(start, i)); return args; } depth--; }
    else if (c === ',' && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return args;
}
/** Every file or folder name the main-process code may persist: path.join literals, *_FILE / *_FOLDER constants, JSON file names. */
function namesIn(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf('path.join('); at >= 0; at = src.indexOf('path.join(', at + 1)) {
    const args = topLevelArgs(src, at + 'path.join'.length).slice(1);
    let run: string[] = [];
    for (const arg of [...args, '']) {
      const m = literal.exec(arg);
      if (m) run.push(normalize(m[2]));
      else { if (run.length) out.push(run.join('/')); run = []; }
    }
  }
  for (const m of src.matchAll(/const\s+[A-Z_]*(?:FILE|FOLDER|DIRECTORY|DIR)\s*=\s*(['"`])([^'"`]+)\1/g)) if (/^[\w.*${}/-]+$/.test(m[2])) out.push(normalize(m[2]));
  for (const m of src.matchAll(/(['"`])([\w.${}()-]*\.(?:json|jsonl|frame|pcm))\1/g)) out.push(normalize(m[2]).replace(/\*+/g, '*'));
  return out.filter(Boolean);
}
async function persistedNames(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const file of await sourceFiles(path.join(ROOT, 'electron'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    for (const name of namesIn(await readFile(file, 'utf8'))) if (!found.has(name)) found.set(name, rel);
  }
  return found;
}
const covered = (name: string) => rows.some(row => row.paths.some(p => covers(p, name))) || Object.hasOwn(NOT_PROFILE_DATA, name);

test('(i) every file or folder name the main process writes is in the data map (or listed as not profile data)', async () => {
  const names = await persistedNames();
  assert.ok(names.size > 80, `the scan found only ${names.size} names: it is probably broken`);
  const missing = [...names].filter(([name]) => !covered(name));
  assert.deepEqual(missing.map(([name, where]) => `${name}  (${where})`), [],
    'add a row to electron/foundation/data-map.ts for each (what it holds, whose it is, and what each privacy action does to it)');
  assert.deepEqual(Object.keys(NOT_PROFILE_DATA).filter(name => !names.has(name)), [], 'a name the code no longer has: take it out of NOT_PROFILE_DATA');
});

test('(i) the scan catches a new store: made-up writes under the profile are found and not covered', () => {
  const src = "const a = path.join(store.directory, 'secret-diary.json');\nconst b = path.join(this.directory, `her-secret-${userProfileScopeId(scope)}.json`);\n"
    + "export const NEW_FOLDER = 'new-folder';\nconst c = new Store({ file: 'new-settings.json' });\nconst d = path.join(root, 'relationship', 'x', `${id}.json`);";
  const names = new Set(namesIn(src));
  for (const name of ['her-secret-*.json', 'new-folder', 'new-settings.json', 'relationship/x/*.json', 'secret-diary.json']) {
    assert.ok(names.has(name), `found ${name}`);
    assert.equal(covered(name), false, name);
  }
  for (const name of ['her-note-*.json', 'relationship', '*.json', 'dev/reply-latency.jsonl', 'memory-vectors']) assert.equal(covered(name), true, name);
});

test('the table is well formed: unique ids, follows point at delete rows, only outside rows leave the backup', () => {
  const ids = rows.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const row of rows) {
    assert.ok(row.paths.length > 0 && row.label && row.holds, row.id);
    if (row.characterForget === 'follows') {
      const leader = rows.find(other => other.id === row.follows);
      assert.ok(leader && (leader.characterForget === 'delete' || leader.characterForget === 'follows'), `${row.id} follows ${row.follows}`);
    } else assert.equal(row.follows, undefined, row.id);
    assert.equal(row.backup, row.scope !== 'outside-profile' && row.id !== 'voice-keep', `${row.id}: everything under the profile is in the backup, nothing outside (except the dev-only kept voice: audio, too big)`);
    if (row.cardExport === 'included') assert.equal(row.holdsUserData, false, `${row.id}: a card export never carries the user's data`);
    if (row.scope === 'outside-profile') assert.equal(row.holdsUserData, false, `${row.id}: nothing about the user outside the profile`);
  }
  assert.deepEqual(rows.filter(row => row.cardExport === 'included').map(row => row.id).sort(), ['character-cards', 'character-response']);
  assert.deepEqual(rows.filter(row => row.diagnostics !== 'never').map(row => row.id), ['dev-logs']);
});

test('I-144 the recycle column: every row a deletion removes is kept by the bin or says why not; nothing a deletion keeps is listed as kept', () => {
  for (const row of rows) {
    if (row.characterForget === 'delete' || row.characterForget === 'follows' || row.characterForget === 'with-card') assert.notEqual(row.recycle, 'stays', row.id);
    if (row.recycle === 'skip') assert.ok(row.recycleWhy && row.recycleWhy.length > 8, `${row.id}: why the bin does not keep it`);
    else assert.equal(row.recycleWhy, undefined, row.id);
    if (row.recycle === 'take') assert.ok(row.holdsUserData || row.characterForget === 'with-card' || row.id === 'memory-scopes' || row.id === 'upcoming-marks', row.id);
  }
  assert.deepEqual(rows.filter(row => row.recycle === 'skip').map(row => row.id), ['watch-screens', 'reminders', 'voiceprint']); // Unbound v1 step 3: a voiceprint is deleted for good; I-188: a reminder too
  assert.equal(rows.some(row => row.characterForget === 'pending' || row.recordingOff === 'pending'), false, 'every 待用户定 of 2026-11-16 is decided');
});

// ---- (ii) the registries follow the table ----

const NO_STORES: PrivacyStores = {
  memory: { forgetScope: async () => 0 }, profiles: null, relationship: { forget: async () => {} }, rps: { forget: () => false }, feeding: { forget: () => false },
  herNote: null, movingMemory: null, songMemory: null, semantic: null, listenTogether: null, watchTogether: null, upcoming: null, hands: null,
};
const ALL_STORES: PrivacyStores = { ...NO_STORES, profiles: { forgetScope: async () => false }, herNote: { clear: async () => {} }, movingMemory: { clear: async () => {} },
  songMemory: { clear: async () => ({}) }, semantic: { forgetCharacter: async () => {} }, listenTogether: { forgetCharacter: () => {} },
  watchTogether: { forgetCharacter: async () => {} }, upcoming: { recordingOff: async () => {} }, hands: { recordingOff: () => {} }, voiceprint: { deleteData: async () => ({}) }, reminders: { forgetCharacter: () => 0 },
  // I-144: the rows that came out of 待用户定 clear through the recycle registry's remove.
  recycle: Object.fromEntries(recycleIds().map(id => [id, { per: 'character', capture: async () => null, remove: async () => {}, restore: async () => {} }])) as unknown as RecycleRegistry };

test('(ii) the registries have exactly the rows that say delete, and each has a clear when its store runs', () => {
  const forget = characterForgetRegistry(ALL_STORES), off = recordingOffRegistry(ALL_STORES);
  assert.deepEqual(Object.keys(forget).sort(), characterForgetIds().sort());
  assert.deepEqual(Object.keys(off).sort(), recordingOffIds().sort());
  for (const [id, clear] of Object.entries(forget)) assert.ok(clear, `${id} has a clear`);
  for (const [id, clear] of Object.entries(off)) assert.ok(clear, `${id} has a clear`);
  assert.ok(characterForgetIds().includes('feeding') && characterForgetIds().includes('song-memory') && characterForgetIds().includes('memory-vectors'));
});

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-data-map-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const exists = (file: string) => stat(file).then(() => true, () => false);
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for: ${what}`);
}

const DOOMED = 'card-doomed', KEPT = 'card-kept1';
const provider = { kind: 'claude' as const, baseUrl: 'http://127.0.0.1:11434/v1', model: 'sonnet' };

test('(ii) "同时删除她的记忆" removes every delete row (and the rows that follow them) from real stores, and only hers', async () => withDirectory(async directory => {
  const providerScope = memoryProviderScope(provider);
  const scope = (characterId: string) => ({ characterId, providerScope });
  const profilesDir = path.join(directory, 'user-profiles');
  const service = new CompanionService(directory, () => {});
  const upcoming = new UpcomingStore(profilesDir, { recording: () => true });
  const reviews = new ReviewStore(profilesDir, { recording: () => true });
  const profiles = new UserProfileStore(profilesDir, { upcoming, reviews });
  const rps = new RpsStore({ file: () => path.join(directory, 'rps.json') }); await rps.load();
  const feeding = new FeedRecognitionStore({ file: () => path.join(directory, 'feed-recognition.json') }); await feeding.load();
  const herNote = new HerNoteStore(profilesDir), movingMemory = new MovingMemoryStore(profilesDir);
  const songs = new SongMemoryHost({ directory: () => directory, characterId: () => KEPT });
  const { VectorStore } = await import('../electron/memory/memory-semantic/vectors');
  const vectors = new VectorStore(directory, 'test-model');
  try {
    await service.load();
    for (const id of [DOOMED, KEPT]) {
      await service.context(id, provider, id);
      const turn = await service.begin(`${id}-t`, `给 ${id} 的话`, id, () => {}, {});
      turn.push('delta', '好。'); await turn.finish('complete');
      await service.relationship.setNickname(id, '小蓝');
      await profiles.activate(scope(id)); profiles.setEnabled(true);
      assert.equal(await profiles.saveDiary(profiles.diaryTicket()!, '2026-11-14', `${id} 的日记`), true);
      const scopeId = userProfileScopeId(scope(id));
      await writeFile(path.join(profilesDir, `upcoming-${scopeId}.json`), '{}');
      await writeFile(path.join(profilesDir, `review-${scopeId}.json`), '{}');
      rps.finish(id, { at: Date.now(), origin: 'user', result: 'her', rounds: [{ her: 'rock', user: 'scissors', outcome: 'her' }] }, true);
      feeding.note(id, { edible: true, name: '草莓', category: '水果', liking: '喜欢', summary: '草莓' } as never, Date.now(), true);
      assert.equal(await herNote.add(scope(id), { text: `${id} 的笔记`, writtenAt: 1, cutoffAt: 1 }), true);
      assert.equal(await movingMemory.add(scope(id), { date: '2026-11-14', text: `${id} 的那件事`, quoteRef: { at: 1, role: 'user' }, chosenAt: 1 }), true);
      await writeFile(path.join(directory, `song-memory-${id}.json`), '{"version":1,"songs":[]}');
      await mkdir(path.join(directory, 'memory-vectors'), { recursive: true });
      await writeFile(path.join(directory, 'memory-vectors', `${characterKey(id)}.json`), '{}');
    }
    await service.relationship.flush(); await feeding.flush();
    assert.equal(feeding.fed(DOOMED).length, 1);

    const forgotten = await forgetCharacterMemories(DOOMED, { providerScopes: () => forgettableProviderScopes(provider, memoryProviderScope),
      providerScopesOf: id => service.memory.providerScopesOf(id),
      clears: characterForgetRegistry({ ...NO_STORES, memory: service.memory, profiles, relationship: service.relationship, rps, feeding,
        herNote, movingMemory, songMemory: songs, semantic: vectors }) });
    assert.deepEqual(forgotten.failed, []);
    assert.equal(forgotten.records, 1); assert.equal(forgotten.profiles, 1);
    await feeding.flush();

    // chat-memory
    assert.equal(service.memory.list(scope(DOOMED)).records.length, 0);
    assert.equal(service.memory.list(scope(KEPT)).records.length, 1);
    assert.doesNotMatch(await readFile(path.join(directory, 'memories.jsonl'), 'utf8'), /给 card-doomed 的话/);
    // user-profile, and upcoming-plans / period-reviews that follow it
    await profiles.activate(scope(DOOMED)); assert.deepEqual(profiles.view().diary, []);
    await profiles.activate(scope(KEPT)); assert.equal(profiles.view().diary.length, 1);
    for (const prefix of ['upcoming', 'review']) {
      assert.equal(await exists(path.join(profilesDir, `${prefix}-${userProfileScopeId(scope(DOOMED))}.json`)), false, prefix);
      assert.equal(await exists(path.join(profilesDir, `${prefix}-${userProfileScopeId(scope(KEPT))}.json`)), true, prefix);
    }
    // her-note, moving-memory
    assert.equal(herNote.current(scope(DOOMED)), null); assert.equal(herNote.current(scope(KEPT))?.text, `${KEPT} 的笔记`);
    assert.equal(movingMemory.current(scope(DOOMED)), null); assert.equal(movingMemory.current(scope(KEPT))?.text, `${KEPT} 的那件事`);
    assert.doesNotMatch(await readFile(path.join(profilesDir, `her-note-${userProfileScopeId(scope(DOOMED))}.json`), 'utf8').catch(() => ''), /card-doomed 的笔记/);
    // relationship
    await assert.rejects(readFile(path.join(directory, 'relationship', `${DOOMED}.json`)), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(path.join(directory, 'relationship', `${KEPT}.json`), 'utf8')).nickname, '小蓝');
    // rps, feeding (one shared file each)
    assert.deepEqual(rps.games(DOOMED), []); assert.equal(rps.games(KEPT).length, 1);
    assert.deepEqual(feeding.fed(DOOMED), []); assert.equal(feeding.fed(KEPT).length, 1);
    const fedFile = await readFile(path.join(directory, 'feed-recognition.json'), 'utf8');
    assert.ok(!fedFile.includes(DOOMED) && fedFile.includes(KEPT));
    // song-memory, memory-vectors
    assert.equal(await exists(path.join(directory, `song-memory-${DOOMED}.json`)), false);
    assert.equal(await exists(path.join(directory, `song-memory-${KEPT}.json`)), true);
    assert.equal(await exists(path.join(directory, 'memory-vectors', `${characterKey(DOOMED)}.json`)), false);
    assert.equal(await exists(path.join(directory, 'memory-vectors', `${characterKey(KEPT)}.json`)), true);
  } finally { await service.flush().catch(() => {}); profiles.dispose(); }
}));

test('(ii) listen-together and watch-notes forget a character in their own tests (each forgets only hers)', async () => {
  // Their hosts need a running audio / screen pipeline; their own real-store tests cover forgetCharacter. If one is renamed, update here.
  for (const [file, needle] of [['tests/listen-together.test.ts', 'forgetCharacter'], ['tests/i048-watch-session.test.ts', 'forgetCharacter']] as const) {
    assert.match(await readFile(path.join(ROOT, file), 'utf8'), new RegExp(needle), file);
  }
  const covered = new Set(['chat-memory', 'memory-vectors', 'user-profile', 'her-note', 'moving-memory', 'relationship', 'rps', 'feeding', 'song-memory', 'listen-together', 'watch-notes']);
  // I-144: the rows that came out of 待用户定 (2026-11-16) are deleted through the recycle bin; tests/i144-recycle-bin.test.ts puts something of two
  // characters in each with real stores, deletes one and finds nothing of hers left, the other untouched. If it is renamed, update here.
  assert.match(await readFile(path.join(ROOT, 'tests/i144-recycle-bin.test.ts'), 'utf8'), /nothing of hers is left in place/);
  for (const id of ['memory-scopes', 'hands', 'our-things', 'people-things', 'ambient-transcripts', 'text-invitations', 'special-day', 'keepsakes', 'recycle-bin']) covered.add(id);
  // 边说边演 (2026-11-20): her beats leave with her chat; tests/speech-beats-privacy.test.ts checks the file's bytes after each deletion. If it is renamed, update here.
  assert.match(await readFile(path.join(ROOT, 'tests/speech-beats-privacy.test.ts'), 'utf8'), /nothing of those replies stays/);
  covered.add('speech-beats');
  // I-188: the reminders (one file, every character): tests/i188-moments.test.ts deletes one character's with a real store and finds the other's untouched.
  assert.match(await readFile(path.join(ROOT, 'tests/i188-moments.test.ts'), 'utf8'), /reminders of the deleted character go, the other's stay/);
  covered.add('reminders');
  assert.deepEqual(characterForgetIds().filter(id => !covered.has(id)), [], 'a new delete row needs a real-store test above');
});

test('(ii) "允许记录" off clears its rows (only the shown scope where per scope); clearing the diary clears only the rows marked for it', async () => withDirectory(async directory => {
  const providerScope = memoryProviderScope(provider);
  const scope = (characterId: string) => ({ characterId, providerScope });
  const profilesDir = path.join(directory, 'user-profiles');
  const rps = new RpsStore({ file: () => path.join(directory, 'rps.json') }); await rps.load();
  const feeding = new FeedRecognitionStore({ file: () => path.join(directory, 'feed-recognition.json') }); await feeding.load();
  const herNote = new HerNoteStore(profilesDir), movingMemory = new MovingMemoryStore(profilesDir);
  const calls: string[] = [];
  const stores: PrivacyStores = { ...NO_STORES, rps, feeding, herNote, movingMemory,
    upcoming: { recordingOff: async () => { calls.push('marks'); } }, hands: { recordingOff: () => { calls.push('hands'); } } };
  const seed = async () => {
    for (const id of [DOOMED, KEPT]) {
      rps.finish(id, { at: Date.now(), origin: 'user', result: 'her', rounds: [{ her: 'rock', user: 'scissors', outcome: 'her' }] }, true);
      feeding.note(id, { edible: true, name: '草莓', category: '水果', liking: '喜欢', summary: '草莓' } as never, Date.now(), true);
      await herNote.add(scope(id), { text: `${id} 的笔记`, writtenAt: Date.now(), cutoffAt: 1 });
      await movingMemory.add(scope(id), { date: '2026-11-14', text: `${id} 的那件事`, quoteRef: { at: 1, role: 'user' }, chosenAt: Date.now() });
    }
  };
  await seed();
  // The diary cleared: match counts and what she was fed go; her note, her bookmark, the marks and the promises stay.
  runRecordingOff(recordingOffRegistry(stores), scope(DOOMED), 'diary-cleared');
  assert.deepEqual(rps.games(DOOMED), []); assert.deepEqual(feeding.fed(DOOMED), []);
  assert.equal(rps.games(KEPT).length, 1); assert.equal(feeding.fed(KEPT).length, 1);
  assert.ok(herNote.current(scope(DOOMED))); assert.ok(movingMemory.current(scope(DOOMED))); assert.deepEqual(calls, []);
  // "允许记录" off: all of its rows, the shown scope's notes only.
  await seed();
  runRecordingOff(recordingOffRegistry(stores), scope(DOOMED), 'recording-off');
  await until(() => herNote.current(scope(DOOMED)) === null && movingMemory.current(scope(DOOMED)) === null, 'her note and bookmark cleared');
  assert.deepEqual(rps.games(DOOMED), []); assert.deepEqual(feeding.fed(DOOMED), []);
  assert.ok(herNote.current(scope(KEPT))); assert.ok(movingMemory.current(scope(KEPT)));
  assert.deepEqual(calls.sort(), ['hands', 'marks']);
  // One clear that throws does not stop the others.
  await seed(); calls.length = 0;
  runRecordingOff(recordingOffRegistry({ ...stores, rps: { forget: () => { throw new Error('disk'); } } }), scope(DOOMED), 'recording-off');
  assert.deepEqual(feeding.fed(DOOMED), []); assert.deepEqual(calls.sort(), ['hands', 'marks']);
  await feeding.flush();
}));

// ---- (iii) a card export carries nothing private ----

/** A sample path for a pattern (`*` → x, `**` → deep/x.bin). */
const sample = (pattern: string) => pattern.replace(/\*\*/g, 'deep/x.bin').replace(/\*/g, 'x');
const MARK = 'DATA-MAP-PRIVATE-MARK';

test('(iii) exporting a card never carries a private row, a path or the profile folder', async () => withDirectory(async directory => {
  for (const row of rows) {
    if (row.scope === 'outside-profile' || row.cardExport === 'included' || !row.holdsUserData) continue; // every private row
    for (const pattern of row.paths) {
      const file = path.join(directory, ...sample(pattern).split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ mark: `${MARK}-${row.id}` }) + '\n');
    }
  }
  const cards = new CharacterCardStore(directory, 'legacy');
  await cards.load({ preinstalledGene: true, freshProfile: true });
  await cards.save({ name: 'Alice', description: 'd', personality: 'p', scenario: '', greeting: '', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() });
  const alice = cards.publicState().cards.find(card => card.name === 'Alice')!;
  await cards.bindModel(alice.id, path.join(directory, 'models', 'Alice', 'alice.pmx'), 'alice.pmx');
  const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id)); await responses.load();
  const exported = new CharacterResponseService(cards, responses).export(alice.id);
  assert.doesNotMatch(exported, new RegExp(MARK));
  assert.doesNotMatch(exported, new RegExp(path.basename(directory)));
  assert.doesNotMatch(exported, /alice\.pmx|modelPath|data:image/);
  assert.match(exported, /Alice/);
}));

// ---- the record shows exactly this table ----

test('docs/data-map.md shows the current table', async () => {
  const doc = await readFile(path.join(ROOT, 'docs', 'data-map.md'), 'utf8');
  assert.ok(doc.replace(/\r\n/g, '\n').includes(renderDataMapMarkdown()),
    'regenerate the table: node node_modules/tsx/dist/cli.mjs scripts/dev/data-map-table.ts, and paste it into docs/data-map.md');
});
