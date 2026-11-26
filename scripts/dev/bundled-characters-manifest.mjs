#!/usr/bin/env node
// Writes shared/cards/bundled-characters.json: the checked file list (bytes, sha256) of the preinstalled characters' models that live
// under assets/bundled/<folder>/ (One: a VRM; Mumi: a PMX with its tex/ folder). Gene has its own manifest (shared/actions/bundled-assets.json).
// Run after replacing a model file: node scripts/dev/bundled-characters-manifest.mjs   (tests/bundled-characters.test.ts checks the file matches the bytes)
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLED = path.join(ROOT, 'assets', 'bundled');
const describe = rel => {
  const bytes = readFileSync(path.join(BUNDLED, rel));
  return { path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const list = dir => readdirSync(path.join(BUNDLED, dir), { withFileTypes: true }).filter(e => e.isFile()).map(e => `${dir}/${e.name}`).sort();
const models = [
  { key: 'bundled:one', name: 'One', model: 'one/one.vrm', files: ['one/one.vrm'] },
  { key: 'bundled:mumi', name: 'Mumi', model: 'mumi/model.pmx', files: ['mumi/model.pmx', ...list('mumi/tex')] },
].map(m => ({ key: m.key, name: m.name, model: m.model, files: m.files.map(describe) }));
const out = path.join(ROOT, 'shared', 'cards', 'bundled-characters.json');
writeFileSync(out, JSON.stringify({ schemaVersion: 1, models }, null, 2) + '\n');
console.log('wrote', path.relative(ROOT, out), models.map(m => `${m.key}: ${m.files.length} files`).join(', '));
