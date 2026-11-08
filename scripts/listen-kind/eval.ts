/**
 * I-016 A (docs/claude/2026-11-03-listen-kind.md): how well "is it music" and the four kinds are told apart, on synthetic sound only:
 * program-made songs (drums, sung lines, drumless pads) and Windows SAPI voices (scripts/listen-kind/make-speech.ps1 writes them to
 * .local/listen-kind/sapi first). No real song, show or recording; nothing is captured from this computer.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/listen-kind/eval.ts [--out .local/listen-kind]
 *
 * Per clip: the fast layer (src/stage/music-likeness.ts) on the capture's own samples (tests/helpers/listen-audio.ts analyser), and the
 * host's judgement (electron/listen-kind-source.ts) fed what the pet window would report each second (sound or not, the score). The
 * host is run twice: on the beat alone, and with recognizer tags simulated per 12 s clip by the rules measured on the real local
 * recognizer (docs/claude/2026-11-03-ambient-local-asr.md: music alone → bgm, no words; Chinese speech over music → bgm with words;
 * English speech over music → speech with words; speech alone → speech with words; laughter → laughter, an assumption: not measured).
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MusicLikeness } from '../../src/stage/music-likeness';
import { ListenKindJudge } from '../../electron/listen-kind-source';
import type { ListenKind } from '../../shared/listen-kind';
import type { AsrEventTag } from '../../electron/asr/decode';
import { RATE, ambientPad, analyserSamples, concat, drumSong, laughter, level, mix, noise, readWav, seconds, sungVocal } from '../../tests/helpers/listen-audio';

const root = join(import.meta.dirname, '..', '..');
const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : join(root, '.local', 'listen-kind');
const sapi = join(root, '.local', 'listen-kind', 'sapi');
const files = (() => { try { return readdirSync(sapi).filter(f => f.endsWith('.wav')).sort(); } catch { return []; } })();
if (!files.length) { console.error(`no SAPI clips in ${sapi}: run scripts/listen-kind/make-speech.ps1 first`); process.exit(1); }
const voice = (prefix: string, start = 0) => {
  const lines = files.filter(f => f.startsWith(prefix)), order = [...lines.slice(start % lines.length), ...lines.slice(0, start % lines.length)];
  return level(concat(...order.flatMap((f, i) => [readWav(join(sapi, f)), seconds(0.35 + (i % 3) * 0.3)])), 0.1);
};
const take = (pcm: Float32Array, s: number) => { const out = new Float32Array(Math.round(s * RATE)); for (let i = 0; i < out.length; i++) out[i] = pcm[i % pcm.length]!; return out; };
const zh = (start = 0) => voice('huihui', start), zira = (start = 0) => voice('zira', start), david = (start = 0) => voice('david', start);
const laughWav = level(readWav(join(sapi, 'laugh-00.wav')), 0.09);

type Truth = Exclude<ListenKind, 'unsure'>;
/** Which spans are what (seconds), for the fast layer's "is it music" and the simulated tags. */
type Part = { from: number; to: number; music: boolean; speech: 'zh' | 'en' | null; laughter?: boolean };
interface Clip { name: string; truth: Truth; pcm: Float32Array; parts: Part[] }
const clips: Clip[] = [];
const add = (name: string, truth: Truth, pieces: { pcm: Float32Array; music: boolean; speech: 'zh' | 'en' | null; laughter?: boolean }[]) => {
  let t = 0; const parts: Part[] = [];
  for (const piece of pieces) { const length = piece.pcm.length / RATE; parts.push({ from: t, to: t + length, music: piece.music, speech: piece.speech, laughter: piece.laughter }); t += length; }
  clips.push({ name, truth, pcm: concat(...pieces.map(p => p.pcm)), parts });
};
const m = (pcm: Float32Array) => ({ pcm, music: true, speech: null });

