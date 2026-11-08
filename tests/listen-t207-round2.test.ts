// Codex T-207 round 2 (X-257; pinned at 9f58785): two counterexamples left in 一起听 (I-016) after round 1. Record:
// docs/claude/2026-11-03-listen-together.md, 「Codex 第二轮反例和修复」. The outbound boundary is unchanged (round 1): the sound
// never leaves the computer; text reaches the user's Claude only for a segment's haiku note, when the user asks, or as the note
// when she speaks; plain talk is not kept.
//  - #3: a no in one sentence of a message did not stop another part of it bringing the raw words ("禁止引用刚才那句台词。请只说
//    今天是星期几。" carried the line). Now any sentence that clearly refuses quoting / discussing / mentioning it means the whole
//    message brings nothing (no raw text, no note).
//  - #5: a call over a steady hum that the host first took for a song reached the save port with its words (at 15 s and 26 s)
//    before the host took the song back (30 s). Now an open song is held in memory only and written when it has ended (an ended
//    song is never taken back), so a song taken back was never on disk at any moment.
// Every input is synthetic: hand-written text, programme-made PCM, fake clocks, fake model ports; the store writes only into a
// fresh temporary directory. No Electron, no network, no device, no real profile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAtomicFileWriter } from '../electron/atomic-file';
import { ListenKindSource } from '../electron/listen-kind-source';
import { ListenTogetherCore, type ListenFile } from '../electron/listen-together/core';
import { ListenTogether } from '../electron/listen-together/host';
import { ListenStore } from '../electron/listen-together/store';
import { ListenKindHost, type ListenKind } from '../shared/listen-kind';
import { listenAskContext, matchListenAsk } from '../shared/listen-ask';
import type { ListenNote, ListenSegment } from '../shared/listen-together';
import type { StageMusicState } from '../shared/her-state';
import { MusicLikeness } from '../src/stage/music-likeness';
import { musicPresence, MUSIC_AUDIBLE_RMS } from '../src/stage/music-presence';
import { analyserSamples, RATE, seconds, speechLike } from './helpers/listen-audio';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// ---- #3. a refusal anywhere in the message: nothing comes along ----

test('X-257 #3 (Codex\'s minimal case): "禁止引用刚才那句台词。请只说今天是星期几。" brings no block into the turn', async () => {
  const kinds = new ListenKindHost();
  kinds.set({ kind: 'show', since: 1_000, revision: 1, confidence: 1 });
  const listen = new ListenTogetherCore({ kinds, now: () => 15_000, characterId: () => 'synthetic', listening: () => true,
    note: async () => { throw Error('no note expected'); }, save: async () => {} });
  const canary = '合成台词核验标记柠檬八十七';
  try {
    assert.equal(listen.accept({ at: 2_000, end: 12_000, text: canary, language: 'zh' }), 'kept');
    const block = listen.askContext('禁止引用刚才那句台词。请只说今天是星期几。');
    assert.equal(block.includes(canary), false, 'an explicit prohibition must not attach raw text');
    assert.equal(block, '', 'nor her note: nothing at all');
  } finally {
    await listen.flush();
  }
});

/** One open show with recent raw text and a note (so "nothing" means neither, and "note only" is visible). */
function askData() {
  const now = 10 * MIN;
  const segment: ListenSegment = { id: 's', characterId: 'c', kind: 'show', startedAt: now - 5 * MIN, lastHeardAt: now, endedAt: null, notedUpTo: now - 4 * MIN, notedAt: now,
    pieces: [{ at: now - 5 * MIN, end: now - 4 * MIN, text: '早一点的台词', language: 'zh' }, { at: now - MIN, end: now, text: '合成台词核验标记柠檬八十七', language: 'zh' }] };
  const note: ListenNote = { id: 'ln-s', characterId: 'c', segmentId: 's', kind: 'show', what: '剧', gist: '两个人在车站告别', mood: '不舍', points: [], mention: false,
    hook: '', startedAt: segment.startedAt, endedAt: now, local: false, languages: ['zh'], createdAt: now, updatedAt: now, rolls: 0, talkedAt: null };
  const music: ListenSegment = { ...segment, id: 'm', kind: 'music', pieces: [{ at: now - MIN, end: now, text: '合成歌词核验标记苹果三十一', language: 'zh' }] };
  const songNote: ListenNote = { ...note, id: 'ln-m', segmentId: 'm', kind: 'music', what: '歌', gist: '一首讲雨夜等人的歌' };
  return { now, segments: [segment, music], notes: [note, songNote] };
}
const RAW = /柠檬八十七|苹果三十一|早一点的台词/u;
const NOTES = /车站告别|雨夜等人/u;

