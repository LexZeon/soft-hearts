// I-209 第 4 步（docs/claude/2026-11-24-i209-step4.md）：接话的那一句是她自己的——用她自己的 Claude、她的气泡、她的声音，只记一次；一次只有一个声音；
// 作废的、迟到的不显示也不记。另外：台上别的角色被摸、被拉、亲抱时她自己的心情会动；歌只检测一次，台上每位都收到；看屏幕的描述大家共用一份；
// 控制窗口的聊天单子里，台上别人的回复写她的名字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChimeTurns, type ChimeTurnPorts } from '../electron/brain/stage-chat/turns';
import { sharedSight } from '../electron/brain/stage-chat/perceive';
import type { ChimeFacts } from '../electron/brain/stage-chat/facts';
import { stageWorld } from './helpers/stage-world';
import { MAIN_KEY } from '../electron/unbound/company/stage';
import { UNBOUND_EVENTS } from '../shared/unbound/scene';
import { StageTouchMood } from '../electron/mood/stage-touch';
import { MoodHost } from '../electron/mood/mood';
import { labelReplySpeaker } from '../src/brain/speaker-label';
import { readSenseLineMessage, chimeInOrigin } from '../shared/senses/sense-router';

const facts: ChimeFacts = { self: 'one', selfName: 'One', present: [{ id: 'gene', name: 'Gene' }, { id: 'one', name: 'One' }], recent: [{ id: 'a', speaker: 'gene', text: '下雪了', at: 0 }], streak: 1, sinceUserMs: 1000, userBusy: null, userAway: null };

function turnsRig(over: Partial<ChimeTurnPorts> = {}) {
  let now = 0;
  const state = { free: true, speaking: false, onStage: true, line: '{"text":"真的吗"}' as string | null };
  const shown: [string, string, string][] = [], archived: [string, string, string][] = [], released: string[] = [], prompts: string[] = [];
  const ports: ChimeTurnPorts = {
    chatModel: () => '', character: () => ({ persona: '（One 的角色卡）' }), mood: () => '心情：平静', history: () => 'Gene：下雪了', available: () => true,
    decide: async () => '{"speak":true}',
    line: async prompt => { prompts.push(prompt); if (state.line === null) throw new Error('down'); return state.line; },
    free: () => state.free, onStage: () => state.onStage,
    show: (id, lineId, text) => { shown.push([id, lineId, text]); return true; },
    speaking: () => state.speaking, release: lineId => { released.push(lineId); },
    archive: async (id, lineId, text) => { archived.push([id, lineId, text]); },
    clock: () => now, sleep: async ms => { now += ms; await new Promise(resolve => setImmediate(resolve)); }, createId: () => 'x1',
    ...over,
  };
  return { turns: new ChimeTurns(ports), state, shown, archived, released, prompts, advance: (ms: number) => { now += ms; } };
}

test('her line: her own call, shown once in her bubble, archived once, read in her voice; the floor passes when her voice ends', async () => {
  // 2026-11-25: her voice now starts when her bubble shows and lasts 100 ms of the rig's own clock (it used a real 5 ms timer, which lost
  // the race against the fake clock on a loaded machine since the line waits for real quiet first, I-209 stage voice).
  let clock = 0, voiceEnds = -1;
  const shownHere: [string, string, string][] = [];
  const r = turnsRig({
    clock: () => clock, sleep: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)); },
    speaking: () => clock < voiceEnds,
    voice: () => true, // her reading starts (the voice port says the line was handed to her voice)
    show: (id, lineId, text) => { shownHere.push([id, lineId, text]); voiceEnds = clock + 100; return true; },
  });
  const run = r.turns.speak('one', facts, new AbortController().signal);
  assert.equal(await run, 'said');
  assert.ok(clock >= voiceEnds, 'the floor passed only after her voice ended');
  assert.deepEqual(shownHere, [['one', 'sense-chime-x1', '真的吗']]);
  assert.deepEqual(r.archived, [['one', 'sense-chime-x1', '真的吗']], 'archived once');
  assert.deepEqual(r.released, ['sense-chime-x1']);
  assert.match(r.prompts[0]!, /（One 的角色卡）/);
  assert.match(r.prompts[0]!, /【台上之前的话】\nGene：下雪了/);
  assert.equal(await r.turns.ask('one', facts, new AbortController().signal), true);
});

test('one voice at a time: her line waits while anything else is said or read (not free), then goes', async () => {
  const r = turnsRig();
  r.state.free = false;
  const run = r.turns.speak('one', facts, new AbortController().signal);
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.shown.length, 0, 'not while someone else speaks');
  r.state.free = true;
  assert.equal(await run, 'said');
  assert.equal(r.shown.length, 1);
});

test('a dropped (aborted) or late chime-in never shows and never archives; one who left the stage neither', async () => {
  const r = turnsRig();
  r.state.free = false;
  const controller = new AbortController();
  const run = r.turns.speak('one', facts, controller.signal);
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); // a newer line came
  r.state.free = true;
  assert.equal(await run, 'dropped');
  assert.deepEqual([r.shown.length, r.archived.length], [0, 0]);
  const gone = turnsRig();
  gone.state.onStage = false;
  assert.equal(await gone.turns.speak('one', facts, new AbortController().signal), 'not-shown');
  assert.deepEqual([gone.shown.length, gone.archived.length], [0, 0]);
  const quiet = turnsRig();
  quiet.state.line = '{"text":""}';
  assert.equal(await quiet.turns.speak('one', facts, new AbortController().signal), 'quiet', 'she may choose to say nothing');
  assert.equal(quiet.shown.length, 0);
  const down = turnsRig();
  down.state.line = null;
  assert.equal(await down.turns.speak('one', facts, new AbortController().signal), 'failed');
});

