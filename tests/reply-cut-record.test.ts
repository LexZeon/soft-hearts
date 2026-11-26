// and (docs/claude/2026-11-23-i204-barge-in.md, "被打断的回复：存整条，记打断位置和原因"):
// the generic cut record. One small typed record per interrupted reply (where, closed cause), filed beside the whole reply; the quiet marker in the
// chat window and in her history is made from it; her next turn's facts state the cause and give no instruction. Nothing here is her words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CUT_CAUSES, cleanCut, cutMarkerText, cutPlace, shiftCut, withCutMarker, type CutRecord } from '../shared/foundation/reply-cut';
import { callCutNote, cutRecordNote } from '../shared/voice/call-cut-note';
import { SPEECH_BEATS_FILE, SpeechBeatArchive, speechBeatScopeKey } from '../electron/brain/speech-beats/archive';
import { recordReplyCut } from '../electron/brain/speech-beats/cuts';
import { speechBeatsFor } from '../electron/brain/speech-beats/host';
import { cleanChatRows, cleanRowCut } from '../src/brain/chat-continuity';
import { VoiceCallHost } from '../electron/voice/voice-call/host';

const scope = { characterId: 'c1', providerScope: 'p1' }, other = { characterId: 'c2', providerScope: 'p1' };
const reply = '好哒，今天天气很好。我们去公园散步吧。然后一起吃晚饭。';
const s1 = reply.indexOf('我们'), s1End = reply.indexOf('然后');
const inSentence: CutRecord = { cause: 'user-spoke', known: true, saidEnd: s1, sentenceEnd: s1End };
const between: CutRecord = { cause: 'pulled-away', known: true, saidEnd: s1End, sentenceEnd: s1End };
const lost: CutRecord = { cause: 'could-not-reach', known: false, saidEnd: 0, sentenceEnd: 0 };

async function inDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-cut-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('record: closed causes, four numbers, nothing else survives cleaning; offsets move with a leg\'s base and stay in the reply', () => {
  assert.deepEqual([...CUT_CAUSES], ['user-spoke', 'pulled-away', 'could-not-reach', 'other']);
  assert.deepEqual(cleanCut({ ...inSentence, text: '她的话', userLine: '你好' }), inSentence, 'no words ride along');
  for (const bad of [null, 'x', {}, { ...inSentence, cause: 'angry' }, { ...inSentence, saidEnd: -1 }, { ...inSentence, saidEnd: 5, sentenceEnd: 4 }, { ...inSentence, sentenceEnd: 1.5 }])
    assert.equal(cleanCut(bad), null, JSON.stringify(bad));
  assert.deepEqual(shiftCut(inSentence, 10), { ...inSentence, saidEnd: s1 + 10, sentenceEnd: s1End + 10 });
  assert.deepEqual(shiftCut(inSentence, 10, 12), { ...inSentence, saidEnd: 12, sentenceEnd: 12 }, 'clamped to the reply');
  assert.deepEqual(cutPlace(inSentence, reply.length), { at: s1End, inSentence: true });
  assert.deepEqual(cutPlace(between, reply.length), { at: s1End, inSentence: false });
  assert.deepEqual(cutPlace(lost, reply.length), { at: reply.length, inSentence: false }, 'unknown place: the end of the reply');
});

test('marker: fixed words per cause and place in her chat\'s language; on its own line in her history; the reply\'s own text is untouched', () => {
  assert.equal(cutMarkerText({ ...between, cause: 'user-spoke' }, 'zh-CN'), '（念到这里被打断）');
  assert.equal(cutMarkerText(inSentence, 'zh-CN'), '（念到这一句时被打断）');
  assert.equal(cutMarkerText(lost, 'zh-CN'), '（够不到，说到哪里没有记录）');
  assert.equal(cutMarkerText(inSentence, 'en'), '(interrupted while reading this sentence aloud)');
  assert.equal(cutMarkerText(between, 'en'), '(pulled away; the words stop here)');
  const marked = withCutMarker(reply, inSentence, 'zh-CN');
  assert.equal(marked, [reply.slice(0, s1End), '（念到这一句时被打断）', reply.slice(s1End)].join('\n'));
  assert.equal(marked.replace('\n（念到这一句时被打断）\n', ''), reply, 'removing the marker gives her words back');
  assert.equal(withCutMarker('', inSentence, 'zh-CN'), '', 'nothing is inserted into an empty reply');
  assert.equal(withCutMarker(reply, lost, 'en').endsWith('(could not reach; where the words stopped was not recorded)'), true);
});

