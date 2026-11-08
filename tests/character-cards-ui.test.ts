import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterCards } from '../src/ui/CharacterCards';
import { defaultCharacterMoodTemplate, validateCharacterDraft, type CharacterCard, type CharacterCardState, type CharacterDraft, type CharacterMoodTemplate } from '../shared/character-cards';
import type { DesktopAPI } from '../shared/contracts';
import { emptyLanguageProfile } from '../shared/personalize-language';
import { defaultCharacterResponseProfile, defaultCharacterResponseRule, type CharacterResponseProfile, type CharacterResponseState } from '../shared/character-response';

// Text/action-only fixture. The real editor owns all draft, validation, consent,
// broadcast and save behavior; no browser, service or normal profile is started.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; disabled = false; checked = false; hidden = false;
  dataset: Record<string, string> = {};
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onchange: (() => void) | null = null;
  readonly classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
    toggle: (name: string, enabled?: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      if (enabled ?? !names.has(name)) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return names.has(name);
    },
  };
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]): void { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes: Element[]): void { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  setAttribute(_name: string, _value: string): void {}
  focus(): void {}
  click(): void { assert.equal(this.disabled, false, `${this.id || this.textContent} should be enabled`); this.onclick?.(); }
}
class TextArea extends Element { constructor() { super('textarea'); } }
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
function field(root: Element, id: string): Element { const node = all(root).find(item => item.id === id); assert.ok(node, `#${id}`); return node; }
function type(root: Element, id: string, value: string): void { const node = field(root, id); node.value = value; node.oninput?.(); }
function change(root: Element, id: string, value: string): void { const node = field(root, id); node.value = value; node.onchange?.(); }
function mood(root: Element): CharacterMoodTemplate { return JSON.parse(field(root, 'character-mood-template').value); }
async function flush(): Promise<void> { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); }
const card = (id = 'gene', name = 'Gene', template = defaultCharacterMoodTemplate()): CharacterCard => ({ id, name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: 'Literal persona only', mood: template });