// Music (12): drums at five tempos, two with a sung line, a ballad, three drumless pieces, a song with a quiet intro.
for (const [bpm, seed] of [[84, 1], [100, 2], [112, 3], [128, 4], [140, 5]] as const) add(`drums ${bpm} BPM`, 'music', [m(drumSong(75, { bpm, seed, swing: bpm === 140 ? 0.08 : 0 }))]);
add('song 96 BPM, sung 0 dB', 'music', [m(mix(drumSong(75, { bpm: 96, seed: 6 }), sungVocal(75, { bpm: 96, seed: 7 }), 0))]);
add('song 120 BPM, sung +3 dB', 'music', [m(mix(drumSong(75, { bpm: 120, seed: 8 }), sungVocal(75, { bpm: 120, seed: 9 }), 3))]);
add('ballad: pads + sung line (no drums)', 'music', [m(mix(ambientPad(75, { seed: 10 }), sungVocal(75, { bpm: 70, seed: 11 }), -2))]);
add('pads, 4 s chords (no drums)', 'music', [m(ambientPad(75, { seed: 12 }))]);
add('pads, 2 s chords (no drums)', 'music', [m(ambientPad(75, { seed: 13, chordS: 2 }))]);
add('pads, no melody (no drums)', 'music', [m(ambientPad(75, { seed: 14, melody: false }))]);
add('song with a pad intro', 'music', [m(ambientPad(15, { seed: 15 })), m(drumSong(60, { bpm: 108, seed: 16 }))]);

// Shows (6): an opening song, then dialogue over quiet background music, with laughter in some; one without any opening.
const dialogue = (speech: Float32Array, lang: 'zh' | 'en', s: number, bgmDb: number, bgm: 'pad' | 'drums', seed: number) =>
  ({ pcm: mix(take(speech, s), bgm === 'pad' ? ambientPad(s, { seed }) : drumSong(s, { bpm: 92, seed }), bgmDb), music: false, speech: lang });
const laughPart = (seed: number) => ({ pcm: mix(take(laughWav, 3), laughter(3, seed), -3), music: false, speech: null, laughter: true });
add('show zh: theme, dialogue over pads −15 dB', 'show', [m(drumSong(20, { bpm: 128, seed: 20 })), dialogue(zh(0), 'zh', 70, -15, 'pad', 21)]);
add('show en: theme, dialogue over pads −12 dB, laughter', 'show', [m(drumSong(20, { bpm: 110, seed: 22 })), dialogue(zira(1), 'en', 30, -12, 'pad', 23), laughPart(24), dialogue(david(2), 'en', 37, -12, 'pad', 25)]);
add('show zh: theme, dialogue over a quiet beat −18 dB', 'show', [m(drumSong(20, { bpm: 100, seed: 26 })), dialogue(zh(3), 'zh', 70, -18, 'drums', 27)]);
add('show en: theme, dialogue over pads −20 dB', 'show', [m(drumSong(20, { bpm: 140, seed: 28 })), dialogue(david(4), 'en', 70, -20, 'pad', 29)]);
add('show zh: ballad theme, dialogue, laughter', 'show', [m(mix(ambientPad(20, { seed: 30 }), sungVocal(20, { bpm: 76, seed: 31 }), -2)), dialogue(zh(5), 'zh', 35, -15, 'pad', 32), laughPart(33), dialogue(zh(6), 'zh', 32, -15, 'pad', 34)]);
add('show en: no opening, laughter twice', 'show', [dialogue(zira(5), 'en', 30, -15, 'pad', 35), laughPart(36), dialogue(david(6), 'en', 30, -15, 'pad', 37), laughPart(38), dialogue(zira(7), 'en', 15, -15, 'pad', 39)]);

