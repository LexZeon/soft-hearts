import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  applyMoodEvent, canRequestAmbientSpeech, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodAttentionCandidate,
  KEEP_SPEECH_INTERVAL, type MoodParameters, type MoodState, type SpeechIntervalStretch,
} from '../shared/foundation/mood';
import { speechIntervalAfterUnanswered } from '../shared/behaviors/busy-chat/unanswered';

// Overhaul parts 3 (docs/claude/2026-11-16-overhaul-parts-3.md): the foundation's proactive-talk gate used to import busy-chat's
// "longer interval when unanswered" itself (the last foundation -> part import). It now takes it as a parameter that the mood host
// passes in. Pure refactor: GOLDEN below is the gate's answer over this grid computed with the code BEFORE the change (commit
// 946a9ce8, where the gate imported speechIntervalAfterUnanswered); the gate with the function passed in must give the same answers.

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function params(intervalMin: number, allowance: number): MoodParameters {
  return { ...DEFAULT_MOOD_PARAMETERS, frequency: { ...DEFAULT_MOOD_PARAMETERS.frequency, speechIntervalMs: intervalMin * MINUTE, speechPerHour: 6, speechWithoutReply: allowance } };
}

/** One character per grid point and gate entry: candidate (s/m/l/n), ambient readiness (1/0), an attention event accepted (1/0). */
function gridAnswers(stretch?: SpeechIntervalStretch): string {
  let out = '';
  for (const unanswered of [0, 1, 2, 3, 4, 5, 6, 7])
    for (const allowance of [1, 2, 3])
      for (const intervalMin of [2, 10, 45])
        for (const sinceMin of [null, 0, 1, 2, 5, 10, 20, 45, 90, 180, 400, 1000]) {
          const p = params(intervalMin, allowance);
          const state: MoodState = { ...createMoodState(NOW - 2000 * MINUTE, p), updatedAt: NOW, boredom: 100, unansweredSpeech: unanswered,
            lastSpeechAt: sinceMin === null ? null : NOW - sinceMin * MINUTE, lastLookAt: null, lastMotionAt: null, speechTimes: [] };
          const candidate = stretch ? getMoodAttentionCandidate(state, NOW, p, true, stretch) : getMoodAttentionCandidate(state, NOW, p, true);
          out += candidate === null ? 'n' : candidate[0];
          const source = { kind: 'ambient' as const, sessionId: 's', observationId: `o${out.length}` };
          out += (stretch ? canRequestAmbientSpeech(state, source, NOW, p, stretch) : canRequestAmbientSpeech(state, source, NOW, p)) ? '1' : '0';
          const event = { type: 'attention' as const, id: `a${out.length}`, kind: 'speech' as const };
          const after = stretch ? applyMoodEvent(state, event, NOW, p, stretch) : applyMoodEvent(state, event, NOW, p);
          out += after.lastSpeechAt === NOW ? '1' : '0';
        }
  return out;
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
// 864 grid points x 3 answers, from 946a9ce8 (before the change). Counts of each answer character are pinned too, to read a failure.
const GOLDEN_SHA256 = '7571eb036b28dce8f32b410045e0124e83d3c26126901fb875e341c74ed83103';
const GOLDEN_COUNTS = '{"0":1224,"1":504,"s":432,"m":432}';

const counts = (s: string) => [...s].reduce<Record<string, number>>((m, c) => { m[c] = (m[c] ?? 0) + 1; return m; }, {});

test('the gate with busy-chat\'s stretch passed in answers exactly as before the change, over the whole grid', () => {
  const now = gridAnswers(speechIntervalAfterUnanswered);
  assert.equal(now.length, 864 * 3);
  assert.equal(JSON.stringify(counts(now)), GOLDEN_COUNTS);
  assert.equal(digest(now), GOLDEN_SHA256);
});

test('without a stretch the gate keeps the plain interval: it differs from the stretched one only where lines went unanswered past the allowance', () => {
  const plain = gridAnswers();
  assert.equal(plain, gridAnswers(KEEP_SPEECH_INTERVAL));
  const stretched = gridAnswers(speechIntervalAfterUnanswered);
  let i = 0;
  let differs = 0;
  for (const unanswered of [0, 1, 2, 3, 4, 5, 6, 7])
    for (const allowance of [1, 2, 3])
      for (let k = 0; k < 3 * 12; k++, i += 3) {
        const same = plain.slice(i, i + 3) === stretched.slice(i, i + 3);
        if (unanswered < allowance) assert.ok(same, `unanswered ${unanswered} within allowance ${allowance} must not stretch`);
        if (!same) differs++;
      }
  assert.ok(differs > 0, 'the stretch changes some answers');
});
