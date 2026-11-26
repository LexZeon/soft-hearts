// The wiring's source text for tests that read it (wiring rewrite step 3, docs/claude/2026-11-16-wiring-step-3.md). The code those tests
// read is moving from electron/main.ts into electron/wiring/*.ts; they read it here, across both, with the same assertions as before.
// Prefer importing a module over this: it is for checks that are about how the wiring is written (order, guards, what is passed on).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** electron/main.ts first, then electron/wiring/*.ts in name order (repo-relative paths). */
export function wiringFiles(root = ROOT): string[] {
  const folder = path.join(root, 'electron', 'wiring');
  const wiring = fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.endsWith('.ts')).sort().map(name => `electron/wiring/${name}`) : [];
  return ['electron/main.ts', ...wiring];
}

export interface WiringSourceFile { readonly file: string; readonly text: string; readonly ast: ts.SourceFile }
/** Each wiring file, read and parsed. */
export function wiringSources(root = ROOT): WiringSourceFile[] {
  return wiringFiles(root).map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return { file, text, ast: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
  });
}

/** All the wiring's text, file after file (for text and regular-expression checks that used to read electron/main.ts). */
export function wiringSource(root = ROOT): string {
  return wiringSources(root).map(source => source.text).join('\n');
}

/** Every node in the wiring that `match` accepts, with its file. */
export function wiringNodes<T extends ts.Node>(match: (node: ts.Node, ast: ts.SourceFile) => node is T, root = ROOT): { node: T; ast: ts.SourceFile; file: string }[] {
  const out: { node: T; ast: ts.SourceFile; file: string }[] = [];
  for (const source of wiringSources(root)) {
    const visit = (node: ts.Node) => { if (match(node, source.ast)) out.push({ node, ast: source.ast, file: source.file }); ts.forEachChild(node, visit); };
    visit(source.ast);
  }
  return out;
}

const dropExport = (text: string) => text.replace(/^export\s+(?:default\s+)?/, '');

/**
 * The one function named `name` in the wiring, as text a test can evaluate: a function declaration (at any depth, `export` dropped) or
 * `const name = (...) => ...` (the whole statement). Fails unless exactly one is found.
 */
export function wiringFunction(name: string, root = ROOT): string {
  const found: string[] = [];
  for (const source of wiringSources(root)) {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(dropExport(node.getText(source.ast)));
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name
        && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))) found.push(dropExport(node.getText(source.ast)));
      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }
  if (found.length !== 1) throw new Error(`wiringFunction(${name}): found ${found.length} in ${wiringFiles(root).join(', ')}`);
  return found[0];
}

/**
 * The one declaration of `name` in the wiring, as text a test can evaluate: a function declaration (at any depth, `export` dropped) or
 * the variable statement that declares it by name (at any depth: `const completedReplySpeech = new CompletedReplySpeech();` inside a
 * part's wire function counts; a destructuring `const { completedReplySpeech } = part.provides` does not). Fails unless exactly one.
 */
export function wiringDeclaration(name: string, root = ROOT): string {
  const found: string[] = [];
  // A `let name: T;` with no value counts only when nothing declares the name with a value (step 4c: 感知's `export let ambientStore:
  // AudioReadingArchive;` is made in the ready chain; the save steps' `let voiceHost!: VoiceChatHost;` binding is not the host itself).
  const bare: string[] = [];
  for (const source of wiringSources(root)) {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) found.push(dropExport(node.getText(source.ast)));
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name && d.initializer))
        found.push(dropExport(node.getText(source.ast)));
      else if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name && !d.exclamationToken))
        bare.push(dropExport(node.getText(source.ast)));
      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }
  if (found.length === 0 && bare.length === 1) return bare[0];
  if (found.length !== 1) throw new Error(`wiringDeclaration(${name}): found ${found.length} in ${wiringFiles(root).join(', ')}`);
  return found[0];
}

