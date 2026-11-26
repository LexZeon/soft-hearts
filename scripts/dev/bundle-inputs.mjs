#!/usr/bin/env node
// Which source files each bundle includes (overhaul plan section 8; docs/claude/2026-11-16-overhaul-parts-1.md section 6.1,
// docs/claude/2026-11-16-overhaul-parts-2.md). A part's public page (index.ts) re-exports a whole side of the part, so importing
// through it can pull that side into a small, separately bundled entry (a preload, a worker, the Unbound page). Moving files must not.
//   node scripts/dev/bundle-inputs.mjs                       build in memory and print every bundle: source files and size
//   node scripts/dev/bundle-inputs.mjs --save <file>         ... and write them as a baseline (json; records the git commit)
//   node scripts/dev/bundle-inputs.mjs --compare <file>      ... and print, per bundle, the source files added and removed since the
//                                                            baseline, after following the renames git sees since its commit
//   --only electron|vite                                     build one side only (the electron side takes seconds, vite a minute)
//   --strict                                                 with --compare: exit 1 when any bundle gained a source file
// Electron side: the esbuild entries of scripts/build-electron.mjs (read from its text, same options, metafile, nothing written).
// Renderer side: vite build with write off; every output chunk (keyed by its name, without the hash) and css asset.
// Source files are repo paths under electron/ shared/ src/ (and root html); node_modules is counted per bundle, not listed.
// Nothing is written but the --save file; builds happen in memory. Behaviour of the app is not touched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** The esbuild entry points and externals written in scripts/build-electron.mjs (the same text the build tests read). */
export function parseElectronBuild(text) {
  const start = text.indexOf('entryPoints:');
  if (start < 0) throw new Error('build-electron.mjs: no entryPoints');
  const open = text.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < text.length; end++) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}' && --depth === 0) break;
  }
  const body = text.slice(open + 1, end).replace(/\/\/[^\n]*/g, '');
  const entries = {};
  for (const m of body.matchAll(/"?([\w-]+)"?\s*:\s*"([^"]+)"/g)) entries[m[1]] = m[2];
  const ext = /external:\s*\[([^\]]*)\]/.exec(text);
  const external = ext ? [...ext[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  const target = /target:\s*"([^"]+)"/.exec(text)?.[1] ?? 'node22';
  return { entries, external, target };
}

/** A bundle's inputs as repo-relative forward-slash paths; node_modules inputs are only counted. */
export function splitInputs(ids, root = ROOT) {
  const sources = new Set();
  let packages = 0;
  for (const raw of ids) {
    if (!raw || raw.startsWith('\0')) continue;
    const id = raw.replace(/\?.*$/, '');
    const rel = (path.isAbsolute(id) ? path.relative(root, id) : id).replace(/\\/g, '/');
    if (rel.includes('node_modules/')) { packages++; continue; }
    if (rel.startsWith('..')) continue;
    sources.add(rel);
  }
  return { sources: [...sources].sort(), packages };
}

async function electronBundles() {
  const { build } = await import('esbuild');
  const { entries, external, target } = parseElectronBuild(fs.readFileSync(path.join(ROOT, 'scripts', 'build-electron.mjs'), 'utf8'));
  const result = await build({
    entryPoints: entries, bundle: true, platform: 'node', target, format: 'cjs', outdir: path.join(ROOT, 'dist-electron'),
    outExtension: { '.js': '.cjs' }, external, write: false, metafile: true, logLevel: 'silent', absWorkingDir: ROOT,
  });
  const out = {};
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    if (!info.entryPoint) continue;
    const name = path.basename(file).replace(/\.cjs$/, '');
    out[`electron:${name}`] = { bytes: info.bytes, ...splitInputs(Object.keys(info.inputs)) };
  }
  return out;
}

async function viteBundles() {
  const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href).catch(() => import('vite'));
  const results = await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
  const outputs = (Array.isArray(results) ? results : [results]).flatMap((r) => r.output ?? []);
  const out = {};
  const taken = new Map();
  for (const o of outputs) {
    if (o.type === 'chunk') {
      const base = `vite:${o.name}${o.isEntry ? '' : '-chunk'}`;
      const n = (taken.get(base) ?? 0) + 1;
      taken.set(base, n);
      const ids = o.moduleIds ?? Object.keys(o.modules ?? {});
      out[n === 1 ? base : `${base}#${n}`] = { bytes: Buffer.byteLength(o.code), ...splitInputs(ids) };
    } else if (o.fileName.endsWith('.css')) {
      const base = `vite-css:${o.fileName.replace(/^.*\//, '').replace(/-[\w-]{8}\.css$/, '.css')}`;
      const n = (taken.get(base) ?? 0) + 1;
      taken.set(base, n);
      const bytes = typeof o.source === 'string' ? Buffer.byteLength(o.source) : o.source.length;
      out[n === 1 ? base : `${base}#${n}`] = { bytes, sources: [], packages: 0 };
    }
  }
  return out;
}

