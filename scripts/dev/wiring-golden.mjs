#!/usr/bin/env node
// The wiring golden (docs/claude/2026-11-16-wiring-rewrite-plan.md, step 0; docs/claude/2026-11-16-wiring-steps-0-2.md).
// A static picture of how electron/main.ts connects the parts, read with the TypeScript parser (no type checker, nothing run):
//   - every `desk:*` IPC handler and whether it is control-window only, including the ones registered inside the parts'
//     register()/registerXIpc() functions; which ones the agent channel's recorder sees (registered inside registerIPC before
//     agentOperations.done());
//   - checked one to one against the preload (electron/safety/preload.ts): invoke('x') and subscribe('desk:x');
//   - every channel the host sends to a window (broadcast('desk:x'), *.send('desk:x'));
//   - ordered lists: the ready chain, the before-quit steps, the 1-second clock, secureWindow's window events and their steps,
//     saveSettings' side effects, the module-level timers; sync's steps (since wiring rewrite step 4). saveSettings and sync are
//     ordered step lists electron/main.ts gives the settings wiring (wireSaveSettings, wireSettingsSync): each step's body is read
//     in place, in the list's order, so reordering two steps changes the golden.
// Robust to code moving between files: handlers are searched in every electron/ source file and attributed to the wiring through
// the calls that pass the registrar (host / scopedHost) on; the wiring is electron/main.ts plus electron/wiring/*.ts, and a call
// from an ordered list to a function declared in electron/wiring/*.ts is inlined. No file paths are kept in the golden.
//   node scripts/dev/wiring-golden.mjs            print a summary (counts and mismatches)
//   node scripts/dev/wiring-golden.mjs --write    regenerate tests/fixtures/wiring-golden.json (tests/wiring-golden.test.mjs compares)
//   node scripts/dev/wiring-golden.mjs --json     print the golden
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { resolveImport } from './structure-inventory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
export const GOLDEN_FILE = 'tests/fixtures/wiring-golden.json';
const PRELOAD = 'electron/safety/preload.ts';
const AGENT_BRIDGE = 'electron/safety/agent-channel/bridge.ts';
/** Callee names that register an IPC handler: main.ts's two guards and the names the parts give the registrar they are handed. */
const REGISTRAR_NAMES = new Set(['host', 'scopedHost', 'register', 'registrar']);
/** Calls with those names that are not IPC. */
const NOT_IPC = new Set(['globalShortcut.register', 'assets.register', 'protocol.register']);
const METHOD_NAME = /^[a-z][A-Za-z0-9]*$/;

const posix = (p) => p.replace(/\\/g, '/');

function walk(root, dir, out) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(root, rel, out); }
    else if (/\.(?:ts|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel);
  }
}

/** Every electron/ source file, parsed. The preloads run in the window and register nothing. */
export function loadProgram(root) {
  const files = [];
  walk(root, 'electron', files);
  const fileSet = new Set(files);
  const sources = new Map();
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    sources.set(f, ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  return { files, fileSet, sources };
}

export const isWiringFile = (f) => f === 'electron/main.ts' || /^electron\/wiring\/[^/]+\.ts$/.test(f);
const isPreload = (f) => /preload\.ts$/.test(f);

// ---------------------------------------------------------------------------------------------------------------------------
// Small AST helpers

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
/** One-line, comment-free text of a node, the same however the source was formatted. */
function flat(node, sf) {
  let text;
  try { text = printer.printNode(ts.EmitHint.Unspecified, node, sf); } catch { text = node.getText(sf); }
  return text.replace(/\s+/g, ' ').trim();
}
const lineOf = (node, sf) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function visit(node, fn) {
  const walkNode = (n) => { if (fn(n) === false) return; ts.forEachChild(n, walkNode); };
  walkNode(node);
}
const unwrap = (e) => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e;
};
/** 'a.b.c' for a property access chain (optional chaining written as '.'), or the identifier; null otherwise. */
function dotted(e) {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(e)) { const left = dotted(e.expression); return left ? `${left}.${e.name.text}` : null; }
  return null;
}
const lastName = (e) => { const d = dotted(e); return d ? d.split('.').pop() : null; };
const isFunctionLike = (e) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
const stringValue = (e) => { e = unwrap(e); return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null; };

function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return null;
}
function topLevelFunctions(sf) {
  const map = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) map.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && isFunctionLike(d.initializer)) map.set(d.name.text, d.initializer);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Imports: which file declares a name a file uses (following index.ts re-exports)

