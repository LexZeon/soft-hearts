// I-209 第 4 步（docs/claude/2026-11-24-i209-step4.md）。 开关「她们都能接话」默认开（"可以"）；不加每天上限（"不加"）。
// 每说完一句，台上没说这句的每一位各问一次自己的 haiku；第一个说要接的先说，其余的作废，等她说完再问；有人接就一直接下去，没人接就停；
// 谁也不接自己的话；开关关着时只有你点的那位回你。给 haiku 的只有事实，没有"该停了"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChimeIn, type ChimeInPorts, type ChimeLineOutcome, type ChimeRow } from '../electron/brain/stage-chat/chime-in';
import { chimeDecisionPrompt, chimeFactsBlock, chimeLinePrompt, parseChimeDecision, type ChimeFacts, type StageLine } from '../electron/brain/stage-chat/facts';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';

const names: Record<string, string> = { gene: 'Gene', one: 'One', two: 'Two' };
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

interface Pending { id: string; signal: AbortSignal; resolve(yes: boolean): void; facts: ChimeFacts }
function rig(options: { present?: string[]; enabled?: boolean } = {}) {
  let now = 1_000_000, n = 0;
  const asks: Pending[] = [], speaks: { id: string; signal: AbortSignal; facts: ChimeFacts; resolve(outcome: ChimeLineOutcome): void }[] = [], rows: ChimeRow[] = [];
  const state = { present: options.present ?? ['gene', 'one', 'two'], enabled: options.enabled ?? true };
  const ports: ChimeInPorts = {
    enabled: () => state.enabled, present: () => state.present, name: id => names[id] ?? '',
    ask: (id, facts, signal) => new Promise(resolve => { asks.push({ id, signal, resolve, facts }); }),
    speak: (id, facts, signal) => new Promise(resolve => { speaks.push({ id, signal, facts, resolve }); }),
    user: () => ({ busy: null, away: null }), journal: row => { rows.push(row); }, clock: () => now,
  };
  const chime = new ChimeIn(ports);
  const line = (speaker: string | null, text: string, to?: string): StageLine => ({ id: `l${++n}`, speaker, text, at: now, ...(to ? { to } : {}) });
  return { chime, asks, speaks, rows, state, line, tick: (ms: number) => { now += ms; } };
}

test('after a line, every other one on stage asks her haiku; the first yes speaks, the others are dropped (their calls aborted)', async () => {
  const r = rig();
  r.chime.heard(r.line('gene', '我刚才梦见下雪了'));
  await settle();
  assert.deepEqual(r.asks.map(ask => ask.id).sort(), ['one', 'two'], 'nobody answers her own line');
  r.tick(700); r.asks.find(ask => ask.id === 'two')!.resolve(true);
  await settle();
  assert.deepEqual(r.speaks.map(speak => speak.id), ['two'], 'the first yes takes the floor');
  assert.equal(r.asks.find(ask => ask.id === 'one')!.signal.aborted, true, 'the others still out are dropped');
  r.asks.find(ask => ask.id === 'one')!.resolve(true); // a late yes
  await settle();
  assert.deepEqual(r.speaks.map(speak => speak.id), ['two'], 'a late yes never speaks');
  assert.deepEqual(r.rows.filter(row => row.step === 'ask').map(row => [row.characterId, row.outcome]), [['two', 'yes'], ['one', 'dropped']]);
  assert.equal(r.rows[0]!.ms, 700, 'how long her haiku took');
});

