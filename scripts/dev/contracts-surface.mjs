#!/usr/bin/env node
// The window↔host API surface golden (docs/claude/2026-11-16-contracts-split.md, step 0).
// What every `import … from '…/shared/contracts'` sees, read with the TypeScript type checker (nothing is run):
//   - every name shared/contracts.ts exports, and for each the shape it resolves to (an interface's members with their full types,
//     optional marks and doc comments; a type alias's expanded type), wherever the declaration lives (re-exports are followed);
//   - DesktopAPI flattened: every member, inherited ones included, with its kind (method or property), optional mark, full type
//     and doc comment. Sorted by name, so splitting the interface into per-part slices (`extends`) keeps the golden as it is;
//   - whether any of it is a runtime value (it must not be: the contract is types only, so no bundle includes it).
// Type names are printed as the checker names them (no file paths), so the golden is the same in every checkout.
//   node scripts/dev/contracts-surface.mjs            print a summary (counts)
//   node scripts/dev/contracts-surface.mjs --write    regenerate tests/fixtures/contracts-surface.json (tests/contracts-surface.test.mjs compares)
//   node scripts/dev/contracts-surface.mjs --json     print the golden
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
export const SURFACE_FILE = 'tests/fixtures/contracts-surface.json';
export const CONTRACT = 'shared/contracts.ts';
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature;

/** A program over shared/contracts.ts with the repo's compiler options. */
export function contractProgram(root = DEFAULT_ROOT) {
  const configPath = path.join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const file = path.join(root, CONTRACT);
  return { program: ts.createProgram([file], { ...parsed.options, noEmit: true }), file };
}

const docOf = (symbol, checker) => ts.displayPartsToString(symbol.getDocumentationComment(checker)).replace(/\r\n/g, '\n');

function memberEntry(prop, checker) {
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  const kind = decl && ts.isMethodSignature(decl) ? 'method' : decl && ts.isPropertySignature(decl) ? 'property' : decl ? ts.SyntaxKind[decl.kind] : 'none';
  const type = checker.typeToString(checker.getTypeOfSymbol(prop), undefined, FLAGS);
  const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
  const readonly = !!decl && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly) !== 0;
  const entry = { name: prop.name, kind, optional, type };
  if (readonly) entry.readonly = true;
  const doc = docOf(prop, checker);
  if (doc) entry.doc = doc;
  return entry;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The shape a type-level export resolves to. */
function shapeOf(symbol, checker) {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const out = { kinds: [] };
  if (target.flags & ts.SymbolFlags.Interface) {
    out.kinds.push('interface');
    const type = checker.getDeclaredTypeOfSymbol(target);
    out.members = checker.getPropertiesOfType(type).map((p) => memberEntry(p, checker)).sort(byName);
    const index = checker.getIndexInfosOfType(type).map((i) => `[${checker.typeToString(i.keyType)}]: ${checker.typeToString(i.type, undefined, FLAGS)}`);
    if (index.length) out.index = index;
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map((s) => checker.signatureToString(s, undefined, FLAGS));
    if (calls.length) out.calls = calls;
  }
  if (target.flags & ts.SymbolFlags.TypeAlias) {
    out.kinds.push('type');
    const type = checker.getDeclaredTypeOfSymbol(target);
    out.type = checker.typeToString(type, undefined, FLAGS | ts.TypeFormatFlags.InTypeAlias);
    if (type.flags & ts.TypeFlags.Object) out.members = checker.getPropertiesOfType(type).map((p) => memberEntry(p, checker)).sort(byName);
  }
  if (target.flags & ts.SymbolFlags.Value) out.kinds.push('VALUE');
  const doc = docOf(target, checker);
  if (doc) out.doc = doc;
  return out;
}

export function buildSurface(root = DEFAULT_ROOT) {
  const { program, file } = contractProgram(root);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`contracts-surface: cannot read ${CONTRACT}`);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const exports = checker.getExportsOfModule(moduleSymbol).slice().sort((a, b) => (a.name < b.name ? -1 : 1));
  const types = {};
  const values = [];
  for (const symbol of exports) {
    const shape = shapeOf(symbol, checker);
    if (shape.kinds.includes('VALUE')) values.push(symbol.name);
    types[symbol.name] = shape;
  }
  const api = types.DesktopAPI;
  if (!api?.members) throw new Error('contracts-surface: DesktopAPI is not an exported interface');
  // The global the renderer uses (declare global { interface Window { desktop: DesktopAPI } }).
  const windowType = checker.getDeclaredTypeOfSymbol(checker.resolveName('Window', undefined, ts.SymbolFlags.Type, false));
  const desktop = windowType && checker.getPropertyOfType(windowType, 'desktop');
  const windowDesktop = desktop ? checker.typeToString(checker.getTypeOfSymbol(desktop), undefined, FLAGS) : null;
  return {
    note: 'Generated by `node scripts/dev/contracts-surface.mjs --write` (docs/claude/2026-11-16-contracts-split.md); tests/contracts-surface.test.mjs compares. The whole type surface of shared/contracts.ts: regenerate only for an intended API change and say why in the commit.',
    counts: { exports: exports.length, desktopApiMembers: api.members.length, optionalMembers: api.members.filter((m) => m.optional).length },
    runtimeValues: values,
    windowDesktop,
    desktopApi: api.members,
    exports: Object.fromEntries(Object.entries(types).filter(([name]) => name !== 'DesktopAPI')),
  };
}

/** The JavaScript a file compiles to on its own (isolatedModules), minus comments and blank lines: a types-only module is `export {};`. */
export function emittedJs(root, relPath) {
  const text = fs.readFileSync(path.join(root, relPath), 'utf8');
  const out = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true, verbatimModuleSyntax: false, removeComments: true }, fileName: relPath }).outputText;
  return out.split(/\r?\n/).filter((l) => l.trim() && !/^\/\/# sourceMappingURL/.test(l)).join('\n');
}

export const serialize = (surface) => JSON.stringify(surface, null, 1) + '\n';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const surface = buildSurface(DEFAULT_ROOT);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(DEFAULT_ROOT, SURFACE_FILE), serialize(surface));
    console.log(`written ${SURFACE_FILE}`);
  } else if (process.argv.includes('--json')) process.stdout.write(serialize(surface));
  else console.log(`exports ${surface.counts.exports}, DesktopAPI members ${surface.counts.desktopApiMembers} (${surface.counts.optionalMembers} optional), runtime values ${surface.runtimeValues.length}, window.desktop: ${surface.windowDesktop}`);
}
