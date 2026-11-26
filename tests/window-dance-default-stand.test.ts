/**
 * 2026-11-26 (docs/claude/2026-11-26-window-dance.md). The owner, development build, small window, Gene, music playing, 和她一起听 on: the
 * journal said the tier was "dance" for minutes, she never danced. The window's music read "a picked head motion" as "the pose clip moves
 * her head" (blocks.head). Since 2026-11-21 the window plays her reviewed default stand when no pose is picked, and that stand moves her
 * head a little, so the dance and the nod yielded ('manual-head') for ever. Her motions' own rule (window-motions.ts) is "moves her head
 * AND is a picked pose or gesture"; the music now uses the same.
 *
 * The blocks here are made the way the stage makes them (faceBlocks + motionBlocks on the clips the figure plays), on the real Gene frame
 * loop (tests/helpers/window-music-run.ts) at 60 and 30 fps. WINDOW_DANCE_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { faceBlocks, motionBlocks, windowFaceRig, type MotionBlocks } from '../src/unbound/window-mode/window-face-rig';
import { musicEnvOf } from '../src/unbound/window-mode/window-own-life';
import { musicKeeps, musicYieldReason, musicYieldReasons, type WindowMusicEnv } from '../src/unbound/window-mode/window-music';
import { MUSIC_YIELD_KNOB_OF, MUSIC_YIELD_KNOBS, type MusicYieldReason } from '../src/unbound/window-mode/music-yield/knobs';
import { isChatGestureTrack } from '../src/stage';
import { StageModelProfile } from '../src/stage/model-profile';
import { beatFold, musicBaseEnv, windowMusicRun, type MusicCtx } from './helpers/window-music-run';
import { windowGene, surprises } from './helpers/unbound-window';
import { standClip } from './helpers/unbound-gene';
import { faceView } from './helpers/window-face-fixture';

const REPORT = process.env.WINDOW_DANCE_REPORT === '1';
const max = (values: readonly number[]) => values.reduce((a, b) => Math.max(a, b), 0);

/** The stage's blocks for Gene's stand: as her default (reviewedDefault, none picked) or as a pose the user picked. */
async function standBlocks(picked: boolean): Promise<MotionBlocks> {
  const g = await windowGene();
  try {
    const mesh = g.fixture.mesh, pose = await standClip(mesh);
    const rig = windowFaceRig(mesh, new StageModelProfile(mesh, { reviewed: true }), true, g.figure.head);
    const clips = { pose, gesture: null, expression: null };
    return motionBlocks(clips, !picked, faceBlocks(clips, false, mesh, rig?.slots.a ?? -1, g.figure.head?.name ?? null), isChatGestureTrack);
  } finally { g.close(); }
}

test('her default stand moves her head but is not a picked head motion: the dance does not yield to it; a picked pose that moves her head still holds it', async () => {
  const stand = await standBlocks(false), picked = await standBlocks(true);
  assert.equal(stand.head, true, 'the stand moves her head (what the music used to read as a picked head motion)');
  assert.equal(stand.manualPose, false, 'her default stand is not a picked pose');
  assert.equal(musicEnvOf(musicBaseEnv({ blocks: stand })).manualHead, false);
  assert.equal(musicYieldReason(musicEnvOf(musicBaseEnv({ blocks: stand })), true), null, 'nothing holds the dance back');
  assert.equal(musicYieldReason(musicEnvOf(musicBaseEnv({ blocks: picked })), true), 'manual-head', 'a picked pose that moves her head: as before');
});

