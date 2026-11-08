// 体验记录 (E2): the control window's switch and "刚才发生了什么" (src/ui/JournalPanel.ts). Text only, never markup.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJournalEntry, type JournalEntry, type JournalInput, type JournalView } from '../shared/journal';
import { setUiLanguage } from '../shared/ui-language';
import { JournalPanel, journalFilterChoices, journalPanelLines, journalStatusText } from '../src/ui/JournalPanel';

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = ''; value = '';
  checked = false; disabled = false; hidden = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  onchange: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  get innerHTML(): string { throw new Error('the panel never reads or writes markup'); }
  set innerHTML(_value: string) { throw new Error('the panel never reads or writes markup'); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const part = (root: Element, name: string) => { const found = all(root).find(node => node.dataset.journal === name); assert.ok(found, name); return found; };
const flush = () => new Promise(resolve => setImmediate(resolve));
(globalThis as any).document = { createElement: (tag: string) => new Element(tag) };

const at = (minute: number) => new Date(2026, 10, 3, 11, minute).getTime();
const entry = (input: JournalInput, minute: number) => buildJournalEntry(input, at(minute)) as JournalEntry;
const values = (n = 50) => ({ D: n, O: n, E: n, N: n, C: n });
const entries = [
  entry({ type: 'mood-event', characterId: 'gene', source: 'touch', before: values(), after: { ...values(), O: 56 }, labelBefore: 'calm', labelAfter: 'content' }, 42),
  entry({ type: 'her-life', characterId: 'momo', from: 'company', to: 'daydream', untilMinutes: 10 }, 43),
  entry({ type: 'mood-label', characterId: 'gene', from: 'content', to: 'happy' }, 44),
];
const on: JournalView = { enabled: true, entries, characters: [{ id: 'gene', name: 'Gene' }], failure: false, truncatedToday: false };
const off: JournalView = { enabled: false, entries: [], characters: [], failure: false, truncatedToday: false };

test('lines newest first, a character filter from the lines themselves, and status lines', () => {
  setUiLanguage('zh-CN');
  assert.deepEqual(journalPanelLines(on, ''), ['11:44 心情：满足 → 愉快', '11:43 她开始发呆', '11:42 你摸了摸头 → 亲近 +6，现在：满足']);
  assert.deepEqual(journalPanelLines(on, 'momo'), ['11:43 她开始发呆']);
  assert.deepEqual(journalPanelLines(off, ''), []);
  assert.deepEqual(journalPanelLines({ ...on, enabled: false }, ''), [], 'nothing is shown while the switch is off, whatever the view holds');
  assert.deepEqual(journalFilterChoices({ ...on, enabled: false }), []);
  assert.deepEqual(journalFilterChoices(on), [{ value: 'gene', label: 'Gene' }, { value: 'momo', label: '已删除的角色' }]);
  assert.match(journalStatusText(off), /^已关闭/);
  assert.equal(journalStatusText(on), '已开启 · 最近 3 条');
  assert.match(journalStatusText({ ...on, failure: true }), /没能写进文件/);
  assert.match(journalStatusText({ ...on, truncatedToday: true }), /到上限/);
});

test('the switch starts disabled, follows the host, and the list shows only while it is on', async () => {
  setUiLanguage('zh-CN');
  const requests: boolean[] = [], errors: string[] = [];
  let publish: (view: JournalView) => void = () => {};
  const root = new Element('div');
  new JournalPanel(root as never, {
    get: async () => off, setEnabled: async enabled => { requests.push(enabled); return enabled ? on : off; },
    changed: callback => { publish = callback; return () => {}; }, error: message => errors.push(message),
  });
  const toggle = part(root, 'enabled'), list = part(root, 'lines'), filter = part(root, 'filter');
  assert.equal(toggle.checked, false); assert.equal(toggle.disabled, true);
  await flush();
  assert.equal(toggle.disabled, false);
  assert.ok(all(root).some(node => node.className === 'journal-recent' && node.hidden), 'hidden while off');
  toggle.checked = true; toggle.onchange!();
  await flush();
  assert.deepEqual(requests, [true]);
  assert.deepEqual(list.children.map(node => node.textContent), journalPanelLines(on, ''));
  assert.deepEqual(filter.children.map(node => node.value), ['', 'gene', 'momo']);
  filter.value = 'gene'; filter.onchange!();
  assert.deepEqual(list.children.map(node => node.textContent), ['11:44 心情：满足 → 愉快', '11:42 你摸了摸头 → 亲近 +6，现在：满足']);
  // A pushed view keeps the filter; a character that disappears from the lines resets it.
  publish({ ...on, entries: entries.slice(1, 2) });
  assert.equal(filter.value, '');
  assert.deepEqual(list.children.map(node => node.textContent), ['11:43 她开始发呆']);
  publish(off);
  assert.equal(toggle.checked, false);
  assert.deepEqual(errors, []);
});

test('English interface: the fixed copy is translated, every line is plain text', async () => {
  setUiLanguage('en');
  try {
    const root = new Element('div');
    new JournalPanel(root as never, { get: async () => on, setEnabled: async () => on, changed: () => () => {}, error: () => {} });
    await flush();
    const text = all(root).map(node => node.textContent ?? '').join('\n');
    assert.match(text, /Keep an experience log \(this computer only\)/);
    assert.match(text, /What just happened/);
    assert.match(text, /11:42 You patted her head → Closeness \+6, now: Content/);
    assert.ok(!/[一-鿿]/u.test(text), text);
  } finally { setUiLanguage('zh-CN'); }
});
