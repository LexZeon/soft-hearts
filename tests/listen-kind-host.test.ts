/**
 * I-016 A (docs/claude/2026-11-03-listen-kind.md): the host's slower layer (electron/listen-kind-source.ts): music / show / talk /
 * quiet from the stage's beat score (I-017's narrow channel, one more number) and, only as help, the recognizer's tags; 30 s
 * smoothing with hysteresis; the shared ListenKindHost (shared/listen-kind.ts) is set only on a change, with a new revision.
 * Also: the channel's new field is checked like the rest, stale reports say nothing, the I-017 line names the kind and a change
 * of kind is a change worth the full sentence, the recognizer route reports words/tags (never text), the developer line.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LISTEN_ENTER_MS, LISTEN_MIN_SOUND_MS, LISTEN_QUIET_MS, LISTEN_STRETCH_GAP_MS, ListenKindJudge, ListenKindSource, type ListenObservation,
} from '../electron/listen-kind-source';
import { STAGE_STATE_TTL_MS, StageStateHost, createHerState } from '../electron/her-state-host';
import { AmbientAsrRoute, localAmbientResult } from '../electron/asr/ambient-route';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { briefHearingWords, hearingWords, parseStageStateReport, HER_STATE_MAX, type HearingNow, type StageMusicState } from '../shared/her-state';
import { HER_STATE_BEAT_STEP, HerStateReporter } from '../src/ui/her-state-reporter';
import { ListenKindPanelFeed } from '../src/ui/listen-kind-panel';
import type { ListenKind } from '../shared/listen-kind';
import type { AsrEventTag } from '../electron/asr/decode';

const T0 = 1_700_000_000_000;
type Step = { seconds: number; music?: StageMusicState; beat?: number; hearing?: boolean; stale?: boolean };
/** Drives a judge one second at a time; returns the kind after every second and when each kind was first taken. */
function drive(judge: ListenKindJudge, steps: Step[], clips: { at: number; words: boolean; event: AsrEventTag | null }[] = [], start = T0) {
  const kinds: { t: number; kind: ListenKind }[] = [];
  let t = start, s = 0;
  const pending = [...clips].sort((a, b) => a.at - b.at);
  for (const step of steps) for (let i = 0; i < step.seconds; i++) {
    t += 1000; s++;
    while (pending.length && pending[0]!.at <= s) { const clip = pending.shift()!; judge.noteClip(start + clip.at * 1000, { words: clip.words, event: clip.event }); }
    const observation: ListenObservation = { hearing: step.hearing ?? true, stage: step.stale ? null : { music: step.music ?? 'silent', ...(step.beat !== undefined ? { beat: step.beat } : {}) } };
    kinds.push({ t: s, kind: judge.observe(t, observation).kind });
  }
  const firstAt = (kind: ListenKind, after = 0) => kinds.find(k => k.t > after && k.kind === kind)?.t ?? null;
  return { kinds, firstAt, last: kinds.at(-1)!.kind, view: judge.current() };
}
const song = (seconds: number, beat = 0.85): Step => ({ seconds, music: 'dance', beat });
const talk = (seconds: number, beat = 0.1): Step => ({ seconds, music: 'still', beat });
const quiet = (seconds: number): Step => ({ seconds, music: 'silent', beat: 0 });
/** One clip every 12 s over [from, to) seconds. */
const clipsOf = (from: number, to: number, words: boolean, event: AsrEventTag | null) => Array.from({ length: Math.floor((to - from) / 12) }, (_, i) => ({ at: from + 12 * (i + 1), words, event }));

test('music: a steady beat for ~15 s is music; since is when the sound began; the shared host gets one new revision', () => {
  const run = drive(new ListenKindJudge(), [quiet(5), song(60)]);
  const at = run.firstAt('music')!;
  assert.ok(at > 5 && at <= 5 + LISTEN_MIN_SOUND_MS / 1000 + LISTEN_ENTER_MS / 1000 + 2, `music after ${at - 5} s of it`);
  assert.equal(run.last, 'music');
  assert.equal(run.view.since, T0 + 5_000, 'since: the first second of the song');
  assert.ok(run.view.revision >= 1 && run.view.confidence > 0.7);
});

test('talk: voices that are never music, from start to finish (a call, a meeting, a podcast)', () => {
  const run = drive(new ListenKindJudge(), [quiet(3), talk(90)]);
  assert.equal(run.last, 'talk');
  assert.ok(run.firstAt('talk')! <= 3 + 15, `talk after ${run.firstAt('talk')! - 3} s`);
  assert.equal(run.kinds.some(k => k.kind === 'music' || k.kind === 'show'), false);
});

