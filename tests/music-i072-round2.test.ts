/**
 * I-072 round 2 (docs/claude/2026-11-10-i072-music-overhaul.md "第二轮"): two false "not music" verdicts Codex found (T-234), synthetic 16 s at
 * 48 kHz: side-chain pumping on a mid-band chord over drums, and 0.14 s syllables on a 0.25 s grid over drums. Dips and onsets that repeat at the
 * beat's own period are the music's structure, not pauses between words. Controls stay "not music": dialogue, dialogue over drums at -24 and
 * -12 dB, and the same syllables at irregular intervals.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_DETECT_KNOBS } from '../shared/senses/music-detect/knobs';
import { likenessScore, onBeatDips, syllabicVoice, type LikenessFeatures } from '../src/stage/music-likeness';
import { round2Cases, tailShare } from './helpers/music-fixtures';

for (const refreshHz of [60, 30]) {
  test(`round 2 cases at a ${refreshHz} Hz display: pumping and on-beat rap are music, the controls are not`, t => {
    for (const c of round2Cases()) {
      const r = tailShare(c.pcm, { refreshHz }, c.music ? 12 : 8);
      t.diagnostic(`${c.name}: ${(r.share * 100).toFixed(0)}%, beat ${r.beat.toFixed(2)} speech ${r.speech.toFixed(2)}`);
      if (c.music) assert.equal(r.share, 1, `${c.name}: music from 12 s on`);
      else assert.equal(r.share, 0, `${c.name}: never music`);
    }
  });
}

const base: LikenessFeatures = {
  soundS: 8, beatPeak: 0.6, period: 0.5, periodStable: 1, gridLock: 0.8, ioiCv: 0.1, slowPeak: 0.3, dipShare: 0.3, flutter: 5, swing: 10, tilt: -10,
  onsetRate: 4, recentDips: 2, tempoMatch: 0, steadyShare: 0, midLock: 0.7,
};

test('on-beat dips need both a repeating voice band and a clear beat; they cancel the speech evidence', () => {
  const k = MUSIC_DETECT_KNOBS.speechVsSinging;
  assert.equal(onBeatDips({ ...base }), 0, 'no measure, no cancel');
  assert.equal(onBeatDips({ ...base, midPeriodic: k.onBeatFrom }), 0);
  assert.equal(onBeatDips({ ...base, midPeriodic: k.onBeatFrom + 0.25 }), 1);
  assert.equal(onBeatDips({ ...base, midPeriodic: 0.9, beatPeak: 0.2 }), 0, 'a repeating mid band with no clear beat is not music structure');
  const plain = likenessScore({ ...base, midPeriodic: 0.1 }), locked = likenessScore({ ...base, midPeriodic: 0.9 });
  assert.equal(plain.speech, 1);
  assert.ok(locked.speech < 0.1 && locked.score > 0.6, `locked: speech ${locked.speech}, score ${locked.score}`);
  assert.ok(syllabicVoice({ ...base, midPeriodic: 0.9 }) < 0.01 && syllabicVoice({ ...base, midLock: 0.5, midPeriodic: 0.1 }) === 1);
});