test('a chain goes on while someone says yes and stops when nobody does; her own line is never hers to answer', async () => {
  const r = rig();
  r.chime.heard(r.line('gene', '下雪了'));
  await settle();
  r.asks.find(ask => ask.id === 'one')!.resolve(true);
  await settle();
  // One's line is archived and heard (the memory tells the hearing, which tells the round).
  r.chime.heard(r.line('one', '真的吗'));
  r.speaks[0]!.resolve('said');
  await settle();
  const second = r.asks.slice(2);
  assert.deepEqual(second.map(ask => ask.id).sort(), ['gene', 'two'], 'asked again after her line; not One herself');
  assert.equal(second.find(ask => ask.id === 'gene')!.facts.streak, 2, 'the facts say two lines came without the user');
  second.find(ask => ask.id === 'gene')!.resolve(true);
  await settle();
  r.chime.heard(r.line('gene', '真的'));
  await settle();
  const third = r.asks.slice(4);
  assert.deepEqual(third.map(ask => ask.id).sort(), ['one', 'two']);
  for (const ask of third) ask.resolve(false);
  await settle();
  assert.equal(r.asks.length, 6, 'nobody wanted to: the chain stopped');
  assert.equal(r.chime.counts.longest, 3);
});

test('the user\'s own line is answered by the one clicked (her turn), not by a round; a new turn of the user drops a round in flight', async () => {
  const r = rig();
  r.chime.heard(r.line(null, '你们在干嘛', 'gene'));
  await settle();
  assert.equal(r.asks.length, 0, 'the user\'s line starts no round (the clicked one answers it with her own turn)');
  r.chime.heard(r.line('gene', '在等你呀'));
  await settle();
  assert.equal(r.asks.length, 2, 'her reply does: the others hear both');
  assert.equal(r.asks[0]!.facts.streak, 1);
  assert.match(chimeFactsBlock(r.asks[0]!.facts), /你（用户）对Gene说：你们在干嘛/);
  r.chime.userSpoke(Date.now());
  for (const ask of r.asks) assert.equal(ask.signal.aborted, true, 'the user spoke: the round is dropped');
  r.asks[0]!.resolve(true);
  await settle();
  assert.equal(r.speaks.length, 0, 'a late yes after the user spoke never speaks');
});

test('a yes whose line is being made is dropped by a newer line: its signal aborts (the speaker never shows or archives it)', async () => {
  const r = rig();
  r.chime.heard(r.line('gene', '好饿'));
  await settle();
  r.asks[0]!.resolve(true);
  await settle();
  assert.equal(r.speaks.length, 1);
  r.chime.heard(r.line('two', '我也是')); // someone else's line came first (an initiative of hers)
  assert.equal(r.speaks[0]!.signal.aborted, true);
});

test('the switch 「她们都能接话」 off: nobody asks and nobody answers anyone else (only the clicked one answers you, with her own turn)', async () => {
  const r = rig({ enabled: false });
  r.chime.heard(r.line(null, '早', 'one'));
  r.chime.heard(r.line('one', '早呀'));
  r.chime.heard(r.line('gene', '早'));
  await settle();
  assert.deepEqual([r.asks.length, r.speaks.length, r.rows.length], [0, 0, 0]);
});

test('alone on stage: no round', async () => {
  const r = rig({ present: ['gene'] });
  r.chime.heard(r.line('gene', '嗨'));
  await settle();
  assert.equal(r.asks.length, 0);
});

