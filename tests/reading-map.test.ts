// I-164 读法: a character's { shown text -> spoken text } list, part of her voice. What is spoken changes; what is shown does not.
// Pure module rules, the resolver, the host's cloud path (SpeechRuntime), the window's system voice (SpeechOutput), export / import, and the page.
// No real voice, no paid call: fake synthesizer, fake speechSynthesis, fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { SpeechRuntime, type SpeechSynthesizer } from '../electron/voice/speech-runtime';
import { CharacterVoiceControls, type CharacterVoicePorts } from '../src/cards/CharacterVoiceControls';
import { SpeechOutput } from '../src/voice/speech';
import { setSystemVoiceWishSource, systemVoiceReading, systemWishOf } from '../src/voice/voice-language';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { normalizeCharacterVoice, portableCharacterVoice, type CharacterVoice } from '../shared/foundation/character-voice';
import { normalizeReadingEntries, portableReadingEntries, type ReadingEntry } from '../shared/foundation/character-voice-reading';
import { followedVoice } from '../shared/voice/character-voice-settle';
import { characterTtsConfig, type VoiceSettings } from '../shared/voice/character-voice-resolver';
import { applyReading, applyReadingMapped, readingFor, readingSample, shownToSpokenOffset, spokenToShownOffset } from '../shared/voice/reading-map';
import { speakableText } from '../shared/voice/speakable-text';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent } from '../shared/voice/tts';
import { voiceFormOf, voiceFromForm } from '../shared/voice/character-voice-form';

const ONE: ReadingEntry[] = [
  { from: 'One', to: 'オネ' },
  { from: '切', to: 'ちっ' },
  { from: '切……', to: 'ちっ……' },
  { from: '啧', to: '嘁' },
  { from: 'huh?', to: '哈？' },
];

test('a name and the tics are spoken as mapped', () => {
  assert.equal(applyReading('One，今天也很晚。', ONE), 'オネ，今天也很晚。');
  assert.equal(applyReading('我是 One。', ONE), '我是 オネ。');
  assert.equal(applyReading('切，随便你。', ONE), 'ちっ，随便你。');
  assert.equal(applyReading('切……我才不在乎。', ONE), 'ちっ……我才不在乎。', 'a tic ending in a mark is followed by text without a blank');
  assert.equal(applyReading('啧。这也叫方案？', ONE), '嘁。这也叫方案？');
  assert.equal(applyReading('Huh? 你再说一遍。', ONE), '哈？ 你再说一遍。', 'case does not matter for Latin text');
});

test('a name written with a capital matches only that case: the English word "one" is read as written; a lower-case entry matches any case', () => {
  //
  assert.equal(applyReading('no one 会懂，one more time。', ONE), 'no one 会懂，one more time。');
  assert.equal(applyReading('ONE 不是我。', ONE), 'ONE 不是我。');
  assert.equal(applyReading('One，过来。', ONE), 'オネ，过来。');
  assert.equal(applyReading('HUH? 再说一遍。', ONE), '哈？ 再说一遍。', 'an entry written in lower case still ignores case');
});

test('at a sentence start a capitalized name is her only when no English word follows: "One more thing" stays the number', () => {
  // One." "One,"）时才按名字念。可以".
  const EN: ReadingEntry[] = [{ from: 'One', to: 'Oh-neh' }];
  assert.equal(applyReading('One more thing. Sit down.', EN), 'One more thing. Sit down.');
  assert.equal(applyReading('Fine. One more try.', EN), 'Fine. One more try.');
  assert.equal(applyReading('“One last time,” she said.', EN), '“One last time,” she said.');
  assert.equal(applyReading('One. Say it properly.', EN), 'Oh-neh. Say it properly.');
  assert.equal(applyReading('One, come here.', EN), 'Oh-neh, come here.');
  assert.equal(applyReading("I'm One, not sis.", EN), "I'm Oh-neh, not sis.", 'inside a sentence a capitalized One is her name');
  assert.equal(applyReading('One说得对。', ONE), 'オネ说得对。', 'Chinese text after the name is not an English word');
  assert.equal(applyReading('好吧。One 才不在乎。', ONE), '好吧。オネ 才不在乎。', 'a Chinese word after a space is not an English word either');
});