function importsOf(sf, file, fileSet) {
  const map = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const target = resolveImport(file, st.moduleSpecifier.text, fileSet);
    if (!target) continue;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) map.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
    if (st.importClause.name) map.set(st.importClause.name.text, { file: target, name: 'default' });
  }
  return map;
}
function declares(sf, name) {
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return true;
    if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) return true;
  }
  return false;
}
/** The file that declares `name` as seen from `file` (an export of it, followed through `export { } from` and `export * from`). */
function declaringFile(prog, file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const sf = prog.sources.get(file);
  if (!sf) return null;
  if (declares(sf, name)) return file;
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
    const target = resolveImport(file, st.moduleSpecifier.text, prog.fileSet);
    if (!target) continue;
    if (!st.exportClause) { const found = declaringFile(prog, target, name, seen); if (found) return found; continue; }
    if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements)
      if (el.name.text === name) return declaringFile(prog, target, (el.propertyName ?? el.name).text, seen);
  }
  const imp = importsOf(sf, file, prog.fileSet).get(name);
  return imp ? declaringFile(prog, imp.file, imp.name, seen) : null;
}
function resolveName(prog, file, name) {
  const sf = prog.sources.get(file);
  if (declares(sf, name)) return file;
  const imp = importsOf(sf, file, prog.fileSet).get(name);
  return imp ? declaringFile(prog, imp.file, imp.name) : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Handler names: a literal, a loop over a literal array, or the keys of an object a called function returns

function namesFor(prog, file, expr) {
  const literal = stringValue(expr);
  if (literal !== null) return [literal];
  expr = unwrap(expr);
  if (!ts.isIdentifier(expr)) return null;
  const constant = constantString(prog, file, expr.text);
  if (constant !== null) return [constant];
  // The loop that binds it: for (const name of [...]) / for (const [name, op] of [...]) / of Object.entries(f(...))
  for (let p = expr.parent; p; p = p.parent) {
    if (!ts.isForOfStatement(p)) continue;
    const decl = p.initializer.declarations?.[0];
    if (!decl) continue;
    let index = -1;
    if (ts.isIdentifier(decl.name) && decl.name.text === expr.text) index = null;
    else if (ts.isArrayBindingPattern(decl.name)) index = decl.name.elements.findIndex((el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === expr.text);
    if (index === -1) continue;
    const over = unwrap(p.expression);
    if (ts.isArrayLiteralExpression(over)) {
      const out = [];
      for (const el of over.elements) {
        const item = unwrap(el);
        const v = index === null ? stringValue(item) : ts.isArrayLiteralExpression(item) ? stringValue(item.elements[index]) : null;
        if (v === null) return null;
        out.push(v);
      }
      return out;
    }
    if (ts.isCallExpression(over) && /^Object\.(?:entries|keys)$/.test(dotted(over.expression) ?? '') && (index === null || index === 0)) {
      const inner = unwrap(over.arguments[0]);
      if (inner && ts.isCallExpression(inner) && ts.isIdentifier(unwrap(inner.expression))) {
        const fname = unwrap(inner.expression).text;
        const declFile = resolveName(prog, file, fname);
        const fn = declFile && topLevelFunctions(prog.sources.get(declFile)).get(fname);
        const keys = fn && returnedKeys(fn);
        if (keys) return keys;
      }
    }
    return null;
  }
  return null;
}
/** The value of a top-level `const NAME = 'text'` in the file or the file it is imported from; null otherwise. */
function constantString(prog, file, name) {
  const declFile = resolveName(prog, file, name);
  const sf = declFile && prog.sources.get(declFile);
  if (!sf) return null;
  for (const st of sf.statements) if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const)
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return stringValue(d.initializer);
  return null;
}
function returnedKeys(fn) {
  let obj = null;
  if (fn.body && !ts.isBlock(fn.body)) obj = unwrap(fn.body);
  else visit(fn.body, (n) => { if (n !== fn.body && ts.isFunctionLike(n)) return false; if (ts.isReturnStatement(n) && n.expression) obj = unwrap(n.expression); });
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const keys = [];
  for (const prop of obj.properties) {
    if (!prop.name) return null;
    const k = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (k === null) return null;
    keys.push(k);
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------------------------------------
// IPC handlers

/** Is this call a registrar call: host('x', op[, controlOnly]) / scopedHost / register / ports.register / this.ports.register? */
function registrarCall(call, wrappers = null) {
  const name = lastName(call.expression);
  const wrapped = !!wrappers && ts.isIdentifier(unwrap(call.expression)) && wrappers.has(name);
  if (!name || (!REGISTRAR_NAMES.has(name) && !wrapped)) return false;
  const full = dotted(call.expression) ?? '';
  if ([...NOT_IPC].some((n) => full === n || full.endsWith(`.${n}`)) || /shortcut/i.test(full)) return false;
  if (call.arguments.length < 2 || call.arguments.length > 3) return false;
  const first = unwrap(call.arguments[0]);
  if (ts.isIdentifier(first) && REGISTRAR_NAMES.has(first.text)) return false; // x.register(host, ...): hands the registrar on
  const op = unwrap(call.arguments[1]);
  return isFunctionLike(op) || ts.isIdentifier(op) || ts.isPropertyAccessExpression(op) || ts.isCallExpression(op) || ts.isElementAccessExpression(op);
}

/** The functions in the wiring that put a handler on ipcMain (scopedHost) and the ones that only pass their name on (host). */
function wiringGuards(prog) {
  const guards = new Map(); // name -> { file, fn, kind }
  for (const file of prog.files.filter(isWiringFile)) {
    for (const [name, fn] of topLevelFunctions(prog.sources.get(file))) {
      let raw = false;
      visit(fn, (n) => { if (ts.isCallExpression(n) && /(?:^|\.)ipcMain\.handle$/.test(dotted(n.expression) ?? '')) raw = true; });
      if (raw) guards.set(name, { file, fn, kind: 'guard' });
    }
  }
  for (const file of prog.files.filter(isWiringFile)) {
    for (const [name, fn] of topLevelFunctions(prog.sources.get(file))) {
      if (guards.has(name)) continue;
      // A wrapper hands its own first parameter (the method name) to a guard: host(method, ...) -> scopedHost(method, ...).
      const first = fn.parameters?.[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : null;
      let passes = false;
      visit(fn, (n) => { if (first && ts.isCallExpression(n) && guards.has(dotted(n.expression) ?? '') && dotted(n.arguments[0] ?? n) === first) passes = true; });
      if (passes) guards.set(name, { file, fn, kind: 'wrapper' });
    }
  }
  return guards;
}

const literalFlag = (e, sf) => e === undefined ? true : e.kind === ts.SyntaxKind.TrueKeyword ? true : e.kind === ts.SyntaxKind.FalseKeyword ? false : flat(e, sf);

/**
 * A part's local helpers that register for it: `const fixed = (method, op, controlOnly) => register(method, ..., controlOnly)`.
 * name -> how the inner call's controlOnly is set: { value } (a literal, or absent = true) or { param: k } (the helper's k-th argument).
 */
function localWrappers(sf) {
  const wrappers = new Map();
  visit(sf, (fn) => {
    if (!ts.isFunctionLike(fn) || !fn.body) return;
    const name = ts.isFunctionDeclaration(fn) ? fn.name?.text : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : null;
    const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
    if (!name || !params[0]) return;
    visit(fn.body, (n) => {
      if (!ts.isCallExpression(n) || !registrarCall(n) || dotted(n.arguments[0]) !== params[0]) return;
      const third = unwrap(n.arguments[2]);
      const k = third && ts.isIdentifier(third) ? params.indexOf(third.text) : -1;
      wrappers.set(name, k > 0 ? { param: k } : { value: literalFlag(n.arguments[2], sf) });
    });
  });
  return wrappers;
}

/** Every registrar call in a file: { names, controlOnly, line, node }. Throws on a name it cannot resolve. */
function handlerCalls(prog, file, skipFns) {
  const sf = prog.sources.get(file);
  const out = [];
  const wrappers = localWrappers(sf);
  visit(sf, (n) => {
    if (skipFns.has(n)) return false;
    if (!ts.isCallExpression(n) || !registrarCall(n, wrappers)) return;
    const names = namesFor(prog, file, n.arguments[0]);
    if (!names) {
      const first = unwrap(n.arguments[0]);
      // A registrar passing its own first parameter on (host -> scopedHost, a part's wrapper) is not a handler.
      const fn = enclosingFunction(n);
      if (ts.isIdentifier(first) && fn?.parameters?.[0] && ts.isIdentifier(fn.parameters[0].name) && fn.parameters[0].name.text === first.text) return;
      throw new Error(`wiring-golden: cannot read the handler name at ${file}:${lineOf(n, sf)} (${flat(n.arguments[0], sf)}); teach namesFor() this form`);
    }
    if (names.some((m) => !METHOD_NAME.test(m))) return; // not a desk: method (a shortcut, a file); registrarCall is a name heuristic
    const wrapper = ts.isIdentifier(unwrap(n.expression)) ? wrappers.get(lastName(n.expression)) : null;
    const controlOnly = !wrapper ? literalFlag(n.arguments[2], sf) : 'value' in wrapper ? wrapper.value : literalFlag(n.arguments[wrapper.param], sf);
    out.push({ names, controlOnly, line: lineOf(n, sf), node: n, guard: dotted(n.expression) });
  });
  return out;
}

/**
 * Calls in `file` that hand a registrar on: an argument or an object property whose value is a registrar. In the wiring a registrar
 * is one of its guards by name (host, scopedHost); in a part it is an identifier named like one (the parameter it was handed) or a
 * property `x.register` (`register: wiring.register`).
 */
function registrarPasses(file, sf, registrars) {
  const out = [];
  const isRegistrar = (e) => {
    const d = dotted(e);
    if (!d) return false;
    if (registrars) return registrars.has(d);
    return d.includes('.') ? /.(?:register|registrar)$/.test(d) : REGISTRAR_NAMES.has(d);
  };
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return;
    const args = n.arguments ?? [];
    let passes = false;
    for (const a of args) {
      const u = unwrap(a);
      if (!u) continue;
      if ((ts.isIdentifier(u) || ts.isPropertyAccessExpression(u)) && isRegistrar(u)) passes = true;
      // The wiring hands a part its registrars as partIpc('<part>') (electron/wiring/ipc-wiring.ts; wiring rewrite step 4).
      if (registrars && ts.isCallExpression(u) && dotted(u.expression) === 'partIpc') passes = true;
      if (ts.isObjectLiteralExpression(u)) for (const prop of u.properties) {
        if (ts.isShorthandPropertyAssignment(prop) && isRegistrar(prop.name)) passes = true;
        if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(unwrap(prop.initializer)) || ts.isPropertyAccessExpression(unwrap(prop.initializer))) && isRegistrar(prop.initializer)) passes = true;
      }
    }
    if (passes && !registrarCall(n)) out.push(n);
  });
  return out;
}

