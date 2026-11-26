#!/usr/bin/env node
// Point imports at the file that now defines the names (overhaul plan section 8; docs/claude/2026-11-16-overhaul-foundation.md).
// When a type moves out of a hub file (shared/contracts.ts) into a smaller one (shared/foundation/settings.ts) and the hub keeps a
// re-export for compatibility, its importers still compile, but they still depend on the hub. This rewrites, symbol by symbol:
//   node scripts/dev/retarget-imports.mjs --from shared/contracts.ts --to shared/foundation/settings.ts [--to ...] [--exclude a,b] [--dry-run]
// For every `import { ... } from '<from>'` / `import type { ... }` / `export { ... } from` / `export type { ... } from` statement in
// electron/ shared/ src/ tests/ scripts/ whose names ALL live in the --to files (their own `export` declarations and re-exports),
// the specifier is rewritten to the --to file (split into one statement per --to file when the names live in several). A statement
// that also names anything else, a default or namespace import, `export *`, or a clause with a comment in it is left alone.
// The specifier style is kept (with or without extension, .js for .ts); line endings and every other byte stay as they were.
// A part's public page (overhaul step "parts in folders", docs/claude/2026-11-16-overhaul-parts-1.md):
//   node scripts/dev/retarget-imports.mjs --index electron/cards/index.ts --outside-part cards [--dry-run]
// For every `export { ... } from './x'` / `export type { ... } from` in the index, the source files (electron/ shared/ src/, not tests
// or scripts) of other parts, the wiring and the contract that import those names from x are pointed at the index; files of the part
// keep their direct imports. Only names the index re-exports from that very file count, so a name never switches to another binding.
// An extensionless specifier becomes the folder ('../cards'); inline type queries `import('../x').Name` are rewritten too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { maskCode, parseImports, resolveImport } from './structure-inventory.mjs';
import { assignPart } from './structure-parts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
const ROOTS = ['electron/', 'shared/', 'src/', 'tests/', 'scripts/'];
const CODE = /\.(?:ts|tsx|mts|mjs|js)$/;
const RESOLVABLE = /\.(?:ts|tsx|mts|mjs|js|json|css)$/;