test('X-257 #3: a sentence that refuses quoting, discussing or mentioning it stops the whole message, raw text and note alike', () => {
  const data = askData();
  const refused = [
    // The no is in another sentence or clause than the words about the sound.
    '刚才那句台词，禁止引用。请只说今天是星期几。',
    '关于刚才那首歌：不要讨论。只告诉我现在几点。',
    '刚才那句台词。不要引用它，也不要复述。今天星期几？',
    '这首歌的歌词你记得吧？先别说出来，也别引用，告诉我今天几号就好。',
    '那集的台词我知道。请勿复述。',
    '这集演到哪了我自己会看。那段原文不许引用。',
    'That line from the show. Do not quote it. What day is it?',
    "this song. please don't repeat any of it. just tell me the time.",
    // Refusal words the first round missed, in the same clause; and the thing refused put before the verb with 把 / 对.
    '严禁复述刚才那段剧情', '请勿讨论这首歌', '避免引用剧里那句', '禁止提这集',
    '不要把刚才那句台词念出来', '别对这首歌发表评论', '刚才那段剧情你看了吧？别把它说出来。今天几号？',
    // A question with a content refusal (the price, written down in the record): nothing rather than a guess at what is allowed.
    '别引用原文，刚才那首歌讲的什么',
  ];
  const leaks = refused.filter(line => matchListenAsk(line) !== null || listenAskContext(matchListenAsk(line), data, line) !== '');
  assert.deepEqual(leaks, [], 'none of these may carry the raw words or her note');
});

test('X-257 #3 (guarded): real questions still bring the words; a no about something else still means her note only', () => {
  const data = askData();
  for (const line of ['刚才那句台词什么意思？', '这首歌在唱什么', '我没听懂刚才那句台词', '这首歌不是讲分手的吗', '演到哪了']) {
    assert.equal(matchListenAsk(line)?.raw, true, `asked: ${line}`);
    assert.match(listenAskContext(matchListenAsk(line), data, line), RAW, `asked, the words come along: ${line}`);
  }
  // A no about something else, or about how to answer: round 1's rule, her note and never the raw words. Round 5 (X-262, structural):
  // a no that tells her something ("不要骗我") is always unsure, so "刚才那首歌说的是什么，不要骗我" (raw text before) is her note only.
  for (const line of ['我不想聊工作了，刚才那首歌讲的什么', '工作上的事先不说了。刚才那首歌讲的什么', '不要告诉别人，刚才那首歌讲的什么',
    '别把我的事说出去，刚才那首歌讲的什么', '刚才那首歌讲的什么？不用解释太多', '刚才那首歌说的是什么，不要骗我']) {
    assert.equal(matchListenAsk(line)?.raw, false, `unclear: ${line}`);
    const block = listenAskContext(matchListenAsk(line), data, line);
    assert.match(block, NOTES, `unclear, her note may come: ${line}`);
    assert.ok(!RAW.test(block), `unclear, never the raw words: ${line}`);
  }
});

// ---- #5. a song the host takes back was never written ----

