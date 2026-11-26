// I-050 她的文件夹: the names, the disk operations in real temporary folders (links, junctions, sizes, versions, recycle bin,
// restore, purge), the tail block, the host's switch and tickets, and the journal line. Only temporary folders; no model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  HER_FOLDER_FILE_MAX_BYTES, HER_FOLDER_KEEP_MS, HER_FOLDER_TOTAL_MAX_BYTES, HER_FOLDER_TRASH_DIR, HER_FOLDER_VERSIONS_DIR,
  mentionsHerFolder, type HerFolderNoteView, type HerFolderView,
} from '../shared/initiative/her-folder';
import { sanitizeHerFileName } from '../electron/initiative/her-folder/names';
import { HerFolderStore, emptyManifest, type HerFolderManifest } from '../electron/initiative/her-folder/store';
import { herFolderInstruction, parseHerFileBlock } from '../electron/initiative/her-folder/proposal';
import { HerFolderHost, type HerFolderJournalInput } from '../electron/initiative/her-folder/host';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { herFolderActionLine, readHerFolderNote } from '../src/initiative/HerFolderPanel';

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = (label: string) => { const dir = mkdtempSync(path.join(os.tmpdir(), `sh-her-folder-${label}-`)); temps.push(dir); return dir; };

async function storeIn(label: string, manifest: HerFolderManifest = emptyManifest(), now = () => 1_800_000_000_000) {
  const outside = temp(`${label}-out`), parent = temp(label), folder = path.join(parent, 'gifts');
  mkdirSync(folder);
  const real = await HerFolderStore.resolveFolder(folder);
  let saved = 0;
  const store = new HerFolderStore({ folder, real, manifest, saveManifest: async () => { saved++; }, now });
  return { store, folder: real, outside, manifest, saves: () => saved };
}
const visible = (dir: string) => readdirSync(dir).filter(name => !name.startsWith('.')).sort();

// ---------------------------------------------------------------- names

test('a file name: only a plain top-level .md / .txt name survives', () => {
  for (const bad of ['../x.md', '..\\x.md', 'a/b.md', 'a\\b.md', 'C:\\x.md', 'C:x.md', '\\\\server\\share\\x.md', '/etc/x.md',
    'name.txt:stream', 'x.md:Zone.Identifier', 'CON', 'con.md', 'NUL.txt', 'nul.tar.md', 'COM1.md', 'LPT9.txt', 'CONIN$.md', 'COM¹.md',
    'trailing.md.', 'trailing.md ', ' lead.md', '.hidden.md', '..', '.', '', 'a..b.md', 'x\u0000.md', 'x\u202e.md', 'x\u200b.md', 'line\nbreak.md',
    'a'.repeat(81) + '.md', 'what?.md', 'star*.md', 'pipe|.md', 'quote".md', '<tag>.md'])
    assert.equal(sanitizeHerFileName(bad).ok, false, JSON.stringify(bad));
  for (const ext of ['x.exe', 'x.md.exe', 'x.js', 'x.html', 'x.lnk', 'x.bat', 'x.ps1', 'x.url'])
    assert.deepEqual(sanitizeHerFileName(ext), { ok: false, why: 'extension' }, ext);
  assert.deepEqual(sanitizeHerFileName('给你的信.md'), { ok: true, name: '给你的信.md' });
  assert.deepEqual(sanitizeHerFileName('Notes.TXT'), { ok: true, name: 'Notes.TXT' });
  assert.deepEqual(sanitizeHerFileName('生日快乐'), { ok: true, name: '生日快乐.md' });
  assert.deepEqual(sanitizeHerFileName('console.md'), { ok: true, name: 'console.md' }, 'only the exact device names');
  assert.equal(sanitizeHerFileName(42).ok, false);
});

// ---------------------------------------------------------------- the disk

test('a valid write creates exactly one file, atomically, with the text as given', async () => {
  const { store, folder } = await storeIn('write');
  const outcome = await store.write('给你的信.md', '亲爱的你：\n生日快乐。', 'write');
  assert.equal(outcome.ok, true);
  assert.deepEqual(visible(folder), ['给你的信.md'], 'one file, no temporary file left beside it');
  assert.equal(readFileSync(path.join(folder, '给你的信.md'), 'utf8'), '亲爱的你：\n生日快乐。');
  assert.equal(outcome.ok && outcome.action.kind, 'created');
  assert.equal(outcome.ok && outcome.action.userFile, false);
});

