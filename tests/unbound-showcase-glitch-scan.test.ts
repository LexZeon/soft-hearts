// Round 12 (QA): the showcase glitch scan (scripts/unbound/showcase-glitch-scan.ts) — what it flags on made-up frames, that it
// flags nothing on a short clean run through the real frame loop, and the blink fix the scan led to (no blink on smile-closed eyes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { morphsOf, scanShowcase, type ScanFrame } from '../scripts/unbound/showcase-glitch-scan';
import { validateBeats } from '../shared/unbound/showcase';
import { ShowcasePerformer } from '../src/unbound/showcase/performer';
import { laptopLens } from './helpers/unbound-peek';
import { runShowcase, SHOWCASE_TRACKED } from './helpers/unbound-showcase';

const AXIS = new Vector3(0, 1, 0);
/** One bone turning smoothly at `degPerS`, plus whatever `edit` changes in frame i. */
function frames(n: number, fps: number, edit: (i: number, f: ScanFrame) => void = () => {}): ScanFrame[] {
  return Array.from({ length: n }, (_, i) => {
    const f: ScanFrame = { t: i / fps, beats: ['hold-gaze'], rotations: [new Quaternion().setFromAxisAngle(AXIS, (20 * Math.PI / 180) * Math.sin(i / fps))],
      eyeInHead: [{ yaw: 3, pitch: 1 }], clearance: 0.02, morphs: { 'まばたき': 0, 'にっこり': 0.2, 'う': 0, '笑い': 0 } };
    edit(i, f);
    return f;
  });
}

test('round 12, the glitch scan: a clean stretch is clean; each kind of glitch is found, at its time, merged over frames', () => {
  const opts = { fps: 60, boneNames: ['頭'] };
  assert.deepEqual(scanShowcase(frames(120, 60), opts), []);
  const pop = scanShowcase(frames(120, 60, (i, f) => { if (i === 50) f.rotations = [new Quaternion().setFromAxisAngle(AXIS, 0.3)]; }), opts);
  // Found at the jump (the frame out of it, or the frame back from it).
  assert.ok(pop.some(h => h.kind === 'pop' && h.name === '頭' && Math.abs(h.from - 50 / 60) <= 1 / 60 + 1e-3), JSON.stringify(pop));
  const morph = scanShowcase(frames(120, 60, (i, f) => { if (i >= 70) f.morphs = { ...f.morphs, 'にっこり': 0.7 }; }), opts);
  assert.ok(morph.some(h => h.kind === 'morph' && h.name === 'にっこり'), JSON.stringify(morph));
  const fight = scanShowcase(frames(120, 60, (i, f) => { f.morphs = { ...f.morphs, 'にっこり': 0.6, 'う': i > 30 && i < 60 ? 0.6 : 0.6 }; }), opts);
  assert.equal(fight.filter(h => h.kind === 'fight').length, 1, 'one merged finding over the whole stretch');
  const blink = scanShowcase(frames(120, 60, (i, f) => { f.morphs = { ...f.morphs, '笑い': 0.9, 'まばたき': i === 40 ? 0.5 : 0 }; }), opts);
  assert.ok(blink.some(h => h.kind === 'blink-pop'), JSON.stringify(blink));
  const plainBlink = scanShowcase(frames(120, 60, (i, f) => { f.morphs = { ...f.morphs, 'まばたき': i === 40 ? 0.5 : 0 }; }), opts);
  assert.deepEqual(plainBlink, [], 'an ordinary blink is crisp by design, not a glitch');
  const hand = scanShowcase(frames(120, 60, (i, f) => { if (i > 10 && i < 14) f.clearance = -0.004; }), opts);
  assert.deepEqual(hand.map(h => [h.kind, h.worst]), [['hand', -0.4]]);
  const eye = scanShowcase(frames(120, 60, (i, f) => { if (i === 90) f.eyeInHead = [{ yaw: 14, pitch: 7 }]; }), opts);
  assert.ok(eye.some(h => h.kind === 'eye' && h.worst > 15), JSON.stringify(eye));
});

test('round 12, the glitch scan on a short run through the real frame loop (30 fps): no glitch', async () => {
  const beats = validateBeats([
    { at: 0, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1.5, dur: 6, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
    { at: 2, dur: 2.5, kind: 'expression', name: 'laugh', intensity: 0.8, feel: '—' }, { at: 4.5, dur: 2.5, kind: 'hand-face', where: 'cheek', side: 'right', intensity: 0.5, feel: '—' },
  ], { from: 0, to: 30 })!.beats;
  const morphs: Record<string, number>[] = [];
  const run = await runShowcase(30, 7.5, beats, { seed: 0.42, onFrame: mesh => morphs.push(morphsOf(mesh)) });
  const hits = scanShowcase(run.frames.map((f, i) => ({ ...f, morphs: morphs[i] ?? {} })).slice(15), { fps: 30, boneNames: SHOWCASE_TRACKED });
  assert.deepEqual(hits, []);
  assert.ok(morphs.some(m => Object.values(m).some(v => v > 0.3)), 'morphs were read');
});

test('round 12: no blink starts while a big smile holds her eyes closed in arcs (the scan found the lids flicking)', () => {
  const lens = laptopLens(), p = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, 0.42, 'standing');
  p.append(validateBeats([{ at: 0, dur: 1, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1, dur: 20, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
    { at: 2, dur: 10, kind: 'expression', name: 'laugh', intensity: 0.9, onset: 'quick', feel: '—' }], { from: 0, to: 30 })!.beats); // 10 s: the longest a beat may be
  for (let i = 0; i < 60 * 16; i++) p.frame(1 / 60, lens);
  const during = p.blinkTimes.filter(t => t > 2.8 && t < 11.5);
  assert.deepEqual(during, [], `blinks during the laugh: ${during.map(t => t.toFixed(2)).join(', ')}`);
  assert.ok(p.blinkTimes.some(t => t > 14.5), 'blinks come back after it');
});