type CardBridge = Pick<DesktopAPI, 'onCharacterCards' | 'getCharacterCards' | 'saveCharacterCard' | 'requestCharacterRealerEmotions' | 'activateCharacterCard' | 'deleteCharacterCard' | 'bindCharacterModel' | 'importCharacterCard' | 'exportCharacterCard' | 'getCharacterResponse' | 'saveCharacterResponse' | 'copyCharacterResponse' | 'onCharacterResponse' | 'getPersonalizeLanguage' | 'savePersonalizeLanguage' | 'undoPersonalizeLanguage' | 'onPersonalizeLanguage' | 'openLanguageAuthoring' | 'researchLanguage' | 'cancelLanguageAuthoring' | 'closeLanguageAuthoring'>;
type VisualCardBridge=Pick<DesktopAPI,'getVisualAuthoring'|'chooseVisualMaterial'|'researchVisual'|'previewVisualBinding'|'visualPreviewReceipt'|'saveVisualBehavior'|'changeVisualBehavior'|'cancelVisualAuthoring'|'onVisualPreviewCancelled'|'getBodyAuthoring'|'chooseBodyMaterial'|'researchBody'|'discardBodyAdvice'|'consumeBodyAdvice'|'previewBodyBinding'|'previewFixedBodyBinding'|'bodyPreviewReceipt'|'saveBodyBehavior'|'changeBodyBehavior'|'cancelBodyAuthoring'|'onBodyPreviewCancelled'>;
function fixture(initial: CharacterCard = card(), imported: CharacterCard | null = null) {
  const originals = new Map(['document', 'window', 'HTMLTextAreaElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const root = new Element('div'), errors: string[] = [], confirmations: string[] = [], answers: boolean[] = [];
  const saves: { draft: CharacterDraft; id?: string }[] = [], activations: string[] = [];
  // F6: the host asks the user first; `realerAnswers` is what the user picks in that dialog (true: 我知道了，打开).
  const realerRequests: Array<[string, boolean]> = [], realerAnswers: boolean[] = [];
  let stored: CharacterCardState = { cards: [structuredClone(initial)], activeId: initial.id, revision: 1 };
  let callback: ((state: CharacterCardState) => void) | undefined;
  let responseCallback: ((state: CharacterResponseState) => void) | undefined;
  const responses = new Map<string, CharacterResponseProfile>();
  const responseCopies: { sourceId: string; targetId: string }[] = [], responseSaves: string[] = [], copyErrors: Error[] = [];
  const copyWaiters: Promise<void>[] = [];
  let responseRevision = 0;
  const responseState = (id: string): CharacterResponseState => ({ characterId: id, revision: responseRevision, profile: structuredClone(responses.get(id) ?? defaultCharacterResponseProfile()) });
  let unsubscribed = false;
  const publish = () => { stored.revision = (stored.revision ?? 0) + 1; callback?.(structuredClone(stored)); return structuredClone(stored); };
  const api: CardBridge & VisualCardBridge = {
    async getVisualAuthoring(){throw Error('Legacy card fixture must not open visual authoring');},
    async chooseVisualMaterial(){throw Error('Legacy card fixture must not choose images');},
    async researchVisual(){throw Error('Legacy card fixture must not submit images');},
    async previewVisualBinding(){throw Error('Legacy card fixture must not preview visual recipes');},
    async visualPreviewReceipt(){throw Error('Legacy card fixture must not acknowledge visual preview');},
    async saveVisualBehavior(){throw Error('Legacy card fixture must not save visual mapping');},
    async changeVisualBehavior(){throw Error('Legacy card fixture must not change visual mapping');},
    async cancelVisualAuthoring(){},onVisualPreviewCancelled(){return()=>{};},
    async getBodyAuthoring(){throw Error('Legacy card fixture must not open body authoring');},
    async chooseBodyMaterial(){throw Error('Legacy card fixture must not choose body images');},
    async researchBody(){throw Error('Legacy card fixture must not submit body images');},
    async discardBodyAdvice(){throw Error('Legacy card fixture must not discard body advice');},
    async consumeBodyAdvice(){throw Error('Legacy card fixture must not consume body advice');},
    async previewBodyBinding(){throw Error('Legacy card fixture must not preview body poses');},
    async previewFixedBodyBinding(){throw Error('Legacy card fixture must not preview body poses');},
    async bodyPreviewReceipt(){throw Error('Legacy card fixture must not acknowledge body preview');},
    async saveBodyBehavior(){throw Error('Legacy card fixture must not save body mapping');},
    async changeBodyBehavior(){throw Error('Legacy card fixture must not change body mapping');},
    async cancelBodyAuthoring(){},onBodyPreviewCancelled(){return()=>{};},
    async openLanguageAuthoring() { throw Error('Legacy card fixture must not open research'); },
    async researchLanguage() { throw Error('Legacy card fixture must not research'); },
    async cancelLanguageAuthoring() {}, async closeLanguageAuthoring() {},
    async getPersonalizeLanguage(id) { return { characterId: id, revision: 0, profile: emptyLanguageProfile() }; },
    async savePersonalizeLanguage() { throw Error('Legacy card fixture must not save language rules'); },
    async undoPersonalizeLanguage() { throw Error('Legacy card fixture must not undo language rules'); },
    onPersonalizeLanguage() { return () => {}; },
    onCharacterCards(handler) { callback = handler; return () => { callback = undefined; unsubscribed = true; }; },
    async getCharacterCards() { return structuredClone(stored); },
    async saveCharacterCard(value, id) {
      const normalized = validateCharacterDraft(value); saves.push({ draft: structuredClone(normalized), ...(id ? { id } : {}) });
      if (id) stored.cards = stored.cards.map(item => item.id === id ? { ...item, ...normalized } : item);
      else stored.cards.push({ id: `copy-${stored.cards.length}`, ...normalized, mood: normalized.mood ?? defaultCharacterMoodTemplate() });
      return publish();
    },
    async activateCharacterCard(id) { activations.push(id); stored.activeId = id; return publish(); },
    async requestCharacterRealerEmotions(id, value) {
      realerRequests.push([id, value]);
      if (value && !(realerAnswers.shift() ?? false)) return structuredClone(stored);
      stored.cards = stored.cards.map(item => { if (item.id !== id) return item; const { realerEmotions: _old, ...rest } = item; return value ? { ...rest, realerEmotions: true } : rest; });
      return publish();
    },
    async importCharacterCard() { if (!imported) return null; stored.cards.push(structuredClone(imported)); return publish(); },
    async deleteCharacterCard(id) { stored.cards = stored.cards.filter(item => item.id !== id); if (stored.activeId === id) stored.activeId = stored.cards[0].id; return publish(); },
    async bindCharacterModel() { return publish(); },
    async exportCharacterCard() { return true; },
    async getCharacterResponse(id) { return responseState(id); },
    async saveCharacterResponse(id, profile) { responseSaves.push(id); responses.set(id, structuredClone(profile)); responseRevision++; const state = responseState(id); responseCallback?.(state); return state; },
    async copyCharacterResponse(sourceId, targetId) {
      responseCopies.push({ sourceId, targetId }); const failure = copyErrors.shift(); if (failure) throw failure;
      const waiter = copyWaiters.shift(); if (waiter) await waiter;
      responses.set(targetId, structuredClone(responses.get(sourceId) ?? defaultCharacterResponseProfile())); responseRevision++;
      const state = responseState(targetId); responseCallback?.(state); return state;
    },
    onCharacterResponse(handler) { responseCallback = handler; return () => { responseCallback = undefined; }; },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: (tag: string) => tag === 'textarea' ? new TextArea() : new Element(tag) } });
  Object.defineProperty(globalThis, 'HTMLTextAreaElement', { configurable: true, writable: true, value: TextArea });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { desktop: api, confirm: (message: string) => { confirmations.push(message); return answers.shift() ?? true; } } });
  const ui = new CharacterCards(root as unknown as HTMLElement, { onError: message => errors.push(message) });
  return {
    ui, root, errors, saves, activations, confirmations, answers, realerRequests, realerAnswers, responseCopies, responseSaves, copyErrors, copyWaiters,
    setResponse(id: string, profile: CharacterResponseProfile) { responses.set(id, structuredClone(profile)); responseRevision++; responseCallback?.(responseState(id)); },
    state: () => structuredClone(stored),
    broadcast(next: CharacterCardState) { stored = structuredClone(next); callback?.(structuredClone(next)); },
    get unsubscribed() { return unsubscribed; },
    restore() { ui.dispose(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test('basic parameters and blush controls survive copy, save, activation and effective readback without entering persona text', async () => {
  const f = fixture();
  try {
    await f.ui.init();
    change(f.root, 'character-mood-sensitivity-O', '1.2');
    change(f.root, 'character-mood-baseline-O', '60');
    change(f.root, 'character-mood-half-life-O', '60');
    field(f.root, 'character-blush-enabled').checked = false; field(f.root, 'character-blush-enabled').onchange?.();
    type(f.root, 'character-blush-intensity', '72');
    type(f.root, 'character-blush-size', '64');
    field(f.root, 'character-duplicate').click();
    const copied = mood(f.root);
    assert.equal(copied.parameters.sensitivity.O, 1.2); assert.equal(copied.parameters.baseline.O, 60);
    assert.equal(copied.parameters.halfLifeMs.O, 60 * 60_000);
    assert.equal(copied.parameters.blush.enabled, false); assert.equal(copied.parameters.blush.intensity, 72);
    assert.equal(copied.parameters.blush.size, 64);
    assert.equal(field(f.root, 'persona').value, 'Literal persona only');
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 1); assert.equal(f.saves[0].id, undefined);
    assert.deepEqual(f.saves[0].draft.mood, copied);
    assert.equal(f.state().activeId, 'gene'); assert.equal(f.saves[0].draft.systemPrompt, 'Literal persona only');
    assert.deepEqual(mood(f.root), f.state().cards.at(-1)!.mood);
    field(f.root, 'character-save-activate').click(); await flush();
    assert.equal(f.state().activeId, 'copy-1'); assert.deepEqual(f.activations, ['copy-1']);
    assert.equal(f.confirmations.length, 0); assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('complete JSON edits retain advanced fields when easy blush controls are used and save validated canonical templates', async () => {
  const f = fixture();
  try {
    await f.ui.init(); const edited = mood(f.root);
    edited.parameters.frequency.speechIntervalMs = 45 * 60_000;
    edited.parameters.longing.graceMs = 8 * 3_600_000;
    edited.parameters.weights.close = 1.3;
    edited.parameters.blush.fadeMs = 2400;
    edited.parameters.blush.intensity = 41;
    edited.parameters.blush.size = 75;
    type(f.root, 'character-mood-template', JSON.stringify(edited));
    assert.equal(field(f.root, 'character-blush-intensity').value, '41');
    assert.equal(field(f.root, 'character-blush-size').value, '75');
    field(f.root, 'character-blush-enabled').checked = false; field(f.root, 'character-blush-enabled').onchange?.();
    field(f.root, 'character-save').click(); await flush();
    const saved = f.saves[0].draft.mood!.parameters;
    assert.equal(saved.frequency.speechIntervalMs, 45 * 60_000); assert.equal(saved.longing.graceMs, 8 * 3_600_000);
    assert.equal(saved.weights.close, 1.3); assert.equal(saved.blush.fadeMs, 2400); assert.equal(saved.blush.enabled, false);
    assert.equal(saved.blush.size, 75);
    assert.deepEqual(mood(f.root).parameters, saved);
    assert.equal(field(f.root, 'persona').value.includes('parameters'), false);
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('熟悉度: "关系慢慢升温" is unchecked for a card without it, follows the selected card, and saves exactly what is shown', async () => {
  const f = fixture(card());
  try {
    await f.ui.init();
    assert.equal(field(f.root, 'character-slow-warm-up').checked, false, 'older cards read as off');
    type(f.root, 'character-greeting', '嗨');
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves[0].draft.slowWarmUp, false);
    field(f.root, 'character-slow-warm-up').checked = true; field(f.root, 'character-slow-warm-up').onchange?.();
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves[1].draft.slowWarmUp, true, 'ticked and saved');
    assert.equal(field(f.root, 'persona').value.includes('升温'), false, 'it is a card setting, not persona text');
    field(f.root, 'character-duplicate').click();
    assert.equal(field(f.root, 'character-slow-warm-up').checked, true, 'a copy keeps the switch');
    field(f.root, 'character-slow-warm-up').checked = false; field(f.root, 'character-slow-warm-up').onchange?.();
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves[2].draft.slowWarmUp, false);
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('F6 "更真实的情绪": off by default, ticking asks the host (which explains first), declining leaves it off, the box shows the saved value, an unsaved card cannot', async () => {
  const f = fixture(card());
  try {
    await f.ui.init();
    const box = () => field(f.root, 'character-realer-emotions');
    assert.equal(box().checked, false, 'older cards read as off');
    box().checked = true; box().onchange?.(); await flush();
    assert.deepEqual(f.realerRequests, [['gene', true]]);
    assert.equal(box().checked, false, 'declined in the dialog: still off');
    assert.equal(f.state().cards[0].realerEmotions, undefined);
    f.realerAnswers.push(true);
    box().checked = true; box().onchange?.(); await flush();
    assert.equal(f.state().cards[0].realerEmotions, true);
    assert.equal(box().checked, true);
    // Editing her text and saving keeps the switch out of the draft (the host keeps the saved value).
    type(f.root, 'character-greeting', '嗨');
    field(f.root, 'character-save').click(); await flush();
    assert.equal(Object.hasOwn(f.saves[0].draft, 'realerEmotions'), false, 'the switch is never part of the draft');
    box().checked = false; box().onchange?.(); await flush();
    assert.deepEqual(f.realerRequests.at(-1), ['gene', false]);
    assert.equal(f.state().cards[0].realerEmotions, undefined, 'off at once, no dialog');
    // A new, unsaved card: the box is off and disabled.
    field(f.root, 'character-new').click();
    assert.equal(box().checked, false); assert.equal(box().disabled, true);
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('malformed JSON and runtime/private fields are rejected before any save IPC and valid edits recover the controls', async () => {
  const f = fixture();
  try {
    await f.ui.init();
    type(f.root, 'character-mood-template', '{not complete');
    assert.equal(field(f.root, 'character-blush-enabled').disabled, true);
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 0); assert.equal(f.errors.length, 1);
    const invalid = { ...defaultCharacterMoodTemplate(), runtimeValues: { D: 100 } };
    type(f.root, 'character-mood-template', JSON.stringify(invalid));
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 0); assert.equal(f.errors.length, 2);
    type(f.root, 'character-mood-template', JSON.stringify(defaultCharacterMoodTemplate()));
    assert.equal(field(f.root, 'character-blush-enabled').disabled, false);
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 1);
  } finally { f.restore(); }
});

test('new extended values require explained confirmation and cancellation preserves the unsaved template', async () => {
  const f = fixture();
  try {
    await f.ui.init(); change(f.root, 'character-mood-sensitivity-O', '2');
    f.answers.push(false); field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 0); assert.equal(mood(f.root).parameters.sensitivity.O, 2);
    assert.ok(f.confirmations[0].includes('O 事件敏感度') && f.confirmations[0].includes('1倍 → 2倍'));
    f.answers.push(true); field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 1); assert.equal(f.confirmations.length, 2);
    type(f.root, 'character-description', 'Only a text edit'); field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 2); assert.equal(f.confirmations.length, 2, 'unchanged accepted range is not reconfirmed');
    field(f.root, 'character-duplicate').click(); field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.at(-1)!.draft.mood!.parameters.sensitivity.O, 2);
    assert.equal(f.confirmations.length, 2, 'copy preserves already accepted template choices');
  } finally { f.restore(); }
});

test('dirty text and numeric drafts survive newer host broadcasts and save their actual visible values', async () => {
  const f = fixture();
  try {
    await f.ui.init();
    type(f.root, 'character-name', 'Unsaved name'); change(f.root, 'character-mood-sensitivity-O', '1.4');
    const changed = f.state(); changed.revision = 5; changed.cards[0].name = 'Host name'; changed.cards[0].mood!.parameters.sensitivity.O = 0.8;
    f.broadcast(changed);
    assert.equal(field(f.root, 'character-name').value, 'Unsaved name');
    assert.equal(mood(f.root).parameters.sensitivity.O, 1.4); assert.equal(f.saves.length, 0);
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves[0].draft.name, 'Unsaved name'); assert.equal(f.saves[0].draft.mood!.parameters.sensitivity.O, 1.4);
    assert.deepEqual(mood(f.root), f.state().cards[0].mood);
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('imported numeric cards remain inactive, expose their template and review extended values before first activation', async () => {
  const template = defaultCharacterMoodTemplate(); template.parameters.sensitivity.O = 2.2;
  const f = fixture(card(), card('imported', 'Imported numeric', template));
  try {
    await f.ui.init(); field(f.root, 'character-import').click(); await flush();
    assert.equal(f.state().activeId, 'gene'); assert.deepEqual(f.activations, []);
    assert.equal(mood(f.root).parameters.sensitivity.O, 2.2);
    assert.equal(field(f.root, 'character-name').value, 'Imported numeric');
    f.answers.push(false); field(f.root, 'character-save-activate').click(); await flush();
    assert.deepEqual(f.activations, []); assert.equal(f.saves.length, 0);
    f.answers.push(true); field(f.root, 'character-save-activate').click(); await flush();
    assert.equal(f.state().activeId, 'imported'); assert.deepEqual(f.activations, ['imported']);
    type(f.root, 'character-description', 'Edit after acceptance'); field(f.root, 'character-save').click(); await flush();
    assert.equal(f.confirmations.length, 2, 'accepted import is not reconfirmed on unrelated edits');
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('restoring Gene and creating a new card change only the draft until save and never copy the old instance', async () => {
  const initial = card(); initial.mood!.parameters.sensitivity.O = 1.4;
  const f = fixture(initial);
  try {
    await f.ui.init(); field(f.root, 'character-mood-gene').click();
    assert.equal(mood(f.root).parameters.sensitivity.O, 1);
    assert.equal(f.state().cards[0].mood!.parameters.sensitivity.O, 1.4);
    assert.equal(field(f.root, 'persona').value, 'Literal persona only'); assert.equal(f.saves.length, 0);
    field(f.root, 'character-new').click();
    assert.equal(field(f.root, 'character-name').value, '新角色');
    assert.equal(field(f.root, 'persona').value, ''); assert.deepEqual(mood(f.root), defaultCharacterMoodTemplate());
    assert.equal(f.state().activeId, 'gene'); assert.equal(f.activations.length, 0);
    f.ui.dispose(); assert.equal(f.unsubscribed, true);
  } finally { f.restore(); }
});

test('an invalid visible shortcut value cannot silently save the previous JSON value', async () => {
  const f = fixture();
  try {
    await f.ui.init(); change(f.root, 'character-mood-baseline-O', '4');
    assert.equal(field(f.root, 'character-mood-baseline-O').value, '4');
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 0);
    assert.ok(f.errors.at(-1)?.includes('快捷数值控件'));
    change(f.root, 'character-mood-baseline-O', '55');
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 1); assert.equal(f.saves[0].draft.mood!.parameters.baseline.O, 55);
  } finally { f.restore(); }
});

test('blush size and intensity remain independent through zero, save and readback', async () => {
  const f = fixture();
  try {
    await f.ui.init();
    type(f.root, 'character-blush-size', '0');
    assert.equal(mood(f.root).parameters.blush.intensity, 35);
    assert.equal(mood(f.root).parameters.blush.enabled, true);
    type(f.root, 'character-blush-intensity', '70');
    assert.equal(mood(f.root).parameters.blush.size, 0);
    field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves[0].draft.mood!.parameters.blush.size, 0);
    assert.equal(f.saves[0].draft.mood!.parameters.blush.intensity, 70);
    assert.equal(field(f.root, 'character-blush-size').value, '0');
    assert.equal(field(f.root, 'character-blush-intensity').value, '70');
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test('ordinary card saves keep response templates separate and duplication captures the original source ID', async () => {
  const f = fixture();
  try {
    const profile: CharacterResponseProfile = { version: 1, rules: [defaultCharacterResponseRule({ mood: 'happy' })] };
    profile.rules[0].intensityScale.expression = 1.3; f.setResponse('gene', profile);
    await f.ui.init(); await flush();
    type(f.root, 'character-description', 'Ordinary persona edit'); clickSaved(); await flush();
    assert.equal(f.responseSaves.length, 0); assert.equal(f.responseCopies.length, 0);
    field(f.root, 'character-duplicate').click();
    const next = f.state(); next.cards.push(card('other', 'Other')); next.activeId = 'other'; next.revision = 9; f.broadcast(next);
    clickSaved(); await flush();
    assert.deepEqual(f.responseCopies, [{ sourceId: 'gene', targetId: 'copy-2' }]);
    assert.equal(f.state().cards.length, 3); assert.equal(f.state().activeId, 'other');
    assert.equal(f.responseSaves.length, 0);
    function clickSaved() { field(f.root, 'character-save').click(); }
  } finally { f.restore(); }
});

test('failed response copies preserve the newly created card and retry only its sidecar', async () => {
  const f = fixture();
  try {
    await f.ui.init(); await flush(); f.copyErrors.push(new Error('sidecar locked'));
    field(f.root, 'character-duplicate').click(); field(f.root, 'character-save').click(); await flush();
    assert.equal(f.saves.length, 1); assert.equal(f.state().cards.length, 2);
    assert.equal(f.state().cards[1].id, 'copy-1'); assert.equal(f.state().activeId, 'gene');
    assert.equal(field(f.root, 'character-retry-response-copy').hidden, false);
    assert.match(field(f.root, 'character-status').textContent, /角色卡已保存/);
    field(f.root, 'character-retry-response-copy').click(); await flush();
    assert.equal(f.saves.length, 1, 'retry does not create a second base card');
    assert.deepEqual(f.responseCopies, [{ sourceId: 'gene', targetId: 'copy-1' }, { sourceId: 'gene', targetId: 'copy-1' }]);
    assert.equal(field(f.root, 'character-retry-response-copy').hidden, true);
    assert.equal(f.responseSaves.length, 0);
  } finally { f.restore(); }
});

test('a late duplicate response copy cannot reactivate its target after an external character switch', async () => {
  const f = fixture(); let finish!: () => void;
  try {
    await f.ui.init(); await flush(); f.copyWaiters.push(new Promise<void>(resolve => { finish = resolve; }));
    field(f.root, 'character-duplicate').click(); field(f.root, 'character-save-activate').click(); await flush();
    assert.deepEqual(f.responseCopies, [{ sourceId: 'gene', targetId: 'copy-1' }]);
    const next = f.state(); next.cards.push(card('other', 'Other')); next.activeId = 'other'; next.revision = 10; f.broadcast(next);
    finish(); await flush();
    assert.deepEqual(f.activations, []); assert.equal(f.state().activeId, 'other');
    assert.equal(field(f.root, 'character-name').value, 'Other'); assert.equal(f.saves.length, 1);
  } finally { finish?.(); f.restore(); }
});
