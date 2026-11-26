// Wiring rewrite step 4, the parts moved after the skeleton (docs/claude/2026-11-16-wiring-step-4a.md): what each part's move must keep
// that the wiring golden does not say by itself.
// - Unbound (electron/wiring/unbound-wiring.ts): its three handlers stay outside the agent channel's recorder (registered in the ready
//   chain before registerIPC), and the check for a stay a dead run left (unboundEntry.recover) still runs at its old moment: after both
//   windows loaded, once the face check settled, before the first sync.
// - 连接任务和安全 (electron/wiring/safety-wiring.ts): the agent channel's recorder still wraps every part's register; the help card and
//   the IPC guard stay core (nothing between them and the ready chain's fatal catch); the test command, help card and Claude task
//   handlers keep their flags and stay inside the recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { validateCodexTaskPrompt } from '../shared/safety/codex-tasks';
import { WIRING_PRELUDE, wiringFunction } from './helpers/wiring-source';

// The golden's builder is a plain .mjs script without types (scripts/dev/wiring-golden.mjs).
const goldenScript: string = '../scripts/dev/wiring-golden.mjs';
const { buildGolden } = await import(goldenScript) as { buildGolden(root: string): any };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const golden = buildGolden(ROOT);

/** The ready chain's callback in electron/main.ts: app.whenReady().then(async () => { ... }). */
function readyChain(ast: ts.SourceFile): ts.Block {
  let found: ts.Block | null = null;
  const visit = (node: ts.Node) => {
    if (!found && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then'
      && /whenReady\(\)$/.test(node.expression.expression.getText(ast).replace(/\s+/g, ''))) {
      const fn = node.arguments[0];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) found = fn.body;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, 'the ready chain');
  return found!;
}
const flat = (node: ts.Node, ast: ts.SourceFile) => node.getText(ast).replace(/\s+/g, ' ');

test('Unbound: getUnbound, setUnbound and toggleUnbound register in the ready chain before registerIPC, outside the recorder', () => {
  const chain = golden.order.readyChain as string[];
  const ipc = chain.indexOf('registerIPC()');
  for (const name of ['getUnbound', 'setUnbound', 'toggleUnbound']) {
    const at = chain.indexOf(`host('${name}', fn)`);
    assert.ok(at >= 0 && at < ipc, `${name} is a ready chain step before registerIPC (startUnbound's body, read in place)`);
    assert.ok(golden.handlers.controlOnly.includes(name), `${name} stays control-window only`);
    assert.ok(!golden.agentChannel.recorded.includes(name), `${name} is not an operation the agent channel records`);
  }
  // The step itself: electron/main.ts calls startUnbound once, in the ready chain, with the guard's host; nothing in registerIPC does.
  const ast = parse('electron/main.ts');
  const calls: string[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === 'startUnbound') calls.push(flat(node, ast)); ts.forEachChild(node, visit); };
  visit(readyChain(ast));
  assert.deepEqual(calls, ["startUnbound(partIpc('unbound').host)"]);
  const register = ast.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'registerIPC');
  assert.ok(register && !register.getText(ast).includes('startUnbound'));
});

test('Unbound: the recovery of a stay a dead run left still runs after both windows loaded, once the face check settled, before the first sync', () => {
  const ast = parse('electron/main.ts');
  const steps = readyChain(ast).statements.map(statement => flat(statement, ast));
  const recover = steps.findIndex(text => text.includes('unboundEntry?.recover()'));
  assert.ok(recover >= 0, 'the recovery check is a ready chain step');
  assert.match(steps[recover], /^void faceReady\.catch\(\(\) => undefined\)\.then\(\(\) => unboundEntry\?\.recover\(\)\);/);
  // Overhaul step 8: both windows start loading early (loadWindowsEarly); the chain still waits for them here, where it waited before.
  const loading = steps.findIndex(text => text.startsWith('const windowsLoaded = loadWindowsEarly(controls, pet);'));
  const loaded = steps.findIndex(text => text.startsWith('await windowsLoaded;'));
  const face = steps.findIndex(text => text.startsWith('const faceReady = '));
  const started = steps.findIndex(text => text.startsWith('startUnbound('));
  const firstSync = steps.findIndex((text, i) => i > loaded && text.startsWith('sync();'));
  assert.ok(loading >= 0 && loading < started, 'the windows start loading before the parts start');
  assert.ok(started >= 0 && face > started && loaded > face, 'Unbound starts, the face check starts, then the chain waits for both windows');
  assert.equal(recover, loaded + 1, 'right after both windows loaded');
  assert.ok(firstSync > recover, 'before the sync that follows');
  // unboundEntry is the wiring's live binding (electron/wiring/unbound-wiring.ts), set by startUnbound.
  const wiring = read('electron/wiring/unbound-wiring.ts');
  assert.match(wiring, /export let unboundEntry: UnboundEntryHandle \| null = null;/);
  assert.match(wiring, /unboundEntry = createUnboundEntry\(\{/);
  assert.match(read('electron/main.ts'), /import \{[^}]*\bunboundEntry\b[^}]*\} from '\.\/wiring\/unbound-wiring'/);
});