/**
 * The files a call's callee lives in: f(...) via imports; x.m(...) via x's initializer or assignment (new C / createC(...) / typeof
 * createC). When that function returns another factory's result (`return createY(...)`), createY's file is added. Null: cannot tell.
 * x made in another wiring file and imported (a part's feature file, docs/claude/2026-11-17-split-initiative-memory-wiring.md): x's
 * initializer or assignment is read where x is declared.
 */
function calleeFile(prog, file, call) {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    const base = dotted(callee.expression);
    const found = calleeFileIn(prog, file, call);
    if (found || !base || base.includes('.') || declares(prog.sources.get(file), base)) return found;
    const declFile = resolveName(prog, file, base);
    return declFile && declFile !== file && isWiringFile(declFile) ? calleeFileIn(prog, declFile, call) : null;
  }
  return calleeFileIn(prog, file, call);
}
/** calleeFile, reading x's initializer or assignment in `file` only. */
function calleeFileIn(prog, file, call) {
  const sf = prog.sources.get(file);
  const callee = unwrap(call.expression);
  const viaName = (name) => {
    const declFile = declares(sf, name) && !isWiringFile(file) ? file : resolveName(prog, file, name);
    if (!declFile) return null;
    const out = [declFile];
    const fn = topLevelFunctions(prog.sources.get(declFile)).get(name);
    if (fn?.body && ts.isBlock(fn.body)) for (const st of fn.body.statements) {
      const r = ts.isReturnStatement(st) ? unwrap(st.expression) : null;
      if (r && ts.isCallExpression(r) && ts.isIdentifier(unwrap(r.expression))) {
        const next = resolveName(prog, declFile, unwrap(r.expression).text);
        if (next && next !== declFile) out.push(next);
      }
    }
    return out;
  };
  if (ts.isIdentifier(callee)) return viaName(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    const base = dotted(callee.expression);
    if (!base || base.includes('.')) return null;
    const owner = base;
    let found = null;
    const fromExpr = (e) => {
      e = unwrap(e);
      if (!e) return null;
      if (ts.isNewExpression(e) || ts.isCallExpression(e)) { const d = dotted(e.expression); return d && !d.includes('.') ? viaName(d) : null; }
      return null;
    };
    visit(sf, (n) => {
      if (found) return false;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === owner) {
        found = fromExpr(n.initializer);
        if (!found && n.type) {
          const t = n.type.getText(sf);
          const m = /typeof\s+([A-Za-z_$][\w$]*)/.exec(t) ?? /^([A-Z][\w$]*)/.exec(t);
          if (m) found = viaName(m[1]);
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === owner) found = fromExpr(n.right);
    });
    return found;
  }
  return null;
}

export function collectHandlers(prog) {
  const guards = wiringGuards(prog);
  const guardFns = new Set([...guards.values()].map((g) => g.fn));
  const registrars = new Set(guards.keys());
  const all = []; // { name, controlOnly, file, line, node }
  const byFile = new Map();
  for (const file of prog.files) {
    if (isPreload(file)) continue;
    const calls = handlerCalls(prog, file, isWiringFile(file) ? guardFns : new Set());
    if (calls.length) byFile.set(file, calls);
    for (const c of calls) for (const name of c.names) all.push({ name, controlOnly: c.controlOnly, file, line: c.line, node: c.node });
  }
  // The handlers of each part: what the wiring hands the registrar to, followed through the files that pass it on.
  const sites = []; // { file, node, text, files: Set }
  const reached = new Set();
  const follow = (file, seen) => {
    if (seen.has(file)) return;
    seen.add(file);
    const sf = prog.sources.get(file);
    for (const pass of registrarPasses(file, sf, null))
      for (const target of calleeFile(prog, file, pass) ?? []) if (target !== file) follow(target, seen);
  };
  for (const file of prog.files.filter(isWiringFile)) {
    const sf = prog.sources.get(file);
    for (const pass of registrarPasses(file, sf, registrars)) {
      if (guardFns.has(enclosingFunction(pass))) continue;
      const targets = calleeFile(prog, file, pass);
      if (!targets) throw new Error(`wiring-golden: cannot tell which file ${flat(pass.expression, sf)}(...) at ${file}:${lineOf(pass, sf)} registers in; teach calleeFile() this form`);
      const files = new Set();
      for (const target of targets) if (target !== file) follow(target, files);
      for (const f of files) reached.add(f);
      sites.push({ file, node: pass, text: `${flat(pass.expression, sf)}(…)`, files });
    }
  }
  const unreached = [...byFile.keys()].filter((f) => !isWiringFile(f) && !reached.has(f));
  return { guards, all, sites, unreached };
}

/** The handlers the agent channel's recorder sees: registered inside the function that calls recordAgentOperations, before .done(). */
function recordedWindow(prog) {
  for (const file of prog.files.filter(isWiringFile)) {
    const sf = prog.sources.get(file);
    let start = null;
    let recorder = null;
    visit(sf, (n) => {
      if (!start && ts.isCallExpression(n) && lastName(n.expression) === 'recordAgentOperations') {
        start = n;
        const decl = n.parent;
        if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) recorder = decl.name.text;
      }
    });
    if (!start || !recorder) continue;
    const fn = enclosingFunction(start);
    let end = null;
    visit(fn, (n) => {
      if (!end && ts.isCallExpression(n) && dotted(n.expression) === `${recorder}.done`) end = n;
    });
    return { file, fn, from: start.getEnd(), to: end ? end.getStart(sf) : fn.getEnd() };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The preload and the channels the host sends

function preloadSurface(prog) {
  const sf = prog.sources.get(PRELOAD);
  const invokes = new Set();
  const subscribes = new Set();
  visit(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = dotted(n.expression);
    const v = n.arguments[0] && stringValue(n.arguments[0]);
    if (name === 'invoke' && v !== null && v !== undefined) invokes.add(v);
    if (name === 'subscribe' && v) subscribes.add(v);
    if (name === 'invoke' && v === null && !ts.isIdentifier(unwrap(n.arguments[0]))) throw new Error(`wiring-golden: preload invoke with a computed name at line ${lineOf(n, sf)}`);
  });
  return { invokes, subscribes };
}