test('a show: an opening song and then dialogue is a show, from the opening on; the dialogue stays a show', () => {
  const run = drive(new ListenKindJudge(), [quiet(2), song(40), talk(180)]);
  assert.equal(run.firstAt('music'), run.firstAt('music', 0));
  const show = run.firstAt('show', 42)!;
  assert.ok(show > 42 && show <= 42 + 30 + 10, `a show ${show - 42} s into the dialogue (30 s window + hysteresis)`);
  assert.equal(run.last, 'show');
  assert.equal(run.view.since, T0 + 2_000, 'the show began with its opening song');
  assert.equal(run.kinds.filter(k => k.t > show).every(k => k.kind === 'show'), true, 'no flipping back to talk');
});

test('a show without music: laughter in the clips marks it; without any cue the same dialogue is talk', () => {
  const laughs = [...clipsOf(0, 60, true, 'speech'), { at: 30, words: false, event: 'laughter' as const }];
  assert.equal(drive(new ListenKindJudge(), [talk(70)], laughs).last, 'show');
  assert.equal(drive(new ListenKindJudge(), [talk(70)], clipsOf(0, 70, true, 'speech')).last, 'talk');
});

test('quiet: 20 s of nothing after anything; the switch off is quiet at once (after the hysteresis)', () => {
  const run = drive(new ListenKindJudge(), [song(40), quiet(40)]);
  const at = run.firstAt('quiet', 40)!;
  assert.ok(at - 40 >= LISTEN_QUIET_MS / 1000 - 2 && at - 40 <= LISTEN_QUIET_MS / 1000 + 10, `quiet after ${at - 40} s of silence`);
  const off = drive(new ListenKindJudge(), [song(40), { seconds: 30, hearing: false }]);
  assert.equal(off.last, 'quiet');
});

test('a long silence ends a stretch: dialogue after it is talk, not the old show (privacy: a call after the music is not kept)', () => {
  const run = drive(new ListenKindJudge(), [song(40), quiet(LISTEN_STRETCH_GAP_MS / 1000 + 5), talk(90)]);
  assert.equal(run.last, 'talk');
  const close = drive(new ListenKindJudge(), [song(40), quiet(10), talk(90)]);
  assert.equal(close.last, 'show', 'a short pause after the song: the same stretch, a show');
});

test('hysteresis: a few seconds of something else inside a kind do not switch it; changes take a new revision each', () => {
  const run = drive(new ListenKindJudge(), [song(60), talk(6), song(30), talk(5), song(30)]);
  assert.equal(run.kinds.filter(k => k.t > 25).every(k => k.kind === 'music'), true, JSON.stringify(run.kinds.filter(k => k.t > 25 && k.kind !== 'music')));
  // Every change is a new revision, one per change, never going back.
  const judge = new ListenKindJudge();
  let revision = 0, changes = 0, previous: ListenKind = 'quiet';
  const flips = drive(judge, [song(40), talk(120), song(60), song(90)]);
  const sequence: ListenKind[] = [];
  for (const { kind } of flips.kinds) if (kind !== previous) { changes++; previous = kind; sequence.push(kind); }
  revision = judge.current().revision;
  assert.equal(revision, changes, `${changes} changes, revision ${revision}`);
  assert.deepEqual(sequence, ['unsure', 'music', 'show', 'music']);
  assert.ok(flips.kinds.filter(k => k.t > 160 && k.t <= 220).every(k => k.kind === 'show'), 'a minute of music inside a show (an insert song) stays the show');
  assert.equal(flips.last, 'music', 'a long run of music after the show: music again');
});

test('tags help only when most recent clips agree: instrumental clips turn "not music" into music (no drums)', () => {
  // The beat missed a drumless song (score low), the recognizer heard background music without words in every clip.
  const drumless = drive(new ListenKindJudge(), [talk(80, 0.2)], clipsOf(0, 80, false, 'bgm'));
  assert.equal(drumless.last, 'music');
  // Two of six clips are not a majority.
  const few = [...clipsOf(0, 36, true, 'speech'), ...clipsOf(36, 60, false, 'bgm')];
  assert.notEqual(drive(new ListenKindJudge(), [talk(60, 0.2)], few).last, 'music');
  // Only punctuation is no words: a "." clip tagged bgm is instrumental.
  assert.deepEqual(localAmbientResult({ text: '.', tags: { language: 'ja', event: 'bgm', emotion: null } }).text, '');
});