const S = { on: 1, end: 12 } as const;
for (const fps of [60, 30]) {
  test(`Gene window, ${fps} fps, her default stand playing: "一直跟着跳" makes her body dance, the calm choice makes her nod; the entry is eased`, { timeout: 900_000 }, async () => {
    const blocks = await standBlocks(false);
    // 一直跟着跳 turned on after the settings came (her choice exists, as in the app), or her own calm choice.
    const scene = (always: boolean) => (t: number, c: MusicCtx) => { if (t === 0 && always) c.own.music.setSettings({ alwaysDance: true }); c.env = { ...c.env, blocks };
      if (t >= S.on && !c.hearing) { c.hearing = true; c.own.music.setEnabled(true); }
    };
    const quiet = await windowMusicRun(fps, S.end, (_t, c) => { c.env = { ...c.env, blocks }; }, { settings: { alwaysDance: false, strength: 0.7 } });
    const dance = await windowMusicRun(fps, S.end, scene(true), { settings: { alwaysDance: false, strength: 0.7 } });
    const nod = await windowMusicRun(fps, S.end, scene(false), { view: faceView({ primary: 'calm', companion: null }), settings: { alwaysDance: false, strength: 0.7 } });
    // What the music adds to her body: the largest angle of any tracked bone against the same frames without music (°).
    const added = (r: typeof dance, from: number) => max(r.frames.slice(Math.round(from * fps)).map((f, i) => max(f.map((q, b) => q.angleTo(quiet.frames[Math.round(from * fps) + i][b]) * 180 / Math.PI))));
    const after = (r: typeof dance, from: number) => r.shown.filter(f => f.t >= from);
    const idle = +max(surprises(quiet.frames.slice(Math.round(1 * fps))).perFrame).toFixed(3);
    const enter = +max(surprises(dance.frames.slice(Math.round((S.on - 0.1) * fps), Math.round((S.on + 4) * fps))).perFrame).toFixed(3);
    const rows = { danceAdded: +added(dance, 4).toFixed(2), nodBeat: +beatFold(nod.shown.map((f, i) => ({ ...f, headPitch: f.headPitch - quiet.shown[i].headPitch })), f => f.headPitch, nod.songStart, 5, S.end).amp.toFixed(2),
      nodShown: +Math.min(...after(nod, 6).map(f => f.nodShown)).toFixed(2), reasons: [...new Set(after(dance, 4).map(f => f.reason))],
      told: [...new Set(after(dance, 6).map(f => f.presence))], nodTold: [...new Set(after(nod, 6).map(f => f.presence))], tier: dance.shown.at(-1)!.tier, nodTier: nod.shown.at(-1)!.tier, idle, enter };
    if (REPORT) console.log(JSON.stringify({ fps, ...rows }));
    assert.equal(rows.tier, 'dance'); assert.equal(rows.nodTier, 'nod');
    assert.deepEqual(rows.reasons, [null], 'nothing holds the dance back');
    assert.ok(rows.danceAdded >= 2, `the dance moves her body: ${rows.danceAdded}° against the same frames without music`);
    assert.deepEqual(rows.told, ['dance'], 'she is told she dances, and she does');
    assert.ok(rows.nodBeat >= 2, `her head nods on the beat: ${rows.nodBeat}° against the same frames without music`);
    assert.ok(rows.nodShown >= 0.35, `the nod is on her body (${rows.nodShown} of it)`);
    assert.deepEqual(rows.nodTold, ['nod']);
    // R29: the dance comes in by its own fade (the unexpected step of her bones within her own idle's, with room for the dance's own beat).
    assert.ok(enter <= Math.max(fps === 60 ? 0.3 : 0.9, idle * 1.5), `entry: unexpected step ${enter}° (idle ${idle}°)`);
  });
}

// ---- the I-227 seam (music-yield/knobs.ts): today's numbers are today's behaviour -------------------------------------------------
test('I-227 seam: with today\'s knobs every owner takes all of the dance and the nod (as before); a knob of 1 would keep it; several owners: the least', () => {
  const env = (over: Partial<WindowMusicEnv>): WindowMusicEnv => ({ view: null, shown: true, speaking: false, adjusting: false, behaviorBlocked: false, touched: false, manualHead: false, asleep: false, ...over });
  const cases: Record<MusicYieldReason, Partial<WindowMusicEnv>> = { speech: { speaking: true }, camera: { adjusting: true }, 'window-or-input': { behaviorBlocked: true },
    'direct-interaction': { touched: true }, walking: { walking: true }, 'manual-head': { manualHead: true }, asleep: { asleep: true } };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(MUSIC_YIELD_KNOB_OF).sort(), 'every reason has a knob');
  assert.deepEqual([...new Set(Object.values(MUSIC_YIELD_KNOB_OF))].sort(), Object.keys(MUSIC_YIELD_KNOBS).sort(), 'and every knob a reason');
  for (const [reason, over] of Object.entries(cases) as [MusicYieldReason, Partial<WindowMusicEnv>][]) {
    assert.equal(musicYieldReason(env(over), true), reason);
    assert.deepEqual(musicYieldReasons(env(over)), [reason]);
    assert.deepEqual(musicKeeps([reason]), { dance: 0, nod: 0 }, `${reason}: nothing stays today`);
  }
  assert.deepEqual(musicKeeps([]), { dance: 1, nod: 1 }, 'no owner: all of it');
  const hoverKeeps = { ...MUSIC_YIELD_KNOBS, directInteraction: { dance: 1, nod: 1 }, speech: { dance: 1, nod: 0.5 } };
  assert.deepEqual(musicKeeps(['direct-interaction'], hoverKeeps), { dance: 1, nod: 1 });
  assert.deepEqual(musicKeeps(['speech'], hoverKeeps), { dance: 1, nod: 0 }, 'a share below 1 yields as before (partial shares are I-227 work)');
  assert.deepEqual(musicKeeps(['direct-interaction', 'manual-head'], hoverKeeps), { dance: 0, nod: 0 }, 'the least of the owners');
  assert.deepEqual(musicYieldReasons(env({ speaking: true, touched: true, asleep: true })), ['speech', 'direct-interaction', 'asleep'], 'in musicYieldReason\'s order');
});