test('traversal, absolute, UNC, stream, device and wrong-extension names write nothing anywhere', async () => {
  const { store, folder, outside } = await storeIn('names');
  const escape = path.relative(folder, path.join(outside, 'escaped.md'));
  for (const name of [escape, '../escaped.md', path.join(outside, 'escaped.md'), '\\\\localhost\\c$\\escaped.md', 'escaped.md:ads', 'CON.md', 'escaped.md.', 'escaped.exe']) {
    const outcome = await store.write(name, 'x', 'write');
    assert.equal(outcome.ok, false, name);
  }
  assert.deepEqual(readdirSync(folder), []);
  assert.deepEqual(readdirSync(outside), []);
});

test('a junction inside the folder pointing outside is refused (write, append, delete), and nothing outside changes', async () => {
  const { store, folder, outside } = await storeIn('junction');
  writeFileSync(path.join(outside, 'keep.md'), 'outside');
  symlinkSync(outside, path.join(folder, 'link.md'), 'junction');
  for (const op of [() => store.write('link.md', 'x', 'write'), () => store.write('link.md', 'x', 'append'), () => store.trash('link.md')]) {
    const outcome = await op();
    assert.deepEqual(outcome, { ok: false, why: 'link' });
  }
  assert.deepEqual(readdirSync(outside), ['keep.md']);
  assert.equal(readFileSync(path.join(outside, 'keep.md'), 'utf8'), 'outside');
});

test('a junction in place of her hidden subfolder is refused before anything is copied into it', async () => {
  const { store, folder, outside } = await storeIn('hidden-junction');
  assert.equal((await store.write('a.md', 'one', 'write')).ok, true);
  symlinkSync(outside, path.join(folder, HER_FOLDER_VERSIONS_DIR), 'junction');
  assert.deepEqual(await store.write('a.md', 'two', 'write'), { ok: false, why: 'link' });
  assert.equal(readFileSync(path.join(folder, 'a.md'), 'utf8'), 'one');
  assert.deepEqual(readdirSync(outside), []);
});

test('a file symlink inside the folder is refused (skipped where this account may not make symlinks)', async t => {
  const { store, folder, outside } = await storeIn('symlink');
  writeFileSync(path.join(outside, 'target.md'), 'outside');
  try { symlinkSync(path.join(outside, 'target.md'), path.join(folder, 'link.md'), 'file'); }
  catch { t.skip('symlinks need developer mode or admin here'); return; }
  assert.deepEqual(await store.write('link.md', 'x', 'write'), { ok: false, why: 'link' });
  assert.deepEqual(await store.trash('link.md'), { ok: false, why: 'link' });
  assert.equal(readFileSync(path.join(outside, 'target.md'), 'utf8'), 'outside');
});

test('the folder swapped for a junction elsewhere after it was chosen: nothing is written', async () => {
  const parent = temp('moved'), outside = temp('moved-out'), folder = path.join(parent, 'gifts');
  mkdirSync(folder);
  const store = new HerFolderStore({ folder, real: await HerFolderStore.resolveFolder(folder), manifest: emptyManifest(), saveManifest: async () => {} });
  rmSync(folder, { recursive: true });
  symlinkSync(outside, folder, 'junction');
  assert.deepEqual(await store.write('a.md', 'x', 'write'), { ok: false, why: 'moved' });
  assert.deepEqual(readdirSync(outside), []);
});