function sentChannels(prog) {
  const sent = new Set();
  for (const file of prog.files) {
    if (isPreload(file)) continue;
    visit(prog.sources.get(file), (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = unwrap(n.expression);
      // x.send / x?.webContents.send / windows().find(...)?.webContents.send / broadcast
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
      if (name !== 'broadcast' && name !== 'send') return;
      const first = n.arguments[0] && unwrap(n.arguments[0]);
      const v = !first ? null : ts.isIdentifier(first) ? constantString(prog, file, first.text) : stringValue(first);
      if (v && v.startsWith('desk:')) sent.add(v);
    });
  }
  return sent;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Ordered lists: one line per step, nested steps indented by two spaces

function argShape(a, sf) {
  a = unwrap(a);
  if (!a) return '';
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return JSON.stringify(a.text).replace(/^"|"$/g, "'");
  if (ts.isNumericLiteral(a)) return a.getText(sf).replace(/_/g, '');
  if (a.kind === ts.SyntaxKind.TrueKeyword || a.kind === ts.SyntaxKind.FalseKeyword || a.kind === ts.SyntaxKind.NullKeyword) return a.getText(sf);
  if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) return flat(a, sf); // keeps ?.
  if (isFunctionLike(a)) return 'fn';
  if (ts.isObjectLiteralExpression(a)) return '{…}';
  if (ts.isCallExpression(a) || ts.isNewExpression(a) || ts.isAwaitExpression(a)) return shape(a, sf);
  return '…';
}
/** Type-only wrappers go; parentheses stay (they change what && and || mean). */
const unwrapTypes = (e) => {
  while (e && (ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e;
};
function shape(e, sf) {
  const raw = e;
  e = unwrapTypes(e);
  if (!e) return '';
  if (ts.isParenthesizedExpression(e)) {
    const inner = unwrapTypes(e.expression);
    return ts.isBinaryExpression(inner) || ts.isConditionalExpression(inner) ? `(${shape(inner, sf)})` : shape(inner, sf);
  }
  if (ts.isAwaitExpression(e)) return `await ${shape(e.expression, sf)}`;
  if (ts.isVoidExpression(e)) return `void ${shape(e.expression, sf)}`;
  if (ts.isCallExpression(e)) return `${calleeShape(e.expression, sf)}${e.questionDotToken ? '?.' : ''}(${e.arguments.map((a) => argShape(a, sf)).join(', ')})`;
  if (ts.isNewExpression(e)) return `new ${flat(e.expression, sf)}(${(e.arguments ?? []).map((a) => argShape(a, sf)).join(', ')})`;
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.getText(sf);
    if (/^(?:=|\|\|=|&&=|\?\?=|\+=|-=)$/.test(op)) return `${flat(e.left, sf)} ${op} ${shape(e.right, sf)}`;
    if (op === '&&' || op === '||' || op === '??' || op === ',') return `${shape(e.left, sf)} ${op} ${shape(e.right, sf)}`;
    return flat(e, sf);
  }
  if (ts.isConditionalExpression(e)) return `${flat(e.condition, sf)} ? ${shape(e.whenTrue, sf)} : ${shape(e.whenFalse, sf)}`;
  if (isFunctionLike(e)) return 'fn';
  if (ts.isObjectLiteralExpression(e)) return '{…}';
  return flat(raw, sf);
}
function calleeShape(c, sf) {
  c = unwrap(c);
  if (ts.isPropertyAccessExpression(c)) return `${calleeShape(c.expression, sf)}${c.questionDotToken ? '?.' : '.'}${c.name.text}`;
  if (ts.isCallExpression(c)) return shape(c, sf);
  if (ts.isElementAccessExpression(c)) return `${calleeShape(c.expression, sf)}[${argShape(c.argumentExpression, sf)}]`;
  if (isFunctionLike(c)) return '(fn)';
  return flat(c, sf);
}

/**
 * The steps of a function body, in order. `inline`: functions declared in electron/wiring/*.ts (by name) whose body replaces a call
 * to them, so moving a stretch of main.ts into a wiring function keeps the list. `descend`: callee names whose function argument is
 * itself a list of steps (mutate(async () => ...)).
 */
function steps(body, sf, opts, depth = 0, out = [], seen = new Set()) {
  const pad = '  '.repeat(depth);
  const push = (text) => out.push(pad + text);
  const list = !body ? [] : ts.isBlock(body) ? body.statements : ts.isSourceFile(body) ? body.statements : null;
  if (!list) { stepOfExpr(body, sf, opts, depth, out, seen); return out; }
  for (const st of list) {
    if (ts.isBlock(st)) { steps(st, sf, opts, depth, out, seen); continue; }
    if (ts.isExpressionStatement(st)) { stepOfExpr(st.expression, sf, opts, depth, out, seen); continue; }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const kw = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
        push(d.initializer ? `${kw} ${flat(d.name, sf)} = ${shape(d.initializer, sf)}` : `${kw} ${flat(d.name, sf)}`);
      }
      continue;
    }
    if (ts.isIfStatement(st)) {
      push(`if (${flat(st.expression, sf)})`);
      steps(ts.isBlock(st.thenStatement) ? st.thenStatement : blockOf(st.thenStatement), sf, opts, depth + 1, out, seen);
      if (st.elseStatement) {
        push('else');
        steps(ts.isBlock(st.elseStatement) ? st.elseStatement : blockOf(st.elseStatement), sf, opts, depth + 1, out, seen);
      }
      continue;
    }
    if (ts.isTryStatement(st)) {
      push('try');
      steps(st.tryBlock, sf, opts, depth + 1, out, seen);
      if (st.catchClause) { push('catch'); steps(st.catchClause.block, sf, opts, depth + 1, out, seen); }
      if (st.finallyBlock) { push('finally'); steps(st.finallyBlock, sf, opts, depth + 1, out, seen); }
      continue;
    }
    // An ordered step list (for (const step of <list>) step(…) / await step(…), the list a wire function was given as an array
    // literal: saveSettings' and sync's steps, wiring rewrite step 4): each step's body in place, in the list's order.
    // In a window's step list (secureWindow, step 5b), a shared helper listed among the steps is one line, as the old per-window closure call.
    const hooks = ts.isForOfStatement(st) ? lifecycleSubscribers(st, sf, opts.prog) : null;
    if (hooks) {
      for (const hook of hooks) {
        if (opts.windowHelpers?.has(hook.name)) { push(`${hook.name}()`); continue; }
        if (!seen.has(hook.fn)) steps(hook.fn.body, hook.sf, opts, depth, out, new Set(seen).add(hook.fn));
      }
      continue;
    }
    if (ts.isForOfStatement(st) || ts.isForInStatement(st) || ts.isForStatement(st) || ts.isWhileStatement(st)) {
      const head = ts.isForOfStatement(st) ? `for (${flat(st.initializer, sf)} of ${flat(st.expression, sf)})`
        : ts.isForInStatement(st) ? `for (${flat(st.initializer, sf)} in ${flat(st.expression, sf)})`
        : ts.isWhileStatement(st) ? `while (${flat(st.expression, sf)})` : `for (${st.initializer ? flat(st.initializer, sf) : ''}; ${st.condition ? flat(st.condition, sf) : ''}; ${st.incrementor ? flat(st.incrementor, sf) : ''})`;
      push(head);
      steps(ts.isBlock(st.statement) ? st.statement : blockOf(st.statement), sf, opts, depth + 1, out, seen);
      continue;
    }
    if (ts.isReturnStatement(st)) { push(st.expression ? `return ${shape(st.expression, sf)}` : 'return'); continue; }
    if (ts.isFunctionDeclaration(st)) { push(`function ${st.name?.text ?? ''}`); continue; }
    push(flat(st, sf));
  }
  return out;
}
/** A one-statement stand-in block (ts.isBlock only reads `kind`), for an if/loop body written without braces. */
const blockOf = (statement) => ({ statements: [statement], kind: ts.SyntaxKind.Block });
/**
 * The part runner's wrappers (electron/wiring/parts-wiring.ts, overhaul step 7): `startUnit(part, unit, () => x)`, `startUnitSync(…)`,
 * `tickUnit(…)` run x as a unit's step. A step written that way reads as x itself (a block body as its statements, in place), so wrapping
 * a step never changes an order list; `await startUnit(…, () => x)` reads as `await x`. Which steps are wrapped is pinned elsewhere
 * (tests/part-units.test.ts).
 */
