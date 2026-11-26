// I-209 step 3 (同时启动三个全屏额外加功能"做"):
// each character on stage is her own complete full screen (the same UnboundHost the first one is, her own window and page), made through
// createUnboundStage with fake Electron parts (tests/helpers/stage-world.ts). The coordinator owns only what they share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stageWorld, flush, type StageWindow } from './helpers/stage-world';
import { MAIN_KEY } from '../electron/unbound/company/stage';
import { UnboundSayAcks } from '../electron/unbound/say-ack';
import { setHandedLineGate, turnOwnerFor } from '../electron/brain/handed-line-gate';
import { ownHistory, ownerSettings } from '../electron/brain/turn-owner/persona';
import { SharedLook } from '../electron/unbound/company/shared-senses';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS, type UnboundScene } from '../shared/unbound/scene';
import { UNBOUND_COMPANY_REQUESTS, UNBOUND_STAGE_EVENTS, UNBOUND_STAGE_REQUESTS, type StageBody, type StageView } from '../shared/unbound/company';

const body = (over: Partial<StageBody> = {}): StageBody => ({ xM: 0, depthM: 8, radiusM: 0.25, heightM: 1.6, faceM: 1.47, dipM: 0, vxM: 0, vdM: 0, pulled: false, closing: false, free: true, ...over });
const views = (win: StageWindow) => win.of(UNBOUND_STAGE_EVENTS.stage) as StageView[];
const scene = async (w: ReturnType<typeof stageWorld>, win: StageWindow) => await w.call(UNBOUND_REQUESTS.getScene, win) as UnboundScene;

test('one character: exactly as before (no view of anyone else, her reply\'s bubble and her mouth in her own window, nothing routed)', async () => {
  const w = stageWorld();
  const win = await w.enter();
  assert.equal(w.stage.present, 1);
  assert.equal(w.stage.speechTo('r1'), null, 'alone on stage nothing is routed');
  w.host.stream({ id: 'r1', kind: 'chat', type: 'delta', text: '嗯' });
  w.host.speaking(true);
  assert.equal((win.of(UNBOUND_EVENTS.bubble)[0] as { text: string }).text, '嗯');
  assert.deepEqual(win.of(UNBOUND_EVENTS.speaking), [true]);
  assert.ok(views(win).every(view => view.present === 1 && view.others.length === 0 && !('subject' in view)), 'any view she gets says she is alone');
  w.host.exit(); w.host.quit();
});

test('three on stage: each is her own full-screen host and window; one world (the same eye height, viewer distance and floor in every scene)', async () => {
  const w = stageWorld();
  const main = await w.enter();
  const a = await w.bringOut('vrm-a', 1.7), b = await w.bringOut('pmx-b', 1.5);
  assert.deepEqual(w.stage.keys(), [MAIN_KEY, 'vrm-a', 'pmx-b']);
  assert.notEqual(w.stage.hostOf('vrm-a'), w.host, 'her own host, not a copy inside the first one\'s page');
  const scenes = await Promise.all([main, a, b].map(win => scene(w, win)));
  assert.deepEqual(scenes.map(s => s.modelUrl), ['mmd-asset://t/gene.pmx', 'mmd-asset://tok/a.vrm', 'mmd-asset://tok/b.pmx'], 'each draws her own model');
  for (const s of scenes) {
    assert.equal(s.world.eyeHeightM, scenes[0]!.world.eyeHeightM, 'one eye height');
    assert.equal(s.world.viewerDistanceM, scenes[0]!.world.viewerDistanceM, 'one viewer distance');
    assert.deepEqual(s.world.workArea, scenes[0]!.world.workArea, 'one floor line (the work area\'s bottom)');
  }
  // Everyone reports; every page hears where the others stand, and nothing about a camera (2026-11-25: each frames her own body).
  await w.call(UNBOUND_STAGE_REQUESTS.body, main, body({ xM: -1, depthM: 9 }));
  await w.call(UNBOUND_STAGE_REQUESTS.body, a, body({ xM: 0.2, depthM: 6, heightM: 1.7 }));
  await w.call(UNBOUND_STAGE_REQUESTS.body, b, body({ xM: 1.2, depthM: 8, heightM: 1.5 }));
  const last = [main, a, b].map(win => views(win).at(-1)!);
  for (const view of last) { assert.equal(view.present, 3); assert.equal('subject' in view, false, 'no shared eye: pulling one never moves the others'); }
  assert.deepEqual(last[0]!.others.map(o => o.id).sort(), ['pmx-b', 'vrm-a']);
  w.host.exit(); await flush();
  assert.deepEqual(w.stage.keys(), [], 'she went back: everyone leaves with her');
  assert.ok(w.windows.every(win => win.destroyed), 'every window closed');
  w.host.quit();
});

