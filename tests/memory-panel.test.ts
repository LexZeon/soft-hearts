import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPanel } from '../src/ui/MemoryPanel';
import { DEFAULT_MEMORY_CONFIG, type MemoryPage, type MemoryReadQuery, type MemoryRecordPage, type MemorySummary } from '../shared/memory';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_TASKS_UI_COPY } from '../shared/ui-copy.tasks.en';
import type { MemoryNoteBody, MemoryNoteState } from '../shared/memory-notes/interface';

// A narrow text/action DOM fixture. Requests run through the real panel; the
// fixture supplies no generation, pagination or context-reset implementation.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  id = '';
  className = '';
  textContent = '';
  disabled = false;
  dataset: Record<string, string> = {};
  private fieldValue = '';
  readonly classList = { add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); } };
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  get value(): string { return this.fieldValue; }
  set value(value: string) {
    this.fieldValue = this.tagName === 'select' && !this.children.some(child => child.value === value) ? '' : value;
  }
  append(...nodes: Element[]): void {
    for (const child of nodes) { child.parent = this; this.children.push(child); }
    if (this.tagName === 'select' && this.children.length && !this.children.some(child => child.value === this.fieldValue)) this.fieldValue = this.children[0].value;
  }
  add(node: Element): void { this.append(node); }
  replaceChildren(...nodes: Element[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
    if (this.tagName === 'select') this.fieldValue = this.children[0]?.value ?? '';
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(_name: string, _value: string): void {}
  click(): void { assert.equal(this.disabled, false); this.onclick?.(); }
}
class OptionElement extends Element {
  constructor(label: string, value: string) { super('option'); this.textContent = label; this.value = value; }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string => all(root).map(node => node.textContent).join('\n');
function byId(root: Element, id: string): Element { const node = all(root).find(item => item.id === id); assert.ok(node, `element #${id}`); return node; }
function button(root: Element, label: string): Element { const node = all(root).find(item => item.tagName === 'button' && item.textContent === label); assert.ok(node, `button ${label}`); return node; }
async function flush(): Promise<void> { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

const summary: MemorySummary = { id: 'old-record', title: 'Old private title', tags: ['OLD_PRIVATE_TAG'], category: '日常', createdAt: 1000, updatedAt: 2000, weight: 20, messageCount: 2, turnCount: 1, sealed: true };
const firstPage = (): MemoryRecordPage => ({ ...structuredClone(summary), messageOffset: 0, nextMessageOffset: 1, messages: [
  { id: 'user-original', turnId: 'turn', role: 'user', content: 'HEAD', createdAt: 1000, updatedAt: 1000, status: 'complete', contentOffset: 0, totalCharacters: 8, nextTextOffset: 4 },
] });
const tailPage = (content = 'TAIL'): MemoryRecordPage => ({ ...structuredClone(summary), messageOffset: 0, messages: [
  { id: 'user-original', turnId: 'turn', role: 'user', content, createdAt: 1000, updatedAt: 1000, status: 'complete', contentOffset: 4, totalCharacters: 8 },
] });
const replyPage = (): MemoryRecordPage => ({ ...structuredClone(summary), messageOffset: 1, messages: [
  { id: 'assistant-original', turnId: 'turn', role: 'assistant', content: 'COMPLETE_REPLY', createdAt: 2000, updatedAt: 2000, status: 'complete', contentOffset: 0, totalCharacters: 14 },
] });
const listPage = (): MemoryPage => ({ records: [structuredClone(summary)], total: 1, offset: 0, limit: 20, tags: [...summary.tags], notice: 'OLD_SCOPE_NOTICE' });
type Actions = ConstructorParameters<typeof MemoryPanel>[1];
function fixture(overrides: Partial<Actions> = {}) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const optionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: (tag: string) => new Element(tag) } });
  Object.defineProperty(globalThis, 'Option', { configurable: true, writable: true, value: OptionElement });
  const root = new Element('div'), errors: string[] = [], reads: { id: string; query?: MemoryReadQuery }[] = [];
  const actions: Actions = {
    async list() { return listPage(); },
    async read(id, query) { reads.push({ id, query }); return query?.textOffset ? tailPage() : query?.messageOffset ? replyPage() : firstPage(); },
    async edit() {}, async remove() {}, async configure() {},
    async config() { return structuredClone(DEFAULT_MEMORY_CONFIG); },
    error(message) { errors.push(message); },
    ...overrides,
  };
  const panel = new MemoryPanel(root as unknown as HTMLElement, actions);
  return {
    panel, root, errors, reads,
    restore() {
      panel.dispose();
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document');
      if (optionDescriptor) Object.defineProperty(globalThis, 'Option', optionDescriptor); else Reflect.deleteProperty(globalThis, 'Option');
    },
  };
}
function openOldRecord(root: Element): void {
  const selected = all(root).find(node => node.dataset.recordId === summary.id);
  assert.ok(selected); selected.click();
}

