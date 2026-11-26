// I-056: while her folder has never been turned on, a message asking
// her to write or keep something adds one optional line to that turn; only a reply that really mentions the folder gets the
// 「带我去」 button and ends it. Real temporary profiles; no model calls.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { asksHerToKeepSomething } from '../shared/initiative/her-folder';
import { HER_FOLDER_HINT_LINE, HER_FOLDER_HINT_MAX, readMentions } from '../electron/initiative/her-folder/mention';
import { HerFolderHost, type HerFolderJournalInput } from '../electron/initiative/her-folder/host';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_HER_FOLDER_UI_COPY } from '../shared/foundation/ui-copy.her-folder.en';

const temps: string[] = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = (label: string) => { const dir = mkdtempSync(path.join(os.tmpdir(), `sh-her-mention-${label}-`)); temps.push(dir); return dir; };

async function hostIn(label: string, profile = temp(`${label}-profile`)) {
  const parent = temp(label), folder = path.join(parent, 'her');
  mkdirSync(folder, { recursive: true });
  const journal: HerFolderJournalInput[] = [];
  let character: string | null = 'c1';
  const host = new HerFolderHost({ profileDirectory: () => profile, pickFolder: async () => folder, openPath: async () => '', broadcast: () => {},
    sendNote: () => {}, journal: input => journal.push(input), characterId: () => character });
  await host.load();
  return { host, profile, journal, setCharacter: (id: string | null) => { character = id; } };
}

const ASK = '帮我写一份周末清单吧';
const MENTIONS = '好呀，周末先睡个懒觉……要是你给我一个文件夹，这种清单我就能替你收着了。';
const PLAIN = '好呀，周末先睡个懒觉，再去买菜。';

test('the topic: asking her to write or keep something counts; a plain mention of a file or a place does not', () => {
  for (const text of ['帮我写一份周末清单', '给我写封信吧', '这个帮我记下来', '能不能替我存起来', '生日礼物你准备了吗', '你的文件夹在哪', '写一首诗给我'])
    assert.equal(asksHerToKeepSomething(text), true, text);
  for (const text of ['这个文件好大', '我把杯子放在桌上了', '今天好累', '你记得我昨天说的吗', '', 42])
    assert.equal(asksHerToKeepSomething(text), false, String(text));
});

test('never turned on: the line comes on a related message, and only then; she decides whether to say it', async () => {
  const { host } = await hostIn('hint');
  assert.equal(host.beginHint('今天好累'), null, 'an unrelated message gets nothing');
  const turn = host.beginHint(ASK);
  assert.ok(turn);
  assert.equal(turn!.line, HER_FOLDER_HINT_LINE);
  assert.match(turn!.line, /只提一次/);
  assert.match(turn!.line, /别说已经保存了/);
  // Her reply did not mention it: no button, the chance is spent, the topic may come back.
  assert.equal(host.hintDone(turn, PLAIN), false);
  assert.deepEqual(host.mentionState('c1'), { hints: 1, done: false });
});

test('her reply mentions the folder: the button may show once, then no more lines for her', async () => {
  const { host, journal } = await hostIn('done');
  const turn = host.beginHint(ASK);
  assert.equal(host.hintDone(turn, MENTIONS), true);
  assert.deepEqual(host.mentionState('c1'), { hints: 1, done: true });
  assert.equal(host.beginHint(ASK), null, 'mentioned once: never again');
  assert.equal(host.hintDone(turn, MENTIONS), false, 'already done: no second button and no second line');
  assert.equal(host.hintDone(null, MENTIONS), false, 'no hint turn: nothing');
  // One journal line, nothing of the reply in it.
  const lines = journal.filter(line => line.action === 'mentioned');
  assert.equal(lines.length, 1);
  assert.ok(!JSON.stringify(lines).includes('清单'));
});

test('at most HER_FOLDER_HINT_MAX turns carry the line when she keeps judging it unrelated', async () => {
  const { host } = await hostIn('max');
  for (let i = 0; i < HER_FOLDER_HINT_MAX; i++) { const turn = host.beginHint(ASK); assert.ok(turn, `turn ${i}`); host.hintDone(turn, PLAIN); }
  assert.equal(host.beginHint(ASK), null);
  assert.deepEqual(host.mentionState('c1'), { hints: HER_FOLDER_HINT_MAX, done: false });
});

