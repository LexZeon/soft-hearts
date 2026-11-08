// L2 预试用问题 6（2026-11-03）：她正在做自己的事时，用户的任何互动（打字、摸头、说话）都让她像从那件事里抬起头，
// 那一轮私有上下文里带上她刚才在做什么；抬头的样子按她的性格和心情有点不同（I-013：有个性的随机，不重复刚做过的）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HER_LIFE_LOOK_UP_KINDS, herLifeLookUpStyle, type HerLifeActivity, type HerLifeLookUpKind, type HerLifeView } from '../shared/her-life';
import { HerLifeHost, type HerLifeTickInput } from '../electron/her-life/host';
import { HerLifeStage } from '../src/stage/her-life-stage';
import { CompanionService } from '../electron/companion';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import type { ProviderConfig } from '../shared/contracts';

const MINUTE = 60_000;
const card = (weights: Partial<MoodParameters['weights']> = {}): MoodParameters => ({ ...structuredClone(DEFAULT_MOOD_PARAMETERS),
  weights: { ...DEFAULT_MOOD_PARAMETERS.weights, ...weights } });
const seeded = (seed: number) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };

function lifeHost(random: () => number = () => 0.5) {
  const clock = { now: 1_000 * MINUTE };
  const host = new HerLifeHost({ file: () => null, diagnosticsFile: () => null, developerMode: () => false, changed: () => {}, clock: () => clock.now, random });
  const tick = (over: Partial<HerLifeTickInput> = {}) => host.tick('gene', { now: clock.now, expressions: true, canExpress: true, phase: 'idle',
    lastInteractionAt: clock.now, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60, ...over });
  return { host, clock, tick };
}

test('测试命令开始的事（你一直在场）：你一打字或摸头，她就抬头，下一轮带上她刚才在做什么', () => {
  for (const activity of ['daydream', 'humming', 'thinking', 'drowsy'] as const) {
    const h = lifeHost();
    h.tick();
    h.host.startNow('gene', activity, { parameters: card(), mood: 'calm', localMinute: 14 * 60 });
    h.clock.now += 4_000;
    // Typing in the chat box (electron: noteChatTyping → CompanionService.noteTyping → HerLifeHost.interact).
    assert.equal(h.host.interact('gene', h.clock.now), true, `${activity}: an interaction 4 s later lifts her out of it`);
    const view = h.host.view('gene')!;
    assert.equal(view.activity, 'company');
    assert.ok(view.lookUp, `${activity}: the stage gets a look-up`);
    assert.ok(HER_LIFE_LOOK_UP_KINDS.includes(view.lookUp!.style!.kind), 'with a style of her own');
    const line = h.host.chatTurn('gene', h.clock.now + 2_000);
    assert.match(line, /^你刚才在：.+（刚开始没一会儿），被用户打断了/u, `${activity}: the next chat turn hears what she was doing`);
    assert.equal(h.host.chatTurn('gene', h.clock.now + 5_000), '', 'once');
  }
});

test('"陪着你"时互动不算打断：没有抬头、没有那一行', () => {
  const h = lifeHost();
  h.tick();
  assert.equal(h.host.interact('gene', h.clock.now + 1_000), false);
  assert.equal(h.host.view('gene')!.lookUp, null);
  assert.equal(h.host.chatTurn('gene', h.clock.now + 2_000), '');
});

