// I-070 step 2: each character has its own Drama 3 voice id and acting style. Pure pieces, the request text, the per-character
// binding, the internal channel (set and undo) and the Bailian binding left exactly as it was. Fakes only; nothing goes online.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig, type TtsStreamEvent } from '../shared/voice/tts';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import { FISH_ACTING_STYLE_MAX, FISH_MOODS, FISH_NEUTRAL_DIRECTION, cleanFishActingStyle, fishDirection, fishRequestText } from '../shared/voice/fish-voice';
import { synthesizeFishSpeech, validateTtsConfig } from '../electron/voice/tts';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { createAppTools, voiceStyleArgs } from '../electron/safety/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';

const KEY = 'fish-key-marker-0123456789';
const CARD = '0f8fad5b-d9cb-469f-a165-70867728950e', OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MODEL = 'C:\\m\\aoi.pmx';
const CUTE = '像萌系动画女主角那样，声优式地演：可爱、表情丰富、带笑意、句尾俏皮上扬';

function fakeFetch() {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.close(); } }), { status: 200, headers: { 'content-type': 'audio/pcm' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, bodies };
}
async function requestText(config: TtsConfig, words: string, mood?: string): Promise<string> {
  const fake = fakeFetch();
  await synthesizeFishSpeech(config, words, new AbortController().signal, (_e: TtsStreamEvent) => {}, mood ? { mood: mood as any } : {}, { fetch: fake.fetch });
  return fake.bodies[0].text;
}
const fish = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: 'fish', fishApiKey: KEY, fishVoiceId: 'global1', ...patch });

test('no acting style: the bracket and the whole request text are byte-for-byte what they were', async () => {
  const before: Record<string, string> = {
    calm: '[natural, like everyday chatting]',
    happy: '[happy, a small smile, natural, like everyday chatting]',
    comfort: '[soft tone, caring, natural, like everyday chatting]',
    sad: '[a little sad, natural, like everyday chatting]',
    firm: '[a little annoyed, serious, natural, like everyday chatting]',
    focused: '[clear and attentive, natural, like everyday chatting]',
    sleepy: '[sleepy, unhurried, natural, like everyday chatting]',
  };
  for (const mood of FISH_MOODS) for (const none of [undefined, '', '   ', '[]<>', null, 5]) {
    assert.equal(fishDirection(mood, none as any), before[mood], `${mood} / ${JSON.stringify(none)}`);
    assert.equal(fishRequestText(mood, '你好', none as any), `${before[mood]} 你好`);
  }
  assert.equal(fishDirection(undefined), FISH_NEUTRAL_DIRECTION);
  assert.equal(fishDirection('angry', ''), FISH_NEUTRAL_DIRECTION);
  assert.equal(await requestText(fish(), '你好呀', 'happy'), '[happy, a small smile, natural, like everyday chatting] 你好呀');
  assert.equal(await requestText(fish({ fishActingStyle: '' }), '你好呀'), `${FISH_NEUTRAL_DIRECTION} 你好呀`);
});

test('with an acting style: [style; mood word] without "natural, like everyday chatting"; unknown mood or calm gives [style]', async () => {
  assert.equal(fishDirection('happy', CUTE), `[${CUTE}; happy, a small smile]`);
  assert.equal(fishDirection('sleepy', 'cute'), '[cute; sleepy, unhurried]');
  assert.equal(fishDirection('firm', 'cute'), '[cute; a little annoyed, serious]');
  assert.equal(fishDirection('calm', 'cute'), '[cute]');
  assert.equal(fishDirection(undefined, 'cute'), '[cute]');
  assert.equal(fishDirection('angry', 'cute'), '[cute]');
  for (const mood of [...FISH_MOODS, undefined]) assert.equal(fishDirection(mood, 'cute').includes('natural'), false, String(mood));
  assert.equal(fishRequestText('sad', '我[laughs]才不是', 'cute'), '[cute; a little sad] 我(laughs)才不是');
  // End to end through the adapter: the acting style on the config reaches the request.
  assert.equal(await requestText(fish({ fishActingStyle: CUTE }), '你好呀', 'comfort'), `[${CUTE}; soft tone, caring] 你好呀`);
  assert.equal(await requestText(fish({ fishActingStyle: CUTE }), '你好呀'), `[${CUTE}] 你好呀`);
});

