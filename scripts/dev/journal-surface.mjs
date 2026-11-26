#!/usr/bin/env node
// The experience journal's export surface golden (docs/claude/2026-11-16-journal-split.md, step 0). What every
// `import … from '…/shared/memory/journal'` sees, read with the TypeScript type checker (nothing is run):
//   - every name shared/memory/journal.ts exports (re-exports are followed to the declaration), and for each: its kinds (value,
//     function, type, interface), its doc comment, and its full type: a value's declared type, a function's signatures, an
//     interface's members, a type alias's expansion;
//   - a union type alias (JournalInput, JournalEntry, …) as its constituents, each printed in full with its members (optional
//     marks, types, doc comments), sorted by text: splitting one union into per-part unions keeps the golden as it is.
// Type names are printed as the checker names them (no file paths), so the golden is the same in every checkout.
// The behaviour (the lines written and read back) has its own golden: scripts/dev/journal-behaviour.ts.
//   node scripts/dev/journal-surface.mjs            print a summary (counts)
//   node scripts/dev/journal-surface.mjs --write    regenerate tests/fixtures/journal-surface.json (tests/journal-surface.test.mjs compares)
//   node scripts/dev/journal-surface.mjs --json     print the golden
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
export const SURFACE_FILE = 'tests/fixtures/journal-surface.json';
export const JOURNAL = 'shared/memory/journal.ts';
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature;

/** A program over shared/memory/journal.ts with the repo's compiler options. */
export function journalProgram(root = DEFAULT_ROOT) {
  const configPath = path.join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const file = path.join(root, JOURNAL);
  return { program: ts.createProgram([file], { ...parsed.options, noEmit: true }), file };
}

const docOf = (symbol, checker) => ts.displayPartsToString(symbol.getDocumentationComment(checker)).replace(/\r\n/g, '\n');

/**
 * A type printed canonically. The checker prints a union in the order its constituents were created (literal types are made the
 * first time any file mentions them), and moving code between files changes that order, so its own printer cannot be the golden.
 * This one prints every union sorted, keeps tuple and member order (those mean something), and names a type by its alias or
 * declared name when it has one.
 */
function canon(type, checker, depth = 0, expand = false) {
  if (depth > 12) return checker.typeToString(type, undefined, FLAGS);
  const next = (t) => canon(t, checker, depth + 1);
  const named = (name, args) => (args?.length ? `${name}<${args.map(next).join(', ')}>` : name);
  // Unions and intersections are shared by every alias with the same constituents, and carry the name of whichever alias made
  // them first, so they are always spelled out; other types are named by their alias (Readonly<…>, Record<…>) when they have one.
  if (!expand && type.aliasSymbol && !(type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection))) return named(type.aliasSymbol.name, type.aliasTypeArguments);
  if (type.flags & ts.TypeFlags.Union) {
    const parts = type.types.map(next);
    // boolean is printed as one word, the way it was written.
    if (parts.includes('true') && parts.includes('false')) { parts.splice(parts.indexOf('true'), 1); parts.splice(parts.indexOf('false'), 1, 'boolean'); }
    return [...new Set(parts)].sort().join(' | ');
  }
  if (type.flags & ts.TypeFlags.Intersection) return type.types.map(next).join(' & ');
  if (type.flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value);
  if (type.flags & (ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.BigIntLiteral)) return checker.typeToString(type);
  if (type.flags & ts.TypeFlags.TypeParameter) return type.symbol?.name ?? checker.typeToString(type);
  if (type.flags & ts.TypeFlags.Object) {
    if (checker.isTupleType(type)) {
      const target = type.target;
      const elements = checker.getTypeArguments(type).map((t, i) => {
        const flag = target.elementFlags?.[i] ?? 0;
        return flag & ts.ElementFlags.Rest ? `...${next(t)}[]` : flag & ts.ElementFlags.Optional ? `${next(t)}?` : next(t);
      });
      return `${target.readonly ? 'readonly ' : ''}[${elements.join(', ')}]`;
    }
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type);
      const inner = next(element);
      const wrapped = /[|&]|=>/.test(inner) ? `(${inner})` : inner;
      return type.symbol?.name === 'ReadonlyArray' ? `readonly ${wrapped}[]` : `${wrapped}[]`;
    }
    const symbol = type.symbol;
    const anonymous = !symbol || symbol.name === '__type' || symbol.name === '__object' || (symbol.flags & ts.SymbolFlags.TypeLiteral) !== 0
      || (symbol.flags & ts.SymbolFlags.ObjectLiteral) !== 0 || (type.objectFlags & ts.ObjectFlags.Mapped) !== 0;
    if (!anonymous || (!expand && (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) !== 0)) {
      const args = type.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type) : undefined;
      if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class) && !expand) return named(symbol.name, args);
      if (symbol.flags & ts.SymbolFlags.Function || symbol.flags & ts.SymbolFlags.Method) return signatures(type, checker, depth);
    }
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    const props = checker.getPropertiesOfType(type);
    if (calls.length && !props.length) return signatures(type, checker, depth);
    const index = checker.getIndexInfosOfType(type).map((i) => `${i.isReadonly ? 'readonly ' : ''}[key: ${next(i.keyType)}]: ${next(i.type)}`);
    const members = props.map((p) => {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const readonly = decl && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly) !== 0 ? 'readonly ' : '';
      const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
      // An optional member's type is printed as written (the checker adds `undefined` to it).
      const printed = next(checker.getTypeOfSymbol(p)).split(' | ').filter((s) => !(optional && s === 'undefined')).join(' | ');
      return `${readonly}${p.name}${optional ? '?' : ''}: ${printed}`;
    });
    return `{ ${[...index, ...members].join('; ')} }`;
  }
  return checker.typeToString(type, undefined, FLAGS);
}

