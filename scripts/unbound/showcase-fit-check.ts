// Development (round 16): what the showcase measures on a model to fit it (head extent, slot reach, the distance scale and the
// per-slot strength factors), read only. Prints JSON. Gene's numbers are the reference constants in model-fit.ts.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-fit-check.ts [model.pmx]
import { StageModelProfile } from '../../src/stage/model-profile';
import { MORPH_SLOTS, type MorphSlot } from '../../shared/foundation/universal-skeleton';
import { fitModel } from '../../src/unbound/showcase/model-fit';
import { geneFigure } from '../../tests/helpers/unbound-gene';

const { fixture, figure } = await geneFigure({ modelPath: process.argv[2] });
try {
  const profile = new StageModelProfile(fixture.mesh, { reviewed: true }).profile;
  const map: Partial<Record<MorphSlot, number>> = {};
  for (const slot of MORPH_SLOTS) { const entry = profile?.morphs[slot]; if (entry) map[slot] = entry.index; }
  const fit = fitModel(fixture.mesh, map);
  const round = (o: Record<string, number | undefined>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? v : +v.toFixed(4)]));
  console.log(JSON.stringify({ headExtentM: +fit.headExtentM.toFixed(4), distanceScale: +fit.distanceScale.toFixed(3), slotReach: round(fit.slotReach), slotGain: round(fit.slotGain) }, null, 1));
} finally { figure.dispose(); fixture.close(); }
