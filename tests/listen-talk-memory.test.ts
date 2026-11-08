// 2026-11-07 (docs/claude/2026-11-07-listen-talk-memory.md): a narration video ("这视频的文案怎么样") has voices and no music, so the host
// calls it talk and, until now, kept nothing. Now its words wait in memory for ten minutes (never on disk) and come along only when the
// user asks about what is playing; her hearing line says someone is talking instead of "没在放东西"; the ask words are wider.
// Synthetic transcripts only, a fake clock, a fake listen-kind producer; the one disk test uses a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ListenKindHost, type ListenKind } from '../shared/listen-kind';
import { LISTEN_LIMITS } from '../shared/listen-together';
import { matchListenAsk } from '../shared/listen-ask';
import { briefHearingWords, hearingWords, type HearingNow } from '../shared/her-state';
import { perceptionTurnLine, type PerceptionTurn } from '../shared/perception-rule';
import { createHerState, StageStateHost } from '../electron/her-state-host';
import { ListenTogetherCore, NO_LISTEN_ASK, type ListenFile } from '../electron/listen-together/core';
import { ListenStore } from '../electron/listen-together/store';
import { TalkMemory } from '../electron/listen-together/talk-memory';

const MIN = 60_000;
const NARRATION = '合成解说词这一期我们来聊聊雨天为什么会让人想起远方的朋友，先看第一个原因';
const NARRATION_2 = '合成解说词第二个原因是气味，潮湿的泥土味会把很久以前的记忆一起带回来';

function rig(options: { character?: () => string | null; save?: (file: ListenFile) => Promise<void> } = {}) {
  let clock = 1_000_000_000, revision = 0, listening = true;
  const kinds = new ListenKindHost(), saved: ListenFile[] = [];
  const core = new ListenTogetherCore({ kinds, characterId: options.character ?? (() => 'card-a'), listening: () => listening, now: () => clock,
    note: async () => '', save: options.save ?? (async file => { saved.push(file); }), createId: () => `seg-${revision}` });
  const kind = (k: ListenKind) => { kinds.set({ kind: k, confidence: 0.9, since: clock, revision: ++revision }); core.tick(); };
  const hear = (text: string) => core.accept({ at: clock - 8_000, end: clock, text, language: 'zh' });
  const advance = (ms: number, step = 1_000) => { for (let t = 0; t < ms; t += step) { clock += step; core.tick(); } };
  return { core, kind, hear, advance, saved, now: () => clock, setListening(v: boolean) { listening = v; core.tick(); }, flipWithoutTick(v: boolean) { listening = v; } };
}
const ASK = '这视频讲了什么';

test('a narration-only video (talk): asking about the video brings its last words; the text is in no segment and no note', () => {
  const r = rig();
  r.kind('talk');
  assert.equal(r.hear(NARRATION), 'talk');
  r.advance(20_000);
  r.hear(NARRATION_2);
  const turn = r.core.askTurn(ASK);
  assert.ok(turn.block.includes(NARRATION) && turn.block.includes(NARRATION_2), 'both pieces come along');
  assert.match(turn.block, /<external-audio-data>/u);
  assert.equal(r.core.segmentsFor('card-a').length, 0, 'still no segment');
  assert.equal(r.core.notesFor('card-a').length, 0, 'still no note');
});

test('the first seconds of narration (kind still unsure) join the talk memory once the host settles on talk, not a segment', () => {
  const r = rig();
  r.kind('unsure');
  assert.equal(r.hear(NARRATION), 'pending');
  r.advance(5_000);
  r.kind('talk');
  assert.ok(r.core.askTurn(ASK).block.includes(NARRATION));
  assert.equal(r.core.segmentsFor('card-a').length, 0);
});

