import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_SCREEN_SHARING_OPTIONS,
  SCREEN_LOOK_HINT,
  ScreenSharingOptions,
  type ScreenSharingOptionsPatch,
  type ScreenSharingOptionsState,
} from "../src/ui/ScreenSharingOptions";

class ElementMock {
  className = ""; textContent = ""; id = ""; type = ""; value = "";
  min = ""; max = ""; step = ""; inputMode = "";
  checked = false; disabled = false; hidden = false; required = false;
  dataset: Record<string, string> = {};
  children: ElementMock[] = [];
  attributes = new Map<string, string>();
  validationMessage = "";
  parent: ElementMock | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  append(...children: ElementMock[]) {
    for (const child of children) { this.children.push(child); child.parent = this; }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  setCustomValidity(value: string) { this.validationMessage = value; }
}

function environment(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new ElementMock() } });
  const parent = new ElementMock(), changes: ScreenSharingOptionsPatch[] = [];
  const controls = new ScreenSharingOptions(parent as unknown as HTMLElement, value => { changes.push(value); });
  const root = parent.children[0];
  const find = (predicate: (element: ElementMock) => boolean, node = root): ElementMock | undefined =>
    predicate(node) ? node : node.children.map(child => find(predicate, child)).find(Boolean);
  const field = (key: string): ElementMock => {
    const result = find(node => node.dataset.screenOption === key);
    assert.ok(result, `missing ${key}`); return result;
  };
  const state = (patch: Partial<ScreenSharingOptionsState>) => controls.update({ ...DEFAULT_SCREEN_SHARING_OPTIONS, ...patch });
  t.after(() => {
    controls.dispose();
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  return { parent, root, controls, changes, field, state, find };
}

test("screen options start hidden and reveal only for enabled sharing; R09 自动截图 has no control any more", t => {
  const ui = environment(t);
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.find(node => node.dataset.screenOption === "autoCapture"), undefined, "no automatic snapshot switch");
  assert.equal(ui.find(node => node.dataset.screenOption === "intervalSeconds"), undefined, "no interval");
  assert.deepEqual(ui.changes, []);

  ui.state({ screenSharing: true, autoCapture: true, intervalSeconds: 3 }); // an old host state is shown as nothing more
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.find(node => node.className === "screen-sharing-options-screen")!.hidden, false);
  assert.equal(ui.field("lookHint").textContent, SCREEN_LOOK_HINT);
  assert.match(SCREEN_LOOK_HINT, /叫她看/u);
  assert.match(SCREEN_LOOK_HINT, /不保存/u);
  assert.deepEqual(ui.changes, []);
});

test("camera-only sharing exposes the proactive choice without the screen hint", t => {
  const ui = environment(t);
  ui.state({ cameraSharing: true });
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.find(node => node.className === "screen-sharing-options-screen")!.hidden, true);
  ui.field("proactiveVision").checked = false;
  ui.field("proactiveVision").onchange?.();
  assert.deepEqual(ui.changes, [{ proactiveVision: false }]);
  ui.field("proactiveVision").onchange?.();
  assert.deepEqual(ui.changes, [{ proactiveVision: false }], "an unchanged value sends nothing");
});

test("with sharing off the proactive choice is disabled and sends nothing", t => {
  const ui = environment(t);
  ui.state({ screenSharing: true, proactiveVision: true });
  ui.state({});
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.field("proactiveVision").disabled, true);
  ui.field("proactiveVision").checked = false;
  ui.field("proactiveVision").onchange?.();
  assert.deepEqual(ui.changes, []);
});

test("disposing removes only this component and invalidates captured event callbacks", t => {
  const ui = environment(t), sibling = new ElementMock();
  ui.parent.append(sibling);
  ui.state({ screenSharing: true });
  const proactive = ui.field("proactiveVision");
  const oldProactive = proactive.onchange!;
  ui.controls.dispose(); ui.controls.dispose();
  assert.deepEqual(ui.parent.children, [sibling]);
  proactive.checked = false;
  oldProactive();
  ui.controls.update({ ...DEFAULT_SCREEN_SHARING_OPTIONS, screenSharing: true });
  assert.deepEqual(ui.changes, []);
  assert.equal(proactive.onchange, null);
});

test('English sharing controls: the label and the new hint are translated', t => {
  registerUiMessages({ en: ENGLISH_SETTINGS_UI_COPY, 'zh-CN': {} }); setUiLanguage('en'); t.after(() => setUiLanguage('zh-CN'));
  const ui = environment(t);
  assert.equal(ui.root.attributes.get('aria-label'), 'Visual sharing options');
  assert.doesNotMatch(ui.field('lookHint').textContent, /[\u4e00-\u9fff]/u);
  assert.deepEqual(ui.changes, []);
});