export const UNIT_WRAPPERS = new Set(['startUnit', 'startUnitSync', 'tickUnit']);
function unitWrapped(call) {
  if (!ts.isCallExpression(call) || !UNIT_WRAPPERS.has(dotted(call.expression) ?? '') || call.arguments.length !== 3) return null;
  const fn = unwrap(call.arguments[2]);
  return fn && isFunctionLike(fn) ? fn : null;
}
function stepOfExpr(e, sf, opts, depth, out, seen, prefix = '') {
  const pad = '  '.repeat(depth);
  const wrapped = unitWrapped(unwrap(ts.isAwaitExpression(unwrap(e)) || ts.isVoidExpression(unwrap(e)) ? unwrap(e).expression : e));
  if (wrapped) {
    if (ts.isBlock(wrapped.body)) { steps(wrapped.body, sf, opts, depth, out, seen); return; }
    const outer = unwrap(e);
    const kept = ts.isAwaitExpression(outer) ? 'await ' : ts.isVoidExpression(outer) ? 'void ' : '';
    stepOfExpr(wrapped.body, sf, opts, depth, out, seen, prefix + kept);
    return;
  }
  const inner = unwrap(ts.isAwaitExpression(unwrap(e)) || ts.isVoidExpression(unwrap(e)) ? unwrap(e).expression : e);
  // secureWindow's shared helpers (step 5b): a step calls one with the window's own scope, `h(win, owner, windowId)`, where the old code
  // called its per-window closure `h()`; `x = () => h(win, owner, windowId)` keeps that closure, as `x = h` did. Both read as before.
  if (opts.windowHelpers) {
    const helperCall = (c) => ts.isCallExpression(c) && ts.isIdentifier(c.expression) && opts.windowHelpers.has(c.expression.text) ? windowScopeCall(c, sf) : null;
    const called = helperCall(inner);
    if (called) { out.push(`${pad}${called}()`); return; }
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const right = unwrap(inner.right);
      const kept = isFunctionLike(right) && right.parameters.length === 0 && !ts.isBlock(right.body) ? helperCall(unwrap(right.body)) : null;
      if (kept) { out.push(`${pad}${flat(inner.left, sf)} = ${kept}`); return; }
    }
  }
  if (ts.isCallExpression(inner)) {
    const name = dotted(inner.expression);
    const target = name && opts.inline?.get(name);
    if (target && !seen.has(target.fn)) {
      const s2 = new Set(seen).add(target.fn);
      steps(target.fn.body, target.sf, opts, depth, out, s2);
      return;
    }
    const fnArg = name && opts.descend?.has(name) && inner.arguments.find((a) => isFunctionLike(unwrap(a)));
    if (fnArg) {
      out.push(`${pad}${prefix}${shape(e, sf)} =>`);
      steps(unwrap(fnArg).body, sf, opts, depth + 1, out, seen);
      return;
    }
    // an immediately run function, maybe chained: void (async () => { ... })().catch(...).finally(...)
    let root = inner;
    while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) {
      const next = unwrap(root.expression);
      if (ts.isCallExpression(root) && isFunctionLike(next)) break;
      root = next;
    }
    if (ts.isCallExpression(root) && isFunctionLike(unwrap(root.expression))) {
      out.push(`${pad}${prefix}${shape(e, sf)} =>`);
      steps(unwrap(root.expression).body, sf, opts, depth + 1, out, seen);
      return;
    }
  }
  out.push(pad + prefix + shape(e, sf));
}
/** The steps of a function (block body, or an expression body as one step). */
function stepsOfBody(fn, sf, opts) {
  return fn?.body ? steps(fn.body, sf, opts) : [];
}

/** Functions declared in electron/wiring/*.ts, by name, for inlining. */
function wiringInlines(prog) {
  const map = new Map();
  for (const file of prog.files.filter((f) => f.startsWith('electron/wiring/'))) {
    const sf = prog.sources.get(file);
    for (const [name, fn] of topLevelFunctions(sf)) if (fn.body) map.set(name, { fn, sf });
  }
  return map;
}

function orderedLists(prog, handlers) {
  // A guard (host / scopedHost) and secureWindow are not steps to inline: a handler is listed by name, secureWindow is a list of its own.
  const inline = wiringInlines(prog);
  for (const name of [...handlers.guards.keys(), 'secureWindow']) inline.delete(name);
  const opts = { inline, descend: new Set(['mutate']), prog };
  const lists = { readyChain: null, beforeQuit: [], clock: null, secureWindow: null, saveSettings: null, moduleTimers: [] };
  for (const file of prog.files.filter(isWiringFile)) {
    const sf = prog.sources.get(file);
    visit(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = unwrap(n.expression);
      // app.whenReady().then(async () => { ... })
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'then' && ts.isCallExpression(unwrap(callee.expression))
        && /(?:^|\.)app\.whenReady$/.test(dotted(unwrap(callee.expression).expression) ?? '') && isFunctionLike(unwrap(n.arguments[0]))) {
        if (lists.readyChain) throw new Error('wiring-golden: two app.whenReady().then(...) chains');
        lists.readyChain = stepsOfBody(unwrap(n.arguments[0]), sf, opts);
      }
      // app.on('before-quit', ...) / app.once('before-quit', ...)
      const d = dotted(callee);
      if ((d === 'app.on' || d === 'app.once') && stringValue(n.arguments[0]) === 'before-quit' && isFunctionLike(unwrap(n.arguments[1])))
        lists.beforeQuit.push({ registration: `${d}('before-quit')`, steps: stepsOfBody(unwrap(n.arguments[1]), sf, opts) });
      // the 1-second clock: setInterval(fn, 1_000)
      if (d === 'setInterval' && n.arguments[1] && ts.isNumericLiteral(unwrap(n.arguments[1])) && Number(unwrap(n.arguments[1]).text.replace(/_/g, '')) === 1000 && isFunctionLike(unwrap(n.arguments[0]))) {
        if (lists.clock) throw new Error('wiring-golden: two 1-second clocks');
        lists.clock = stepsOfBody(unwrap(n.arguments[0]), sf, opts);
      }
    });
    // Module-level timers: setInterval / setTimeout statements at the top level of a wiring file.
    for (const st of sf.statements) {
      if (!ts.isExpressionStatement(st)) continue;
      // the statement is a timer call, maybe chained (setInterval(fn, ms).unref()); a timer inside a callback does not count
      let root = unwrap(st.expression);
      while (root && (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) && !(ts.isCallExpression(root) && ts.isIdentifier(unwrap(root.expression)))) root = unwrap(root.expression);
      const timer = !!root && ts.isCallExpression(root) && /^(?:setInterval|setTimeout)$/.test(dotted(root.expression) ?? '');
      if (timer) lists.moduleTimers.push(shape(st.expression, sf));
    }
    // The mood publish (wiring rewrite step 4e, docs/claude/2026-11-16-wiring-step-4e.md): the callback CompanionService is made with,
    // run on every mood publish; its steps in order (her cue's claim among them). Absent in a repo without it (the fake repos).
    visit(sf, (n) => {
      if (!ts.isNewExpression(n) || dotted(n.expression) !== 'CompanionService' || !isFunctionLike(unwrap(n.arguments?.[1]))) return;
      if (lists.moodPublish) throw new Error('wiring-golden: two CompanionService mood callbacks');
      // broadcast stays one step here (its channel is what is pinned), not the shell's loop over the windows
      lists.moodPublish = stepsOfBody(unwrap(n.arguments[1]), sf, { ...opts, inline: new Map([...inline].filter(([name]) => name !== 'broadcast')) });
    });
    // The cue chain (step 4e): who is asked about her mood cue, in order (`const CUE_CHAIN = [{ id, claims }, …]` in the wiring), each
    // step's id and what it does. Absent before the chain was a list (it was one expression in the mood publish, pinned there).
    visit(sf, (n) => {
      if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== 'CUE_CHAIN') return;
      const list = unwrap(n.initializer);
      if (!list || !ts.isArrayLiteralExpression(list)) throw new Error('wiring-golden: CUE_CHAIN is not an array literal');
      if (lists.cueChain) throw new Error('wiring-golden: two CUE_CHAIN lists');
      lists.cueChain = list.elements.map((el) => {
        const step = unwrap(el);
        const prop = (name) => step && ts.isObjectLiteralExpression(step) ? step.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === name) : null;
        const id = prop('id') && stringValue(prop('id').initializer), claims = prop('claims');
        if (!id || !claims) throw new Error(`wiring-golden: a CUE_CHAIN step without an id or claims (${flat(el, sf)})`);
        return `${id}: ${flat(claims.initializer, sf)}`;
      });
    });
    const fns = topLevelFunctions(sf);
    const secure = fns.get('secureWindow');
    if (secure) lists.secureWindow = secureWindowOrder(secure, sf, opts);
  }
  const save = handlers.all.find((h) => h.name === 'saveSettings');
  if (save) {
    const sf = prog.sources.get(save.file);
    lists.saveSettings = stepsOfBody(unwrap(save.node.arguments[1]), sf, opts);
  }
  // sync (electron/wiring/settings-wiring.ts since wiring rewrite step 4): the settings part's own lines, then its step list in place.
  // Only the list is expanded (a call in a step stays one line), so a step's text, not a helper it calls, is what is pinned.
  const syncFns = [];
  for (const file of prog.files.filter(isWiringFile)) {
    const sf = prog.sources.get(file);
    visit(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === 'sync' && n.body) syncFns.push({ fn: n, sf }); });
  }
  if (syncFns.length > 1) throw new Error('wiring-golden: two functions named sync in the wiring');
  if (syncFns.length === 1 && lists.saveSettings) lists.sync = stepsOfBody(syncFns[0].fn, syncFns[0].sf, { inline: new Map(), descend: new Set(), prog });
  for (const [k, v] of Object.entries(lists)) if (v === null) throw new Error(`wiring-golden: could not find ${k}`);
  return lists;
}