test('the acting style loses brackets and angle brackets, control characters, and is cut at 300 characters (any language)', () => {
  assert.equal(cleanFishActingStyle('可爱[laughs] <whisper>  带笑意\n\t句尾上扬'), '可爱laughs whisper 带笑意 句尾上扬');
  assert.equal(fishDirection('happy', '[hack] <x>'), '[hack x; happy, a small smile]');
  assert.equal(cleanFishActingStyle(5), '');
  assert.equal(cleanFishActingStyle(undefined), '');
  assert.equal(Array.from(cleanFishActingStyle('あ'.repeat(500))).length, FISH_ACTING_STYLE_MAX);
  assert.equal(Array.from(cleanFishActingStyle('😀'.repeat(400))).length, 300, 'counted in characters, not UTF-16 units');
  assert.equal(cleanFishActingStyle('Cute, playful, bright. 日本語もOK。'), 'Cute, playful, bright. 日本語もOK。');
  // Nothing left inside the bracket can open another one.
  const text = fishRequestText('happy', 'hi', 'a]b[c<d>e');
  assert.equal(text, '[abcde; happy, a small smile] hi');
  assert.equal(validateTtsConfig({ fishActingStyle: '[x]' + 'y'.repeat(400) }).fishActingStyle!.length, 300);
  assert.equal(Object.hasOwn(validateTtsConfig({ fishActingStyle: '[]' }), 'fishActingStyle'), false, 'nothing left means no field');
});

test('per character: the binding’s voice id and acting style win; otherwise the global voice id and no acting style', () => {
  const tts = fish({ styleBindings: [
    { characterId: CARD, modelPath: MODEL, voice: 'v', instruction: '', emotion: 'custom', rate: 1, fishVoiceId: 'mine', fishActingStyle: CUTE },
    { characterId: OTHER, modelPath: 'C:\\m\\o.pmx', voice: 'v', instruction: '', emotion: 'custom', rate: 1 },
  ] });
  const mine = effectiveTtsConfig(tts, CARD, MODEL);
  assert.deepEqual([mine.fishVoiceId, mine.fishActingStyle], ['mine', CUTE]);
  const mineEmptyVoice = effectiveTtsConfig({ ...tts, styleBindings: [{ ...tts.styleBindings![0], fishVoiceId: '' }] }, CARD, MODEL);
  assert.equal(mineEmptyVoice.fishVoiceId, '', 'an explicit empty id is the Drama 3 default voice, not the global one');
  // A binding without Drama 3 fields (a Bailian-only binding) and a character with no binding at all both fall back.
  const bare = effectiveTtsConfig(tts, OTHER, 'C:\\m\\o.pmx');
  assert.deepEqual([bare.fishVoiceId, Object.hasOwn(bare, 'fishActingStyle')], ['global1', false]);
  const none = effectiveTtsConfig(tts, 'nobody', MODEL);
  assert.deepEqual([none.fishVoiceId, Object.hasOwn(none, 'fishActingStyle')], ['global1', false]);
  // Another character's style never leaks, even if the global config carried a stray one.
  assert.equal(Object.hasOwn(effectiveTtsConfig({ ...tts, fishActingStyle: 'stray' }, OTHER, 'C:\\m\\o.pmx'), 'fishActingStyle'), false);
  // Survives the host's validation, which is what the synthesizer sees.
  const checked = validateTtsConfig(JSON.parse(JSON.stringify(tts)));
  assert.deepEqual([checked.styleBindings![0].fishVoiceId, checked.styleBindings![0].fishActingStyle], ['mine', CUTE]);
  assert.equal(Object.hasOwn(checked.styleBindings![1], 'fishVoiceId'), false);
  assert.equal(Object.hasOwn(checked.styleBindings![1], 'fishActingStyle'), false);
  assert.deepEqual(validateTtsConfig({ styleBindings: [{ characterId: 'a', modelPath: 'm', fishVoiceId: 'bad id!', fishActingStyle: '[]' }] }).styleBindings,
    [{ characterId: 'a', modelPath: 'm', voice: DEFAULT_TTS_CONFIG.voice, instruction: '', emotion: 'custom', rate: 1 }], 'an unusable id is dropped; an empty style is not kept');
});