test('tags: speech clips turn a wavering beat into a show (dialogue over a beat); a steady beat heard only as speech is unsure', () => {
  const wavering: Step[] = []; for (let i = 0; i < 20; i++) wavering.push(song(3), talk(1));
  assert.equal(drive(new ListenKindJudge(), wavering, clipsOf(0, 80, true, 'speech')).last, 'show');
  // Codex T-207: a steady beat with every clip heard as speech with words (a voice over a loop; maybe an English song tagged
  // speech) is conflicting evidence: unsure, so nothing of it is kept (宁可少记，不误记通话), since back at the stretch's start.
  const conflict = drive(new ListenKindJudge(), [song(80)], clipsOf(0, 80, true, 'speech'));
  assert.equal(conflict.last, 'unsure'); assert.ok(conflict.view.since <= T0 + 1_000, 'taken back from the stretch\'s first second');
  assert.ok(conflict.firstAt('unsure', 24)! <= 24 + LISTEN_ENTER_MS / 1000 + 1, 'taken back within seconds of the second speech clip');
  // A sung or instrumental clip among them keeps the song a song.
  assert.equal(drive(new ListenKindJudge(), [song(80)], [...clipsOf(0, 80, true, 'speech'), { at: 30, words: true, event: 'sing' }]).last, 'music');
  assert.equal(drive(new ListenKindJudge(), wavering).last, 'music', 'without the tags the beat leads');
});

test('only clips (the rhythm switch off, a transcription switch on): the tags alone, conservatively', () => {
  const off = (seconds: number): Step => ({ seconds, hearing: false });
  assert.equal(drive(new ListenKindJudge(), [off(70)], clipsOf(0, 70, true, 'speech')).last, 'talk');
  assert.equal(drive(new ListenKindJudge(), [off(70)], clipsOf(0, 70, false, 'sing')).last, 'music');
  assert.equal(drive(new ListenKindJudge(), [off(30)], clipsOf(0, 30, true, 'speech')).last, 'unsure', 'two clips are not enough');
});

test('no evidence: a stale stage report or a window without the score says nothing new; a window without the score still knows a dance', () => {
  const stale = drive(new ListenKindJudge(), [song(30), { seconds: 60, stale: true }]);
  assert.equal(stale.last, 'music', 'the last kind stays while nothing fresh comes (the pet window hidden a while)');
  assert.equal(drive(new ListenKindJudge(), [song(30), { seconds: 160, stale: true }]).last, 'unsure', 'but not for ever');
  const legacy = drive(new ListenKindJudge(), [{ seconds: 40, music: 'dance' }]);
  assert.equal(legacy.last, 'music', 'an older page without beat: dancing is music');
  // Time going back is ignored.
  const judge = new ListenKindJudge();
  drive(judge, [song(40)]);
  const before = judge.current();
  assert.deepEqual(judge.observe(T0, { hearing: true, stage: { music: 'still', beat: 0 } }), before);
  assert.deepEqual(judge.observe(Number.NaN, { hearing: true, stage: null }), before);
});

test('ListenKindSource: ticks the judge from the stage host, sets the shared host only on a change, never backwards', () => {
  let now = T0;
  const stage = new StageStateHost(() => now);
  let hearing = true;
  const source = new ListenKindSource({ stage, hearing: () => hearing, now: () => now });
  const seen: string[] = [];
  source.host.subscribe(view => seen.push(view.kind));
  let seq = 0;
  const report = (music: StageMusicState, beat: number) => assert.ok(stage.accept({ instance: 'pet-page-listen-1', seq: ++seq, music, always: false, beat }));
  for (let i = 0; i < 40; i++) { now += 1000; report('dance', 0.9); source.tick(); }
  assert.equal(source.host.current().kind, 'music');
  assert.deepEqual(seen, ['unsure', 'music'].filter(kind => seen.includes(kind)));
  const revision = source.host.current().revision;
  for (let i = 0; i < 10; i++) { now += 1000; report('dance', 0.9); source.tick(); }
  assert.equal(source.host.current().revision, revision, 'no change, no new revision');
  // The stage stops reporting: after its TTL the report is stale and adds nothing.
  now += STAGE_STATE_TTL_MS + 1000; source.tick();
  assert.equal(source.host.current().kind, 'music');
  assert.equal(source.heardKind(), 'music');
  // A late, older value is refused by the shared host.
  assert.equal(source.host.set({ kind: 'talk', confidence: 1, since: 0, revision: 1 }), false);
  hearing = false;
  for (let i = 0; i < 20; i++) { now += 1000; source.tick(); }
  assert.equal(source.host.current().kind, 'quiet');
  assert.match(source.panelLine(), /^宿主：安静 \d\.\d\d（没在听/);
  // Clips through the recognizer route reach it.
  source.noteHeard({ words: true, event: 'speech' });
  assert.match(source.panelLine(), /标签 1 段/);
});

