import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterResponseControls, type CharacterResponseBridge } from '../src/ui/CharacterResponseControls';
import {
  CHARACTER_RESPONSE_MOODS, defaultCharacterResponseProfile, defaultCharacterResponseRule, type CharacterResponseProfile, type CharacterResponseState,
} from '../shared/character-response';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';

class Element {
  children: Element[] = [];
  id = ''; className = ''; textContent = ''; value = ''; disabled = false; hidden = false;
  onclick: (() => void) | null = null; oninput: (() => void) | null = null; onchange: (() => void) | null = null;
  attributes = new Map<string, string>();
  readonly classList = { toggle: (name: string, enabled: boolean) => { const classes = new Set(this.className.split(' ')); if (enabled) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); } };
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const get = (root: Element, id: string) => { const found = all(root).find(node => node.id === id); assert.ok(found, `#${id}`); return found; };
const click = (root: Element, id: string) => { const node = get(root, id); assert.equal(node.disabled, false, `${id} enabled`); node.onclick?.(); };
const change = (root: Element, id: string, value: string) => { const node = get(root, id); assert.equal(node.disabled, false); node.value = value; node.onchange?.(); };
const input = (root: Element, id: string, value: string) => { const node = get(root, id); assert.equal(node.disabled, false); node.value = value; node.oninput?.(); };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const state = (id: string, revision: number, profile = defaultCharacterResponseProfile()): CharacterResponseState => ({ characterId: id, revision, profile });
function fixture(initial = defaultCharacterResponseProfile(), overrides: Partial<CharacterResponseBridge> = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  const root = new Element('div'), errors: string[] = [], confirmations: string[] = [], answers: boolean[] = [], reads: string[] = [];
  const stored = new Map<string, CharacterResponseState>([['a', state('a', 1, initial)], ['b', state('b', 1)]]);
  const saves: { id: string; profile: CharacterResponseProfile; expectedRevision?: number }[] = [];
  let revision = 1, listener: ((value: CharacterResponseState) => void) | undefined, unsubscribed = false;
  const api: CharacterResponseBridge = {
    async getCharacterResponse(id) { reads.push(id); return structuredClone(stored.get(id) ?? state(id, revision)); },
    async saveCharacterResponse(id, profile, expectedRevision) {
      saves.push({ id, profile: structuredClone(profile), expectedRevision });
      if (expectedRevision !== revision) throw new Error('已有新修改，请重新读取后再保存');
      const result = state(id, ++revision, structuredClone(profile)); stored.set(id, result); listener?.(structuredClone(result)); return structuredClone(result);
    },
    onCharacterResponse(callback) { listener = callback; return () => { listener = undefined; unsubscribed = true; }; },
    ...overrides,
  };
  const ui = new CharacterResponseControls(root as unknown as HTMLElement, { api, onError: message => errors.push(message), confirm: message => { confirmations.push(message); return answers.shift() ?? true; } });
  return {
    ui, root, reads, saves, errors, confirmations, answers, stored,
    select(id: string | null = 'a') { ui.select(id, DEFAULT_MOOD_PARAMETERS); },
    emit(value: CharacterResponseState) { stored.set(value.characterId, structuredClone(value)); revision = Math.max(revision, value.revision); listener?.(structuredClone(value)); },
    get unsubscribed() { return unsubscribed; },
    restore() { ui.dispose(); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); },
  };
}

test('a new unsaved card has no sidecar reads/writes; saved cards expose nine independent neutral sliders', async () => {
  const f = fixture();
  try {
    f.select(null); assert.equal(get(f.root, 'response-save').disabled, true); assert.deepEqual(f.reads, []);
    f.select(); await flush(); click(f.root, 'response-add-rule');
    const sliders = all(f.root).filter(node => /^response-(?:tendency|intensity)-/.test(node.id));
    assert.equal(sliders.length, 9); assert.ok(sliders.every(node => node.value === '100'));
    input(f.root, 'response-tendency-playful', '125'); input(f.root, 'response-tendency-comfortable', '140');
    assert.equal(get(f.root, 'response-tendency-close').value, '100');
    input(f.root, 'response-intensity-expression', '120');
    assert.ok(all(f.root).some(node => node.textContent.includes('预计 60 / 100')));
    assert.equal(f.saves.length, 0); click(f.root, 'response-save'); await flush();
    assert.equal(f.saves[0].id, 'a'); assert.equal(f.saves[0].expectedRevision, 1);
    assert.equal(f.saves[0].profile.rules[0].tendencyScale.playful, 1.25);
    assert.equal(f.saves[0].profile.rules[0].tendencyScale.comfortable, 1.4);
    assert.equal(f.saves[0].profile.rules[0].intensityScale.expression, 1.2);
    assert.equal(get(f.root, 'response-save').disabled, true); assert.deepEqual(f.confirmations, []);
  } finally { f.restore(); }
});

