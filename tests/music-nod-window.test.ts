/**
 * 2026-11-24 (docs/claude/2026-11-24-music-nod-window.md).
 * She chose to nod and was told "你正跟着点头", but her body did not nod: the nod (about 1°, on a loop that did not follow the kicks) rode
 * procedural life's spring goals on the window engine's livelier idle, and was gone whenever procedural life gave way.
 *
 * On the real Gene frame loop of the companion window (tests/helpers/window-music-run.ts: WindowOwnLife, WindowMotions, WindowLiveliness), at
 * 60 and 30 fps: her head goes down on the kicks when she chose to nod (procedural life on or off), does nothing when she chose to stay still,
 * follows the strength; what she is told her body does is what shows (a yield to speech or a pat says "still"); every hand-over is eased
 * (R29c unexpected step against her own idle). Pure parts: the nod's beat (music-nod-beat.ts) and the told state (music-presence.ts).
 * MUSIC_NOD_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NodBeat, NOD_BEAT, followerLagCycles } from '../src/stage/music-nod-beat';
import { musicPresence, MUSIC_SHOWN_MIN } from '../src/stage/music-presence';
import { faceView } from './helpers/window-face-fixture';
import { BEAT_PERIOD_S, beatFold, windowMusicRun, type MusicCtx, type MusicFrame } from './helpers/window-music-run';
import { surprises } from './helpers/unbound-window';

const REPORT = process.env.MUSIC_NOD_REPORT === '1';
const max = (values: readonly number[]) => values.reduce((a, b) => Math.max(a, b), 0);

// ---- the nod's beat (pure) -------------------------------------------------------------------------------------------------------
test('the nod\'s beat: locks onto kicks every 0.5 s within a few kicks, its lowest point on the kick, no jump of its phase', () => {
  const beat = new NodBeat(), dt = 1 / 60;
  let t = 0, nextKick = 0.3, worstStep = 0, last = -1;
  const dips: { t: number; dip: number }[] = [];
  while (t < 8) {
    beat.advance(dt); t += dt;
    if (t >= nextKick - 1e-9) { beat.kick(); nextKick += 0.5; }
    const s = beat.getState();
    // While any of it shows (before that, the first kick may set the phase: nothing is on screen).
    if (last >= 0 && beat.share > 0) { const step = ((s.phase - last) % 1 + 1) % 1; worstStep = Math.max(worstStep, Math.abs(step - dt / s.nodPeriod)); }
    last = s.phase;
    dips.push({ t, dip: beat.dip() });
  }
  const s = beat.getState();
  assert.ok(Math.abs(s.period - 0.5) < 0.01, `the beat period (${s.period})`);
  assert.ok(s.lock > 0.8 && beat.share > 0.95, `locked (${s.lock}, share ${beat.share})`);
  assert.ok(worstStep <= NOD_BEAT.slew / 60 + 1e-9, `the phase never jumps: a correction is spread (${worstStep})`);
  // After the lock: the lowest point (dip 1) within a frame of each kick.
  const late = dips.filter(d => d.t > 4);
  for (const d of late) if (d.dip > 0.999) { const off = ((d.t - 0.3) / 0.5) % 1; assert.ok(Math.min(off, 1 - off) * 0.5 < 0.03, `dip at ${d.t.toFixed(3)} s is on a kick`); }
});

test('the nod\'s beat: shows nothing before two kicks agreed, holds the beat through a gap, ignores an off-beat kick, follows a new tempo', () => {
  const beat = new NodBeat(), dt = 1 / 60;
  const run = (seconds: number, kicks: (t: number) => boolean) => { for (let i = 0; i < seconds * 60; i++) { beat.advance(dt); if (kicks(i)) beat.kick(); } };
  run(0.5, i => i === 0);
  assert.equal(beat.share, 0, 'one kick: no nod yet');
  run(4, i => i % 30 === 0);
  const locked = beat.share;
  assert.ok(locked > 0.9);
  run(3, () => false);
  assert.ok(beat.share > 0.6, `a 3 s passage without kicks: she keeps the beat (${beat.share.toFixed(2)})`);
  const before = beat.getState().period;
  beat.advance(0.25); beat.kick(); // off the beat by half
  assert.ok(Math.abs(beat.getState().period - before) < 1e-9, 'an off-beat kick is not a tempo');
  run(6, i => i % 24 === 0); // 150 BPM: 0.4 s
  assert.ok(Math.abs(beat.getState().period - 0.4) < 0.02, `a new tempo is taken (${beat.getState().period})`);
  assert.ok(followerLagCycles(20, 0.5) > 0.15 && followerLagCycles(20, 0.5) < 0.2, 'the follower lag at 120 BPM (about 89 ms)');
});

// ---- what she is told (pure) ------------------------------------------------------------------------------------------------------
test('what she is told: "nod" and "dance" only while that much of it is on her body; otherwise "still"', () => {
  const choice = (tier: 'none' | 'nod' | 'dance', always = false) => ({ isAlways: always, tier, getState: () => ({ audible: true }) as never });
  const base = { hearing: true, danceOn: false, sinceLoudS: 0.1, music: true, beat: 0.8 };
  assert.equal(musicPresence({ ...base, choice: choice('nod') }).music, 'nod', 'without the shown shares: the tier (as before)');
  assert.equal(musicPresence({ ...base, choice: choice('nod'), shown: { nod: 0, dance: 0 } }).music, 'still', 'chose to nod, nothing on her body: still');
  assert.equal(musicPresence({ ...base, choice: choice('nod'), shown: { nod: MUSIC_SHOWN_MIN - 0.01, dance: 0 } }).music, 'still');
  assert.equal(musicPresence({ ...base, choice: choice('nod'), shown: { nod: 0.9, dance: 0 } }).music, 'nod');
  assert.equal(musicPresence({ ...base, choice: choice('dance'), danceOn: true, shown: { nod: 0.9, dance: 0.1 } }).music, 'still', 'a dance that does not show is not told');
  assert.equal(musicPresence({ ...base, choice: choice('dance', true), danceOn: true, shown: { nod: 0, dance: 0.8 } }).music, 'dance');
  assert.equal(musicPresence({ ...base, choice: choice('none'), shown: { nod: 0.9, dance: 0.9 } }).music, 'still', 'still stays still');
  assert.equal(musicPresence({ ...base, hearing: false, choice: choice('nod'), shown: { nod: 0, dance: 0 } }).music, 'off');
});

// ---- the real Gene frame loop of the companion window ------------------------------------------------------------------------------
/** The scene (s): her idle; the switch on; nodding; she speaks; nodding; a pat; nodding; the switch off; her idle. */
const S = { on: 1, speak: 9, speakOff: 11, pat: 13, patOff: 14, off: 17, end: 20 } as const;
function scene(over: { life?: boolean } = {}): (t: number, c: MusicCtx) => void {
  const done = new Set<string>();
  const at = (key: keyof typeof S, t: number) => t >= S[key] && !done.has(key) && !!done.add(key);
  return (t, c) => {
    if (over.life === false) c.life = false;
    if (at('on', t)) { c.hearing = true; c.own.music.setEnabled(true); }
    if (at('speak', t)) c.env = { ...c.env, speaking: true };
    if (at('speakOff', t)) c.env = { ...c.env, speaking: false };
    if (at('pat', t)) c.env = { ...c.env, pat: true };
    if (at('patOff', t)) c.env = { ...c.env, pat: false };
    if (at('off', t)) { c.hearing = false; c.own.music.setEnabled(false); }
  };
}
const calm = () => faceView({ primary: 'calm', companion: null });
const sad = () => faceView({ primary: 'sad', companion: null });
const told = (shown: readonly MusicFrame[], from: number, to: number) => [...new Set(shown.filter(f => f.t >= from && f.t < to).map(f => f.presence))];

