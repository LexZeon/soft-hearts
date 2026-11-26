// I-051 「带我去」: the local map, the host offer, the renderer button. Sentences are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TAKE_ME_THERE, TAKE_ME_THERE_IDS, isTakeMeThereId, matchTakeMeThere, type TakeMeThereId, type TakeMeThereView } from '../shared/initiative/take-me-there';
import { TakeMeThere } from '../electron/initiative/take-me-there';
import { TakeMeThereOffers, flashTarget, readTakeMeThere, takeMeThereLeaf } from '../src/initiative/TakeMeThere';
import { CONTROL_NAVIGATION, ControlNavigationState } from '../src/settings/control-navigation-state';
import { ENGLISH_UI_COPY } from '../shared/foundation/ui-copy.en';
import { setUiLanguage } from '../shared/foundation/ui-language';

setUiLanguage('zh-CN');

test('the map only points at pages that exist in the control window', () => {
  for (const id of TAKE_ME_THERE_IDS) {
    const leaf = takeMeThereLeaf(id);
    assert.ok(leaf, `${id} -> ${TAKE_ME_THERE[id].leafId} must be a leaf of the control navigation`);
    const state = new ControlNavigationState();
    assert.equal(state.navigate(leaf.page, leaf.target)?.leafId, leaf.id, `${id} navigates to its own leaf`);
  }
  assert.equal(takeMeThereLeaf('not-a-page'), null);
  assert.equal(takeMeThereLeaf('../../etc'), null);
  assert.ok(CONTROL_NAVIGATION.length > 0);
});

test('the user asking for something on the map gets its page', () => {
  const cases: [string, TakeMeThereId][] = [
    ['帮我访问一下桌面上的文件', 'task-folder'],
    ['让她能看我的文件夹', 'task-folder'],
    ['开一下屏幕共享', 'screen'],
    ['你能打开屏幕共享吗', 'screen'],
    ['打开摄像头', 'camera'],
    ['我想让你看看我的屏幕', 'screen'],
    ['帮我打开麦克风', 'mic'],
    ['我想和你一起听歌', 'listen'],
    ['开启电脑声音', 'listen'],
    ['打开 Claude 任务', 'claude-tasks'],
    ['我要填百炼的密钥', 'bailian-key'],
    ['换一个朗读的声音', 'voice-scheme'],
    ['删除聊天记录', 'delete-data'],
    ['清空记忆', 'delete-memory'],
    ['导入一个新角色', 'import-character'],
    ['想换模型', 'import-model'],
  ];
  for (const [text, id] of cases) assert.equal(matchTakeMeThere(text), id, text);
});

test('chit-chat that only mentions the thing, things a card can do, and refusals give no button', () => {
  for (const text of ['我在看屏幕上的剧', '这个文件好大', '朗读声音小一点', '把音量调高一点', '今天的屏幕好亮', '我看了这个文件', '别打开摄像头', '不要开屏幕共享', '先别访问我的文件夹', '', '你好呀'])
    assert.equal(matchTakeMeThere(text), null, text);
  assert.equal(matchTakeMeThere(undefined), null);
  assert.equal(matchTakeMeThere({ a: 1 }), null);
});

test('a refusal in one clause does not hide a request in another', () => {
  assert.equal(matchTakeMeThere('别开摄像头，帮我开一下屏幕共享'), 'screen');
});

const view = (patch: Partial<TakeMeThereView> = {}): TakeMeThereView => ({ kind: 'take-me-there', version: 1, offerId: 'o1', destination: 'task-folder', state: 'open', ...patch });

function host(options: { ttlMs?: number } = {}) {
  const sent: { owner: number; view: TakeMeThereView }[] = [], opened: TakeMeThereId[] = [];
  let now = 0, n = 0;
  const go = new TakeMeThere({ send: (owner, v) => sent.push({ owner, view: v }), open: d => opened.push(d), now: () => now, id: () => `o${++n}`, ttlMs: options.ttlMs });
  return { go, sent, opened, tick: (ms: number) => { now += ms; } };
}

test('host: a matched message without a setting card gets one button for the owning window', () => {
  const h = host();
  const turn = h.go.beginTurn('帮我访问一下桌面上的文件');
  assert.equal(turn.destination, 'task-folder');
  const offer = h.go.offer(turn, 7, false);
  assert.deepEqual(offer, view());
  assert.deepEqual(h.sent, [{ owner: 7, view: view() }]);
});

test('host: no button when her reply carried a setting card, when nothing matched, or after a new turn began', () => {
  const h = host();
  assert.equal(h.go.offer(h.go.beginTurn('开一下屏幕共享'), 7, true), null, 'the card is the answer');
  assert.equal(h.go.offer(h.go.beginTurn('我在看屏幕上的剧'), 7, false), null);
  const stale = h.go.beginTurn('开一下屏幕共享');
  h.go.beginTurn('随便聊聊');
  assert.equal(h.go.offer(stale, 7, false), null, 'a late reply of an older turn');
  assert.deepEqual(h.sent, []);
});

test('host: a new turn, a context change or the lifetime takes the button away', () => {
  const h = host({ ttlMs: 1000 });
  h.go.offer(h.go.beginTurn('开一下屏幕共享'), 7, false);
  h.go.beginTurn('再说一句');
  assert.equal(h.sent.at(-1)?.view.state, 'gone');
  assert.equal(h.go.go(7, { offerId: 'o1', destination: 'screen' }), false);
  h.go.offer(h.go.beginTurn('开一下屏幕共享'), 7, false);
  h.go.invalidate();
  assert.equal(h.sent.at(-1)?.view.state, 'gone');
  h.go.offer(h.go.beginTurn('开一下屏幕共享'), 7, false);
  h.tick(1001);
  assert.equal(h.go.go(7, { offerId: 'o3', destination: 'screen' }), false);
  assert.deepEqual(h.opened, []);
});