test('size limits: one file over 200 KB, an append past it, and her total over 20 MB write nothing', async () => {
  const manifest = emptyManifest();
  const { store, folder } = await storeIn('size', manifest);
  assert.deepEqual(await store.write('big.md', 'x'.repeat(HER_FOLDER_FILE_MAX_BYTES + 1), 'write'), { ok: false, why: 'size' });
  assert.equal((await store.write('grow.md', 'x'.repeat(HER_FOLDER_FILE_MAX_BYTES - 10), 'write')).ok, true);
  assert.deepEqual(await store.write('grow.md', 'y'.repeat(20), 'append'), { ok: false, why: 'size' });
  assert.equal(readFileSync(path.join(folder, 'grow.md'), 'utf8').length, HER_FOLDER_FILE_MAX_BYTES - 10);
  // Her copies kept so far already fill the total.
  manifest.backups.full = { kind: 'version', file: 'none.md', name: 'none.md', at: 0, bytes: HER_FOLDER_TOTAL_MAX_BYTES, hers: true, expiresAt: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(await store.write('more.md', 'z', 'write'), { ok: false, why: 'total' });
  assert.equal(existsSync(path.join(folder, 'more.md')), false);
});

test("changing the user's file keeps the original in .她的旧版本 with no end; her own earlier version for 30 days", async () => {
  const manifest = emptyManifest();
  let now = 1_800_000_000_000;
  const { store, folder } = await storeIn('versions', manifest, () => now);
  writeFileSync(path.join(folder, '清单.md'), '用户自己写的');
  const changed = await store.write('清单.md', '她改过的', 'write');
  assert.equal(changed.ok && changed.action.userFile, true);
  assert.equal(changed.ok && changed.action.restore, 'version');
  const versions = readdirSync(path.join(folder, HER_FOLDER_VERSIONS_DIR));
  assert.equal(versions.length, 1);
  assert.equal(readFileSync(path.join(folder, HER_FOLDER_VERSIONS_DIR, versions[0]), 'utf8'), '用户自己写的');
  assert.equal(Object.values(manifest.backups)[0].expiresAt, null, "a user's original is kept until the user removes it");
  // Now the file is hers: her next change keeps her version for 30 days.
  assert.equal((await store.write('清单.md', '她又改了', 'write')).ok, true);
  const hers = Object.values(manifest.backups).find(backup => backup.expiresAt !== null)!;
  assert.equal(hers.hers, true);
  assert.equal(hers.expiresAt, now + HER_FOLDER_KEEP_MS);
  // 31 days later her version is gone; the user's original stays.
  now += HER_FOLDER_KEEP_MS + 86_400_000;
  assert.equal(await store.purge(), 1);
  const left = readdirSync(path.join(folder, HER_FOLDER_VERSIONS_DIR));
  assert.equal(left.length, 1);
  assert.equal(readFileSync(path.join(folder, HER_FOLDER_VERSIONS_DIR, left[0]), 'utf8'), '用户自己写的');
});

test('a file she wrote and the user then changed counts as the user\'s again (its new original is kept)', async () => {
  const manifest = emptyManifest();
  const { store, folder } = await storeIn('user-edit', manifest);
  await store.write('诗.md', '她写的', 'write');
  writeFileSync(path.join(folder, '诗.md'), '用户补了一句，变长了');
  const outcome = await store.write('诗.md', '她再写', 'write');
  assert.equal(outcome.ok && outcome.action.userFile, true);
  assert.ok(Object.values(manifest.backups).some(backup => backup.expiresAt === null && !backup.hers));
});

test('delete moves to .她的回收站, restore brings it back, and a bin item is removed after 30 days', async () => {
  const manifest = emptyManifest();
  let now = 1_800_000_000_000;
  const { store, folder } = await storeIn('trash', manifest, () => now);
  await store.write('留言.txt', '一句话', 'write');
  const trashed = await store.trash('留言.txt');
  assert.equal(trashed.ok && trashed.action.restore, 'trash');
  assert.deepEqual(visible(folder), []);
  assert.equal(readdirSync(path.join(folder, HER_FOLDER_TRASH_DIR)).length, 1);
  const restored = await store.restore(trashed.ok ? trashed.action.id : '');
  assert.equal(restored.ok, true);
  assert.equal(readFileSync(path.join(folder, '留言.txt'), 'utf8'), '一句话');
  assert.deepEqual(readdirSync(path.join(folder, HER_FOLDER_TRASH_DIR)), []);
  // Trash again and let 31 days pass: the bin item is removed for good.
  await store.trash('留言.txt');
  now += HER_FOLDER_KEEP_MS + 1;
  assert.equal(await store.purge(), 1);
  assert.deepEqual(readdirSync(path.join(folder, HER_FOLDER_TRASH_DIR)), []);
  assert.deepEqual(await store.trash('留言.txt'), { ok: false, why: 'missing' });
});

test('restoring a version puts the earlier text back and keeps what was there (so the restore can be undone)', async () => {
  const { store, folder } = await storeIn('restore-version');
  await store.write('信.md', '第一版', 'write');
  const second = await store.write('信.md', '第二版', 'write');
  const restored = await store.restore(second.ok ? second.action.id : '');
  assert.equal(restored.ok, true);
  assert.equal(readFileSync(path.join(folder, '信.md'), 'utf8'), '第一版');
  const kept = readdirSync(path.join(folder, HER_FOLDER_VERSIONS_DIR)).map(file => readFileSync(path.join(folder, HER_FOLDER_VERSIONS_DIR, file), 'utf8')).sort();
  assert.deepEqual(kept, ['第一版', '第二版']);
  assert.deepEqual(await store.restore('no-such-action'), { ok: false, why: 'missing' });
});

test('append adds to the end of a file (her own, or the user\'s with its original kept)', async () => {
  const { store, folder } = await storeIn('append');
  writeFileSync(path.join(folder, '日记.md'), '第一行');
  const outcome = await store.write('日记.md', '第二行', 'append');
  assert.equal(outcome.ok && outcome.action.kind, 'appended');
  assert.equal(readFileSync(path.join(folder, '日记.md'), 'utf8'), '第一行\n第二行');
});

// ---------------------------------------------------------------- the tail block and the turn's text

const protocolFor = (instruction: ((s: string, e: string) => string) | null) => new MoodReplyProtocol(() => {}, { settingProposal: { instruction: null }, herFolder: { instruction } });
const run = (protocol: MoodReplyProtocol, reply: string, allow = true) => {
  const shown: string[] = [];
  (protocol as any).emit = (text: string) => shown.push(text);
  protocol.push(reply);
  protocol.finish(allow);
  return shown.join('');
};
const nonceOf = (protocol: MoodReplyProtocol) => protocol.start.slice('<sh-state-'.length, -1);
const tail = (protocol: MoodReplyProtocol) => `${protocol.start}{"context":"positive","delta":{"O":1},"reason":"写信","confidence":0.9}${protocol.end}`;

test('a valid file block after the state tail is handed over raw and never shown', () => {
  const protocol = protocolFor((s, e) => `FILE ${s}${e}`);
  const nonce = nonceOf(protocol);
  const shown = run(protocol, `我写好啦，放在文件夹里了。\n${tail(protocol)}<sh-file-${nonce}>{"op":"write","name":"给你的信.md"}\n亲爱的你\n第二行\n</sh-file-${nonce}>`);
  assert.equal(shown, '我写好啦，放在文件夹里了。');
  assert.deepEqual(parseHerFileBlock(protocol.herFileProposal()), { op: 'write', name: '给你的信.md', content: '亲爱的你\n第二行' });
});

test('a block with another nonce, before the state tail, unclosed, or on a cancelled turn hands nothing over (and is never shown)', () => {
  const foreign = protocolFor((s, e) => `FILE ${s}${e}`);
  assert.equal(run(foreign, `好的。\n${tail(foreign)}<sh-file-0123456789abcdef0123456789abcdef>{"op":"write","name":"a.md"}\nx</sh-file-0123456789abcdef0123456789abcdef>`), '好的。');
  assert.equal(foreign.herFileProposal(), null);
  const before = protocolFor((s, e) => `FILE ${s}${e}`), n1 = nonceOf(before);
  assert.equal(run(before, `好的。\n<sh-file-${n1}>{"op":"write","name":"a.md"}\nx</sh-file-${n1}>${tail(before)}`), '好的。');
  assert.equal(before.herFileProposal(), null);
  const open = protocolFor((s, e) => `FILE ${s}${e}`), n2 = nonceOf(open);
  run(open, `好的。\n${tail(open)}<sh-file-${n2}>{"op":"write","name":"a.md"}\nx`);
  assert.equal(open.herFileProposal(), null);
  const cancelled = protocolFor((s, e) => `FILE ${s}${e}`), n3 = nonceOf(cancelled);
  run(cancelled, `好的。\n${tail(cancelled)}<sh-file-${n3}>{"op":"write","name":"a.md"}\nx</sh-file-${n3}>`, false);
  assert.equal(cancelled.herFileProposal(), null);
  // No folder on this turn: a block is still hidden, and nothing is handed over.
  const off = new MoodReplyProtocol(() => {}, { settingProposal: { instruction: null } }), n4 = nonceOf(off);
  assert.equal(run(off, `好的。\n${tail(off)}<sh-file-${n4}>{"op":"write","name":"a.md"}\nx</sh-file-${n4}>`), '好的。');
  assert.equal(off.herFileProposal(), null);
});

test('the block parser is strict', () => {
  assert.equal(parseHerFileBlock('{"op":"write","name":"a.md"}'), null, 'write needs text');
  assert.equal(parseHerFileBlock('{"op":"run","name":"a.md"}\nx'), null);
  assert.equal(parseHerFileBlock('{"op":"write","name":"a.md","path":"C:/x"}\nx'), null);
  assert.equal(parseHerFileBlock('{"op":"delete","name":"a.md"}\nnot empty'), null);
  assert.equal(parseHerFileBlock('not json\nx'), null);
  assert.equal(parseHerFileBlock('{"op":"write","name":"a.md"}\n' + 'x'.repeat(HER_FOLDER_FILE_MAX_BYTES + 1)), null);
  assert.deepEqual(parseHerFileBlock('{"op":"delete","name":"a.md"}\n'), { op: 'delete', name: 'a.md', content: '' });
});

// Pinned before I-050 (sha256 of the instruction with the nonce replaced by N): ordinary turns must not change by a byte.
// 2026-11-25 rules removal: the two entries with small actions offered were re-pinned on purpose ("不必每轮都有" left the gesture sentence; old 2e6f0e81…a162, 0b94b2b3…3ca).
const PINNED: Array<[object, string]> = [
  [{}, '281d9ed9942fcd797bfdcafe71fbe63ad4b7012d3b153a4908d424595d9177cc'],
  [{ settingProposal: { instruction: null }, userText: '你好', chineseChat: true }, '281d9ed9942fcd797bfdcafe71fbe63ad4b7012d3b153a4908d424595d9177cc'],
  [{ settingProposal: { instruction: null }, opening: 'fixed', reminderAt: 'lead', actions: ['wave', 'nod'] }, 'c27f046a9b5c0aae6fe967998d9c135671a198010fb3062dd324d575693dbc6d'],
  // 2026-11-23: the reminder at the end (the app's default): the same text without that sentence, plus the closing slot (buildCodexChatPrompt turns it into the last line)
  [{ settingProposal: { instruction: null }, opening: 'fixed', actions: ['wave', 'nod'] }, '26348c6d5a4d0d7ce2b5424fa1e3e6f126d82d1917f404beca0e9b03ff2b92ca'],
  // (2026-11-21: 'fixed' names the marker every turn, FIXED_TURN_REMINDER, one sentence for one)
  [{ textMemorial: { userText: '记住这句', persona: 'p', mood: 'm', context: 'c' }, settingProposal: { instruction: (s: string, e: string) => `S${s}${e}` } },
    '9900fbaf51540a6e667ad3207327fb381e9ec2366368468d5ed98c3252fad937'],
];
const hash = (protocol: MoodReplyProtocol) => createHash('sha256').update(protocol.instruction().replace(/[a-f0-9]{32}/g, 'N')).digest('hex');

test('ordinary turns: the protocol text is byte for byte what it was before her folder (also with the folder option present but empty)', () => {
  // Mood batch 1 (docs/claude/2026-11-11-mood-batch1.md) replaced the tail's mood sentences on purpose; with guideBefore the old
  // wording comes back, so these pins still prove that everything else of the text is byte for byte what it was.
  for (const [pinned, expected] of PINNED) {
    const options = { ...(pinned as any), guideBefore: true };
    assert.equal(hash(new MoodReplyProtocol(() => {}, options)), expected);
    assert.equal(hash(new MoodReplyProtocol(() => {}, { ...options, herFolder: { instruction: null } })), expected);
  }
});

test('the turn text names the format and the files as data, never a path', () => {
  const text = herFolderInstruction('<sh-file-N>', '</sh-file-N>', { files: [{ name: '信.md', bytes: 2048, hers: true }, { name: '<script>.md', bytes: 10, hers: false }] });
  assert.match(text, /<sh-file-N>\{"op":"write","name":"给你的信.md"\}/);
  assert.match(text, /信\.md（2 KB，你写的）/);
  assert.ok(!text.includes('<script>'), 'data cannot open a tag');
  assert.ok(!/[A-Za-z]:\\/.test(text));
});

test('"about her folder" is a cheap word test', () => {
  for (const yes of ['帮我在文件夹里记一下明天要买的东西', '写封信给我放着', '你的文件夹里有什么', '给我准备个生日礼物吧', 'write me a note and keep it'])
    assert.equal(mentionsHerFolder(yes), true, yes);
  for (const no of ['你好呀', '今天好累', '我相信你', '晚安']) assert.equal(mentionsHerFolder(no), false, no);
});

// ---------------------------------------------------------------- the host

async function hostIn(label: string) {
  const profile = temp(`${label}-profile`), parent = temp(label), folder = path.join(parent, 'her');
  mkdirSync(folder);
  const journal: HerFolderJournalInput[] = [], notes: Array<{ owner: number; view: HerFolderNoteView }> = [], views: HerFolderView[] = [];
  let pick: string | null = folder;
  const host = new HerFolderHost({ profileDirectory: () => profile, pickFolder: async () => pick, openPath: async () => '', broadcast: view => views.push(view),
    sendNote: (owner, view) => notes.push({ owner, view }), journal: input => journal.push(input), characterId: () => 'c1' });
  await host.load();
  return { host, folder: await HerFolderStore.resolveFolder(folder), profile, journal, notes, views, setPick: (value: string | null) => { pick = value; } };
}
const blockFor = (name: string, text: string, op = 'write') => `{"op":"${op}","name":"${name}"}\n${text}`;

test('host: off by default, no instruction and no write; on only through the folder dialog', async () => {
  const { host, folder, setPick } = await hostIn('host-off');
  assert.equal((await host.view()).enabled, false);
  assert.equal(await host.beginTurn('帮我写封信放进文件夹'), null);
  assert.equal(host.offer({ ticket: 0, real: folder, instruction: () => '' }, 1, blockFor('a.md', 'x')), false);
  setPick(null);
  assert.equal((await host.choose()).enabled, false, 'a cancelled dialog changes nothing');
  setPick(folder);
  const on = await host.choose();
  assert.equal(on.enabled, true);
  assert.equal(on.folder, folder);
  assert.equal(await host.beginTurn('今天好累'), null, 'a message not about the folder gets nothing new');
  assert.deepEqual(readdirSync(folder), []);
});

test('host: a valid block of a current turn writes one file, sends the note, and journals the name and size only', async () => {
  const { host, folder, journal, notes } = await hostIn('host-write');
  await host.choose();
  const turn = await host.beginTurn('写封信给我放在你的文件夹里');
  assert.ok(turn);
  assert.match(turn!.instruction('<s>', '</s>'), /还是空的/);
  assert.equal(host.offer(turn, 7, blockFor('给你的信.md', '秘密的内容')), true);
  await host.idle();
  assert.deepEqual(readdirSync(folder), ['给你的信.md']);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].owner, 7);
  assert.equal(notes[0].view.name, '给你的信.md');
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0], { type: 'her-folder', characterId: 'c1', action: 'created', name: '给你的信.md', bytes: Buffer.byteLength('秘密的内容'), userFile: false, by: 'her' });
  assert.ok(!JSON.stringify(journal).includes('秘密'));
  // The record in the profile has names and sizes only.
  assert.ok(!readFileSync(path.join((host as any).options.profileDirectory(), 'her-folder.json'), 'utf8').includes('秘密'));
});