/** Codex T-207 round 2's replay (listen-kind-classifier.test.mts): the real fast layer and host on synthetic PCM, one look a second. */
async function detect(pcm: Float32Array, speechTags: boolean, onTick: (second: number, now: number, source: ListenKindSource) => void | Promise<void>) {
  let now = 1_000_000, lastTick = 0, lastLoud = -Infinity;
  const fast = new MusicLikeness();
  let presence = musicPresence({ hearing: true, choice: undefined, danceOn: false, sinceLoudS: Infinity });
  const slow = new ListenKindSource({ stage: { current: () => presence }, hearing: () => true, now: () => now });
  const changes: { second: number; kind: string }[] = [];
  for (const sample of analyserSamples(pcm, { jitterMs: 0, refreshHz: 60 })) {
    fast.update(sample);
    if (sample.rms >= MUSIC_AUDIBLE_RMS) lastLoud = sample.time;
    const second = Math.floor(sample.time);
    if (second <= lastTick) continue;
    lastTick = second;
    now += 1_000;
    presence = musicPresence({ hearing: true, choice: undefined, danceOn: false, sinceLoudS: sample.time - lastLoud, music: fast.music, beat: fast.score });
    if (speechTags && second % 12 === 0) slow.noteHeard({ words: true, event: 'speech' });
    const view = slow.tick();
    await onTick(second, now, slow); // as Codex's replay: let the save chain run each second
    if (changes.at(-1)?.kind !== view.kind) changes.push({ second, kind: view.kind });
  }
  return { changes };
}
function periodicSpeech() {
  const syllables = speechLike(0.65, { seed: 17, rate: 1.5 });
  const signal = seconds(42);
  for (let n = 0; n < signal.length; n++) signal[n] = syllables[n % syllables.length]! * 0.6 + 0.04 * Math.sin(2 * Math.PI * 114 * n / RATE);
  return signal;
}

test('X-257 #5 (Codex\'s minimal case): words of the periodic speech never reach the save port, before or after the take-back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const marker = '合成周期性说话标签';
  let clock = 1_000_000, noteCalls = 0;
  let core: ListenTogetherCore | undefined;
  const saved: { elapsed: number; containsMarker: boolean }[] = [], decisions: { second: number; decision: string }[] = [];
  const run = await detect(periodicSpeech(), true, (second, now, source) => {
    clock = now;
    core ??= new ListenTogetherCore({ kinds: source.host, now: () => clock, characterId: () => 'synthetic', listening: () => true,
      note: async () => { noteCalls++; return ''; },
      save: async file => { saved.push({ elapsed: clock - 1_000_000, containsMarker: file.segments.some(s => s.pieces.some(p => p.text === marker)) }); } });
    t.mock.timers.tick(1_000); // the core's real 1.5 s save debounce, on the same virtual timeline
    core.tick();
    if (second % 12 === 0) decisions.push({ second, decision: core.accept({ at: now - 12_000, end: now, text: marker, language: 'zh' }) });
  });
  assert.ok(core);
  await core.settled();
  t.diagnostic(JSON.stringify({ changes: run.changes, decisions, saved, noteCalls, remaining: core.snapshot().segments.length }));
  assert.ok(run.changes.some(c => c.kind === 'music'), 'fixture: the host did take it for a song for a while');
  assert.ok(decisions.some(d => d.decision === 'kept'), 'fixture: its words were kept in memory meanwhile');
  assert.equal(core.snapshot().segments.length, 0, 'the take-back discards the open segment');
  assert.equal(noteCalls, 0, 'and nothing reaches the note port');
  assert.ok(saved.every(save => !save.containsMarker), 'provisionally classified speech never reaches the save port');
});

/** Every string handed to the disk, through the real atomic writer, into a fresh temporary directory. */
async function recordingStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-t207-r2-'));
  const real = createAtomicFileWriter(), writes: string[] = [];
  const store = new ListenStore(directory, { writeFile: async (file, data) => { writes.push(data); await real(file, data); } });
  /** Everything on disk now, temporary files included. */
  // A write in flight may rename its temporary file between the listing and the read (ENOENT, seen 1 run in 30): list again, nothing is skipped.
  const disk = async (): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      try { return (await Promise.all((await readdir(directory)).map(name => readFile(path.join(directory, name), 'utf8')))).join('\n'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 20) throw error; }
    }
  };
  return { directory, store, writes, disk, dispose: () => rm(directory, { recursive: true, force: true }) };
}

