#!/usr/bin/env node
// The closed values each journal entry field can take, read from JournalInput with the TypeScript checker (nothing is run):
// for every entry type, every field, the string / number / boolean literals its declared type allows (an array field: its
// element's). scripts/dev/journal-behaviour.ts stores them in the behaviour golden, which tries every one of them on every field.
//   node scripts/dev/journal-pools.mjs     print them
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { journalProgram } from './journal-surface.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function literals(type, checker, out, seen = new Set()) {
  if (seen.has(type)) return out;
  seen.add(type);
  if (type.flags & ts.TypeFlags.Union) { for (const t of type.types) literals(t, checker, out, seen); return out; }
  if (type.flags & ts.TypeFlags.StringLiteral || type.flags & ts.TypeFlags.NumberLiteral) out.values.add(type.value);
  else if (type.flags & ts.TypeFlags.BooleanLiteral) out.values.add(checker.typeToString(type) === 'true');
  else if (type.flags & ts.TypeFlags.Object && checker.isArrayType(type)) { out.array = true; literals(checker.getTypeArguments(type)[0], checker, out, seen); }
  return out;
}

const sortValues = (values) => [...values].sort((a, b) => (typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a < typeof b ? -1 : 1));

/** { [entry type]: { [field]: { values: [...sorted literals], array?: true } } }, fields and types sorted. */
export function journalPools(root = DEFAULT_ROOT) {
  const { program, file } = journalProgram(root);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(sf)).find((s) => s.name === 'JournalInput');
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const union = checker.getDeclaredTypeOfSymbol(target);
  const pools = {};
  for (const constituent of union.types) {
    const typeProp = checker.getPropertyOfType(constituent, 'type');
    const entryType = checker.getTypeOfSymbol(typeProp).value;
    const fields = (pools[entryType] ??= {});
    for (const prop of checker.getPropertiesOfType(constituent)) {
      if (prop.name === 'type') continue;
      const found = literals(checker.getTypeOfSymbol(prop), checker, { values: new Set(), array: false });
      const slot = (fields[prop.name] ??= { values: [] });
      slot.values = sortValues(new Set([...slot.values, ...found.values]));
      if (found.array) slot.array = true;
    }
  }
  return Object.fromEntries(Object.keys(pools).sort().map((t) => [t, Object.fromEntries(Object.keys(pools[t]).sort().map((f) => [f, pools[t][f]]))]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pools = journalPools();
  for (const [type, fields] of Object.entries(pools)) {
    console.log(type);
    for (const [field, pool] of Object.entries(fields)) console.log(`  ${field}${pool.array ? '[]' : ''}: ${pool.values.map((v) => JSON.stringify(v)).join(' ')}`);
  }
}
