// (docs/claude/2026-11-24-unsaved-sign.md): a page with an unsaved edit shows "未保存",
// a line that points at its save button and the button lit; saving or reverting clears all three; the voice page's Drama 3 monthly limit
// shows it; a page that applies at once never uses it; leaving a page or closing the window says so once and never blocks.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { announceUnsaved, attachUnsavedSign, rearmUnsavedAnnouncements, unsavedPages } from '../src/foundation/unsaved-sign';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';
import { EmotionalVoiceControls } from '../src/voice/EmotionalVoice';

class El {
  id = ''; textContent = ''; className = ''; value = ''; type = ''; placeholder = '';
  hidden = false; disabled = false; autocomplete = ''; spellcheck = true; maxLength = 0; rows = 0; min = ''; max = ''; step = '';
  dataset: Record<string, string> = {}; children: El[] = []; parentElement: El | null = null;
  attributes = new Map<string, string>(); classes = new Set<string>();
  onclick: (() => void) | null = null; onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  readonly classList = { add: (name: string) => { this.classes.add(name); }, toggle: (name: string, on?: boolean) => { if (on ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); }, remove: (name: string) => { this.classes.delete(name); } };
  get firstChild(): El | null { return this.children[0] ?? null; }
  get nextSibling(): El | null { const list = this.parentElement?.children ?? []; return list[list.indexOf(this) + 1] ?? null; }
  append(...kids: El[]) { for (const kid of kids) { kid.remove(); kid.parentElement = this; this.children.push(kid); } }
  replaceChildren(...kids: El[]) { for (const kid of this.children) kid.parentElement = null; this.children = []; this.append(...kids); }
  insertBefore(kid: El, before: El | null) { kid.remove(); kid.parentElement = this; const at = before ? this.children.indexOf(before) : -1; if (at < 0) this.children.push(kid); else this.children.splice(at, 0, kid); }
  remove() { if (!this.parentElement) return; this.parentElement.children = this.parentElement.children.filter(kid => kid !== this); this.parentElement = null; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  focus() {}
}
const all = (node: El): El[] => [node, ...node.children.flatMap(all)];
const withDom = (t: TestContext) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new El() } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); });
};
const signLine = (root: El) => all(root).find(item => item.className === 'unsaved-sign');
const badges = (root: El) => all(root).filter(item => item.className === 'unsaved-badge');

test('an unsaved edit shows the sign, points at the save button and lights it; clean clears all three', t => {
  withDom(t);
  const host = new El(), row = new El(), save = new El(), field = new El();
  save.textContent = '保存这页'; row.append(save); host.append(field, row);
  const sign = attachUnsavedSign({ saveButton: save as never, page: '语音' });
  const line = () => signLine(host);
  assert.equal(line(), undefined, 'nothing is shown before an edit');
  sign.update(true, [field as never]);
  assert.ok(line() && !line()!.hidden);
  assert.match(line()!.textContent, /^未保存 · .*「保存这页」/);
  assert.ok(save.classes.has('unsaved-save')); assert.equal(save.attributes.get('data-unsaved'), 'true');
  assert.equal(badges(host).length, 1); assert.equal(badges(host)[0].textContent, '未保存'); assert.equal(field.children[0], badges(host)[0]);
  assert.deepEqual(unsavedPages(), ['语音']);
  assert.equal(host.children.indexOf(line()!) + 1, host.children.indexOf(row), 'the line sits right above the save button row');
  sign.update(true, [field as never]); assert.equal(badges(host).length, 1, 'a second report does not add a second badge');
  sign.update(false);
  assert.ok(line()!.hidden); assert.equal(line()!.textContent, '');
  assert.ok(!save.classes.has('unsaved-save')); assert.equal(save.attributes.has('data-unsaved'), false);
  assert.equal(badges(host).length, 0); assert.deepEqual(unsavedPages(), []);
  sign.dispose();
});

test('leaving a page says it once per unsaved page and never blocks; the window coming back may say it again once', t => {
  withDom(t);
  const host = new El(), row = new El(), save = new El(); row.append(save); host.append(row);
  const sign = attachUnsavedSign({ saveButton: save as never, page: '语音' });
  const said: string[] = [];
  assert.equal(announceUnsaved(text => said.push(text)), null);
  sign.update(true);
  assert.match(announceUnsaved(text => said.push(text))!, /语音.*没保存/);
  assert.equal(announceUnsaved(text => said.push(text)), null, 'once');
  rearmUnsavedAnnouncements();
  assert.ok(announceUnsaved(text => said.push(text)), 'again after the window was closed');
  sign.update(false); sign.update(true);
  assert.ok(announceUnsaved(text => said.push(text)), 'a new unsaved stretch is announced again');
  assert.equal(said.length, 3);
  sign.dispose();
});

test('voice page: a Drama 3 monthly limit typed and not saved shows the sign at that field; saving clears it', async t => {
  withDom(t);
  const container = new El();
  let config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'fish' }, context = 'card-a:model-a';
  const controls = new EmotionalVoiceControls(container as never, {
    getConfig: () => structuredClone(config), getContextKey: () => context, getContextLabel: () => context,
    async onChange(value: TtsConfig) { config = { ...value }; }, async onPreview() {}, onStop() {}, onError() {}, onFirstUse() {},
    onOpenConsole() {}, onOpenGuide() {},
  } as never);
  t.after(() => controls.dispose());
  const byId = (id: string) => all(container).find(item => item.id === id)!;
  assert.equal(signLine(container)?.hidden ?? true, true, 'untouched: no sign');
  assert.equal(badges(container).length, 0);
  const cap = byId('tts-fish-cap'); cap.value = '12'; cap.oninput?.();
  const line = signLine(container)!;
  assert.ok(line && !line.hidden, 'an unsaved monthly limit shows the line');
  assert.match(line.textContent, /保存语音配置/);
  assert.ok(byId('tts-save').classes.has('unsaved-save'));
  assert.equal(badges(container).length, 1); assert.equal(badges(container)[0].parentElement, cap.parentElement, 'the badge sits on the monthly-limit row');
  byId('tts-save').onclick?.();
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(config.fishMonthlyCapUsd, 12, 'what is saved is unchanged by the sign');
  assert.ok(line.hidden); assert.equal(badges(container).length, 0); assert.ok(!byId('tts-save').classes.has('unsaved-save'));
  // Reverting (the character or model changed, so the unsaved fields are re-read) clears it too.
  cap.value = '30'; cap.oninput?.(); assert.ok(!line.hidden);
  context = 'card-b:model-b'; controls.refresh();
  assert.ok(line.hidden); assert.equal(badges(container).length, 0);
});

test('only pages with an explicit save button use the sign; a page that applies at once never does', () => {
  const used: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) {
    const path = join(dir, name); if (statSync(path).isDirectory()) { walk(path); continue; }
    if (/\.ts$/.test(name) && /attachUnsavedSign\(/.test(readFileSync(path, 'utf8')) && !path.endsWith('unsaved-sign.ts')) used.push(path.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'));
  } };
  walk(join(process.cwd(), 'src'));
  assert.deepEqual(used.sort(), [
    'src/cards/CharacterCards.ts', 'src/cards/CharacterResponseControls.ts', 'src/cards/CharacterVoiceControls.ts', 'src/cards/PersonalizeLanguageControls.ts',
    'src/mood/BlushCalibrationControls.ts', 'src/mood/MoodPanel.ts', 'src/stage/SingleEmojiControls.ts', 'src/voice/EmotionalVoice.ts',
  ]);
});
