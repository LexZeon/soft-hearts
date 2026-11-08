import { scanBreathRequest } from '../shared/breath-request';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
import { scanFramingRequest } from '../shared/framing-request';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';
import { appendReplyHistory, outgoingChatMessages } from '../src/ui/reply-history';

const text = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('src/main.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const names = ['sendChat', 'beginReadoutControl', 'receiveReadoutControl', 'onStream'];
const functions = new Map(ast.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n)
  && !!n.name && names.includes(n.name.text)).map(n => [n.name!.text, n.getText(ast)]));
assert.equal(functions.size, names.length);
class Node {
  children: Node[] = []; textContent = ''; className = ''; removed = false;
  append(...nodes: Node[]) { this.children.push(...nodes); }
  remove() { this.removed = true; }
}
function fixture() {
  const input = { value: '请停止当前朗读' }, root = new Node(), requests: any[] = [], failures: unknown[] = [];
  const forbidden = () => { throw Error('Readout control touched ordinary audio/media/settings/presentation'); };
  const context: any = { activeChat: null, pendingReadoutControl: null, attachments: [], history: [], isPet: false,
    commandMessageRows: new Map(), readoutControlTurns: new Map(),
    scanBreathRequest, scanFramingRequest, scanStopReadoutRequest, appendReplyHistory, outgoingChatMessages, crypto: { randomUUID: () => 'control-id' },
    $: (id: string) => id === 'chat-input' ? input : root,
    document: { createElement: () => new Node(), querySelector: () => root },
    window: { desktop: { chat: async (value: unknown) => { requests.push(value); }, noteUserInput: forbidden, sharedAttachments: forbidden } },
    speech: { stop: forbidden }, replySpeechQueue: { cancel: forbidden }, petUI: new Proxy({}, { get: () => forbidden }),
    save: forbidden, setChatBusy: forbidden, noteVisionUserActivity: forbidden,
    displayFailure: String, notify: (value: unknown) => failures.push(value),
  };
  vm.createContext(context);
  for (const [name, source] of functions) context[name] = vm.runInContext(ts.transpileModule('(' + source + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { context, input, root, requests, failures };
}

test('actual renderer send preserves audio and submits only literal chat, with no save, shared frame or provider prerequisite', async () => {
  for (const text of ['请停止当前朗读', '停一下']) {
    const h = fixture(); h.input.value = text;
    await h.context.sendChat();
    assert.equal(h.requests.length, 1); const request = h.requests[0];
    assert.equal(request.id, 'control-id'); assert.equal(request.messages.at(-1).content, text);
    assert.deepEqual(Array.from(request.attachments), []); assert.equal(h.input.value, '');
    assert.equal(h.context.pendingReadoutControl, 'control-id'); assert.deepEqual(h.failures, []);
    await h.context.sendChat(); assert.equal(h.requests.length, 1, 'pending control does not submit a duplicate');
  }
});

test('actual control presentation and stream consume once without touching normal reply, queue or audio', () => {
  const h = fixture(); h.context.activeChat = 'unrelated-text-generation';
  h.context.pendingReadoutControl = 'control-id';
  const chat = { id: 'control-id', readoutControl: true, owner: 'controls', messages: [{ role: 'user', content: '停止朗读' }] };
  h.context.beginReadoutControl(chat); h.context.beginReadoutControl(chat);
  assert.equal(h.root.children.length, 1); assert.equal(h.context.commandMessageRows.size, 1);
  h.context.onStream({ id: 'control-id', kind: 'chat', type: 'delta', text: '已停止本次回复朗读。' });
  h.context.onStream({ id: 'control-id', kind: 'chat', type: 'done', text: '' });
  h.context.onStream({ id: 'control-id', kind: 'chat', type: 'done', text: '' });
  assert.equal(h.context.activeChat, 'unrelated-text-generation'); assert.equal(h.context.pendingReadoutControl, null);
  assert.equal(h.context.history.length, 2); assert.equal(h.context.history[1].content, '已停止本次回复朗读。');
  assert.equal(h.root.children[0].children[1].textContent, '已停止本次回复朗读。');
});

test('actual control row ownership stays bounded and failures never trigger another spoken reply', () => {
  const h = fixture();
  for (let i = 0; i < 10; i++) h.context.beginReadoutControl({ id: `control-${i}`, owner: 'controls',
    messages: [{ role: 'user', content: '停一下' }], readoutControl: true });
  assert.equal(h.context.readoutControlTurns.size, 8); assert.equal(h.context.commandMessageRows.size, 8);
  h.context.onStream({ id: 'control-9', kind: 'chat', type: 'error', text: '原朗读目标已变化' });
  assert.equal(h.context.history.length, 0); assert.equal(h.root.children.at(-1)!.children[1].textContent, '原朗读目标已变化');
});
