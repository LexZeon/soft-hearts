/**
 * 2026-11-22 嘴型记录: one journal line per reply read aloud
 * on the window's Unbound engine, per stretch the expression holding her face and the peak lip opening (share of the model's own あ), and
 * whether the floor or the ceiling held. The log (src/unbound/window-mode/mouth-reading-log.ts), the line (shared/stage/journal-entries.ts:
 * closed words and numbers only, nothing smuggled), the host's fact (companion window only), and the real Gene window feeding it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MouthReadingLog, QUIET_S, dominantExpression, type MouthReadingEntry } from '../src/unbound/window-mode/mouth-reading-log';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { MOUTH_READING_MAX } from '../shared/stage';
import { JournalExtras } from '../electron/memory/journal/extras';
import { emptyShowcaseFace } from '../src/unbound/window-mode/window-expression';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { windowGene } from './helpers/unbound-window';
import { faceView } from './helpers/window-face-fixture';

const reading = (aa: number, floored = false, capped = false) => ({ aa, floored, capped });

test('the log: a stretch per held speaking, the word that held most of it, the peak, the flags; one line per reply, never twice', () => {
  const lines: MouthReadingEntry[] = [];
  const log = new MouthReadingLog(entry => lines.push(entry));
  const dt = 1 / 60;
  for (let k = 0; k < 30; k++) log.frame(dt, true, reading(0.2 + k / 100), k < 5 ? 'none' : 'confirm-smile');
  for (let k = 0; k < 10; k++) log.frame(dt, false, reading(0), 'confirm-smile');
  for (let k = 0; k < 20; k++) log.frame(dt, true, reading(0.3, k === 3, false), 'pout');
  assert.equal(lines.length, 0, 'nothing until the reply is over');
  log.release();
  assert.deepEqual(lines, [{ sentences: [{ word: 'confirm-smile', peak: 0.49, floor: false, ceiling: false }, { word: 'pout', peak: 0.3, floor: true, ceiling: false }] }]);
  log.release();
  assert.equal(lines.length, 1, 'never twice');
  // No release (read-aloud ended without one): after QUIET_S of silence.
  for (let k = 0; k < 10; k++) log.frame(dt, true, reading(0.5, false, true), 'none');
  for (let t = 0; t < QUIET_S - 0.1; t += dt) log.frame(dt, false, null, 'none');
  assert.equal(lines.length, 1);
  for (let t = 0; t < 0.2; t += dt) log.frame(dt, false, null, 'none');
  assert.deepEqual(lines[1], { sentences: [{ word: 'none', peak: 0.5, floor: false, ceiling: true }] });
  // A very long reading keeps its first MOUTH_READING_MAX stretches; a reset reports nothing.
  for (let s = 0; s < MOUTH_READING_MAX + 5; s++) { log.frame(dt, true, reading(0.4), 'none'); log.frame(dt, false, null, 'none'); }
  log.release();
  assert.equal(lines[2].sentences.length, MOUTH_READING_MAX);
  log.frame(dt, true, reading(0.4), 'none'); log.reset(); log.release();
  assert.equal(lines.length, 3);
});

test('the word: the strongest showcase expression at or over a tenth, from what was asked or her reply\'s beats', () => {
  const face = emptyShowcaseFace();
  assert.equal(dominantExpression(face, null), 'none');
  assert.equal(dominantExpression({ ...face, confirm: 0.6 }, { ...face, pout: 0.3 }), 'confirm-smile');
  assert.equal(dominantExpression(face, { ...face, warm: 0.2, laugh: 0.5 }), 'laugh');
  assert.equal(dominantExpression({ ...face, sly: 0.05 }), 'none', 'a trace is not holding her face');
});

test('the journal line: closed words and numbers only; anything else is refused or dropped; Chinese with an English copy', () => {
  const at = Date.UTC(2026, 10, 22, 8, 44);
  const ok = buildJournalEntry({ type: 'mouth-reading', characterId: 'one', sentences: [{ word: 'confirm-smile', peak: 0.4567, floor: true, ceiling: false }, { word: 'none', peak: 1, floor: false, ceiling: true }] }, at)!;
  assert.ok(ok);
  assert.deepEqual((ok as unknown as { sentences: unknown }).sentences, [{ word: 'confirm-smile', peak: 0.46, floor: true, ceiling: false }, { word: 'none', peak: 1, floor: false, ceiling: true }]);
  assert.equal(ok.reason, '她念这条回复时嘴张开了多少');
  const tr = (text: string, ...args: unknown[]) => text.replace(/\{(\d)\}/gu, (_, i: string) => String(args[Number(i)]));
  assert.match(describeJournalEntry(ok, tr), /她念这条回复时嘴张开了多少：轻笑 0\.46（托底）、没表情 1\.00（封顶）$/u);
  const smuggled = buildJournalEntry({ type: 'mouth-reading', characterId: 'one', text: '你好', sentences: [{ word: 'pout', peak: 0.3, floor: false, ceiling: false, text: '你好' }] } as never, at)!;
  assert.deepEqual(Object.keys(smuggled).sort(), ['at', 'characterId', 'reason', 'sentences', 'time', 'type', 'v']);
  assert.deepEqual(Object.keys((smuggled as unknown as { sentences: object[] }).sentences[0]).sort(), ['ceiling', 'floor', 'peak', 'word']);
  for (const bad of [[], [{ word: 'grin', peak: 0.3, floor: false, ceiling: false }], [{ word: 'pout', peak: 3, floor: false, ceiling: false }], [{ word: 'pout', peak: 0.3, floor: 'yes', ceiling: false }],
    Array.from({ length: MOUTH_READING_MAX + 1 }, () => ({ word: 'none', peak: 0.1, floor: false, ceiling: false })), 'x'])
    assert.equal(buildJournalEntry({ type: 'mouth-reading', characterId: 'one', sentences: bad } as never, at), null, JSON.stringify(bad).slice(0, 60));
  assert.equal(buildJournalEntry({ type: 'mouth-reading', characterId: null, sentences: [{ word: 'none', peak: 0.1, floor: false, ceiling: false }] } as never, at), null, 'needs her');
});

test('the host takes the fact from the companion window only', () => {
  const records: Record<string, unknown>[] = [];
  const extras = new JournalExtras({ sink: { record: (input: Record<string, unknown>) => { records.push(input); return true; } } as never, characterId: () => 'one',
    engine: () => 'local', uptimeMs: () => 1, blushStage: () => {} });
  const value = { sentences: [{ word: 'pout', peak: 0.3, floor: false, ceiling: false }] };
  assert.equal(extras.fact('mouth-reading', value, false), false, 'not from another window');
  assert.equal(extras.fact('mouth-reading', value, true), true);
  assert.deepEqual(records, [{ type: 'mouth-reading', characterId: 'one', sentences: value.sentences }]);
  assert.equal(extras.fact('mouth-reading', 'nope', true), false);
});

test('the real Gene window: a held smile and a plain stretch come out as two stretches with their words and their peaks', async () => {
  const g = await windowGene();
  const mesh = g.fixture.mesh, rig = windowFaceRig(mesh, new StageModelProfile(mesh, { reviewed: true }), true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); face.setMood(faceView({ primary: 'calm', companion: null }));
  g.body.bindFace(slotBindings(rig, face.blushMorph()));
  const lines: MouthReadingEntry[] = [], log = new MouthReadingLog(entry => lines.push(entry));
  try {
    for (let k = 0; k <= 60 * 7; k++) {
      const t = k / 60, dt = k ? 1 / 60 : 0, raw = (t >= 1 && t < 3) || (t >= 4.5 && t < 6.5) ? ((t * 1000) % 350 < 250) : false;
      g.body.setSpeaking(raw);
      if (k === 60 * 4) face.show('confirm-smile', { holdS: 4 });
      const f = face.frame(dt, { shown: true, adjusting: false, voiced: g.body.mouth?.voiced === true, speaking: raw });
      g.body.frame(dt, { pointer: { x: 0, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: f });
      log.frame(dt, g.body.mouth?.voiced === true, g.body.mouth?.lastReading, face.mouthWord);
    }
    log.release();
  } finally { g.close(); }
  assert.equal(lines.length, 1);
  const [plain, smiling] = lines[0].sentences;
  assert.equal(lines[0].sentences.length, 2, JSON.stringify(lines[0]));
  assert.equal(plain.word, 'none'); assert.equal(smiling.word, 'confirm-smile');
  assert.ok(plain.peak > 0.3 && smiling.peak > 0.35 * plain.peak, JSON.stringify(lines[0]));
  assert.ok(buildJournalEntry({ type: 'mouth-reading', characterId: 'gene', ...lines[0] }, Date.now()), 'the window\'s line passes the journal');
});
