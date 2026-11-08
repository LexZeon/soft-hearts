import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { uiText, uiTemplate } from '../src/ui/ui-language';
import { ProfileViewGate } from '../src/ui/ProfileViewGate';

// Same light DOM stand-in as tests/diary-panel.test.ts.
class Element {
  children: Element[] = []; textContent = ''; hidden = false; disabled = false; value = ''; checked = false; className = ''; maxLength = 0; rows = 0;
  type = ''; attrs: Record<string, string> = {}; onclick: (() => void) | null = null; oninput: (() => void) | null = null; onchange: (() => void) | null = null;
  constructor(public tagName: string, public ownerDocument: unknown) {}
  append(...nodes: Element[]) { this.children.push(...nodes); } replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; } addEventListener() {} removeEventListener() {} focus() {}
}
const doc = { createElement: (tag: string) => new Element(tag, doc) };
const find = (root: Element, p: (e: Element) => boolean): Element | undefined => p(root) ? root : root.children.map(c => find(c, p)).find(Boolean);
const texts = (root: Element): string => [root.textContent, ...root.children.map(texts)].join('|');
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function PanelCtor() {
  const source = readFileSync(new URL('../src/ui/UserProfilePanel.ts', import.meta.url), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export class UserProfilePanel', 'class UserProfilePanel');
  const js = transformSync(source, { loader: 'ts', target: 'es2022' }).code;
  return new Function('ProfileViewGate', 'uiText', 'uiTemplate', `${js};return UserProfilePanel`)(ProfileViewGate, uiText, uiTemplate);
}
const view = { scopeId: 'A', generation: 1, revision: 0, enabled: false, entries: [], diary: [{ date: '2026-11-01', text: '昨天抢布丁没抢到。', writtenAt: 1, meme: '最后一个布丁' }] };

function mount(options: { nickname?: string | null; offer?: boolean; fail?: boolean } = {}) {
  let nickname: string | null = options.nickname ?? null;
  const calls: Array<string | null> = [];
  const api: Record<string, unknown> = { onUserProfileChanged: () => () => {}, getUserProfile: async () => view,
    setUserProfileEnabled: async () => { throw Error('unexpected'); }, editUserProfile: async () => { throw Error('unexpected'); }, deleteUserProfile: async () => { throw Error('unexpected'); },
    editUserDiary: async () => { throw Error('unexpected'); }, deleteUserDiary: async () => { throw Error('unexpected'); }, clearUserDiary: async () => { throw Error('unexpected'); } };
  if (options.offer !== false) {
    api.getRelationshipNickname = async () => nickname;
    api.setRelationshipNickname = async (value: string | null) => {
      calls.push(value);
      if (options.fail) throw Error('称呼需要是 1 到 8 个字的普通文字。');
      nickname = value; return nickname;
    };
  }
  const errors: string[] = [];
  const panel = new Element('section', doc), trigger = new Element('button', doc); panel.hidden = true;
  const Panel = PanelCtor(), instance = new Panel(panel, trigger, api, (message: string) => { errors.push(message); });
  return { panel, instance, calls, errors };
}
const section = (panel: Element) => find(panel, n => n.className === 'user-profile-nickname');
const button = (root: Element, label: string) => { const b = find(root, n => n.tagName === 'button' && n.textContent === label); assert.ok(b, label); return b; };

test('the nickname section shows what she calls the user, and says there is none yet', async () => {
  const empty = mount(); await tick(); empty.instance.open(); await tick();
  assert.ok(texts(section(empty.panel)!).includes('还没有称呼。'));
  assert.equal(find(section(empty.panel)!, n => n.tagName === 'button' && n.textContent === '删除称呼'), undefined, 'nothing to delete');
  assert.ok(texts(section(empty.panel)!).includes('你明确说好才会记下'));
  const named = mount({ nickname: '小糖' }); await tick(); named.instance.open(); await tick();
  assert.ok(texts(section(named.panel)!).includes('小糖'));
  assert.equal(find(section(named.panel)!, n => n.tagName === 'input')!.value, '小糖');
  button(section(named.panel)!, '删除称呼');
  empty.instance.dispose(); named.instance.dispose();
});

test('changing and deleting the nickname go through the host; opening the panel changes nothing', async () => {
  const { panel, instance, calls } = mount({ nickname: '小糖' }); await tick(); instance.open(); await tick();
  assert.deepEqual(calls, [], 'opening is read only');
  const input = find(section(panel)!, n => n.tagName === 'input')!;
  assert.equal(input.maxLength, 8);
  input.value = '阿满'; input.oninput?.();
  button(section(panel)!, '保存称呼').onclick?.(); await tick();
  assert.deepEqual(calls, ['阿满']);
  assert.ok(texts(section(panel)!).includes('阿满'));
  button(section(panel)!, '删除称呼').onclick?.(); await tick();
  assert.deepEqual(calls, ['阿满', null]);
  assert.ok(texts(section(panel)!).includes('还没有称呼。'));
  // An empty box saves as a delete rather than as an empty nickname.
  input.value = '  '; find(section(panel)!, n => n.tagName === 'input')!.oninput?.();
  instance.dispose();
});

test('a refused nickname is reported and nothing is shown as saved; a window without the bridge shows no section', async () => {
  const failing = mount({ nickname: '小糖', fail: true }); await tick(); failing.instance.open(); await tick();
  const input = find(section(failing.panel)!, n => n.tagName === 'input')!;
  input.value = '这个称呼实在是太长太长了'; input.oninput?.();
  button(section(failing.panel)!, '保存称呼').onclick?.(); await tick();
  assert.equal(failing.errors.length, 1);
  assert.ok(texts(section(failing.panel)!).includes('小糖'), 'the old nickname is still what is shown');
  failing.instance.dispose();
  const bare = mount({ offer: false }); await tick(); bare.instance.open(); await tick();
  assert.equal(section(bare.panel), undefined);
  bare.instance.dispose();
});

test('a diary day shows its meme as plain text so the user can see what was kept', async () => {
  const { panel, instance } = mount(); await tick(); instance.open(); await tick();
  assert.ok(texts(panel).includes('只属于你们的小事：最后一个布丁'));
  assert.ok(texts(panel).includes('昨天抢布丁没抢到。'));
  instance.dispose();
});
