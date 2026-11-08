// Which repository files do the unit tests read that prepare() does not freeze?
// prepare() (scripts/update-desktop.mjs) runs every unit test inside .local/desktop-updates/<time>/source, a copy
// of runtimeInputs only. A test that reads any other repository file passes in the workspace and fails there, and
// then no development version and no desktop shortcut is installed (R26, 2026-11-03: handbook/README.md,
// handbook/ideas.md, tools/bridge/scorer.html). Static: the test sources are parsed, nothing is run.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/** Never repository sources: dependencies, build output, local data, git and agent folders, test output. */
const NOT_REPOSITORY = new Set(['node_modules', '.git', '.local', '.claude', 'release', 'dist', 'dist-electron', 'test-results', '_probe', 'runtime-tests']);
const SCANNED = /\.(?:[cm]?[jt]s|tsx)$/i;
const JOINS = new Set(['join', 'resolve']);

/** True when the frozen copy contains this repository path (a file, a frozen folder, or a folder above one). */
export function frozenCovers(relative, inputs) {
  return inputs.fixed.includes(relative)
    || inputs.folders.some(folder => relative === folder || relative.startsWith(folder + '/') || folder.startsWith(relative + '/'));
}

const literal = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const clean = value => value.replaceAll('\\', '/').replace(/\/+$/u, '');
/** `import.meta.url`, `import.meta.dirname`, `__dirname` or `__filename`: an expression anchored at this source file. */
function anchored(node) {
  let found = false;
  const visit = child => {
    if (found) return;
    if (ts.isMetaProperty(child) || (ts.isIdentifier(child) && (child.text === '__dirname' || child.text === '__filename'))) { found = true; return; }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}
function callName(call) {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
}

/**
 * Repository-relative paths this source reads, as written: `'../handbook/x.md'` (a URL or relative path),
 * `'docs/x.md'` (relative to the repository, as tests run there), `join(here, '..', 'handbook', 'x.md')`, and
 * `join(root, 'handbook', 'x.md')` where `root` is computed from this file's own location.
 */
export function repositoryReads(text, fileName, topLevel) {
  const kind = /\.[cm]?js$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const roots = new Set(), found = new Map();
  const add = (relative, node) => {
    const value = clean(relative);
    if (!value || !topLevel.has(value.split('/')[0])) return;
    if (!found.has(value)) found.set(value, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
  };
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && anchored(node.initializer)) roots.add(node.name.text);
    if (literal(node)) {
      const value = clean(node.text), prefix = /^(?:\.\.?\/)+/u.exec(value)?.[0] ?? '';
      if (prefix || value.includes('/')) add(value.slice(prefix.length), node);
    }
    if (ts.isCallExpression(node) && JOINS.has(callName(node))) {
      const args = [...node.arguments], up = args.map((arg, index) => literal(arg) && arg.text === '..' ? index : -1).filter(index => index >= 0).at(-1);
      const first = up ?? (args.length > 1 && ts.isIdentifier(args[0]) && roots.has(args[0].text) ? 0 : undefined);
      if (first !== undefined) {
        const parts = [];
        for (const arg of args.slice(first + 1)) { if (!literal(arg)) break; parts.push(arg.text); }
        if (parts.length) add(parts.join('/'), node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].map(([relative, line]) => ({ path: relative, line }));
}

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(file));
    else if (entry.isFile() && SCANNED.test(entry.name)) result.push(file);
  }
  return result;
}

/**
 * Every test source under tests/ that reads an existing repository path the frozen copy would not contain.
 * Strings that only look like paths (MCP method names such as `tools/list`) name nothing in the workspace and are ignored.
 */
export async function unfrozenTestReads(root, inputs) {
  const topLevel = new Set((await readdir(root)).filter(name => !NOT_REPOSITORY.has(name)));
  const findings = [];
  for (const file of (await sources(path.join(root, 'tests'))).sort()) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    for (const read of repositoryReads(await readFile(file, 'utf8'), file, topLevel))
      if (!frozenCovers(read.path, inputs) && existsSync(path.join(root, ...read.path.split('/')))) findings.push({ file: relative, ...read });
  }
  return findings;
}