test('Unbound: before quit the entry, the host and the typing close in their old order', () => {
  const quit = golden.order.beforeQuit.find((q: { registration: string }) => q.registration === "app.on('before-quit')")!.steps as string[];
  const at = quit.indexOf('void unboundEntry?.quit()');
  assert.ok(at > 0);
  assert.deepEqual(quit.slice(at - 2, at + 3), ['petWindowDrag?.cancel()', 'petPresentation.dispose()', 'void unboundEntry?.quit()', 'unbound?.quit()', 'unboundTyping?.quit()']);
});

// ---- 连接任务和安全 (electron/wiring/safety-wiring.ts) ------------------------------------------------------------------------------

/** registerIPC's body in electron/main.ts, as statements. */
function registerIpcBody(ast: ts.SourceFile): readonly ts.Statement[] {
  const fn = ast.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'registerIPC');
  assert.ok(fn?.body, 'registerIPC');
  return fn!.body!.statements;
}

test('the agent channel recorder still wraps every part\'s register: all of them run between recordAgentOperations and the first done()', () => {
  const ast = parse('electron/main.ts');
  const body = registerIpcBody(ast).map(statement => flat(statement, ast));
  const start = body.findIndex(text => /^const agentOperations = recordAgentOperations\(hostIpc\(\)\);/.test(text));
  const stop = body.findIndex(text => text.includes('agentOperations.done()'));
  assert.ok(start === 0 && stop > start, 'the recorder starts first and stops once');
  assert.match(body[stop], /^const agentOperationsRecorded = agentOperations\.done\(\);/, 'the recorder stops on a line of its own, after every registration');
  // Every hand-off of the registrars to a part, and every part registrar call, is inside the window.
  const handOffs = body.map((text, i) => ({ text, i })).filter(({ text }) => /\.register\(partIpc\(|^(?!registerQuit\b)register\w*\(partIpc\(|^\w+\.register\((?:host|scopedHost)\b|^register\w*\((?:host|scopedHost)\b|^if \(typeof hands!=='undefined'\) hands\.register\(scopedHost\)/.test(text));
  for (const name of ['settings', 'cards', 'actions', 'safety']) assert.ok(handOffs.some(({ text }) => text.startsWith(`${name}.register(partIpc('${name}'))`) || text.startsWith(`${name}Part.register(partIpc('${name}'))`)), `${name} registers`);
  for (const { text, i } of handOffs) assert.ok(i > start && i < stop, `registered inside the recorder: ${text.slice(0, 80)}`);
  // After it stopped only the agent channel itself (with what was recorded) and the quit handler (wiring rewrite step 5: the shell's
  // registerQuit, electron/wiring/shell-wiring.ts, the same one handler; the step-5 handler files, registerXxx(partIpc(…)), are hand-offs above).
  assert.deepEqual(body.slice(stop + 1).map(text => text.slice(0, 40)), ["perceptionSwitches = safetyPart.startAge", "registerQuit(partIpc('shell'));"]);
  assert.match(body[stop + 1], /^perceptionSwitches = safetyPart\.startAgentChannel\(agentOperationsRecorded, partIpc\('safety'\), \{/);
  // The golden's count: every operation the agent channel may reuse is recorded (56 since I-173: deleteCharacter, saveCharacterVoice; 57 since
  // 2026-11-24: getTtsBudget, read only), none missed.
  assert.equal(golden.agentChannel.recorded.length, 57);
  assert.deepEqual(golden.agentChannel.notRecorded, []);
});

/** The nearest try block or promise .catch(...) around this node, or null: what would take a failure there before it goes further. */
function catcher(node: ts.Node): ts.Node | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTryStatement(p) && p.tryBlock.pos <= node.pos && node.end <= p.tryBlock.end) return p;
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'catch') return p;
  }
  return null;
}
const caught = (node: ts.Node) => catcher(node) !== null;
function callsIn(ast: ts.SourceFile, text: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === text) out.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  return out;
}

test('the help card and the IPC guard stay core: made and registered with nothing that could swallow their failure', () => {
  const safety = parse('electron/wiring/safety-wiring.ts'), main = parse('electron/main.ts'), ipc = parse('electron/wiring/ipc-wiring.ts');
  const made = callsIn(safety, 'createSafety'), registered = callsIn(safety, 'safety.register');
  assert.equal(made.length, 1); assert.equal(registered.length, 1);
  assert.equal(registered[0].arguments[0].getText(safety), 'scopedHost');
  for (const call of [...made, ...registered]) assert.ok(!caught(call), `not caught: ${call.getText(safety).slice(0, 60)}`);
  assert.match(read('electron/wiring/safety-wiring.ts'), /core: \['crisis-card'\]/, 'the help card is a core unit (step 7 never switches it off)');
  // electron/main.ts makes the part while it is evaluated (a throw stops the app loading) and registers it in registerIPC, which the
  // ready chain calls with only its fatal catch (「soft hearts 启动失败」) around it.
  const wire = main.statements.filter(s => ts.isVariableStatement(s) && s.getText(main).startsWith('const safetyPart = wireSafety('));
  assert.equal(wire.length, 1, 'wireSafety is a top-level statement of electron/main.ts');
  const register = callsIn(main, 'safetyPart.register');
  assert.equal(register.length, 1); assert.ok(!caught(register[0]));
  const ipcCall = callsIn(main, 'registerIPC');
  assert.equal(ipcCall.length, 1);
  const fatal = catcher(ipcCall[0]);
  assert.ok(fatal && ts.isCallExpression(fatal), 'registerIPC runs inside the ready chain, whose only catch is the fatal one');
  const handler = (fatal as ts.CallExpression).arguments[0].getText(main);
  assert.match(handler, /dialog\.showErrorBox\(\s*"soft hearts 启动失败"/); assert.match(handler, /app\.quit\(\)/);
  assert.equal(catcher(fatal!), null, 'and nothing catches around that');
  // The guard: wired at the top level of electron/main.ts; host / scopedHost throw on a foreign sender with nothing catching it.
  const wireIpc = main.statements.filter(s => ts.isExpressionStatement(s) && s.getText(main).startsWith('wireIpc('));
  assert.equal(wireIpc.length, 1);
  const thrown: ts.ThrowStatement[] = [];
  const visit = (node: ts.Node) => { if (ts.isThrowStatement(node)) thrown.push(node); ts.forEachChild(node, visit); };
  visit(ipc);
  assert.ok(thrown.some(t => t.getText(ipc).includes('请求来源未授权')));
  for (const t of thrown) assert.ok(!caught(t), 'the guard\'s refusal is not caught');
});

test('test commands: runTestCommand stays a handler both windows may call, inside the recorder; the help card\'s handlers and the Claude task handlers likewise', () => {
  assert.ok(golden.handlers.eitherWindow.includes('runTestCommand'));
  assert.ok(golden.handlers.eitherWindow.includes('getSafetyCard') && golden.handlers.eitherWindow.includes('safetyCardAnswer'));
  assert.ok(golden.registrarSites.includes("safetyPart.register(…)") && golden.registrarSites.includes('safety.register(…)') && golden.registrarSites.includes('codexTasks.register(…)'));
  const safety = parse('electron/wiring/safety-wiring.ts');
  const run = callsIn(safety, 'scopedHost').filter(call => ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'runTestCommand');
  assert.equal(run.length, 1);
  assert.equal(flat(run[0], safety), "scopedHost('runTestCommand', (sender, text) => { lookTurns.userTurn(); return testCommands.accept(sender, text); }, false)");
});

test('Claude tasks: the proposal entry checks the prompt, opens only a live control window and drops a proposal that went stale meanwhile', () => {
  // The actual function (electron/wiring/safety-wiring.ts), reading its control window from the part's needs (this sandbox's `controls`).
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${wiringFunction('openCodexTaskConfirmation')}\nreturn openCodexTaskConfirmation;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const run = (controls: unknown, prompt: unknown, current: () => boolean) => {
    const log: string[] = [];
    const open = new Function('validateCodexTaskPrompt', 'showControls', 'controls', code)(validateCodexTaskPrompt, () => log.push('show'), controls);
    open(prompt, current);
    return log;
  };
  const live = (log: string[] = []) => ({ isDestroyed: () => false, webContents: { send: (channel: string, prompt: string) => log.push(`${channel}:${prompt}`) } });
  const sent: string[] = [];
  assert.deepEqual(run(live(sent), '  整理项目  ', () => true), ['show']); assert.deepEqual(sent, ['desk:codex-task-proposal:整理项目']);
  for (const bad of ['', '   ', 42, null, 'x'.repeat(100_000)]) assert.throws(() => run(live(), bad, () => true), /任务内容/);
  const stale: string[] = [];
  assert.deepEqual(run(live(stale), '整理项目', () => false), [], 'stale before anything: no window shown'); assert.deepEqual(stale, []);
  let calls = 0; const late: string[] = [];
  assert.deepEqual(run(live(late), '整理项目', () => ++calls === 1), ['show'], 'went stale while the window came up'); assert.deepEqual(late, [], 'nothing is sent');
  assert.deepEqual(run({ isDestroyed: () => true, webContents: { send: () => { throw Error('destroyed window'); } } }, '整理项目', () => true), []);
  assert.deepEqual(run(null, '整理项目', () => true), []);
});