test('ten minutes: still there at 9, gone after 10 (and the cap holds)', () => {
  const r = rig();
  r.kind('talk'); r.hear(NARRATION);
  r.advance(9 * MIN);
  assert.ok(r.core.askTurn(ASK).block.includes(NARRATION), 'nine minutes later');
  r.advance(MIN + 2_000);
  assert.equal(r.core.askTurn(ASK).block, '', 'past ten minutes: nothing');
  assert.equal(LISTEN_LIMITS.talkMemoryMs, 10 * MIN);
  const memory = new TalkMemory(10 * MIN, 100);
  for (let i = 0; i < 5; i++) memory.add('c', 'x'.repeat(40), 1_000 + i);
  assert.ok(memory.view('c', 2_000)!.text.replaceAll('\n', '').length <= 120, 'oldest pieces go first beyond the cap');
});

test('switching 一起听 off clears it, and switching on again does not bring it back; a turn composed before the switch loses it', () => {
  const r = rig();
  r.kind('talk'); r.hear(NARRATION);
  const early = r.core.askTurn(ASK), persona = `前文${early.block}后文`;
  assert.equal(early.current(persona), persona, 'unchanged while nothing went');
  r.setListening(false);
  assert.equal(r.core.askTurn(ASK).block, '', 'off: nothing');
  assert.ok(!early.current(persona).includes(NARRATION), 'the late window drops it from a turn already composed');
  r.setListening(true);
  assert.equal(r.core.askTurn(ASK).block, '', 'on again: it was cleared, not paused');
});

test('the user clearing the listening data clears it', () => {
  const r = rig();
  r.kind('talk'); r.hear(NARRATION);
  const early = r.core.askTurn(ASK), persona = `前文${early.block}后文`;
  r.core.clearRaw();
  assert.equal(r.core.askTurn(ASK).block, '');
  assert.ok(!early.current(persona).includes(NARRATION));
});

test('another character does not see it, and forgetting the character clears it; quit lets go of it', () => {
  let character: string | null = 'card-a';
  const r = rig({ character: () => character });
  r.kind('talk'); r.hear(NARRATION);
  character = 'card-b';
  assert.equal(r.core.askTurn(ASK).block, '', 'card-b never heard it');
  r.core.tick(); // the one-second tick sees the other character
  character = 'card-a'; r.core.tick();
  assert.equal(r.core.askTurn(ASK).block, '', 'and it was dropped when the character changed');
  r.kind('talk'); r.hear(NARRATION);
  r.core.forgetCharacter('card-a');
  assert.equal(r.core.askTurn(ASK).block, '');
  r.hear(NARRATION); assert.ok(r.core.askTurn(ASK).block.includes(NARRATION));
  r.core.dropMemory();
  assert.equal(r.core.askTurn(ASK).block, '');
});

test('nothing is ever written: no save carries it, and a real store directory stays empty', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-talk-memory-'));
  try {
    const store = new ListenStore(directory);
    const r = rig({ save: file => store.save(file) });
    r.kind('talk'); r.hear(NARRATION); r.advance(30_000); r.hear(NARRATION_2);
    r.kind('music'); r.hear('合成歌词这是一首歌的第一句'); r.advance(5_000); r.kind('quiet'); r.advance(10_000);
    await r.core.flush();
    for (const name of await readdir(directory)) {
      const text = await readFile(path.join(directory, name), 'utf8');
      assert.ok(!text.includes('合成解说词'), `${name} must not hold talk words`);
    }
    assert.ok(r.core.askTurn(ASK).block.includes(NARRATION), 'while still in memory');
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
  const talkOnly = rig();
  talkOnly.kind('talk'); talkOnly.hear(NARRATION); talkOnly.advance(2 * MIN); await talkOnly.core.flush();
  assert.ok(talkOnly.saved.every(file => !JSON.stringify(file).includes('合成解说词')), 'no snapshot holds it');
});

