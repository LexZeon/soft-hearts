// I-162 step 2: the character page's 「她的声音」 as the user meets it: it is built from the card, saving goes through the host call with exactly
// the card voice, a paid provider is only a stored choice (no preview, no spending), and no key ever enters the page or what it sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterVoiceControls, type CharacterVoicePorts } from '../src/cards/CharacterVoiceControls';
import type { CharacterVoice } from '../shared/foundation/character-voice';
import { setSystemVoiceWishSource, systemVoiceDelivery } from '../src/voice/voice-language';

class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; value = ''; hidden = false; disabled = false; title = ''; type = ''; placeholder = '';
  rows = 0; maxLength = 0; min = ''; max = ''; step = ''; autocomplete = ''; spellcheck = true; tabIndex = 0;
  attributes = new Map<string, string>();
  onclick: (() => void) | null = null; onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  constructor(readonly tag: string) {}
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]): void { this.children = nodes; }
  add(node: Node): void { this.children.push(node); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  click(): void { this.onclick?.(); }
}
class FakeOption extends Node { constructor(text = '', value = '') { super('option'); this.textContent = text; this.value = value; } }
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function withDom<T>(run: () => Promise<T>): Promise<T> {
  const before = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), option: Object.getOwnPropertyDescriptor(globalThis, 'Option') };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Node(tag) } });
  Object.defineProperty(globalThis, 'Option', { configurable: true, value: FakeOption });
  return run().finally(() => {
    for (const [name, descriptor] of [['document', before.document], ['Option', before.option]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
}

function fixture(options: { ready?: boolean; active?: boolean; newDefault?: CharacterVoice } = {}) {
  const calls: unknown[][] = [], previews: string[] = [], setups: string[] = [], errors: string[] = [];
  const ports: CharacterVoicePorts = {
    newDefault: () => options.newDefault ?? { provider: 'system', voiceId: '' },
    systemVoices: () => [{ voiceURI: 'huihui', name: 'Microsoft Huihui', lang: 'zh-CN' }, { voiceURI: 'kangkang', name: 'Microsoft Kangkang', lang: 'zh-CN' }],
    providerReady: () => options.ready ?? false,
    isActive: () => options.active ?? true,
    preview: async () => { previews.push('preview'); },
    openSetup: provider => setups.push(provider),
  };
  const root = new Node('div');
  const controls = new CharacterVoiceControls(root as unknown as HTMLElement, {
    api: { saveCharacterVoice: async (id, voice) => { calls.push([id, voice]); return { cards: [], activeId: '' }; } }, ports, onError: message => errors.push(message) });
  const by = (id: string) => all(controls.root as unknown as Node).find(node => node.id === id)!;
  const button = (text: string) => all(controls.root as unknown as Node).find(node => node.tag === 'button' && node.textContent === text)!;
  const choose = (id: string, value: string) => { const node = by(id); node.value = value; node.onchange?.(); };
  return { controls, calls, previews, setups, errors, by, button, choose, root: controls.root as unknown as Node };
}

test('the section is built from her card: provider, voice, pace, description; pitch only for the system voice', async () => withDom(async () => {
  const f = fixture();
  f.controls.select({ id: 'akiko', name: '艾琳', voice: { provider: 'bailian', voiceId: 'longanhuan_v3.1', rate: 0.9, description: '活泼的女生' } }, false);
  assert.equal(f.by('character-voice-provider').value, 'bailian');
  assert.equal(f.by('character-voice-voice').value, 'longanhuan_v3.1');
  assert.equal(f.by('character-voice-description').value, '活泼的女生');
  assert.equal(f.by('character-voice-rate').value, '0.9');
  const row = (id: string) => all(f.root).filter(node => node.tag === 'label' && all(node).includes(f.by(id))).at(-1)!;
  assert.equal(row('character-voice-rate').hidden, false);
  assert.equal(row('character-voice-pitch').hidden, true, 'a cloud voice has no pitch');
  assert.equal(row('character-voice-id').hidden, true, 'the voice id box is for Drama 3');
  // The Bailian list marks the gender where it is known; the unknown one has no mark.
  const labels = f.by('character-voice-voice').children.map(option => option.textContent);
  assert.ok(labels.includes('龙安欢 · 女声') && labels.includes('许南川 · 男声') && labels.includes('龙安风悦'));
  f.choose('character-voice-provider', 'system');
  assert.equal(row('character-voice-pitch').hidden, false);
  assert.ok(f.by('character-voice-voice').children.map(option => option.textContent).some(label => label === 'Microsoft Kangkang · zh-CN · 男声'));
  f.choose('character-voice-provider', 'fish');
  assert.equal(row('character-voice-id').hidden, false);
  assert.equal(row('character-voice-voice').hidden, true);
}));

test('a card without a voice shows the default for new characters; nothing to save until something is changed', async () => withDom(async () => {
  const f = fixture({ newDefault: { provider: 'fish', voiceId: 'g6two' } });
  f.controls.select({ id: 'akiko', name: '艾琳' }, false);
  assert.equal(f.by('character-voice-provider').value, 'fish');
  assert.equal(f.button('保存她的声音').disabled, true);
  assert.equal(f.button('恢复成新角色的默认声音').disabled, true, 'she has no voice of her own to take away');
  f.choose('character-voice-provider', 'system');
  assert.equal(f.button('保存她的声音').disabled, false);
}));

test('saving sends exactly the card voice to the host call; clearing sends null; nothing else is sent', async () => withDom(async () => {
  const f = fixture();
  f.controls.select({ id: 'akiko', name: '艾琳', voice: { provider: 'system', voiceId: 'huihui' } }, false);
  f.choose('character-voice-provider', 'bailian');
  const description = f.by('character-voice-description'); description.value = '二十出头的女生，声音亮'; description.oninput?.();
  f.button('保存她的声音').click(); await flush();
  assert.deepEqual(f.calls, [['akiko', { provider: 'bailian', voiceId: '', description: '二十出头的女生，声音亮' }]]);
  assert.deepEqual(Object.keys(f.calls[0][1] as object).sort(), ['description', 'provider', 'voiceId']);
  assert.match(all(f.root).find(node => node.className === 'character-voice-status')!.textContent, /已保存/u);
  f.controls.select({ id: 'akiko', name: '艾琳', voice: { provider: 'bailian', voiceId: '' } }, false);
  f.button('恢复成新角色的默认声音').click(); await flush();
  assert.deepEqual(f.calls.at(-1), ['akiko', null]);
}));

test('choosing a paid provider only stores the choice: no preview runs, no key box exists, and a missing key is said with a way to fill it', async () => withDom(async () => {
  const f = fixture({ ready: false });
  f.controls.select({ id: 'akiko', name: '艾琳', voice: { provider: 'system', voiceId: '' } }, false);
  f.choose('character-voice-provider', 'fish');
  const text = all(f.root).map(node => node.textContent).join('\n');
  assert.match(text, /Drama 3 的 Key 还没有填/u);
  assert.match(text, /不会花钱/u);
  const id = f.by('character-voice-id'); id.value = 'g6two'; id.oninput?.();
  f.button('保存她的声音').click(); await flush();
  assert.deepEqual(f.calls, [['akiko', { provider: 'fish', voiceId: 'g6two' }]]);
  assert.deepEqual(f.previews, [], 'saving never plays a voice');
  f.button('去填 Drama 3 的 Key').click();
  assert.deepEqual(f.setups, ['fish'], 'the button only goes to the page where the key is filled');
  // No password or key field anywhere in the section.
  assert.ok(!all(f.root).some(node => node.type === 'password' || /api.?key/iu.test(node.id)));
}));

test('a preview is only for the character in use, only after saving, and goes through the existing preview port', async () => withDom(async () => {
  const idle = fixture({ active: false });
  idle.controls.select({ id: 'a', name: 'A', voice: { provider: 'system', voiceId: '' } }, false);
  assert.equal(idle.button('试听她现在的声音').disabled, true);
  const f = fixture({ active: true });
  f.controls.select({ id: 'a', name: 'A', voice: { provider: 'system', voiceId: '' } }, false);
  assert.equal(f.button('试听她现在的声音').disabled, false);
  f.button('试听她现在的声音').click(); await flush();
  assert.deepEqual(f.previews, ['preview']);
  f.choose('character-voice-provider', 'bailian');
  assert.equal(f.button('试听她现在的声音').disabled, true, 'unsaved changes: save first');
}));

test('an unsaved edit stays while the same card is refreshed, and a new card starts clean', async () => withDom(async () => {
  const f = fixture();
  const card = { id: 'a', name: 'A', voice: { provider: 'system' as const, voiceId: 'huihui' } };
  f.controls.select(card, false);
  const description = f.by('character-voice-description'); description.value = '半写的'; description.oninput?.();
  f.controls.select(card, false);
  assert.equal(f.by('character-voice-description').value, '半写的');
  f.controls.select({ id: 'b', name: 'B', voice: { provider: 'system', voiceId: 'kangkang' } }, false);
  assert.equal(f.by('character-voice-description').value, '');
  assert.equal(f.by('character-voice-provider').value, 'system');
}));

test('the window applies her own pace and pitch to the system voice on top of the global ones (1 when she has none)', () => {
  assert.deepEqual(systemVoiceDelivery(null), { rate: 1, pitch: 1 });
  assert.deepEqual(systemVoiceDelivery({ gender: 'female', voiceURI: '' }), { rate: 1, pitch: 1 });
  assert.deepEqual(systemVoiceDelivery({ gender: 'female', voiceURI: '', rate: 0.8, pitch: 1.2 }), { rate: 0.8, pitch: 1.2 });
  setSystemVoiceWishSource(() => ({ gender: 'female', voiceURI: '', rate: 0.7 }));
  try { assert.deepEqual(systemVoiceDelivery(), { rate: 0.7, pitch: 1 }); } finally { setSystemVoiceWishSource(() => null); }
});