// Talk (6): one voice, a call taking turns, with a little room noise.
const plain = (speech: Float32Array, lang: 'zh' | 'en', s: number, room = 0) => ({ pcm: room ? mix(take(speech, s), noise(s, 40 + s, room)) : take(speech, s), music: false, speech: lang });
add('talk zh (Huihui)', 'talk', [plain(zh(0), 'zh', 80)]);
add('talk en (Zira)', 'talk', [plain(zira(0), 'en', 80)]);
add('talk en (David)', 'talk', [plain(david(0), 'en', 80)]);
add('call: three voices taking turns', 'talk', [plain(zh(2), 'zh', 20), plain(david(3), 'en', 20), plain(zira(4), 'en', 20), plain(zh(5), 'zh', 20)]);
add('talk zh + room noise', 'talk', [plain(zh(4), 'zh', 80, 0.004)]);
add('talk en + room noise', 'talk', [plain(david(5), 'en', 80, 0.004)]);

// Quiet (3).
add('silence', 'quiet', [{ pcm: seconds(60), music: false, speech: null }]);
add('noise floor −50 dB', 'quiet', [{ pcm: noise(60, 50, 0.003), music: false, speech: null }]);
add('noise floor −56 dB', 'quiet', [{ pcm: noise(60, 51, 0.0015), music: false, speech: null }]);

/** Simulated recognizer tags for the 12 s clip ending at `t` (the rules measured on the real local recognizer). */
function tagsAt(clip: Clip, t: number): { words: boolean; event: AsrEventTag | null } {
  const inside = clip.parts.filter(p => p.to > t - 12 && p.from < t);
  const span = (p: Part) => Math.min(p.to, t) - Math.max(p.from, t - 12);
  const main = inside.sort((a, b) => span(b) - span(a))[0];
  if (!main) return { words: false, event: null };
  if (inside.some(p => p.laughter && span(p) >= 2)) return { words: true, event: 'laughter' };
  if (main.speech) {
    const underMusic = clip.truth === 'show';
    return { words: true, event: underMusic && main.speech === 'zh' ? 'bgm' : 'speech' };
  }
  if (main.music) return { words: false, event: 'bgm' };
  return clip.truth === 'quiet' ? { words: false, event: null } : { words: false, event: 'speech' };
}

interface Result {
  name: string; truth: Truth; seconds: number;
  fast: { firstMusicS: number | null; musicShareOnMusic: number | null; musicShareOnSpeech: number | null };
  host: Record<'beat' | 'tags', { accuracy: number; settledS: number | null; final: ListenKind; kinds: string }>;
}
const results: Result[] = [];
for (const clip of clips) {
  const samples = analyserSamples(clip.pcm, { seed: 11, offset: 0 });
  const length = clip.pcm.length / RATE;
  const fast = new MusicLikeness();
  let firstMusic: number | null = null, onMusic = 0, onMusicYes = 0, onSpeech = 0, onSpeechYes = 0, lastLoud = -Infinity, next = 1;
  const reports: { t: number; sound: boolean; beat: number; music: boolean }[] = [];
  for (const sample of samples) {
    fast.update(sample);
    const t = sample.time;
    if (sample.rms >= 0.004) lastLoud = t;
    const part = clip.parts.find(p => t >= p.from && t < p.to);
    // Score the fast layer away from the edges between parts (2 s after a change it may still be catching up).
    if (part && t - part.from > 6) {
      if (part.music) { onMusic++; if (fast.music) onMusicYes++; }
      else if (part.speech || part.laughter) { onSpeech++; if (fast.music) onSpeechYes++; }
    }
    if (fast.music && firstMusic === null && clip.parts.some(p => p.music && t >= p.from && t < p.to)) firstMusic = t - clip.parts.find(p => p.music)!.from;
    if (t >= next) { next += 1; reports.push({ t, sound: t - lastLoud < 3, beat: fast.score, music: fast.music }); }
  }
  const host = {} as Result['host'];
  for (const mode of ['beat', 'tags'] as const) {
    const judge = new ListenKindJudge(), base = 1_700_000_000_000, kinds: ListenKind[] = [];
    let nextClip = 12;
    for (const r of reports) {
      if (mode === 'tags' && r.t >= nextClip) { judge.noteClip(base + r.t * 1000, tagsAt(clip, r.t)); nextClip += 12; }
      kinds.push(judge.observe(base + r.t * 1000, { hearing: true, stage: { music: !r.sound ? 'silent' : r.music ? 'dance' : 'still', beat: r.beat } }).kind);
    }
    // Accuracy from 30 s on (the host smooths over 30 s; a show is a show only once its dialogue has run a while).
    const from = clip.truth === 'show' ? Math.max(30, (clip.parts.find(p => !p.music)?.from ?? 0) + 30) : clip.truth === 'quiet' ? 25 : 30;
    const judged = kinds.filter((_, i) => reports[i]!.t >= from);
    const settled = kinds.findIndex(k => k === clip.truth);
    const runs: string[] = [];
    kinds.forEach((k, i) => { if (!runs.length || !runs.at(-1)!.startsWith(k)) runs.push(`${k}@${Math.round(reports[i]!.t)}`); });
    host[mode] = { accuracy: judged.filter(k => k === clip.truth).length / Math.max(1, judged.length), settledS: settled >= 0 ? Math.round(reports[settled]!.t) : null, final: kinds.at(-1)!, kinds: runs.join(' → ') };
  }
  results.push({ name: clip.name, truth: clip.truth, seconds: Math.round(length),
    fast: { firstMusicS: firstMusic === null ? null : Math.round(firstMusic * 10) / 10, musicShareOnMusic: onMusic ? onMusicYes / onMusic : null, musicShareOnSpeech: onSpeech ? onSpeechYes / onSpeech : null }, host });
}

