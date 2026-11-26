#!/usr/bin/env node
// The renderer golden (overhaul step 5, front-end half: docs/claude/2026-11-16-src-main-split.md). A static picture of how the
// renderer entry (src/main.ts) starts each window, read with the TypeScript parser (no type checker, nothing run):
//   - per window (companion, control), the ordered start-up events: every `window.desktop.on*` subscription, every other DesktopAPI call,
//     every `new X(…)`, addEventListener, handler property (`x.onmessage = …`), timer and other call that runs while the window
//     starts, and each `await` between them;
//   - how many times each `window.desktop.on*` subscription is written anywhere in the renderer wiring.
// "While the window starts" means: src/main.ts's own top-level statements in order (imports and declarations skipped), with every
// call to a function declared at the top level of the renderer wiring (src/main.ts, src/wiring/*.ts) read in place, recursively.
// Callbacks (arrow functions and function expressions) are not entered: they run later. `isPet` is taken as true for the companion
// window and false for the control window wherever a condition or `? :` depends only on it (`isPet`, `!isPet`, `isPet && x`, …);
// a branch the window cannot decide is read in source order. No file paths are kept, so code can move between the wiring files.
//   node scripts/dev/renderer-golden.mjs            print a summary
//   node scripts/dev/renderer-golden.mjs --write    regenerate tests/fixtures/renderer-golden.json (tests/renderer-golden.test.mjs)
//   node scripts/dev/renderer-golden.mjs --json     print the golden
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
export const RENDERER_GOLDEN_FILE = 'tests/fixtures/renderer-golden.json';
export const RENDERER_ENTRY = 'src/main.ts';

/** The renderer wiring: the entry, then src/wiring/*.ts in name order (repo-relative paths). */
export function rendererWiringFiles(root = DEFAULT_ROOT) {
  const folder = path.join(root, 'src', 'wiring');
  const wiring = fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith('.ts')).sort().map((name) => `src/wiring/${name}`) : [];
  return [RENDERER_ENTRY, ...wiring];
}