test('the stage: her chime-in goes into HER window\'s bubble and takes the floor; her mouth moves alone; the next line waits for it', async () => {
  const w = stageWorld({ replyOwner: new Map([['r-g', 'gene']]) });
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  assert.deepEqual(w.stage.ids(), ['gene', 'vrm-a'], 'who is on stage, as card ids');
  w.stage.own('sense-chime-1', 'vrm-a');
  assert.deepEqual(w.host.holdLine('sense-chime-1', '我也想去'), { held: true });
  assert.equal((a.of(UNBOUND_EVENTS.bubble)[0] as { text: string }).text, '我也想去', 'in A\'s bubble');
  assert.equal(main.of(UNBOUND_EVENTS.bubble).length, 0, 'not over the first one\'s head');
  assert.deepEqual(w.stage.floor.holder, { replyId: 'sense-chime-1', owner: 'vrm-a' });
  w.host.speaking(true);
  assert.deepEqual(a.of(UNBOUND_EVENTS.speaking), [true]);
  w.host.stream({ id: 'r-g', kind: 'chat', type: 'delta', text: '我也是' });
  w.host.speaking(true);
  assert.deepEqual(main.of(UNBOUND_EVENTS.speaking), [], 'two characters never speak at once');
  w.host.speaking(false); // her reading ended
  assert.equal(w.stage.floor.holder?.replyId, 'r-g', 'then the next one');
  // A line whose voice never comes (read-aloud off): released, the floor passes.
  w.stage.own('sense-chime-2', MAIN_KEY);
  w.host.holdLine('sense-chime-2', '嗯');
  w.stage.release('r-g');
  assert.equal(w.stage.floor.holder?.replyId, 'sense-chime-2');
  w.stage.release('sense-chime-2');
  assert.equal(w.stage.floor.holder, null);
  // What the senses took once reaches every other one on stage (the music).
  const seen: string[] = [], her = w.stage.hostOf('vrm-a')!;
  her.mood = channel => { seen.push(channel); };
  w.stage.relayAll('desk:audio-capture-state', { sources: [] });
  assert.deepEqual(seen, ['desk:audio-capture-state']);
  w.host.exit(); w.host.quit();
});

test('her chime-in reaches the companion window as a held sense line it accepts (read aloud there, never shown on it)', () => {
  const line = { id: 'sense-chime-abc', text: '真的吗', origin: chimeInOrigin('sense-chime-abc', 1_700_000_000_000) };
  assert.deepEqual(readSenseLineMessage(line), line);
});

test('perceive once: someone else on stage reads the one screen description the watched one has; off stage nothing', () => {
  const calls: (string | null)[] = [];
  const source = { sight: (id: string | null) => { calls.push(id); return id === 'gene' ? { text: '画面' } : null; } };
  assert.deepEqual(sharedSight(source, 'one', 'gene', ['gene', 'one']), { text: '画面' });
  assert.equal(sharedSight(source, 'one', 'gene', []), null, 'not on stage: nothing (as before)');
  assert.deepEqual(sharedSight(source, 'gene', 'gene', ['gene', 'one']), { text: '画面' });
  assert.equal(calls.filter(id => id === 'gene').length, 2, 'only reads: no look is taken here');
});

test('someone else on stage: a pat, a pinch and a pull move HER mood (her own profile), feeding stays the desktop companion\'s', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i209-touch-'));
  let now = 1_700_000_000_000;
  const host = new MoodHost(directory, () => {}, () => now);
  try {
    await host.load(); host.activate('gene'); host.ensure('one');
    const before = host.liveOf('one')!.snapshot.values, geneBefore = host.get().snapshot.values;
    const touch = new StageTouchMood({ event: (event, id) => host.event(event, id), lift: (lift, id) => host.lift(lift, id), view: id => host.liveOf(id), clock: () => now });
    touch.interaction('one', { sessionId: 's1', type: 'phase', phase: 'rua' });
    for (let i = 0; i < 8; i++) { now += 400; touch.interaction('one', { sessionId: 's1', type: 'rua', id: `p${i}`, activeMs: 400 }); }
    touch.interaction('one', { sessionId: 's1', type: 'phase', phase: 'idle' });
    const after = host.liveOf('one')!.snapshot.values;
    assert.ok(after.O > before.O || after.E > before.E, `her closeness or ease rose: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    assert.deepEqual(host.get().snapshot.values, geneBefore, 'the desktop companion\'s mood did not move');
    assert.equal(touch.pulled('one', { ended: 'released', strength: 0.2, heldMs: 400 }), true, 'a gentle pull lifts her');
    assert.throws(() => touch.interaction('one', { sessionId: 's2', type: 'phase', phase: 'food-wait' }), /只接受抚摸和捏脸/);
    assert.throws(() => touch.interaction('one', { sessionId: 's9', type: 'rua', id: 'x', activeMs: 100 }), /过期/);
  } finally { await host.flush(); await rm(directory, { recursive: true, force: true }); }
});

test('the control window\'s chat list: a reply of someone else on stage shows her name', () => {
  const label = { textContent: 'Gene' }, row = { querySelector: () => label };
  const root = { querySelectorAll: () => [{ querySelector: () => ({ textContent: 'old' }) }, row] } as unknown as ParentNode;
  assert.equal(labelReplySpeaker(root, 'One'), true);
  assert.equal(label.textContent, 'One');
  assert.equal(labelReplySpeaker(root, ''), false);
});
