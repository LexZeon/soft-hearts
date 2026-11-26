// I-152 step 2: the motion coverage table (docs/claude/2026-11-19-vrm-motion-step2.md「动作覆盖表」). Every library motion runs
// through Unbound's engine on three models: the public Gene (as authored), Gene with every standard bone renamed to English (a PMX
// from another tool: the stage's conversion and alias table), and the synthetic VRM (the standard body). For each pair:
//  - nothing is dropped silently: every moving track after conversion lands on a bone of the mesh;
//  - what cannot be done is said: the conversion's lost parts are only parts the model really has not (the synthetic VRM has no
//    middle, ring or little fingers), and a face is dropped only when the model has no expression for it;
//  - no NaN on any bone, and no jump: the per-frame turn of the body's bones (bridged in from the previous motion, as on the companion)
//    stays near Gene's own for the same motion (the conversion adds no fast turns), and her hips stay where a standing body has them.
// New library motions are checked here automatically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_POSE, type MorphSlot } from '../shared/foundation/universal-skeleton';
import { libraryMotions, modelUnderTest, runMotion, type CoverageModel, type CoverageRow } from './helpers/motion-coverage';

const MODELS: CoverageModel[] = ['gene', 'renamed-pmx', 'vrm'];
/**
 * How far a limb may point from Gene's for the same motion (deg). The renamed PMX is Gene. The synthetic VRM keeps its own design
 * where the conversion keeps it (a straight spine and shins: about 10° and 5° from Gene's), and the contact fit moves its arms so
 * the hands still meet with its own shoulders and arm length (clap: about 22°); a T-pose arm left as it is would be 34° off.
 */
const POSE_LIMIT: Record<CoverageModel, number> = { gene: 0, 'renamed-pmx': 1, vrm: 25 };
const SLOT_OF_NAME = new Map<string, MorphSlot>(Object.entries(STANDARD_POSE.morphSlots).map(([slot, entry]) => [entry!.name, slot as MorphSlot]));

test('motion coverage: every library motion on Gene, a renamed PMX and a VRM: nothing silently dropped, no NaN, no jump', async () => {
  const rows = new Map<string, Partial<Record<CoverageModel, CoverageRow>>>();
  const lacks: Partial<Record<CoverageModel, (part: string) => boolean>> = {};
  const faces: Partial<Record<CoverageModel, (slot: MorphSlot) => boolean>> = {};
  for (const model of MODELS) {
    const m = await modelUnderTest(model);
    lacks[model] = part => m.lacks(part as never);
    faces[model] = slot => m.standard ? m.standard.has(slot) : true;
    try { for (const motion of libraryMotions) { const row = runMotion(m, motion); rows.set(row.motion, { ...rows.get(row.motion), [model]: row }); } }
    finally { m.close(); }
  }
  assert.equal(rows.size, libraryMotions.length);
  const problems: string[] = [], said: Record<CoverageModel, Set<string>> = { gene: new Set(), 'renamed-pmx': new Set(), vrm: new Set() };
  let clean = 0;
  const worst: Partial<Record<CoverageModel, number>> = {};
  for (const [motion, byModel] of rows) {
    const gene = byModel.gene!;
    let ok = true;
    for (const model of MODELS) {
      const row = byModel[model]!;
      const fail = (what: string) => { problems.push(`${motion} on ${model}: ${what}`); ok = false; };
      if (row.silent.length) fail(`dropped without a word: ${row.silent.join(', ')}`);
      if (row.nan) fail('NaN');
      for (const part of row.lost) { said[model].add(part); if (!lacks[model]!(part)) fail(`lost ${part}, which the model has`); }
      for (const name of row.droppedFaces) { const slot = SLOT_OF_NAME.get(name); if (slot && faces[model]!(slot)) fail(`face ${name} dropped though the model has ${slot}`); }
      // The conversion adds no fast turn: within Gene's own for this motion plus a little (proportions differ), and never a snap.
      if (row.maxStep > gene.maxStep * 1.3 + 3 || row.maxStep > 35) fail(`per-frame turn ${row.maxStep.toFixed(1)}° (Gene ${gene.maxStep.toFixed(1)}°)`);
      if (row.maxSurprise > gene.maxSurprise * 1.5 + 2.5) fail(`unexpected step ${row.maxSurprise.toFixed(1)}° (Gene ${gene.maxSurprise.toFixed(1)}°)`);
      if (row.hips.low < 0.3 || row.hips.high > 0.7 || row.hips.far > 0.2) fail(`hips at ${row.hips.low.toFixed(2)}..${row.hips.high.toFixed(2)} of her height, ${row.hips.far.toFixed(2)} out`);
      // The same pose: each limb and the spine point the way they do on Gene (arms aligned by direction, T pose or not).
      const off = Math.max(...row.directions.map((d, i) => d.angleTo(gene.directions[i]) * 180 / Math.PI));
      worst[model] = Math.max(worst[model] ?? 0, off);
      if (off > POSE_LIMIT[model]) fail(`a limb ${off.toFixed(1)}° off Gene's`);
    }
    if (ok) clean++;
  }
  console.log(`  motion coverage: ${clean} of ${rows.size} motions pass on all three models; farthest limb from Gene's: ${MODELS.map(m => `${m} ${(worst[m] ?? 0).toFixed(1)}°`).join(', ')}`);
  for (const model of MODELS) if (said[model].size) console.log(`  ${model}: parts the motions cannot move (the model has not): ${[...said[model]].sort().join(' ')}`);
  assert.deepEqual(problems, []);
  assert.equal(said.gene.size + said['renamed-pmx'].size, 0, 'Gene and the renamed PMX lose nothing');
});