test('host: a tap only opens the page of its own offer', () => {
  const h = host();
  h.go.offer(h.go.beginTurn('开一下屏幕共享'), 7, false);
  assert.equal(h.go.go(7, { offerId: 'o1', destination: 'screen' }), true);
  assert.deepEqual(h.opened, ['screen']);
  // Opening is repeatable and changes nothing else; refused requests open nothing.
  for (const bad of [null, 'screen', {}, { offerId: 'o1' }, { offerId: 'o1', destination: 'camera' }, { offerId: 'o1', destination: 'privacy-screen' },
    { offerId: 'o1', destination: '../x' }, { offerId: 'other', destination: 'screen' }, { offerId: 'o1', destination: 7 }])
    assert.equal(h.go.go(7, bad), false);
  assert.throws(() => h.go.go(8, { offerId: 'o1', destination: 'screen' }), /未授权/u, 'another window');
  assert.deepEqual(h.opened, ['screen']);
});

test('host: the tap callback is not given anything but the closed id', () => {
  const h = host();
  h.go.offer(h.go.beginTurn('打开摄像头'), 7, false);
  h.go.go(7, { offerId: 'o1', destination: 'camera', path: 'C:/x', extra: 1 });
  assert.deepEqual(h.opened, ['camera']);
});

// A minimal DOM, enough for the button.
class El {
  children: El[] = []; className = ''; textContent: string | null = ''; type = ''; disabled = false; attrs = new Map<string, string>(); parent: El | null = null; onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...c: El[]) { for (const x of c) { x.parent = this; this.children.push(x); } }
  prepend(...c: El[]) { for (const x of c) x.parent = this; this.children.unshift(...c); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
}
const doc = { createElement: (tag: string) => new El(tag) } as unknown as Document;
const buttons = (root: El): El[] => root.children.flatMap(c => [...(c.tagName === 'button' ? [c] : []), ...buttons(c)]);

test('renderer: the button reads 「带我去：页面」, taps send the offer, gone removes it, bad data is ignored', async () => {
  const container = new El('div'), taps: unknown[] = [];
  const offers = new TakeMeThereOffers({ go: async request => { taps.push(request); return true; }, container: () => container as unknown as HTMLElement }, doc);
  offers.present({ ...view(), extra: 'ignored' });
  const [button] = buttons(container);
  assert.equal(button.textContent, '带我去：Claude 任务 · 工作目录');
  button.onclick!();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(taps, [{ offerId: 'o1', destination: 'task-folder' }]);
  offers.present(view({ offerId: 'o2', destination: 'screen' }));
  assert.equal(buttons(container).length, 1, 'only one button at a time');
  offers.present(view({ offerId: 'o1', state: 'gone' }));
  assert.equal(buttons(container).length, 1, 'a removal for another offer changes nothing');
  offers.present(view({ offerId: 'o2', state: 'gone' }));
  assert.equal(buttons(container).length, 0);
  for (const bad of [null, 'x', [], { ...view(), destination: 'privacy-screen' }, { ...view(), version: 2 }, { ...view(), state: 'busy' }, { ...view(), offerId: '' }]) {
    offers.present(bad);
    assert.equal(buttons(container).length, 0);
  }
  assert.equal(readTakeMeThere({ ...view(), destination: '__proto__' }), null);
});

test('renderer: a refused tap (expired offer) takes the button away; the pet gets it first in its chat area', async () => {
  const container = new El('div'); container.append(new El('form'));
  const offers = new TakeMeThereOffers({ go: async () => false, container: () => container as unknown as HTMLElement, prepend: true }, doc);
  offers.present(view());
  assert.equal(container.children[0].className, 'take-me-there');
  buttons(container)[0].onclick!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(buttons(container).length, 0);
});

test('every new visible string has an English entry and the button reads in English', () => {
  assert.ok(ENGLISH_UI_COPY['带我去：{0}']);
  for (const id of TAKE_ME_THERE_IDS) assert.ok(ENGLISH_UI_COPY[TAKE_ME_THERE[id].title], `${id}: ${TAKE_ME_THERE[id].title}`);
  setUiLanguage('en');
  try {
    const container = new El('div');
    new TakeMeThereOffers({ go: async () => true, container: () => container as unknown as HTMLElement }, doc).present(view({ destination: 'screen' }));
    assert.equal(buttons(container)[0].textContent, 'Take me there: Screen sharing');
  } finally { setUiLanguage('zh-CN'); }
});

test('flashing marks the item (or its visible container) for a moment and nothing else', () => {
  const classes = new Set<string>();
  const hidden = { getClientRects: () => [], parentElement: { getClientRects: () => [1], parentElement: null, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } }, classList: { add: () => assert.fail('hidden'), remove() {} } };
  let later: (() => void) | null = null;
  flashTarget(hidden as unknown as HTMLElement, callback => { later = callback; });
  assert.ok(classes.has('take-me-there-flash'));
  later!();
  assert.equal(classes.size, 0);
  flashTarget(null);
});

test('her prompts are untouched: no prompt module knows about the button', () => {
  for (const file of ['../electron/brain/claude-session-prompt.ts', '../electron/brain/chat-settings.ts', '../electron/brain/conversation-context.ts', '../shared/safety/agent-channel.ts'])
    assert.ok(!/take-me-there|TakeMeThere/u.test(readFileSync(new URL(file, import.meta.url), 'utf8')), file);
  assert.ok(isTakeMeThereId('screen') && !isTakeMeThereId('toString'));
});
