/**
 * 2026-11-24 (docs/claude/2026-11-24-music-nod-window.md): the same nod out in full-screen Unbound (src/unbound/her/out-senses.ts runs the
 * window's WindowMusic): on the page's own HerOut frame order with the bundled public Gene, at 60 and 30 fps, her head goes down on the kicks
 * when she chose to nod and gives way to her speaking, every hand-over eased; the user's settings reach the page (strength 0: no nod), and
 * what her body does goes back to the host as the fact 'stage-state', "nod" only while it shows. The host side: the sense bridge sends the
 * settings before the first music frame to the window she is shown in and on every change; StageStateHost reads her full-screen page's
 * report while she is out and the companion window's at home, neither retiring the other.
 * MUSIC_NOD_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, PerspectiveCamera, Quaternion, Scene } from 'three';
import { UNITS_PER_M } from '../src/unbound/figure';
import { applyWorldCamera } from '../src/unbound/camera';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { HerOut } from '../src/unbound/her/out-page';
import { HerOutSenses } from '../src/unbound/her/out-senses';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { NO_MOTION_BLOCKS } from '../src/unbound/window-mode/window-face-rig';
import { loadLivelinessForEngine, loadMusicForEngine } from '../src/stage';
import { UnboundSenseBridge } from '../electron/unbound/sense-bridge';
import { StageStateHost } from '../electron/mood/her-state-host';
import { UNBOUND_SENSE_EVENTS } from '../shared/unbound/sense-relay';
import { geneFigure, max, TRACKED } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { LAPTOP, laptopView } from './helpers/unbound-peek';
import { surprises } from './helpers/unbound-window';
import { faceView } from './helpers/window-face-fixture';
import { beatSong, beatFold, type MusicFrame } from './helpers/window-music-run';

const REPORT = process.env.MUSIC_NOD_REPORT === '1';
const DEG = 180 / Math.PI;
const DIP = { width: LAPTOP.workArea.width / LAPTOP.scaleFactor, height: LAPTOP.workArea.height / LAPTOP.scaleFactor };
Object.assign(globalThis, { innerWidth: Math.round(DIP.width), innerHeight: Math.round(DIP.height) }); // HerOut reads the window's size, as the page does
const HOME = { xM: 0.3, depthM: 4 };

function laptopCamera(): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M, camera = new PerspectiveCamera(30, DIP.width / DIP.height, 0.05 * U, 400 * U);
  applyWorldCamera(camera, { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical',
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: HOME } as never, 0.05);
  return camera;
}

/** Full-screen, the music on at 1 s (her own choice; calm: a nod), she speaks from 9 to 11 s; `music: false`: the same frames without it. */
async function fullRun(fps: number, seconds: number, music: boolean) {
  const { fixture, figure } = await geneFigure({ xM: HOME.xM, depthM: HOME.depthM });
  const mesh = fixture.mesh;
  figure.faceToward({ x: 0, z: 0.55 });
  const idle = new UnboundIdleLayer(async h => createBundledIdle(h, await shippedIdle(), 7));
  idle.attach(figure, figure.heightM);
  await new Promise(resolve => setTimeout(resolve, 20));
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const world = new Scene(); world.add(mesh);
  let clockMs = 0;
  const her = new HerOut({} as HTMLElement, null, { camera: laptopCamera(), pixels: () => 0, canTouch: () => true, scene: world, home: () => HOME, now: () => clockMs }, random);
  her.attach(figure, measureWindowModel(mesh, null, true), { reviewed: true, url: 'gene' }, null);
  const lively = await loadLivelinessForEngine();
  her.face.loadLife(lively); her.sleep.load(lively);
  her.senses.music.load(await loadMusicForEngine());
  her.senses.music.setSettings({ alwaysDance: false, strength: 0.7 });
  const bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const head = figure.head!, upper = mesh.skeleton.bones.find(b => b.name === '上半身2')!;
  const frames: Quaternion[][] = [], shown: MusicFrame[] = [];
  const rel = new Quaternion(), euler = new Euler();
  let sample = 0, songStart = -1;
  try {
    for (let i = 0; i <= Math.round(fps * seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      clockMs = t * 1000;
      if (music && t >= 1) {
        if (songStart < 0) songStart = t;
        while (sample < Math.floor((t - songStart) * 30) + 1) { const s = beatSong(sample); her.senses.dance({ id: 'cap-system-audio', source: 'system-audio', revision: 1, sample: { ...s, time: 1 + sample / 30 } }); sample++; }
      }
      const view = faceView({ primary: 'calm', companion: null });
      (her as unknown as { view: unknown }).view = view; her.face.setMood(view); her.motions.setMood(view);
      const speaking = t >= 9 && t < 11;
      const faced = her.frame(dt, idle.wrap(figure), { shown: true, adjusting: false, voiced: speaking, speaking, walking: false, pulled: false, breath: 0.5, pointer: null });
      idle.frame(dt, idleWanted({ performing: faced.performing, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }), 1);
      figure.frame(dt);
      her.after(DIP.width, DIP.height);
      mesh.updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      rel.copy(upper.getWorldQuaternion(new Quaternion())).invert().multiply(head.getWorldQuaternion(new Quaternion()));
      euler.setFromQuaternion(rel, 'XYZ');
      const st = her.senses.music.getState();
      shown.push({ t, headPitch: euler.x * DEG, nodX: st.nod?.headX ?? 0, tier: st.tier, presence: her.senses.music.presence().music, tiltWeight: 0, nodShown: st.nod?.shown ?? 0, reason: her.senses.music.yieldReason });
    }
  } finally { her.dispose(); figure.dispose(); fixture.close(); }
  return { frames, shown, songStart };
}

for (const fps of [60, 30]) {
  test(`full-screen Gene, ${fps} fps: she chose to nod: her head goes down on the kicks, gives way to her speaking and comes back, told "nod" only while it shows; eased`, { timeout: 900_000 }, async () => {
    const quiet = await fullRun(fps, 14, false), r = await fullRun(fps, 14, true);
    const diff = r.shown.map((f, i) => ({ ...f, headPitch: f.headPitch - quiet.shown[i].headPitch }));
    const fold = beatFold(diff, f => f.headPitch, r.songStart, 5, 9);
    const span = (x: typeof r, from: number, to: number) => x.frames.slice(Math.max(0, Math.round(from * fps) - 2), Math.round(to * fps) + 1);
    const idle = max(surprises(span(quiet, 1, 14)).perFrame), nodding = max(surprises(span(r, 5, 9)).perFrame);
    const handOver = { enter: max(surprises(span(r, 1, 5)).perFrame), speak: max(surprises(span(r, 8.8, 13)).perFrame) };
    const told = (from: number, to: number) => [...new Set(r.shown.filter(f => f.t >= from && f.t < to).map(f => f.presence))];
    if (REPORT) console.log(JSON.stringify({ full: fps, beatLocked: fold, idle, nodding, handOver, told: { nodding: told(6, 9), speaking: told(9.8, 11), after: told(12.2, 14) } }));
    assert.equal(r.shown[Math.round(8 * fps)].tier, 'nod', 'calm: she chose to nod');
    assert.ok(fold.amp >= 2, `her head nods with the beat: ${fold.amp.toFixed(2)}°`);
    assert.ok(Math.abs(fold.peak) <= 0.07, `the chin is lowest on the kick (within one 33 ms bin) (${(fold.peak * 500).toFixed(0)} ms)`);
    assert.deepEqual(told(6, 9), ['nod']);
    assert.deepEqual(told(9.8, 11), ['still'], 'speaking: the nod gave way');
    assert.deepEqual(told(12.2, 14), ['nod'], 'and came back');
    const limit = Math.max(fps === 60 ? 0.3 : 0.9, idle * 1.5);
    assert.ok(nodding <= limit, `the nod itself: unexpected step ${nodding.toFixed(3)}° ≤ ${limit.toFixed(3)}° (idle ${idle.toFixed(3)}°)`);
    for (const [name, value] of Object.entries(handOver)) assert.ok(value <= Math.max(limit, nodding * 1.25), `${name}: unexpected step ${value.toFixed(3)}°`);
  });
}

test('full-screen page: the user\'s settings reach her music (strength 0: no nod, told "still"), and what her body does goes back as \'stage-state\'', async () => {
  const { fixture, figure } = await geneFigure({ xM: HOME.xM, depthM: HOME.depthM });
  const facts: [string, unknown][] = [], listeners: Record<string, (v: unknown) => void> = {};
  let now = 0;
  const api = { onDance: (cb: (v: unknown) => void) => { listeners.dance = cb; return () => {}; }, onMusicSettings: (cb: (v: unknown) => void) => { listeners.settings = cb; return () => {}; },
    herFact: async (kind: string, value: unknown) => { facts.push([kind, value]); return true; } };
  const senses = new HerOutSenses(api as never, () => ({ ok: true }) as never, { musicFace: () => ({ performPick: () => null, setTint: () => {} }) as never, hasSpeechFace: false }, () => {}, () => now);
  senses.music.load(await loadMusicForEngine());
  senses.attach(figure);
  const env = { shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false, feeding: false, hover: false, pinch: false, pulled: false,
    asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false, thinking: false, view: faceView({ primary: 'calm', companion: null }), blocks: NO_MOTION_BLOCKS,
    showing: false, reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false };
  let sample = 0;
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      now += 1000 / 60;
      while (sample < Math.floor(now / 1000 * 30)) { listeners.dance!({ id: 'cap-system-audio', source: 'system-audio', revision: 1, sample: { ...beatSong(sample), time: sample / 30 } }); sample++; }
      senses.frame(1 / 60, { env, view: env.view, walking: false, base: null, game: false, proxy: null, yawn: null, sleepCue: () => null, gates: null, fullBody: true, cover: () => {} });
    }
  };
  try {
    listeners.settings!({ alwaysDance: false, strength: 0.7 });
    run(8);
    const reports = () => facts.filter(([k]) => k === 'stage-state').map(([, v]) => (v as { music: string }).music);
    assert.equal(reports().at(-1), 'nod', `she nods and says so (${reports().join(',')})`);
    assert.ok(Math.abs(senses.music.getState().nod!.headX) > 0 || senses.music.getState().nod!.shown > 0.35);
    listeners.settings!({ strength: 0 }); // the user turns the strength down to 0
    run(3);
    assert.equal(reports().at(-1), 'still', 'strength 0: nothing moves, and she is told so');
    assert.ok(facts.every(([k]) => ['stage-state', 'music-tier', 'music-verdict', 'music-reaction'].includes(k)), 'only her music facts');
  } finally { senses.dispose(); figure.dispose(); fixture.close(); }
});