/** secureWindow: the window and webContents events in registration order, each with its steps; local helpers listed once. */
function secureWindowOrder(fn, sf, opts) {
  const locals = {};
  const events = [];
  const other = [];
  const seen = new Set([fn]);
  walkSecure(fn.body.statements, sf, opts);
  return { events, locals, other };
  // A statement list of secureWindow; a call to a wiring function (the shell's security half) and the subscribers it dispatches to
  // (for (const s of list) s(win, owner, windowId), the list given to the lifecycle's wire function) are read in place, in order.
  function walkSecure(statements, sf, o) {
    for (const st of statements) {
      const subscriberList = lifecycleSubscribers(st, sf, o.prog);
      if (subscriberList) {
        for (const sub of subscriberList) if (!seen.has(sub.fn)) { seen.add(sub.fn); walkSecure(sub.fn.body.statements, sub.sf, o); }
        continue;
      }
      const listeners = windowListenerList(st, sf, o.prog);
      if (listeners) { readWindowListeners(listeners, o); continue; }
      if (ts.isExpressionStatement(st) && ts.isCallExpression(unwrap(st.expression))) {
        const name = dotted(unwrap(st.expression).expression);
        const target = name && o.inline?.get(name);
        if (target && !seen.has(target.fn)) { seen.add(target.fn); walkSecure(target.fn.body.statements, target.sf, o); continue; }
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && isFunctionLike(unwrap(d.initializer))) locals[d.name.text] = stepsOfBody(unwrap(d.initializer), sf, o);
          else other.push(`const ${flat(d.name, sf)} = ${shape(d.initializer, sf)}`);
        }
        continue;
      }
      if (ts.isExpressionStatement(st) && ts.isCallExpression(unwrap(st.expression))) {
        const call = unwrap(st.expression);
        const d = dotted(call.expression) ?? '';
        const m = /^(win|win\.webContents)\.(on|once)$/.exec(d);
        if (m) {
          const handler = unwrap(call.arguments[1]);
          events.push({ on: `${m[1]}.${m[2]}('${stringValue(call.arguments[0])}')`,
            steps: isFunctionLike(handler) ? stepsOfBody(handler, sf, o) : [`→ ${shape(handler, sf)}`] });
          continue;
        }
      }
      for (const line of steps(blockOf(st), sf, o)) other.push(line);
    }
  }
  // Wiring rewrite step 5b (electron/wiring/window-events-wiring.ts): the order electron/main.ts gives wireWindowEvents, read in place.
  // `helpers` are the old per-window closures (listed once under locals, in the list's order; a step names one as `h(win, owner, windowId)`).
  // Each listener `[target, event, run]` is one registration, in order: run a list of steps (each step's body in place, a helper as `h()`)
  // or one helper (`→ h`). A bare step runs once when the window is secured: its statements are read like secureWindow's own.
  function readWindowListeners(list, o) {
    for (const call of list.calls) {
      const helperNames = namesIn(call.container, 'helpers', call.sf);
      const helpers = new Map(helperNames.map((name) => [name, wiringFunction(o.prog, name)]));
      const wo = { ...o, windowHelpers: helpers };
      for (const [name, h] of helpers) locals[name] = stepsOfBody(h.fn, h.sf, wo);
      for (const el of call.elements) {
        const e = unwrap(el);
        if (ts.isIdentifier(e)) {
          const f = wiringFunction(o.prog, e.text);
          if (!seen.has(f.fn)) { seen.add(f.fn); walkSecure(f.fn.body.statements, f.sf, wo); }
          continue;
        }
        const [target, event, run] = ts.isArrayLiteralExpression(e) ? e.elements.map(unwrap) : [];
        const where = { win: 'win', webContents: 'win.webContents' }[stringValue(target) ?? ''];
        if (!where || !stringValue(event) || !run) throw new Error(`wiring-golden: a window listener must be ['win' | 'webContents', 'event', steps] (${flat(el, call.sf)})`);
        const on = `${where}.on('${stringValue(event)}')`;
        if (ts.isIdentifier(run)) {
          if (!helpers.has(run.text)) throw new Error(`wiring-golden: the ${on} listener ${run.text} is one step but not a shared helper`);
          events.push({ on, steps: [`→ ${run.text}`] });
          continue;
        }
        if (!ts.isArrayLiteralExpression(run)) throw new Error(`wiring-golden: the ${on} listener's steps must be an array literal`);
        const lines = [];
        for (const s of run.elements.map(unwrap)) {
          if (!ts.isIdentifier(s)) throw new Error(`wiring-golden: a window step ${flat(s, call.sf)} is not a function name`);
          if (helpers.has(s.text)) { lines.push(`${s.text}()`); continue; }
          const f = wiringFunction(o.prog, s.text);
          lines.push(...stepsOfBody(f.fn, f.sf, wo));
        }
        events.push({ on, steps: lines });
      }
    }
  }
}
/** The identifiers of an array-literal property of an object literal ([] when there is none). */
function namesIn(object, prop, sf) {
  const p = object?.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === prop);
  const arr = p && unwrap(p.initializer);
  if (!arr) return [];
  if (!ts.isArrayLiteralExpression(arr)) throw new Error(`wiring-golden: ${prop} must be an array literal`);
  return arr.elements.map((el) => { const id = unwrap(el); if (!ts.isIdentifier(id)) throw new Error(`wiring-golden: ${flat(el, sf)} in ${prop} is not a function name`); return id.text; });
}
/** The one top-level function of that name in the wiring (the first file that has it), with its file. */
function wiringFunction(prog, name) {
  for (const file of prog.files.filter(isWiringFile)) { const fn = topLevelFunctions(prog.sources.get(file)).get(name); if (fn?.body) return { fn, sf: prog.sources.get(file), name }; }
  throw new Error(`wiring-golden: cannot find the wiring function ${name}`);
}
/** secureWindow's listener list (step 5b): a for-of over a list given as an object literal's property next to `helpers`. Null: not this form. */
function windowListenerList(st, sf, prog) {
  const list = wiredList(st, sf, prog);
  return list && list.prop && list.calls.length && list.calls.every((c) => namesIn(c.container, 'helpers', c.sf).length) ? list : null;
}

