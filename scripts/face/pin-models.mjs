#!/usr/bin/env node
// I-135: print the size and SHA-256 of downloaded face-check model files, for electron/senses/face/manifest.ts (FACE_MODEL_PINS).
// Reads only the files named on the command line; downloads nothing, writes nothing.
//
//   node scripts/face/pin-models.mjs <file.onnx> [<file.onnx> ...]
//
// With --check, compares each file against the pins in electron/senses/face/manifest.ts (by file name) and exits 1 on a mismatch.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const check = args.includes('--check');
const files = args.filter(arg => arg !== '--check');
if (!files.length) {
  console.error('usage: node scripts/face/pin-models.mjs [--check] <file.onnx> [...]');
  process.exit(2);
}

function pinsFromManifest() {
  const manifest = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'electron/senses/face/manifest.ts'), 'utf8');
  const pins = new Map();
  for (const match of manifest.matchAll(/url: `\$\{ZOO\}\/[^`]*?\/([^/`]+\.onnx)`, size: ([\d_]+),\s*sha256: '([0-9a-f]{64})'/g))
    pins.set(match[1], { size: Number(match[2].replaceAll('_', '')), sha256: match[3] });
  return pins;
}

const pins = check ? pinsFromManifest() : null;
let bad = 0;
for (const file of files) {
  const size = statSync(file).size;
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const name = path.basename(file);
  let note = '';
  if (pins) {
    const pin = pins.get(name);
    if (!pin) { note = '  (no pin with this name)'; bad++; }
    else if (pin.size !== size || pin.sha256 !== sha256) { note = '  MISMATCH'; bad++; }
    else note = '  ok';
  }
  console.log(`${name}\tsize ${size.toLocaleString('en-US').replaceAll(',', '_')}\tsha256 ${sha256}${note}`);
}
process.exit(bad ? 1 : 0);
