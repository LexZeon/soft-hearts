// Maintainer helper for the pose-sensing component manifest (electron/pose/manifest.ts).
// Prints size + SHA-256 for every file the manifest keeps, read from an already-extracted copy:
//   node scripts/pose-component-hashes.mjs <node_modules dir with onnxruntime-node + onnxruntime-common> <models dir>
// The models dir holds det_rtmdet_nano.onnx and pose_rtmpose_m_256x192.onnx (the end2end.onnx files from the
// OpenMMLab zips, renamed). Read-only: it never downloads or writes anything.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const [modules, models] = process.argv.slice(2);
if (!modules || !models) throw new Error('usage: pose-component-hashes.mjs <node_modules> <models>');
const entry = (base, rel) => {
  const file = path.join(base, rel);
  const data = readFileSync(file);
  return { path: rel.replaceAll('\\', '/'), size: statSync(file).size, sha256: createHash('sha256').update(data).digest('hex') };
};
const out = { node: { common: [], 'win32-arm64': [], 'win32-x64': [] }, common: [], models: [] };
const node = path.join(modules, 'onnxruntime-node');
for (const rel of ['package.json', ...readdirSync(path.join(node, 'dist')).filter(f => f.endsWith('.js')).map(f => `dist/${f}`)])
  out.node.common.push(entry(node, rel));
for (const arch of ['arm64', 'x64'])
  for (const f of ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll'])
    out.node[`win32-${arch}`].push(entry(node, `bin/napi-v6/win32/${arch}/${f}`));
const common = path.join(modules, 'onnxruntime-common');
for (const rel of ['package.json', 'dist/cjs/package.json', ...readdirSync(path.join(common, 'dist', 'cjs')).filter(f => f.endsWith('.js')).map(f => `dist/cjs/${f}`)])
  out.common.push(entry(common, rel));
for (const f of ['det_rtmdet_nano.onnx', 'pose_rtmpose_m_256x192.onnx']) out.models.push(entry(models, f));
console.log(JSON.stringify(out, null, 1));