test('the decision gets facts only: who said what, how many lines without the user, since when, busy or away; no rule, no stop word, no instruction', () => {
  const facts: ChimeFacts = {
    self: 'one', selfName: 'One', present: [{ id: 'gene', name: 'Gene' }, { id: 'one', name: 'One' }, { id: 'two', name: 'Two' }],
    recent: [{ id: 'a', speaker: null, text: '你们聊', at: 0, to: 'gene' }, { id: 'b', speaker: 'gene', text: '好呀', at: 1 }, { id: 'c', speaker: 'one', text: '嗯', at: 2 }],
    streak: 14, sinceUserMs: 26 * 60_000, userBusy: true, userAway: null,
  };
  const block = chimeFactsBlock(facts);
  for (const word of [...INSTRUCTION_WORDS, '不要', '别', '该', '停', '够了', '休息', '太久', '安慰', '道歉']) assert.ok(!block.includes(word), `no "${word}" in the facts: ${block}`);
  assert.match(block, /你是One。台上现在还有：Gene、Two。/);
  assert.match(block, /你（用户）对Gene说：你们聊/);
  assert.match(block, /Gene：好呀/);
  assert.match(block, /你自己：嗯/);
  assert.match(block, /台上接着说了 14 句/);
  assert.match(block, /用户上一次开口：大约 26 分钟前/);
  assert.match(block, /用户现在看起来在忙。/);
  const decision = chimeDecisionPrompt('（角色卡）One 是个话不多的人。', facts);
  assert.ok(decision.startsWith('（角色卡）'), 'her card\'s persona as context');
  assert.match(decision, /\{"speak":true\} 或 \{"speak":false\}/);
  for (const word of ['不要', '应该', '必须', '请']) assert.ok(!decision.includes(word), `no "${word}" anywhere in the decision prompt`);
  const line = chimeLinePrompt({ persona: 'P', facts, history: 'Gene：好呀' });
  assert.match(line, /\{"text":""\}/);
  assert.ok(!line.includes('不要') && !line.includes('应该'));
});

test('the decision\'s answer reads a clear yes only', () => {
  assert.equal(parseChimeDecision('{"speak":true}'), true);
  assert.equal(parseChimeDecision('嗯 {"speak": true}'), true);
  assert.equal(parseChimeDecision('{"speak":false}'), false);
  assert.equal(parseChimeDecision('{"speak":"yes"}'), false);
  assert.equal(parseChimeDecision('好的'), false);
  assert.equal(parseChimeDecision(null), false);
});

// The numbers for the record (docs/claude/2026-11-24-i209-step4.md): a simulated group chat with fake haiku answers (seeded), how many haiku
// and Claude calls one line of the user's costs, and how long the chains get. Each character says yes with her own chance, lower the more
// lines came without the user (as a character reading the facts might); the program itself never stops a chain.
test('a simulated chat: haiku calls per line and chain lengths (fake answers, no real Claude)', async () => {
  let seed = 7;
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const results: { present: number; lines: number; haiku: number; claude: number; chains: number[] }[] = [];
  for (const present of [['gene', 'one'], ['gene', 'one', 'two']]) {
    let haiku = 0, claude = 0, streak = 0;
    const chains: number[] = [];
    const chime = new ChimeIn({
      enabled: () => true, present: () => present, name: id => names[id] ?? '', user: () => ({ busy: null, away: null }), journal: () => {}, clock: () => 0,
      ask: async (_id, facts) => { haiku++; return random() < 0.55 / (1 + facts.streak * 0.6); },
      speak: async id => { claude++; queueMicrotask(() => { streak++; chime.heard({ id: `c${haiku}-${claude}`, speaker: id, text: '…', at: 0 }); }); return 'said'; },
    });
    const lines = 40;
    for (let i = 0; i < lines; i++) {
      const before = claude;
      streak = 0;
      chime.userSpoke(0);
      chime.heard({ id: `u${i}`, speaker: null, text: '…', at: 0, to: 'gene' });
      chime.heard({ id: `r${i}`, speaker: 'gene', text: '…', at: 0 }); claude++; // the clicked one's own turn
      await settle();
      chains.push(claude - before - 1);
    }
    results.push({ present: present.length, lines, haiku, claude, chains });
  }
  for (const result of results) {
    const longest = Math.max(...result.chains), mean = result.chains.reduce((a, b) => a + b, 0) / result.chains.length;
    console.log(`[i209-step4 sim] ${result.present} on stage: per user line ${(result.haiku / result.lines).toFixed(2)} haiku, ${(result.claude / result.lines).toFixed(2)} Claude calls; chime-ins per line mean ${mean.toFixed(2)}, longest chain ${longest}`);
    assert.ok(result.haiku >= result.lines * (result.present - 1), 'at least one round of asks per user line');
  }
});