/**
 * What changed per bundle between two snapshots. `renames` maps old repo paths to new ones (files moved since the baseline): an old
 * input that was moved counts as the same file. Returns one row per bundle that changed in files or size, plus the bundles only one
 * side has.
 */
export function compareBundles(before, after, renames = {}) {
  const rows = [];
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const name of names) {
    const a = before[name];
    const b = after[name];
    if (!a || !b) { rows.push({ name, only: a ? 'before' : 'after', bytes: (b ?? a).bytes }); continue; }
    const was = new Set(a.sources.map((s) => renames[s] ?? s));
    const now = new Set(b.sources);
    const added = [...now].filter((s) => !was.has(s)).sort();
    const removed = [...was].filter((s) => !now.has(s)).sort();
    const bytesDelta = b.bytes - a.bytes;
    const packagesDelta = (b.packages ?? 0) - (a.packages ?? 0);
    if (added.length || removed.length || bytesDelta || packagesDelta) rows.push({ name, added, removed, bytesDelta, packagesDelta, bytes: b.bytes });
  }
  return rows;
}

/** Renames git sees between a commit and the working tree: { old: new }. */
export function parseRenames(nameStatus) {
  const map = {};
  for (const line of nameStatus.split(/\r?\n/)) {
    const m = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line.trim());
    if (m) map[m[1]] = m[2];
  }
  return map;
}

function gitRenames(commit) {
  if (!commit) return {};
  try {
    return parseRenames(execFileSync('git', ['diff', '-M50%', '--name-status', '--diff-filter=R', commit, '--', 'electron', 'shared', 'src'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }));
  } catch { return {}; }
}

function headCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const only = arg('--only');
  const bundles = {};
  if (only !== 'vite') Object.assign(bundles, await electronBundles());
  if (only !== 'electron') Object.assign(bundles, await viteBundles());
  const save = arg('--save');
  const compare = arg('--compare');
  if (save) {
    fs.mkdirSync(path.dirname(path.resolve(save)), { recursive: true });
    fs.writeFileSync(save, JSON.stringify({ commit: headCommit(), savedAt: new Date().toISOString(), bundles }, null, 1) + '\n');
    console.log(`saved ${Object.keys(bundles).length} bundles to ${save}`);
  }
  if (!compare) {
    for (const [name, b] of Object.entries(bundles)) console.log(`${name.padEnd(40)} ${String(b.sources.length).padStart(4)} source files  ${String(b.packages).padStart(4)} package modules  ${kb(b.bytes)}`);
    return 0;
  }
  const base = JSON.parse(fs.readFileSync(compare, 'utf8'));
  const beforeAll = base.bundles;
  const before = only ? Object.fromEntries(Object.entries(beforeAll).filter(([k]) => (only === 'vite' ? k.startsWith('vite') : k.startsWith('electron:')))) : beforeAll;
  const renames = gitRenames(base.commit);
  const rows = compareBundles(before, bundles, renames);
  console.log(`compared with ${compare} (commit ${base.commit?.slice(0, 8) ?? '?'}, ${Object.keys(renames).length} renames followed)`);
  if (!rows.length) console.log('every bundle has the same source files and size');
  let gained = false;
  for (const r of rows) {
    if (r.only) { console.log(`${r.name}: only ${r.only} (${kb(r.bytes)})`); if (r.only === 'after') gained = true; continue; }
    const sign = r.bytesDelta >= 0 ? '+' : '';
    console.log(`${r.name}: ${sign}${r.bytesDelta} bytes (${kb(r.bytes)}), +${r.added.length} -${r.removed.length} source files${r.packagesDelta ? `, packages ${r.packagesDelta > 0 ? '+' : ''}${r.packagesDelta}` : ''}`);
    for (const s of r.added) console.log(`    + ${s}`);
    for (const s of r.removed) console.log(`    - ${s}`);
    if (r.added.length || r.packagesDelta > 0) gained = true;
  }
  return argv.includes('--strict') && gained ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 2; });
}
