// I-154 step 1 / I-176 step 3 (docs/claude/2026-11-19-unbound-in-window.md, docs/claude/2026-11-23-i176-delete.md): Unbound's engine in the
// companion window and in the control window's preview (the only engine since I-176; its developer switch is gone).
//  - the personal-feel strength: stored in page storage, garbage reads as 0, a value of the removed switch is read once, a change applies in place;
//  - the safety line: entering window mode changes none of the user's senses and gives the engine only its one named port;
//  - her body there: the real Gene frame loop (figure, idle layer, mouth) at 60 and 30 fps: she stays where she stands, blinks,
//    follows the cursor, a pat comes and goes without a jump, her mouth opens while she speaks and closes after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { LEGACY_WINDOW_ENGINE_KEY, WINDOW_STYLE_KEY, announceWindowStyle, parseWindowStyle, readWindowStyle, watchWindowStyle, writeWindowStyle } from '../src/unbound/window-mode/window-style';
import { WINDOW_STAGE_HOST_METHODS, windowStageHost, type WindowStageHost } from '../src/unbound/window-mode/host-ports';
import { createWindowStage } from '../src/unbound/window-mode';
import { WINDOW_BLINK, WINDOW_PAT, WindowLife } from '../src/unbound/window-mode/window-life';
import { WindowBody, unboundPageBeside } from '../src/unbound/window-mode/window-body';
import { WindowStageNotYet } from '../src/unbound/window-mode/not-yet';
import { WindowStageGames } from '../src/unbound/window-mode/window-stage-games';
import { WindowStageMotions } from '../src/unbound/window-mode/window-stage-motions';
import { WindowStageMusic } from '../src/unbound/window-mode/window-stage-music';
import { STAGE_SURFACE_MEMBERS } from '../src/stage/stage-surface';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { geneFigure, TRACKED, max } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { legacyMorphIndices } from '../src/stage/model-profile';

const DEG = 180 / Math.PI;
const memory = (initial?: string, key = WINDOW_STYLE_KEY) => { const map = new Map<string, string>(); if (initial !== undefined) map.set(key, initial); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map }; };

// ---- the personal-feel strength ------------------------------------------------------------------------------------------------------

test('the strength is 0 unless stored; anything unreadable is 0; it is kept in 0..1; a value of the removed switch is read when the new key is empty', () => {
  assert.equal(readWindowStyle(null), 0);
  assert.equal(readWindowStyle(memory()), 0);
  for (const bad of ['', 'yes', '{"style":"1"}', '[1]', 'null', '{"on":1}', 'x'.repeat(300)]) assert.equal(readWindowStyle(memory(bad)), 0, bad);
  assert.equal(readWindowStyle({ getItem: () => { throw new Error('denied'); }, setItem: () => {} }), 0);
  assert.equal(parseWindowStyle('{"style":7}'), 1);
  assert.equal(parseWindowStyle('{"style":-3}'), 0);
  const storage = memory();
  assert.equal(writeWindowStyle(storage, 0.35), true);
  assert.equal(readWindowStyle(storage), 0.35);
  assert.equal(writeWindowStyle({ getItem: () => null, setItem: () => { throw new Error('full'); } }, 0.5), false);
  assert.equal(writeWindowStyle(null, 0.5), false);
  // The removed switch stored {on, style} under its own key: the strength it carried is kept; the new key wins once it exists.
  assert.equal(readWindowStyle(memory('{"on":true,"style":0.4}', LEGACY_WINDOW_ENGINE_KEY)), 0.4);
  const both = memory('{"style":0.1}'); both.map.set(LEGACY_WINDOW_ENGINE_KEY, '{"on":true,"style":0.9}');
  assert.equal(readWindowStyle(both), 0.1);
});