test('Bailian bindings are untouched: same effective config, same validated bytes', () => {
  const binding = { characterId: CARD, modelPath: MODEL, voice: 'private_voice', instruction: '绑定风格。', emotion: 'gentle' as const, rate: 0.8 };
  const base: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiKey: 'k', styleBindings: [binding] };
  const bound = effectiveTtsConfig(base, CARD, MODEL);
  assert.deepEqual(bound, { ...base, voice: 'private_voice', instruction: '绑定风格。', emotion: 'gentle', rate: 0.8 });
  assert.deepEqual(Object.keys(bound).sort(), Object.keys({ ...base }).sort(), 'no new keys appear');
  assert.deepEqual(effectiveTtsConfig(base, 'other', MODEL), base);
  assert.deepEqual(Object.keys(effectiveTtsConfig(base, '', '')).sort(), Object.keys(base).sort());
  assert.deepEqual(validateTtsConfig(base).styleBindings, [binding]);
  assert.equal(Object.hasOwn(validateTtsConfig(base), 'fishActingStyle'), false);
});

// --- Internal channel --------------------------------------------------------------------------------------------------

function channel(tts: Partial<TtsConfig>) {
  let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), model: { path: MODEL, url: 'local://aoi', name: 'aoi.pmx' } as any,
    tts: { ...structuredClone(DEFAULT_TTS_CONFIG), ...tts } as any };
  const cards = { activeId: CARD, cards: [{ id: CARD, name: '小桃', modelName: 'aoi.pmx' } as any] };
  const calls: string[] = [];
  const handlers: Record<string, (...args: any[]) => unknown> = {
    getSettings: () => structuredClone(settings),
    saveSettings: next => { calls.push('saveSettings'); settings = structuredClone(next); return settings; },
    getCharacterCards: () => structuredClone(cards),
    openControls: () => {},
  };
  const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) => [name, (_event: any, ...args: unknown[]) => run(...args)]));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
    commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
  let undo: { run(guard: () => void): unknown } | undefined;
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true,
    confirm: async () => true, notice: () => {}, called: (_summary, offer) => { undo = offer; } });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args), calls, settings: () => settings,
    undo: () => undo, tts: () => settings.tts as TtsConfig, mine: () => (settings.tts as TtsConfig).styleBindings?.find(b => b.characterId === CARD) };
}