test('note: the facts include the cause in her language, the user\'s line only when the user spoke, and no instruction on how to react', () => {
  const said = reply.slice(0, s1), rest = reply.slice(s1End);
  const spoke = callCutNote({ ...inSentence, text: reply, userLine: '等一下我说' }, 'zh-CN');
  assert.match(spoke, /通话中你被用户打断了/);
  assert.ok(spoke.includes(`已经念出声的：「${said}」`) && spoke.includes('用户打断你时说的：「等一下我说」'));
  const pulled = cutRecordNote(between, reply, 'zh-CN', '这句不应出现');
  assert.match(pulled, /用户把你拉开了/);
  assert.ok(pulled.includes(`已经说出口的：「${reply.slice(0, s1End)}」`) && pulled.includes(`「${rest}」`) && pulled.includes('停在两句之间'));
  assert.ok(!pulled.includes('这句不应出现'), 'only a user\'s voice carries a line of theirs');
  assert.match(cutRecordNote({ ...between, cause: 'could-not-reach' }, reply, 'zh-CN'), /你够不到用户/);
  assert.match(cutRecordNote(lost, reply, 'zh-CN'), /你够不到用户[\s\S]*说到哪里没有收到记录/);
  const en = cutRecordNote(between, reply, 'en');
  assert.match(en, /pulled you away/); assert.match(en, /Already said:/);
  assert.equal(cutRecordNote({ ...between, saidEnd: reply.length, sentenceEnd: reply.length }, reply, 'zh-CN'), '', 'said to the end: nothing was cut');
  for (const note of [spoke, pulled, en, cutRecordNote(lost, reply, 'en')]) {
    assert.match(note.split('\n').at(-1)!, /^[)）]$/, 'the note ends with its facts: no closing sentence of advice');
    assert.doesNotMatch(note, /不要|不用|先接|道歉|do not|don't|no need|should|apolog/i, 'facts only; the character reacts on her own');
  }
});

test('archive: the cut rides with the reply (filed once, kept when beats arrive later, beats kept when it arrives later), leaves and returns with it', async () => inDirectory(async directory => {
  const archive = new SpeechBeatArchive(directory);
  await archive.recordCut(scope, 't1', inSentence, 1000);
  await archive.record(scope, 't1', { beats: [{ word: 'smile-warm', at: 3 }] as never, line: '', performanceOnly: false }, 2000);
  assert.deepEqual(archive.get(scope, 't1')?.cut, inSentence, 'a cut filed while she was still writing stays when the beats are filed');
  assert.equal(archive.get(scope, 't1')?.beats.length, 1);
  await archive.record(scope, 't2', { beats: [{ word: 'smile-warm', at: 1 }] as never, line: '', performanceOnly: false }, 3000);
  await archive.recordCut(scope, 't2', between, 4000);
  assert.equal(archive.get(scope, 't2')?.beats.length, 1, 'beats stay when the cut comes later');
  await archive.recordCut(scope, 't3', { ...lost, cause: 'oops' as never }); // not a record
  assert.equal(archive.get(scope, 't3'), null);
  await archive.recordCut(scope, 't3', lost, 5000);
  await archive.flush();

  const reread = new SpeechBeatArchive(directory); // the file comes back as it was written
  assert.deepEqual([1, 2, 3].map(n => reread.get(scope, `t${n}`)?.cut), [inSentence, between, lost]);
  const raw = await readFile(path.join(directory, SPEECH_BEATS_FILE), 'utf8');
  assert.ok(!/等|公园|散步|晚饭/.test(raw), 'the file holds numbers and a closed word, never her words');

  const part = archive.copyTurns(scope, ['t1', 't3']);                      // the recycle bin's copy of a deleted record
  assert.deepEqual(part!.items.map(item => item.cut), [inSentence, lost]);
  await archive.removeTurns(speechBeatScopeKey(scope), ['t1', 't3']);
  assert.equal(archive.get(scope, 't1'), null); assert.equal(archive.get(scope, 't3'), null);
  assert.deepEqual(archive.get(scope, 't2')?.cut, between, 'the other reply keeps its record');
  await archive.restore(scope, part);                                        // put back with the reply
  assert.deepEqual([archive.get(scope, 't1')?.cut, archive.get(scope, 't3')?.cut], [inSentence, lost]);
  await archive.removeScope(scope);
  assert.equal(archive.get(scope, 't2'), null, 'forgetting her chat takes every record of it');
  await archive.recordCut(other, 'x', between); assert.deepEqual(archive.get(other, 'x')?.cut, between);
  assert.equal(archive.get(scope, 'x'), null, 'a record is per character and connection');
}));

test('archive: an older file without cuts reads as before; a cut-only entry (no beats) is read back, not dropped', async () => inDirectory(async directory => {
  const archive = new SpeechBeatArchive(directory);
  await archive.record(scope, 'old', { beats: [{ word: 'smile-warm', at: 0 }] as never, line: '', performanceOnly: false });
  await archive.flush();
  const again = new SpeechBeatArchive(directory);
  assert.equal(again.get(scope, 'old')?.cut, undefined);
  assert.equal(again.cutShown(scope, 'old', 10, 'zh-CN'), null, 'a reply said to the end shows nothing');
}));