/** The host on the stage's reports (round 1's replay), the whole 一起听 host on top, the disk read back after every second. */
async function throughDisk(steps: (play: (count: number, music: StageMusicState, beat: number, clip?: { words: boolean; event: 'speech' | 'sing' | 'bgm' }, text?: string) => Promise<void>) => Promise<void>) {
  let now = T0, stage: { music: StageMusicState; beat: number; always: boolean } | null = null;
  const source = new ListenKindSource({ stage: { current: () => stage }, hearing: () => true, now: () => now });
  const disk = await recordingStore();
  const listen = new ListenTogether({ directory: disk.directory, kinds: source.host, characterId: () => 'synthetic-card', listening: () => true, now: () => now,
    quick: async () => JSON.stringify({ what: '歌', gist: '一首合成的歌', mood: '平静', points: [], mention: false, hook: '' }) }, disk.store);
  await listen.load();
  const kinds: ListenKind[] = [], seenOnDisk: string[] = [];
  let second = 0;
  try {
    await steps(async (count, music, beat, clip, text) => {
      stage = { music, beat, always: false };
      for (let i = 0; i < count; i++) {
        now += 1_000; second++;
        if (clip && second % 12 === 0) { source.noteHeard(clip); if (text) listen.core.accept({ at: now - 12_000, end: now, text: `${text}${second}`, language: 'zh' }); }
        source.tick(); listen.core.tick();
        // Force a write every second, so whatever the core would save is on disk now; then read the disk back.
        await listen.core.flush(); seenOnDisk.push(await disk.disk());
        kinds.push(source.host.current().kind);
      }
    });
    await listen.dispose();
    return { kinds, seenOnDisk, writes: disk.writes, final: await disk.disk(), memory: listen.core.snapshot() };
  } finally { await disk.dispose(); }
}

test('X-257 #5: a call the host first takes for a song and then takes back is not on disk at any moment, nor in any write', async () => {
  const marker = '合成通话核验标记梨子';
  const run = await throughDisk(async play => {
    await play(60, 'still', 0.95, { words: true, event: 'speech' }, marker); // a voice over a steady loop, every clip heard as speech
    await play(40, 'silent', 0); // then quiet
  });
  assert.ok(run.kinds.includes('music') && run.kinds.includes('unsure'), 'fixture: taken for a song, then taken back');
  assert.ok(run.writes.length > 0, 'fixture: the store did write');
  assert.ok(run.seenOnDisk.every(content => !content.includes(marker)), 'never on disk, second by second');
  assert.ok(run.writes.every(data => !data.includes(marker)), 'never in any write');
  assert.ok(!run.final.includes(marker));
  assert.ok(!run.memory.segments.some(s => s.pieces.some(p => p.text.includes(marker))), 'and gone from memory');
});

test('X-257 #5: a real song is written once it has ended, not while it plays; an open show is still written while it plays', async () => {
  const lyric = '合成歌词核验标记苹果';
  const song = await throughDisk(async play => {
    await play(100, 'dance', 0.95, { words: true, event: 'sing' }, lyric); // a sung song with a steady beat
    await play(40, 'silent', 0);
  });
  const playing = song.kinds.slice(0, 100);
  assert.ok(playing.includes('music') && !playing.slice(playing.indexOf('music')).includes('unsure'), 'fixture: a song, never taken back');
  const firstOnDisk = song.seenOnDisk.findIndex(content => content.includes(lyric));
  const lastMusic = song.kinds.lastIndexOf('music');
  assert.ok(firstOnDisk > lastMusic, `written only after it ended (on disk from second ${firstOnDisk + 1}, music until ${lastMusic + 1})`);
  assert.ok(song.final.includes(lyric), 'and kept');
  // A show (an opening song, then dialogue) is never taken back: its words are saved while it is still open (a crash keeps them).
  const line = '合成台词核验标记柠檬';
  const show = await throughDisk(async play => {
    await play(16, 'still', 0.95);
    await play(60, 'still', 0.05, { words: true, event: 'speech' }, line);
  });
  assert.equal(show.kinds.at(-1), 'show', 'fixture: a show');
  assert.ok(show.seenOnDisk.at(-1)!.includes(line), 'the open show is on disk');
});