test('抬头的样子：按她的性格、心情和刚才在做什么，在一个范围里取值，不重复刚做过的', () => {
  const tally = (input: Omit<Parameters<typeof herLifeLookUpStyle>[0], 'previous'>, seed: number) => {
    const random = seeded(seed), counts: Partial<Record<HerLifeLookUpKind, number>> = {};
    let previous: HerLifeLookUpKind | null = null;
    for (let i = 0; i < 400; i++) {
      const style = herLifeLookUpStyle({ ...input, previous }, random);
      assert.notEqual(style.kind, previous, 'never the same look twice in a row');
      for (const [key, [low, high]] of Object.entries({ pace: [0.8, 1.7], hold: [0.7, 1.5], lift: [0.45, 1.4], tilt: [0, 0.03], smile: [0, 0.4] }))
        assert.ok(style[key as 'pace'] >= low && style[key as 'pace'] <= high, `${key} ${style[key as 'pace']} in its range`);
      counts[style.kind] = (counts[style.kind] ?? 0) + 1; previous = style.kind;
    }
    return counts;
  };
  const share = (counts: Partial<Record<HerLifeLookUpKind, number>>, kinds: HerLifeLookUpKind[]) => kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0) / 400;
  const playfulHappy = tally({ from: 'humming', mood: 'happy', weights: card({ playful: 1.8 }).weights }, 1);
  const cautiousWorried = tally({ from: 'daydream', mood: 'concerned', weights: card({ cautious: 1.8 }).weights }, 2);
  const sleepy = tally({ from: 'drowsy', mood: 'calm', weights: card().weights }, 3);
  assert.ok(share(playfulHappy, ['bright', 'curious']) > 0.6, `玩闹又开心：多是眼睛一亮或歪头看你 ${JSON.stringify(playfulHappy)}`);
  assert.ok(share(cautiousWorried, ['startled', 'soft']) > 0.55, `谨慎又担心：多是回过神或轻轻抬眼 ${JSON.stringify(cautiousWorried)}`);
  // Never twice in a row caps any one look at half; out of drowsiness "慢慢睁眼" is still the most common one.
  assert.ok(share(sleepy, ['sleepy']) > 0.3 && Object.values(sleepy).every(count => count! <= sleepy.sleepy!), `犯困时：多是慢慢睁眼 ${JSON.stringify(sleepy)}`);
  assert.ok(Object.keys(playfulHappy).length >= 3, '但不是只有一种');
  assert.equal(share(playfulHappy, ['sleepy']), 0, '没在犯困就不会"慢慢睁眼"');
});

test('舞台：抬头的样子真的不同（快慢、抬多少、歪头、笑），而且每一帧都连续（60 / 30 帧）', () => {
  const run = (style: NonNullable<HerLifeView['lookUp']>['style'] | undefined, fps: number) => {
    const stage = new HerLifeStage(null), owner = {}, gates = { expressive: true, engaged: true, bodyOwned: false, asleep: false, posture: 50 };
    const view: HerLifeView = { activity: 'company', since: 0, until: Number.MAX_SAFE_INTEGER, source: 'return', lookUp: { id: 'a', at: 10_000, ...(style ? { style } : {}) } };
    // She was already on stage (a second without a look-up), then the look-up arrives.
    for (let i = 0; i < fps; i++) stage.frame(1 / fps, { owner, view: { ...view, lookUp: null }, gates, nowMs: 9_000 + (i * 1000) / fps });
    const rows: { up: number; x: number; z: number; smile: number }[] = [];
    for (let i = 0; i < fps * 4; i++) { const life = stage.frame(1 / fps, { owner, view, gates, nowMs: 10_000 + (i * 1000) / fps }); rows.push({ up: life.lookUp, x: life.headX, z: life.headZ, smile: life.smileEyes }); }
    const peak = (key: 'up' | 'x' | 'z' | 'smile') => Math.max(...rows.map(row => Math.abs(row[key])));
    const firstFull = rows.findIndex(row => row.up > 0.95) / fps, lasted = rows.filter(row => row.up > 0.01).length / fps;
    // The largest frame-to-frame change of velocity (rad per frame²): what a jump would show as.
    const kink = (key: 'x' | 'z') => Math.max(0, ...rows.slice(2).map((row, i) => Math.abs(row[key] - 2 * rows[i + 1][key] + rows[i][key])));
    return { peak, firstFull, lasted, kink };
  };
  const plain = run(undefined, 60);
  assert.equal(plain.peak('x'), 0, 'no style (an older host): exactly the look-up as before'); assert.equal(plain.peak('smile'), 0);
  const quick = run({ kind: 'startled', pace: 0.8, hold: 0.7, lift: 1.4, tilt: 0, smile: 0 }, 60);
  const slow = run({ kind: 'sleepy', pace: 1.7, hold: 1.1, lift: 0.45, tilt: 0.02, smile: 0 }, 60);
  const bright = run({ kind: 'bright', pace: 0.9, hold: 1.2, lift: 1.1, tilt: 0.01, smile: 0.4 }, 60);
  assert.ok(quick.firstFull < slow.firstFull - 0.2, `快慢不同：${quick.firstFull.toFixed(2)} s 对 ${slow.firstFull.toFixed(2)} s`);
  assert.ok(quick.peak('x') > 0.005 && slow.peak('x') > 0.005, 'the chin lift differs from the plain one by its own amount');
  assert.ok(slow.peak('z') > 0.015 && quick.peak('z') < 1e-9, '歪头只在有的样子里');
  assert.ok(bright.peak('smile') > 0.35 && quick.peak('smile') === 0, '笑只在有的样子里');
  assert.ok(slow.lasted > quick.lasted, '慢慢睁眼也停得久一点');
  // The extremes of every range together (quickest, highest, most tilted), at both frame rates.
  const extremes = [
    { kind: 'startled' as const, pace: 0.8, hold: 0.7, lift: 1.4, tilt: 0.03, smile: 0.4 },
    { kind: 'sleepy' as const, pace: 1.7, hold: 1.5, lift: 0.45, tilt: 0.03, smile: 0 },
  ];
  for (const fps of [60, 30]) for (const style of extremes) {
    const result = run(style, fps), dt = 1 / fps;
    // Smoothstep envelopes: the change of velocity per frame stays at the level of an eased keyframe (≤ 4 rad/s² × dt²).
    assert.ok(result.kink('x') <= 4 * dt * dt && result.kink('z') <= 4 * dt * dt, `${style.kind} @${fps}: x ${result.kink('x')}, z ${result.kink('z')}`);
  }
});

