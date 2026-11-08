/**
 * R18 小问题 (U-009). With M1 the audio switch only means "she may
 * hear it"; a calm her nods a couple of degrees and a low one does nothing, and "hearing" was the capture being on, not
 * music actually playing. Now (docs/claude/2026-11-03-e1-r18-fixes.md):
 *  - "she heard it" was sound in the capture (not just the capture running); since I-016 (docs/claude/2026-11-03-listen-kind.md)
 *    it is sound the fast layer recognizes as music (music-likeness.ts), so talk never makes her look up; each song is a new song;
 *  - every mood shows she heard it: a short listening look (head up and tilted) at the song's start, then her own choice;
 *    not asleep, not with 自动表现 paused, never in "让她一直跟着跳" (R15 unchanged);
 *  - the developer line says 听到了 / 没听到 / 听到声音但不是音乐 / 听到了但不想跳.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_AUDIBLE_RMS, MUSIC_NEW_SONG_GAP_S, MusicChoice, type MusicChoiceContext } from '../src/stage/music-choice';
import { MUSIC_LISTEN, MusicListenCue } from '../src/stage/music-listen';
import { between, geneStage, surprises, type GeneStage } from './helpers/gene-stage-harness';

const DT = 1 / 60, DEG = 180 / Math.PI;
/** The harness's songSample is recognized as music this long after the capture starts (tests/listen-kind-stage.test.ts measures it). */
const RECOGNIZE_S = 2.5;
const context = (patch: Partial<MusicChoiceContext> = {}): MusicChoiceContext => ({ playfulWeight: 1, cautiousWeight: 1, playfulIntensity: 50, mood: 'calm',
  fatigue: { phase: 'awake', F: 0, sleeping: false }, activity: null, scope: 'gene|t', request: null, nowMs: 0, expressive: true, ...patch });
/**
 * Runs a choice for `seconds` with this level per sample (30 Hz) and returns the cues it asked for. `music` is the fast layer's
 * verdict (I-016); by default loud sound is music here.
 */
function run(choice: MusicChoice, seconds: number, rms: number, patch: Partial<MusicChoiceContext> = {}, music = rms > 0): number {
  let cues = 0;
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    if (i % 2 === 0) choice.noteLevel(rms);
    choice.noteMusic(music);
    choice.frame(DT, context(patch));
    if (choice.takeListenCue()) cues++;
  }
  return cues;
}

test('heard = a song recognized as music, not just sound; each song asks once for the listening look', () => {
  const choice = new MusicChoice(undefined, () => 0.5);
  choice.setHearing(true);
  assert.equal(run(choice, 2, 0), 0, 'the capture on, silence: nothing heard');
  assert.equal(choice.getState().audible, false);
  assert.match(choice.getState().line, /没听到声音/);
  assert.equal(run(choice, 8, 0.2, {}, false), 0, 'talk (loud, not music): no look, nothing judged');
  assert.equal(choice.getState().audible, false); assert.equal(choice.getState().sound, true); assert.equal(choice.getState().judgements, 0);
  assert.match(choice.getState().line, /听到声音，还没认出是音乐/);
  assert.equal(run(choice, 1, 0.2), 1, 'music: she heard it, once');
  assert.equal(choice.getState().audible, true);
  assert.equal(run(choice, 4, 0.2), 0, 'the same song: no second look');
  assert.equal(run(choice, MUSIC_NEW_SONG_GAP_S - 1, 0) + run(choice, 1, 0.2), 0, 'a short pause is the same song');
  assert.equal(run(choice, MUSIC_NEW_SONG_GAP_S - 1, 0.2, {}, false) + run(choice, 1, 0.2), 0, 'a short stretch that is not music is the same song too');
  assert.equal(run(choice, MUSIC_NEW_SONG_GAP_S + 0.5, 0), 0); assert.equal(choice.getState().audible, false, 'a long silence: the song is over');
  assert.equal(run(choice, 1, 0.2), 1, 'the next song: she listens again');
  assert.equal(choice.getState().judgements >= 1 && choice.getState().heardSeconds < 1.5, true, 'judged as a new song from when it became audible');
  assert.ok(MUSIC_AUDIBLE_RMS > 0.003 && MUSIC_AUDIBLE_RMS < 0.02);
});

