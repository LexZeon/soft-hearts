/**
 * I-037 害羞 reaction on the real Stage frame loop (Gene, tests/helpers/gene-stage-harness.ts), at 60 and 30 fps (R29: smooth, never a
 * jump; a second shy while one is showing keeps the show going and eases to the higher strength — I-038 part A, show-blend.ts —
 * instead of restarting its curve). X-343 (show-clock.ts): it also keeps her in the hold, so the show ends about SHOW_MS.shy after
 * the latest cue, not on the first cue's schedule. The cue goes through MmdStage.playReaction, as the host's `desk:reaction` does.
 * Measured: the display guard's catches (must stay 0), when the show ends, and the head's largest unexpected step (degrees) at the
 * start, around each later cue, while it holds and lets go, and at the end, against the same run without the reaction. Set
 * R29_REPORT=1 to print the numbers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SHOW_MS } from '../src/stage/expression-show';
import { between, geneStage, surprises, steps } from './helpers/gene-stage-harness';

const HEAD = 4, SHY = SHOW_MS.shy / 1000;
const report = (label: string, values: Record<string, number>) => {
  if (process.env.R29_REPORT) console.log(`${label}: ${Object.entries(values).map(([key, value]) => `${key} ${value.toFixed(3)}`).join(' · ')}`);
};

/** Seconds after the first cue at which a later shy cue comes. */
const SCRIPTS: readonly (readonly [label: string, cues: readonly number[]])[] = [
  ['again at 1.0 s (coming in)', [1.0]],
  ['again at 1.9 s (late in the hold)', [1.9]],
  ['four times', [0.6, 1.5, 2.6]],
];
const LEVELS = ['light', 'mid', 'strong'] as const;

async function run(fps: number, cues: readonly number[] | null) {
  const h = await geneStage({ fps });
  try {
    const t0 = 3, last = t0 + (cues?.at(-1) ?? 0), total = cues ? last + SHY + 2.5 : t0 + 9;
    h.run(t0);
    const answers: string[] = [];
    let shownUntil = -1;
    const each = () => { if ((h.stage as { expressionShow?: unknown }).expressionShow) shownUntil = h.time(); };
    if (cues) answers.push(h.stage.playReaction({ id: 'reaction-shy-0', kind: 'shy', level: 'mid' }));
    let at = t0;
    for (const [i, cue] of (cues ?? []).entries()) {
      h.run(t0 + cue - at, each); at = t0 + cue;
      answers.push(h.stage.playReaction({ id: `reaction-shy-${i + 1}`, kind: 'shy', level: LEVELS[(i + 2) % 3] }));
    }
    h.run(total - at, each);
    // `each` runs before a frame: the show was still on at the last such time, and gone one frame later.
    return { frames: h.shown, answers, t0, last, end: shownUntil + 1 / fps };
  } finally { h.close(); }
}

for (const fps of [60, 30]) {
  test(`Gene ${fps} fps: a shy reaction plays smoothly; asked again while it shows it stays in the hold and ends a full show after the latest cue (no restart, no pop); the guard catches nothing`, async () => {
    const control = await run(fps, null);
    const worst = (frames: typeof control.frames, from: number, to: number) => Math.max(...surprises(between(frames, from, to))[HEAD]);
    const edge = 2 / fps, frame = 1 / fps;
    for (const [label, cues] of SCRIPTS) {
      const reaction = await run(fps, cues);
      assert.deepEqual(reaction.answers, cues.map(() => 'played').concat('played'), label);
      const { t0, last, end } = reaction, expectedEnd = last + SHY;
      const undisturbed = worst(control.frames, t0 - 1, expectedEnd + 1.5);
      const stepPeak = Math.max(...steps(between(reaction.frames, t0 - edge, end + 1.2))[HEAD]);
      const numbers = {
        end: end - t0, expectedEnd: expectedEnd - t0,
        entry: worst(reaction.frames, t0 - edge, t0 + 0.6),
        secondCue: Math.max(...cues.map(cue => worst(reaction.frames, t0 + cue - edge, t0 + cue + 0.6))),
        holdAndRelease: worst(reaction.frames, last + 0.6, end - 0.6), exit: worst(reaction.frames, end - 0.6, end + 1.2),
        undisturbed, stepPeak, guard: reaction.frames.at(-1)!.guardJumps - reaction.frames[0].guardJumps,
        // The held look (head away from where it would be, degrees) from once the higher strength has eased in until the hold's
        // own slow tail: a restart would dip it (the old show fades while the new one rises from 0). Her own idle glances in the
        // undisturbed run move this by up to ~1°, so the bar is 80 % (a restart dips to about 30 %).
        heldMin: Infinity, heldMax: 0,
      };
      for (const [i, shown] of reaction.frames.entries()) if (shown.t >= last + 0.5 && shown.t <= expectedEnd - 1.2) {
        const away = shown.world[HEAD].angleTo(control.frames[i].world[HEAD]) * 180 / Math.PI;
        numbers.heldMin = Math.min(numbers.heldMin, away); numbers.heldMax = Math.max(numbers.heldMax, away);
      }
      report(`X-343 shy ${fps} fps ${label} (s, head surprise deg)`, numbers);      // The show is still on after the first cue's end, and ends a full show after the latest cue (within a frame or two).
      assert.ok(end > t0 + SHY + 0.5, `${label}: still shy after the first cue's end (${(end - t0).toFixed(3)} s)`);
      assert.ok(Math.abs(end - expectedEnd) <= 2 * frame + 1e-6, `${label}: ends ${SHY} s after the latest cue (${(end - t0).toFixed(3)} vs ${(expectedEnd - t0).toFixed(3)} s)`);
      assert.equal(numbers.guard, 0, `${label}: the display guard had nothing to catch`);
      const quiet = Math.max(0.15 * 60 / fps, undisturbed * 1.25);
      assert.ok(numbers.entry <= Math.max(0.15 * 60 / fps, stepPeak * 0.5), `${label}: no jump at the start (${numbers.entry.toFixed(3)})`);
      assert.ok(numbers.secondCue <= Math.max(quiet, numbers.entry), `${label}: a later cue only eases, never snaps (${numbers.secondCue.toFixed(3)})`);
      assert.ok(numbers.holdAndRelease <= undisturbed * 1.25, `${label}: the held look and its release are as quiet as her own motion (${numbers.holdAndRelease.toFixed(3)} vs ${undisturbed.toFixed(3)})`);
      assert.ok(numbers.heldMax > 6 && numbers.heldMin >= 0.8 * numbers.heldMax, `${label}: she stays in the held look, no dip (${numbers.heldMin.toFixed(2)}–${numbers.heldMax.toFixed(2)}°)`);
      assert.ok(numbers.exit <= quiet, `${label}: no jump at the end (${numbers.exit.toFixed(3)} vs ${undisturbed.toFixed(3)})`);
    }
  });
}