test('a page follows the strength: a change is applied in place once, other keys are ignored, the page that wrote it hears the announcement', () => {
  const listeners: ((event: Event) => void)[] = [];
  const target = { addEventListener: (_: string, f: (event: Event) => void) => listeners.push(f), removeEventListener: () => {} } as unknown as Window;
  const seen: number[] = [];
  watchWindowStyle(target, 0, value => seen.push(value));
  const fire = (key: string | null, newValue: string | null) => listeners.forEach(f => f({ key, newValue } as unknown as Event));
  fire('something-else', '{"style":0.9}');
  fire(WINDOW_STYLE_KEY, '{"style":0.5}');
  fire(WINDOW_STYLE_KEY, '{"style":0.5}');
  fire(WINDOW_STYLE_KEY, '{"style":0.2}');
  fire(null, null); // storage cleared: back to 0
  assert.deepEqual(seen, [0.5, 0.2, 0]);
  const events: Event[] = [];
  announceWindowStyle({ dispatchEvent: event => { events.push(event); return true; } }, 0.4);
  assert.equal((events[0] as unknown as { key: string }).key, WINDOW_STYLE_KEY);
  assert.equal(parseWindowStyle((events[0] as unknown as { newValue: string }).newValue), 0.4);
});

test('which ports: the companion window gets its host port and no grants, the control window preview the preview port and the authoring grants (batch 7); the strength comes from storage', () => {
  const desktop = { isBehaviorModelSupported: async () => true } as never;
  const grants: unknown[] = [];
  const make = (_host: unknown, style: number, given: unknown) => { grants.push(given); return { style }; };
  const control = createWindowStage({ isPet: false, storage: memory('{"style":0.2}'), desktop }, make); // no-pet-ok: createWindowStage's isPet is the existing companion-window flag
  assert.equal(control.style, 0.2);
  assert.ok(grants[0] && typeof grants[0] === 'object', 'the control window preview gets the authoring grants');
  const companion = createWindowStage({ isPet: true, storage: null, desktop }, make); // no-pet-ok: createWindowStage's isPet is the existing companion-window flag
  assert.equal(companion.style, 0, 'unreadable storage: 0');
  assert.equal(grants[1], null, 'the companion window gets none');
});

// ---- the safety line ------------------------------------------------------------------------------------------------------------

/**
 * The companion window's preload as far as this matters: the six senses the permission bundle turns on (「发图片」 since 2026-11-20), every way the preload can switch
 * them, and Unbound's own way out. Every property read is recorded.
 */
function fakePetPreload() {
  const senses = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false };
  const touched: string[] = [];
  const turnOn = () => { for (const key of Object.keys(senses) as (keyof typeof senses)[]) senses[key] = true; };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    isBehaviorModelSupported: async () => true,
    // Batch 5: the grants of her own motions and her answer to a test command (reads and one report; none switches a sense).
    resolveChatGesture: async () => null, resolveHerAction: async () => null, reportHerAction: async () => {}, getBehaviorBodyPlan: async () => null,
    resolveBehaviorBody: async () => null, resolveBehaviorMotion: async () => null,
    resolveHerLifeMotion: async () => null, // batch 6: her own life's held pose (a read)
    setRuntimeState: async () => { turnOn(); }, setPerception: async () => { turnOn(); }, setVoiceInput: async () => { senses.microphone = true; },
    startScreenShare: async () => { senses.screen = true; }, setSystemAudio: async () => { senses.listen = true; }, setFaceCheck: async () => { senses.face = true; },
    setPoseSensing: async () => { senses.camera = true; }, toggleUnbound: async () => { turnOn(); return 'entering'; }, setUnbound: async () => { turnOn(); return {}; },
  };
  const desktop = new Proxy(methods, { get(target, key) { if (typeof key === 'string') touched.push(key); return target[key as string]; } });
  return { desktop: desktop as unknown as WindowStageHost & import('../src/unbound/window-mode').WindowPreviewGrants, senses, touched };
}

