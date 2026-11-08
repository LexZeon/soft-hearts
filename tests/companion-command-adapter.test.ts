import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { CompanionCommandHost } from '../electron/companion-command-host';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import { createCommandDialogueTurn } from '../electron/companion-command-dialogue';
import { applyPetTopmost } from '../electron/pet-topmost';

const filename = new URL('../electron/main.ts', import.meta.url);
const source = ts.createSourceFile('main.ts', fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['noteCompanionTopmostWrite', 'commitCompanionTopmost'];
const functions = source.statements.filter(s => ts.isFunctionDeclaration(s) && s.name && names.includes(s.name.text));
assert.equal(functions.length, names.length);
const js = ts.transpileModule(functions.map(s => s.getText(source)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function adapter(nativeFails = false, persistFails = false) {
  let writes = 0, nativeValue = false;
  const before = { provider: { model: 'new-manual-value' }, pet: { alwaysOnTop: false, visible: true, scale: 0.91 }, voice: { enabled: false } };
  const store = { current: structuredClone(before), persist: async (next: typeof before) => {
    if (persistFails) throw Error('unacknowledged write'); writes++; store.current = next;
  } };
  const sandbox = { store, structuredClone, applyPetTopmost, publicSettings: (v: unknown) => v,
    broadcast: () => {}, pet: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, moveTop: () => {},
      setAlwaysOnTop: (v: boolean) => { if (nativeFails) throw Error('presentation unavailable'); nativeValue = v; },
      isAlwaysOnTop: () => nativeValue } };
  const context = vm.createContext(sandbox);
  vm.runInContext(`let companionCommandRevision=0;let companionCommandObservedTop=false;${js};
    globalThis.adapter={commit:commitCompanionTopmost,revision:()=>companionCommandRevision};`, context);
  const api = (context as unknown as { adapter: { commit(v: boolean): Promise<{ persistence: string; presentation: string; value?: boolean }>; revision(): number } }).adapter;
  return { before, store, api, writes: () => writes };
}
test('actual host persist adapter changes exactly one field from latest current settings, without normalizing scale', async () => {
  const f = adapter(), result = await f.api.commit(true);
  assert.equal(result.persistence, 'saved'); assert.equal(result.presentation, 'applied'); assert.equal(result.value, true);
  assert.deepEqual(structuredClone(f.store.current), { ...f.before, pet: { ...f.before.pet, alwaysOnTop: true } });
  assert.equal(f.writes(), 1); assert.equal(f.api.revision(), 1);
  assert.equal((await f.api.commit(true)).persistence, 'unchanged'); assert.equal(f.writes(), 1);
  await f.api.commit(false); assert.equal(f.api.revision(), 2);
});
test('actual adapter separates failed save acknowledgement and failed native presentation without rollback', async () => {
  const failed = adapter(false, true);
  assert.equal((await failed.api.commit(true)).persistence, 'unknown'); assert.equal(failed.store.current.pet.alwaysOnTop, false);
  const display = adapter(true), result = await display.api.commit(true);
  assert.equal(result.persistence, 'saved'); assert.equal(result.presentation, 'failed'); assert.equal(display.store.current.pet.alwaysOnTop, true);
});
test('frozen Voice classifier, real host ledger and dialogue adapter couple once without provider', async () => {
  let top = false, revision = 0, writes = 0, finish = 0; const chunks: string[] = [];
  const host = new CompanionCommandHost({ now: () => 0, id: () => 'cancel',
    target: () => ({ contextId: 'context', value: top, revision }), classify: classifyCompanionCommand,
    format: formatCompanionCommandReceipt, enqueue: async run => run(), publish: () => {},
    commit: async value => { top = value; revision++; writes++; return { persistence: 'saved', presentation: 'applied', value }; } });
  const input = { requestId: 'r', contextId: 'context', text: '保持桌宠置顶', currentValue: false };
  const ticket = host.admit({ requestId: 'r', owner: 1, window: 'pet', text: input.text, source: 'current-human' })!;
  const dialogue = createCommandDialogueTurn({ classify: classifyCompanionCommand, formatReceipt: formatCompanionCommandReceipt,
    signal: new AbortController().signal, isCurrent: () => true,
    host: async () => (await host.run(ticket))!.receipt!,
    turn: { push: (_type, text) => { chunks.push(text); }, finish: async () => { finish++; } } });
  assert.equal(await dialogue.handle(input), 'handled'); assert.equal(writes, 1); assert.equal(finish, 1);
  assert.ok(chunks.join('').includes('置顶')); await assert.rejects(dialogue.handle(input));
});

test('actual newConversation synchronously revokes completed clarification before renderer cancellation', async () => {
  let writes = 0, choices = 0, finished = 0;
  const pending = new Map<string, { kind: string; controller: AbortController }>();
  const host = new CompanionCommandHost({ now: () => 0, id: () => `c${++choices}`,
    target: () => ({ contextId: 'context', value: false, revision: 0 }), classify: classifyCompanionCommand,
    format: formatCompanionCommandReceipt, enqueue: async run => run(), publish: () => {},
    commit: async value => { writes++; return { persistence: 'saved', presentation: 'applied', value }; } });
  const input = { requestId: 'clarification', contextId: 'context', text: '不要挡着我', currentValue: false };
  const ticket = host.admit({ requestId: input.requestId, owner: 7, window: 'controls', text: input.text, source: 'current-human' })!;
  let view: Awaited<ReturnType<typeof host.run>>;
  pending.set(input.requestId, { kind: 'chat', controller: new AbortController() });
  const dialogue = createCommandDialogueTurn({ classify: classifyCompanionCommand, formatReceipt: formatCompanionCommandReceipt,
    signal: pending.get(input.requestId)!.controller.signal, isCurrent: () => true,
    host: async () => { view = await host.run(ticket); return view!; },
    turn: { push: () => {}, finish: async () => { finished++; pending.delete(input.requestId); } } });
  assert.equal(await dialogue.handle(input), 'handled'); assert.equal(finished, 1); assert.equal(pending.size, 0);
  const register = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'registerIPC');
  assert.ok(register && ts.isFunctionDeclaration(register) && register.body);
  const entry = register.body.statements.find(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
    && s.expression.expression.getText(source) === 'host' && ts.isStringLiteral(s.expression.arguments[0])
    && s.expression.arguments[0].text === 'newConversation');
  assert.ok(entry);
  const entryJs = ts.transpileModule(entry.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let newConversation!: () => Promise<void>, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vm.runInNewContext(entryJs, { host: (_name: string, handler: typeof newConversation) => { newConversation = handler; },
    companionCommands: host, pending, userProfileManagement: { cancelPending() {} }, voiceHost: { history: null },
    revokeVoice() {}, stopSystemAudio() {}, proactiveSpeechGate: { cancel() {} }, clearVisionContext() {},
    speechRuntime: { stop() {} }, clearReplySpeech() {}, companion: { newConversation: () => gate }, refreshVisionContext() {} });
  const clearing = newConversation();
  try {
    const stale = await host.choose(7, { requestId: input.requestId, choiceId: view!.choices[0].choiceId });
    assert.equal(stale, null); assert.equal(writes, 0);
  } finally { release(); await clearing; }
});