test('host: a turn from before the switch went off (or another folder) writes nothing, also when it was already queued', async () => {
  const { host, folder, journal, setPick } = await hostIn('host-stale');
  await host.choose();
  const early = await host.beginTurn('帮我记在文件夹里');
  await host.turnOff();
  assert.equal(host.offer(early, 1, blockFor('a.md', 'x')), false);
  assert.equal(await host.beginTurn('帮我记在文件夹里'), null, 'off: no instruction');
  await host.choose();
  const queued = await host.beginTurn('帮我记在文件夹里');
  assert.equal(host.offer(queued, 1, blockFor('b.md', 'x')), true);
  void host.turnOff(); // before the queued write runs
  await host.idle();
  assert.deepEqual(readdirSync(folder), []);
  assert.ok(journal.some(line => line.action === 'refused' && line.why === 'stale'));
  // Another folder chosen: the old turn's ticket is stale.
  const other = temp('host-stale-other');
  await host.choose();
  const old = await host.beginTurn('帮我记在文件夹里');
  setPick(other);
  await host.choose();
  assert.equal(host.offer(old, 1, blockFor('c.md', 'x')), false);
  await host.idle();
  assert.deepEqual(readdirSync(other), []);
});

test('host: a malformed block or a refused name writes nothing and says why in the journal (no name)', async () => {
  const { host, folder, journal } = await hostIn('host-bad');
  await host.choose();
  const turn = await host.beginTurn('帮我记在文件夹里');
  assert.equal(host.offer(turn, 1, 'not a block'), false);
  assert.equal(host.offer(turn, 1, blockFor('../evil.md', 'x')), true);
  await host.idle();
  assert.deepEqual(readdirSync(folder), []);
  assert.deepEqual(journal.map(line => [line.action, line.why, line.name]), [['refused', 'malformed', undefined], ['refused', 'name', undefined]]);
});

