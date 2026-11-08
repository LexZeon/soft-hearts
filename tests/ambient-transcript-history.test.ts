import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbientTranscriptHistory, type AmbientTranscriptHistoryActions, type AmbientTranscriptHistoryOptions } from '../src/ui/AmbientTranscriptHistory';
import type { AmbientComment, AmbientDeleteResult, AmbientTranscript, AmbientTranscriptPage, AmbientTranscriptQuery, AmbientTranscriptSummary } from '../shared/ambient-audio';

// Text-only DOM/action fixture. It supplies no async generation or deletion logic.
class Element {
  children: Element[] = [];
  id = ''; className = ''; textContent = ''; disabled = false;
  dataset: Record<string, string> = {};
  private fieldValue = '';
  readonly classList = { add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); } };
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onkeydown: ((event: { key: string; isComposing: boolean; preventDefault(): void }) => void) | null = null;
  constructor(readonly tagName: string) {}
  get value(): string { return this.fieldValue; }
  set value(value: string) { this.fieldValue = this.tagName === 'select' && !this.children.some(child => child.value === value) ? '' : value; }
  set innerHTML(_value: string) { throw new Error('History must never parse ASR/user text as HTML'); }
  append(...nodes: Element[]): void {
    this.children.push(...nodes);
    if (this.tagName === 'select' && this.children.length && !this.children.some(child => child.value === this.fieldValue)) this.fieldValue = this.children[0].value;
  }
  replaceChildren(...nodes: Element[]): void { this.children = []; this.append(...nodes); if (this.tagName === 'select') this.fieldValue = this.children[0]?.value ?? ''; }
  setAttribute(_name: string, _value: string): void {}
  click(): void { assert.equal(this.disabled, false); this.onclick?.(); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string => all(root).map(node => node.textContent).join('\n');
function byId(root: Element, id: string): Element { const node = all(root).find(item => item.id === id); assert.ok(node, `element #${id}`); return node; }
function row(root: Element, id: string): Element { const node = all(root).find(item => item.dataset.recordId === id); assert.ok(node, `row ${id}`); return node; }
async function flush(): Promise<void> { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; }); return { promise, resolve, reject }; }
const record = (id = 'record-a', changes: Partial<AmbientTranscript> = {}): AmbientTranscript => ({
  id, sessionId: 'session-a', mode: 'movie', startedAt: 1_800_000_000_001, endedAt: 1_800_000_003_234,
  createdAt: 1_800_000_004_000, source: 'system-audio', title: `Title ${id}`, tags: ['PUBLIC_TAG'],
  language: { status: 'unknown', source: 'unverified' }, text: `Complete original ${id}`, ...changes,
});
function summary(value: AmbientTranscript): AmbientTranscriptSummary {
  const { text, ...metadata } = structuredClone(value); return { ...metadata, excerpt: text.slice(0, 10), totalCharacters: text.length };
}
function page(records: AmbientTranscript[] = [record()], query: AmbientTranscriptQuery = {}, tags = ['PUBLIC_TAG'], total = records.length): AmbientTranscriptPage {
  return { records: records.map(summary), tags, offset: query.offset ?? 0, limit: query.limit ?? 24, total };
}
const comment = (recordId = 'record-a', changes: Partial<AmbientComment> = {}): AmbientComment => ({
  id: `comment-${recordId}`, sessionId: 'session-a', recordIds: [recordId], text: `Displayed comment ${recordId}`,
  createdAt: 1_800_000_005_000, source: 'ambient-assistant-comment', ...changes,
});
function fixture(overrides: Partial<AmbientTranscriptHistoryActions> = {}, options: AmbientTranscriptHistoryOptions = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  const root = new Element('div'), errors: string[] = [], lists: AmbientTranscriptQuery[] = [];
  const actions: AmbientTranscriptHistoryActions = {
    async list(query) { lists.push(structuredClone(query)); return page(undefined, query); },
    async read(id) { return record(id); }, async comments(id) { return [comment(id)]; },
    async remove() { return { deleted: true, invalidatedCandidateIds: [] }; }, onError(message) { errors.push(message); }, ...overrides,
  };
  const history = new AmbientTranscriptHistory(root as unknown as HTMLElement, actions, options);
  return { root, history, errors, lists, restore() { history.dispose(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document'); } };
}

test('history searches and pages bounded queries while preserving literal originals and actual language/comment provenance', async () => {
  const unsafe = '<img src=x onerror="not-executed">完整原文\n台词尾部😀';
  const original = record('record-a', { title: '<b>Literal title</b>', text: unsafe, language: { status: 'detected', language: 'ja', source: 'provider' } });
  const calls: AmbientTranscriptQuery[] = [];
  const f = fixture({
    async list(query) { calls.push(structuredClone(query)); return page([original], query, ['PUBLIC_TAG'], 49); },
    async read() { return original; },
    async comments() { return [comment('record-a', { text: '<script>Literal comment</script>' }), comment('record-a', { id: 'foreign', sessionId: 'other-session', text: 'MUST_NOT_RENDER' })]; },
  });
  try {
    assert.equal(calls.length, 0, 'constructor does not query a scope before the host is ready');
    await f.history.init(); assert.deepEqual(calls[0], { offset: 0, limit: 24 });
    const query = byId(f.root, 'ambient-transcript-query'); query.value = '  原文  ';
    byId(f.root, 'ambient-transcript-search').click(); await flush();
    assert.deepEqual(calls.at(-1), { offset: 0, limit: 24, query: '原文' });
    const tag = byId(f.root, 'ambient-transcript-tag'); tag.value = 'PUBLIC_TAG'; tag.onchange?.(); await flush();
    assert.deepEqual(calls.at(-1), { offset: 0, limit: 24, query: '原文', tag: 'PUBLIC_TAG' });
    byId(f.root, 'ambient-transcript-next').click(); await flush(); assert.equal(calls.at(-1)!.offset, 24);
    const beforeIme = calls.length;
    query.onkeydown?.({ key: 'Enter', isComposing: true, preventDefault() { throw new Error('IME should retain Enter'); } });
    await flush(); assert.equal(calls.length, beforeIme);
    row(f.root, original.id).click(); await flush();
    assert.equal(byId(f.root, 'ambient-transcript-original').textContent, unsafe);
    assert.ok(text(f.root).includes('日语 · 转写服务返回'));
    assert.ok(text(f.root).includes(new Date(original.startedAt).toLocaleString()));
    assert.ok(text(f.root).includes(new Date(original.endedAt).toLocaleString()));
    assert.ok(text(f.root).includes('<script>Literal comment</script>'));
    assert.ok(!text(f.root).includes('MUST_NOT_RENDER'));
    assert.ok(!all(f.root).some(node => ['img', 'script', 'b'].includes(node.tagName)));
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
  const capped = fixture({}, { pageSize: 900 });
  try { await capped.history.init(); assert.equal(capped.lists[0].limit, 100); } finally { capped.restore(); }
});

test('scope reset clears old data immediately and rejects late list, full original and comment results without new implicit requests', async () => {
  const lateList = deferred<AmbientTranscriptPage>(), lateRead = deferred<AmbientTranscript>(), lateComments = deferred<AmbientComment[]>();
  const newList = deferred<AmbientTranscriptPage>(); let current = 'old', listCalls = 0, reads = 0;
  const f = fixture({
    async list() { listCalls++; return current === 'new' ? newList.promise : listCalls === 1 ? page([record('old')], {}, ['OLD_PRIVATE_TAG']) : lateList.promise; },
    async read() { reads++; return lateRead.promise; }, async comments() { return lateComments.promise; },
  });
  try {
    await f.history.init(); const oldRow = row(f.root, 'old'); oldRow.click();
    const oldRefresh = f.history.refresh();
    current = 'new'; f.history.reset();
    assert.equal(listCalls, 2, 'reset itself must not query another scope');
    assert.equal(byId(f.root, 'ambient-transcript-list').children.length, 0);
    assert.equal(byId(f.root, 'ambient-transcript-detail').children.length, 0);
    assert.equal(byId(f.root, 'ambient-transcript-status').textContent, '');
    assert.ok(!text(f.root).includes('OLD_PRIVATE_TAG'));
    const newRefresh = f.history.refresh();
    lateRead.resolve(record('old', { text: 'OLD_PRIVATE_ORIGINAL' }));
    lateComments.resolve([comment('old', { text: 'OLD_PRIVATE_COMMENT' })]);
    lateList.resolve(page([record('old-late', { title: 'OLD_PRIVATE_LIST' })], {}, ['OLD_PRIVATE_TAG']));
    await oldRefresh; await flush();
    assert.ok(!text(f.root).includes('OLD_PRIVATE'));
    oldRow.click(); assert.equal(reads, 1, 'detached previous-scope actions are also invalidated');
    newList.resolve(page([record('new')], {}, ['NEW_SCOPE_TAG'])); await newRefresh;
    assert.ok(text(f.root).includes('Title new')); assert.ok(text(f.root).includes('NEW_SCOPE_TAG'));
    assert.ok(!text(f.root).includes('OLD_PRIVATE'));
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('deletion immediately invalidates selected comments, preserves a newer selection, and never follows a reset with stale refresh/error', async () => {
  const deletionA = deferred<AmbientDeleteResult>(), deletionB = deferred<AmbientDeleteResult>(); let removedA = false, removals = 0, listCalls = 0;
  const f = fixture({
    async list(query) { listCalls++; return page(removedA ? [record('b')] : [record('a'), record('b')], query); },
    async remove(id) { removals++; if (id === 'a') return deletionA.promise; return deletionB.promise; },
  });
  try {
    await f.history.init(); row(f.root, 'a').click(); await flush();
    const removeA = byId(f.root, 'ambient-transcript-delete'); removeA.click();
    assert.equal(removals, 0, 'confirmation is reviewable before deleting the original');
    removeA.click(); assert.equal(removals, 1);
    assert.equal(byId(f.root, 'ambient-transcript-detail').children.length, 0);
    row(f.root, 'b').click(); await flush(); assert.equal(byId(f.root, 'ambient-transcript-original').textContent, 'Complete original b');
    removedA = true; deletionA.resolve({ deleted: true, invalidatedCandidateIds: ['candidate-a'], deletedCommentIds: ['comment-a'] }); await flush();
    assert.equal(byId(f.root, 'ambient-transcript-original').textContent, 'Complete original b');
    assert.ok(!text(byId(f.root, 'ambient-transcript-detail')).includes('Displayed comment a'));
    const removeB = byId(f.root, 'ambient-transcript-delete'); removeB.click(); removeB.click();
    f.history.reset(); const callsBeforeLate = listCalls;
    deletionB.reject(new Error('OLD_PRIVATE_DELETE_FAILURE')); await flush();
    assert.equal(listCalls, callsBeforeLate);
    assert.equal(byId(f.root, 'ambient-transcript-detail').children.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});