test('safety: entering window mode changes none of the senses (camera, 发图片, microphone, screen, computer sound, face check), whatever the engine does with its port', async () => {
  const { desktop, senses, touched } = fakePetPreload();
  const before = structuredClone(senses);
  // The engine, as carelessly as code can be: every function on the port it was given is called.
  const made = createWindowStage({ isPet: true, storage: memory(), desktop }, host => { for (const value of Object.values(host)) if (typeof value === 'function') void (value as () => unknown)(); return host; }); // no-pet-ok: createWindowStage's isPet is the existing companion-window flag
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(made.stage, 'window mode was entered');
  assert.deepEqual(senses, before, 'no sense was switched');
  assert.deepEqual(Object.keys(made.stage!).sort(), [...WINDOW_STAGE_HOST_METHODS].sort(), 'the port has the named read only');
  assert.deepEqual([...new Set(touched)].filter(name => !(WINDOW_STAGE_HOST_METHODS as readonly string[]).includes(name)), [], 'nothing else of the preload was reached');
  // The fake is live: the same calls on the preload itself would have switched them (so the check above can fail).
  await (desktop as unknown as Record<string, () => Promise<unknown>>).setRuntimeState();
  assert.notDeepEqual(senses, before);
});

test('safety: the port is a new frozen object with the allowed methods only, each still answering', async () => {
  const { desktop } = fakePetPreload();
  const host = windowStageHost(desktop);
  assert.notEqual(host, desktop);
  assert.ok(Object.isFrozen(host));
  assert.deepEqual(Object.keys(host), [...WINDOW_STAGE_HOST_METHODS]);
  assert.equal(await host.isBehaviorModelSupported(), true);
  // Batch 5: what was added is the companion stage's own reads of her motions' grants and her answer to a test command; no sense, no Unbound.
  assert.deepEqual([...WINDOW_STAGE_HOST_METHODS].sort(), ['getBehaviorBodyPlan', 'getRestStand', 'isBehaviorModelSupported', 'reportHerAction', 'resolveBehaviorBody',
    'resolveBehaviorMotion', 'resolveChatGesture', 'resolveHerAction', 'resolveHerLifeMotion']); // batch 6: the held pose's grant; 2026-11-21: her default stand (a read)
  for (const name of WINDOW_STAGE_HOST_METHODS) assert.ok(!/perception|screen|voice|audio|face|pose|unbound|runtime/i.test(name.replace('BehaviorModel', '')), `${name} is not a sense or a way out`);
});

test('the not-yet list and the window stage together answer for every member of the stage surface', () => {
  const notYet = Object.getOwnPropertyNames(WindowStageNotYet.prototype).filter(name => name !== 'constructor');
  for (const name of notYet) assert.ok((STAGE_SURFACE_MEMBERS as readonly string[]).includes(name), `${name} is not a stage surface member`);
  // Batch 4: the games' members moved out of the list into window-stage-games.ts; every one of them is a surface member too.
  const games = Object.getOwnPropertyNames(WindowStageGames.prototype).filter(name => name !== 'constructor' && !name.startsWith('game') && name !== 'pictureParts');
  for (const name of ['setRps', 'startGive', 'takeGive', 'withdrawGive', 'giveAnchor', 'captureGivePicture', 'handInput', 'startHands', 'handsCommand', 'handsState', 'handsAnchor', 'handsNear']) {
    assert.ok(games.includes(name), `${name} is answered by the games' members`);
    assert.ok(!notYet.includes(name), `${name} is no longer a stand-in`);
  }
  for (const name of games) assert.ok((STAGE_SURFACE_MEMBERS as readonly string[]).includes(name), `${name} is not a stage surface member`);
  // Batch 5: her motions' members moved into window-stage-motions.ts.
  const motions = Object.getOwnPropertyNames(WindowStageMotions.prototype).filter(name => name !== 'constructor');
  for (const name of ['setTyping', 'setBehaviorBlocked', 'setBodyInputBlocked', 'playHerAction', 'expressionSupport', 'playExpression', 'playReaction']) {
    assert.ok(motions.includes(name), `${name} is answered by her motions' members`);
    assert.ok(!notYet.includes(name), `${name} is no longer a stand-in`);
  }
  for (const name of motions) assert.ok((STAGE_SURFACE_MEMBERS as readonly string[]).includes(name), `${name} is not a stage surface member`);
  // Batch 6: the music members moved into window-stage-music.ts.
  const music = Object.getOwnPropertyNames(WindowStageMusic.prototype).filter(name => name !== 'constructor' && name !== 'musicView');
  for (const name of ['setMusicEnabled', 'setMusicSample', 'setMusicSettings', 'getMusicPresence', 'getMusicChoiceLine', 'setListenKindLine', 'rejudgeMusicNow']) {
    assert.ok(music.includes(name), `${name} is answered by the music members`);
    assert.ok(!notYet.includes(name), `${name} is no longer a stand-in`);
  }
  for (const name of music) assert.ok((STAGE_SURFACE_MEMBERS as readonly string[]).includes(name), `${name} is not a stage surface member`);
});