function signatures(type, checker, depth) {
  const list = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map((s) => signature(s, checker, depth));
  return list.length === 1 ? list[0] : `{ ${list.join('; ')} }`;
}

function signature(sig, checker, depth = 0) {
  const params = sig.getParameters().map((p) => {
    const decl = p.valueDeclaration;
    const rest = decl && ts.isParameter(decl) && decl.dotDotDotToken;
    const optional = decl && ts.isParameter(decl) && (decl.questionToken || decl.initializer);
    let printed = canon(checker.getTypeOfSymbol(p), checker, depth + 1);
    if (optional) printed = printed.split(' | ').filter((s) => s !== 'undefined').join(' | ');
    return `${rest ? '...' : ''}${p.name}${optional ? '?' : ''}: ${printed}`;
  });
  const typeParams = sig.getTypeParameters()?.map((t) => t.symbol.name) ?? [];
  const returns = sig.getTypePredicate?.() ? checker.typePredicateToString(sig.getTypePredicate()) : canon(checker.getReturnTypeOfSignature(sig), checker, depth + 1);
  return `${typeParams.length ? `<${typeParams.join(', ')}>` : ''}(${params.join(', ')}) => ${returns}`;
}

const text = (type, checker, expand = false) => canon(type, checker, 0, expand);

function memberEntry(prop, checker) {
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  const kind = decl && ts.isMethodSignature(decl) ? 'method' : decl && ts.isPropertySignature(decl) ? 'property' : decl ? ts.SyntaxKind[decl.kind] : 'none';
  const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
  const printed = text(checker.getTypeOfSymbol(prop), checker);
  const entry = { name: prop.name, kind, optional, type: optional ? printed.split(' | ').filter((s) => s !== 'undefined').join(' | ') : printed };
  if (decl && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly) !== 0) entry.readonly = true;
  const doc = docOf(prop, checker);
  if (doc) entry.doc = doc;
  return entry;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byText = (a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);

/** One constituent of a union: printed in full (members in declaration order), with the doc comments of its members. */
function constituent(type, checker) {
  const out = { text: text(type, checker, true) };
  if (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
    const docs = Object.fromEntries(checker.getPropertiesOfType(type).map((p) => [p.name, docOf(p, checker)]).filter(([, doc]) => doc));
    if (Object.keys(docs).length) out.docs = docs;
  }
  return out;
}