test('stacking follows depth: the nearer one\'s window is raised last (on top), only when the order changes', async () => {
  const w = stageWorld();
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  await w.call(UNBOUND_STAGE_REQUESTS.body, main, body({ xM: -1, depthM: 9 }));
  await w.call(UNBOUND_STAGE_REQUESTS.body, a, body({ xM: 1, depthM: 6 }));
  assert.deepEqual(w.stage.world.stack, [MAIN_KEY, 'vrm-a']);
  assert.equal(w.raised.at(-1), a, 'the nearer one on top');
  const before = w.raised.length;
  await w.call(UNBOUND_STAGE_REQUESTS.body, a, body({ xM: 1, depthM: 6.2 }));
  await w.call(UNBOUND_STAGE_REQUESTS.body, main, body({ xM: -1, depthM: 6.15 })); // about the same depth: no swap, no flicker
  assert.equal(w.raised.length, before, 'nothing raised while the order holds');
  await w.call(UNBOUND_STAGE_REQUESTS.body, main, body({ xM: -1, depthM: 4 })); // you pulled the first one nearer
  assert.deepEqual(w.stage.world.stack, ['vrm-a', MAIN_KEY]);
  assert.equal(w.raised.at(-1), main);
  w.host.exit(); w.host.quit();
});

test('a request is answered only for the window that sent it: her body report from her own window, never another one\'s', async () => {
  const w = stageWorld();
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  await w.call(UNBOUND_STAGE_REQUESTS.body, a, body({ xM: 2, depthM: 7 }));
  assert.equal(w.stage.world.bodies().get('vrm-a')!.xM, 2, 'A\'s report is A\'s');
  assert.equal(w.stage.world.bodies().get(MAIN_KEY)!.xM === 2, false, 'and not the first one\'s');
  const sceneOfA = await scene(w, a);
  assert.equal(sceneOfA.modelUrl, 'mmd-asset://tok/a.vrm', 'her scene request reaches her own host');
  const stranger = { sender: { id: 99_999, mainFrame: {} }, senderFrame: {} };
  await assert.rejects(Promise.resolve().then(() => w.handlers.get(UNBOUND_REQUESTS.getScene)!(stranger)), /未授权/);
  void main;
  w.host.exit(); w.host.quit();
});