test('a tic inside a longer word and a Latin name inside a longer word are left alone', () => {
  assert.equal(applyReading('这件事关切到你，切换一下。', ONE), '这件事关切到你，切换一下。');
  assert.equal(applyReading('someone and Oneself and phone', ONE), 'someone and Oneself and phone');
  assert.equal(applyReading('One说得对。', ONE), 'オネ说得对。', 'a name next to Chinese text is still read');
});

test('the longest shown text wins, and every provider-less entry is used', () => {
  assert.equal(applyReading('切……切。', ONE), 'ちっ……ちっ。');
});

test('no map, or no match: the very same string back', () => {
  const text = '切，One，啧……哈？（把脸埋低）';
  assert.equal(applyReading(text, undefined), text);
  assert.equal(applyReading(text, []), text);
  assert.equal(applyReading('没有任何口癖的一句话。', ONE), '没有任何口癖的一句话。');
  assert.deepEqual(applyReadingMapped(text, []).edits, []);
});

test('offsets map back: a position in the spoken text lands on the right shown character', () => {
  const shown = 'One，切……好吧。';
  const { text, edits } = applyReadingMapped(shown, ONE);
  assert.equal(text, 'オネ，ちっ……好吧。');
  // "好" is at 6 in the spoken text and at 6 in the shown text here (equal lengths); use a map that changes length to prove the shift.
  const long = applyReadingMapped('切。One，好吧。', [{ from: '切', to: '哎呀呀呀' }, { from: 'One', to: 'ō-ne' }]);
  assert.equal(long.text, '哎呀呀呀。ō-ne，好吧。');
  const spokenAt = long.text.indexOf('好'), shownAt = '切。One，好吧。'.indexOf('好');
  assert.equal(spokenToShownOffset(long.edits, spokenAt), shownAt);
  assert.equal(shownToSpokenOffset(long.edits, shownAt), spokenAt);
  // Inside a replacement an offset lands on where that replacement began (never in the middle of a shown word).
  assert.equal(spokenToShownOffset(long.edits, 2), 0);
  assert.equal(spokenToShownOffset(long.edits, long.text.indexOf('-')), '切。One，好吧。'.indexOf('One'));
  assert.equal(shownToSpokenOffset(long.edits, 3), long.text.indexOf('ō'), 'inside "One" -> the start of its spoken form');
  // Every shown character that was not replaced maps to itself both ways.
  const plain = '切。One，好吧。';
  for (let i = 0; i < plain.length; i++) {
    if (long.edits.some(edit => i >= edit.fromStart && i < edit.fromEnd)) continue;
    assert.equal(spokenToShownOffset(long.edits, shownToSpokenOffset(long.edits, i)), i);
  }
  assert.ok(edits.length === 2);
});

test('per-provider entries pick the right one; another provider\'s entry is never used', () => {
  const entries: ReadingEntry[] = [
    { from: 'One', to: 'オネ' },
    { from: 'One', to: 'o-ne', provider: 'bailian' },
    { from: '啧', to: 'zé', provider: 'system' },
    { from: '切', to: 'ちっ', provider: 'fish' },
  ];
  assert.deepEqual(readingFor(entries, 'fish').map(entry => entry.to).sort(), ['オネ', 'ちっ'].sort());
  assert.deepEqual(readingFor(entries, 'bailian').map(entry => entry.to), ['o-ne'], "Bailian's own wording wins over the general one");
  assert.deepEqual(readingFor(entries, 'system').map(entry => entry.to).sort(), ['オネ', 'zé'].sort());
  assert.equal(applyReading('One 啧 切', readingFor(entries, 'bailian')), 'o-ne 啧 切');
  assert.equal(applyReading('One 啧 切', readingFor(entries, 'system')), 'オネ zé 切');
  assert.equal(applyReading('One 啧 切', readingFor(entries, 'fish')), 'オネ 啧 ちっ');
  assert.deepEqual(readingFor(undefined, 'system'), []);
});