test('fixed phase/context selections create sparse rules and deletion restores inheritance only in the draft', async () => {
  const broad = defaultCharacterResponseRule({ mood: 'happy' }); broad.intensityScale.expression = 1.2;
  const f = fixture({ version: 1, rules: [broad] });
  try {
    f.select(); await flush(); change(f.root, 'response-mood', 'happy'); change(f.root, 'response-phase', 'cheek');
    change(f.root, 'response-context', 'support');
    assert.equal(get(f.root, 'response-intensity-expression').value, '120');
    assert.equal(get(f.root, 'response-intensity-expression').disabled, true);
    click(f.root, 'response-add-rule'); input(f.root, 'response-intensity-expression', '135');
    assert.equal(get(f.root, 'response-rule-list').children.length, 3);
    click(f.root, 'response-remove-rule'); assert.equal(get(f.root, 'response-intensity-expression').value, '120');
    assert.equal(get(f.root, 'response-save').disabled, true, 'adding then removing restores the saved template');
    click(f.root, 'response-inherit'); assert.equal(f.saves.length, 0);
    assert.equal(get(f.root, 'response-intensity-expression').value, '100'); click(f.root, 'response-revert');
    assert.equal(get(f.root, 'response-intensity-expression').value, '120');
  } finally { f.restore(); }
});

test('dirty drafts survive card switches, same-card refreshes and later host revisions without crossing IDs', async () => {
  const f = fixture();
  try {
    f.select(); await flush(); click(f.root, 'response-add-rule'); input(f.root, 'response-tendency-close', '135');
    f.select('b'); await flush(); click(f.root, 'response-add-rule'); input(f.root, 'response-tendency-close', '80');
    f.select('a'); assert.equal(get(f.root, 'response-tendency-close').value, '135');
    f.select('a'); assert.deepEqual(f.reads, ['a', 'b'], 'a refresh cannot replace an edited profile');
    f.emit(state('a', 3, { version: 1, rules: [defaultCharacterResponseRule({ mood: 'calm', phase: 'rua' })] }));
    assert.equal(get(f.root, 'response-tendency-close').value, '135');
    assert.equal(get(f.root, 'response-save').disabled, true, 'a conflicting same-card revision cannot be overwritten');
    click(f.root, 'response-revert'); assert.equal(get(f.root, 'response-tendency-close').disabled, true);
    f.select('b'); assert.equal(get(f.root, 'response-tendency-close').value, '80');
    assert.equal(f.saves.length, 0);
  } finally { f.restore(); }
});

test('a late read cannot replace a newer event or move another selected character', async () => {
  const pending = deferred<CharacterResponseState>();
  const f = fixture(defaultCharacterResponseProfile(), { async getCharacterResponse(id) { return id === 'a' ? pending.promise : state('b', 2); } });
  try {
    f.select('a'); f.select('b'); await flush(); click(f.root, 'response-add-rule'); input(f.root, 'response-tendency-playful', '125');
    const newProfile = { version: 1 as const, rules: [defaultCharacterResponseRule({ mood: 'calm' })] }; newProfile.rules[0].tendencyScale.playful = 1.4;
    f.emit(state('a', 4, newProfile)); pending.resolve(state('a', 1)); await flush();
    assert.equal(get(f.root, 'response-tendency-playful').value, '125', 'late a result does not touch b');
    f.select('a'); assert.equal(get(f.root, 'response-tendency-playful').value, '140');
    f.emit(state('a', 3)); assert.equal(get(f.root, 'response-tendency-playful').value, '140', 'older revision stays ignored');
  } finally { f.restore(); }
});

test('a save finishing after a card switch updates only its original sidecar draft', async () => {
  const pending = deferred<CharacterResponseState>(); let requested = '';
  const f = fixture(defaultCharacterResponseProfile(), { async saveCharacterResponse(id) { requested = id; return pending.promise; } });
  try {
    f.select(); await flush(); click(f.root, 'response-add-rule'); input(f.root, 'response-intensity-text', '120');
    click(f.root, 'response-save'); f.select('b'); await flush(); click(f.root, 'response-add-rule'); input(f.root, 'response-intensity-text', '75');
    const profile = { version: 1 as const, rules: [defaultCharacterResponseRule({ mood: 'calm' })] }; profile.rules[0].intensityScale.text = 1.2;
    pending.resolve(state('a', 2, profile)); await flush();
    assert.equal(requested, 'a'); assert.equal(get(f.root, 'response-intensity-text').value, '75');
    assert.equal(get(f.root, 'response-save').disabled, false);
    f.select('a'); assert.equal(get(f.root, 'response-intensity-text').value, '120'); assert.equal(get(f.root, 'response-save').disabled, true);
  } finally { f.restore(); }
});