test('it comes only for a question about what is playing, and the earlier refusals still hold for talk', () => {
  const r = rig();
  r.kind('talk'); r.hear(NARRATION);
  const has = (text: string) => r.core.askTurn(text).block.includes(NARRATION);
  assert.ok(has(ASK));
  assert.ok(has('这个视频的文案怎么样'));
  // I-047: a question that matched opens the "talking about the show" window, in which small talk carries the latest words too
  // (docs/claude/2026-11-07-watch-timely.md), so each of these starts from a fresh listen core with no window.
  const cold = (text: string) => { const q = rig(); q.kind('talk'); q.hear(NARRATION); return q.core.askTurn(text).block.includes(NARRATION); };
  for (const text of ['今天天气怎么样', '你听到了吗', '这首歌怎么样', '这首歌的歌词是什么', '上次那个视频讲了什么', '晚饭吃什么']) assert.ok(!cold(text), `no talk words for: ${text}`);
  for (const text of [
    '不要引用这视频的内容', '别管这视频讲了什么', '禁止逐字引用这视频的台词。请只说今天是星期几。', '请把「这视频讲了什么」翻译成英文',
    '他说：这视频讲了什么', '朋友问我这视频讲了什么', "don't quote the video", '这视频的字幕别原样复述',
  ]) assert.ok(!has(text), `refused or quoted, no talk words for: ${text}`);
  // Unclear (a no elsewhere): never raw text, so no talk words either.
  assert.ok(!has('这视频讲了什么？我不太喜欢吵的'.replace('不太喜欢吵的', '不要原样念出来')));
  // Not listening: nothing, whatever was held, even in the second before the one-second tick has looked.
  r.flipWithoutTick(false); assert.equal(r.core.askTurn(ASK).block, '', 'off, tick not yet run');
  r.setListening(false); assert.equal(r.core.askTurn(ASK).block, '');
  assert.equal(NO_LISTEN_ASK.block, '');
});

test('the ask words: 文案、说了什么、讲了什么、在说什么、这段话、这个讲解、字幕、台词说的 about the current video match; her own words do not', () => {
  const speech = (text: string) => matchListenAsk(text)?.speech === true;
  for (const text of ['这视频的文案怎么样', '这个视频文案写得好不好', '这段文案怎么样？视频里的', '视频文案你觉得呢', '讲解在说什么', '他们在说什么', '它在说什么', '主持人讲了什么',
    '里面说了什么', '视频里说了些什么', '这段话是什么意思', '这个讲解怎么样', '这个解说好不好', '字幕上写了什么', '这个视频的字幕对吗', '台词说的是什么', '刚才那段说了什么',
    '你听听这段话', '旁白在说什么']) assert.ok(speech(text), `should match: ${text}`);
  for (const text of ['你刚才说了什么', '你刚刚说了什么呀', '你在说什么', '你刚才说的这段话是什么意思', '你说的这个讲解我没懂', '我刚才说了什么', '说了什么', '帮我写个视频文案', '帮我改一下这个文案',
    '我们在说什么', '你上面讲了什么', '你刚才那段话再说一遍']) assert.ok(!speech(text), `must not pull audio text: ${text}`);
  // The three nouns ask about the sound's content, so they are a match at all (target show); a song question stays a song question.
  assert.equal(matchListenAsk('这视频的文案怎么样')?.target, 'show');
  assert.equal(matchListenAsk('这首歌怎么样')?.speech, false);
  assert.equal(matchListenAsk('你听到了吗')?.speech, false);
  assert.equal(matchListenAsk('上次那集讲了什么')?.speech, false);
});

// ---- her hearing line ----

const sight = (): PerceptionTurn => ({ screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null });
const heard = (patch: Partial<HearingNow>): HearingNow => ({ source: 'system-audio', stage: { music: 'silent', always: false }, transcript: false, ...patch });
const NOTHING = /没在放东西|很安静/u;