/** The handler of the one `host('name', …)` / `scopedHost('name', …)` registration in the wiring, as its text. */
export function wiringHandler(name: string, root = ROOT): string {
  const rows = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && ['host', 'scopedHost'].includes(node.expression.text) && !!node.arguments[0] && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text === name, root);
  if (rows.length !== 1) throw new Error(`wiringHandler(${name}): found ${rows.length}`);
  return rows[0].node.arguments[1].getText(rows[0].ast);
}

/** The one `host('name', …)` / `scopedHost('name', …)` registration in the wiring, as its statement text. */
export function wiringRegistration(name: string, root = ROOT): string {
  const rows = wiringNodes((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && ['host', 'scopedHost'].includes(node.expression.expression.text)
    && !!node.expression.arguments[0] && ts.isStringLiteral(node.expression.arguments[0]) && node.expression.arguments[0].text === name, root);
  if (rows.length !== 1) throw new Error(`wiringRegistration(${name}): found ${rows.length}`);
  return rows[0].node.getText(rows[0].ast);
}

/**
 * The call or `new` that makes the one variable named `variable` in the wiring, at any depth: `const name = new X(…)` / `createX(…)`,
 * or an assignment `name = new X(…)` (a store the ready chain makes). Exactly one.
 */
function initializerCall(variable: string, root: string): { call: ts.CallExpression | ts.NewExpression; ast: ts.SourceFile } {
  // Step 7: `x = gatedRecycleHost(createRecycleHost({ … }))` makes x by the inner call (the gate only wraps what it makes).
  const gated = (value: ts.Expression | undefined) => value && ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'gatedRecycleHost'
    && value.arguments.length === 1 ? value.arguments[0] : value;
  const made = (value: ts.Expression | undefined): value is ts.CallExpression | ts.NewExpression => { const inner = gated(value); return !!inner && (ts.isNewExpression(inner) || ts.isCallExpression(inner)); };
  const rows = wiringNodes((node): node is ts.VariableDeclaration | ts.BinaryExpression =>
    (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variable && made(node.initializer))
    || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === variable && made(node.right)), root);
  if (rows.length !== 1) throw new Error(`wiring: found ${rows.length} places that make ${variable} by a call`);
  const node = rows[0].node;
  return { call: gated(ts.isVariableDeclaration(node) ? node.initializer : node.right) as ts.CallExpression | ts.NewExpression, ast: rows[0].ast };
}

/**
 * The value of option `property` in an object literal given to the call that makes `variable` (`const lookAttachments = new
 * LookAttachments(lookTurns, { watchingTogether: () => … })` → the arrow's text), as text a test can evaluate. Exactly one.
 */
export function wiringOption(variable: string, property: string, root = ROOT): string {
  const { call, ast } = initializerCall(variable, root);
  const found: string[] = [];
  for (const argument of call.arguments ?? []) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const member of argument.properties) {
      if (!member.name || !ts.isIdentifier(member.name) || member.name.text !== property) continue;
      if (ts.isPropertyAssignment(member)) found.push(member.initializer.getText(ast));
      else if (ts.isMethodDeclaration(member)) found.push(`function ${member.getText(ast)}`);
      else if (ts.isShorthandPropertyAssignment(member)) found.push(member.name.text);
    }
  }
  if (found.length !== 1) throw new Error(`wiringOption(${variable}, ${property}): found ${found.length}`);
  return found[0];
}

/** Argument `index` of the call that makes `variable` (`new CameraSampleBroker((owner, id) => …)` → the arrow's text). */
export function wiringArgument(variable: string, index: number, root = ROOT): string {
  const { call, ast } = initializerCall(variable, root);
  const argument = call.arguments?.[index];
  if (!argument) throw new Error(`wiringArgument(${variable}, ${index}): no such argument`);
  return argument.getText(ast);
}

/** The one call statement `callee(…)` in the wiring (any depth), as its arguments' text. */
export function wiringCallArguments(callee: string, root = ROOT): string[] {
  const rows = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === callee, root);
  if (rows.length !== 1) throw new Error(`wiringCallArguments(${callee}): found ${rows.length}`);
  return rows[0].node.arguments.map(argument => argument.getText(rows[0].ast));
}