test('entries are sanitized: caps, control characters, brackets, no-letter texts, duplicates, at most 24, no key, path or link on export', () => {
  const messy = normalizeReadingEntries([
    { from: ' One\u0000 ', to: '[オネ]<>{}', provider: 'fish' }, { from: 'one', to: 'x', provider: 'fish' },
    { from: '，', to: 'x' }, { from: '切', to: '' }, { from: '切', to: '切' }, { from: 7, to: 'x' }, null, 'string',
    { from: 'a'.repeat(100), to: 'b'.repeat(200), provider: 'nope' },
  ]);
  assert.deepEqual(messy[0], { from: 'One', to: 'オネ', provider: 'fish' });
  assert.equal(messy.length, 2, 'a duplicate (case ignored), a mark-only text, an empty or unchanged reading and non-entries are left out');
  assert.equal(messy[1].from.length, 40); assert.equal(messy[1].to.length, 80); assert.equal(messy[1].provider, undefined);
  assert.equal(normalizeReadingEntries(Array.from({ length: 60 }, (_, i) => ({ from: `名${i}`, to: `读${i}` }))).length, 24);
  assert.deepEqual(normalizeReadingEntries('not a list'), []);
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const portable = portableReadingEntries([{ from: 'One', to: 'オネ' }, { from: 'a', to: secret }, { from: 'b', to: 'C:\\Users\\me\\x.wav' }, { from: 'https://x.y/z', to: 'link' }, { from: 'c', to: 'see https://example.invalid' }]);
  assert.deepEqual(portable, [{ from: 'One', to: 'オネ' }]);
});

test('the voice keeps the map through normalize and export, a voice without one stays exactly as before', () => {
  const voice = normalizeCharacterVoice({ provider: 'fish', voiceId: 'g6two', reading: ONE })!;
  assert.deepEqual(voice.reading, ONE);
  assert.deepEqual(portableCharacterVoice(voice)?.reading, ONE);
  assert.deepEqual(Object.keys(normalizeCharacterVoice({ provider: 'fish', voiceId: 'g6two' })!), ['provider', 'voiceId'], 'no `reading` key appears when there is no map');
  assert.deepEqual(Object.keys(portableCharacterVoice({ provider: 'fish', voiceId: 'g6two', reading: [{ from: 'a', to: 'sk-abcdefghijklmnopqrstuvwxyz123456' }] })!), ['provider', 'voiceId']);
  // Following the panel's voice change keeps her map.
  const settings: VoiceSettings = { tts: { ...DEFAULT_TTS_CONFIG, provider: 'system' } as TtsConfig, voice: { voiceURI: 'a' }, model: { path: 'C:/m.pmx' } };
  const moved = followedVoice(settings, { ...settings, voice: { voiceURI: 'b' } }, { id: 'one', voice: { provider: 'system', voiceId: 'a', reading: ONE } });
  assert.deepEqual(moved?.reading, ONE);
});