test('真实的 CompanionService：测试命令开始发呆，打字后聊天这一轮的私有上下文里有"你刚才在：发呆"', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-l2-lookup-'));
  const service = new CompanionService(directory, () => {});
  const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
  try {
    await service.load(); await service.context('gene', provider, '角色名称：Gene');
    assert.deepEqual(service.herLifeStartNow('daydream'), { ok: true, activity: 'daydream' as HerLifeActivity });
    service.noteTyping();
    assert.ok(service.herLife.view('gene')!.lookUp, 'typing alone lifts her out of it');
    const turn = await service.begin('t1', '在干嘛呢', '角色名称：Gene', () => {});
    assert.match(turn.persona, /你刚才在：发呆（刚开始没一会儿），被用户打断了/u);
    await turn.finish('stopped');
    const next = await service.begin('t2', '嗯嗯', '角色名称：Gene', () => {});
    assert.doesNotMatch(next.persona, /你刚才在/u, 'only that one turn');
    await next.finish('stopped');
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('真实的 CompanionService：她在想事情时你开口说话（语音），她马上抬头；语音这一轮不加那一行（首字 A/B 没过），留给下一轮打字', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-l2-voice-'));
  const service = new CompanionService(directory, () => {});
  const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
  const leg = (seq: number, text: string) => ({ replyId: 'reply-' + seq, groupId: 'voice-group', epoch: 'host-epoch', kind: seq === 1 ? 'initial' as const : 'continuation' as const,
    merged: false, inputText: seq === 1 ? text : text.split('\n').at(-1)!, priorUserText: seq === 1 ? '' : text.split('\n').slice(0, -1).join('\n'),
    fromSeq: seq, throughSeq: seq, canonicalUserText: text, segments: [] });
  try {
    await service.load(); await service.context('gene', provider, '角色名称：Gene');
    service.herLifeStartNow('thinking');
    const group = await service.beginVoiceGroup('voice-group', '你在想什么', '角色名称：Gene');
    assert.ok(service.herLife.view('gene')!.lookUp, 'speaking to her lifts her out of it');
    const first = await group.beginLeg(leg(1, '你在想什么'), () => {});
    assert.doesNotMatch(first.persona, /你刚才在/u, 'the voice persona carries no extra line (first-token A/B)');
    await first.finish('stopped');
    assert.equal(service.herLife.chatTurn('gene'), '你刚才在：想事情（刚开始没一会儿），被用户打断了；可以自然提一句，不用每次都提。', 'the next typed turn hears it');
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
