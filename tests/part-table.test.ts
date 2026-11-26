// Wiring rewrite step 5 (docs/claude/2026-11-17-wiring-step-5.md): electron/main.ts hands every part one table of needs (`parts`) instead
// of a literal per wire call. What the move must keep that the wiring golden does not say by itself:
// - every entry is read when the part reads it: a getter, or a function that calls the current one (a plain value would be read once,
//   when the table is made, before most of what it names exists: a part would keep `undefined` or an old object);
// - the wire calls run while electron/main.ts is evaluated, in the order they had (a part made before what its early() reads, or after a
//   part that reads it while being made, breaks start-up), each handed the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = 'electron/main.ts';
const ast = ts.createSourceFile(MAIN, fs.readFileSync(path.join(ROOT, MAIN), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function table(): ts.ObjectLiteralExpression {
  for (const st of ast.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.name.text === 'parts' && d.initializer && ts.isObjectLiteralExpression(d.initializer)) return d.initializer;
  }
  assert.fail('electron/main.ts declares the table `const parts = { ... }` at the top level');
}
const isFn = (e: ts.Expression) => ts.isArrowFunction(e) || ts.isFunctionExpression(e);

test('the part table: every entry is read when used (a getter or a function), never a value taken when the table is made', () => {
  const lazy: string[] = [];
  const eager: string[] = [];
  for (const p of table().properties) {
    const name = p.name?.getText(ast) ?? p.getText(ast);
    if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isMethodDeclaration(p)) { lazy.push(name); continue; }
    if (ts.isPropertyAssignment(p) && isFn(p.initializer)) { lazy.push(name); continue; }
    // a group of functions (Unbound's peek, the test commands' ports): each member is a function too
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)
      && p.initializer.properties.every(q => ts.isPropertyAssignment(q) && isFn(q.initializer))) { lazy.push(name); continue; }
    eager.push(name);
  }
  assert.deepEqual(eager, [], 'entries read when the table is made');
  assert.ok(lazy.length > 150, `the table holds every part's needs (${lazy.length})`);
  const names = lazy.filter((n, i) => lazy.indexOf(n) !== i && !table().properties.some(p => ts.isSetAccessorDeclaration(p) && p.name.getText(ast) === n));
  assert.deepEqual(names, [], 'each entry is written once');
});

test('the wire calls: evaluated with electron/main.ts, in their old order, each handed the table', () => {
  const order: string[] = [];
  for (const st of ast.statements) {
    const call = ts.isExpressionStatement(st) ? st.expression
      : ts.isVariableStatement(st) && st.declarationList.declarations.length === 1 ? st.declarationList.declarations[0].initializer : undefined;
    if (!call || !ts.isCallExpression(call)) continue;
    const callee = call.expression.getText(ast);
    if (!/^wire[A-Z]\w*$|\.early$/.test(callee)) continue;
    order.push(callee);
    if (/^wire(?:Health|Stage|Unbound|Shell|Cards|Memory|Voice|Brain|Initiative|Safety|Mood|Senses|Settings|Actions)$/.test(callee))
      assert.equal(call.arguments.map(a => a.getText(ast)).join(', '), 'parts', `${callee} is handed the table`);
  }
  // Step 5b adds the window order (wireWindowEvents) and the parts' cleanup steps' bindings, each right after the wire call whose provides
  // they bind (wireVoiceCleanup, wireSensesCleanup) or after every part (wireStageCleanup); the quit lists (wireQuit) and the quit steps'
  // bindings (wireMemoryCleanup, wireCardsQuit) where the quit gates were made.
  // Step 7: wireHealth (the part runner) comes first: every part's wiring runs through it.
  assert.deepEqual(order, ['wireHealth', 'wireStage', 'wireUnbound', 'wireIpc', 'wireShell', 'wireLifecycle', 'wireWindowEvents', 'wireCards', 'wireMemory', 'wireVoice',
    'wireVoiceCleanup', 'wireBrain', 'wireInitiative', 'initiative.early', 'wireSafety', 'wireMood', 'moodPart.early', 'wireMemoryCleanup', 'wireCardsQuit', 'wireSenses', 'wireSensesCleanup',
    'wireSettings', 'wireSettingsSync', 'wireSaveSettings', 'wireInitiativePublish', 'wireSensesPublish', 'wireMoodPublish', 'wireActions', 'wireStageCleanup',
    'wireSurprisePreview', 'wireQuit']);
});