test('I-016: dialogue after a song ends the song: what she decided ends with it, and nothing is judged on the dialogue', () => {
  let judged = 0;
  const choice = new MusicChoice(input => { judged++; return { score: 0.9, tier: 'dance', parts: [], reason: '想跳 0.90 · 跳起来 · 测试', asleep: false }; }, () => 0.5);
  choice.setHearing(true);
  run(choice, 6, 0.2, { mood: 'happy' });
  assert.equal(choice.tier, 'dance');
  const before = judged;
  run(choice, MUSIC_NEW_SONG_GAP_S + 0.2, 0.2, { mood: 'happy' }, false);
  assert.equal(choice.tier, 'none', 'the song is over: she goes back to herself');
  assert.equal(choice.getState().audible, false);
  run(choice, 30, 0.2, { mood: 'happy' }, false);
  assert.equal(judged, before, 'the dialogue is never judged');
  assert.equal(choice.rejudgeNow(), false, 'nothing to judge without a song');
});

test('every mood gets the look (sad too); asleep, 自动表现 paused and "一直跟着跳" do not', () => {
  for (const mood of ['sad', 'disappointed', 'calm', 'happy']) {
    const choice = new MusicChoice(undefined, () => 0.5); choice.setHearing(true);
    assert.equal(run(choice, 1.5, 0.2, { mood }), 1, mood);
  }
  const asleep = new MusicChoice(undefined, () => 0.5); asleep.setHearing(true);
  assert.equal(run(asleep, 1.5, 0.2, { fatigue: { phase: 'asleep', F: 1, sleeping: true } }), 0, 'asleep');
  const paused = new MusicChoice(undefined, () => 0.5); paused.setHearing(true);
  assert.equal(run(paused, 1.5, 0.2, { expressive: false }), 0, '自动表现 paused');
  const always = new MusicChoice(undefined, () => 0.5); always.setAlways(true); always.setHearing(true);
  assert.equal(run(always, 1.5, 0.2), 0, 'R15 fallback: nothing added');
});

test('developer line: 没听到 / 听到了 / 听到了，但不想跳', () => {
  const off = new MusicChoice(undefined, () => 0.5);
  assert.match(off.getState().line, /没听到/);
  const sad = new MusicChoice(undefined, () => 0.5); sad.setHearing(true); run(sad, 1.5, 0.2, { mood: 'sad' });
  assert.match(sad.getState().line, /^听到了，但不想跳 · 想跳 0\.\d\d · 不动/);
  const calm = new MusicChoice(undefined, () => 0.5); calm.setHearing(true); run(calm, 1.5, 0.2, { mood: 'calm' });
  assert.match(calm.getState().line, /^听到了 · 想跳 0\.\d\d · 点头晃一晃/);
  const quiet = new MusicChoice(undefined, () => 0.5); quiet.setHearing(true); run(quiet, 1, 0);
  assert.match(quiet.getState().line, /^想跳：没听到声音/);
  const talk = new MusicChoice(undefined, () => 0.5); talk.setHearing(true); run(talk, 2, 0.2, {}, false);
  assert.match(talk.getState().line, /^想跳：听到声音，还没认出是音乐/);
});

