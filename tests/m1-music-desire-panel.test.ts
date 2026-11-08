/** M1: the developer panel shows her want to dance as one line, and hides it when there is nothing to say. */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MoodPanel } from '../src/ui/MoodPanel';

test('M1 panel: the want-to-dance line follows the stage text and hides when empty', () => {
  class Node {
    className = ''; textContent = ''; dataset = {}; hidden = false; disabled = false;
    value: string | number = ''; children: Node[] = [];
    setAttribute() {} addEventListener() {} append(...nodes: Node[]) { this.children.push(...nodes); } remove() {}
  }
  const original = globalThis.document;
  Object.assign(globalThis, { document: { createElement: () => new Node() } });
  try {
    const panel = new MoodPanel(new Node() as unknown as HTMLElement, { onApply() {}, onRestore() {}, onWake() {} });
    const line = (panel as unknown as { musicDesireLine: Node }).musicDesireLine;
    assert.equal(line.hidden, true, 'hidden until the stage has something to say');
    panel.setMusicDesire('想跳 0.62 · 跳起来 · 心情愉快+0.22 → 跳起来 · 第 1 次判断');
    assert.equal(line.hidden, false);
    assert.equal(line.textContent, '想跳 0.62 · 跳起来 · 心情愉快+0.22 → 跳起来 · 第 1 次判断');
    panel.setMusicDesire('');
    assert.equal(line.hidden, true);
    assert.equal(line.textContent, '');
  } finally { Object.assign(globalThis, { document: original }); }
});
