/**
 * (docs/claude/2026-11-25-rps-1628.md): "石剪刀布结束说的没朗读。游戏开始前角色的语句不知道接下来要石头剪刀布。
 * ……聊天泡也挡住了石头剪刀布。" Three things: her game lines are read aloud (also out in full-screen Unbound), the reply in which she
 * agrees tells her the facts of the game that starts right after it (and which throw is hers in round one), and her bubble never sits
 * on the buttons or the score.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameLineRelay, gameLineGuard, type GameLinePorts } from '../electron/unbound/game-line';
import { outSayPorts } from '../src/unbound/her/out-play';
import { RpsHost, type RpsCharacterState } from '../electron/initiative/rps/host';
import { RpsStore } from '../electron/initiative/rps/store';
import { HeldLines, type HeldLinePorts } from '../src/brain/held-lines';
import { RpsOverlay } from '../src/initiative/RpsOverlay';
import { RpsSpeech, type RpsSayPorts } from '../src/initiative/rps-speech';
import { rpsClearSpot, shownRects, type LayoutRect } from '../src/initiative/rps-layout';
import { RPS_HAND_WORDS, RPS_TIMING, readRpsResponse, rpsRevealAfterMs, type RpsView } from '../shared/initiative/rps';
import { rpsChatContext } from '../shared/initiative/rps-personality';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import { seeded } from './helpers/seeded';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// ---------------------------------------------------------------- 1. her game lines are read aloud

function relayHarness(over: Partial<GameLinePorts> = {}) {
  const log: string[] = [];
  const ports: GameLinePorts = { chatBusy: () => false, hold: (id, text) => { log.push(`hold ${id} ${text}`); return true; }, voiceOn: () => true,
    read: (id, text) => { log.push(`read ${id} ${text}`); return true; }, skipped: (id, why) => { log.push(`skipped ${id} ${why}`); }, unread: why => { log.push(`unread ${why}`); }, ...over };
  return { relay: new GameLineRelay(ports), log };
}
const said = (id: string, text: string) => ({ say: { id, text } });

test('out in Unbound: a new game line is held in her bubble and then read, once per line id', () => {
  const { relay, log } = relayHarness();
  relay.view(said('m1l1', '这局我赢了！'));
  relay.view(said('m1l1', '这局我赢了！'));
  relay.view(null); relay.view({});
  relay.view(said('m1l2', '再来一局'));
  assert.deepEqual(log, ['hold m1l1 这局我赢了！', 'read m1l1 这局我赢了！', 'hold m1l2 再来一局', 'read m1l2 再来一局']);
});

test('out in Unbound: a line she could not say tells the game and the journal why, and is never read', () => {
  const busy = relayHarness({ chatBusy: () => true });
  busy.relay.view(said('a1', '嘿'));
  assert.deepEqual(busy.log, ['skipped a1 busy'], 'a chat reply is under way: skipped, nothing held, nothing read');
  const hidden = relayHarness({ hold: () => false });
  hidden.relay.view(said('a2', '嘿'));
  assert.deepEqual(hidden.log, ['skipped a2 bubble-hidden']);
  const mute = relayHarness({ voiceOn: () => false });
  mute.relay.view(said('a3', '嘿'));
  assert.deepEqual(mute.log, ['hold a3 嘿', 'unread voice-off'], 'shown but not read: one row, and why');
  const failed = relayHarness({ read: () => false });
  failed.relay.view(said('a4', '嘿'));
  assert.deepEqual(failed.log, ['hold a4 嘿', 'unread voice-failed']);
  const throwing = relayHarness({ hold: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => throwing.relay.view(said('a5', '嘿')), 'a relay failure never holds the game');
});

test('the voice guard lets the companion window play a game line only while her bubble shows exactly it', () => {
  const proof = { currentId: 'm1l1' as string | null, shown: '这局我赢了！', isPresentationCurrent(text: string) { return text === this.shown; } };
  const guard = gameLineGuard(proof, 'm1l1', '这局我赢了！');
  assert.equal(guard('m1l1'), true);
  assert.equal(guard('other'), false, 'another reply id');
  proof.currentId = 'm1l2'; assert.equal(guard('m1l1'), false, 'her bubble moved on to another line');
  proof.currentId = 'm1l1'; proof.shown = '别的话'; assert.equal(guard('m1l1'), false, 'the bubble shows other words: not read');
});

test('full-screen Unbound page: it paces the game by the line, paints no bubble of its own, and does not call a missing voice "read-aloud off"', async () => {
  let closed = false;
  const ports = outSayPorts(() => closed);
  assert.equal(ports.free(), true); closed = true; assert.equal(ports.free(), false, 'the page is gone or she cannot be played with now');
  const reports: string[] = [];
  closed = false;
  const speech = new RpsSpeech({ ...ports, wait: async () => {} }, (id, shown, unread) => reports.push(`${id} ${shown} ${unread ?? '-'}`));
  speech.view({ id: 'g', revision: 2, phase: 'end', round: 2, score: { her: 2, user: 0 }, firstTo: 2, accepting: false, commitment: null, revealed: null, userHand: null, outcome: null, line: null, face: 'happy',
    tease: null, beatMs: 0, phaseMs: 0, elapsedMs: 0, result: 'her', say: { id: 'u1', text: '我赢啦' } });
  await flush();
  assert.deepEqual(reports, ['u1 true -']);
});

function held(overrides: Partial<HeldLinePorts> = {}) {
  const log: string[] = [], spoken: { text: string; context: unknown }[] = [], remembered: string[] = [];
  const ports: HeldLinePorts = { ackVision: async () => true, ackAmbient: async () => null, free: () => true, voiceOn: () => true,
    speak: async (text, context) => { spoken.push({ text, context }); }, stop: () => { log.push('stop'); }, ended: (id, kind) => { log.push(`ended ${kind} ${id}`); },
    rememberVision: m => { remembered.push(m.id); }, rememberAmbient: c => { remembered.push(c.id); }, rememberSense: m => { remembered.push(m.id); }, ...overrides };
  return { lines: new HeldLines(ports), log, spoken, remembered };
}

test('the companion window reads a held game line with its own id, and never puts it in her history', async () => {
  const h = held();
  assert.equal(h.lines.sense({ id: 'm1l1', text: '这局我赢了！', held: true, game: true }), true);
  await flush();
  assert.deepEqual(h.spoken, [{ text: '这局我赢了！', context: { replyId: 'm1l1' } }], 'read aloud (a fake voice), as that reply id');
  assert.deepEqual(h.remembered, [], 'a game line is not chat history');
  assert.deepEqual(h.log, ['stop', 'ended vision m1l1']);
  const busy = held({ free: () => false });
  busy.lines.sense({ id: 'm1l2', text: '嘿', held: true, game: true }); await flush();
  assert.deepEqual(busy.spoken, [], 'a chat reply under way in this window: not read over it');
  const bad = held();
  assert.equal(bad.lines.sense({ id: 'bad id', text: '嘿', held: true, game: true }), true, 'handled (dropped), never shown on the hidden companion');
  assert.equal(bad.lines.sense({ id: 'x1', text: '   ', held: true, game: true }), true);
  await flush();
  assert.deepEqual(bad.spoken, []);
  assert.equal(held().lines.sense({ id: 'x2', text: '嘿', game: true }), false, 'not held: not this path');
});

test('at home: the end-of-game line is read with the ordinary voice, and a voice that is off or fails says why', async () => {
  const log: string[] = [], reports: string[] = [];
  let voice = true, fail = false;
  const ports: RpsSayPorts = { free: () => true, voiceOn: () => voice, show: id => log.push(`show ${id}`), speak: async id => { log.push(`speak ${id}`); if (fail) throw new Error('tts'); },
    ended: id => log.push(`ended ${id}`), wait: async () => { log.push('wait'); } };
  const speech = new RpsSpeech(ports, (id, shown, unread) => reports.push(`${id} ${shown} ${unread ?? '-'}`));
  const end = (id: string): RpsView => ({ id: 'g', revision: 9, phase: 'end', round: 2, score: { her: 2, user: 0 }, firstTo: 2, accepting: false, commitment: null, revealed: null, userHand: null, outcome: null,
    line: null, face: 'happy', tease: null, beatMs: 0, phaseMs: 0, elapsedMs: 0, result: 'her', say: { id, text: '我赢了两局！' } });
  speech.view(end('e1')); await flush();
  assert.deepEqual(log, ['show e1', 'speak e1', 'ended e1']); assert.deepEqual(reports, ['e1 true -']);
  voice = false; speech.view(end('e2')); await flush();
  assert.equal(reports.at(-1), 'e2 true voice-off');
  voice = true; fail = true; speech.view(end('e3')); await flush();
  assert.equal(reports.at(-1), 'e3 true voice-failed');
  const elsewhere = new RpsSpeech({ ...ports, voiceOn: () => false, voiceElsewhere: () => true }, (id, shown, unread) => reports.push(`${id} ${shown} ${unread ?? '-'}`));
  elsewhere.view(end('e4')); await flush();
  assert.equal(reports.at(-1), 'e4 true -', 'another window reads it (full-screen Unbound): not "read-aloud was off"');
  const busy = new RpsSpeech({ ...ports, free: () => false }, (id, shown, unread) => reports.push(`${id} ${shown} ${unread ?? '-'}`));
  busy.view(end('e5')); await flush();
  assert.equal(reports.at(-1), 'e5 false busy');
});

test('the reason rides on said / skipped only, as a closed word; one journal row says it without the line', () => {
  assert.deepEqual(readRpsResponse({ id: 'g1l1', action: 'said', unread: 'voice-off' }), { id: 'g1l1', action: 'said', unread: 'voice-off' });
  assert.equal(readRpsResponse({ id: 'g1l1', action: 'accept', unread: 'busy' }), null);
  assert.equal(readRpsResponse({ id: 'g1l1', action: 'said', unread: 'whatever' }), null);
  assert.deepEqual(readRpsResponse({ id: 'g1l1', action: 'said' }), { id: 'g1l1', action: 'said' });
  const entry = buildJournalEntry({ type: 'rps', characterId: 'c', event: 'line-unread', unread: 'busy' }, 1_000);
  assert.equal((entry as { unread?: string } | null)?.unread, 'busy');
  assert.match(describeJournalEntry(entry!, (text, ...values) => text.replace(/\{(\d+)\}/gu, (_all, i) => String(values[Number(i)]))), /她的一句猜拳台词没读出来（聊天或打字占着窗口）/u);
  assert.equal(JSON.stringify(entry).includes('台词内容'), false);
});

// ---------------------------------------------------------------- 2. the reply in which she agrees knows what is about to happen

test('the accept turn tells her the game starts right after, with buttons beside her, best of three, and her sealed first throw (zh and en)', () => {
  for (const hand of ['rock', 'scissors', 'paper'] as const) {
    const zh = rpsChatContext('accept', null, { first: hand });
    assert.match(zh, /这句话说完后，游戏马上开始/u); assert.match(zh, /三个按钮/u); assert.match(zh, /点按钮来出拳/u); assert.match(zh, /三局两胜/u);
    assert.ok(zh.includes(`你第一次要出的是${RPS_HAND_WORDS[hand]}`), 'her first throw, in words');
    assert.doesNotMatch(zh, /不要|不能|别|必须|禁止/u, 'facts only: no rule wording');
    const en = rpsChatContext('accept', null, { first: hand, language: 'en' });
    assert.match(en, /starts right after this message/u); assert.match(en, /three buttons/u); assert.match(en, /clicking them/u); assert.match(en, /best of three/u);
    assert.ok(en.includes(`Your first throw is already decided, before the user threw anything: ${hand}.`));
    assert.doesNotMatch(en, /\bdo not\b|\bdon't\b|\bmust\b|\bnever\b/iu);
    assert.doesNotMatch(en, /[一-鿿]/u, 'English card: no Chinese in her context');
  }
  assert.doesNotMatch(rpsChatContext('accept'), /第一次要出的是/u, 'no first throw to tell: nothing is said about one');
  assert.doesNotMatch(rpsChatContext('sleepy', null, { first: 'rock' }), /第一次要出的是/u, 'only the accept branch carries it');
});

async function hostFor(seed: number, extra: { quick?: () => Promise<string>; journal?: (id: string, entry: unknown) => void } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rps-1628-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json') }); await store.load();
  const timers: { at: number; fn: () => void }[] = []; let now = 1_000_000;
  const views: (RpsView | null)[] = [];
  const character = { id: 'gene', persona: '角色：基恩', parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'happy', values: { D: 70, O: 50, E: 55, N: 50, C: 40 } }, fatigue: null, herLife: 'company' } as RpsCharacterState;
  let n = 0;
  const host = new RpsHost({ store, character: () => character, visible: () => true, recording: () => false, localDate: () => '2026-11-25', publish: view => views.push(view), mood: () => {},
    chatBusy: () => false, available: () => !!extra.quick, quick: extra.quick, journal: extra.journal, clock: () => now, random: seeded(seed), voiceRandom: extra.quick ? () => 0 : seeded(3), nonce: () => `nonce${++n}`, createId: () => `id${++n}`,
    timers: { set: (fn, ms) => { timers.push({ at: now + ms, fn }); return timers.length; }, clear: () => {} } });
  const advance = (ms: number) => { const end = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const due = timers[0]; if (!due || due.at > end) break; timers.shift(); now = Math.max(now, due.at); due.fn(); } now = end; };
  return { host, views, advance, close: async () => { host.dispose(); await store.flush(); await rm(dir, { recursive: true, force: true }); } };
}

test('the hand she is told about in the accept turn is the hand round one seals and later reveals (many seeds)', async () => {
  const told: string[] = [];
  for (let seed = 1; seed <= 24; seed++) {
    const h = await hostFor(seed);
    const context = h.host.chatTurn('r1', '来玩猜拳吧');
    const match = /你第一次要出的是(石头|剪刀|布)/u.exec(context ?? '');
    assert.ok(match, `seed ${seed}: the accept turn names her first throw`);
    told.push(match![1]);
    h.host.chatDone('r1', true); h.advance(800);
    const ready = h.views.at(-1)!;
    assert.equal(ready.phase, 'ready', 'the game starts right after the reply');
    const sealed = ready.commitment!;
    // The user throws; read the reveal.
    h.advance(300);
    assert.equal(h.host.throwHand({ gameId: ready.id, round: 1, hand: 'rock', source: 'click' }), 'accepted');
    h.advance(6_000);
    const reveal = h.views.find(v => v?.phase === 'reveal' && v.round === 1)!;
    assert.ok(reveal?.revealed, `seed ${seed}: round one was revealed`);
    assert.equal(RPS_HAND_WORDS[reveal.revealed!.hand], match![1], `seed ${seed}: what she was told is what she threw`);
    assert.equal(sealed.round, 1);
    await h.close();
  }
  assert.ok(new Set(told).size === 3, 'all three hands come up across seeds (a uniform pick, not rigged)');
});

test('a game line that was not read aloud writes one journal row with the reason (from the window, and from the Unbound relay), never the line', async () => {
  const rows: { id: string; entry: { event: string; unread?: string } }[] = [];
  const h = await hostFor(5, { quick: async () => '{"text":"嘿嘿，这局算我的"}', journal: (id, entry) => rows.push({ id, entry: entry as never }) });
  h.host.chatTurn('a', '来玩猜拳'); h.host.chatDone('a', true); h.advance(800);
  const open = h.views.at(-1)!;
  h.advance(300);
  h.host.throwHand({ gameId: open.id, round: 1, hand: 'rock', source: 'click' });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  h.advance(RPS_TIMING.readyMs + rpsRevealAfterMs(RPS_TIMING) + 200);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const line = h.views.find(v => v?.say)?.say;
  assert.ok(line, 'she said something at the reveal');
  assert.equal(h.host.respond({ id: line.id, action: 'said', unread: 'voice-off' }), true);
  assert.deepEqual(rows.filter(r => r.entry.event === 'line-unread').map(r => [r.id, r.entry.unread]), [['gene', 'voice-off']]);
  h.host.lineUnread('bubble-hidden'); // the Unbound relay's own reasons
  assert.deepEqual(rows.filter(r => r.entry.event === 'line-unread').map(r => r.entry.unread), ['voice-off', 'bubble-hidden']);
  assert.equal(JSON.stringify(rows).includes('嘿嘿'), false, 'the line itself is never in the journal');
  await h.close();
});

test('the first throw is drawn before the user does anything: the same host state gives the same told hand however the user throws', async () => {
  const a = await hostFor(7), b = await hostFor(7);
  const ca = a.host.chatTurn('r1', '来玩猜拳吧'), cb = b.host.chatTurn('r1', '来玩猜拳吧');
  assert.equal(ca, cb, 'nothing about the user\'s later throws can reach it');
  await a.close(); await b.close();
});

// ---------------------------------------------------------------- 3. her bubble never sits on the buttons or the score

const overlap = (a: LayoutRect, b: LayoutRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('layout: the nearest free spot, never on a bubble, always inside the window, the same input giving the same spot', () => {
  const size = { w: 160, h: 112 };
  let checked = 0, moved = 0;
  for (const bounds of [{ w: 400, h: 560 }, { w: 320, h: 420 }, { w: 1280, h: 720 }, { w: 1920, h: 1080 }, { w: 2560, h: 1440 }]) {
    const bubbleSizes = [{ w: 220, h: 60 }, { w: 300, h: 160 }, { w: Math.round(bounds.w * 0.8), h: Math.round(bounds.h * 0.25) }];
    for (const bubble of bubbleSizes) for (let bx = 0; bx <= bounds.w - bubble.w; bx += Math.max(20, Math.round(bounds.w / 8))) for (let by = 0; by <= bounds.h - bubble.h; by += Math.max(20, Math.round(bounds.h / 8))) {
      const avoid: LayoutRect[] = [{ x: bx, y: by, ...bubble }];
      for (const px of [0, bounds.w * 0.25, bounds.w * 0.5, bounds.w - size.w]) for (const py of [0, bounds.h * 0.3, bounds.h * 0.6, bounds.h - size.h]) {
        const spot = rpsClearSpot({ preferred: { x: px, y: py }, size, bounds, avoid });
        const box = { x: spot.x, y: spot.y, ...size };
        assert.ok(spot.x >= 0 && spot.y >= 0 && spot.x + size.w <= bounds.w && spot.y + size.h <= bounds.h, `inside ${bounds.w}x${bounds.h}: ${JSON.stringify(spot)}`);
        assert.equal(overlap(box, avoid[0]), false, `clear of the bubble ${JSON.stringify(avoid[0])} at ${JSON.stringify(spot)} in ${bounds.w}x${bounds.h}`);
        assert.deepEqual(rpsClearSpot({ preferred: { x: px, y: py }, size, bounds, avoid }), spot, 'deterministic');
        if (!overlap({ x: Math.round(px) - 8, y: Math.round(py) - 8, w: size.w + 16, h: size.h + 16 }, avoid[0])) assert.deepEqual(spot, { x: Math.round(px), y: Math.round(py) }, 'a free preferred spot is kept');
        else moved++;
        checked++;
      }
    }
  }
  assert.ok(checked > 1_000 && moved > 100, `checked ${checked}, moved ${moved}`);
  // Two bubbles (her reply and the said line): clear of both.
  const two: LayoutRect[] = [{ x: 100, y: 40, w: 220, h: 70 }, { x: 100, y: 130, w: 220, h: 40 }];
  const spot = rpsClearSpot({ preferred: { x: 120, y: 60 }, size, bounds: { w: 400, h: 560 }, avoid: two });
  assert.ok(two.every(r => !overlap({ x: spot.x, y: spot.y, ...size }, r)));
  // Nothing free (a bubble as large as the window): the preferred spot, clamped, no crash.
  assert.deepEqual(rpsClearSpot({ preferred: { x: -50, y: 900 }, size, bounds: { w: 400, h: 560 }, avoid: [{ x: 0, y: 0, w: 400, h: 560 }] }), { x: 0, y: 448 });
  assert.deepEqual(rpsClearSpot({ preferred: { x: 10, y: 10 }, size, bounds: { w: 400, h: 560 }, avoid: [] }), { x: 10, y: 10 });
});

class El {
  children: El[] = []; className = ''; textContent = ''; hidden = false; disabled = false; type = ''; title = ''; offsetWidth = 160; offsetHeight = 112;
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {}; style: Record<string, string> = {}; onclick: (() => void) | null = null;
  constructor(public tagName: string) {}
  append(...xs: El[]) { this.children.push(...xs); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  remove() {}
}
const view = (extra: Partial<RpsView> = {}): RpsView => ({ id: 'g1', revision: 1, phase: 'ready', round: 1, score: { her: 0, user: 0 }, firstTo: 2, accepting: true, commitment: { gameId: 'g1', round: 1, committedAt: 1, digest: 'a'.repeat(64) },
  revealed: null, userHand: null, outcome: null, line: null, face: 'nervous', tease: null, beatMs: 500, phaseMs: 1540, elapsedMs: 0, result: null, ...extra });

test('the overlay steps aside for her bubble, also while it holds still for the count, and stays near her hand', () => {
  const root = new El('div'), bubbles: LayoutRect[] = [];
  const overlay = new RpsOverlay(root as never, { rpsGet: async () => null, rpsThrow: async () => 'accepted', rpsRespond: async () => true, rpsEvents: () => () => {} },
    { now: () => 0, document: { createElement: (tag: string) => new El(tag) } as never, avoid: () => bubbles });
  const box = root.children[0];
  try { checkOverlay(); } finally { overlay.dispose(); } // a failing check must not leave the overlay's timer running (the file would hang)
  function checkOverlay() {
  const arm = { x: 200, y: 165, visible: true, radius: 24, raisedHand: { x: 120, y: 200, elbowX: 165, elbowY: 270 } };
  const spot = () => ({ x: parseFloat(box.style.left), y: parseFloat(box.style.top), w: 160, h: 112 });
  overlay.show(view({ phase: 'ready' })); overlay.place(arm, 400, 560);
  const home = spot();
  // Her reply bubble appears right on the buttons, mid-count (when they otherwise hold still).
  overlay.show(view({ phase: 'count', revision: 2 }));
  bubbles.push({ x: home.x - 20, y: home.y - 10, w: 240, h: 90 });
  overlay.place(arm, 400, 560);
  const aside = spot();
  assert.equal(overlap(aside, bubbles[0]), false, 'the bubble does not cover the buttons or the score');
  assert.ok(aside.x >= 0 && aside.y >= 0 && aside.x + 160 <= 400 && aside.y + 112 <= 560, 'inside the window');
  assert.ok(Math.hypot(aside.x - home.x, aside.y - home.y) < 260, `still near her hand, moved ${Math.round(Math.hypot(aside.x - home.x, aside.y - home.y))} px`);
  // It stays put while the bubble stays (no jitter on each of her 100 ms reports), and a pumping fist does not move it.
  for (const dy of [0, 70, 0, 70]) { overlay.place({ ...arm, raisedHand: { ...arm.raisedHand, y: 200 + dy, elbowY: 270 + dy } }, 400, 560); assert.deepEqual(spot(), aside); }
  // The bubble leaves: it does not jump about; a real move of the arm brings it home again.
  bubbles.length = 0;
  overlay.place(arm, 400, 560);
  assert.deepEqual(spot(), aside);
  overlay.show(view({ phase: 'reveal', revision: 3 }));
  overlay.place({ ...arm, raisedHand: { x: 300, y: 100, elbowX: 330, elbowY: 150 } }, 400, 560);
  assert.notDeepEqual(spot(), aside);
  }
});

test('the small window: her answer bubble and the said line are read from the page, hidden ones are ignored', () => {
  const visible = { getBoundingClientRect: () => ({ left: 110, top: 50, width: 200, height: 80 }) };
  const hidden = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
  assert.deepEqual(shownRects([visible as never, hidden as never], { left: 10, top: 20 }), [{ x: 100, y: 30, w: 200, h: 80 }]);
  assert.deepEqual(shownRects([{} as never], { left: 0, top: 0 }), []);
});