/**
 * A list a wire function was given: for (const x of <list>) … over a module variable that the wire function in the same file sets from
 * one of its parameters (`<list> = …param…`, or `…param.<name>…` for one property of an object literal it is given). Each wiring call's
 * array literal, with the object literal it is a property of (null for a plain array argument). Null: not this form.
 */
function wiredList(st, sf, prog) {
  if (!prog || !ts.isForOfStatement(st) || !ts.isIdentifier(unwrap(st.expression))) return null;
  const listName = unwrap(st.expression).text;
  // the wire function in the same file: function w(…, list, …) { <listName> = …list… } (or …list.<prop>…)
  let wireName = null;
  let wireArg = 0;
  let prop = null;
  for (const [name, fn] of topLevelFunctions(sf)) {
    (fn.parameters ?? []).forEach((p, index) => {
      if (!ts.isIdentifier(p.name)) return;
      const param = new RegExp(`\\b${p.name.text}\\b(?:\\.(\\w+))?`);
      visit(fn, (n) => {
        if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(n.left) || n.left.text !== listName) return;
        const m = param.exec(n.right.getText(sf));
        if (m) { wireName = name; wireArg = index; prop = m[1] ?? null; }
      });
    });
  }
  if (!wireName) return null;
  const calls = [];
  for (const file of prog.files.filter(isWiringFile)) {
    const wsf = prog.sources.get(file);
    visit(wsf, (n) => {
      if (!ts.isCallExpression(n) || dotted(n.expression) !== wireName) return;
      let arr = unwrap(n.arguments[wireArg]);
      let container = null;
      if (prop) {
        if (!arr || !ts.isObjectLiteralExpression(arr)) throw new Error(`wiring-golden: ${wireName}(…) at ${file}:${lineOf(n, wsf)} must be given an object literal`);
        container = arr;
        const p = arr.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(wsf) === prop);
        arr = p && unwrap(p.initializer);
      }
      if (!arr || !ts.isArrayLiteralExpression(arr)) throw new Error(`wiring-golden: ${wireName}(…) at ${file}:${lineOf(n, wsf)} must be given an array literal${prop ? ` as ${prop}` : ''}`);
      calls.push({ elements: arr.elements, sf: wsf, container });
    });
  }
  return { wireName, prop, calls };
}

/**
 * secureWindow's dispatch (electron/wiring/lifecycle-wiring.ts), the step lists of saveSettings and sync (electron/wiring/settings-wiring.ts),
 * the mood publish, the quit steps and a window's step lists (step 5b): for (const s of <list>) s(…) (or await s(…)) over a list a wire
 * function was given (wiredList); that argument's functions, in order, from the wiring call (wireLifecycle([a, b]), wireSaveSettings([a], [b]),
 * wireWindowEvents({ newDocument: [a, b] })). Null: not this form.
 */
