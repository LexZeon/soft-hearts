import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { VoiceContinuationStatus } from '../src/ui/VoiceContinuationStatus';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const rows: ts.IfStatement[] = [];
function visit(node: ts.Node) { if (ts.isIfStatement(node) && node.expression.getText(ast) === 'voiceStatus') rows.push(node); ts.forEachChild(node, visit); }
visit(ast); assert.equal(rows.length, 1);
const body = ts.transpileModule(`return function actual(){${rows[0].getText(ast)}return voiceContinuationStatus;}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
class Node {
  textContent = ''; hidden = false; style: Record<string, string> = {}; children: Node[] = [];
  attrs = new Map<string, string>();
  constructor(readonly tag: string) {}
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  append(node: Node) { this.children.push(node); }
}

test('actual common voice input block presents status in both chat surfaces with no manual talk buttons or capture handlers', () => {
  for (const surface of ['controls', 'pet'] as const) {
    const slot = new Node('div'), created: Node[] = [];
    const actual = new Function('voiceStatus', '$', 'document', 'VoiceContinuationStatus', `let voiceContinuationStatus=null;${body}`)(
      new Node('output'), (id: string) => { assert.equal(id, 'voice-action-slot'); return slot; },
      { createElement: (tag: string) => { const node = new Node(tag); created.push(node); return node; } }, VoiceContinuationStatus);
    const status: VoiceContinuationStatus = actual();
    assert.deepEqual(created.map(node => node.tag), ['small'], surface);
    assert.equal(slot.children.length, 1); assert.equal(slot.children[0].attrs.get('role'), 'status');
    assert.equal(slot.children[0].hidden, true);
    const base = { epoch: 'epoch', groupId: 'group', owner: surface };
    status.receive({ ...base, type: 'row', seq: 1, text: '合成原文' });
    status.receive({ ...base, type: 'start', replyId: 'reply' });
    status.receive({ ...base, type: 'continuation', replyId: 'reply', state: 'queued' });
    assert.match(slot.children[0].textContent, /排队/);
    status.receive({ epoch: 'epoch', owner: surface, type: 'revoked' }); assert.equal(slot.children[0].hidden, true);
  }
});
