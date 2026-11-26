#!/usr/bin/env node
// What a part shows the rest of the program (overhaul plan section 8; docs/claude/2026-11-16-overhaul-parts-1.md).
//   node scripts/dev/part-surface.mjs --part cards            per file of the part: the names other parts, the wiring and the contract
//                                                             import from it, each marked type or value, and who imports them
//   node scripts/dev/part-surface.mjs --part cards --draft    a draft index.ts per side (electron / shared / src), to edit by hand
//   node scripts/dev/part-surface.mjs --part cards --json     the same as data
// Read from the inventory (scripts/dev/structure-inventory.mjs): only source files count; tests and scripts may keep importing internals.
// Imports from inside the part, css side-effect imports and imports of wiring files (a public page must not import wiring) are left out.
// Type or value: read from the declaring file with the TypeScript parser, following `export { } from` and local imports; `export type`
// is what a public page needs for a type under isolatedModules (tsx, esbuild and vite compile one file at a time).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { buildInventory, resolveImport } from './structure-inventory.mjs';
import { isWiring, isPublicPage, PART_FOLDERS } from './structure-parts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
const CODE = /\.(?:ts|tsx|mts|mjs|js)$/;

/** 'type' | 'value' | null (not found) for an exported name of a repo file, following re-exports and imports. */
export function exportKind(root, file, name, fileSet, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  let text;
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isExported = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
  const follow = (spec, inner) => { const to = resolveImport(file, spec, fileSet); return to ? exportKind(root, to, inner, fileSet, seen) : null; };
  const local = (inner) => {
    for (const st of sf.statements) {
      if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name.text === inner) return 'type';
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === inner) return 'value';
      if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === inner)) return 'value';
      if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
        const c = st.importClause;
        if (c.name?.text === inner) return c.isTypeOnly ? 'type' : 'value';
        const b = c.namedBindings;
        if (b && ts.isNamedImports(b)) for (const el of b.elements) {
          if (el.name.text !== inner) continue;
          if (c.isTypeOnly || el.isTypeOnly) return 'type';
          return follow(st.moduleSpecifier.text, (el.propertyName ?? el.name).text) ?? 'value';
        }
        if (b && ts.isNamespaceImport(b) && b.name.text === inner) return 'value';
      }
    }
    return null;
  };
  for (const st of sf.statements) {
    if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && isExported(st) && st.name.text === name) return 'type';
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && isExported(st) && st.name?.text === name) return 'value';
    if (ts.isVariableStatement(st) && isExported(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) return 'value';
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const inner = (el.propertyName ?? el.name).text;
        if (st.isTypeOnly || el.isTypeOnly) return 'type';
        if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) return follow(st.moduleSpecifier.text, inner) ?? 'value';
        return local(inner) ?? 'value';
      }
    }
  }
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const kind = follow(st.moduleSpecifier.text, name);
      if (kind) return st.isTypeOnly ? 'type' : kind;
    }
  }
  return null;
}

/**
 * Every module reference in a source file, read with the TypeScript parser:
 * [{ spec, kind: "import"|"export"|"export-star"|"side-effect"|"namespace"|"default"|"inline-type"|"dynamic", names: [inner names], line }].
 * inner names are the names as the target exports them (`import { a as b }` gives a).
 */
