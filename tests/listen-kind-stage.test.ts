/**
 * I-016 A on the real Stage frame loop (the bundled Gene, real procedural life, the R15 dance; gene-stage-harness), fed the capture's
 * samples of synthetic sound (tests/helpers/listen-audio.ts: the same analyser maths as src/ui/SystemAudio.ts):
 *  - "让她一直跟着跳" (user-confirmed R15) now dances once the sound is recognized as music: for music every frame from then on is R15's own, bit for bit, also after a stretch of talk;
 *    talk is never danced to;
 *  - her own choice: dialogue never makes her look up to listen or want to dance (with the capture on and only talk she is
 *    exactly as without it); a show's opening song she may dance to, and she stops by the dance's own ease-out once the
 *    dialogue starts; no jumps (the display guard catches nothing), entries and exits within the R15 standard.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { between, geneStage, surprises, type GeneStage, type GeneStageOptions, type ShownFrame } from './helpers/gene-stage-harness';
import { ambientPad, analyserSamples, concat, drumSong, mix, speechLike } from './helpers/listen-audio';
import type { MusicEnergySample } from '../src/stage/music-dance';

function digest(frames: readonly ShownFrame[]): string {
  const hash = createHash('sha256'), buffer = new Float64Array(4);
  for (const frame of frames) {
    for (const q of [...frame.world, ...frame.derived]) { buffer[0] = q.x; buffer[1] = q.y; buffer[2] = q.z; buffer[3] = q.w; hash.update(Buffer.from(buffer.buffer)); }
    buffer[0] = frame.blink; buffer[1] = frame.smile; buffer[2] = frame.brow; buffer[3] = frame.mouth; hash.update(Buffer.from(buffer.buffer));
  }
  return hash.digest('hex');
}
const samplesOf = (pcm: Float32Array) => analyserSamples(pcm, { seed: 3 });
const her = (h: GeneStage) => h.stage.setMusicSettings({ alwaysDance: false });
const always = (h: GeneStage) => { her(h); h.stage.setMusicSettings({ alwaysDance: true }); };
const jumps = (frames: readonly ShownFrame[]) => frames.length ? frames.at(-1)!.guardJumps - frames[0].guardJumps : 0;

interface Trace { frames: ShownFrame[]; held: number[]; music: boolean[]; danceOn: boolean[]; cues: number; tier: string[] }
/** Listens from the first frame for `seconds`, then the capture stops for `after` seconds. */
async function run(samples: readonly MusicEnergySample[], route: (h: GeneStage) => void, seconds: number, options: GeneStageOptions = {}, after = 2): Promise<Trace> {
  const h = await geneStage({ music: false, samples, ...options });
  try {
    route(h);
    const trace: Trace = { frames: h.shown, held: [], music: [], danceOn: [], cues: 0, tier: [] };
    const record = () => { const s = h.stage; trace.held.push(s.musicChoice ? s.musicDance.heldShare : 1); trace.music.push(s.musicLikeness?.music === true); trace.danceOn.push(s.musicEnabled === true); trace.tier.push(s.musicChoice?.tier ?? '-'); };
    if (route !== none) h.stage.setMusicEnabled(true);
    h.run(seconds, record);
    h.stage.setMusicEnabled(false);
    h.run(after, record);
    trace.cues = h.stage.musicListen?.getState().cues ?? 0;
    return trace;
  } finally { h.close(); }
}
const none = (_h: GeneStage) => {};
const r15 = (h: GeneStage) => h.stage.setDanceOn(true);
/** The first frame index from which the hold is exactly 1 for good (the dance shown in full), after it had been held. */
const openAt = (trace: Trace, from = 0) => { let open = -1; for (let i = from; i < trace.held.length; i++) { if (trace.held[i]! < 1) open = -1; else if (open < 0 && i > from && trace.held.slice(from, i).some(v => v < 1)) open = i; } return open; };

test('"一直跟着跳" on a synthetic song: held until it is recognized as music, then R15\'s own frames bit for bit (the exit too)', async () => {
  const samples = samplesOf(drumSong(14, { bpm: 112, seed: 21 }));
  const original = await run(samples, r15, 12), now = await run(samples, always, 12);
  assert.equal(original.frames.length, now.frames.length);
  const open = openAt(now);
  const recognized = now.music.indexOf(true);
  assert.ok(recognized > 60 && recognized < 6 * 60, `recognized as music ${(recognized / 60).toFixed(2)} s in`);
  assert.ok(open > recognized && open - recognized <= Math.ceil(0.6 * 60) + 2, `shown in full ${((open - recognized) / 60).toFixed(2)} s after (the 0.6 s ease-in)`);
  // Before it is recognized she does not dance: the frames differ from R15's, which danced from the first beat.
  assert.notEqual(digest(now.frames.slice(0, recognized)), digest(original.frames.slice(0, recognized)));
  assert.equal(digest(now.frames.slice(open)), digest(original.frames.slice(open)), 'from then on, every frame is R15\'s');
  assert.equal(jumps(now.frames), 0, 'the display guard caught nothing');
  const enter = Math.max(...surprises(between(now.frames, recognized / 60 - 0.05, open / 60 + 0.3)).map(bone => Math.max(...bone)));
  const r15Enter = Math.max(...surprises(between(original.frames, 0, 1.5)).map(bone => Math.max(...bone)));
  if (process.env.R29_REPORT) console.log(`always: recognized ${(recognized / 60).toFixed(2)} s, full ${(open / 60).toFixed(2)} s; entry surprise ${enter.toFixed(3)} deg (R15's own entry ${r15Enter.toFixed(3)})`);
  assert.ok(enter <= Math.max(r15Enter * 1.25, 0.15), `the dance comes in without a jump (${enter.toFixed(3)} vs R15 ${r15Enter.toFixed(3)} deg)`);
});

