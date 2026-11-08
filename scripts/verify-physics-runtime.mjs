import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = [
  ['ammo.wasm.js', 393768, '3fa63c584d4732f72b954c5ea105f1faca99559c95c57ce7bb738d3497f98228'],
  ['ammo.wasm.wasm', 651386, '16be07b989963bddebfef66eab28a4387536eb37014d9df1531dab380bd96a93'],
];

/** Only the reviewed unmodified runtime in pinned three@0.170.0 is packaged. */
export async function verifyPhysicsRuntime() {
  const info = JSON.parse(await readFile(path.join(root, 'node_modules/three/package.json'), 'utf8'));
  if (info.version !== '0.170.0') throw new Error('Physics runtime requires reviewed three@0.170.0.');
  for (const [name, size, expected] of resources) {
    const bytes = await readFile(path.join(root, 'node_modules/three/examples/jsm/libs', name));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== size || actual !== expected) throw new Error(`Physics runtime asset differs from reviewed bytes: ${name}`);
  }
  const notice = await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  if (!notice.includes('Ammo.js and Bullet local physics runtime') || !notice.includes('Copyright (c) 2011 ammo.js contributors')
      || !notice.includes('Erwin Coumans') || !notice.includes('This software is provided')) {
    throw new Error('Physics runtime distribution notices are incomplete.');
  }
}
