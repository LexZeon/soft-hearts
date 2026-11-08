/** Maintainer-only offline converter. It never downloads, executes, or publishes assets. */
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { retargetBvhToGene } from './lib/bvh-to-gene.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOptions = new Set(['--input', '--output', '--model', '--start-frame', '--end-frame', '--loop-blend-seconds', '--root-mode', '--source-up-axis']);
const flags = new Set(['--upper-body-only', '--keep-source-facing', '--overwrite']);
const options = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if ((!valueOptions.has(key) && !flags.has(key)) || options.has(key)) throw new Error(`Unknown or duplicate option: ${key}`);
  if (flags.has(key)) options.set(key, true);
  else {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options.set(key, value);
  }
}
if (!options.has('--input') || !options.has('--output')) throw new Error('Usage: node scripts/retarget-gene-motions.mjs --input source.bvh --output gene.vmd [--start-frame N --end-frame N --loop-blend-seconds 0.5 --upper-body-only]');
const input = path.resolve(options.get('--input'));
const output = path.resolve(options.get('--output'));
if (path.extname(input).toLowerCase() !== '.bvh' || path.extname(output).toLowerCase() !== '.vmd' || input === output) throw new Error('Use separate .bvh input and .vmd output files.');
const reportPath = output.replace(/\.vmd$/i, '.conversion.json');
if (!options.has('--overwrite')) {
  for (const destination of [output, reportPath]) {
    let exists = true;
    try { await access(destination); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (exists) throw new Error(`Output already exists: ${destination}. Pass --overwrite only after reviewing it.`);
  }
}
const model = options.has('--model') ? path.resolve(options.get('--model')) : path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx');
const source = await readFile(input);
const modelBytes = await readFile(model);
const pmx = new MMDParser.Parser().parsePmx(modelBytes.buffer.slice(modelBytes.byteOffset, modelBytes.byteOffset + modelBytes.byteLength), true);
const numeric = key => options.has(key) ? Number(options.get(key)) : undefined;
const converted = retargetBvhToGene(source.toString('utf8'), pmx.bones, {
  startFrame: numeric('--start-frame'), endFrame: numeric('--end-frame'),
  loopBlendSeconds: numeric('--loop-blend-seconds'),
  rootMode: options.get('--root-mode'), sourceUpAxis: options.get('--source-up-axis'),
  upperBodyOnly: options.has('--upper-body-only'), faceForward: !options.has('--keep-source-facing'),
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, converted.bytes, { flag: options.has('--overwrite') ? 'w' : 'wx' });
await writeFile(reportPath, `${JSON.stringify({
  schemaVersion: 1, converter: 'soft hearts BVH-to-Gene v1',
  inputFile: path.basename(input), inputSha256: hash(source),
  targetModelSha256: hash(modelBytes), outputFile: path.basename(output), outputSha256: hash(converted.bytes),
  ...converted.report,
  licenseNote: 'Conversion does not change the source license. Distribute the original author attribution, license URL, source URL and this adaptation description with the motion.',
}, null, 2)}\n`, { flag: options.has('--overwrite') ? 'w' : 'wx' });
console.log(JSON.stringify({ output, reportPath, bytes: converted.bytes.length, ...converted.report }, null, 2));