test('"一直跟着跳": talk is never danced to; music after the talk is again R15 frame for frame once recognized', async () => {
  const song = drumSong(12, { bpm: 104, seed: 22 }), talk = speechLike(14, { seed: 23 });
  const samples = samplesOf(concat(song, talk, song));
  const original = await run(samples, r15, 37), now = await run(samples, always, 37);
  const talkFrom = Math.round(13.5 * 60), talkTo = Math.round(26 * 60);
  // R15 itself dances to the talk; now the dance is held back through it (a little after it starts, by the dance's own yield).
  const offDuring = now.held.slice(talkFrom + 4 * 60, talkTo);
  assert.ok(offDuring.every(v => v === 0), `held through the talk (max ${Math.max(...offDuring)})`);
  assert.ok(original.danceOn.slice(talkFrom, talkTo).every(Boolean), 'R15 had the dance on all along');
  const open = openAt(now, talkTo);
  // Slower than a song after silence (3–5 s): the talk stays in the 8 s window for a while and keeps the score down.
  assert.ok(open > talkTo && open < talkTo + 10 * 60, `the next song shown in full ${((open - talkTo) / 60).toFixed(2)} s after the talk ended`);
  assert.equal(digest(now.frames.slice(open)), digest(original.frames.slice(open)), 'and from then on R15\'s frames again: the beat analysis never stopped');
  assert.equal(jumps(now.frames), 0);
  const out = Math.max(...surprises(between(now.frames, 12, 19)).map(bone => Math.max(...bone)));
  const r15Exit = Math.max(...surprises(between(original.frames, 36.9, 38.5)).map(bone => Math.max(...bone)));
  if (process.env.R29_REPORT) console.log(`always, song → talk: hold-out surprise ${out.toFixed(3)} deg (R15's own exit ${r15Exit.toFixed(3)})`);
  assert.ok(out <= Math.max(r15Exit * 1.25, 0.35), `the dance leaves the talk without a jump (${out.toFixed(3)} deg)`);
});

test('her own choice, only talk (SAPI-like speech) with the capture on: no look, no nod, no dance: frame for frame as with it off', async () => {
  const samples = samplesOf(concat(speechLike(20, { seed: 24 }), mix(speechLike(10, { seed: 25, pitch: 220 }), ambientPad(10, { seed: 26 }), -14)));
  for (const primary of ['happy', 'calm', 'sad']) {
    const off = await run(samples, none, 28, { primary }), on = await run(samples, her, 28, { primary });
    assert.equal(on.music.some(Boolean), false, `${primary}: never recognized as music`);
    assert.equal(on.cues, 0, `${primary}: she never looks up to listen`);
    assert.deepEqual([...new Set(on.tier)], ['none'], `${primary}: never wants to dance or nod`);
    assert.equal(digest(on.frames), digest(off.frames), `${primary}: exactly as with the capture off`);
  }
});

test('her own choice, a show: the opening song (she may dance), then dialogue: she stops by the dance\'s own ease-out, and stays still', async () => {
  const samples = samplesOf(concat(drumSong(16, { bpm: 120, seed: 27 }), mix(speechLike(26, { seed: 28 }), ambientPad(26, { seed: 29 }), -15)));
  const now = await run(samples, her, 40, { primary: 'happy' });
  const recognized = now.music.indexOf(true);
  assert.ok(recognized > 0 && recognized < 6 * 60, `the opening song is recognized ${(recognized / 60).toFixed(2)} s in`);
  assert.equal(now.cues, 1, 'one look up to listen, at the song, none for the dialogue');
  const dancing = now.danceOn.findIndex(Boolean);
  assert.ok(dancing >= recognized && dancing <= recognized + 2, 'happy, she dances once it is music');
  assert.ok(now.held.slice(dancing, 16 * 60).every(v => v === 1), 'her dance is shown in full (R15\'s own dance) while it is music');
  const dialogue = 16 * 60, stopped = now.held.findIndex((v, i) => i > dialogue && v === 0);
  assert.ok(stopped > dialogue && stopped - dialogue <= 7 * 60, `the dance eased out ${((stopped - dialogue) / 60).toFixed(2)} s into the dialogue`);
  assert.ok(now.tier.slice(stopped + 4 * 60, 40 * 60).every(t => t === 'none'), 'then the song is over: she goes back to herself');
  assert.equal(jumps(now.frames), 0);
  const out = Math.max(...surprises(between(now.frames, 16, 24)).map(bone => Math.max(...bone)));
  if (process.env.R29_REPORT) console.log(`her, show: dance out ${((stopped - dialogue) / 60).toFixed(2)} s into the dialogue, worst surprise ${out.toFixed(3)} deg`);
  assert.ok(out <= 0.35, `no jump as she stops (${out.toFixed(3)} deg; R15's own exits are 0.06–0.30)`);
});

test('her own choice, a drumless song: recognized from its sustained sound, and the nod / dance start from there', async () => {
  const samples = samplesOf(ambientPad(24, { seed: 30 }));
  const now = await run(samples, her, 22, { primary: 'calm' });
  const recognized = now.music.indexOf(true);
  assert.ok(recognized > 0 && recognized < 12 * 60, `recognized ${(recognized / 60).toFixed(2)} s in`);
  assert.equal(now.cues, 1);
  assert.ok(now.tier.slice(recognized + 2).includes('nod'), 'a calm her nods to it');
  assert.equal(jumps(now.frames), 0);
});