test('heardKind: the settled kind, or the stage\'s own guess before that; I-017 counts a settled change as a change, not the guess', () => {
  let now = T0;
  const stage = new StageStateHost(() => now);
  const source = new ListenKindSource({ stage, hearing: () => true, now: () => now });
  let seq = 0;
  const report = (music: StageMusicState, beat: number) => stage.accept({ instance: 'pet-page-listen-2', seq: ++seq, music, always: false, beat });
  report('still', 0.1); source.tick();
  assert.equal(source.heardKind(), 'sound');
  report('dance', 0.8); source.tick();
  assert.equal(source.heardKind(), 'rhythm');
  // I-017's turn: the guess flickering is not a change; the settled kind is.
  const capture = { slots: { 'system-audio': { dance: true } } } as never;
  const her = createHerState({ stage, capture: () => capture, legacy: () => null, contacts: () => [], scope: () => 'conversation-1', kind: () => source.heardKind(), now: () => now });
  assert.equal(her.chatTurn('', '今天好累').say, 'full');
  report('still', 0.1); assert.equal(her.chatTurn('', '今天好累').say, 'none', 'rhythm → sound before anything settled: no new sentence');
  for (let i = 0; i < 40; i++) { now += 1000; report('dance', 0.85); source.tick(); }
  assert.equal(source.heardKind(), 'music');
  const turn = her.chatTurn('', '今天好累');
  assert.equal(turn.say, 'full', 'settled on music: the full sentence once');
  assert.equal(turn.hearing.kind, 'music');
  assert.equal(her.chatTurn('', '晚饭吃什么').say, 'none', 'and not again');
});

test('the words: 在放歌 / 在放剧或视频的声音 / 有人在说话, honest about what she cannot make out; every combination within the limit', () => {
  const at = (kind: HearingNow['kind'], music: StageMusicState = 'still', transcript = false): HearingNow => ({ source: 'system-audio', stage: { music, always: false }, transcript, kind });
  assert.equal(hearingWords(at('music', 'dance')), '用户让你听到电脑里的声音，现在在放歌，你正跟着跳；你只听得到节奏，听不懂歌词。');
  assert.equal(hearingWords(at('show')), '用户让你听到电脑里的声音，现在在放剧或视频的声音，你没跟着动；你只听得到声音，听不懂台词。');
  assert.equal(hearingWords(at('talk')), '用户让你听到电脑里的声音，现在有人在说话，你没跟着动；你只听得到声音（本机在转写，用户问到内容时才会附上；没附就别编）。');
  assert.equal(hearingWords(at(undefined, 'dance')), '用户让你听到电脑里的声音，现在在放有节奏的声音（像是歌），你正跟着跳；你只听得到节奏，听不懂歌词。', 'I-017 wording when nothing is known');
  assert.equal(briefHearingWords(at('music', 'nod')), '电脑里在放歌，你正跟着轻轻点头；听不懂歌词。');
  assert.equal(briefHearingWords(at('talk')), '电脑里有人在说话，你没跟着动；本机在转写，问到才附。');
  assert.equal(briefHearingWords(at('show', 'still', true)), '电脑里在放剧或视频的声音，你没跟着动；内容以转写为准。');
  for (const kind of ['rhythm', 'music', 'show', 'talk', 'sound', undefined] as const) for (const music of ['silent', 'still', 'nod', 'dance'] as const)
    for (const source of ['system-audio', 'microphone'] as const) for (const transcript of [false, true]) for (const always of [false, true]) {
      const h: HearingNow = { source, stage: { music, always }, transcript, kind };
      for (const words of [hearingWords(h), briefHearingWords(h)]) {
        assert.ok(words.length <= HER_STATE_MAX && !words.includes('\n'), words);
        assert.doesNotMatch(words, /听不到/u, words);
        if (music === 'silent') assert.doesNotMatch(words, /没在放东西|很安静/u, words); // 2026-11-07: never claims nothing is playing
        if (transcript && music !== 'silent') assert.match(words, /转写/u);
      }
    }
});

