/**
 * 2026-11-21: an English character's own words (the ones she says without the user's message) are English.
 * (docs/claude/2026-11-21-proactive-language.md). The instructions of those calls
 * are Chinese for every card, so the card's language has to reach each of them: the prompt ends with one English line, and the line
 * validators leave an English sentence room. A Chinese card's prompts are byte for byte what they were.
 * Real modules over fakes; no Claude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ENGLISH_SPEECH_LINE, ENGLISH_TEXT_LINE, withSpeechLanguage } from '../shared/brain/chat-language';
import { spokenLineMax } from '../shared/foundation/spoken-line';
import { SPOKEN_ONLY_LINE } from '../shared/foundation/spoken-only-line';
import { buildR20OfferPrompt } from '../electron/initiative/r20-offer-dialogue';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import { INNER_LOOP_TEXT_MAX, innerLoopLine, parseInnerLoopDecision } from '../shared/initiative/inner-loop';
import { innerLoopPrompt } from '../electron/initiative/inner-loop/context';
import { parseRpsVoice } from '../shared/initiative/rps-voice';
import { feedLineText } from '../shared/senses/feed-recognition';
import { senseLineText } from '../shared/senses/sense-router';
import { RpsStore } from '../electron/initiative/rps/store';
import { RpsVoice } from '../electron/initiative/rps/voice';
import type { RpsMoment } from '../shared/initiative/rps-voice';

const NOW = Date.UTC(2026, 10, 21, 20, 34);
const sources = (language?: () => 'en' | 'zh-CN') => ({ now: () => NOW, localMinute: () => 12 * 60 + 34, persona: () => 'You are One.', language: () => '', mood: () => '',
  parameters: () => DEFAULT_MOOD_PARAMETERS, lastInteractionAt: () => NOW - 40 * 60_000, profileEnabled: () => false, profilePoints: () => '', audioReading: () => false,
  ambientText: () => '', ...(language ? { cardLanguage: language } : {}) });
const claim = { id: 'c', kind: 'speech', at: NOW, characterId: 'one', gateScope: 's' } as never;
const open = { asleep: false, drowsy: false, night: false, quiet: false };
/** I-178: an English card's prompt is the Chinese one with the "only what you say out loud" sentence swapped for its English twin. */
const twin = (zhPrompt: string) => zhPrompt.replace(SPOKEN_ONLY_LINE.zh, SPOKEN_ONLY_LINE.en);

test('withSpeechLanguage: an English card gets the one line last, a Chinese card (or none) gets the same string back', () => {
  assert.equal(withSpeechLanguage('提示', 'zh-CN'), '提示');
  assert.equal(withSpeechLanguage('提示'), '提示');
  assert.equal(withSpeechLanguage('提示', null), '提示');
  assert.equal(withSpeechLanguage('提示', 'en'), `提示\n\n${ENGLISH_SPEECH_LINE}`);
  assert.equal(withSpeechLanguage('提示', 'en', false), `提示\n\n${ENGLISH_TEXT_LINE}`);
  assert.match(ENGLISH_SPEECH_LINE, /in English/);
  assert.match(ENGLISH_SPEECH_LINE, /JSON keys/, 'the protocol words stay');
  assert.ok(!/12 words/.test(ENGLISH_TEXT_LINE), 'a plan or a letter is not held to one line');
});

test('the inner loop: with an English card the prompt asks for English as its last line; Chinese or no source is exactly the old prompt', () => {
  const old = innerLoopPrompt(sources() as never, claim, true, open);
  const zh = innerLoopPrompt(sources(() => 'zh-CN') as never, claim, true, open);
  const en = innerLoopPrompt(sources(() => 'en') as never, claim, true, open);
  assert.equal(zh, old, 'a Chinese card: byte for byte');
  assert.ok(!old.includes('English-speaking'));
  assert.equal(en, `${twin(old)}\n\n${ENGLISH_SPEECH_LINE}`); // I-178: and the "only what you say out loud" sentence is its English twin
  assert.ok(en.endsWith(ENGLISH_SPEECH_LINE));
  const broken = innerLoopPrompt({ ...sources(), cardLanguage: () => { throw new Error('no card'); } } as never, claim, true, open);
  assert.equal(broken, old, 'a failing source is Chinese, as before');
  // every kind of speech opportunity ends the same way (invite-only, play, a motion-only call too: she may still pick a line)
  for (const [allow, play, focus] of [[true, true, 'play'], [true, false, 'touch'], [false, false, undefined]] as const)
    assert.ok(innerLoopPrompt(sources(() => 'en') as never, claim, allow, open, null, play, focus as never).endsWith(ENGLISH_SPEECH_LINE), `${allow} ${play} ${focus}`);
});