test('a card export carries the map and an import brings it back; a card without a map exports none', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-reading-map-'));
  try {
    const store = new CharacterCardStore(directory, 'legacy persona');
    await store.load();
    const id = store.publicState().activeId;
    await store.setVoices(new Map([[id, { provider: 'fish', voiceId: 'g6two', reading: ONE } as CharacterVoice]]));
    assert.deepEqual(store.getActive().voice?.reading, ONE);
    const text = store.export(id);
    assert.deepEqual(JSON.parse(text).card.voice.reading, ONE);
    assert.deepEqual(parseCharacterCardText(text).draft.voice?.reading, ONE);
    await store.setVoices(new Map([[id, { provider: 'fish', voiceId: 'g6two' }]]));
    assert.equal('reading' in JSON.parse(store.export(id)).card.voice, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const READY = { fishApiKey: 'placeholder-not-a-key', apiKey: 'placeholder-not-a-key', apiHost: 'https://example.invalid', region: 'x' };
const settingsFor = (provider: TtsConfig['provider']): VoiceSettings => ({ tts: { ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, provider, ...READY }, voice: { voiceURI: '' }, model: { path: 'C:/m.pmx' } });

test('the resolver hands over the entries of the provider that really reads her; a card without a map gets no field', () => {
  const entries: ReadingEntry[] = [{ from: 'One', to: 'オネ' }, { from: '啧', to: 'zé', provider: 'system' }, { from: '切', to: 'ちっ', provider: 'fish' }];
  const fish = characterTtsConfig(settingsFor('fish'), { id: 'one', name: 'One', voice: { provider: 'fish', voiceId: 'g6two', reading: entries } });
  assert.equal(fish.provider, 'fish');
  assert.deepEqual(fish.voicePlan?.reading?.map(entry => entry.to).sort(), ['オネ', 'ちっ'].sort());
  // Drama 3 has no voice id: the system voice reads, and her map for the system voice goes with it.
  const passed = characterTtsConfig(settingsFor('fish'), { id: 'one', name: 'One', voice: { provider: 'fish', voiceId: '', reading: entries } });
  assert.equal(passed.provider, 'system');
  assert.deepEqual(passed.voicePlan?.reading?.map(entry => entry.to).sort(), ['オネ', 'zé'].sort());
  assert.equal('reading' in characterTtsConfig(settingsFor('fish'), { id: 'one', voice: { provider: 'fish', voiceId: 'g6two' } }).voicePlan!, false);
  assert.equal('reading' in characterTtsConfig(settingsFor('system'), { id: 'x' }).voicePlan!, false);
});

const audio: TtsStreamEvent = { type: 'audio', data: 'AAAFAA==', format: 'pcm_s16le', sampleRate: 24000, channels: 1, firstAudioMs: 20 };
function hostHarness(card: { voice?: CharacterVoice }, provider: TtsConfig['provider'] = 'fish') {
  const texts: string[] = [], events: unknown[] = [];
  const synthesize: SpeechSynthesizer = async (_config, text, _signal, emit) => { texts.push(text); await emit(audio); };
  const runtime = new SpeechRuntime(() => characterTtsConfig(settingsFor(provider), { id: 'one', name: 'One', ...card }), (_owner, event) => events.push(event), synthesize);
  return { runtime, texts, events };
}

test('the host reads her as mapped on the cloud path; the shown text the caller holds is untouched', async () => {
  const { runtime, texts } = hostHarness({ voice: { provider: 'fish', voiceId: 'g6two', reading: ONE } });
  const shown = 'One：切，这也叫方案？（把脸埋低）';
  await runtime.speak(11, 'reply-1', shown);
  assert.deepEqual(texts, ['オネ：ちっ，这也叫方案？'], 'stage directions stay out as before, then the map');
  assert.equal(shown, 'One：切，这也叫方案？（把脸埋低）');
});

test('a character without a map is read byte for byte as before, on the cloud path', async () => {
  const { runtime, texts } = hostHarness({ voice: { provider: 'fish', voiceId: 'g6two' } });
  const text = '切，One 啧 huh? 你好。';
  await runtime.speak(11, 'plain', text);
  assert.deepEqual(texts, [speakableText(text)]);
});

test('a provider-specific entry for another provider is not used by the cloud voice', async () => {
  const { runtime, texts } = hostHarness({ voice: { provider: 'fish', voiceId: 'g6two', reading: [{ from: '啧', to: 'zé', provider: 'system' }, { from: 'One', to: 'オネ' }] } });
  await runtime.speak(11, 'p', 'One 啧。');
  assert.deepEqual(texts, ['オネ 啧。']);
});

class Utterance {
  voice: SpeechSynthesisVoice | null = null; lang = ''; rate = 1; volume = 1; pitch = 1;
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null; onboundary: ((event: { charIndex: number }) => void) | null = null;
  constructor(readonly text: string) {}
}
function systemHarness() {
  const previous = new Map(['speechSynthesis', 'SpeechSynthesisUtterance'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const queued: Utterance[] = [];
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: Utterance });
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, writable: true, value: { getVoices: () => [{ voiceURI: 'zh', lang: 'zh-CN' }], speak: (utterance: Utterance) => queued.push(utterance), cancel() {} } });
  const output = new SpeechOutput(() => {});
  const config = { ...DEFAULT_SETTINGS.voice, enabled: true, voiceURI: 'zh' };
  return { output, queued, config, restore() { output.stop(); setSystemVoiceWishSource(() => null); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
}

test('the window reads her as mapped with the system voice, and reads others exactly as before', async () => {
  const f = systemHarness();
  try {
    setSystemVoiceWishSource(() => ({ gender: 'female', voiceURI: '', reading: ONE }));
    void f.output.speak('One，切，你来了。（笑）', f.config);
    assert.equal(f.queued.at(-1)?.text, 'オネ，ちっ，你来了。');
    f.queued.at(-1)?.onend?.();
    setSystemVoiceWishSource(() => ({ gender: 'female', voiceURI: '' }));
    void f.output.speak('One，切，你来了。（笑）', f.config);
    assert.equal(f.queued.at(-1)?.text, 'One，切，你来了。', 'a wish without a map: only the stage direction goes, as before');
    f.queued.at(-1)?.onend?.();
    setSystemVoiceWishSource(() => null);
    void f.output.speak('One，切。', f.config);
    assert.equal(f.queued.at(-1)?.text, 'One，切。');
  } finally { f.restore(); }
});

test("the window's wish carries the map only when the system voice really reads her (never another provider's entries, e.g. Drama 3's standing in)", () => {
  const plan = (used: 'system' | 'fish') => characterTtsConfig(settingsFor('fish'), { id: 'one', name: 'One', voice: { provider: 'fish', voiceId: used === 'fish' ? 'g6two' : '', reading: [{ from: 'One', to: 'オネ' }, { from: '切', to: 'ちっ', provider: 'fish' }] } }).voicePlan;
  assert.deepEqual(systemWishOf(plan('system'))?.reading, [{ from: 'One', to: 'オネ' }]);
  assert.equal(systemWishOf(plan('fish'))?.reading, undefined);
  assert.equal(systemWishOf(undefined), null);
  // The Drama 3 month used up: the window reads with the system voice while the plan still says Drama 3.
  assert.equal(systemVoiceReading(systemWishOf(plan('fish'))), undefined);
});

test('the sample for 试听 is the shown texts, one sentence each', () => {
  assert.equal(readingSample(ONE), 'One。切。切……。啧。huh?。');
  assert.equal(readingSample([]), '');
  assert.equal(applyReading(readingSample(ONE), ONE), 'オネ。ちっ。ちっ……。嘁。哈？。');
});

// --- the page -------------------------------------------------------------------------------------------------------------------------------

class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; value = ''; hidden = false; disabled = false; title = ''; type = ''; placeholder = ''; checked = false;
  rows = 0; maxLength = 0; min = ''; max = ''; step = ''; autocomplete = ''; spellcheck = true;
  attributes = new Map<string, string>();
  onclick: (() => void) | null = null; onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  constructor(readonly tag: string) {}
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]): void { this.children = nodes; }
  add(node: Node): void { this.children.push(node); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}
class FakeOption extends Node { constructor(text = '', value = '') { super('option'); this.textContent = text; this.value = value; } }
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const before = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), option: Object.getOwnPropertyDescriptor(globalThis, 'Option') };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Node(tag) } });
  Object.defineProperty(globalThis, 'Option', { configurable: true, value: FakeOption });
  try { return await run(); } finally {
    for (const [name, descriptor] of [['document', before.document], ['Option', before.option]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('the page: add, edit and remove a reading, save sends exactly the card voice with the list, 试听 plays the shown texts through the preview port', () => withDom(async () => {
  const saves: unknown[][] = [], played: string[] = [], errors: string[] = [];
  const ports: CharacterVoicePorts = { newDefault: () => ({ provider: 'system', voiceId: '' }), systemVoices: () => [], providerReady: () => true, isActive: () => true,
    preview: async () => {}, previewText: async text => { played.push(text); } };
  const controls = new CharacterVoiceControls(new Node('div') as unknown as HTMLElement, { api: { saveCharacterVoice: async (id, voice) => { saves.push([id, voice]); return { cards: [], activeId: '' }; } }, ports, onError: message => errors.push(message) });
  const root = controls.root as unknown as Node;
  const button = (text: string) => all(root).find(node => node.tag === 'button' && node.textContent === text)!;
  controls.select({ id: 'one', name: 'One', voice: { provider: 'fish', voiceId: 'g6two', reading: [{ from: 'One', to: 'オネ' }] } }, false);
  const inputs = () => all(root).filter(node => node.placeholder === '显示的字' || node.placeholder === '读的字');
  assert.equal(inputs().length, 2, 'one row built from her card');
  assert.equal(inputs()[0].value, 'One'); assert.equal(inputs()[1].value, 'オネ');
  // add a row, fill it, save
  button('加一条读法').onclick?.();
  const fresh = inputs().slice(2);
  fresh[0].value = '切'; fresh[0].oninput?.(); fresh[1].value = 'ちっ'; fresh[1].oninput?.();
  const save = all(root).find(node => node.id === 'character-voice-save')!;
  assert.equal(save.disabled, false);
  save.onclick?.(); await flush();
  assert.deepEqual(saves, [['one', { provider: 'fish', voiceId: 'g6two', reading: [{ from: 'One', to: 'オネ' }, { from: '切', to: 'ちっ' }] }]]);
  // 试听 reads the shown texts only after saving, and only for the active character
  button('试听读法').onclick?.(); await flush();
  assert.deepEqual(played, ['One。切。']);
  // remove a row: the list shrinks and an empty row is never saved
  all(root).filter(node => node.tag === 'button' && node.textContent === '删掉')[0].onclick?.();
  assert.equal(inputs().length, 2);
  assert.deepEqual(controls.currentVoice().reading, [{ from: '切', to: 'ちっ' }]);
  assert.deepEqual(errors, []);
}));

test('the page: 试听 is off while there are unsaved edits, and a card with no map saves no `reading` field', () => withDom(async () => {
  const ports: CharacterVoicePorts = { newDefault: () => ({ provider: 'system', voiceId: '' }), systemVoices: () => [], providerReady: () => true, isActive: () => true, previewText: async () => {} };
  const controls = new CharacterVoiceControls(new Node('div') as unknown as HTMLElement, { api: { saveCharacterVoice: async () => ({ cards: [], activeId: '' }) }, ports, onError: () => {} });
  const root = controls.root as unknown as Node;
  controls.select({ id: 'one', name: 'One', voice: { provider: 'system', voiceId: '', reading: [{ from: 'One', to: 'オネ' }] } }, false);
  const preview = all(root).find(node => node.id === 'character-voice-reading-preview')!;
  assert.equal(preview.disabled, false);
  all(root).find(node => node.tag === 'button' && node.textContent === '加一条读法')!.onclick?.();
  const blank = all(root).filter(node => node.placeholder === '显示的字').at(-1)!; blank.value = 'x'; blank.oninput?.();
  assert.equal(preview.disabled, true, 'an edit is an unsaved change: the voice she would read with is the saved one, so 试听 waits for the save');
  assert.deepEqual(voiceFromForm(voiceFormOf({ provider: 'system', voiceId: '' }, undefined)), { provider: 'system', voiceId: '' });
}));

test('speech beats and reading progress count shown characters: the map is applied below them, never above', () => {
  // The caller's text (what the bubble shows, what beats and the prefix proof count) is not changed by applying a map to a copy.
  const shown = 'One，切……好吧。';
  const before = shown.length;
  applyReading(speakableText(shown), ONE);
  assert.equal(shown.length, before);
  assert.equal(shown, 'One，切……好吧。');
});

test('the window hands the host the shown segment as it is (the host checks it against the bubble), the map is applied only at the voice', async t => {
  const { world, flush } = await import('./helpers/r02-audio-world');
  const { VoiceOutput } = await import('../src/voice/VoiceOutput');
  const { SharedAudioOutput } = await import('../src/voice/audio-output');
  const { StreamingVoicePlayer } = await import('../src/voice/EmotionalVoice');
  const w = world(t), requests: string[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'fish', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k', fishVoiceId: 'g6two',
    voicePlan: { wanted: 'fish', used: 'fish', gender: 'female', systemVoiceURI: '', fallback: null, reading: ONE } };
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  let ids = 0;
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => ({ ...DEFAULT_SETTINGS.voice, enabled: true }),
    api: { async synthesizeSpeech(_id, text) { requests.push(text); }, async cancelSpeech() {}, async releaseSpeech() {}, onSpeechEvent() { return () => {}; } },
    onSpeaking: () => {}, onError: () => {}, createId: () => `seg-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
    createSystem: () => ({ voices: () => [], speak: () => Promise.resolve(), stop() {} }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  void output.speak('One，切，你来了。', { ...DEFAULT_SETTINGS.voice, enabled: true });
  await flush(); await flush();
  assert.deepEqual(requests, ['One，切，你来了。'], 'the host receives exactly what the bubble shows');
});