function lifecycleSubscribers(st, sf, prog) {
  if (!prog || !ts.isForOfStatement(st) || !ts.isIdentifier(unwrap(st.expression))) return null;
  const body = ts.isBlock(st.statement) ? (st.statement.statements.length === 1 ? st.statement.statements[0] : null) : st.statement;
  const decl = st.initializer.declarations?.[0];
  const called = body && ts.isExpressionStatement(body) ? unwrap(ts.isAwaitExpression(unwrap(body.expression)) ? unwrap(body.expression).expression : body.expression) : null;
  if (!called || !decl || !ts.isIdentifier(decl.name) || !ts.isCallExpression(called) || dotted(called.expression) !== decl.name.text) return null;
  const list = wiredList(st, sf, prog);
  if (!list) return null;
  const out = [];
  for (const call of list.calls) {
    for (const el of call.elements) {
      const id = unwrap(el);
      if (!ts.isIdentifier(id)) throw new Error(`wiring-golden: ${list.wireName} subscriber ${flat(el, call.sf)} is not a function name`);
      let found = null;
      for (const f2 of prog.files.filter(isWiringFile)) { const fn = topLevelFunctions(prog.sources.get(f2)).get(id.text); if (fn?.body) { found = { fn, sf: prog.sources.get(f2), name: id.text }; break; } }
      if (!found) throw new Error(`wiring-golden: cannot find the subscriber ${id.text} of ${list.wireName}`);
      out.push(found);
    }
  }
  return out;
}
/** A step calls a window helper with the window's own scope (win, owner, windowId): the helper's name; anything else is an error. */
function windowScopeCall(call, sf) {
  const args = call.arguments.map((a) => unwrap(a));
  if (args.length !== 3 || args.some((a, i) => !ts.isIdentifier(a) || a.text !== ['win', 'owner', 'windowId'][i]))
    throw new Error(`wiring-golden: the window helper ${call.expression.getText(sf)} must be called with the window's scope (win, owner, windowId)`);
  return call.expression.text;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The golden

export function buildGolden(root = DEFAULT_ROOT) {
  const prog = loadProgram(root);
  const handlers = collectHandlers(prog);
  if (handlers.unreached.length) throw new Error(`wiring-golden: handlers in files no wiring call reaches: ${handlers.unreached.join(', ')}`);
  const window = recordedWindow(prog);
  const siteRecorded = (node) => !!window && node.getSourceFile().fileName === window.file && enclosingFunction(node) && node.getStart() >= window.from && node.getStart() < window.to && within(node, window.fn);
  const within = (node, fn) => { for (let p = node; p; p = p.parent) if (p === fn) return true; return false; };

  const byName = new Map();
  for (const h of handlers.all) {
    const prev = byName.get(h.name);
    if (prev) { prev.count++; continue; }
    byName.set(h.name, { controlOnly: h.controlOnly, count: 1, h });
  }
  // Which handlers the agent channel's recorder sees: direct ones by position, a part's ones by the position of the call that handed it
  // the registrar (one part file may be reached from several calls: recorded if any of them is in the window).
  const recorded = new Set();
  for (const h of handlers.all) {
    if (siteRecorded(h.node) || handlers.sites.some((s) => s.files.has(h.file) && siteRecorded(s.node))) recorded.add(h.name);
  }
  const agentList = readStringArray(prog.sources.get(AGENT_BRIDGE), 'AGENT_HOST_OPERATIONS');
  const agentPetList = readStringArray(prog.sources.get(AGENT_BRIDGE), 'AGENT_PET_OPERATIONS');

  const { invokes, subscribes } = preloadSurface(prog);
  const otherListens = otherPreloadListens(prog);
  const sent = sentChannels(prog);
  const names = [...byName.keys()].sort();
  const flagged = (flag) => names.filter((n) => byName.get(n).controlOnly === flag);
  const other = names.filter((n) => typeof byName.get(n).controlOnly !== 'boolean');
  const golden = {
    note: 'Generated by `node scripts/dev/wiring-golden.mjs --write` (docs/claude/2026-11-16-wiring-steps-0-2.md); tests/wiring-golden.test.mjs compares. Every step of the wiring rewrite is checked against it: regenerate only for an intended change and say why in the commit.',
    counts: {
      handlers: names.length,
      controlOnly: flagged(true).length,
      eitherWindow: flagged(false).length,
      preloadInvokes: invokes.size,
      preloadSubscribes: subscribes.size,
      sentChannels: sent.size,
      registrarSites: handlers.sites.length,
    },
    handlers: {
      controlOnly: flagged(true),
      eitherWindow: flagged(false),
      ...(other.length ? { computedFlag: Object.fromEntries(other.map((n) => [n, byName.get(n).controlOnly])) } : {}),
      registeredTwice: names.filter((n) => byName.get(n).count > 1),
    },
    registrarSites: handlers.sites.map((s) => s.text),
    agentChannel: {
      petOperations: [...agentPetList].sort(),
      recorded: agentList.filter((m) => recorded.has(m)).sort(),
      notRecorded: agentList.filter((m) => !recorded.has(m)).sort(),
    },
    preload: {
      invokeWithoutHandler: [...invokes].filter((m) => !byName.has(m)).sort(),
      handlerWithoutInvoke: names.filter((m) => !invokes.has(m)).sort(),
      subscribeWithoutSender: [...subscribes].filter((c) => !sent.has(c)).sort(),
      sentWithoutSubscriber: [...sent].filter((c) => !subscribes.has(c) && !otherListens.has(c)).sort(),
      sentToOtherPreloads: [...sent].filter((c) => !subscribes.has(c) && otherListens.has(c)).sort(),
    },
    sentChannels: [...sent].sort(),
    order: orderedLists(prog, handlers),
  };
  const privacy = privacyOrder(root);
  if (privacy) golden.privacy = privacy;
  return golden;
}

/**
 * Wiring rewrite step 4d (记忆, docs/claude/2026-11-16-wiring-step-4d.md): the order deleting a character with her memories and turning
 * 「允许记录」 off go through the stores. It comes from the data map (electron/foundation/data-map.ts), never from the order the parts
 * register their stores in; this runs the real order functions (transpiled, nothing else loaded) so a reordered row, a changed rule in
 * electron/memory/recycle/character.ts or a runner that walks the registry instead changes the golden. Absent in a repo without them.
 */
/** The data map's row files (electron/foundation/data-map.ts is the index that spreads them in this order). */
export const DATA_MAP_ROW_FILES = ['electron/foundation/data-map-rows-memory.ts', 'electron/foundation/data-map-rows-app.ts', 'electron/foundation/data-map-rows-character.ts'];
export function privacyOrder(root) {
  const files = { map: 'electron/foundation/data-map.ts', rows: DATA_MAP_ROW_FILES, character: 'electron/memory/recycle/character.ts', privacy: 'electron/memory/privacy-wiring.ts' };
  if (![files.map, files.character, files.privacy, ...files.rows].every((f) => fs.existsSync(path.join(root, f)))) return null;
  const load = (file, deps) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    new Function('exports', 'require', 'module', code)(module.exports, (spec) => {
      const hit = Object.entries(deps).find(([suffix]) => spec.endsWith(suffix));
      if (!hit) throw new Error(`wiring-golden: ${file} needs ${spec} at run time`);
      return hit[1];
    }, module);
    return module.exports;
  };
  // The table is split into row files (2026-11-18); the index imports them by relative path, so they load first.
  const names = load('shared/foundation/assistant-name.ts', {}); // I-217: the row texts are built from the name constants
  const map = load(files.map, { '/assistant-name': names, ...Object.fromEntries(files.rows.map((f) => ['/' + path.basename(f, '.ts'), load(f, { '/assistant-name': names })])) });
  const character = load(files.character, { '/foundation/data-map': map });
  const privacy = load(files.privacy, { '/foundation/data-map': map });
  // Recording-off: run the real runner over a registry built in reverse table order; it must call the clears in the table's order.
  const run = (reason) => {
    const called = [];
    const registry = Object.fromEntries([...map.recordingOffIds()].reverse().map((id) => [id, () => { called.push(id); }]));
    privacy.runRecordingOff(registry, { characterId: 'c', providerScope: 'p' }, reason);
    return called;
  };
  const ids = map.recycleIds();
  return {
    forgetCapture: ids,
    forgetRemove: character.removeOrder(ids),
    forgetRestore: character.restoreOrder(ids),
    cardOnlyRemove: character.removeOrder(character.CARD_ROWS),
    recordingOff: run('recording-off'),
    diaryCleared: run('diary-cleared'),
  };
}

/** Channels the other preloads (reply window, single emoji, ...) listen on with ipcRenderer.on('desk:x'). */
function otherPreloadListens(prog) {
  const out = new Set();
  for (const file of prog.files.filter((f) => isPreload(f) && f !== PRELOAD)) visit(prog.sources.get(file), (n) => {
    if (ts.isCallExpression(n) && /(?:^|\.)ipcRenderer\.(?:on|once)$/.test(dotted(n.expression) ?? '')) {
      const v = n.arguments[0] && stringValue(n.arguments[0]);
      if (v?.startsWith('desk:')) out.add(v);
    }
  });
  return out;
}

function readStringArray(sf, name) {
  let out = null;
  visit(sf, (n) => {
    if (out || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== name) return;
    let init = unwrap(n.initializer);
    if (ts.isCallExpression(init)) init = unwrap(init.arguments[0]);
    if (init && ts.isArrayLiteralExpression(init)) out = init.elements.map((e) => stringValue(e));
  });
  if (!out || out.some((v) => v === null)) throw new Error(`wiring-golden: cannot read ${name}`);
  return out;
}

export const serialize = (golden) => JSON.stringify(golden, null, 1) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const golden = buildGolden(DEFAULT_ROOT);
  if (args.includes('--json')) process.stdout.write(serialize(golden));
  else {
    console.log(JSON.stringify(golden.counts));
    console.log('preload mismatches:', JSON.stringify(golden.preload));
    console.log('agent channel:', JSON.stringify({ recorded: golden.agentChannel.recorded.length, notRecorded: golden.agentChannel.notRecorded }));
    console.log('handlers:', JSON.stringify({ computedFlag: golden.handlers.computedFlag ?? {}, registeredTwice: golden.handlers.registeredTwice }));
    console.log('order:', Object.fromEntries(Object.entries(golden.order).map(([k, v]) => [k, Array.isArray(v) ? v.length : v.events?.length ?? Object.keys(v).length])));
  }
  if (args.includes('--write')) {
    fs.mkdirSync(path.join(DEFAULT_ROOT, path.dirname(GOLDEN_FILE)), { recursive: true });
    fs.writeFileSync(path.join(DEFAULT_ROOT, GOLDEN_FILE), serialize(golden));
    console.log(`written ${GOLDEN_FILE}`);
  }
}