test('an English line is no longer thrown away for its length: the same sentence needs about three times the characters', () => {
  assert.equal(spokenLineMax('你好', 30), 30);
  assert.equal(spokenLineMax('Hello there', 30), 90);
  assert.equal(spokenLineMax('Hello 你好', 30), 30, 'any Chinese: the Chinese limit');
  assert.equal(spokenLineMax('😊'.repeat(31), 30), 30, 'no letters at all: the old limit');
  const english = 'You have been quiet for a while, is everything okay over there?'; // 63 characters, 12 words
  assert.ok(english.length > INNER_LOOP_TEXT_MAX);
  assert.equal(innerLoopLine(english), english);
  assert.deepEqual(parseInnerLoopDecision(JSON.stringify({ action: 'speak', text: english }), true), { action: 'speak', text: english });
  assert.deepEqual(parseInnerLoopDecision(JSON.stringify({ action: 'invite', text: english }), true, null, true), { action: 'invite', text: english });
  assert.equal(innerLoopLine('x'.repeat(91)), null, 'still bounded');
  assert.equal(innerLoopLine('字'.repeat(31)), null, 'Chinese is bounded as before');
  assert.equal(innerLoopLine('字'.repeat(30)), '字'.repeat(30));
  assert.equal(parseRpsVoice('{"text":"Ha, that round is mine, and you saw it coming!"}'), 'Ha, that round is mine, and you saw it coming!');
  assert.equal(parseRpsVoice(`{"text":"${'字'.repeat(33)}"}`), null);
  assert.equal(feedLineText('Mmm, that is really good, can I have another one?'), 'Mmm, that is really good, can I have another one?');
  assert.equal(senseLineText('Oh, I can see it now, what flavour is that one in your hand?'), 'Oh, I can see it now, what flavour is that one in your hand?');
  // the follow-up has only a sanity ceiling (one ordinary reply, 400 Chinese characters); English gets 3x of it
  const longEnglish = 'I like it. '.repeat(60).trim(), longChinese = '好看。'.repeat(150);
  assert.ok(longEnglish.length > 400 && longEnglish.length <= 1200 && longChinese.length > 400);
  assert.equal(senseLineText(longEnglish), longEnglish, 'English: 3x the ceiling');
  assert.equal(senseLineText(longChinese), null, 'Chinese: over the ceiling is runaway output');
  assert.equal(senseLineText('好看。'.repeat(60)), '好看。'.repeat(60), 'a few sentences are fine now');
  assert.equal(senseLineText('这身很精神。\n领口也好看。'), '这身很精神。\n领口也好看。', 'a few lines are fine');
});

test('the task offer: an English card gets the longer-text variant of the line (a plan is not one short line); Chinese or none is the old prompt', () => {
  const input = { userText: 'hi', assistantText: 'hello', persona: 'You are One.', mood: 'calm' };
  const old = buildR20OfferPrompt(input);
  assert.equal(buildR20OfferPrompt({ ...input, language: 'zh-CN' }), old);
  assert.equal(buildR20OfferPrompt({ ...input, language: 'en' }), `${twin(old)}\n\n${ENGLISH_TEXT_LINE}`);
  assert.ok(!buildR20OfferPrompt({ ...input, language: 'en' }).includes('12 words'));
});

async function voiceFor(language: (() => 'en' | 'zh-CN') | undefined, prompts: string[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proactive-lang-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => 1_000 }); await store.load();
  const voice = new RpsVoice({ quick: async prompt => { prompts.push(prompt); return '{"text":"Mine!"}'; }, store, localDate: () => '2026-11-21', clock: () => 1_000, random: () => 0,
    timers: { set: () => 0, clear: () => {} }, ...(language ? { speechLanguage: language } : {}) });
  const character = { persona: 'You are One.', parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'happy' }, fatigue: null };
  const moment: RpsMoment = { kind: 'final', earlier: [], score: { her: 2, user: 0 }, result: 'her',
    round: { her: 'rock', user: 'scissors', outcome: 'her', intent: 'fair', reaction: 'win-round', tease: null } };
  voice.plan({ character: character as never, moment, saidThisMatch: 0, spokeLastRound: false });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { close: async () => { await store.flush(); await rm(dir, { recursive: true, force: true }); } };
}