const pct = (v: number | null) => v === null ? '—' : `${Math.round(v * 100)}%`;
const lines = ['| 片段 | 应为 | 快层：首次认出音乐 | 快层：音乐段认作音乐 | 快层：说话段误作音乐 | 宿主（只看节拍）正确 / 认定于 | 宿主（加模拟标签）正确 / 认定于 |', '|---|---|---|---|---|---|---|'];
for (const r of results) lines.push(`| ${r.name} | ${r.truth} | ${r.fast.firstMusicS ?? '—'} s | ${pct(r.fast.musicShareOnMusic)} | ${pct(r.fast.musicShareOnSpeech)} | ${pct(r.host.beat.accuracy)} / ${r.host.beat.settledS ?? '—'} s | ${pct(r.host.tags.accuracy)} / ${r.host.tags.settledS ?? '—'} s |`);
const summary: Record<string, unknown> = {};
for (const truth of ['music', 'show', 'talk', 'quiet'] as const) {
  const of = results.filter(r => r.truth === truth), mean = (values: (number | null)[]) => { const v = values.filter((x): x is number => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  summary[truth] = {
    clips: of.length,
    hostBeat: { accuracy: mean(of.map(r => r.host.beat.accuracy)), correctFinal: of.filter(r => r.host.beat.final === truth).length, settledS: mean(of.map(r => r.host.beat.settledS)) },
    hostTags: { accuracy: mean(of.map(r => r.host.tags.accuracy)), correctFinal: of.filter(r => r.host.tags.final === truth).length, settledS: mean(of.map(r => r.host.tags.settledS)) },
    fastFirstMusicS: mean(of.map(r => r.fast.firstMusicS)), fastMusicOnMusic: mean(of.map(r => r.fast.musicShareOnMusic)), fastMusicOnSpeech: mean(of.map(r => r.fast.musicShareOnSpeech)),
  };
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'eval.json'), JSON.stringify({ results, summary }, null, 2));
writeFileSync(join(outDir, 'eval.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(JSON.stringify(summary, null, 1));
for (const r of results) console.log(`${r.name}: beat ${r.host.beat.kinds} | tags ${r.host.tags.kinds}`);