test('host: the settings go to the window she is shown in before its first music frame and on every change; her page\'s report is read while she is out', () => {
  type W = { id: string };
  const a: W = { id: 'a' }, b: W = { id: 'b' };
  let shownWin: W | null = a, settings: unknown = { strength: 0.4, alwaysDance: false };
  const sent: [string, string, unknown][] = [];
  const bridge = new UnboundSenseBridge<W>(() => ({ fact: () => true, poseSensing: () => false, musicSettings: () => settings }), { shown: () => shownWin, send: (w, ch, v) => sent.push([w.id, ch, v]) });
  bridge.relay('desk:audio-capture-state', { slots: { 'system-audio': { dance: true } } });
  const frame = { id: 'cap-system-audio', source: 'system-audio', revision: 1, sample: { time: 1, rms: 0.2, low: 0.2, mid: 0.2, high: 0.1 } };
  bridge.relay('unbound-relay:dance', frame); bridge.relay('unbound-relay:dance', { ...frame, sample: { ...frame.sample, time: 1.03 } });
  const S = UNBOUND_SENSE_EVENTS.musicSettings;
  assert.deepEqual(sent.map(([w, ch]) => `${w}:${ch}`), [`a:${S}`, `a:${UNBOUND_SENSE_EVENTS.dance}`, `a:${UNBOUND_SENSE_EVENTS.dance}`], 'the settings once, before the first frame');
  assert.deepEqual(sent[0]![2], { strength: 0.4, alwaysDance: false });
  sent.length = 0; shownWin = b;
  bridge.relay('unbound-relay:dance', frame);
  assert.equal(sent[0]![1], S, 'a window she is newly shown in gets them first too');
  sent.length = 0; settings = { strength: 0.9, alwaysDance: true };
  assert.equal(bridge.relay('desk:music-settings', settings), false, 'the companion windows still get the broadcast');
  assert.deepEqual(sent, [['b', S, { strength: 0.9, alwaysDance: true }]], 'a change goes to her at once');
  sent.length = 0; shownWin = null;
  bridge.relay('desk:music-settings', settings);
  assert.deepEqual(sent, [], 'no window she is shown in: nothing');
  assert.equal(bridge.takesFact(a, 'stage-state'), false, 'a report only from the window she is shown in');

  let out = false, clock = 1_000;
  const host = new StageStateHost(() => clock);
  host.followOut(() => out);
  const report = (instance: string, seq: number, music: string) => ({ instance, seq, music, always: false });
  assert.equal(host.accept(report('home-page-1', 1, 'still')), true);
  assert.equal(host.acceptOut(report('full-page-1', 1, 'nod')), true);
  assert.equal(host.current()?.music, 'still', 'at home: the companion window\'s');
  out = true;
  assert.equal(host.current()?.music, 'nod', 'out: her full-screen page\'s');
  out = false;
  assert.equal(host.accept(report('home-page-1', 2, 'nod')), true, 'neither source retired the other');
  assert.equal(host.current()?.music, 'nod');
  out = true; clock += 20_000;
  assert.equal(host.current(), null, 'a stale report says nothing');
});