test('English memory labels leave private titles, tags, originals and stored category values unchanged', async () => {
  registerUiMessages({ en: ENGLISH_TASKS_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  const privateTitle = '上一页', privateTag = '全部标签', privateText = '查找';
  const f = fixture({
    async list() { return { ...listPage(), records: [{ ...summary, title: privateTitle, tags: [privateTag] }], tags: [privateTag] }; },
    async read() { return { ...firstPage(), title: privateTitle, tags: [privateTag], messages: [{ ...firstPage().messages[0], content: privateText, nextTextOffset: undefined }] }; },
  });
  try {
    await f.panel.init();
    assert.ok(text(f.root).includes('Chat memory'));
    button(f.root, 'Previous page'); button(f.root, 'Next page');
    assert.ok(text(byId(f.root, 'memory-list')).includes(privateTitle));
    assert.deepEqual(byId(f.root, 'memory-tag').children.map(node => node.textContent), ['All tags', privateTag]);
    openOldRecord(f.root); await flush();
    const detail = byId(f.root, 'memory-detail');
    assert.equal(byId(f.root, 'memory-title').value, privateTitle);
    assert.equal(byId(f.root, 'memory-tags').value, privateTag);
    assert.equal(all(detail).find(node => node.tagName === 'pre')!.textContent, privateText);
    const category = all(detail).find(node => node.tagName === 'select')!;
    assert.equal(category.value, '日常');
    assert.equal(category.children[0].textContent, 'Everyday');
    button(detail, 'Save title & tags'); button(detail, 'Delete this record');
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); setUiLanguage('zh-CN'); }
});

test('ordinary list refreshes leave an open long original and subsequent message pagination usable', async () => {
  const f = fixture();
  try {
    await f.panel.init();
    openOldRecord(f.root); await flush();
    const detail = byId(f.root, 'memory-detail');
    const original = all(detail).find(node => node.tagName === 'pre')!;
    assert.equal(original.textContent, 'HEAD');
    // onMemoryChanged and entering the memory tab both use this public refresh.
    await f.panel.refresh();
    button(detail, '继续读取这条长消息').click(); await flush();
    assert.equal(original.textContent, 'HEADTAIL');
    assert.ok(!all(detail).some(node => node.textContent === '继续读取这条长消息'));
    await f.panel.refresh();
    button(detail, '读取后续原文').click(); await flush();
    assert.deepEqual(all(detail).filter(node => node.tagName === 'pre').map(node => node.textContent), ['HEADTAIL', 'COMPLETE_REPLY']);
    assert.deepEqual(f.reads.map(call => call.query), [undefined, { messageOffset: 0, messageLimit: 1, textOffset: 4 }, { messageOffset: 1 }]);
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('scope reset clears old labels and details immediately and rejects a late original read from the former scope', async () => {
  const lateRead = deferred<MemoryRecordPage>(), newList = deferred<MemoryPage>();
  let scope = 'old';
  const f = fixture({
    async list() { return scope === 'old' ? listPage() : newList.promise; },
    async read(_id, query) { return query?.textOffset ? lateRead.promise : firstPage(); },
  });
  try {
    await f.panel.init(); openOldRecord(f.root); await flush();
    const detail = byId(f.root, 'memory-detail');
    const original = all(detail).find(node => node.tagName === 'pre')!;
    const status = all(f.root).find(node => node.tagName === 'output')!;
    assert.ok(text(byId(f.root, 'memory-tag')).includes('OLD_PRIVATE_TAG'));
    assert.ok(status.textContent.includes('OLD_SCOPE_NOTICE'));
    button(detail, '继续读取这条长消息').click();
    scope = 'new'; f.panel.reset();
    assert.equal(detail.children.length, 0);
    assert.equal(byId(f.root, 'memory-list').children.length, 0);
    assert.deepEqual(byId(f.root, 'memory-tag').children.map(node => node.textContent), ['全部标签']);
    assert.equal(status.textContent, '');
    lateRead.resolve(tailPage('LATE_PRIVATE_OLD_SCOPE_TEXT')); await flush();
    assert.equal(original.textContent, 'HEAD', 'the stale read must not even append into its detached original node');
    assert.equal(detail.children.length, 0);
    assert.ok(!text(f.root).includes('LATE_PRIVATE_OLD_SCOPE_TEXT'));
    assert.ok(!text(f.root).includes('OLD_PRIVATE_TAG'));
    newList.resolve({ records: [], total: 0, offset: 0, limit: 20, tags: ['NEW_SCOPE_TAG'] }); await flush();
    assert.equal(detail.children.length, 0);
    assert.ok(text(byId(f.root, 'memory-tag')).includes('NEW_SCOPE_TAG'));
    assert.ok(!text(f.root).includes('Old private title'));
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('C2: a read that arrives while a character switch commits is retried quietly, never shown as a failure', async () => {
  let calls = 0;
  const f = fixture({ async list() { calls++; if (calls === 1) throw Error("Error invoking remote method 'desk:listMemories': Error: 角色或对话正在切换，请稍后再试。"); return listPage(); } });
  try {
    await f.panel.refresh();
    assert.deepEqual(f.errors, [], 'the switch is not a failure');
    await new Promise(resolve => setTimeout(resolve, 260)); await flush();
    assert.equal(calls, 2, 'read again a moment later');
    assert.ok(text(byId(f.root, 'memory-list')).includes('Old private title'));
    // Any other failure is still reported.
    const g = fixture({ async list() { throw Error('磁盘读不了'); } });
    try { await g.panel.refresh(); assert.equal(g.errors.length, 1); } finally { g.restore(); }
  } finally { f.restore(); }
});

// I-021 (docs/claude/2026-11-04-memory-notes.md): her note beside the open memory, read only; only the note can be deleted.
const madeUpNote: MemoryNoteBody = { title: '学校旁边新开的拉面店', summary: '用户说学校旁边新开了一家拉面店，想周末和小林去尝尝。', people: ['小林'],
  things: ['拉面店'], mood: '期待', plans: ['周末和小林去拉面店'], tags: ['拉面店', '面馆', '周末'] };

test('I-021: an open memory shows her note read only, above the original; deleting it takes two clicks and leaves the original', async () => {
  let state: MemoryNoteState = { status: 'written', note: madeUpNote, writtenAt: 5, progress: { noted: 3, waiting: 2 } };
  const removed: string[] = [];
  const f = fixture({ async note() { return state; },
    async removeNote(id) { removed.push(id); state = { status: 'deleted', note: null, writtenAt: null, progress: { noted: 2, waiting: 2 } }; return state; } });
  try {
    await f.panel.init(); openOldRecord(f.root); await flush();
    const box = byId(f.root, 'memory-note');
    for (const part of ['她的笔记', madeUpNote.title, madeUpNote.summary, '提到的人：小林', '提到的事：拉面店', '你当时的心情：期待', '说好要做的：周末和小林去拉面店',
      '方便想起来的词：拉面店、面馆、周末', '可能记错', '以下面的原文为准', '已经整理了 3 段，还有 2 段等着整理。']) assert.ok(text(box).includes(part), part);
    const detail = byId(f.root, 'memory-detail');
    assert.ok(detail.children.indexOf(box) >= 0 && detail.children.indexOf(box) < detail.children.findIndex(node => node.className === 'memory-messages'));
    assert.ok(!all(box).some(node => node.tagName === 'input' || node.tagName === 'textarea'), 'read only');
    const remove = byId(box, 'memory-note-delete');
    remove.click();
    assert.deepEqual(removed, []);
    assert.equal(remove.textContent, '确认删除这条笔记（原文不删）');
    remove.click(); await flush();
    assert.deepEqual(removed, [summary.id]);
    assert.ok(text(box).includes('这条笔记你删掉了'));
    assert.ok(!text(box).includes(madeUpNote.summary));
    assert.equal(all(detail).find(node => node.tagName === 'pre')!.textContent, 'HEAD', 'the original stays');
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('I-021: a note written meanwhile shows up on refresh, a count change leaves a two-step delete alone; without the note action there is no section', async () => {
  let state: MemoryNoteState = { status: 'waiting', note: null, writtenAt: null, progress: { noted: 0, waiting: 4 } };
  const f = fixture({ async note() { return state; }, async removeNote() { return state; } });
  try {
    await f.panel.init(); openOldRecord(f.root); await flush();
    const box = byId(f.root, 'memory-note');
    assert.ok(text(box).includes('这段还没有笔记'));
    state = { status: 'written', note: madeUpNote, writtenAt: 9, progress: { noted: 1, waiting: 3 } };
    await f.panel.refresh(); await flush();
    assert.ok(text(box).includes(madeUpNote.title));
    byId(box, 'memory-note-delete').click();
    state = { ...state, progress: { noted: 2, waiting: 2 } };
    await f.panel.refresh(); await flush();
    assert.equal(byId(box, 'memory-note-delete').textContent, '确认删除这条笔记（原文不删）');
    assert.ok(text(box).includes('已经整理了 2 段，还有 2 段等着整理。'));
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
  const g = fixture();
  try { await g.panel.init(); openOldRecord(g.root); await flush(); assert.ok(!all(g.root).some(node => node.id === 'memory-note')); }
  finally { g.restore(); }
});