test('host: restore from the control page, and the note button opens only from its own window', async () => {
  const { host, folder } = await hostIn('host-restore');
  await host.choose();
  const turn = await host.beginTurn('帮我在文件夹里写');
  host.offer(turn, 3, blockFor('a.md', 'one'));
  await host.idle();
  const turn2 = await host.beginTurn('帮我在文件夹里改一下 a.md');
  assert.match(turn2!.instruction('<s>', '</s>'), /one/, 'a file the message names comes with its text');
  host.offer(turn2, 3, blockFor('a.md', 'two'));
  await host.idle();
  const view = await host.view();
  const changed = view.actions.find(action => action.kind === 'changed')!;
  assert.equal(changed.restore, 'version');
  await host.restore(changed.id);
  assert.equal(readFileSync(path.join(folder, 'a.md'), 'utf8'), 'one');
  const noteId = (host as any).note.view.noteId;
  await assert.rejects(host.openFromNote(4, { noteId }), /未授权/);
  assert.equal(await host.openFromNote(3, { noteId: 'other' }), false);
  assert.equal(await host.openFromNote(3, { noteId }), true);
});

test('host: the switch survives a restart (path kept host-side), and off stays off', async () => {
  const { host, profile } = await hostIn('host-reload');
  await host.choose();
  const again = new HerFolderHost({ profileDirectory: () => profile, pickFolder: async () => null, openPath: async () => '', broadcast: () => {}, sendNote: () => {} });
  await again.load();
  assert.equal((await again.view()).enabled, true);
  await again.turnOff();
  const third = new HerFolderHost({ profileDirectory: () => profile, pickFolder: async () => null, openPath: async () => '', broadcast: () => {}, sendNote: () => {} });
  await third.load();
  assert.equal((await third.view()).enabled, false);
  assert.equal(await third.beginTurn('帮我记在文件夹里'), null);
});