function parseAll(root) {
  return rendererWiringFiles(root).map((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return { file, ast: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
  });
}

/** Calls that only read or format (DOM lookups, text helpers): not events, not read in place. */
const QUIET = new Set(['$', 'text', 'uiText', 'uiTemplate', 'uiMarkup', 'uiHtml', 'fillUiLanguageSelect', 'document.getElementById', 'document.createElement',
  'document.querySelector', 'structuredClone', 'String', 'Number', 'JSON.stringify', 'performance.now', 'Date.now', 'crypto.randomUUID',
  'Promise.resolve', 'normalizeModelPhysicsSettings', 'normalizeMusicSettings', 'new URLSearchParams(…).has']);
/**
 * Constructors with no effect but the object itself (checked by reading them, 2026-11-16): not events, and a wiring file may make
 * one on import (importTimeEffects).
 */
const PURE_NEW = new Set(['Map', 'Set', 'WeakMap', 'URLSearchParams', 'VoiceDraftInput', 'ReplyPresentationState', 'WindowVisibilityTracker', 'FishVoiceFallback']);

const unwrap = (node) => {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
};
const flat = (text) => text.replace(/\?\./g, '.').replace(/\s+/g, ' ').replace(/<[^<>()]*>(?=\()/g, '');
/** A callee's name with every inner call's arguments shown as "…" (`window.desktop.getTtsBudget(…).then`, `$(…).closest`). */
function calleeName(node) {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node)) return `${calleeName(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) return `${calleeName(node.expression)}[${flat(node.argumentExpression.getText())}]`;
  if (ts.isCallExpression(node)) return `${calleeName(node.expression)}(…)`;
  if (ts.isNewExpression(node)) return `new ${flat(node.expression.getText())}(…)`;
  return flat(node.getText());
}
const isFunctionLike =(node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node);

/** true / false when the expression's value is decided by the window alone; undefined otherwise. */
function windowValue(node, pet) {
  node = unwrap(node);
  if (ts.isIdentifier(node) && node.text === 'isPet') return pet;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = windowValue(node.operand, pet);
    return value === undefined ? undefined : !value;
  }
  if (ts.isBinaryExpression(node)) {
    const left = windowValue(node.left, pet), right = windowValue(node.right, pet);
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left === false || right === false) return false;
      if (left === true && right === true) return true;
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      if (left === true || right === true) return true;
      if (left === false && right === false) return false;
    }
  }
  return undefined;
}

/** Every top-level function declaration of the renderer wiring, by name (a name declared twice is an error). */
function topFunctions(files) {
  const functions = new Map();
  for (const { file, ast } of files) for (const statement of ast.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    if (functions.has(statement.name.text)) throw new Error(`renderer golden: ${statement.name.text} is declared in ${functions.get(statement.name.text).file} and ${file}`);
    functions.set(statement.name.text, { file, node: statement, ast });
  }
  return functions;
}

function startupEvents(files, functions, pet) {
  const events = [];
  const stack = [];
  const RETURNED = Symbol('returned');
  const record = (event) => events.push(event);

  function expandable(call) {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee) || QUIET.has(callee.text)) return null;
    const found = functions.get(callee.text);
    return found && !stack.includes(callee.text) ? found : null;
  }

  function expression(node) {
    if (!node) return;
    node = unwrap(node);
    if (isFunctionLike(node) || ts.isClassExpression(node)) return; // runs later
    if (ts.isAwaitExpression(node)) {
      const inner = unwrap(node.expression);
      expression(node.expression);
      if (!(ts.isCallExpression(inner) && expandable(inner))) record('await');
      return;
    }
    if (ts.isConditionalExpression(node)) {
      const value = windowValue(node.condition, pet);
      if (value === undefined) { expression(node.condition); expression(node.whenTrue); expression(node.whenFalse); }
      else expression(value ? node.whenTrue : node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
        const left = windowValue(node.left, pet);
        expression(node.left);
        if (kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false) return;
        if (kind === ts.SyntaxKind.BarBarToken && left === true) return;
        expression(node.right);
        return;
      }
      if (kind === ts.SyntaxKind.EqualsToken) {
        const target = unwrap(node.left), value = unwrap(node.right);
        if (!ts.isIdentifier(target)) expression(target);
        expression(node.right);
        if (isFunctionLike(value) && ts.isPropertyAccessExpression(target)) record(`set:${flat(target.getText())}`);
        return;
      }
      expression(node.left); expression(node.right);
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) expression(callee.expression);
      for (const argument of node.arguments) expression(argument);
      const found = expandable(node);
      if (found) {
        stack.push(found.node.name.text);
        statements(found.node.body.statements);
        stack.pop();
        return;
      }
      const name = calleeName(callee);
      if (QUIET.has(name)) return;
      const desktop = /^window\.desktop\.(\w+)$/.exec(name);
      if (desktop) record(/^on[A-Z]/.test(desktop[1]) ? `on:${desktop[1]}` : `api:${desktop[1]}`);
      else if (/\.addEventListener$/.test(name) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) record(`listen:${flat(name.slice(0, -'.addEventListener'.length))}:${node.arguments[0].text}`);
      else if (name === 'setInterval' || name === 'setTimeout' || name === 'queueMicrotask') record(`timer:${name}`);
      else record(`call:${name}`);
      return;
    }
    if (ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) expression(argument);
      if (!PURE_NEW.has(flat(node.expression.getText()))) record(`new:${flat(node.expression.getText())}`);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) expression(property.initializer);
        else if (ts.isSpreadAssignment(property)) expression(property.expression);
      }
      return;
    }
    ts.forEachChild(node, (child) => { if (ts.isExpression(child)) expression(child); });
  }

  /** Reads statements in order; RETURNED when one of them certainly returns from the function being read. */
  function statements(list) {
    for (const statement of list) if (one(statement) === RETURNED) return RETURNED;
    return undefined;
  }
  function one(node) {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isEmptyStatement(node)) return undefined;
    if (ts.isBlock(node)) return statements(node.statements);
    if (ts.isExpressionStatement(node)) return void expression(node.expression);
    if (ts.isVariableStatement(node)) { for (const declaration of node.declarationList.declarations) expression(declaration.initializer); return undefined; }
    if (ts.isIfStatement(node)) {
      const value = windowValue(node.expression, pet);
      if (value === undefined) {
        expression(node.expression);
        one(node.thenStatement);
        if (node.elseStatement) one(node.elseStatement);
        return undefined;
      }
      if (value) return one(node.thenStatement);
      return node.elseStatement ? one(node.elseStatement) : undefined;
    }
    if (ts.isReturnStatement(node)) { expression(node.expression); return RETURNED; }
    if (ts.isTryStatement(node)) {
      const result = statements(node.tryBlock.statements);
      if (node.finallyBlock) statements(node.finallyBlock.statements);
      return result;
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) { expression(node.expression); one(node.statement); return undefined; }
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) { one(node.statement); return undefined; }
    if (ts.isThrowStatement(node)) { expression(node.expression); return RETURNED; }
    ts.forEachChild(node, (child) => { if (ts.isExpression(child)) expression(child); });
    return undefined;
  }

  const entry = files.find((source) => source.file === RENDERER_ENTRY);
  statements(entry.ast.statements);
  return events;
}

/** How many times each `window.desktop.on*` subscription is written anywhere in the renderer wiring (calls only). */
function subscriptionCounts(files) {
  const counts = {};
  for (const { ast } of files) {
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const name = flat(unwrap(node.expression).getText(ast));
        const match = /^window\.desktop\.(on[A-Z]\w*)$/.exec(name);
        if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Statements of the non-entry wiring files that would run on import (before the entry decides the window): anything at the top
 * level other than imports, exports of declarations, types, function declarations and variables whose value is a literal, a
 * function, a PURE_NEW construction, or a call in PURE_AT_IMPORT. Must stay empty (tests/renderer-golden.test.mjs).
 */
// windowSendGuard (src/brain/send-guard.ts, 2026-11-22): only builds the guard object; its ports read the window and the host when used.
const PURE_AT_IMPORT = new Set(['structuredClone', 'normalizeModelPhysicsSettings', 'normalizeMusicSettings', 'uiText', 'Promise.resolve', 'windowSendGuard']);
export function importTimeEffects(root = DEFAULT_ROOT) {
  const effects = [];
  const files = parseAll(root);
  // A value read on import from another wiring file can be in its temporal dead zone (the files import each other): not pure.
  const namesOf = new Map(files.map(({ file, ast }) => [file, new Set(ast.statements.flatMap((s) => ts.isFunctionDeclaration(s) && s.name ? []
    : ts.isVariableStatement(s) ? s.declarationList.declarations.map((d) => d.name.getText(ast)) : []))]));
  let foreign = new Set();
  const pure = (node) => {
    if (!node) return true;
    node = unwrap(node);
    if (ts.isIdentifier(node)) return !foreign.has(node.text);
    if (isFunctionLike(node) || ts.isLiteralExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isPrefixUnaryExpression(node)) return pure(node.operand);
    if (ts.isPropertyAccessExpression(node)) return pure(node.expression);
    if (ts.isObjectLiteralExpression(node)) return node.properties.every((p) => ts.isPropertyAssignment(p) ? pure(p.initializer) : (ts.isShorthandPropertyAssignment(p) && pure(p.name)) || ts.isMethodDeclaration(p) || (ts.isSpreadAssignment(p) && pure(p.expression)));
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(pure);
    if (ts.isNewExpression(node)) return PURE_NEW.has(node.expression.getText()) && (node.arguments ?? []).every(pure);
    if (ts.isCallExpression(node)) return PURE_AT_IMPORT.has(flat(node.expression.getText())) && node.arguments.every(pure);
    return false;
  };
  for (const { file, ast } of files) {
    if (file === RENDERER_ENTRY) continue;
    foreign = new Set([...namesOf].filter(([other]) => other !== file).flatMap(([, names]) => [...names]));
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        || ts.isInterfaceDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.every((d) => pure(d.initializer))) continue;
      effects.push(`${file}: ${flat(statement.getText(ast)).slice(0, 120)}`);
    }
  }
  return effects;
}

export function buildRendererGolden(root = DEFAULT_ROOT) {
  const files = parseAll(root);
  const functions = topFunctions(files);
  const pet = startupEvents(files, functions, true);
  const controls = startupEvents(files, functions, false);
  const subscriptions = (events) => events.filter((event) => event.startsWith('on:')).map((event) => event.slice(3));
  const desktopCalls = (events) => events.filter((event) => event.startsWith('api:')).map((event) => event.slice(4));
  return {
    counts: { petEvents: pet.length, controlEvents: controls.length, petSubscriptions: subscriptions(pet).length, controlSubscriptions: subscriptions(controls).length },
    subscriptions: { pet: subscriptions(pet), controls: subscriptions(controls) },
    startupDesktopCalls: { pet: desktopCalls(pet), controls: desktopCalls(controls) },
    startup: { pet, controls },
    subscriptionCounts: subscriptionCounts(files),
  };
}

function main() {
  const root = DEFAULT_ROOT;
  const golden = buildRendererGolden(root);
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(golden, null, 1)}\n`); return; }
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(root, RENDERER_GOLDEN_FILE), `${JSON.stringify(golden, null, 1)}\n`);
    console.log(`wrote ${RENDERER_GOLDEN_FILE}`);
  }
  console.log(golden.counts);
  const effects = importTimeEffects(root);
  console.log(`import-time effects in src/wiring: ${effects.length}`);
  for (const effect of effects) console.log(`  ${effect}`);
  const file = path.join(root, RENDERER_GOLDEN_FILE);
  if (fs.existsSync(file) && !process.argv.includes('--write')) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of Object.keys(saved)) if (JSON.stringify(saved[key]) !== JSON.stringify(golden[key])) console.log(`differs: ${key}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