test('X-257 #5: the core never hands the save port an open song, whenever it is taken back; other saves meanwhile leave it out', async () => {
  let clock = T0, revision = 0, serial = 0;
  const kinds = new ListenKindHost(), saved: ListenFile[] = [], gates: (() => void)[] = [];
  const NOTE = JSON.stringify({ what: '歌', gist: '一首讲雨夜等人的歌', mood: '安静', points: [], mention: false, hook: '' });
  const core = new ListenTogetherCore({ kinds, now: () => clock, characterId: () => 'synthetic', listening: () => true,
    note: () => new Promise(resolve => gates.push(() => resolve(NOTE))),
    save: async file => { saved.push(structuredClone(file)); }, createId: () => `seg-${++serial}` });
  const set = (kind: ListenKind, since = clock) => { kinds.set({ kind, confidence: 0.9, since, revision: ++revision }); core.tick(); };
  const hear = (text: string) => core.accept({ at: clock - 12_000, end: clock, text, language: 'zh' });
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 1_000) { clock += 1_000; core.tick(); } await flush(); await core.flush(); };
  const onDisk = (text: string) => saved.some(file => file.segments.some(s => s.pieces.some(p => p.text.includes(text))));
  // An ordinary song is written when it ends (its note request waits at the gate).
  set('music'); hear('真正的第一首歌的歌词在这里唱着'); await advance(70_000);
  assert.ok(!onDisk('真正的第一首歌'), 'not while it plays');
  set('quiet'); await advance(2_000);
  assert.ok(onDisk('真正的第一首歌'), 'ended: written'); assert.equal(gates.length, 1);
  // A show opens: saved while open (a show is never taken back).
  set('show'); hear('合成台词核验标记柠檬第一句'); await advance(20_000);
  assert.ok(onDisk('柠檬第一句'), 'the open show is saved');
  // A "song" starts between its scenes and runs three minutes; meanwhile the first song's note lands and is saved.
  const since = clock;
  set('music', since);
  for (let i = 0; i < 15; i++) {
    hear(`被当成歌的通话第${i}句`); await advance(12_000);
    if (i === 7) { gates[0]!(); await flush(); await core.flush(); }
  }
  assert.equal(core.notesFor('synthetic').length, 1, 'fixture: the earlier song\'s note landed meanwhile');
  assert.ok(saved.some(file => file.notes.length === 1), 'fixture: and was saved meanwhile');
  assert.ok(core.snapshot().segments.some(s => s.kind === 'music' && s.endedAt === null && s.pieces.length > 0), 'fixture: kept in memory meanwhile');
  assert.ok(!onDisk('被当成歌的通话'), 'never handed to the save port while it was open');
  // The host takes it back late (unsure from the song's own start).
  set('unsure', since); await advance(10_000);
  assert.ok(!onDisk('被当成歌的通话'), 'taken back: never written');
  assert.ok(!core.snapshot().segments.some(s => s.kind === 'music' && s.pieces.some(p => p.text.includes('被当成歌的通话'))), 'and gone from memory');
  assert.ok(saved.at(-1)!.segments.some(s => s.pieces.some(p => p.text.includes('真正的第一首歌'))), 'the earlier song stays');
});

test('X-257 #5 (the price): at quit an open show is kept and closed at the next start; the song still playing is not kept', async () => {
  const disk = await recordingStore();
  let clock = T0, revision = 0;
  const kinds = new ListenKindHost();
  const listen = new ListenTogether({ directory: disk.directory, kinds, characterId: () => 'synthetic-card', listening: () => true, now: () => clock,
    quick: async () => { throw Error('no note call at quit'); } }, disk.store);
  const set = (kind: ListenKind) => { kinds.set({ kind, confidence: 1, since: clock, revision: ++revision }); listen.core.tick(); };
  try {
    await listen.load();
    set('show'); listen.core.accept({ at: clock - 12_000, end: clock, text: '合成台词核验标记柠檬', language: 'zh' });
    clock += 20_000; listen.core.tick();
    set('music'); listen.core.accept({ at: clock - 12_000, end: clock, text: '合成歌词核验标记苹果', language: 'zh' }); // the show stays open
    clock += 20_000; listen.core.tick();
    await listen.dispose();
    assert.ok(disk.writes.length > 0 && disk.writes.every(data => !data.includes('苹果')), 'the open song was never written');
    const again = new ListenTogether({ directory: disk.directory, kinds, characterId: () => 'synthetic-card', listening: () => true, now: () => clock,
      quick: async () => { throw Error('no note call at restart'); } }, new ListenStore(disk.directory));
    await again.load();
    const segments = again.core.segmentsFor('synthetic-card');
    assert.deepEqual(segments.map(s => [s.kind, s.endedAt !== null, s.pieces.map(p => p.text)]), [['show', true, ['合成台词核验标记柠檬']]]);
    await again.dispose();
  } finally { await disk.dispose(); }
});
