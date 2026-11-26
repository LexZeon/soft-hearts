// I-085 第 5 节: while the user chats, she seldom wants to look on
// her own, so her turns mostly said "最近也没看到用户". Now: after a message, with no look for 10 minutes, one look in the background
// for her next turn. Fakes only: frames, haiku, clock, presence, mood; no camera, no model call, no Electron.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SELF_LOOK_KNOBS, type SelfLookKnobs } from '../shared/behaviors/self-look/knobs';
import { SELF_LOOK_WHYS, SELF_LOOK_WHY_WORDS, type SelfLookMoodInput } from '../shared/initiative/self-look';
import { SelfLookHost, type SelfLookCamera, type SelfLookPorts, type SelfLookRow } from '../electron/initiative/self-look/host';
import { createSelfLook } from '../electron/initiative/self-look/wiring';
import { uiText } from '../src/foundation/ui-language';
import { setUiLanguage } from '../shared/foundation/ui-language';
import type { Attachment } from '../shared/foundation/chat';

const MIN = 60_000, HOUR = 60 * MIN;
const FRAME = 'data:image/jpeg;base64,SECRETFRAMEAAAA';
const LINE = '他靠在椅子上，在笑';
// Calm and not bored: she does not want to look on her own (the minute clock would do nothing).
const calm = (): SelfLookMoodInput => ({ values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, boredom: 0, longing: 0, fatigue: { F: 0.25, phase: 'awake' } });
async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }

interface Harness {
  host: SelfLookHost;
  rows: SelfLookRow[];
  logs: unknown[];
  captures: number;
  asks: number;
  eyes: number;
  answer: string | (() => Promise<string>);
  state: { enabled: boolean; camera: SelfLookCamera; scope: string; mood: SelfLookMoodInput | null; present: boolean; typing: boolean; now: number };
  advance(ms: number): void;
}
function harness(options: { knobs?: Partial<SelfLookKnobs>; ports?: Partial<SelfLookPorts> } = {}): Harness {
  const h = {
    rows: [] as SelfLookRow[], logs: [] as unknown[], captures: 0, asks: 0, eyes: 0, answer: `${LINE}\n标签：smiling` as string | (() => Promise<string>),
    state: { enabled: true, camera: 'on' as SelfLookCamera, scope: 'gene|c1', mood: calm() as SelfLookMoodInput | null, present: true, typing: false, now: 40 * MIN },
  } as Harness;
  h.advance = ms => { h.state.now += ms; };
  h.host = new SelfLookHost({
    enabled: () => h.state.enabled, camera: () => h.state.camera, scope: () => h.state.scope, mood: () => h.state.mood, present: () => h.state.present,
    typing: () => h.state.typing, lastInteractionAt: () => h.state.now, idleSeconds: () => null,
    capture: async () => { h.captures++; return FRAME; },
    ask: async () => { h.asks++; return typeof h.answer === 'function' ? h.answer() : h.answer; },
    journal: row => { h.rows.push(row); }, eye: () => { h.eyes++; }, log: entry => { h.logs.push(entry); },
    clock: () => h.state.now, timers: { set: () => ({}), clear: () => {} }, knobs: options.knobs, ...options.ports,
  });
  return h;
}

test('after a message with no look for 10 minutes: one look in the background, not waited for; the next turn has the line', async () => {
  const h = harness();
  assert.equal(h.host.hint('今天好累啊', false, true), '', 'this turn: nothing seen yet');
  const started = h.host.afterMessage('今天好累啊', false);
  assert.equal(started, true);
  assert.equal(h.host.looking, true, 'it runs in the background: the call returned before the look finished');
  await flush();
  assert.deepEqual([h.captures, h.asks, h.eyes], [1, 1, 1]);
  assert.deepEqual(h.rows, [{ why: 'chat', sense: 'camera', result: 'looked', hour: 1 }]);
  h.advance(1 * MIN);
  const next = h.host.hint('你在干嘛', false, true);
  assert.match(next, /他靠在椅子上，在笑/u, 'her next turn can mention it');
  assert.match(h.host.openingLine(), /他靠在椅子上/u, 'a line she starts herself can use it too');
  for (const text of [next, JSON.stringify(h.rows), JSON.stringify(h.logs)]) assert.ok(!text.includes('SECRETFRAME'));
  assert.ok(!JSON.stringify(h.logs).includes('椅子'), 'the developer log has numbers and closed names only');
  assert.deepEqual(h.logs, [{ want: 0, why: 'chat', result: 'looked' }]);
});

test('typing does not stop it (they are talking to her); her own wish to look stays at zero while they type', async () => {
  const h = harness();
  h.state.typing = true;
  h.host.tick(); await flush();
  assert.equal(h.captures, 0, 'the minute clock: she does not look on her own while the user types');
  assert.equal(h.host.afterMessage('嗯嗯', false), true);
  await flush();
  assert.equal(h.captures, 1);
});

test('I-168 "不用限制": no ten-minute gap and no hourly count; once her line has expired the next message may bring a look', async () => {
  // A short-lived line: the only thing between two chat looks is the line she still has (and one look at a time).
  const knobs = { lineTtlMs: 1 * MIN };
  const own = harness({ knobs });
  own.state.mood = { ...calm(), boredom: 100 };
  own.host.tick(); await flush();
  assert.equal(own.captures, 1, 'her own look');
  own.advance(2 * MIN);
  assert.equal(own.host.afterMessage('嗨', false), true, 'two minutes later, her line gone: she looks again');
  const chat = harness({ knobs });
  let started = 0;
  for (let i = 0; i < 9; i++) { if (chat.host.afterMessage('嗨', false)) started++; await flush(); chat.advance(2 * MIN); }
  assert.equal(started, 9, 'no hourly cap');
  assert.equal(chat.rows.at(-1)?.hour, 9, 'the journal counts them');
});