test('channel: set_voice_style sets this character’s voice id and acting style; the global voice id, key and limit stay', async () => {
  const h = channel({ provider: 'fish', fishApiKey: KEY, fishVoiceId: 'global1', fishMonthlyCapUsd: 10 });
  const result = await h.call('set_voice_style', { voiceId: 'mine', actingStyle: ` ${CUTE} [x] ` });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual([h.mine()?.fishVoiceId, h.mine()?.fishActingStyle], ['mine', `${CUTE} x`]);
  assert.deepEqual([h.tts().fishVoiceId, h.tts().fishApiKey, h.tts().fishMonthlyCapUsd, h.tts().provider], ['global1', KEY, 10, 'fish']);
  assert.equal(Object.hasOwn(h.tts(), 'fishActingStyle'), false, 'never a shared setting');
  assert.equal(result.result.voiceId, 'mine');
  assert.equal(result.result.actingStyle, `${CUTE} x`);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  // The host reads exactly what the channel set.
  const effective = effectiveTtsConfig(h.tts(), CARD, MODEL);
  assert.equal(await requestText({ ...effective, provider: 'fish' }, '嗯', 'happy'), `[${CUTE} x; happy, a small smile] 嗯`);
  // Only the acting style: the voice id stays. Empty clears it.
  assert.ok((await h.call('set_voice_style', { actingStyle: '' })).ok);
  assert.deepEqual([h.mine()?.fishVoiceId, Object.hasOwn(h.mine()!, 'fishActingStyle')], ['mine', false]);
  // A character that never set a voice id keeps using the global one while it sets only the acting style.
  const g = channel({ provider: 'fish', fishApiKey: KEY, fishVoiceId: 'global1' });
  assert.ok((await g.call('set_voice_style', { actingStyle: 'bright' })).ok);
  assert.equal(Object.hasOwn(g.mine()!, 'fishVoiceId'), false);
  assert.equal(effectiveTtsConfig(g.tts(), CARD, MODEL).fishVoiceId, 'global1');
  // Refused input saves nothing; the catalog allows no key or cap and the acting style no more than 300 characters.
  const saves = h.calls.length;
  for (const bad of [{ actingStyle: 'x'.repeat(301) }, { actingStyle: 5 }, { actingStyle: 'ok', fishApiKey: 'x' }, { actingStyle: 'ok', fishMonthlyCapUsd: 1 }]) {
    assert.equal((await h.call('set_voice_style', bad)).ok, false, JSON.stringify(bad));
  }
  assert.equal(h.calls.length, saves);
  assert.deepEqual(voiceStyleArgs({ actingStyle: '[a]' }), { actingStyle: 'a' });
  assert.ok((await h.call('set_voice_style', { actingStyle: 'あ'.repeat(300) })).ok, '300 characters of any language pass');
});

test('channel: the change can be undone, and a Bailian-only change never writes Drama 3 fields into the binding', async () => {
  const h = channel({ provider: 'fish', fishApiKey: KEY, fishVoiceId: 'global1' });
  assert.ok((await h.call('set_voice_style', { voiceId: 'mine', actingStyle: 'cute' })).ok);
  await h.undo()!.run(() => {});
  assert.deepEqual([h.mine()?.fishVoiceId, h.mine()?.fishActingStyle], ['global1', undefined], 'back to what the character was using');
  assert.equal(Object.hasOwn(h.mine()!, 'fishActingStyle'), false);
  // Changed again by hand after the call: the undo of that call does not overwrite it.
  assert.ok((await h.call('set_voice_style', { actingStyle: 'first' })).ok);
  const stale = h.undo()!;
  assert.ok((await h.call('set_voice_style', { actingStyle: 'second' })).ok);
  await assert.rejects(Promise.resolve(stale.run(() => {})), /又改过了/);
  assert.equal(h.mine()?.fishActingStyle, 'second');
  // A Bailian-only change on a fresh character leaves the binding exactly as the old code wrote it.
  const b = channel({ provider: 'bailian', apiHost: 'https://dashscope.example', region: 'cn-beijing', apiKey: 'k', fishVoiceId: 'global1' });
  assert.ok((await b.call('set_voice_style', { voice: 'longxiaochun_v2', rate: 1.2 })).ok);
  assert.deepEqual(b.mine(), { characterId: CARD, modelPath: MODEL, voice: 'longxiaochun_v2', instruction: '', emotion: 'custom', rate: 1.2 });
  await b.undo()!.run(() => {});
  assert.deepEqual(b.mine(), { characterId: CARD, modelPath: MODEL, voice: DEFAULT_TTS_CONFIG.voice, instruction: '', emotion: 'custom', rate: 1 });
  assert.equal(b.tts().fishVoiceId, 'global1', 'the global voice id is not touched');
});