// ---------------------------------------------------------------- journal and renderer

test('journal: one line with the name and size; content, paths and odd names are refused', () => {
  const at = 1_800_000_000_000;
  const line = buildJournalEntry({ type: 'her-folder', characterId: 'c1', action: 'created', name: '信.md', bytes: 2048, userFile: false, by: 'her', content: '秘密' }, at);
  assert.ok(line);
  assert.ok(!JSON.stringify(line).includes('秘密'));
  assert.match(describeJournalEntry(line!, (s: string, ...v: readonly unknown[]) => s.replace(/\{(\d)\}/g, (_m, i) => String(v[Number(i)]))), /信\.md（2\.0 KB）/);
  for (const name of ['C:/x/信.md', '../信.md', '信.exe', '.hidden.md', 'a\\b.md'])
    assert.equal(buildJournalEntry({ type: 'her-folder', characterId: 'c1', action: 'created', name, bytes: 1, by: 'her' }, at), null, name);
  assert.ok(buildJournalEntry({ type: 'her-folder', characterId: null, action: 'refused', why: 'link', by: 'her' }, at));
  assert.equal(buildJournalEntry({ type: 'her-folder', characterId: null, action: 'refused', why: 'whatever', by: 'her' }, at), null);
});

test('renderer: only a well-formed note is shown; the action line has no content', () => {
  assert.equal(readHerFolderNote({ kind: 'her-folder-note', version: 1, noteId: 'n', action: 'created', name: 'a.md', state: 'open', extra: 1 })?.name, 'a.md');
  assert.equal(readHerFolderNote({ kind: 'her-folder-note', version: 1, noteId: 'n', action: 'run', name: 'a.md', state: 'open' }), null);
  assert.equal(readHerFolderNote({ kind: 'take-me-there', version: 1, noteId: 'n', action: 'created', name: 'a.md', state: 'open' }), null);
  const line = herFolderActionLine({ id: 'a', at: 1_800_000_000_000, kind: 'changed', name: '信.md', bytes: 2048, userFile: true, restore: 'version' },
    (s: string, ...v: readonly unknown[]) => s.replace(/\{(\d)\}/g, (_m, i) => String(v[Number(i)])));
  assert.match(line, /改了「信\.md」· 2\.0 KB（你的文件，原来的留了一份）/);
});