test('a fresh line is used as it is: no second look while she still has one', async () => {
  // The ten minutes are over but the line lives a little longer when the knob says so.
  const longer = harness({ knobs: { lineTtlMs: 20 * MIN } });
  longer.host.afterMessage('嗨', false); await flush();
  longer.advance(12 * MIN);
  assert.equal(longer.host.afterMessage('还在吗', false), false, 'she still has a line');
  assert.equal(longer.captures, 1);
});

test('never: setting off, 「发图片」 off, held by a "别看", hidden, asleep, no conversation, the knob off, a look under way', async () => {
  const cases: [string, (h: Harness) => void, Partial<SelfLookKnobs>?][] = [
    ['setting off', h => { h.state.enabled = false; }], ['camera off', h => { h.state.camera = 'off'; }], ['held', h => { h.state.camera = 'held'; }],
    ['hidden', h => { h.state.present = false; }], ['asleep', h => { h.state.mood = { ...calm(), fatigue: { phase: 'asleep', sleeping: true } }; }],
    ['no scope', h => { h.state.scope = ''; }], ['knob off', () => {}, { chatLook: false }],
  ];
  for (const [name, setup, knobs] of cases) {
    const h = harness({ knobs });
    setup(h);
    assert.equal(h.host.afterMessage('嗨', false), false, name);
    await flush();
    assert.deepEqual([h.captures, h.asks, h.eyes, h.rows.length], [0, 0, 0, 0], `${name}: nothing, and no "she wanted to" row`);
  }
  const busy = harness();
  let release: (value: string) => void = () => {};
  busy.answer = () => new Promise<string>(resolve => { release = resolve; });
  busy.host.afterMessage('嗨', false); await flush();
  assert.equal(busy.host.afterMessage('还在吗', false), false, 'one look at a time');
  assert.equal(busy.captures, 1);
  release(`${LINE}\n标签：present`); await flush();
});

test('I-168: a "别看" in the message no longer stops her look (she hears it and decides herself; only the switch locks); a clear camera picture this turn: no look', async () => {
  for (const text of ['先别看我', '不要看我，头发乱糟糟', '你别看了']) {
    const h = harness();
    assert.equal(h.host.afterMessage(text, false), true, text);
    await flush();
    assert.equal(h.captures, 1, text);
  }
  const unread = harness();
  assert.equal(unread.host.afterMessage('嗨'.repeat(4100), false), true, 'a message too long to read is not a no either');
  const clear = harness();
  assert.equal(clear.host.afterMessage('看看我今天的衣服', true), false, 'she sees for herself in this turn');
  assert.equal(clear.captures, 0);
  const plain = harness();
  assert.equal(plain.host.afterMessage('这个好看吗', false), true, '"好看" is not about her looking');
});

test('a "别看" said while the background look runs: the answer is not kept', async () => {
  const h = harness();
  let release: (value: string) => void = () => {};
  h.answer = () => new Promise<string>(resolve => { release = resolve; });
  h.host.afterMessage('嗨', false); await flush();
  h.state.camera = 'held';
  h.host.mediaChanged();
  release(`${LINE}\n标签：smiling`); await flush();
  assert.equal(h.host.holding, false);
  assert.equal(h.host.hint('嗯', false, true), '');
});

test('wiring: only with text first on (without it every message already carries the small picture); a clear camera attachment stops it', async () => {
  const build = () => {
    let captures = 0;
    const now = 40 * MIN;
    const w = createSelfLook({
      enabled: () => true, camera: () => ({ frames: true, held: false }), characterId: () => 'gene', conversationId: () => 'c1', mood: () => null,
      present: () => true, typing: () => true, idleSeconds: () => null, capture: async () => { captures++; return FRAME; },
      ports: { mood: () => calm(), lastInteractionAt: () => now, clock: () => now, timers: { set: () => ({}), clear: () => {} }, ask: async () => `${LINE}\n标签：present`, log: () => {} },
    });
    return { w, captures: () => captures };
  };
  const off = build();
  assert.equal(off.w.afterMessage('嗨', [], false, false), false);
  await flush();
  assert.equal(off.captures(), 0);
  const on = build();
  assert.equal(on.w.hint('嗨', [], false), '');
  assert.equal(on.w.afterMessage('嗨', [], false, true), true);
  await flush();
  assert.match(on.w.hint('在干嘛', [], false), /他靠在椅子上/u);
  const clear = build();
  const picture: Attachment = { source: 'camera', dataUrl: FRAME } as Attachment;
  assert.equal(clear.w.afterMessage('看看我', [picture], false, true), false, 'a clear camera picture this turn');
  // I-166 (docs/claude/2026-11-21-i166-see-and-say.md): a turn that carried 「发图片」's small picture needs no second look of her own (no double looks).
  assert.equal(clear.w.afterMessage('嗨', [picture], true, true), false, 'a small camera picture went this turn: no second look');
  const broken = createSelfLook({
    enabled: () => { throw new Error('settings'); }, camera: () => ({ frames: true, held: false }), characterId: () => 'gene', conversationId: () => 'c1', mood: () => null,
    present: () => true, typing: () => false, idleSeconds: () => null, capture: async () => FRAME,
  });
  assert.equal(broken.afterMessage('嗨', [], false, true), false, 'never throws into her chat');
});

test('the journal knows the new reason, in both languages', () => {
  assert.ok((SELF_LOOK_WHYS as readonly string[]).includes('chat'));
  assert.equal(SELF_LOOK_WHY_WORDS.chat, '聊天时');
  setUiLanguage('en');
  try { assert.equal(uiText('聊天时'), 'While chatting'); } finally { setUiLanguage('zh-CN'); }
});