// ---- her window life (pure) ------------------------------------------------------------------------------------------------------

test('window life: natural blinks at the pet rhythm; the cursor gives a look (her left = your right, up = negative pitch); 看鼠标 off looks ahead', () => {
  let seed = 1; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const life = new WindowLife(random);
  const starts: number[] = [];
  let last = 0;
  for (let i = 0; i < 60 * 60; i++) {
    const t = life.frame({ dt: 1 / 60, pointer: { x: 0.5, y: 0.4 }, eyes: { x: 0, y: 0.2 }, follow: true, pat: false });
    if (t.blink > 0.5 && last <= 0.5) starts.push(i / 60);
    last = t.blink;
    if (i === 100) { assert.ok(t.eyes.yaw > 0.2 && t.eyes.pitch < 0, JSON.stringify(t.eyes)); }
  }
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  assert.ok(starts.length >= 8 && starts.length <= 20, `${starts.length} blinks in a minute`);
  assert.ok(gaps.every(g => g >= WINDOW_BLINK.minS - 0.05 && g <= WINDOW_BLINK.minS + WINDOW_BLINK.spreadS + 0.05), gaps.join(', '));
  assert.deepEqual(life.frame({ dt: 1 / 60, pointer: { x: 1, y: 1 }, eyes: null, follow: false, pat: false }).eyes, { yaw: 0, pitch: 0 });
});

test('window life: a pat eases her lids half shut and back with no jump (60 and 30 fps), outlives a brief exit, and holds natural blinks off', () => {
  for (const fps of [60, 30]) {
    const life = new WindowLife(() => 0.5);
    const lids: number[] = [];
    for (let i = 0; i < fps * 6; i++) {
      const t = i / fps, pat = (t > 1 && t < 3.5 && !(t > 2 && t < 2.2)) ; // a brief exit at 2.0–2.2 s
      life.frame({ dt: 1 / fps, pointer: null, eyes: null, follow: true, pat });
      lids.push(life.patLids);
      if (t > 2.05 && t < 2.15) assert.ok(life.patted, 'the brief exit is held');
    }
    const steps = lids.slice(1).map((v, i) => Math.abs(v - lids[i]));
    assert.ok(Math.max(...lids) > WINDOW_PAT.lids * 0.95, 'the lids reach the pat level');
    assert.ok(max(steps) < (fps === 60 ? 0.03 : 0.06), `${fps} fps: largest lid step ${max(steps).toFixed(4)}`);
    assert.equal(lids.at(-1), 0, 'and open fully again');
  }
});

// ---- her body in the window: the real Gene frame loop ---------------------------------------------------------------------------

async function runWindowBody(fps: number, seconds: number, script: (t: number) => { pat?: boolean; speaking?: boolean; style?: number; pointer?: { x: number; y: number } }) {
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 0 });
  const idle = await shippedIdle();
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const body = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random);
  await new Promise(resolve => setImmediate(resolve)); // the idle is made
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const mouthIndex = legacyMorphIndices(fixture.mesh.morphTargetDictionary).mouth;
  const frames: { t: number; rotations: Quaternion[]; root: { x: number; z: number }; mouth: number }[] = [];
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, input = script(t);
      if (input.speaking !== undefined) body.setSpeaking(input.speaking);
      if (input.style !== undefined && input.style !== body.style) body.setStyle(input.style);
      body.frame(frame ? 1 / fps : 0, { pointer: input.pointer ?? { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: input.pat === true });
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), root: { x: figure.placement.xM, z: figure.placement.depthM }, mouth: fixture.mesh.morphTargetInfluences![mouthIndex] });
    }
  } finally { body.dispose(); fixture.close(); }
  const step = (from: number, to: number) => frames.slice(1).flatMap((f, i) => f.t < from || f.t > to ? [] : [Math.max(...f.rotations.map((q, b) => q.angleTo(frames[i].rotations[b]) * DEG))]);
  const surprise = (from: number, to: number) => {
    const out: number[] = [], s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
    for (let i = 2; i < frames.length; i++) {
      if (frames[i].t < from || frames[i].t > to) continue;
      for (let b = 0; b < bones.length; b++) {
        s.copy(frames[i].rotations[b]).multiply(inv.copy(frames[i - 1].rotations[b]).invert());
        l.copy(frames[i - 1].rotations[b]).multiply(inv.copy(frames[i - 2].rotations[b]).invert());
        out.push(s.angleTo(l) * DEG);
      }
    }
    return out;
  };
  return { frames, step, surprise };
}

