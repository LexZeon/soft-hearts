// I-088 第 1 条 她的"这阵子"回顾: the control window's panel shows the look-backs next to the diary (months first, then weeks, newest first),
// each editable and deletable (a confirmation first), as text only, and nothing is sent by opening it. Same light DOM stand-in as
// tests/diary-panel.test.ts.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { uiText, uiTemplate } from '../src/foundation/ui-language';
import { registerUiMessages, setUiLanguage } from '../shared/foundation/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/foundation/ui-copy.settings.en';
import { ProfileViewGate } from '../src/memory/ProfileViewGate';

class Element {
  children: Element[] = []; textContent = ''; hidden = false; disabled = false; value = ''; checked = false; className = ''; maxLength = 0; rows = 0;
  type = ''; attrs: Record<string, string> = {}; onclick: (() => void) | null = null; oninput: (() => void) | null = null; onchange: (() => void) | null = null;
  constructor(public tagName: string, public ownerDocument: unknown) {}
  append(...nodes: Element[]) { this.children.push(...nodes); } replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; } addEventListener() {} removeEventListener() {} focus() {}
}
const doc = { createElement: (tag: string) => new Element(tag, doc) };
const find = (root: Element, p: (e: Element) => boolean): Element | undefined => p(root) ? root : root.children.map(c => find(c, p)).find(Boolean);
const all = (root: Element, p: (e: Element) => boolean): Element[] => [...(p(root) ? [root] : []), ...root.children.flatMap(c => all(c, p))];
const texts = (root: Element): string => [root.textContent, ...root.children.map(texts)].join('|');
const button = (root: Element, label: string) => { const b = find(root, n => n.tagName === 'button' && n.textContent === label); assert.ok(b, label); return b; };
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
function PanelCtor() {
  const source = readFileSync(new URL('../src/memory/UserProfilePanel.ts', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export class UserProfilePanel', 'class UserProfilePanel');
  const js = transformSync(source, { loader: 'ts', target: 'es2022' }).code;
  return new Function('ProfileViewGate', 'uiText', 'uiTemplate', `${js};return UserProfilePanel`)(ProfileViewGate, uiText, uiTemplate);
}
type Review = { kind: 'week' | 'month'; key: string; text: string; writtenAt: number; editedAt?: number };
const REVIEWS: Review[] = [
  { kind: 'month', key: '2026-10', text: '十月里你搬了新家。', writtenAt: 4 },
  { kind: 'week', key: '2026-11-02', text: '<script>alert(1)</script>这周我们去了海边。', writtenAt: 3, editedAt: 5 },
  { kind: 'week', key: '2026-10-26', text: '上一周你忙着搬家。', writtenAt: 2 },
];
const view = (revision = 0, reviews: Review[] | null = REVIEWS, enabled = true) => ({ scopeId: 'A', generation: 1, revision, enabled, entries: [], diary: [], upcoming: [], ...(reviews ? { reviews } : {}) });

function mount(initial: unknown = view(), withReviewApi = true) {
  const calls: { method: string; request: Record<string, unknown> }[] = [];
  let current = initial as ReturnType<typeof view>;
  const respond = (method: string) => async (request: Record<string, unknown>) => {
    calls.push({ method, request });
    current = method === 'deleteUserReview' ? { ...current, reviews: (current.reviews ?? []).filter(item => !(item.kind === request.kind && item.key === request.key)) }
      : { ...current, reviews: (current.reviews ?? []).map(item => item.kind === request.kind && item.key === request.key ? { ...item, text: String(request.text), editedAt: 9 } : item) };
    return current;
  };
  const unexpected = async () => { throw Error('unexpected'); };
  const api = { onUserProfileChanged: () => () => {}, getUserProfile: async () => current, setUserProfileEnabled: unexpected, editUserProfile: unexpected, deleteUserProfile: unexpected,
    editUserDiary: unexpected, deleteUserDiary: unexpected, clearUserDiary: unexpected, deleteUserUpcoming: unexpected, clearUserUpcoming: unexpected,
    ...(withReviewApi ? { editUserReview: respond('editUserReview'), deleteUserReview: respond('deleteUserReview') } : {}) };
  const panel = new Element('section', doc), trigger = new Element('button', doc); panel.hidden = true;
  const Panel = PanelCtor(), instance = new Panel(panel, trigger, api, (message: string) => { throw Error(message); });
  return { panel, instance, calls };
}
const section = (panel: Element) => find(panel, n => n.className === 'user-profile-reviews');
const cards = (panel: Element) => all(section(panel)!, n => n.tagName === 'article');

test('the look-backs are listed under the diary, months first then weeks newest first, as text only; opening changes nothing', async () => {
  const { panel, instance, calls } = mount(); await tick(); instance.open();
  assert.ok(section(panel)); assert.ok(texts(section(panel)!).includes('这阵子的回顾'));
  assert.deepEqual(cards(panel).map(card => card.children[0]!.textContent), ['2026 年 10 月', '2026-11-02 起的一周（已修改）', '2026-10-26 起的一周']);
  assert.ok(texts(section(panel)!).includes('<script>alert(1)</script>这周我们去了海边。'));
  assert.equal(find(panel, n => n.tagName === 'script'), undefined);
  const order = all(panel, n => n.className === 'user-profile-diary' || n.className === 'user-profile-reviews' || n.className === 'user-profile-upcoming').map(n => n.className);
  assert.deepEqual(order, ['user-profile-diary', 'user-profile-reviews', 'user-profile-upcoming'], 'next to the diary');
  assert.equal(calls.length, 0);
  instance.dispose();
});

test('with recording off the look-backs are still listed and manageable', async () => {
  const { panel, instance } = mount(view(0, REVIEWS, false)); await tick(); instance.open();
  assert.equal(cards(panel).length, 3);
  for (const label of ['修改回顾', '删除这段回顾']) assert.ok(all(section(panel)!, n => n.tagName === 'button' && n.textContent === label).length >= 3);
  instance.dispose();
});

test('editing sends only that period and the new text with the current identity, then goes back to reading', async () => {
  const { panel, instance, calls } = mount(); await tick(); instance.open();
  button(cards(panel)[1]!, '修改回顾').onclick?.();
  const text = find(section(panel)!, n => n.tagName === 'textarea')!; assert.ok(text.value.includes('海边')); assert.equal(text.maxLength, 1200);
  text.value = '我改写了这一周。'; text.oninput?.();
  button(panel, '保存回顾修改').onclick?.(); await tick();
  assert.deepEqual(calls, [{ method: 'editUserReview', request: { scopeId: 'A', generation: 1, revision: 0, kind: 'week', key: '2026-11-02', text: '我改写了这一周。' } }]);
  assert.equal(find(section(panel)!, n => n.tagName === 'textarea'), undefined);
  assert.ok(texts(section(panel)!).includes('我改写了这一周。'));
  instance.dispose();
});

test('discarding an edit sends nothing; deleting needs a confirmation and sends the kind and key', async () => {
  const { panel, instance, calls } = mount(); await tick(); instance.open();
  button(cards(panel)[0]!, '修改回顾').onclick?.();
  button(panel, '放弃修改').onclick?.(); assert.equal(calls.length, 0);
  button(cards(panel)[0]!, '删除这段回顾').onclick?.(); assert.equal(calls.length, 0, 'asks first');
  button(panel, '取消').onclick?.(); assert.equal(calls.length, 0);
  button(cards(panel)[0]!, '删除这段回顾').onclick?.();
  button(panel, '确认删除这段回顾').onclick?.(); await tick();
  assert.deepEqual(calls, [{ method: 'deleteUserReview', request: { scopeId: 'A', generation: 1, revision: 0, kind: 'month', key: '2026-10' } }]);
  assert.equal(cards(panel).length, 2);
  instance.dispose();
});

test('no look-backs yet says so; a host without the feature shows no section; English copy covers it', async () => {
  const none = mount(view(0, [])); await tick(); none.instance.open();
  assert.ok(texts(section(none.panel)!).includes('她还没有写过回顾。')); none.instance.dispose();
  const older = mount(view(0, null)); await tick(); older.instance.open();
  assert.equal(section(older.panel), undefined, 'a view from an older host has no reviews field'); older.instance.dispose();
  const noApi = mount(view(), false); await tick(); noApi.instance.open();
  assert.equal(section(noApi.panel), undefined, 'a window without the two operations shows nothing it cannot do'); noApi.instance.dispose();
  registerUiMessages({ en: ENGLISH_SETTINGS_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  try {
    const english = mount(); await tick(); english.instance.open();
    const text = texts(section(english.panel)!);
    for (const expected of ['Look-backs', 'Month 2026-10', 'Week of 2026-11-02 (edited)', 'Week of 2026-10-26']) assert.ok(text.includes(expected), expected);
    for (const label of ['Edit look-back', 'Delete this look-back']) button(english.panel, label);
    english.instance.dispose();
  } finally { setUiLanguage('zh-CN'); }
});
