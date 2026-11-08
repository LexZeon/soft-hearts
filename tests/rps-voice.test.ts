/** G1 猜拳: whether she says something at a moment, what she is asked, and what of her answer may reach the bubble (shared/rps-voice.ts, electron/rps/voice.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import { RPS_VOICE_SAFETY, parseRpsVoice, rpsMomentClass, rpsReusableLine, rpsSayHoldMs, rpsVoiceChance, rpsVoicePrompt, type RpsMoment, type RpsVoiceInput } from '../shared/rps-voice';
import { RpsStore, RPS_REMEMBERED } from '../electron/rps/store';
import { RpsVoice, rpsVoiceCardKey } from '../electron/rps/voice';
import { seeded } from './helpers/seeded';

const card = (weights: Partial<MoodParameters['weights']> = {}, text = 50): MoodParameters => ({ ...DEFAULT_MOOD_PARAMETERS,
  weights: { ...DEFAULT_MOOD_PARAMETERS.weights, ...weights }, intensity: { ...DEFAULT_MOOD_PARAMETERS.intensity, text } });
const round = (outcome: 'her' | 'user' | 'draw', extra: Partial<NonNullable<RpsMoment['round']>> = {}): NonNullable<RpsMoment['round']> => ({
  her: 'rock', user: outcome === 'her' ? 'scissors' : outcome === 'user' ? 'paper' : 'rock', outcome, intent: 'fair',
  reaction: outcome === 'her' ? 'win-round' : outcome === 'user' ? 'lose-round' : 'draw', tease: null, ...extra });
const moment = (kind: RpsMoment['kind'], extra: Partial<RpsMoment> = {}): RpsMoment => ({ kind, earlier: [], score: { her: 1, user: 0 },
  ...(kind === 'round' || kind === 'final' ? { round: round('her') } : {}), ...(kind === 'final' ? { result: 'her' as const, score: { her: 2, user: 0 } } : {}), ...extra });
const input = (extra: Partial<RpsVoiceInput> = {}): RpsVoiceInput => ({ moment: moment('round'), parameters: card(), mood: 'happy', fatigue: null,
  saidThisMatch: 0, spokeLastRound: false, saidToday: 0, ...extra });

test('whether she speaks: the decisive round and a pretend cheat call for words, an ordinary round only now and then; her character and mood shape it', () => {
  const ordinary = rpsVoiceChance(input()), final = rpsVoiceChance(input({ moment: moment('final') }));
  const tease = rpsVoiceChance(input({ moment: moment('round', { round: round('user', { reaction: 'tease', tease: 'scissors' }) }) }));
  assert.ok(ordinary > 0.15 && ordinary < 0.5, `ordinary ${ordinary}`);
  assert.ok(final > 0.8, `final ${final}`); assert.ok(tease > 0.9, `tease ${tease}`);
  assert.ok(rpsVoiceChance(input({ moment: moment('round', { round: round('draw') }) })) < ordinary, 'a single draw is a small thing');
  assert.ok(rpsVoiceChance(input({ moment: moment('round', { round: round('draw'), earlier: [{ her: 'paper', user: 'paper', outcome: 'draw' }] }) })) > ordinary, 'a second draw in a row is not');
  const comeback = rpsVoiceChance(input({ moment: moment('round', { round: round('her'), score: { her: 1, user: 1 }, earlier: [{ her: 'rock', user: 'paper', outcome: 'user' }] }) }));
  assert.ok(comeback > ordinary, 'coming back from behind');
  assert.ok(rpsVoiceChance(input({ parameters: card({ playful: 2, close: 1.5 }) })) > ordinary, 'playful and close: more');
  assert.ok(rpsVoiceChance(input({ parameters: card({ cautious: 2 }) })) < ordinary, 'cautious: less');
  assert.ok(rpsVoiceChance(input({ parameters: card({}, 90) })) > ordinary, 'expressive words: more');
  assert.ok(rpsVoiceChance(input({ mood: 'sad' })) < rpsVoiceChance(input({ mood: 'excited' })), 'mood');
  assert.ok(rpsVoiceChance(input({ fatigue: 'drowsy' })) < ordinary, 'sleepy: quieter');
  for (const kind of ['decline', 'quit', 'timeout'] as const) assert.ok(rpsVoiceChance(input({ moment: moment(kind) })) > ordinary, kind);
});

test('the soft cap: what she already said presses the chance down smoothly (no cliff), right after a line it halves, a strong moment keeps most of its want', () => {
  let previous = Infinity;
  for (let said = 0; said <= 6; said++) {
    const chance = rpsVoiceChance(input({ saidThisMatch: said }));
    assert.ok(chance < previous && chance > 0, `${said}: ${chance}`);
    previous = chance;
  }
  assert.ok(Math.abs(rpsVoiceChance(input({ spokeLastRound: true })) - rpsVoiceChance(input()) / 2) < 1e-9);
  const today = [0, 10, 30, 60, 120].map(saidToday => rpsVoiceChance(input({ saidToday })));
  for (let i = 1; i < today.length; i++) assert.ok(today[i] < today[i - 1] && today[i] > today[i - 1] * 0.4, `today ${today}`);
  const strong = rpsVoiceChance(input({ moment: moment('final'), saidThisMatch: 4, spokeLastRound: true, saidToday: 60 }));
  assert.ok(strong >= 0.6 * rpsVoiceChance(input({ moment: moment('final') })) - 1e-9, `strong ${strong}`);
  for (const extra of [input({ parameters: card({ playful: 3, close: 3, cautious: 0 }, 100), mood: 'excited', moment: moment('final') })])
    assert.ok(rpsVoiceChance(extra) <= 0.97);
});

test('a typical match: about one or two lines, mostly at the end (simulated with the chance alone)', () => {
  const random = seeded(4);
  let lines = 0, finalLines = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    let said = 0, last = -2;
    const rounds = 2 + Math.floor(random() * 3);
    for (let r = 0; r < rounds; r++) {
      const final = r === rounds - 1;
      const outcome = (['her', 'user', 'draw'] as const)[Math.floor(random() * 3)];
      const m = final ? moment('final') : moment('round', { round: round(outcome) });
      if (random() < rpsVoiceChance(input({ moment: m, saidThisMatch: said, spokeLastRound: last === r - 1 }))) { said++; last = r; if (final) finalLines++; }
    }
    lines += said;
  }
  assert.ok(lines / N > 0.9 && lines / N < 2, `lines per match ${lines / N}`);
  assert.ok(finalLines / N > 0.6, `she nearly always says something at the end: ${finalLines / N}`);
});

test('what she is asked: who she is, how she feels, what just happened in plain words, and the answer\'s shape; nothing to copy into her words', () => {
  const tease = rpsVoicePrompt({ persona: '角色：小葵，傲娇。', mood: 'happy', fatigue: 'light-drowsy',
    moment: moment('round', { round: round('user', { reaction: 'tease', tease: 'scissors' }), score: { her: 1, user: 1 }, earlier: [{ her: 'paper', user: 'rock', outcome: 'her' }] }) });
  assert.match(tease, /^角色：小葵，傲娇。/u);
  assert.match(tease, /愉快，有一点点困/u);
  assert.match(tease, /前面：第一次你出布、用户出石头，你赢/u);
  assert.match(tease, /刚刚揭晓：第二次你出石头、用户出布，用户赢/u);
  assert.match(tease, /其实出的是剪刀/u);
  assert.match(tease, /\{"text":"你要说的话"\}/u); assert.match(tease, /\{"text":""\}/u);
  assert.doesNotMatch(tease.replace('角色：小葵，傲娇。', ''), /[他她]/u);
  const soft = rpsVoicePrompt({ persona: 'p', mood: 'calm', fatigue: null, moment: moment('round', { round: round('user', { intent: 'soft', reaction: 'soft-lose' }) }) });
  assert.match(soft, /故意让着用户的，你不打算说破/u);
  const final = rpsVoicePrompt({ persona: 'p', mood: 'calm', fatigue: null, moment: moment('final', { round: round('user', { reaction: 'lose-game' }), result: 'user', score: { her: 1, user: 2 } }) });
  assert.match(final, /这一场用户赢了（2 比 1）/u);
  assert.match(rpsVoicePrompt({ persona: 'p', mood: 'calm', fatigue: null, moment: moment('decline') }), /用户说下次吧/u);
  assert.match(rpsVoicePrompt({ persona: 'p', mood: 'calm', fatigue: null, moment: moment('timeout') }), /好一会儿都没出拳/u);
});

test('what of her answer reaches the bubble: exactly the asked JSON with one plain line; quiet is allowed; notes, third person, brackets and technical words never', () => {
  assert.equal(parseRpsVoice('{"text":"哼，刚才不算！"}'), '哼，刚才不算！');
  assert.equal(parseRpsVoice('```json\n{"text":"再来！"}\n```'), '再来！');
  assert.equal(parseRpsVoice('{"text":""}'), '', 'she may say nothing');
  assert.equal(parseRpsVoice('{"text":"  "}'), '');
  for (const bad of ['再来！', 'Keep it short. {"text":"好"}', '{"text":"好","why":"x"}', '{"text":3}', '[]', '{"text":"用户赢了，表现得不服气"}',
    '{"text":"（扬起下巴）哼"}', '{"text":"(smug) 哼"}', '{"text":"【得意】哼"}', '{"text":"我是Claude"}', '{"text":"模型说"}', '{"text":"一\\n二"}',
    '{"text":"' + '一'.repeat(40) + '"}', 'x'.repeat(3000)])
    assert.equal(parseRpsVoice(bad), null, bad.slice(0, 40));
});

test('which kind of moment a line belongs to, and which lines are worth keeping for the days without the model', () => {
  assert.equal(rpsMomentClass(moment('round', { round: round('draw') })), 'round-draw');
  assert.equal(rpsMomentClass(moment('round', { round: round('user', { intent: 'soft', reaction: 'soft-lose' }) })), 'round-user');
  assert.equal(rpsMomentClass(moment('final', { result: 'user' })), 'final-user');
  assert.equal(rpsMomentClass(moment('final', { result: 'none' })), null);
  assert.equal(rpsMomentClass(moment('round', { round: round('user', { reaction: 'tease', tease: 'paper' }) })), null, 'a pretend cheat names a hand on screen');
  assert.equal(rpsMomentClass(moment('decline')), 'decline');
  assert.equal(rpsReusableLine('哼，刚才不算！'), true);
  assert.equal(rpsReusableLine('又出布？'), false);
  assert.ok(rpsSayHoldMs('嗯') >= 2_500 && rpsSayHoldMs('一'.repeat(200)) <= 12_000);
});

async function voiceHarness(options: { quick?: (prompt: string) => Promise<string>; available?: () => boolean; random?: () => number } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rps-voice-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => 1_000 }); await store.load();
  const voice = new RpsVoice({ quick: options.quick, available: options.available, store, localDate: () => '2026-11-03', clock: () => 1_000,
    random: options.random ?? (() => 0), timers: { set: () => 0, clear: () => {} } });
  const character = { persona: '角色：基恩', parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'happy' }, fatigue: null };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { dir, store, voice, character, flush, close: async () => { await store.flush(); await rm(dir, { recursive: true, force: true }); } };
}

test('her remembered lines: only live ones that name no hand, a few per kind and card, kept on disk; a ceiling far above normal play stops runaway calls', async () => {
  let answer = '{"text":"嘿嘿，这局算我的"}', calls = 0;
  const h = await voiceHarness({ quick: async () => { calls++; return answer; } });
  const said = async (m: RpsMoment) => { const line = h.voice.plan({ character: h.character, moment: m, saidThisMatch: 0, spokeLastRound: false })!; await h.flush(); h.voice.said(line); return line; };
  const win = moment('round', { round: round('her') });
  assert.equal((await said(win)).text, '嘿嘿，这局算我的');
  answer = '{"text":"布果然最强"}';
  await said(win);
  const key = rpsVoiceCardKey('角色：基恩');
  assert.deepEqual(h.store.remembered(key, 'round-her'), ['嘿嘿，这局算我的'], 'a line naming a hand is not kept');
  for (let i = 0; i < 8; i++) { answer = `{"text":"第${'一二三四五六七八'[i]}句"}`; await said(win); }
  assert.equal(h.store.remembered(key, 'round-her').length, RPS_REMEMBERED.perClass);
  await h.store.flush();
  const disk = await readFile(path.join(h.dir, 'rps.json'), 'utf8');
  assert.match(disk, /第八句/u); assert.doesNotMatch(disk, /用户|角色：基恩/u, 'her words only, keyed by a hash of the card');
  const reloaded = new RpsStore({ file: () => path.join(h.dir, 'rps.json'), now: () => 1_000 }); await reloaded.load();
  assert.deepEqual(reloaded.remembered(key, 'round-her'), h.store.remembered(key, 'round-her'));
  // The protective ceiling: past it no call, her remembered lines instead.
  calls = 0;
  for (let i = 0; i < RPS_VOICE_SAFETY.callsPerDay + 5; i++) { h.voice.plan({ character: h.character, moment: win, saidThisMatch: 0, spokeLastRound: false }); await h.flush(); }
  assert.ok(calls <= RPS_VOICE_SAFETY.callsPerDay && calls >= RPS_VOICE_SAFETY.callsPerDay - 11, `calls ${calls}`);
  assert.ok(RPS_VOICE_SAFETY.callsPerDay >= 40, 'far above a day of normal play');
  const after = h.voice.plan({ character: h.character, moment: win, saidThisMatch: 0, spokeLastRound: false })!;
  assert.equal(after.source, 'remembered');
  await h.close();
});

test('a refused or failed call falls back to one of her own earlier lines (not the same as last time); quiet when she has none', async () => {
  const h = await voiceHarness({ quick: async () => { throw new Error('offline'); } });
  const key = rpsVoiceCardKey('角色：基恩');
  const first = h.voice.plan({ character: h.character, moment: moment('round', { round: round('user') }), saidThisMatch: 0, spokeLastRound: false })!;
  await h.flush();
  assert.equal(first.text, null, 'nothing remembered yet');
  h.store.remember(key, 'round-user', '刚才不算！'); h.store.remember(key, 'round-user', '再来一次！');
  const texts = new Set<string>();
  let previous = '';
  for (let i = 0; i < 6; i++) {
    const line = h.voice.plan({ character: h.character, moment: moment('round', { round: round('user') }), saidThisMatch: 0, spokeLastRound: false })!;
    await h.flush();
    assert.notEqual(line.text, previous, 'not the same one twice in a row'); previous = line.text!; texts.add(line.text!);
  }
  assert.deepEqual([...texts].sort(), ['再来一次！', '刚才不算！'].sort());
  await h.close();
});