test('her words in a game: an English card is asked in English; a Chinese card gets the old prompt', async () => {
  const en: string[] = [], zh: string[] = [], none: string[] = [];
  const a = await voiceFor(() => 'en', en), b = await voiceFor(() => 'zh-CN', zh), c = await voiceFor(undefined, none);
  try {
    assert.equal(en.length, 1); assert.equal(zh.length, 1); assert.equal(none.length, 1);
    assert.ok(en[0].endsWith(ENGLISH_SPEECH_LINE));
    assert.equal(zh[0], none[0]);
    assert.ok(!zh[0].includes('English-speaking'));
    assert.equal(en[0], `${twin(zh[0])}\n\n${ENGLISH_SPEECH_LINE}`);
  } finally { await a.close(); await b.close(); await c.close(); }
});

/**
 * The paths whose prompt is built inside a wiring or a host that a unit test cannot stand up cheaply (the keepsake, the feed and
 * look-and-hear lines, the ambient and listening comments, the screen topic she starts herself, the task offer): each one must wrap its
 * prompt with withSpeechLanguage and read the card's language from the card. A new proactive path that forgets it is the bug this file is about.
 */
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const PATHS: { name: string; file: string; wraps: RegExp; source?: { file: string; has: RegExp } }[] = [
  { name: 'inner loop', file: 'electron/initiative/inner-loop/context.ts', wraps: /return withSpeechLanguage\(buildInnerLoopPrompt\(/, source: { file: 'electron/wiring/initiative-inner-loop-wiring.ts', has: /cardLanguage: \(\) => cardLanguageOf\(needs\.characterCards\.getActive\(\)\)/ } },
  { name: 'task offer', file: 'electron/wiring/initiative-inner-loop-wiring.ts', wraps: /language:characterCards\.getActive\(\)\.language==='en'\?'en':'zh-CN' \};/ },
  { name: 'game lines', file: 'electron/initiative/rps/voice.ts', wraps: /withSpeechLanguage\(rpsVoicePrompt\(/, source: { file: 'electron/wiring/initiative-together-wiring.ts', has: /speechLanguage: \(\) => cardLanguageOf\(needs\.characterCards\.getActive\(\)\), speechStyle/ } },
  { name: 'keepsake', file: 'electron/initiative/her-folder/keepsake.ts', wraps: /withSpeechLanguage\(keepsakePrompt\(/, source: { file: 'electron/wiring/initiative-together-wiring.ts', has: /userProfileManagement\?\.get\(\) \?\? null, speechLanguage: \(\) => cardLanguageOf\(/ } },
  { name: 'feeding line', file: 'electron/senses/feed-recognition/host.ts', wraps: /withSpeechLanguage\(feedLinePrompt\(/, source: { file: 'electron/wiring/initiative-together-wiring.ts', has: /speech: cardLanguageOf\(card\) \}; \},\s+chatModel/ } },
  { name: 'look-and-hear line', file: 'electron/senses/sense-router/host.ts', wraps: /withSpeechLanguage\(senseLinePrompt\(/, source: { file: 'electron/wiring/initiative-look-wiring.ts', has: /speech: cardLanguageOf\(card\) \}; \}/ } },
  { name: 'ambient comment', file: 'electron/senses/ambient-comments.ts', wraps: /withSpeechLanguage\(ambientCommentPrompt\(/, source: { file: 'electron/wiring/senses-listen-wiring.ts', has: /speechLanguage: \(\) => cardLanguageOf\(characterCards\.getActive\(\)\)/ } },
  { name: 'listening comment', file: 'electron/senses/listen-together/proactive.ts', wraps: /withSpeechLanguage\(listenSpeakPrompt\(/ },
  { name: 'screen topic she starts', file: 'electron/wiring/senses-look-wiring.ts', wraps: /return withSpeechLanguage\(`\$\{settings\.persona\}[\s\S]{0,200}cardLanguageOf\(characterCards\.getActive\(\)\)\)/ },
];
for (const path of PATHS) {
  test(`proactive path "${path.name}" reads the card's language and asks for English`, () => {
    assert.match(read(path.file), path.wraps, `${path.file} no longer wraps its prompt with withSpeechLanguage`);
    if (path.source) assert.match(read(path.source.file), path.source.has, `${path.source.file} no longer passes the card's language`);
  });
}
