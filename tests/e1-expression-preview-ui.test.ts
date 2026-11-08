/**
 * E1 entry points: the 「预览：惊喜 / 害羞」 buttons (角色页「心情和反应」, the developer
 * mood panel), the host relay that sends only the closed recipe to every window's stage, and the D2 test commands
 * ("测试：害羞" / "测试：惊喜"), which use the same relay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '../shared/ui-language';
import { ExpressionPreviewButtons, supportText } from '../src/ui/ExpressionPreviewButtons';
import { relayExpressionPreview } from '../electron/expression-preview-host';
import { showSupport, type ShowCapabilities } from '../src/stage/expression-show';
import type { ExpressionPreviewResult, ExpressionRecipe } from '../shared/expression-preview';
import { buildTestEntries } from '../electron/test-commands/entries';
import { matchTestEntry } from '../electron/test-commands/match';
import { fakeTestDeps } from './helpers/test-command-fixtures';

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = ''; title = '';
  disabled = false; hidden = false; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  onclick: (() => void) | null = null; listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  fire(name: string) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  get innerHTML(): string { throw new Error('never markup'); }
  set innerHTML(_value: string) { throw new Error('never markup'); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const button = (root: Element, recipe: ExpressionRecipe) => all(root).find(node => node.dataset.expressionPreview === recipe)!;
const status = (root: Element) => all(root).find(node => node.className === 'expression-preview-status')!;
const flush = () => new Promise(resolve => setImmediate(resolve));
(globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
setUiLanguage('zh-CN');

const all1: ShowCapabilities = { head: true, upperBody: true, eyes: true, lids: true, browUp: true, browSad: true, eyeWide: true, smileEyes: true, mouthSmile: true, mouthOpen: true, blush: true };
const none: ShowCapabilities = Object.fromEntries(Object.keys(all1).map(key => [key, false])) as unknown as ShowCapabilities;

test('buttons: both recipes, on any model they play; the line names what shows and what this model skips', async () => {
  const played: ExpressionRecipe[] = [];
  let capabilities = { ...all1, browUp: false };
  const ui = new ExpressionPreviewButtons({ support: recipe => showSupport(recipe, capabilities),
    play: async recipe => { played.push(recipe); return { sent: true, petVisible: true } satisfies ExpressionPreviewResult; } });
  const root = ui.root as unknown as Element;
  assert.equal(root.attributes.get('role'), 'group');
  assert.deepEqual(all(root).filter(node => node.dataset.expressionPreview).map(node => node.textContent), ['惊喜', '害羞']);
  assert.equal(button(root, 'surprise').disabled, false, 'a model without raised brows still shows the rest');
  button(root, 'surprise').onclick!(); await flush();
  assert.deepEqual(played, ['surprise']);
  assert.equal(status(root).textContent, '惊喜：睁大眼睛、小"o"嘴、头微微后仰、身体往后一靠 · 这个模型没有：眉毛上扬（跳过）');
  // A model with nothing usable: greyed out, with the reason, and a click does nothing.
  capabilities = none; root.fire('pointerenter');
  assert.equal(button(root, 'shy').disabled, true);
  assert.match(button(root, 'shy').title, /找不到能用的头部骨骼和表情/);
  assert.match(status(root).textContent!, /没法预览/);
  button(root, 'shy').onclick!(); await flush();
  assert.deepEqual(played, ['surprise']);
  // The pet hidden: it is said.
  capabilities = all1;
  const hidden = new ExpressionPreviewButtons({ support: recipe => showSupport(recipe, capabilities), play: async () => ({ sent: true, petVisible: false }) });
  button(hidden.root as unknown as Element, 'shy').onclick!(); await flush();
  assert.match(status(hidden.root as unknown as Element).textContent!, /桌宠现在没显示/);
  // English UI reads in English.
  setUiLanguage('en');
  try {
    const english = supportText(showSupport('surprise', { ...all1, mouthOpen: false }));
    assert.match(english, /^Surprise: brows up.+eyes wide.+leans back · Not on this model: a small "o" \(skipped\)$/);
    assert.doesNotMatch(english, /[一-鿿]/u, english);
  }
  finally { setUiLanguage('zh-CN'); }
});

test('a model that loads after the buttons were built: they turn on and the old "还没载入模型" line goes away (real-Electron finding)', () => {
  let loaded = false;
  const ui = new ExpressionPreviewButtons({ support: recipe => showSupport(recipe, loaded ? all1 : null), play: async () => ({ sent: true, petVisible: true }) });
  const root = ui.root as unknown as Element;
  assert.equal(button(root, 'shy').disabled, true); assert.match(status(root).textContent!, /还没载入模型/);
  loaded = true; ui.refresh();
  assert.equal(button(root, 'shy').disabled, false); assert.equal(status(root).textContent, '', 'the stale reason is cleared');
});

test('without a support hook (unknown here) the buttons still ask; with no bridge they say so', async () => {
  const played: ExpressionRecipe[] = [];
  const ui = new ExpressionPreviewButtons({ play: async recipe => { played.push(recipe); return { sent: true, petVisible: true }; } });
  button(ui.root as unknown as Element, 'shy').onclick!(); await flush();
  assert.deepEqual(played, ['shy']); assert.match(status(ui.root as unknown as Element).textContent!, /害羞：已发给桌面上的她/);
  const bare = new ExpressionPreviewButtons({});
  assert.equal(button(bare.root as unknown as Element, 'shy').disabled, true); assert.match(status(bare.root as unknown as Element).textContent!, /这里不能预览/);
});

test('host relay: only the two recipes cross, to every window; the answer says whether the pet can show it', () => {
  const sent: string[] = [];
  const ports = { send: (recipe: ExpressionRecipe) => sent.push(recipe), petVisible: () => true };
  assert.deepEqual(relayExpressionPreview('shy', ports), { sent: true, petVisible: true });
  assert.deepEqual(relayExpressionPreview('surprise', { ...ports, petVisible: () => false }), { sent: true, petVisible: false });
  for (const bad of ['angry', '', null, 1, { recipe: 'shy' }, ['shy'], 'shy '] as unknown[]) assert.throws(() => relayExpressionPreview(bad, ports), /预览类型不正确/);
  assert.deepEqual(sent, ['shy', 'surprise']);
});

test('D2: "测试：害羞" / "测试：惊喜" (and the old 试作 words) reach the same relay', async () => {
  const { deps, calls } = fakeTestDeps();
  const built = buildTestEntries(deps);
  for (const [said, id] of [['害羞', 'E1.shy'], ['害羞试作', 'E1.shy'], ['惊喜试作', 'E1.surprise'], ['预览惊喜', 'E1.surprise']] as const) {
    const match = matchTestEntry(built.entries, said);
    assert.equal(match.kind === 'entry' ? match.entry.id : match.kind, id, said);
  }
  const shy = built.entries.find(entry => entry.id === 'E1.shy')!;
  assert.match(String(await shy.run({ note() {} })), /已让她害羞一次/);
  assert.deepEqual(calls, ['expression.play:shy']);
  built.dispose();
});