test('clicking B opens HER box (her host, her head) and the line you type becomes her turn; voice input goes to the last one clicked', async () => {
  const w = stageWorld();
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  assert.equal(w.stage.addressedHost(), w.host);
  await w.call(UNBOUND_REQUESTS.touch, a, { part: 'head', side: null });
  assert.equal(w.clicks.length, 1, 'the click goes to the box');
  assert.equal(w.stage.addressedHost(), w.stage.hostOf('vrm-a'), 'the box opens beside her, her line shows near her');
  assert.equal(w.stage.addresseeId(), 'vrm-a');
  assert.equal(w.stage.addresseeName(), 'A', 'her box says whose it is ("对 A 说点什么…")');
  assert.equal((await w.host.company.look()).entries.find(e => e.talking)!.id, 'vrm-a', 'the panel says who you talk to');
  const timers: (() => void)[] = [];
  const acks = new UnboundSayAcks({ now: () => 1, setTimer: run => { timers.push(run); return timers.length; }, clearTimer: () => {}, journal: () => {}, addressee: () => w.stage.addresseeId() });
  setHandedLineGate(acks);
  try {
    const tag = acks.start(() => {});
    acks.own(tag.line, w.stage.addresseeId()); // the wiring's say: her box's line
    assert.equal(turnOwnerFor(tag.line), 'vrm-a', 'the line is her turn (step 2\'s id)');
    assert.equal(turnOwnerFor(undefined), 'vrm-a', 'voice input goes to the last one you clicked');
    const personas: Record<string, string> = { gene: 'I am Gene', 'vrm-a': 'I am A' };
    assert.equal(ownerSettings({ persona: 'I am Gene' }, turnOwnerFor(tag.line), 'gene', id => personas[id]!).persona, 'I am A', 'written by her own card');
    assert.throws(() => ownerSettings({ persona: 'I am Gene' }, 'vrm-a', 'gene', () => ''), /人设/, 'never the first one\'s words in her place');
    // Who said what: with others on stage the control window's one list mixes speakers, so every turn's history is her own archive's.
    assert.equal(ownHistory(false, 'vrm-a', 'gene', 1), true, 'her turn: her own lines and yours');
    assert.equal(ownHistory(false, 'gene', 'gene', 1), true, 'the first one\'s turn with others on stage: hers too');
    assert.equal(ownHistory(false, 'gene', 'gene', 0), false, 'alone with 新聊天 off: the renderer\'s list, as before');
    await w.call(UNBOUND_REQUESTS.touch, main, { part: 'head', side: null });
    assert.equal(turnOwnerFor(undefined), null, 'clicked the first one again: as before');
  } finally { setHandedLineGate(null); }
  w.host.exit(); w.host.quit();
});

test('one voice: her reply\'s bubble goes to her window only, her mouth moves only while she has the floor, then the floor passes', async () => {
  const owners = new Map([['r-a', 'vrm-a'], ['r-g', 'gene']]);
  const w = stageWorld({ replyOwner: owners });
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  w.host.stream({ id: 'r-a', kind: 'chat', type: 'delta', text: '我是A' });
  assert.equal(a.of(UNBOUND_EVENTS.bubble).length, 1, 'A\'s words in A\'s bubble');
  assert.equal(main.of(UNBOUND_EVENTS.bubble).length, 0, 'not over the first one\'s head');
  w.host.speaking(true);
  assert.deepEqual(a.of(UNBOUND_EVENTS.speaking), [true]);
  assert.deepEqual(main.of(UNBOUND_EVENTS.speaking), [], 'one mouth moves');
  w.host.stream({ id: 'r-g', kind: 'chat', type: 'delta', text: '我是Gene' }); // the first one's line comes while A still speaks
  assert.equal(main.of(UNBOUND_EVENTS.bubble).length, 1);
  w.host.speaking(true);
  assert.deepEqual(main.of(UNBOUND_EVENTS.speaking), [], 'she waits for the floor (the voice still sounding is A\'s)');
  assert.equal(w.stage.floor.holder!.replyId, 'r-a');
  w.host.stream({ id: 'r-a', kind: 'chat', type: 'done', text: '' });
  w.host.speaking(false); // A's reading ended
  assert.equal(w.stage.floor.holder!.replyId, 'r-g', 'the floor passed');
  assert.deepEqual(a.of(UNBOUND_EVENTS.speaking), [true, false]);
  w.host.speaking(true);
  assert.deepEqual(main.of(UNBOUND_EVENTS.speaking), [true], 'now her mouth');
  assert.deepEqual(a.of(UNBOUND_EVENTS.speaking), [true, false], 'never two at once');
  w.host.exit(); w.host.quit();
});