test('turned on once (even if off again), on now, or no character: no line; turned on while she was replying: no button', async () => {
  const on = await hostIn('on');
  await on.host.choose();
  assert.equal(on.host.beginHint(ASK), null, 'on: the folder itself handles such messages');
  await on.host.turnOff();
  assert.equal(on.host.beginHint(ASK), null, 'the user has turned it on before: they know it');

  const racing = await hostIn('racing');
  const turn = racing.host.beginHint(ASK);
  await racing.host.choose();
  assert.equal(racing.host.hintDone(turn, MENTIONS), false);

  const nobody = await hostIn('nobody');
  nobody.setCharacter(null);
  assert.equal(nobody.host.beginHint(ASK), null);
});

test('per character, and switched character before the reply ended: no button', async () => {
  const { host, setCharacter } = await hostIn('chars');
  const turn = host.beginHint(ASK);
  host.hintDone(host.beginHint(ASK) ?? turn, MENTIONS); // c1 is done
  setCharacter('c2');
  const other = host.beginHint(ASK);
  assert.ok(other, 'the other character may still mention it');
  setCharacter('c1');
  assert.equal(host.hintDone(other, MENTIONS), false, 'the reply ended under another character');
  assert.equal(host.mentionState('c2').done, false);
});

test('the record survives a restart; a damaged record only means she may still mention it', async () => {
  const first = await hostIn('reload');
  first.host.hintDone(first.host.beginHint(ASK), MENTIONS);
  await first.host.idle(); // the queued save has reached the disk
  const saved = JSON.parse(readFileSync(path.join(first.profile, 'her-folder.json'), 'utf8'));
  assert.deepEqual(saved.mentions, { c1: { hints: 1, done: true } });
  assert.equal(JSON.stringify(saved).includes('清单'), false, 'nothing of the chat is kept');
  const again = await hostIn('reload-2', first.profile);
  assert.equal(again.host.beginHint(ASK), null);
  assert.deepEqual(readMentions({ c1: { hints: 99, done: 'yes' }, '': { hints: 1 }, c3: null }), { c1: { hints: HER_FOLDER_HINT_MAX, done: false } });
  assert.deepEqual(readMentions('broken'), {});
});

test('idle() waits for a slow save: the record is on disk when it settles (what the restart test relies on)', async () => {
  const profile = temp('slow-profile'), folder = path.join(temp('slow'), 'her');
  mkdirSync(folder, { recursive: true });
  const host = new HerFolderHost({ profileDirectory: () => profile, pickFolder: async () => folder, openPath: async () => '', broadcast: () => {},
    sendNote: () => {}, journal: () => {}, characterId: () => 'c1',
    writeAtomic: async (file, data) => { await new Promise(resolve => setTimeout(resolve, 150)); writeFileSync(file, data); } });
  await host.load();
  host.hintDone(host.beginHint(ASK), MENTIONS);
  await host.idle();
  assert.deepEqual(JSON.parse(readFileSync(path.join(profile, 'her-folder.json'), 'utf8')).mentions, { c1: { hints: 1, done: true } });
});

test('the reply protocol: the line is in her private context only on such a turn, and changes nothing else', () => {
  const plain = new MoodReplyProtocol(() => {}).instruction();
  const hinted = new MoodReplyProtocol(() => {}, { folderHint: HER_FOLDER_HINT_LINE }).instruction();
  assert.equal(plain.includes('她的文件夹'), false);
  const noNonce = (text: string) => text.replace(/sh-state-[0-9a-f]+/gu, 'sh-state-N'); // each protocol has its own marker
  assert.equal(noNonce(hinted), noNonce(`${plain}\n${HER_FOLDER_HINT_LINE}`));
});

test('journal: the "mentioned" line holds only the fact, and has its English copy', () => {
  const at = 1_800_000_000_000;
  const line = buildJournalEntry({ type: 'her-folder', characterId: 'c1', action: 'mentioned', by: 'her', name: '秘密.md', bytes: 5 }, at);
  assert.ok(line);
  assert.equal(JSON.stringify(line).includes('秘密'), false);
  const text = describeJournalEntry(line!, (s: string, ...v: readonly unknown[]) => s.replace(/\{(\d)\}/g, (_m, i) => String(v[Number(i)])));
  assert.match(text, /她的文件夹还没开，她顺口提了一次/);
  assert.ok(ENGLISH_HER_FOLDER_UI_COPY['她的文件夹还没开，她顺口提了一次']);
});