test('the listening look: chin up and a tilt, smoothstep in and out, exactly zero after', () => {
  const cue = new MusicListenCue();
  assert.equal(cue.frame(DT), null, 'nothing before a song');
  cue.start(1);
  const rows: { headX: number; headZ: number }[] = [];
  for (let frame: ReturnType<MusicListenCue['frame']>; (frame = cue.frame(DT));) rows.push({ ...frame });
  const total = MUSIC_LISTEN.riseS + MUSIC_LISTEN.holdS + MUSIC_LISTEN.fallS;
  assert.ok(Math.abs(rows.length * DT - total) < 2 * DT);
  assert.ok(Math.min(...rows.map(row => row.headX)) <= MUSIC_LISTEN.headX + 1e-9 && Math.max(...rows.map(row => row.headZ)) >= MUSIC_LISTEN.headZ - 1e-9);
  assert.equal(rows.at(-1)!.headX, 0); assert.equal(rows.at(-1)!.headZ, 0);
  const speeds = rows.slice(1).map((row, i) => row.headZ - rows[i].headZ), peak = Math.max(...speeds.map(Math.abs));
  const accel = Math.max(...speeds.slice(1).map((speed, i) => Math.abs(speed - speeds[i])));
  assert.ok(Math.abs(speeds[0]) < peak * 0.25 && Math.abs(speeds.at(-1)!) < peak * 0.25, 'starts and stops from (nearly) rest');
  assert.ok(accel <= peak * 0.3, `speed changes smoothly (${accel} vs peak ${peak} per frame)`);
  assert.equal(cue.frame(DT), null);
});

// ---------------------------------------------------------------- the real Stage loop (Gene)

const HEAD = 4;
async function heard(primary: string, withMusic: boolean, seconds = 6 + RECOGNIZE_S) {
  const h = await geneStage({ music: false, primary, extraBones: [] });
  try {
    h.stage.setMusicSettings({ alwaysDance: false });
    h.run(2);
    if (withMusic) h.stage.setMusicEnabled(true);
    h.run(seconds);
    return { h, frames: h.shown, line: (h.stage.setMood({ ...h.stage.moodView, developerMode: true }), h.stage.getMusicChoiceLine()) as string,
      data: JSON.parse(h.stage.renderer.domElement.dataset.musicDance ?? 'null') };
  } finally { h.close(); }
}
const deviation = (a: { frames: GeneStage['shown'] }, b: { frames: GeneStage['shown'] }) => a.frames.map((frame, i) => frame.world[HEAD].angleTo(b.frames[i].world[HEAD]) * DEG);

test('Gene, sad: she does not dance, but she visibly listens when the music starts (before: nothing at all)', async () => {
  const quiet = await heard('sad', false), music = await heard('sad', true);
  // I-016: the look comes when the song is recognized as music (the harness catches up on the samples it owes after a late
  // start, so in display time that is a little sooner than RECOGNIZE_S), not on the first sound.
  const off = deviation(music, quiet), start = off.findIndex((value, i) => i >= 2 * 60 && value > 0.05);
  assert.ok(start >= Math.round(3 * 60) && start <= Math.round((2 + RECOGNIZE_S + 0.5) * 60), `the look starts when the music is recognized (${(start / 60).toFixed(2)} s)`);
  const look = Math.max(...off.slice(start, start + Math.round(2.4 * 60)));
  if (process.env.R29_REPORT) console.log(`sad listen: head ${look.toFixed(2)} deg; after ${Math.max(...off.slice(start + 3 * 60)).toFixed(3)}`);
  assert.ok(look > 1.5, `a head movement you can see (${look.toFixed(2)} deg)`);
  assert.ok(Math.max(...off.slice(start + 3 * 60)) < 0.05, 'then still, as she chose');
  assert.equal(music.data.choice.tier, 'none'); assert.equal(music.data.choice.audible, true);
  assert.match(music.line, /^听到了，但不想跳/);
  const entry = Math.max(...surprises(between(music.frames, 2 - 2 / 60, 4.5 + RECOGNIZE_S))[HEAD]);
  assert.ok(entry <= 0.15, `the look comes and goes without a jump (${entry.toFixed(3)} deg)`);
  assert.equal(music.frames.at(-1)!.guardJumps - music.frames[0].guardJumps, 0);
});