test('one close moment: while A\'s peek plays nobody else starts one (her own peek waits, her reply\'s kiss is the lighter word)', async () => {
  const w = stageWorld({ peek: true });
  await w.enter(); await w.bringOut('vrm-a');
  const a = w.stage.hostOf('vrm-a')!;
  assert.equal(w.stage.closeBusy(MAIN_KEY), false);
  assert.equal(a.peek!.trial(), true, 'A comes up to the lens');
  assert.equal(w.stage.closeBusy(MAIN_KEY), true);
  assert.equal(w.stage.closeBusy('vrm-a'), false, 'her own does not block her');
  assert.equal(w.host.peek!.arbiter!.block(), '另一位正在凑近你', 'the first one\'s own peek waits');
  assert.equal(w.host.peek!.chatBeat('kiss'), 'lighter', 'her reply\'s kiss does not walk up while A is close');
  assert.deepEqual(w.journal.at(-1), { kind: 'kiss', block: 'busy' }, 'journaled with its block word, as always');
  w.host.exit(); w.host.quit();
});

test('a shared look is one call for everyone on stage (taken once, kept a moment); a failed look is not kept', async () => {
  let now = 0, calls = 0, fail = false;
  const look = new SharedLook(async () => { calls++; await flush(); if (fail) throw new Error('x'); return '在看屏幕'; }, () => now, 1_000);
  const answers = await Promise.all([look.read(), look.read(), look.read()]);
  assert.deepEqual(answers, ['在看屏幕', '在看屏幕', '在看屏幕']);
  assert.equal(calls, 1, 'three on stage, one haiku call');
  now = 500; await look.read(); assert.equal(calls, 1, 'fresh: the same answer');
  now = 2_000; fail = true; await assert.rejects(look.read()); now = 2_100; fail = false; await look.read();
  assert.equal(calls, 3, 'a failed look is asked again');
  // The life readings (the camera's pose signal among them) are read once a second for everyone.
  let reads = 0;
  const readings = new SharedLook<unknown>(() => null, () => now, 900);
  for (let i = 0; i < 3; i++) readings.now(() => { reads++; return { pose: 'sitting' }; });
  assert.equal(reads, 1);
});

test('the guard sends the last one back: she walks out first (her view says leave), then her window closes; the first one says why', async () => {
  const w = stageWorld();
  const main = await w.enter(), a = await w.bringOut('vrm-a'), b = await w.bringOut('pmx-b');
  await w.call(UNBOUND_COMPANY_REQUESTS.guard, main, { present: 3, p95Ms: 33, budgetMs: 20.8 }); await flush();
  assert.equal(views(b).at(-1)!.leave, true, 'the last one who came out walks out');
  assert.equal(views(a).at(-1)!.leave, undefined);
  assert.equal(b.destroyed, false, 'not gone in one frame');
  await w.call(UNBOUND_STAGE_REQUESTS.left, b); await flush();
  assert.equal(b.destroyed, true, 'gone once she walked out');
  assert.deepEqual(w.stage.keys(), [MAIN_KEY, 'vrm-a']);
  assert.match((main.of(UNBOUND_EVENTS.said).at(-1) as { notice: string }).notice, /B先回去了/);
  assert.equal(views(a).at(-1)!.present, 2, 'the others hear who is left');
  w.host.exit(); w.host.quit();
});

test('a newcomer comes out clear of everyone already standing (never inside someone)', async () => {
  const w = stageWorld();
  await w.enter();
  const at = w.host.her.placement!;
  await w.bringOut('vrm-a');
  const her = w.stage.hostOf('vrm-a')!.her.placement!;
  assert.ok(Math.hypot(her.xM - at.xM, her.depthM - at.depthM) >= 0.5 + 0.15 - 1e-9, `she comes out beside the first one (${JSON.stringify(her)} vs ${JSON.stringify(at)})`);
  w.host.exit(); w.host.quit();
});