/**
 * The names a part's wiring reads from its needs (electron/wiring/<part>-wiring.ts: `const { store, pet } = needs; // read when called`,
 * or needs.pet). In a test's sandbox WIRING_PRELUDE's `needs` reads each from the sandbox's own name of the same spelling.
 */
const NEEDS_NAMES = [
  // 设置 (electron/wiring/settings-wiring.ts SettingsNeeds)
  'store', 'pet', 'controls', 'characterCards', 'completedReplySpeech', 'speechScope', 'cancelCompletedReply', 'petHeld', 'nativeVisibility', 'mutate',
  'activateUserProfile', 'shareCompanionCommands',
  // 声音 (electron/wiring/voice-wiring.ts VoiceNeeds; its functions are taken by their own names, so only the values are here)
  'companion', 'media', 'audioCapture', 'localAsr', 'voiceRoute', 'claudeChat', 'replyRhythm', 'appJournal', 'journalExtras', 'textMemorialHost',
  'petReply', 'unbound', 'visionPresentation', 'lastAmbientSpeech', 'lastVisionSpeech', 'feedCueSynth',
  // 感知·看 (electron/wiring/senses-wiring.ts SeeingNeeds; the functions are taken by their own names, so only the values are here)
  'exiting', 'petWindowDrag', 'pending', 'innerLoopHost', 'poseSensing', 'faceCheck', 'asrTask', 'audioReading', 'listenTogether', 'watchTogether',
  'ambientComments', 'userActivity', 'userProfileContext', 'personalizeLanguage', 'surprisePreviewHost', 'languageAuthoring', 'visualAuthoring', 'bodyAuthoring',
  'proactiveSpeechGate', 'selfLook', 'voiceCall',
  // 感知·听 (the same SensesNeeds)
  'textInvitationMemory', 'companionCommands', 'listenKind', 'moodJudge', 'reactions', 'takeMeThere', 'chatSettings', 'i139Chat', 'LONG_CHAT',
  'callStreamingSpeech', 'replySpeechStyles', 'speechRuntime',
  // 记忆 (electron/wiring/memory-wiring.ts MemoryNeeds, step 4d; its moved lines read the other parts' functions through needs too)
  'characterResponses', 'characterAvatars', 'mutations', 'rps', 'feeding', 'hands', 'give', 'keepsake', 'specialDay', 'songMemory',
  'speechScope', 'stopSystemAudio', 'clearVisionContext', 'refreshVisionContext', 'clearReplySpeech', 'cancelReplyStyle', 'replySpeechBusy',
  'completedFatigueFeeling', 'syncCharacter', 'journalCharacterId', 'recentLines', 'speechPlaybackActivity', 'ambientSpeakingOwners', 'voiceHost', 'foregroundAsr',
  // 主动 (electron/wiring/initiative-wiring.ts InitiativeNeeds, step 4e; the functions it takes by their own names need no entry, except
  // the one a top-level function reads through needs)
  'cameraLookJournal', 'moduleRouter', 'touchBrain', 'herState', 'safety', 'lookTurns', 'screenSnapshots', 'proactiveVision', 'cameraSamples', 'readingActive', 'captureSharedCamera',
  // 心情 (electron/wiring/mood-wiring.ts MoodNeeds, step 4f; companionCanExpress and syncMood read the other parts' functions through needs too)
  'fatigueActivityReady', 'motionLibrary', 'chatActions', 'SPEAK_ONLY_ON', 'herOnScreen', 'withBodyPose', 'noteVisionUserActivity', 'roughForTurn',
  // 舞台 (electron/wiring/stage-wiring.ts StageNeeds, step 4g; its moved lines read the other parts' functions through needs too)
  'assets', 'motionFits', 'characterStickerHost', 'reserveCompanionAuthoring', 'topmostJournal', 'sync', 'fitSettingsScale', 'noteCompanionTopmostWrite',
  'commitCompanionVisibility',
  // 大脑 (electron/wiring/brain-wiring.ts BrainNeeds, step 4h; the chat turn reads the other parts' functions through needs too)
  'installedDesktopChannel', 'turnAwareness', 'lookAttachments', 'visionSupport', 'visualSelfRuntime', 'agentInterconnected', 'syncFatigueActivity',
  'revokeVoice', 'lookState', 'lookScope', 'chatContextData', 'publishVisionState', 'suspendAmbientSpeech', 'refreshVisualSelfContext',
  'companionCommandContext',
  // 角色卡's syncCharacter (moved from electron/main.ts, wiring rewrite step 5: it reads the other parts through needs)
  'moodModel', 'userProfileManagement', 'bundledAssets', 'setVisionSupported', 'noteModelSelection',
  // 设置's resetSettings and 感知's handler file (step 5)
  'setCameraEnabled', 'forgetScreenSelection', 'adoptCharacterForModel', 'mediaChanged',
];
/** Needs the moved code writes (`needs.lastAmbientSpeech = null`): the prelude writes the sandbox's own name. */
const NEEDS_SETTABLE = ['lastAmbientSpeech'];