/** A function as declared: its parameters and return type as written (the names they use are exports with their own entries). */
function declaredSignature(decl) {
  const squash = (node) => (node ? node.getText().replace(/\s+/g, ' ') : '?');
  const params = decl.parameters.map((p) => `${p.dotDotDotToken ? '...' : ''}${p.name.getText()}${p.questionToken ? '?' : ''}: ${squash(p.type)}`);
  return `(${params.join(', ')}) => ${squash(decl.type)}`;
}

/** The shape an export resolves to. */
function shapeOf(symbol, checker) {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const out = { kinds: [] };
  if (target.flags & ts.SymbolFlags.Interface) {
    out.kinds.push('interface');
    const type = checker.getDeclaredTypeOfSymbol(target);
    out.members = checker.getPropertiesOfType(type).map((p) => memberEntry(p, checker)).sort(byName);
  }
  if (target.flags & ts.SymbolFlags.TypeAlias) {
    out.kinds.push('type');
    const type = checker.getDeclaredTypeOfSymbol(target);
    if (type.flags & ts.TypeFlags.Union && !(type.flags & ts.TypeFlags.EnumLiteral) && type.types.some((t) => t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) {
      // An object union: its constituents, sorted (a union's own order follows type creation, which moving code changes).
      out.union = type.types.map((t) => constituent(t, checker)).sort(byText);
    } else {
      out.type = text(type, checker, true);
      if (type.flags & ts.TypeFlags.Object) out.members = checker.getPropertiesOfType(type).map((p) => memberEntry(p, checker)).sort(byName);
    }
  }
  if (target.flags & ts.SymbolFlags.Function) {
    out.kinds.push('function');
    const type = checker.getTypeOfSymbol(target);
    out.signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map((s) => (s.declaration?.type ? declaredSignature(s.declaration) : signature(s, checker)));
  } else if (target.flags & ts.SymbolFlags.Variable) {
    out.kinds.push('value');
    out.valueType = text(checker.getTypeOfSymbol(target), checker);
  }
  const doc = docOf(target, checker);
  if (doc) out.doc = doc;
  return out;
}

export function buildSurface(root = DEFAULT_ROOT) {
  const { program, file } = journalProgram(root);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`journal-surface: cannot read ${JOURNAL}`);
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(sf)).slice().sort((a, b) => (a.name < b.name ? -1 : 1));
  const shapes = Object.fromEntries(exports.map((symbol) => [symbol.name, shapeOf(symbol, checker)]));
  const count = (kind) => Object.values(shapes).filter((s) => s.kinds.includes(kind)).length;
  return {
    note: 'Generated by `node scripts/dev/journal-surface.mjs --write` (docs/claude/2026-11-16-journal-split.md); tests/journal-surface.test.mjs compares. The whole export surface of shared/memory/journal.ts: regenerate only for an intended change (a new journal entry type, a new word list) and say why in the commit.',
    counts: { exports: exports.length, values: count('value'), functions: count('function'), types: count('type'), interfaces: count('interface'),
      journalInputConstituents: shapes.JournalInput?.union?.length ?? 0 },
    exports: shapes,
  };
}

export const serialize = (surface) => JSON.stringify(surface, null, 1) + '\n';

/**
 * The same export surface for another module (scripts/dev/app-tools-golden.ts, docs/claude/2026-11-17-app-tools-split.md): every name
 * `rel` exports, sorted, with its kinds, doc comment and full type, printed by the same canonical printer.
 */
export function moduleSurface(rel, root = DEFAULT_ROOT) {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const file = path.join(root, rel);
  const program = ts.createProgram([file], { ...parsed.options, noEmit: true });
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`module-surface: cannot read ${rel}`);
  const types = program.getTypeChecker();
  const exports = types.getExportsOfModule(types.getSymbolAtLocation(source)).slice().sort((a, b) => (a.name < b.name ? -1 : 1));
  return Object.fromEntries(exports.map((symbol) => [symbol.name, shapeOf(symbol, types)]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const surface = buildSurface(DEFAULT_ROOT);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(DEFAULT_ROOT, SURFACE_FILE), serialize(surface));
    console.log(`written ${SURFACE_FILE}`);
  } else if (process.argv.includes('--json')) process.stdout.write(serialize(surface));
  else console.log(JSON.stringify(surface.counts));
}
