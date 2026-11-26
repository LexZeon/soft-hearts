// DesktopAPI's source text for tests that read it (docs/claude/2026-11-16-contracts-split.md). shared/contracts.ts declares
// `interface DesktopAPI extends <Part>DesktopAPI, …` and each part's members live in shared/<part>/desktop-api.ts. Tests that used to
// parse the one interface in contracts.ts read it here: one `interface DesktopAPI { … }` holding every member's own source text
// (doc comments included), slice after slice in `extends` order, with the same assertions as before.
// Prefer the type checker (tests/contracts-surface.test.mjs) or importing a module over this: it is for checks about how a member is written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { DesktopAPI } from '../../shared/contracts';

/** (Typed so the tests that read the slices are chosen when contracts.ts or a slice changes: scripts/dev/test-affected.mjs follows imports.) */
export type DesktopApiMemberName = keyof DesktopAPI;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTRACT_FILE = 'shared/contracts.ts';

const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function interfaceNamed(sf: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const found = sf.statements.filter((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name);
  if (found.length !== 1) throw new Error(`${sf.fileName}: expected one interface ${name}, found ${found.length}`);
  return found[0];
}

export interface DesktopApiSlice { readonly file: string; readonly name: string; readonly memberNames: readonly string[] }

/**
 * The slices DesktopAPI extends, in order: each base named in the `extends` clause is followed through contracts.ts's
 * `import type { X } from './part/desktop-api'` to its file. Throws when a base cannot be found or itself extends something.
 */
export function desktopApiSlices(root = ROOT): { slices: DesktopApiSlice[]; ownMembers: string; sliceTexts: string[] } {
  const contractText = fs.readFileSync(path.join(root, CONTRACT_FILE), 'utf8');
  const contract = parse(CONTRACT_FILE, contractText);
  const api = interfaceNamed(contract, 'DesktopAPI');
  const from = new Map<string, string>();
  for (const st of contract.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) from.set(el.name.text, st.moduleSpecifier.text);
  }
  const slices: DesktopApiSlice[] = [];
  const sliceTexts: string[] = [];
  for (const clause of api.heritageClauses ?? []) for (const base of clause.types) {
    const name = base.expression.getText(contract);
    const spec = from.get(name);
    if (!spec) throw new Error(`DesktopAPI extends ${name}, which shared/contracts.ts does not import`);
    const file = path.posix.join('shared', `${spec.replace(/^\.\//, '')}.ts`);
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const sf = parse(file, text);
    const slice = interfaceNamed(sf, name);
    if (slice.heritageClauses?.length) throw new Error(`${file}: ${name} extends something; a slice holds its members itself`);
    slices.push({ file, name, memberNames: slice.members.map(m => m.name?.getText(sf) ?? '') });
    sliceTexts.push(slice.members.map(m => text.slice(m.pos, m.end)).join(''));
  }
  return { slices, ownMembers: api.members.map(m => contractText.slice(m.pos, m.end)).join(''), sliceTexts };
}

/** `export interface DesktopAPI { … }` with every member's source text (its own, then each slice's), for parsing or text checks. */
export function desktopApiSource(root = ROOT): string {
  const { ownMembers, sliceTexts } = desktopApiSlices(root);
  return `export interface DesktopAPI {${ownMembers}${sliceTexts.join('')}\n}\n`;
}