test('import partial-failure events cache an unsaved same-ID retry profile before selection', async () => {
  const f = fixture();
  try {
    f.select(); await flush(); const pending = { version: 1 as const, rules: [defaultCharacterResponseRule({ mood: 'calm' })] }; pending.rules[0].intensityScale.posture = 1.3;
    f.emit({ ...state('imported', 3), pendingProfile: pending, notice: '卡已导入，反应待重试保存' });
    assert.equal(f.saves.length, 0); f.select('imported');
    assert.equal(get(f.root, 'response-intensity-posture').value, '130');
    assert.match(get(f.root, 'response-status').textContent, /待重试保存/);
    f.emit(state('imported', 3)); assert.equal(get(f.root, 'response-intensity-posture').value, '130', 'plain reads/events keep retry dirty');
    click(f.root, 'response-save'); await flush(); assert.equal(f.saves[0].id, 'imported');
    assert.equal(f.saves[0].profile.rules[0].intensityScale.posture, 1.3);
  } finally { f.restore(); }
});

test('new nonzero extended scales require one confirmation; refusal preserves draft and accepted values are not reconfirmed', async () => {
  const f = fixture();
  try {
    f.select(); await flush(); click(f.root, 'response-add-rule'); input(f.root, 'response-intensity-expression', '200');
    input(f.root, 'response-tendency-cautious', '25'); f.answers.push(false);
    click(f.root, 'response-save'); await flush(); assert.equal(f.saves.length, 0); assert.equal(get(f.root, 'response-intensity-expression').value, '200');
    assert.match(f.confirmations[0], /预计强度 100/); assert.match(f.confirmations[0], /25%/);
    f.answers.push(true); click(f.root, 'response-save'); await flush(); assert.equal(f.saves.length, 1); assert.equal(f.confirmations.length, 2);
    input(f.root, 'response-intensity-text', '120'); click(f.root, 'response-save'); await flush();
    assert.equal(f.confirmations.length, 2); input(f.root, 'response-tendency-cautious', '0'); click(f.root, 'response-save'); await flush();
    assert.equal(f.confirmations.length, 2, 'explicit zero disables only its own scale');
  } finally { f.restore(); }
});

test('a storage failure retains local values, and disposal cancels late read effects and subscriptions', async () => {
  const pending = deferred<CharacterResponseState>();
  const f = fixture(defaultCharacterResponseProfile(), { async saveCharacterResponse() { throw new Error('storage locked'); }, async getCharacterResponse(id) { return id === 'late' ? pending.promise : state(id, 1); } });
  try {
    f.select(); await flush(); click(f.root, 'response-add-rule'); input(f.root, 'response-intensity-gaze', '130');
    click(f.root, 'response-save'); await flush(); assert.match(get(f.root, 'response-status').textContent, /storage locked/);
    assert.equal(get(f.root, 'response-intensity-gaze').value, '130'); f.select('late'); f.ui.dispose();
    pending.resolve(state('late', 4)); await flush(); assert.equal(f.unsubscribed, true); assert.equal(f.root.children.length, 0);
  } finally { f.restore(); }
});

test('a failed initial read has an explicit retry and re-reading never overwrites a dirty profile', async () => {
  let attempts = 0;
  const f = fixture(defaultCharacterResponseProfile(), { async getCharacterResponse(id) { if (++attempts === 1) throw new Error('temporary read failure'); return state(id, attempts); } });
  try {
    f.select(); await flush(); assert.equal(get(f.root, 'response-add-rule').disabled, true);
    assert.match(get(f.root, 'response-status').textContent, /temporary read failure/);
    click(f.root, 'response-reload'); await flush(); click(f.root, 'response-add-rule');
    input(f.root, 'response-intensity-posture', '135'); click(f.root, 'response-reload'); await flush();
    assert.equal(get(f.root, 'response-intensity-posture').value, '135'); assert.equal(f.saves.length, 0);
    assert.equal(get(f.root, 'response-save').disabled, false, 'a global revision with the same saved profile is safe to rebase');
  } finally { f.restore(); }
});

test('the UI exposes only implemented fixed conditions and cannot exceed the 24-rule template limit', async () => {
  const rules = CHARACTER_RESPONSE_MOODS.flatMap(mood => [defaultCharacterResponseRule({ mood, phase: 'idle' }), defaultCharacterResponseRule({ mood, phase: 'rua' })]);
  const f = fixture({ version: 1, rules });
  try {
    f.select(); await flush();
    assert.equal(get(f.root, 'response-mood').children.length, 12);
    assert.deepEqual(get(f.root, 'response-phase').children.map(node => node.value), ['', 'idle', 'rua', 'food-wait', 'food-ready', 'food-eating', 'cheek']);
    assert.equal(get(f.root, 'response-context').children.length, 7);
    assert.equal(get(f.root, 'response-add-rule').disabled, true);
    change(f.root, 'response-phase', 'idle'); click(f.root, 'response-remove-rule');
    change(f.root, 'response-phase', ''); assert.equal(get(f.root, 'response-add-rule').disabled, false);
    click(f.root, 'response-add-rule'); assert.equal(get(f.root, 'response-rule-list').children.length, 25);
    assert.equal(f.saves.length, 0);
  } finally { f.restore(); }
});
