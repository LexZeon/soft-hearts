/**
 * Development command line for the VRM → PMX converter (electron/stage/model-import/vrm/, README there).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/model-lab/vrm-to-pmx.mts <in.vrm> <out-dir> [--mapping <file>] [--no-physics]
 *
 * Writes <out-dir>/model.pmx, <out-dir>/tex/*, <out-dir>/conversion-report.json (the report holds the full mapping used; edit
 * it and pass the file back with --mapping to convert again). Reads only the input and the mapping; writes only below
 * <out-dir>, and refuses an <out-dir> inside this repository or OneDrive (converted models are private: never committed, never
 * synced; the model lab's own path guard, scripts/model-lab/guard.ts). No network (blocked), no Electron, no app profile.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { convertVrmToPmx, VrmImportError } from '../../electron/stage/model-import/vrm/index.ts';
import { blockNetwork, defaultPathContext, privatePathProblem } from './guard.ts';

const USAGE = 'usage: vrm-to-pmx.mts <in.vrm> <out-dir> [--mapping <mapping.json | conversion-report.json>] [--no-physics]';

function main(argv: string[]): number {
  const positional: string[] = [];
  let mappingFile: string | undefined, physics = true;
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--mapping') mappingFile = argv[++k];
    else if (argv[k] === '--no-physics') physics = false;
    else if (argv[k] === '--help' || argv[k] === '-h') { console.log(USAGE); return 0; }
    else positional.push(argv[k]);
  }
  if (positional.length !== 2 || (mappingFile !== undefined && !mappingFile)) { console.error(USAGE); return 2; }
  const [input, outDir] = positional.map(value => path.resolve(value));
  const problem = privatePathProblem(outDir, defaultPathContext());
  if (problem) { console.error(`拒绝写到这里：${problem.message}（转出的模型是私人的，放仓库和 OneDrive 之外）`); return 2; }
  blockNetwork();
  const mapping = mappingFile ? JSON.parse(readFileSync(mappingFile, 'utf8')) : undefined;
  const started = Date.now();
  const result = convertVrmToPmx(new Uint8Array(readFileSync(input)), { mapping, physics });
  mkdirSync(path.join(outDir, 'tex'), { recursive: true });
  writeFileSync(path.join(outDir, 'model.pmx'), result.pmx);
  for (const texture of result.textures) {
    const target = path.resolve(outDir, texture.path);
    if (path.relative(outDir, target).startsWith('..')) throw new Error(`bad texture path ${texture.path}`);
    writeFileSync(target, texture.bytes);
  }
  writeFileSync(path.join(outDir, 'conversion-report.json'), `${JSON.stringify(result.report, null, 2)}\n`, 'utf8');
  const c = result.report.counts;
  console.log(`${path.basename(input)} → ${outDir} (${Date.now() - started} ms)`);
  console.log(`  vertices ${c.vertices}, triangles ${c.triangles}, bones ${c.bones}, morphs ${c.morphs} (${c.groupMorphs} stage names), materials ${c.materials}, textures ${c.textures}, rigid bodies ${c.rigidBodies}, joints ${c.joints}`);
  if (result.report.aPose) console.log(`  arms ${result.report.aPose.beforeDeg.join('/')}° → ${result.report.aPose.afterDeg.join('/')}° below horizontal (target ${result.report.aPose.targetDeg}°)`);
  const unmapped = Object.keys(result.report.morphs.unmapped);
  if (unmapped.length) console.log(`  not mapped: ${unmapped.join(', ')}`);
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof VrmImportError ? `转换失败：${error.message}` : error);
  process.exitCode = 1;
}