for (const fps of [60, 30]) {
  test(`Gene window, ${fps} fps: she chose to nod: her head goes down on the kicks (procedural life on or off), she is told "nod" only while it shows, every hand-over eased`, { timeout: 900_000 }, async () => {
    const settings = { alwaysDance: false, strength: 0.7 };
    // The same frames without the music (the loop is deterministic): what the music adds to her head is the difference.
    const quiet = await windowMusicRun(fps, S.end, () => {}, { view: calm(), settings });
    const quietOff = await windowMusicRun(fps, S.end, (_t, c) => { c.life = false; }, { view: calm(), settings });
    const r = await windowMusicRun(fps, S.end, scene(), { view: calm(), settings });
    const off = await windowMusicRun(fps, S.end, scene({ life: false }), { view: calm(), settings });
    const t0 = r.songStart;
    const head = (x: { shown: MusicFrame[] }, base: { shown: MusicFrame[] }, from: number, to: number) =>
      beatFold(x.shown.map((f, i) => ({ ...f, headPitch: f.headPitch - base.shown[i].headPitch })), f => f.headPitch, t0, from, to);
    const nod = beatFold(r.shown, f => f.nodX * 180 / Math.PI, t0, 5, S.speak);
    const rows = { nod: head(r, quiet, 5, S.speak), lifeOff: head(off, quietOff, 5, S.speak), nodOffset: nod };
    // Her own idle and every hand-over (the scene's spans), R29c unexpected step of the tracked bones.
    const span = (from: number, to: number) => r.frames.slice(Math.max(0, Math.round(from * fps) - 2), Math.round(to * fps) + 1);
    const surprise = (from: number, to: number) => +max(surprises(span(from, to)).perFrame).toFixed(3);
    const idle = +max(surprises(quiet.frames.slice(Math.round(1 * fps))).perFrame).toFixed(3);
    const steps = { idle, enter: surprise(S.on, S.on + 4), nodding: surprise(5, S.speak), speak: surprise(S.speak - 0.2, S.speakOff + 2), pat: surprise(S.pat - 0.2, S.patOff + 2),
      off: surprise(S.off - 0.2, S.end) };
    if (REPORT) console.log(JSON.stringify({ fps, rows, steps, told: { nodding: told(r.shown, 6, S.speak), speaking: told(r.shown, S.speak + 0.8, S.speakOff), pat: told(r.shown, S.pat + 0.8, S.patOff) } }));
    assert.equal(r.shown[Math.round(8 * fps)].tier, 'nod', 'calm: she chose to nod');
    // The nod is on her head, on the kicks: the beat-locked part of her head pitch, well over her idle's own.
    assert.ok(rows.nod.amp >= 2, `her head nods with the beat: ${rows.nod.amp.toFixed(2)}° against the same frames without music`);
    assert.ok(rows.lifeOff.amp >= 2, `with procedural life off too: ${rows.lifeOff.amp.toFixed(2)}°`);
    for (const [name, peak] of [['the nod', nod.peak], ['her head', rows.nod.peak]] as const)
      assert.ok(Math.abs(peak) <= 0.07, `${name}: the chin is lowest on the kick (within one 33 ms bin) (${(peak * BEAT_PERIOD_S * 1000).toFixed(0)} ms from it)`);
    // What she is told is what shows.
    assert.deepEqual(told(r.shown, 6, S.speak), ['nod'], 'nodding: told "nod"');
    assert.deepEqual(told(r.shown, S.speak + 0.8, S.speakOff), ['still'], 'speaking: the nod gave way, told "still"');
    assert.deepEqual(told(r.shown, S.pat + 0.8, S.patOff), ['still'], 'a pat: the nod gave way, told "still"');
    assert.deepEqual(told(r.shown, S.speakOff + 1.2, S.pat), ['nod'], 'and back');
    assert.deepEqual(told(r.shown, S.patOff + 1.2, S.off), ['nod'], 'and back after the pat');
    for (const f of r.shown) if (f.presence === 'nod') assert.ok(f.nodShown >= 0.35, `told "nod" at ${f.t.toFixed(2)} s with ${f.nodShown.toFixed(2)} of it shown`);
    assert.equal(r.shown.at(-1)!.nodX, 0, 'the switch off: the nod eased out to exactly nothing');
    // R29: no hand-over is a jump (within her own idle, with room for the nod's own beat).
    const limit = Math.max(fps === 60 ? 0.3 : 0.9, idle * 1.5, steps.nodding * 1.25);
    for (const name of ['enter', 'speak', 'pat', 'off'] as const)
      assert.ok(steps[name] <= limit, `${name}: unexpected step ${steps[name]}° ≤ ${limit.toFixed(3)}° (idle ${idle}°, nodding ${steps.nodding}°)`);
    assert.ok(steps.nodding <= Math.max(fps === 60 ? 0.3 : 0.9, idle * 1.5), `the nod itself is smooth: ${steps.nodding}° (idle ${idle}°)`);
  });

  test(`Gene window, ${fps} fps: she chose to stay still: nothing of the nod, told "still"; the strength follows the setting (0: no nod, told "still")`, { timeout: 900_000 }, async () => {
    const still = await windowMusicRun(fps, 10, scene(), { view: sad(), settings: { alwaysDance: false, strength: 0.7 } });
    const quiet = await windowMusicRun(fps, 10, () => {}, { view: sad(), settings: { alwaysDance: false, strength: 0.7 } });
    assert.equal(still.shown[Math.round(8 * fps)].tier, 'none', 'sad: she chose to stay still');
    assert.equal(max(still.shown.map(f => Math.abs(f.nodX))), 0, 'no nod at all');
    assert.deepEqual(told(still.shown, 4, 10), ['still']);
    // Only the song's first "听一下" look (R18) differs from the same frames without music; nothing goes with the beat.
    const beatLocked = beatFold(still.shown.map((f, i) => ({ ...f, headPitch: f.headPitch - quiet.shown[i].headPitch })), f => f.headPitch, still.songStart, 5, 10).amp;
    if (REPORT) console.log(JSON.stringify({ fps, stillBeatLocked: beatLocked }));
    assert.ok(beatLocked < 1.5, `nothing of her head goes with the beat (${beatLocked.toFixed(2)}°)`);
    const zero = await windowMusicRun(fps, 10, scene(), { view: calm(), settings: { alwaysDance: false, strength: 0 } });
    assert.equal(zero.shown[Math.round(8 * fps)].tier, 'nod', 'strength 0: she still chose to nod');
    assert.equal(max(zero.shown.map(f => Math.abs(f.nodX))), 0, 'but nothing moves');
    assert.deepEqual(told(zero.shown, 4, 10), ['still'], 'and she is told so');
    const low = await windowMusicRun(fps, 10, scene(), { view: calm(), settings: { alwaysDance: false, strength: 0.35 } });
    const full = await windowMusicRun(fps, 10, scene(), { view: calm(), settings: { alwaysDance: false, strength: 1 } });
    const a = (x: typeof low) => beatFold(x.shown, f => f.nodX * 180 / Math.PI, x.songStart, 5, 10).amp;
    if (REPORT) console.log(JSON.stringify({ fps, strength: { low: a(low), full: a(full) } }));
    assert.ok(a(full) > a(low) * 2.4 && a(full) < a(low) * 3.4, `the nod follows the strength (0.35: ${a(low).toFixed(2)}°, 1: ${a(full).toFixed(2)}°)`);
  });
}