test('Gene, calm: the listening look, then the light nod; "一直跟着跳" is still exactly R15 (no look added)', async () => {
  const quiet = await heard('calm', false), music = await heard('calm', true);
  const off = deviation(music, quiet), start = Math.round(3 * 60);
  assert.ok(Math.max(...off.slice(start, start + 2.5 * 60)) > 1.5, 'she listens first');
  assert.equal(music.data.choice.tier, 'nod'); assert.match(music.line, /^听到了 · 想跳 0\.\d\d · 点头晃一晃/);
  assert.ok(music.data.listen.cues === 1, JSON.stringify(music.data.listen));
});

// ---------------------------------------------------------------- Codex T-112 round-019

test('律动强度 sizes the listening look like the nod: 0 is no look at all, the default is the look as designed', () => {
  const peak = (strength: number | undefined) => {
    const cue = new MusicListenCue(); cue.start(1);
    let x = 0, z = 0;
    for (let frame: ReturnType<MusicListenCue['frame']>; (frame = strength === undefined ? cue.frame(DT) : cue.frame(DT, strength));) { x = Math.min(x, frame.headX); z = Math.max(z, frame.headZ); }
    return { x, z };
  };
  assert.deepEqual(peak(0), { x: 0, z: 0 }, 'strength 0: exactly still (it kept a fixed 0.035/0.045 rad)');
  const designed = peak(0.7), unset = peak(undefined), full = peak(1);
  assert.ok(Math.abs(designed.x - MUSIC_LISTEN.headX) < 1e-6 && Math.abs(designed.z - MUSIC_LISTEN.headZ) < 1e-6, 'the default strength shows the designed look');
  assert.deepEqual(unset, designed);
  assert.ok(Math.abs(full.z / designed.z - 1 / 0.7) < 1e-6, 'and scales with the strength');
});

test('Gene, sad, 律动强度 0: no listening look on the real stage (before: the head still moved 3.3°)', async () => {
  const run = async (withMusic: boolean) => {
    const h = await geneStage({ music: false, primary: 'sad', extraBones: [] });
    try { h.stage.setMusicSettings({ alwaysDance: false, strength: 0 }); h.run(2); if (withMusic) h.stage.setMusicEnabled(true); h.run(5); return { frames: h.shown }; } finally { h.close(); }
  };
  const quiet = await run(false), music = await run(true);
  const off = Math.max(...deviation(music, quiet));
  assert.ok(off < 1e-3, `head off the no-music run by ${off.toFixed(4)}°`);
});

test('I-016 (was R18 "0.3 s of sound"): loudness alone never makes a song; music does, on the very frame it is recognized', () => {
  // Samples every 1/30 s, as the capture sends them: `pattern` says per sample whether it is loud; `music` the fast layer's verdict.
  const audibleAfter = (pattern: (i: number) => boolean, music: (i: number) => boolean, seconds = 6) => {
    const choice = new MusicChoice(undefined, () => 0.5); choice.setHearing(true);
    for (let i = 0, n = Math.round(seconds * 30); i < n; i++) {
      choice.noteLevel(pattern(i) ? 0.2 : 0); choice.noteMusic(music(i));
      choice.frame(1 / 60, context()); choice.frame(1 / 60, context());
      if (choice.getState().audible) return (i + 1) / 30;
    }
    return null;
  };
  assert.equal(audibleAfter(() => true, () => false), null, 'steady loud sound that is not music');
  assert.equal(audibleAfter(i => i % 6 === 0, () => false), null, 'one loud sample every 200 ms');
  assert.equal(audibleAfter(i => i % 30 < 2, () => false), null, 'clicks');
  assert.ok(Math.abs(audibleAfter(() => true, i => i >= 45)! - 46 / 30) < 1e-9, 'the director adds no delay of its own');
});
