// The renderer's own gates, run from the actual code (overhaul step 5, docs/claude/2026-11-16-src-main-split.md): which window does
// what, privacy switches, click-through and stale chat / voice events. Each piece is lifted out of the renderer wiring (src/main.ts
// and src/wiring/*.ts, tests/helpers/renderer-source.ts) by its name or by the call that registers it, and run in a sandbox with
// fakes, so the check follows the code when it moves. Added where a mutation of src/main.ts made no test fail (the record lists them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { rendererSource } from './helpers/renderer-source';

const source = rendererSource();
const ast = ts.createSourceFile('renderer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const all = <T extends ts.Node>(match: (node: ts.Node) => node is T): T[] => {
  const out: T[] = [];
  const visit = (node: ts.Node) => { if (match(node)) out.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  return out;
};
const one = <T>(rows: T[], what: string): T => { assert.equal(rows.length, 1, `exactly one ${what} in the renderer wiring`); return rows[0]; };
/** The one top-level-or-nested function declaration `name`, as text. */
const fn = (name: string) => one(all((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name), `function ${name}`).getText(ast);
/** Argument `index` of the one call whose callee reads `callee` (`window.desktop.onAmbientCommentCommitted`). */
const argumentOf = (callee: string, index = 0) => one(all((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(ast) === callee), `call ${callee}`).arguments[index];
/**
 * The setters `setX` of these variables, where the wiring has them (since the src/main.ts split a variable written from another
 * wiring file is written through its declaring file's setter); '' for one that has none. Run them with the code that calls them.
 */
const setters = (...variables: string[]) => variables.map(variable => {
  const name = `set${variable[0].toUpperCase()}${variable.slice(1)}`;
  const found = all((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(found.length <= 1, `at most one ${name}`);
  return found[0]?.getText(ast) ?? '';
}).join('\n');
/** The listener of the one `target.addEventListener('event', listener)`. */
const listenerOf = (target: string, event: string) => one(all((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(ast) === `${target}.addEventListener`
  && !!n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === event), `${target} ${event} listener`).arguments[1];
/** Argument `index` of the call assigned to `variable` (`pointerTimer = setInterval(…)`). */
const assignedCallArgument = (variable: string, index = 0) => one(all((n): n is ts.BinaryExpression => ts.isBinaryExpression(n)
  && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText(ast) === variable && ts.isCallExpression(n.right)), `${variable} = call`).right as ts.CallExpression;
/** Property `name` of the object literal given to the one call `callee`. */
const optionOf = (callee: string, name: string) => {
  const call = one(all((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(ast) === callee), `call ${callee}`);
  const object = call.arguments.find(ts.isObjectLiteralExpression)!;
  const property = object.properties.find(p => p.name?.getText(ast) === name) as ts.PropertyAssignment;
  assert.ok(property, `${callee}: option ${name}`);
  return property.initializer.getText(ast);
};
const js = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
/** Runs `code` (TypeScript) in a sandbox whose globals are `names`; returns the sandbox. */
function run(code: string, names: Record<string, unknown>): Record<string, any> {
  const context = vm.createContext({ ...names });
  vm.runInContext(js(code), context);
  return context;
}
const uiText = (value: string) => value;
const uiTemplate = (parts: TemplateStringsArray, ...values: unknown[]) => parts.reduce((out, part, i) => out + part + (i < values.length ? String(values[i]) : ''), '');

test('a committed comment becomes a chat row in the control window only', () => {
  const remembered: string[] = [];
  const names = { isPet: true, activeChat: null, ambientDisplayedComments: new Set(), rememberAmbientComment: (c: { id: string }) => remembered.push(c.id) };
  const pet = run(`var handler = ${argumentOf('window.desktop.onAmbientCommentCommitted').getText(ast)};`, names);
  pet.handler({ id: 'c1', text: 'x' });
  assert.deepEqual(remembered, [], 'the pet window shows her comment in its own bubble, never as a chat row');
  const controls = run(`var handler = ${argumentOf('window.desktop.onAmbientCommentCommitted').getText(ast)};`, { ...names, isPet: false });
  controls.handler({ id: 'c2', text: 'x' });
  assert.deepEqual(remembered, ['c2']);
});

/** applyRuntime with recording fakes; returns what it touched. */
function applyRuntimeWith(isPet: boolean, next: Record<string, unknown>) {
  const inputs = new Map<string, { checked: boolean }>(), texts = new Map<string, string>(), sharing: unknown[] = [], looks: unknown[] = [], cleared: unknown[][] = [];
  const names = {
    isPet, runtime: { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null }, visionRuntime: { supported: true, status: '' },
    screenSharingOptions: { update: (value: unknown) => sharing.push(value) }, lookButton: { update: (value: unknown) => looks.push(value) }, lookMeButton: { update: (value: unknown) => looks.push(value) },
    petUI: null, mediaInput: null, clearChat: (...args: unknown[]) => cleared.push(args), uiText, uiTemplate,
    $: (id: string) => { if (!inputs.has(id)) inputs.set(id, { checked: false }); return inputs.get(id); }, text: (id: string, value: string) => texts.set(id, value),
  };
  const sandbox = run(fn('applyRuntime'), names);
  sandbox.applyRuntime({ voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null, ...next });
  return { inputs, texts, sharing, looks, cleared, runtime: sandbox.runtime };
}

test('the switches, the privacy lines and the sharing options show only what the host turned on', () => {
  const off = applyRuntimeWith(false, {});
  for (const id of ['runtime-voice', 'runtime-screen', 'runtime-camera', 'runtime-camera-images']) assert.equal(off.inputs.get(id)?.checked, false, id);
  assert.equal(off.texts.get('privacy-indicator'), '输入与共享已关闭');
  assert.equal(off.texts.get('privacy-state'), '屏幕与摄像头：共享关闭');
  assert.deepEqual(off.sharing.map(value => (value as { screenSharing: boolean }).screenSharing), [false]);
  assert.ok(off.looks.every(value => (value as { screenSharing: boolean; cameraImages?: boolean }).screenSharing === false && !(value as { cameraImages?: boolean }).cameraImages));
  const voice = applyRuntimeWith(false, { voiceInput: true });
  assert.deepEqual(['runtime-voice', 'runtime-screen', 'runtime-camera', 'runtime-camera-images'].map(id => voice.inputs.get(id)?.checked), [true, false, false, false]);
  assert.equal(voice.texts.get('privacy-indicator'), '语音输入已开启');
  const pet = applyRuntimeWith(true, { screenSharing: true });
  assert.equal(pet.inputs.size, 0, 'the pet window has no privacy switches to set');
  assert.equal(pet.texts.size, 0);
});

test('her look-line is shown only on the visible pet, with an empty box and no reply, and only once', () => {
  const message = { id: 'm1', text: '你在写代码呀', origin: { labels: ['屏幕'] } };
  const outcome = (over: Record<string, unknown>) => {
    const record: string[] = [];
    const names = {
      isPet: true, hostVisible: true, activeChat: null, shownInitiatives: new Set<string>(), activeVisionSpeechId: null, initiativeGeneration: 0, provisionalInitiative: null,
      heldLines: { vision: () => false }, speech: { stop: () => record.push('stop'), speak: async () => {} }, settings: { voice: { enabled: false } },
      petUI: { showAnswer: () => { record.push('show'); return {}; }, hideAnswer: () => {}, finishAnswer: () => {} },
      $: () => ({ value: '' }), formatVisionPresentation: (m: { text: string }) => m.text, retractInitiative: () => {}, rememberInitiative: () => {}, endReplySpeech: () => {},
      prepareVisionDelivery: async () => {}, window: { desktop: { cancelVisionInitiative: async () => { record.push('cancel'); }, updatePetReply: async () => {}, ackVisionInitiative: async () => {} } },
      ...over,
    };
    run(`${setters('provisionalInitiative', 'activeVisionSpeechId')}\nvar handler = ${argumentOf('window.desktop.onVisionInitiative').getText(ast)};`, names).handler({ type: 'offer', message });
    return record;
  };
  assert.deepEqual(outcome({}), ['stop', 'show']);
  assert.deepEqual(outcome({ hostVisible: false }), ['cancel'], 'hidden: declined, never shown');
  assert.deepEqual(outcome({ shownInitiatives: new Set(['m1']) }), ['cancel'], 'already shown: not again');
  assert.deepEqual(outcome({ activeChat: 'r1' }), ['cancel']);
  assert.deepEqual(outcome({ $: () => ({ value: '在打字' }) }), ['cancel']);
  assert.deepEqual(outcome({ isPet: false }), [], 'the control window never shows it');
});

test('the page hidden or the window hidden drops the draft\'s screen snapshots', () => {
  const aborted: string[] = [];
  const common = {
    replyPresentation: { canPresent: () => false }, moodCompanion: null, petUI: null, stage: null, stopMotionPreview: () => {}, hideWaitingPresentation: () => {},
    captureController: { abort: () => aborted.push('abort') }, renderAttachments: () => {}, activeChat: null, reply: '', textMemorialOffer: null, activeMemorialSpeechId: null,
    userProfilePanel: null, ambientAudioController: null, speech: { stop: () => {} },
  };
  const page = run(`var handler = ${listenerOf('document', 'visibilitychange').getText(ast)};`, {
    ...common, isPet: false, hostVisible: true, attachments: [{ source: 'screen' }],
    document: { hidden: true, addEventListener: () => {} }, window: { desktop: { cancelCharacterSticker: async () => {}, getWindowVisibility: () => new Promise(() => {}) } }, windowVisibility: { minimized: false }, acceptWindowVisibility: () => false, // I-171: the hidden document asks the host whether it was a minimize
  });
  page.handler();
  assert.equal(page.attachments.length, 0, 'page hidden: snapshots dropped');
  const windowHidden = run(fn('acceptWindowVisibility'), {
    ...common, isPet: false, hostVisible: true, attachments: [{ source: 'screen' }], document: { hidden: false, getElementById: () => null },
    windowVisibility: { accept: () => true, visible: false, minimized: false }, projectPetVisibility: () => {},
  });
  windowHidden.acceptWindowVisibility({ windowId: 1, revision: 1, visible: false, petVisible: true });
  assert.equal(windowHidden.attachments.length, 0, 'window hidden: snapshots dropped');
  assert.deepEqual(aborted, ['abort', 'abort']);
});

test('click-through follows the user\'s switch, the window being shown and every hold', () => {
  const enabled = optionOf('installPetPointerPassthrough', 'enabled'), holds = optionOf('installPetPointerPassthrough', 'holds');
  const evaluate = (code: string, names: Record<string, unknown>) => run(`var value = (${code})();`, names).value;
  assert.equal(evaluate(enabled, { settings: { pet: { clickThrough: true } }, hostVisible: true }), true);
  assert.equal(evaluate(enabled, { settings: { pet: { clickThrough: false } }, hostVisible: true }), false, 'off unless the user turned it on');
  assert.equal(evaluate(enabled, { settings: { pet: { clickThrough: true } }, hostVisible: false }), false);
  assert.equal(evaluate(holds, { cameraEditing: false, petUI: { windowInteractionBlocked: false } }), false);
  assert.equal(evaluate(holds, { cameraEditing: true, petUI: null }), true, 'camera editing holds it');
  assert.equal(evaluate(holds, { cameraEditing: false, petUI: { windowInteractionBlocked: true } }), true, 'window adjusting holds it');
  const gates: Record<string, unknown>[] = [];
  run(fn('syncBehaviorGate'), {
    applyBehaviorGates: (_stage: unknown, value: Record<string, unknown>) => gates.push(value), stage: {}, cameraEditing: false, composing: false, petUI: null,
    settings: { pet: { clickThrough: true } }, motionPreview: null, syncBodyInputGate: () => {}, petPointer: null,
  }).syncBehaviorGate();
  assert.equal(gates[0].clickThrough, true, 'the stage is told click-through is on');
});

test('the 100 ms pointer tick reads the cursor only with follow-mouse on, and her gaze only on the pet', async () => {
  const tick = (names: Record<string, unknown>) => {
    const calls: string[] = [];
    const sandbox = run(`var tick = ${assignedCallArgument('pointerTimer').arguments[0].getText(ast)};`, {
      hostVisible: true, document: { hidden: false }, stage: { setPointer: () => {}, setUserGaze: () => {} }, attentionPollWanted: () => false, noteUserGaze: () => {},
      window: { desktop: { pointer: async () => { calls.push('pointer'); return { x: 0, y: 0 }; }, userGaze: async () => { calls.push('gaze'); return null; } } }, ...names,
    });
    sandbox.tick();
    return calls;
  };
  assert.deepEqual(tick({ isPet: true, settings: { pet: { followMouse: true } } }), ['gaze', 'pointer']);
  assert.deepEqual(tick({ isPet: true, settings: { pet: { followMouse: false } } }), ['gaze'], 'no cursor without follow-mouse');
  assert.deepEqual(tick({ isPet: false, settings: { pet: { followMouse: false } } }), [], 'the control window never reads her gaze');
  // I-189: hidden, the companion window still asks while her voice or a call needs the attention reading; the control window never does.
  assert.deepEqual(tick({ isPet: true, hostVisible: false, attentionPollWanted: () => true, settings: { pet: { followMouse: false } } }), ['gaze']); // no-pet-ok: the window-kind flag and the settings key the tick reads
  assert.deepEqual(tick({ isPet: true, hostVisible: false, settings: { pet: { followMouse: false } } }), [], 'hidden and not needed: not asked'); // no-pet-ok: as above
  assert.deepEqual(tick({ isPet: false, attentionPollWanted: () => true, settings: { pet: { followMouse: false } } }), [], 'the control window never reads it'); // no-pet-ok: as above
});

test('voice conversation events of an older row, an unknown group or another reply change nothing', () => {
  const calls: string[] = [];
  const nodes: { textContent: string }[] = [];
  const sandbox = run(`${fn('receiveVoiceConversation')}\n${setters('history', 'voiceSpeechReady')}`, {
    voiceContinuationStatus: null, windowKind: 'controls', callControls: null, voiceSpeechReady: null, voiceUiGroups: new Map(), voiceReplyIds: new Set<string>(),
    history: [], trimReplyHistory: (h: unknown[]) => h, text: () => {}, uiText,
    addMessage: (_role: string, content: string) => { const node = { textContent: content }; nodes.push(node); return node; },
    beginChat: (chat: { id: string }) => calls.push(`begin ${chat.id}`), onStream: (event: { id: string }) => calls.push(`stream ${event.id}`),
  });
  sandbox.receiveVoiceConversation({ type: 'row', owner: 'pet', epoch: 'e', groupId: 'g', seq: 2, text: '第二句' });
  sandbox.receiveVoiceConversation({ type: 'row', owner: 'pet', epoch: 'e', groupId: 'g', seq: 1, text: '第一句' });
  assert.equal(nodes[0].textContent, '第二句', 'an older row does not overwrite a newer one');
  assert.equal(sandbox.history.length, 1, 'the new row is in the chat history once');
  assert.equal(sandbox.history[0].content, '第二句');
  sandbox.receiveVoiceConversation({ type: 'start', owner: 'pet', epoch: 'e', groupId: 'other', replyId: 'r-other' });
  sandbox.receiveVoiceConversation({ type: 'delta', owner: 'pet', epoch: 'e', groupId: 'g', replyId: 'r-unknown', text: 'x' });
  assert.deepEqual(calls, [], 'no reply starts for a group this window never showed, no delta goes to a reply that is not a voice reply');
  sandbox.receiveVoiceConversation({ type: 'start', owner: 'pet', epoch: 'e', groupId: 'g', replyId: 'r1' });
  sandbox.receiveVoiceConversation({ type: 'delta', owner: 'pet', epoch: 'e', groupId: 'g', replyId: 'r1', text: 'x' });
  assert.deepEqual(calls, ['begin r1', 'stream r1']);
});

test('the windows\' chat channel ignores another card context and a speech-ended of an older reading', () => {
  const posts: unknown[] = [], ended: unknown[][] = [], cleared: unknown[][] = [];
  const names = {
    chatContext: () => '3:akiko', chatChannel: { postMessage: (m: unknown) => posts.push(m) }, history: [], activeChat: null, activeUser: null, reply: '', chatOwner: null,
    ordinaryReplyPresentation: { id: 'r1', context: 'new' }, finishReplySpeechPresentation: (...args: unknown[]) => ended.push(args),
    clearChat: (...args: unknown[]) => cleared.push(args), replyPresentation: { close: () => {} },
    refilledRowsFor: () => undefined, // 边说边演: no grey lines in this fixture
  };
  const sandbox = run(fn('receiveChat'), names);
  sandbox.receiveChat({ type: 'request-state', context: '2:akiko' });
  sandbox.receiveChat({ type: 'clear', context: '2:akiko' });
  assert.deepEqual(posts, [], 'another card context gets no answer');
  assert.deepEqual(cleared, [], 'another card context clears nothing');
  sandbox.receiveChat({ type: 'request-state', context: '3:akiko' });
  assert.equal(posts.length, 1);
  sandbox.receiveChat({ type: 'speech-ended', id: 'r1', replyContext: 'old' });
  assert.deepEqual(ended, [], 'an older reading of the same reply does not end the current one');
  sandbox.receiveChat({ type: 'speech-ended', id: 'r1', replyContext: 'new' });
  assert.deepEqual(ended, [['r1', 'new']]);
});

test('reply-speech segments are taken in order only', () => {
  const touched: string[] = [];
  const accepted = { id: 'r1', text: '第一句。第二句。第三句。', context: 'c', index: 0, early: false, ended: false };
  const sandbox = run(`var handler = ${argumentOf('window.desktop.onReplySpeechSegment').getText(ast)};`, {
    ordinaryReplyPresentation: accepted, replySpeechContext: () => 'c', hostVisible: true, document: { hidden: false }, shown: () => true /* I-174: covered counts */, bubbleFollow: () => ({ segment() {} }), // I-165
    petUI: { refreshAnswerReader: () => touched.push('refresh'), finishAnswer: () => touched.push('finish'), expectAnswerSpeech: () => touched.push('expect') },
  });
  sandbox.handler({ replyId: 'r1', index: 2, visibleText: '第一句。第二句。第三句。' });
  assert.deepEqual(touched, [], 'a skipped segment is not taken');
  assert.equal(accepted.index, 0);
  sandbox.handler({ replyId: 'r1', index: 1, visibleText: '第一句。第二句。' });
  assert.deepEqual(touched, ['refresh']);
  assert.equal(accepted.index, 1);
});

test('the recycle bin\'s 「最近删除的」 under the profile and the memorials is mounted in the control window only (its reads are control-only)', () => {
  // Found by the 11-17 candidate smoke: the companion window built both panels with the recycle API and its first getRecycleBin was refused
  // ("请求来源未授权") at every start. The companion window gets no list; the control window keeps it.
  const mount = (isPet: boolean) => {
    const got: { profile?: unknown; memorials?: unknown } = {};
    const desktop = { tag: 'desktop' };
    const element = () => ({ hidden: false, onclick: null, addEventListener: () => {} });
    run(`${fn('mountUserProfile')}\nmountUserProfile();`, {
      isPet, window: { desktop }, characterState: { activeId: 'gene' }, notify: () => {}, closeProfileForNotice: () => {}, $: element,
      UserProfilePanel: class { constructor(...args: unknown[]) { got.profile = args[5]; } setMemorials() {} refreshMemorials() {} },
      TextMemorialPanel: class { constructor(...args: unknown[]) { got.memorials = args[2]; } },
    });
    return { got, desktop };
  };
  const pet = mount(true);
  assert.equal(pet.got.profile, undefined, 'the pet window\'s profile panel gets no recycle API');
  assert.equal(pet.got.memorials, undefined, 'the pet window\'s memorials get no recycle API');
  const controls = mount(false);
  assert.equal(controls.got.profile, controls.desktop, 'the control window keeps the list under the profile');
  assert.equal(controls.got.memorials, controls.desktop, 'the control window keeps the list under the memorials');
});

// I-174 item 3 (docs/claude/2026-11-21-i174-parity-fixes.md): a press, a key or typing anywhere on her window no longer cuts her own line
// (her look's or her inner loop's line being said, a line being shown); the host still hears that you did something.
test('I-174: a press or a key does not cut the line she is saying; the host is told', () => {
  const done: string[] = [];
  const declaration = one(all((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'noteProactiveInput'), 'noteProactiveInput');
  const sandbox = run('var handler = ' + declaration.initializer!.getText(ast) + ';', {
    initiativeGeneration: 0, textMemorialOffer: null, activeMemorialSpeechId: 'memorial', activeVisionSpeechId: 'her-line', provisionalInitiative: { id: 'p' },
    // no-pet-ok: petUI is the renderer's existing name
    speech: { stop: () => done.push('speech stopped') }, petUI: { hideAnswer: () => done.push('hidden'), hideAnswerFor: () => done.push('hidden') },
    lastProactiveInput: -Infinity, performance: { now: () => 1000 }, window: { desktop: { noteVisionUserActivity: async () => { done.push('host told'); } } } });
  sandbox.handler();
  assert.deepEqual(done, ['host told'], 'her line goes on (before: stopped and hidden)');
});