for (const fps of [60, 30]) {
  test(`window body at ${fps} fps: she stays where she stands; a pat and its end, the cursor sweeping, speaking and the personal feel never jump`, async () => {
    const run = await runWindowBody(fps, 9, t => ({
      pat: t > 2 && t < 4.5,
      speaking: t > 5 && t < 6.5,
      style: t > 6.8 ? 0.6 : 0,
      pointer: { x: Math.sin(t * 1.3) * 0.8, y: Math.cos(t * 0.9) * 0.4 },
    }));
    const roots = run.frames.map(f => Math.hypot(f.root.x, f.root.z));
    assert.ok(max(roots) < 1e-9, `she never walks (root off by ${max(roots)} m)`);
    const idleStep = max(run.step(0.5, 2)), idleSurprise = max(run.surprise(0.5, 2));
    const patStep = max(run.step(2, 5.5)), patSurprise = max(run.surprise(2, 5.5));
    const styleSurprise = max(run.surprise(6.8, 9));
    console.log(`  ${fps} fps · idle step ${idleStep.toFixed(3)}° surprise ${idleSurprise.toFixed(3)}° · pat on/off step ${patStep.toFixed(3)}° surprise ${patSurprise.toFixed(3)}° · personal feel on: surprise ${styleSurprise.toFixed(3)}°`);
    // A frame's step may not depart from the last one by more than the idle's own, with a small margin (no jump, no hitch).
    const limit = (fps === 60 ? 0.5 : 1.0);
    assert.ok(patSurprise < Math.max(limit, idleSurprise * 1.5), `pat surprise ${patSurprise.toFixed(3)}°`);
    assert.ok(styleSurprise < Math.max(limit, idleSurprise * 1.5), `personal feel surprise ${styleSurprise.toFixed(3)}°`);
    const mouth = run.frames.map(f => f.mouth);
    const speakingOpen = max(run.frames.filter(f => f.t > 5.2 && f.t < 6.5).map(f => f.mouth));
    const closedAfter = run.frames.filter(f => f.t > 7.5).map(f => f.mouth);
    assert.ok(speakingOpen > 0.3, `her mouth opens while she speaks (${speakingOpen.toFixed(2)})`);
    assert.ok(max(closedAfter) < 0.01, 'and closes after');
    const mouthJumps = mouth.slice(1).map((v, i) => Math.abs(v - mouth[i]));
    assert.ok(max(mouthJumps) < (fps === 60 ? 0.2 : 0.35), `mouth step ${max(mouthJumps).toFixed(3)}`);
  });
}

test('the bundled idle is read from the Unbound page beside the pet page (built and dev server); any other page gets none', () => {
  assert.equal(unboundPageBeside('file:///C:/Apps/soft%20hearts/resources/app.asar/dist/index.html?pet=1'), 'file:///C:/Apps/soft%20hearts/resources/app.asar/dist/src/unbound/index.html');
  assert.equal(unboundPageBeside('http://localhost:5173/?pet=1'), 'http://localhost:5173/src/unbound/index.html');
  for (const other of ['https://example.com/', 'file:///C:/x/index.html', 'not a url', 'http://localhost:5173/src/unbound/index.html']) assert.equal(unboundPageBeside(other), null, other);
});