function walk(root, dir, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}${e.name}`;
    if (e.isDirectory()) walk(root, `${rel}/`, out);
    else if (RESOLVABLE.test(e.name)) out.push(rel);
  }
}

/** The names a module exports by name: declarations, `export { a, b as c }` and `export { ... } from` (not `export *`). */
export function exportedNames(source) {
  const code = maskCode(source);
  const names = new Set();
  for (const m of code.matchAll(/(?:^|[;\n}])\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:type|interface|const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:^|[;\n}])\s*export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const t = piece.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const as = t.match(/\sas\s+([A-Za-z_$][\w$]*)$/);
      names.add(as ? as[1] : t);
    }
  }
  return names;
}

// The boundary before a statement is looked behind, not consumed: `import a from 'x'; import b from 'y';` on one line is two statements.
const STATEMENT_RE = /(?<=^|[;\n}])(\s*)(import|export)(\s+type)?(\s*)(\{[^}]*\})(\s*)from(\s*)(['"])([^'"\n]+)\8(;?)/g;

/** The specifier from `fromFile` to `toFile`, in the style of the old specifier `oldSpec` (extension, .js, leading ./). */
export function specifierLike(oldSpec, fromFile, toFile) {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const ext = path.posix.extname(toFile);
  const bare = rel.slice(0, rel.length - ext.length);
  const oldExt = (oldSpec.match(/\.(?:ts|tsx|mts|js|mjs)$/) ?? [''])[0];
  if (!oldExt && /(?:^|\/)index$/.test(bare)) return bare.replace(/\/?index$/, '') || '.';
  if (!oldExt) return bare;
  if (oldExt === '.js' && /\.tsx?$/.test(ext)) return `${bare}.js`;
  if (oldExt === '.mjs' && ext === '.mts') return `${bare}.mjs`;
  return `${bare}${ext}`;
}

/**
 * Rewrite one file's statements that import from `fromFile`. `owners` maps each name to the --to file that exports it.
 * Returns { text, edits: [{ line, before, after }], skipped: [{ line, why }] } (text unchanged when nothing applies).
 */
export function retargetSource(source, file, fromFile, owners, fileSet) {
  const code = maskCode(source, { keepStrings: true });
  const edits = [];
  const skipped = [];
  let out = '';
  let last = 0;
  const lineOf = (i) => source.slice(0, i).split('\n').length;
  for (const m of code.matchAll(STATEMENT_RE)) {
    const spec = m[9];
    if (resolveImport(file, spec, fileSet) !== fromFile) continue;
    const start = m.index + m[0].search(/\b(?:import|export)\b/);
    const end = m.index + m[0].length;
    const original = source.slice(start, end);
    const clause = m[5];
    const clauseAt = m.index + m[0].indexOf(clause);
    if (source.slice(clauseAt, clauseAt + clause.length) !== clause) { skipped.push({ line: lineOf(start), why: 'a comment inside the braces' }); continue; }
    const pieces = clause.slice(1, -1).split(',').map((p) => p.trim()).filter(Boolean);
    const groups = new Map();
    let foreign = null;
    for (const piece of pieces) {
      const name = piece.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      const owner = owners.get(name);
      if (!owner) { foreign = name; break; }
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(piece);
    }
    if (foreign) { skipped.push({ line: lineOf(start), why: `${foreign} still lives in ${fromFile}` }); continue; }
    if (!groups.size) continue;
    let replacement;
    if (groups.size === 1) {
      const [owner] = groups.keys();
      const specAt = start + original.lastIndexOf(spec);
      replacement = source.slice(start, specAt) + specifierLike(spec, file, owner) + source.slice(specAt + spec.length, end);
    } else {
      const eol = source.includes('\r\n') ? '\r\n' : '\n';
      const indent = m[1].replace(/^[\r\n]+/, '').split(/\r?\n/).pop();
      const quote = m[8];
      const statements = [...groups].map(([owner, list]) => `${m[2]}${m[3] ?? ''} { ${list.join(', ')} } from ${quote}${specifierLike(spec, file, owner)}${quote}${m[10]}`);
      replacement = statements.join(`${eol}${indent}`);
    }
    out += source.slice(last, start) + replacement;
    last = end;
    edits.push({ line: lineOf(start), before: original.replace(/\s+/g, ' '), after: replacement.replace(/\s+/g, ' ') });
  }
  const text = edits.length ? out + source.slice(last) : source;
  return retargetInlineTypes(text, file, fromFile, owners, fileSet, edits, skipped);
}

const INLINE_TYPE_RE = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)\.([A-Za-z_$][\w$]*)/g;

/** `import('<from>').Name` type queries whose Name lives in a --to file: point the specifier at that file. */
function retargetInlineTypes(source, file, fromFile, owners, fileSet, edits, skipped) {
  const code = maskCode(source, { keepStrings: true });
  const lineOf = (i) => source.slice(0, i).split('\n').length;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(INLINE_TYPE_RE)) {
    const spec = m[2];
    if (resolveImport(file, spec, fileSet) !== fromFile) continue;
    const owner = owners.get(m[3]);
    if (!owner) { skipped.push({ line: lineOf(m.index), why: `${m[3]} still lives in ${fromFile}` }); continue; }
    const specAt = m.index + m[0].indexOf(m[1]) + 1;
    const next = specifierLike(spec, file, owner);
    out += source.slice(last, specAt) + next;
    last = specAt + spec.length;
    edits.push({ line: lineOf(m.index), before: m[0], after: m[0].replace(spec, next) });
  }
  return { text: last ? out + source.slice(last) : source, edits, skipped };
}

/** The names `indexFile` re-exports from each file: Map<resolved file, Set<name>> (only `export { a } from`, not renames or `*`). */
export function indexReexports(root, indexFile, fileSet) {
  const code = maskCode(fs.readFileSync(path.join(root, indexFile), 'utf8'), { keepStrings: true });
  const out = new Map();
  for (const m of code.matchAll(/(?:^|[;\n}])\s*export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g)) {
    const target = resolveImport(indexFile, m[3], fileSet);
    if (!target) throw new Error(`${indexFile}: cannot resolve ${m[3]}`);
    if (!out.has(target)) out.set(target, new Set());
    for (const piece of m[1].split(',')) {
      const t = piece.trim().replace(/^type\s+/, '');
      if (t && !/\sas\s/.test(t)) out.get(target).add(t);
    }
  }
  return out;
}

/**
 * Point the importers outside `part` at the part's public page `indexFile`, file by file of what it re-exports.
 * Returns { files: [{ file, edits, skipped, from }], movedOff } like retargetRepo.
 */
export function retargetToIndex({ root = DEFAULT_ROOT, indexFile, part, dryRun = false }) {
  const all = [];
  for (const r of ROOTS) walk(root, r, all);
  const fileSet = new Set(all);
  const results = [];
  let movedOff = 0;
  for (const [from, names] of indexReexports(root, indexFile, fileSet)) {
    const owners = new Map([...names].map((n) => [n, indexFile]));
    const r = retargetRepo({ root, from, to: [indexFile], owners, dryRun, only: (f) => /^(?:electron|shared|src)\//.test(f) && assignPart(f) !== part });
    movedOff += r.movedOff;
    for (const f of r.files) results.push({ ...f, from });
  }
  return { files: results, movedOff };
}

/** Run over the repo. Returns { files: [{ file, edits, skipped, stillImports }], movedOff: n }. */
export function retargetRepo({ root = DEFAULT_ROOT, from, to, exclude = [], dryRun = false, owners: givenOwners = null, only = null }) {
  const all = [];
  for (const r of ROOTS) walk(root, r, all);
  const fileSet = new Set(all);
  const owners = givenOwners ?? new Map();
  if (!givenOwners) for (const target of to) {
    for (const name of exportedNames(fs.readFileSync(path.join(root, target), 'utf8'))) if (!owners.has(name)) owners.set(name, target);
  }
  const results = [];
  let movedOff = 0;
  for (const file of all) {
    if (!CODE.test(file) || file === from || to.includes(file) || exclude.includes(file) || (only && !only(file))) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (!source.includes(path.posix.basename(from).replace(/\.\w+$/, ''))) continue;
    const r = retargetSource(source, file, from, owners, fileSet);
    if (!r.edits.length && !r.skipped.length) continue;
    const stillImports = parseImports(r.text).some((imp) => resolveImport(file, imp.spec, fileSet) === from);
    if (r.edits.length && !stillImports) movedOff++;
    if (r.edits.length && !dryRun) fs.writeFileSync(path.join(root, file), r.text);
    results.push({ file, edits: r.edits, skipped: r.skipped, stillImports });
  }
  return { files: results, movedOff };
}

function parseArgs(argv) {
  const o = { to: [], exclude: [], dryRun: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') o.from = argv[++i];
    else if (a === '--to') o.to.push(argv[++i]);
    else if (a === '--exclude') o.exclude.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--root') o.root = path.resolve(argv[++i]);
    else if (a === '--index') o.index = argv[++i];
    else if (a === '--outside-part') o.part = argv[++i];
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = parseArgs(process.argv.slice(2));
  const indexMode = !!(o.index || o.part);
  if (indexMode ? !(o.index && o.part) : !o.from || !o.to.length) {
    console.error('usage: retarget-imports.mjs --from <file> --to <file> [--to ...] [--exclude a,b] [--dry-run]\n       retarget-imports.mjs --index <part folder>/index.ts --outside-part <part id> [--dry-run]');
    process.exit(2);
  }
  const { files, movedOff } = indexMode ? retargetToIndex({ root: o.root, indexFile: o.index, part: o.part, dryRun: o.dryRun }) : retargetRepo(o);
  let edits = 0;
  for (const f of files) {
    for (const e of f.edits) { edits++; console.log(`${f.file}:${e.line}  ${e.before}  ->  ${e.after}`); }
    for (const s of f.skipped) console.log(`${f.file}:${s.line}  left: ${s.why}`);
  }
  const touched = files.filter((f) => f.edits.length).length;
  console.log(`${o.dryRun ? '[dry run] ' : ''}${edits} statements in ${touched} files rewritten; ${movedOff} files no longer import ${indexMode ? `what ${o.index} re-exports` : o.from}; ${files.filter((f) => f.stillImports).length} files still do.`);
}