export function moduleRefs(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const c = node.importClause;
      if (!c) refs.push({ spec, kind: "side-effect", names: [], line: lineOf(node) });
      else {
        if (c.name) refs.push({ spec, kind: "default", names: [], line: lineOf(node) });
        const b = c.namedBindings;
        if (b && ts.isNamespaceImport(b)) refs.push({ spec, kind: "namespace", names: [], line: lineOf(node) });
        if (b && ts.isNamedImports(b)) refs.push({ spec, kind: "import", names: b.elements.map((el) => (el.propertyName ?? el.name).text), line: lineOf(node) });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) refs.push({ spec, kind: "export", names: node.exportClause.elements.map((el) => (el.propertyName ?? el.name).text), line: lineOf(node) });
      else refs.push({ spec, kind: "export-star", names: [], line: lineOf(node) });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const q = node.qualifier;
      const first = q ? (ts.isIdentifier(q) ? q.text : q.left && ts.isIdentifier(q.left) ? q.left.text : null) : null;
      refs.push({ spec: node.argument.literal.text, kind: first ? "inline-type" : "dynamic", names: first ? [first] : [], line: lineOf(node) });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      refs.push({ spec: node.arguments[0].text, kind: "dynamic", names: [], line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/**
 * The surface of a part: { files: [{ file, names: [{ name, kind, importers }], sideEffect: [importers], other: [...] }] }.
 * other lists imports a public page cannot carry: default and namespace imports, `export *`, real dynamic imports and require().
 */
export function partSurface({ root = DEFAULT_ROOT, part, inv = buildInventory(root) }) {
  const fileSet = new Set(inv.records.keys());
  const byFile = new Map();
  const entry = (f) => { if (!byFile.has(f)) byFile.set(f, { file: f, names: new Map(), sideEffect: new Set(), other: [] }); return byFile.get(f); };
  for (const rec of inv.records.values()) {
    if (rec.group !== "source" || rec.part === part || !CODE.test(rec.path)) continue;
    const text = fs.readFileSync(path.join(root, rec.path), "utf8");
    for (const ref of moduleRefs(rec.path, text)) {
      const to = resolveImport(rec.path, ref.spec, fileSet);
      const target = to && inv.records.get(to);
      if (!target || target.part !== part || isWiring(to) || isPublicPage(to, part)) continue;
      const e = entry(to);
      if (ref.kind === "side-effect") { e.sideEffect.add(rec.path); continue; }
      if (!["import", "export", "inline-type"].includes(ref.kind)) { e.other.push({ importer: rec.path, line: ref.line, kind: ref.kind }); continue; }
      for (const n of ref.names) add(e, n, rec.path);
    }
  }
  function add(e, name, importer) {
    if (!e.names.has(name)) e.names.set(name, { name, kind: exportKind(root, e.file, name, fileSet), importers: new Set() });
    e.names.get(name).importers.add(importer);
  }
  const files = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)).map((e) => ({
    file: e.file,
    names: [...e.names.values()].sort((a, b) => a.name.localeCompare(b.name)).map((n) => ({ name: n.name, kind: n.kind, importers: [...n.importers].sort() })),
    sideEffect: [...e.sideEffect].sort(),
    other: e.other,
  }));
  return { part, files };
}

/** The side folder of a file among the part's folders (the longest that contains it), else the side root ('electron/'...). */
function sideFolder(file, folders) {
  const hit = folders.filter((f) => file.startsWith(f)).sort((a, b) => b.length - a.length)[0];
  return hit ?? null;
}

/** Draft index.ts texts: { '<folder>index.ts': text }. Each re-export points at the file; types with `export type`. */
export function draftIndexes(surface, folders) {
  const out = {};
  for (const f of surface.files) {
    const folder = sideFolder(f.file, folders) ?? `${f.file.split('/')[0]}/?/`;
    const indexFile = `${folder}index.ts`;
    let spec = path.posix.relative(folder.replace(/\/$/, ''), f.file).replace(/\.(?:ts|tsx|mts)$/, '');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    const values = f.names.filter((n) => n.kind !== 'type').map((n) => n.name);
    const types = f.names.filter((n) => n.kind === 'type').map((n) => n.name);
    const lines = [];
    const who = [...new Set(f.names.flatMap((n) => n.importers))];
    lines.push(`// ${f.file}: used by ${who.join(', ')}`);
    if (values.length) lines.push(`export { ${values.join(', ')} } from '${spec}';`);
    if (types.length) lines.push(`export type { ${types.join(', ')} } from '${spec}';`);
    for (const n of f.names.filter((x) => x.kind === null)) lines.push(`// NOT FOUND, check by hand: ${n.name}`);
    for (const o of f.other) lines.push(`// left direct: ${o.kind} in ${o.importer}:${o.line}`);
    if (f.sideEffect.length) lines.push(`// side-effect imports stay direct: ${f.sideEffect.join(', ')}`);
    (out[indexFile] ??= []).push(lines.join('\n'));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.join('\n\n')}\n`]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const part = args[args.indexOf('--part') + 1];
  if (!args.includes('--part') || !part) { console.error('usage: part-surface.mjs --part <id> [--draft] [--json]'); process.exit(2); }
  const surface = partSurface({ part });
  if (args.includes('--json')) console.log(JSON.stringify(surface, null, 1));
  else if (args.includes('--draft')) {
    for (const [file, text] of Object.entries(draftIndexes(surface, PART_FOLDERS[part] ?? []))) console.log(`===== ${file}\n${text}`);
  } else {
    for (const f of surface.files) {
      console.log(f.file);
      for (const n of f.names) console.log(`  ${n.kind ?? '??'.padEnd(5)} ${n.name}  <- ${n.importers.join(', ')}`);
      for (const o of f.other) console.log(`  (${o.kind}) <- ${o.importer}:${o.line}`);
      if (f.sideEffect.length) console.log(`  (side effect) <- ${f.sideEffect.join(', ')}`);
    }
  }
}