test('her line while the stage hears "silent": someone talking / a song / a show or video / only rhythm / nothing audible, never "没在放东西" without evidence', () => {
  const talking = hearingWords(heard({ kind: 'talk' }));
  assert.match(talking, /有人在说话/u); assert.match(talking, /本机在转写/u); assert.doesNotMatch(talking, NOTHING);
  const spoken = hearingWords(heard({ speaking: true }));
  assert.match(spoken, /有人在说话/u); assert.doesNotMatch(spoken, NOTHING);
  assert.match(hearingWords(heard({ kind: 'sound', speaking: true })), /有人在说话/u, 'unsettled kind but words arriving');
  assert.match(hearingWords(heard({ kind: 'show' })), /在放剧或视频的声音/u);
  assert.match(hearingWords(heard({ kind: 'music' })), /在放歌/u);
  assert.match(hearingWords(heard({ kind: 'rhythm' })), /只听得到一点节奏，没有转写/u);
  for (const quiet of [heard({}), heard({ kind: 'sound' })]) { const line = hearingWords(quiet); assert.match(line, /这会儿好像没声音/u); assert.doesNotMatch(line, /没在放东西/u); }
  assert.match(briefHearingWords(heard({ kind: 'talk' })), /有人在说话/u);
  assert.match(briefHearingWords(heard({ speaking: true })), /有人在说话/u);
  assert.match(briefHearingWords(heard({})), /这会儿好像没声音/u);
  // The turn's whole line, as the model reads it.
  assert.match(perceptionTurnLine(sight(), { hearing: heard({ kind: 'talk' }), contacts: [] }), /用户让你听到电脑里的声音，有人在说话（本机在转写/u);
  // Words that belong to the song, not to talk: a song with lyrics must not read as talk.
  assert.doesNotMatch(hearingWords(heard({ kind: 'music', speaking: true })), /有人在说话/u);
  // Not the computer's sound: the microphone is never "transcribed" here.
  assert.doesNotMatch(hearingWords(heard({ source: 'microphone', speaking: true })), /本机在转写/u);
  // Not silent: talk is also honest that it is being transcribed (it used to say it could not understand anything).
  const noisy = hearingWords(heard({ kind: 'talk', stage: { music: 'still', always: false } }));
  assert.match(noisy, /本机在转写/u); assert.doesNotMatch(noisy, /听不懂在说什么/u);
});

test('the host reads "someone is talking" from the listen core, tells it once when words first arrive while the kind is unsettled, and never when the switch is off', () => {
  const r = rig();
  const stage = new StageStateHost(() => r.now());
  stage.accept({ instance: 'instance-0001', seq: 1, music: 'silent', always: false });
  const her = createHerState({ stage, capture: () => ({ slots: { 'system-audio': { dance: true } } }) as never, legacy: () => null, contacts: () => [],
    scope: () => 'scope-1', now: () => r.now(), kind: () => undefined, speaking: () => r.core.spokenWithin() });
  assert.equal(her.chatTurn('', '在干嘛').hearing.speaking, undefined, 'nothing heard yet');
  assert.match(hearingWords(her.chatTurn('', '在干嘛').hearing), /这会儿好像没声音/u);
  r.kind('unsure'); r.hear(NARRATION);
  const turn = her.chatTurn('', '随便聊聊');
  assert.equal(turn.hearing.speaking, true);
  assert.equal(turn.say, 'full', 'new news: said once in full');
  assert.match(hearingWords(turn.hearing), /有人在说话/u);
  r.advance(LISTEN_LIMITS.speechRecentMs + 5_000);
  stage.accept({ instance: 'instance-0001', seq: 2, music: 'silent', always: false });
  assert.equal(her.chatTurn('', '随便聊聊').hearing.speaking, undefined, 'a long pause in the words');
  assert.equal(her.chatTurn('', '随便聊聊').say, 'none', 'and the pause alone is not told again');
  r.setListening(false);
  assert.equal(r.core.spokenWithin(), false);
});