test('her history: the marker is made at read time from the record (switch off and on), never stored in her words; beats stay in place around it', async () => inDirectory(async directory => {
  const archive = new SpeechBeatArchive(directory);
  await archive.record(scope, 't1', { beats: [{ word: 'smile-warm', at: 2 }, { word: 'smile-warm', at: s1End + 2 }] as never, line: '', performanceOnly: false });
  await archive.recordCut(scope, 't1', inSentence);
  const marker = '（念到这一句时被打断）';
  assert.equal(archive.replyFor(scope, false, 'zh-CN')!('t1', reply), [reply.slice(0, s1End), marker, reply.slice(s1End)].join('\n'), 'switch off: clean words and the marker');
  const withBeats = archive.replyFor(scope, true, 'zh-CN')!('t1', reply)!;
  assert.ok(withBeats.includes(`\n${marker}\n`) && withBeats.split('⟦').length === 3, withBeats);
  assert.equal(archive.replyFor(scope, false, 'zh-CN')!('nothing', reply), null, 'a reply with no record is the archive\'s own text');
  assert.deepEqual(archive.cutShown(scope, 't1', reply.length, 'zh-CN'), { at: s1End, label: marker });
  assert.equal(archive.cutShown(scope, 't1', 3, 'zh-CN')!.at, 3, 'clamped to a shorter text');
  // The public door the Unbound close moment calls.
  await recordReplyCut(directory, scope, 'kiss1', { cause: 'could-not-reach', known: true, saidEnd: 4, sentenceEnd: 4 });
  await recordReplyCut(directory, scope, 'kiss2', { cause: 'sad' } as never);
  await speechBeatsFor(directory).archive.flush();
  assert.equal(speechBeatsFor(directory).archive.get(scope, 'kiss1')?.cut?.cause, 'could-not-reach');
  assert.equal(speechBeatsFor(directory).archive.get(scope, 'kiss2'), null, 'an invalid record is dropped, the caller never throws');
}));

test('chat window: the row keeps its reply whole and carries the marker apart; a marker that is not one is dropped', () => {
  const rows = cleanChatRows([{ role: 'user', content: '嗯' }, { role: 'assistant', content: reply, cut: { at: s1End, label: '（念到这里被打断）' } }])!;
  assert.deepEqual(rows[1], { role: 'assistant', content: reply, cut: { at: s1End, label: '（念到这里被打断）' } });
  assert.equal(rows[1].content, reply);
  assert.equal(cleanChatRows([{ role: 'assistant', content: reply, cut: { at: 'x', label: 'y' } }]), null, 'no row with a performed line or a marker: the page draws as before');
  assert.deepEqual(cleanRowCut({ at: 999, label: '  x  ' }, 'abc'), { at: 3, label: 'x' });
  assert.equal(cleanRowCut({ at: 1, label: '' }, 'abc'), null);
  assert.equal(cleanChatRows([{ role: 'user', content: reply, cut: { at: 1, label: 'x' } }]), null, 'only her rows carry one');
});

// ---------------------------------------------------------------- the voice call files it (host only; the app wiring is in the full-call test of i204-barge-in)
test('call host: a barge-in files one record with the cause and the sentence her voice was in; nothing when she had said it all; unknown place is said so', async () => {
  const ranges = [{ start: 0, end: s1 }, { start: s1, end: s1End }, { start: s1End, end: reply.length }];
  const written = new Map<string, string>([['r1', reply], ['r2', reply], ['r3', reply]]);
  const cuts: [string, CutRecord][] = [];
  const call = new VoiceCallHost({ now: () => Date.now(), media: () => ({ voiceInput: true, voiceOwner: 'controls' as const }), turnOnVoice: () => true, turnOffVoice() {},
    windowShown: () => true, asleep: () => false, ttsConfig: () => null, characterId: () => 'c1', mood: () => ({}), keepWarm() {}, broadcast() {}, journal() {},
    directory: () => null, synthesize: async () => {}, cancelReading() {}, sentence: (_id, index) => ranges[index] ?? null, writtenText: id => written.get(id) ?? null });
  call.onCut((id, cut) => cuts.push([id, cut]));
  try {
    await call.set('controls', true);
    call.noteSpeech('r1'); call.sentenceHeard('r1', 0, 'start'); call.sentenceHeard('r1', 0, 'end'); call.sentenceHeard('r1', 1, 'start');
    assert.equal(call.bargeIn('controls', 'r1', '等一下我说'), true);
    assert.deepEqual(cuts, [['r1', { cause: 'user-spoke', known: true, saidEnd: s1, sentenceEnd: s1End }]]);
    assert.equal(call.bargeIn('controls', 'r1', '又一句'), false, 'one record per reply');
    assert.equal(cuts.length, 1);

    call.noteSpeech('r2'); call.sentenceHeard('r2', 2, 'start'); call.sentenceHeard('r2', 2, 'end'); // her last sentence was said in full
    call.bargeIn('controls', 'r2', '嗯嗯');
    assert.equal(cuts.length, 1, 'said to the end: nothing was cut, nothing is marked');

    call.noteSpeech('r3'); // no sentence was reported: where she stopped is unknown
    call.bargeIn('controls', 'r3', '等等我说');
    assert.deepEqual(cuts[1], ['r3', { cause: 'user-spoke', known: false, saidEnd: 0, sentenceEnd: 0 }]);
  } finally { call.dispose(); }
});