/**
 * For evaluating moved wiring code in a test's sandbox: what the moved code reads through its ports (the IPC guard's guardWindows /
 * guardControls, the shell's shell() and petWindow(), a part's needs) is read from the sandbox's own names, at each call, as
 * electron/main.ts's getters do. The real ports are covered by tests/wiring-skeleton.test.ts. A name the sandbox lacks reads as null.
 */
export const WIRING_PRELUDE = [
  'const guardWindows = () => windows(), guardControls = () => controls;',
  'const sandboxed = (read) => { try { return read() ?? null; } catch { return null; } };',
  'function shell() { return { get controls() { return sandboxed(() => controls); }, get pet() { return sandboxed(() => pet); },',
  '  get unbound() { return sandboxed(() => unbound); }, get unboundEntry() { return sandboxed(() => unboundEntry); }, get store() { return sandboxed(() => store); },',
  '  get appSession() { return sandboxed(() => appSession); }, togglePet: (...a) => togglePet(...a), mutate: (op) => mutate(op), sync: (...a) => sync(...a) }; }',
  'function petWindow() { return shell().pet; }',
  // Overhaul step 7: the part runner's helpers as strict mode (no runner: each runs its function as is); isolation is tested on its own
  // (tests/part-runner.test.ts, tests/privacy-part-off.test.ts, tests/part-isolation.test.ts).
  'const stepAs = (step) => step, startUnit = async (_part, _unit, run) => await run(), startUnitSync = (_part, _unit, run) => run(), tickUnit = (_part, _unit, run) => run();',
  'const privacyRefusal = () => null, refuseWhilePartOff = () => {};',
  "const ASSISTANT_NAME = 'Claude', ASSISTANT_CLI_NAME = 'Claude Code';", // I-217: the wiring builds some messages from shared/foundation/assistant-name.ts (an import the sandbox does not have)
  'const noteWatchOffCause = () => {}; const offCauseOfIntent = () => null;',
  // 2026-11-25 (only the user cutting in interrupts her): the quiet gate (electron/wiring/quiet-wiring.ts) and the interrupt rule (shared/voice/interrupt-policy.ts) are imports the sandbox does not have; she is never busy here
  // (var and ??=, so a test that passes its own `waitsForHer` or the like in its sandbox keeps it)
  'var flushSettled, settleWhenQuiet, waitsForHer, settingsSaveCutsReading; flushSettled ??= async () => {}; settleWhenQuiet ??= (_what, run) => run(); waitsForHer ??= () => false;',
  'settingsSaveCutsReading ??= (previous, next) => (previous.model?.path ?? null) !== (next.model?.path ?? null);', // 2026-11-24: senses-listen-wiring notes why 一起看 ends (electron/senses/watch-off-notice.ts); the fixtures do not need it
  `const needs = { ${NEEDS_NAMES.map(name => `get ${name}() { return sandboxed(() => ${name}); }`
    + (NEEDS_SETTABLE.includes(name) ? `, set ${name}(value) { ${name} = value; }` : '')).join(', ')} };`,
].join('\n');