test('the channel: `beat` is optional and checked like the rest; the reporter sends it on a move of 0.1, rounded', () => {
  const good = { instance: 'a1b2c3d4-0000-4000-8000-000000000001', seq: 1, music: 'dance', always: false };
  assert.deepEqual(parseStageStateReport(good), good, 'without beat: exactly as before');
  assert.deepEqual(parseStageStateReport({ ...good, beat: 0.42 }), { ...good, beat: 0.42 });
  for (const beat of [-0.1, 1.01, Number.NaN, Infinity, '0.5', null, true]) assert.equal(parseStageStateReport({ ...good, beat }), null, String(beat));
  assert.equal(parseStageStateReport({ ...good, beat: 0.4, level: 0.3 }), null, 'nothing else rides along');
  assert.equal(parseStageStateReport(Object.defineProperty({ ...good }, 'beat', { get: () => 0.5, enumerable: true })), null, 'no getters');
  assert.equal(parseStageStateReport({ instance: good.instance, seq: 1, music: 'dance', beat: 0.5 }), null, 'a required field missing');
  let now = 0, current: { music: StageMusicState; always: boolean; beat?: number } = { music: 'dance', always: false, beat: 0.5 };
  const sent: unknown[] = [];
  const reporter = new HerStateReporter({ read: () => current, send: r => { sent.push(r); }, now: () => now, instance: 'pet-page-test-9' });
  assert.equal(reporter.tick(), true);
  current = { ...current, beat: 0.55 }; now += 1000; assert.equal(reporter.tick(), false, 'a small move waits for the heartbeat');
  current = { ...current, beat: 0.5 + HER_STATE_BEAT_STEP + 0.004 }; now += 1000; assert.equal(reporter.tick(), true, 'a move of 0.1 goes at once');
  current = { music: 'dance', always: false, beat: 0.123456 }; now += 1000; reporter.tick();
  assert.deepEqual(sent.map(r => (r as { beat?: number }).beat), [0.5, 0.6, 0.12]);
  for (const report of sent) assert.ok(parseStageStateReport(report));
  const host = new StageStateHost(() => 0);
  for (const report of sent) host.accept(report);
  assert.deepEqual(host.current(0), { music: 'dance', always: false, beat: 0.12 });
});

test('the recognizer route tells observers words-or-not and the event tag, never the text; an observer cannot break it', async () => {
  const route = new AmbientAsrRoute({
    config: () => DEFAULT_SETTINGS.voiceInput!, journal: () => {}, characterId: () => null,
    local: () => ({ ready: true, voiceBlocked: () => null, recognize: async () => ({ text: next, tags: { language: 'zh', event: 'bgm', emotion: 'neutral' } }) }) as never,
  });
  let next = '你好，这是一句台词。';
  const heard: unknown[] = [];
  const stop = route.observe(value => heard.push(value));
  route.observe(() => { throw new Error('an observer failing'); });
  const wav = new ArrayBuffer(44 + 32000);
  const view = new DataView(wav);
  for (const [i, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) for (let k = 0; k < 4; k++) view.setUint8(i + k, text.charCodeAt(k));
  view.setUint32(4, wav.byteLength - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 32000, true);
  const result = await route.transcribe(wav, new AbortController().signal);
  assert.equal(result.text, '你好，这是一句台词。', 'the transcript itself is unchanged');
  next = '.';
  await route.transcribe(wav, new AbortController().signal);
  assert.deepEqual(heard, [{ words: true, event: 'bgm' }, { words: false, event: 'bgm' }]);
  stop();
  await route.transcribe(wav, new AbortController().signal);
  assert.equal(heard.length, 2, 'stopped');
});

test('the developer line feed: only while the line shows, one request at a time, a failure clears it', async () => {
  let active = true, calls = 0, fail = false;
  const shown: string[] = [];
  let resolve: ((value: unknown) => void) | null = null;
  const feed = new ListenKindPanelFeed({ active: () => active, read: () => { calls++; return fail ? Promise.reject(new Error('x')) : new Promise(r => { resolve = r; }); }, show: line => shown.push(line) });
  feed.tick(); feed.tick();
  assert.equal(calls, 1, 'one in flight');
  resolve!('宿主：音乐 0.90（节拍）'); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(shown, ['宿主：音乐 0.90（节拍）']);
  fail = true; feed.tick(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(shown, ['宿主：音乐 0.90（节拍）', '']);
  active = false; fail = false; const before = calls; feed.tick();
  assert.equal(calls, before, 'not asked while the line is hidden');
  resolve = null;
  feed.tick(); assert.equal(shown.at(-1), '');
});
