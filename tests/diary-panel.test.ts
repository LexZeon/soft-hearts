import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { uiText, uiTemplate } from '../src/ui/ui-language';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';
import { ProfileViewGate } from '../src/ui/ProfileViewGate';

// Same light DOM stand-in as tests/profile-panel.test.ts: no markup parsing exists, so text can only be textContent/value.
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
  const source = readFileSync(new URL('../src/ui/UserProfilePanel.ts', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export class UserProfilePanel', 'class UserProfilePanel');
  const js = transformSync(source, { loader: 'ts', target: 'es2022' }).code;
  return new Function('ProfileViewGate', 'uiText', 'uiTemplate', `${js};return UserProfilePanel`)(ProfileViewGate, uiText, uiTemplate);
}
const view = (revision = 0, diary = [
  { date: '2026-10-30', text: '前几天的日记', writtenAt: 1 },
  { date: '2026-11-01', text: '<script>alert(1)</script>今天你说要去爬山，我替你高兴。', writtenAt: 2, editedAt: 3 },
]) => ({ scopeId: 'A', generation: 1, revision, enabled: true, entries: [], diary: [...diary].sort((a, b) => b.date.localeCompare(a.date)) });

function mount(initial = view()) {
  const calls: { method: string; request: Record<string, unknown> }[] = [];
  let current = initial;
  const respond = (method: string) => async (request: Record<string, unknown>) => {
    calls.push({ method, request });
    current = method === 'clearUserDiary' ? { ...current, revision: current.revision + 1, diary: [] }
      : method === 'deleteUserDiary' ? { ...current, revision: current.revision + 1, diary: current.diary.filter(entry => entry.date !== request.date) }
        : { ...current, revision: current.revision + 1, diary: current.diary.map(entry => entry.date === request.date ? { ...entry, text: String(request.text), editedAt: 9 } : entry) };
    return current;
  };
  const api = { onUserProfileChanged: () => () => {}, getUserProfile: async () => current,
    setUserProfileEnabled: async () => { throw Error('unexpected'); }, editUserProfile: async () => { throw Error('unexpected'); }, deleteUserProfile: async () => { throw Error('unexpected'); },
    editUserDiary: respond('editUserDiary'), deleteUserDiary: respond('deleteUserDiary'), clearUserDiary: respond('clearUserDiary') };
  const panel = new Element('section', doc), trigger = new Element('button', doc); panel.hidden = true;
  const Panel = PanelCtor(), instance = new Panel(panel, trigger, api, (message: string) => { throw Error(message); });
  return { panel, instance, calls };
}
const diarySection = (panel: Element) => find(panel, n => n.className === 'user-profile-diary')!;

test('the diary lists days newest first and shows text only as text', async () => {
  const { panel, instance, calls } = mount(); await tick(); instance.open();
  const section = diarySection(panel); assert.ok(section);
  const headings = all(section, n => n.tagName === 'article').map(card => card.children[0].textContent);
  assert.deepEqual(headings, ['2026-11-01（已修改）', '2026-10-30']);
  assert.ok(texts(section).includes('<script>alert(1)</script>今天你说要去爬山'));
  assert.equal(find(panel, n => n.tagName === 'script'), undefined);
  assert.equal(calls.length, 0, 'opening the panel changes nothing');
  instance.dispose();
});

test('editing a day sends only that date and the new text, with the current identity', async () => {
  const { panel, instance, calls } = mount(); await tick(); instance.open();
  const firstCard = all(diarySection(panel), n => n.tagName === 'article')[0];
  button(firstCard, '修改日记').onclick?.();
  const text = find(diarySection(panel), n => n.tagName === 'textarea')!; assert.ok(text.value.includes('爬山'));
  text.value = '我改写了这一天。'; text.oninput?.();
  button(panel, '保存日记修改').onclick?.(); await tick();
  assert.deepEqual(calls, [{ method: 'editUserDiary', request: { scopeId: 'A', generation: 1, revision: 0, date: '2026-11-01', text: '我改写了这一天。' } }]);
  assert.equal(find(diarySection(panel), n => n.tagName === 'textarea'), undefined, 'saved: back to reading');
  assert.ok(texts(diarySection(panel)).includes('我改写了这一天。'));
  instance.dispose();
});

test('deleting a day and clearing the diary both need an explicit confirmation', async () => {
  const { panel, instance, calls } = mount(); await tick(); instance.open();
  button(all(diarySection(panel), n => n.tagName === 'article')[1], '删除这天的日记').onclick?.();
  assert.equal(calls.length, 0);
  button(panel, '取消').onclick?.(); assert.equal(calls.length, 0);
  button(all(diarySection(panel), n => n.tagName === 'article')[1], '删除这天的日记').onclick?.();
  button(panel, '确认删除这天的日记').onclick?.(); await tick();
  assert.deepEqual(calls.at(-1), { method: 'deleteUserDiary', request: { scopeId: 'A', generation: 1, revision: 0, date: '2026-10-30' } });
  assert.deepEqual(all(diarySection(panel), n => n.tagName === 'article').length, 1);
  button(panel, '清空全部日记').onclick?.(); assert.equal(calls.length, 1);
  button(panel, '确认清空全部日记').onclick?.(); await tick();
  assert.deepEqual(calls.at(-1), { method: 'clearUserDiary', request: { scopeId: 'A', generation: 1, revision: 1 } });
  assert.ok(texts(diarySection(panel)).includes('还没有日记。'));
  assert.equal(find(panel, n => n.tagName === 'button' && n.textContent === '清空全部日记'), undefined);
  instance.dispose();
});

test('a view without a diary field (older host) still renders, and English copy covers the diary', async () => {
  registerUiMessages({ en: ENGLISH_SETTINGS_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  try {
    const legacy = { scopeId: 'A', generation: 1, revision: 0, enabled: false, entries: [] };
    const { panel, instance } = mount(legacy as never); await tick(); instance.open();
    assert.ok(texts(panel).includes('Diary')); assert.ok(texts(panel).includes('No diary entries yet.'));
    instance.dispose();
    const filled = mount(); await tick(); filled.instance.open();
    for (const label of ['Edit entry', 'Delete this day', 'Clear the whole diary']) button(filled.panel, label);
    assert.ok(texts(filled.panel).includes('2026-11-01 (edited)'));
    filled.instance.dispose();
  } finally { setUiLanguage('zh-CN'); }
});