/**
 * Wiring rewrite step 4g: the one host / scopedHost registration of `name` runs inside electron/main.ts's registerIPC (the agent channel's
 * recorder): written there directly, or inside a part's `register(ipc)` (electron/wiring/<part>-wiring.ts) whose handle registerIPC registers
 * as `<handle>.register(partIpc('<id>'))`, the id being the one that part's wire function returns.
 */
export function registeredInRegisterIpc(name: string, root = ROOT): boolean {
  const rows = wiringNodes((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && ['host', 'scopedHost'].includes(node.expression.expression.text)
    && !!node.expression.arguments[0] && ts.isStringLiteral(node.expression.arguments[0]) && node.expression.arguments[0].text === name, root);
  if (rows.length !== 1) throw new Error(`registeredInRegisterIpc(${name}): found ${rows.length}`);
  const main = wiringSources(root).find(source => source.file === 'electron/main.ts')!;
  const registerIpc = main.ast.statements.find((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === 'registerIPC');
  if (!registerIpc?.body) return false;
  const { node, file } = rows[0];
  // (the two parses differ: compare positions in the same text)
  if (file === 'electron/main.ts') return node.getStart() >= registerIpc.body.getStart(main.ast) && node.getEnd() <= registerIpc.body.getEnd();
  let method: ts.Node | undefined = node.parent;
  while (method && !(ts.isMethodDeclaration(method) && method.name.getText() === 'register')) method = method.parent;
  if (!method) {
    // A part split by feature (docs/claude/2026-11-17-split-stage-wiring.md): the registration sits in a top-level function of a feature
    // file (electron/wiring/<part>-<feature>-wiring.ts) that the part's `register(ipc)` calls; follow that one call.
    let fn: ts.Node | undefined = node.parent;
    while (fn && !(ts.isFunctionDeclaration(fn) && ts.isSourceFile(fn.parent))) fn = fn.parent;
    const fnName = fn && ts.isFunctionDeclaration(fn) ? fn.name?.text : undefined;
    if (!fnName) return false;
    const calls = wiringNodes((n): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fnName, root);
    if (calls.length !== 1) return false;
    method = calls[0].node.parent;
    while (method && !(ts.isMethodDeclaration(method) && method.name.getText() === 'register')) method = method.parent;
  }
  if (!method || !ts.isObjectLiteralExpression(method.parent)) return false;
  const id = method.parent.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'id');
  if (!id || !ts.isStringLiteral(id.initializer)) return false;
  const call = new RegExp(`^\\w+\\.register\\(partIpc\\('${id.initializer.text}'\\)\\);`);
  return registerIpc.body.statements.some(st => call.test(st.getText(main.ast)));
}

/**
 * Wiring rewrite step 4e: her mood cue's chain as evaluable text (`const CUE_CHAIN = [...]` and `claimMoodCue`, electron/wiring/
 * initiative-wiring.ts), for a test that evaluates the mood publish (the callback CompanionService is made with), which calls it. '' while
 * the chain was one expression inside the mood publish itself (before the move).
 */
export function cueChainSource(root = ROOT): string {
  const files = wiringSources(root);
  if (!files.some(source => /\bCUE_CHAIN\b/.test(source.text))) return '';
  return `${wiringDeclaration('CUE_CHAIN', root)}\n${wiringFunction('claimMoodCue', root)}`;
}

/**
 * Wiring rewrite step 4f: the mood publish's step list as evaluable text (`wireMoodPublish([...])` in electron/main.ts, each step's text,
 * `const moodPublishSteps = [...]` and electron/wiring/mood-wiring.ts publishMood), for a test that evaluates the callback CompanionService
 * is made with (`view => publishMood(view)`). '' while the publish was one callback body (before the move).
 */
export function moodPublishSource(root = ROOT): string {
  if (!wiringSources(root).some(source => /\bwireMoodPublish\(\[/.test(source.text))) return '';
  return [stepListSource('moodPublishSteps', 'wireMoodPublish', 0, root), wiringFunction('publishMood', root)].join('\n');
}

/** The names a wiring call `wireName(…)` is given as an array literal at argument `index` (an ordered step list), in order. */
export function wiringStepList(wireName: string, index = 0, root = ROOT): string[] {
  const calls = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === wireName, root);
  if (calls.length !== 1) throw new Error(`wiringStepList(${wireName}): found ${calls.length} calls`);
  const list = calls[0].node.arguments[index];
  if (!list || !ts.isArrayLiteralExpression(list)) throw new Error(`wiringStepList(${wireName}): argument ${index} is not an array literal`);
  return list.elements.map(element => {
    if (!ts.isIdentifier(element)) throw new Error(`wiringStepList(${wireName}): ${element.getText(calls[0].ast)} is not a function name`);
    return element.text;
  });
}
/** A step list as evaluable text: `const <listName> = [a, b];` and each step function's actual text (electron/wiring/settings-wiring.ts). */
function stepListSource(listName: string, wireName: string, index: number, root: string): string {
  const names = wiringStepList(wireName, index, root);
  return [...names.map(name => wiringFunction(name, root)), `const ${listName} = [${names.join(', ')}];`].join('\n');
}
/** saveSettings' two step lists (savePrepare, saveApplied) and their steps, as electron/main.ts gives them (wireSaveSettings). */
export function saveSettingsStepsSource(root = ROOT): string {
  return [stepListSource('savePrepare', 'wireSaveSettings', 0, root), stepListSource('saveApplied', 'wireSaveSettings', 1, root)].join('\n');
}
/** sync's step list (syncSteps) and its steps, as electron/main.ts gives them (wireSettingsSync). */
export function syncStepsSource(root = ROOT): string {
  return stepListSource('syncSteps', 'wireSettingsSync', 0, root);
}

/**
 * The IPC guard (electron/wiring/ipc-wiring.ts host and scopedHost) as evaluable text, with WIRING_PRELUDE: it reads `windows()` and
 * `controls` from the evaluating sandbox at each call, as the code in electron/main.ts did; the rest is the two functions' actual text.
 */
export function ipcGuardSource(root = ROOT): string {
  return [WIRING_PRELUDE, wiringFunction('host', root), wiringFunction('scopedHost', root)].join('\n');
}

/** One wiring call's object-literal argument `callee({ ... })` (exactly one call in the wiring), with its file's parse. */
function orderCall(callee: string, root: string): { object: ts.ObjectLiteralExpression; call: ts.CallExpression; ast: ts.SourceFile } {
  const calls = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee, root);
  if (calls.length !== 1) throw new Error(`${callee}: found ${calls.length} calls`);
  const object = calls[0].node.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${callee}: its argument is not an object literal`);
  return { object, call: calls[0].node, ast: calls[0].ast };
}
const arrayProperty = (object: ts.ObjectLiteralExpression, name: string): ts.ArrayLiteralExpression => {
  const property = object.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name);
  if (!property || !ts.isArrayLiteralExpression(property.initializer)) throw new Error(`${name}: not an array literal`);
  return property.initializer;
};

/**
 * Before quitting as evaluable text (step 5b): electron/wiring/quit-wiring.ts (wireQuit, markExiting, holdForFlush), every quit and flush
 * step electron/main.ts's `wireQuit([...], [...])` names (each its actual text, wherever it lives) and that call itself; `app.on` is the
 * sandbox's. Declares quitSteps, flushSteps, exiting, flushedCompanion and flushingCompanion (a sandbox must not give those names).
 */
export function quitStepsSource(root = ROOT): { source: string; steps: string[]; flush: string[] } {
  const calls = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'wireQuit', root);
  if (calls.length !== 1) throw new Error(`wireQuit: found ${calls.length} calls`);
  const [steps, flush] = calls[0].node.arguments.map(list => {
    if (!ts.isArrayLiteralExpression(list)) throw new Error('wireQuit: a list is not an array literal');
    return list.elements.map(element => { if (!ts.isIdentifier(element)) throw new Error(`${element.getText()} is not a name`); return element.text; });
  });
  const names = [...new Set(['wireQuit', 'markExiting', 'holdForFlush', ...steps, ...flush])];
  return { steps, flush, source: [
    'let quitSteps = [], flushSteps = [], exiting = false, flushedCompanion = false, flushingCompanion = false;',
    'const stepAs = (step) => step; // step 7: the part runner as strict mode (isolation: tests/part-runner.test.ts)',
    ...names.map(name => wiringFunction(name, root)),
    `${calls[0].node.getText(calls[0].ast)};`,
  ].join('\n') };
}

/** One listener of secureWindow's order (electron/main.ts wireWindowEvents, step 5b): its target, event and step names, or the one helper. */
export interface WindowListenerRow { readonly target: 'win' | 'webContents'; readonly event: string; readonly steps: readonly string[]; readonly helper: string | null }
/**
 * secureWindow's order as electron/main.ts gives it (wireWindowEvents): every listener in registration order (a bare step that runs
 * once per window is left out), and the step lists by name: helpers, newDocument, visible, visibleWhileOpen.
 */
export function windowEventOrder(root = ROOT): { listeners: WindowListenerRow[]; helpers: string[]; newDocument: string[]; visible: string[]; visibleWhileOpen: string[] } {
  const { object } = orderCall('wireWindowEvents', root);
  const names = (list: ts.ArrayLiteralExpression) => list.elements.map(element => { if (!ts.isIdentifier(element)) throw new Error(`${element.getText()} is not a name`); return element.text; });
  const listeners: WindowListenerRow[] = [];
  for (const element of arrayProperty(object, 'listeners').elements) {
    if (ts.isIdentifier(element)) continue;
    if (!ts.isArrayLiteralExpression(element)) throw new Error(`a listener ${element.getText()} is neither a row nor a step`);
    const [target, event, run] = element.elements;
    if (!ts.isStringLiteral(target) || !ts.isStringLiteral(event) || !run) throw new Error(`a listener ${element.getText()} is not [target, event, steps]`);
    listeners.push({ target: target.text as WindowListenerRow['target'], event: event.text, steps: ts.isArrayLiteralExpression(run) ? names(run) : [],
      helper: ts.isIdentifier(run) ? run.text : null });
  }
  return { listeners, helpers: names(arrayProperty(object, 'helpers')), newDocument: names(arrayProperty(object, 'newDocument')),
    visible: names(arrayProperty(object, 'visible')), visibleWhileOpen: names(arrayProperty(object, 'visibleWhileOpen')) };
}

/**
 * secureWindow's order as evaluable text (step 5b): the trunk's dispatcher (electron/wiring/window-events-wiring.ts), every step function
 * the order names (each its actual text, wherever it lives) and electron/main.ts's `wireWindowEvents({ ... })` call itself, so
 * `windowEvents(win, owner, windowId)` registers the real listeners in the real order. What the steps read comes from the sandbox's names;
 * `stubbed`: step names the sandbox gives instead of their text. Declares listeners, newDocumentSteps, visibleSteps,
 * visibleWhileOpenSteps and republishPetVisibility (a sandbox must not give those names).
 */
export function windowEventsSource(stubbed: readonly string[] = [], root = ROOT): string {
  const { object, call, ast } = orderCall('wireWindowEvents', root);
  const used = new Set<string>(['windowEvents', 'wireWindowEvents', 'onNewDocument', 'publishVisibility', 'notePetWindow']);
  const collect = (node: ts.Node): void => { if (ts.isIdentifier(node) && !ts.isPropertyAssignment(node.parent)) used.add(node.text); ts.forEachChild(node, collect); };
  for (const property of object.properties) if (ts.isPropertyAssignment(property)) collect(property.initializer);
  return [
    'let listeners = [], newDocumentSteps = [], visibleSteps = [], visibleWhileOpenSteps = [], republishPetVisibility = null;',
    ...[...used].filter(name => !stubbed.includes(name)).map(name => wiringFunction(name, root)),
    `${call.getText(ast)};`,
  ].join('\n');
}
