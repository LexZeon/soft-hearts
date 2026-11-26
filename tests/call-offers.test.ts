// 通话里的「带我去」和设置提议 (2026-11-15): a call turn gets the same two helps typed chat has, through the same host modules.
// Real CompanionService, VoiceChatHost, ChatSettingProposals, TakeMeThere and CallOffers; a fake Claude, no microphone, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { ChatSettingCardView } from '../shared/brain/chat-settings';
import type { TakeMeThereId, TakeMeThereView } from '../shared/initiative/take-me-there';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { ChatSettingProposals } from '../electron/brain/chat-settings';
import { TakeMeThere } from '../electron/initiative/take-me-there';
import { CallOffers } from '../electron/voice/call-offers';
import { encodeWav } from '../src/senses/MediaInput';

const OWNER = 77, SCOPE = 'scope';

async function harness(options: { wired?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-calloffers-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const cards: { owner: number; card: ChatSettingCardView }[] = [], buttons: { owner: number; view: TakeMeThereView }[] = [];
  const applied: [string, unknown][] = [], opened: TakeMeThereId[] = [];
  const chatSettings = new ChatSettingProposals({ settings: () => settings, send: (owner, card) => cards.push({ owner, card }) });
  chatSettings.connect(async (id, value) => { applied.push([id, value]); return { ok: true, result: { previous: null, value } }; });
  const takeMeThere = new TakeMeThere({ send: (owner, view) => buttons.push({ owner, view }), open: destination => opened.push(destination) });
  const personas: string[] = [];
  let reply = (_persona: string) => '好的。';
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const pending = new Set<string>(), asr: string[] = [];
  const host = new VoiceChatHost({
    broadcast() {}, memoryChanged() {}, windowVisible: () => true, media: () => media, turnOffVoiceInput() {}, speechScope: () => SCOPE, settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => {
      personas.push(task.session!.persona);
      const text = reply(task.session!.persona); emit('delta', text);
      return { superseded: false, output: text };
    } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    ...(options.wired === false ? {} : { callOffers: new CallOffers({ takeMeThere, chatSettings }) }),
  });
  const binding = host.open(OWNER, 'controls');
  let seq = 0;
  const say = async (text: string, how: (persona: string) => string) => {
    reply = how; asr.push(text);
    host.pipeline.submit(OWNER, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(OWNER, binding.captureSessionId);
    const before = personas.length;
    for (let i = 0; i < 400 && personas.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 0; i < 400 && pending.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await host.drain();
  };
  const dispose = async () => { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); };
  return { say, personas, cards, buttons, applied, opened, chatSettings, takeMeThere, dispose };
}

const stateTail = (persona: string) => {
  const marker = persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  return marker ? `\n${marker}{"context":"neutral","delta":{},"confidence":0.9,"reason":"原创测试"}${marker.replace('<', '</')}` : '';
};
const settingBlock = (persona: string, json: string) => {
  const marker = persona.match(/<sh-setting-[a-f0-9]+>/)?.[0];
  assert.ok(marker, 'the setting instruction reached her prompt');
  return `${marker}${json}${marker.replace('<', '</')}`;
};

test('a call turn asking for a page gets the same button as typed chat; nothing opens until the tap', async () => {
  const h = await harness();
  try {
    await h.say('帮我导入一个新角色', persona => '我把按钮放在旁边了。' + stateTail(persona));
    assert.deepEqual(h.buttons.map(item => [item.owner, item.view.destination, item.view.state]), [[OWNER, 'import-character', 'open']]);
    assert.match(h.personas[0], /按钮/, 'she is told how to say it in a call');
    assert.deepEqual(h.opened, [], 'no page opened by the reply');
    assert.equal(h.takeMeThere.go(OWNER, { offerId: h.buttons[0].view.offerId, destination: 'import-character' }), true);
    assert.deepEqual(h.opened, ['import-character']);
  } finally { await h.dispose(); }
});

test('a call turn asking for a setting gets the same card as typed chat; only the tap changes it', async () => {
  const h = await harness();
  try {
    await h.say('把朗读音量调小一点', persona => '好，我把选项放在屏幕上了。' + stateTail(persona) + settingBlock(persona, '{"id":"readout_volume","value":30,"reason":"你说太响"}'));
    assert.match(h.personas[0], /设置提议/, 'the instruction rode in the existing leg prompt');
    assert.equal(h.cards.length, 1);
    assert.deepEqual([h.cards[0].owner, h.cards[0].card.settingId, h.cards[0].card.state], [OWNER, 'readout_volume', 'open']);
    assert.deepEqual(h.applied, [], 'nothing changes without the click');
    const done = await h.chatSettings.choose(OWNER, { proposalId: h.cards[0].card.proposalId, choiceId: 'c0' });
    assert.equal(done?.state, 'applied');
    assert.deepEqual(h.applied, [['readout_volume', 30]]);
  } finally { await h.dispose(); }
});

test('the card is the answer: a message that names a page and a setting shows the card, not a second button', async () => {
  const h = await harness();
  try {
    await h.say('帮我导入一个新角色，再把朗读音量调小一点', persona => '好。' + stateTail(persona) + settingBlock(persona, '{"id":"readout_volume","value":30}'));
    assert.equal(h.cards.length, 1);
    assert.deepEqual(h.buttons, []);
  } finally { await h.dispose(); }
});

test('an ordinary call turn adds nothing: no instruction, no card, no button', async () => {
  const h = await harness();
  try {
    await h.say('今天天气真好', persona => '是啊。' + stateTail(persona));
    assert.doesNotMatch(h.personas[0], /设置提议/);
    assert.deepEqual([h.cards, h.buttons], [[], []]);
  } finally { await h.dispose(); }
});

test('a new call turn takes the old button and card away, like a new typed message', async () => {
  const h = await harness();
  try {
    await h.say('帮我导入一个新角色', persona => '好。' + stateTail(persona));
    await h.say('今天天气真好', persona => '是啊。' + stateTail(persona));
    assert.equal(h.buttons.at(-1)!.view.state, 'gone');
    assert.equal(h.takeMeThere.go(OWNER, { offerId: h.buttons[0].view.offerId, destination: 'import-character' }), false);
  } finally { await h.dispose(); }
});

test('without the wiring a call turn offers nothing (what the user saw on 2026-11-15)', async () => {
  const h = await harness({ wired: false });
  try {
    await h.say('帮我导入一个新角色', persona => '我做不到。' + stateTail(persona));
    assert.deepEqual([h.cards, h.buttons], [[], []]);
  } finally { await h.dispose(); }
});

test('a privacy setting keeps its consent card (the tap is the consent) in a call', async () => {
  const h = await harness();
  try {
    await h.say('把语音输入打开', persona => '好。' + stateTail(persona) + settingBlock(persona, '{"id":"voice_input","value":true}'));
    assert.equal(h.cards.length, 1);
    assert.ok(h.cards[0].card.detail, 'the card itself says what turning it on means (the tap is the consent)');
    assert.deepEqual(h.applied, []);
  } finally { await h.dispose(); }
});
