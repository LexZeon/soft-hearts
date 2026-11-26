// I-137 (option A): when the user asks her to turn a sense on, she may offer a card; nothing changes until the user
// taps it, and the tap goes through the user's own switch (the same host path as the companion's buttons and set_perception). She never
// suggests one on her own: the host takes a sense card only on a turn whose user message asked for that sense, that way. Every turn
// she is told whether 三方互通 is on. Real CompanionService, ChatSettingProposals, VoiceChatHost, CallOffers, the real host bridge with
// the real MediaRuntime behind fake IPC handlers; a fake Claude; no Electron, no model call, no profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { ChatSettingCardView } from '../shared/brain/chat-settings';
import type { FaceCheckPhase } from '../shared/senses/face-check';
import { CompanionService } from '../electron/brain/companion';
import { ChatSettingProposals } from '../electron/brain/chat-settings';
import { TakeMeThere } from '../electron/initiative/take-me-there';
import { CallOffers } from '../electron/voice/call-offers';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { MediaRuntime } from '../electron/senses/media-runtime';
import { createHostBridge, type AgentHostWiring, type IpcHandler } from '../electron/safety/agent-channel/bridge';
import type { AgentAuditEntry } from '../electron/safety/agent-channel/registry';
import { SENSE_CARDS, askedSenses, senseAllowance, senseCardApplier } from '../electron/senses/sense-cards';
import { interconnectTurnLine } from '../electron/brain/interconnect-line';
import { createInnerLoopHost } from '../electron/initiative/inner-loop/host';
import { ProactiveSpeechGate } from '../electron/initiative/proactive-speech-gate';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import { encodeWav } from '../src/senses/MediaInput';
import { setUiLanguage } from '../shared/foundation/ui-language';

setUiLanguage('zh-CN');
const PET = 2, CONTROLS = 1, OWNER = 77;

/**
 * The user's own switches behind the real bridge: the companion window's setRuntimeState drives a real MediaRuntime (pose component
 * present), 「和她一起听」 and 认出是不是你 are small fakes that record what the real handlers would do (a download when the face
 * check turns on without its component).
 */
function switches(options: { facePhase?: FaceCheckPhase; petVisible?: boolean } = {}) {
  const media = new MediaRuntime(undefined, { mode: () => 'local' });
  const audio = { music: false, movie: false };
  const face = { enabled: false, phase: options.facePhase ?? 'idle' as FaceCheckPhase, downloads: 0 };
  const calls: string[] = [];
  const handlers: Record<string, IpcHandler> = {
    getRuntimeState: () => ({ ...media.state }),
    setRuntimeState: (event, patch) => { calls.push(`setRuntimeState@${event.sender.id}:${JSON.stringify(patch)}`); return media.update(patch, event.sender.id === PET ? 'pet' : 'controls'); },
    getAudioReadingView: () => ({ sources: { 'system-audio': { music: { intent: audio.music }, movie: { intent: audio.movie } } } }),
    setAudioReadingIntent: (event, input) => { calls.push(`setAudioReadingIntent@${event.sender.id}:${JSON.stringify(input)}`); audio[input.purpose as 'music' | 'movie'] = input.enabled; },
    getFaceCheck: () => ({ enabled: face.enabled, phase: face.phase }),
    setFaceCheck: (event, on) => {
      calls.push(`setFaceCheck@${event.sender.id}:${on}`); face.enabled = on;
      if (on && (face.phase === 'not-installed')) face.downloads++; // what electron/senses/face/host.ts setEnabled does
      return { enabled: face.enabled, phase: face.phase };
    },
  };
  const window = (id: number, visible = true) => ({ isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false,
    webContents: { id, isDestroyed: () => false, send: () => {} } });
  const bridge = createHostBridge({ operations: new Map(Object.entries(handlers)), controls: () => window(CONTROLS), pet: () => window(PET, options.petVisible ?? true),
    admit: (_guard: unknown, run: () => unknown) => run(), version: () => '0' } as unknown as AgentHostWiring);
  const audits: AgentAuditEntry[] = [], notices: string[] = [];
  const apply = senseCardApplier(bridge, { confirm: async () => { throw new Error('a sense card never opens a dialog'); },
    notice: (_tool, title, detail) => notices.push(`${title}:${detail ?? ''}`), audit: entry => audits.push(entry) });
  const senses = { read: () => ({ perception: bridge.perception!(), facePhase: bridge.faceCheckPhase!() }), apply };
  return { media, audio, face, calls, bridge, senses, audits, notices };
}

function proposals(s: ReturnType<typeof switches>, clock = { now: 1_000 }) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const cards: { owner: number; card: ChatSettingCardView }[] = [], applied: [string, unknown][] = [];
  const chatSettings = new ChatSettingProposals({ settings: () => settings, send: (owner, card) => cards.push({ owner, card }), now: () => clock.now });
  chatSettings.connect(async (id, value) => { applied.push([id, value]); return { ok: true, result: { previous: null, value } }; }, { senses: s.senses });
  return { chatSettings, cards, applied, settings, clock };
}

const block = (persona: string, json: string) => {
  const marker = persona.match(/<sh-setting-[a-f0-9]+>/)?.[0];
  assert.ok(marker, 'the proposal format reached her prompt');
  return `${marker}${json}${marker.replace('<', '</')}`;
};
const stateTail = (persona: string) => {
  const marker = persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  return marker ? `\n${marker}{"context":"neutral","delta":{},"confidence":0.9,"reason":"原创测试"}${marker.replace('<', '</')}` : '';
};
/** A forged block for a turn that carries no format (she cannot see one; the host must still refuse it). */
const forged = (json: string) => json;

/** Typed chat exactly as electron/main.ts runs it: beginTurn, her reply through CompanionService, offer after a complete reply. */
async function typedTurn(service: CompanionService, chatSettings: ChatSettingProposals, id: string, userText: string, reply: (persona: string) => string) {
  const settingTurn = chatSettings.beginTurn(userText);
  const turn = await service.begin(id, userText, 'Fixture persona.', () => {}, { settingProposal: settingTurn });
  for (const char of reply(turn.persona)) turn.push('delta', char);
  await turn.finish('complete');
  const raw = turn.settingProposal?.() ?? null;
  return { persona: turn.persona, card: chatSettings.offer(settingTurn.ticket, OWNER, id, raw), raw, instruction: settingTurn.instruction };
}

async function companion() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-i137-'));
  const service = new CompanionService(root, () => {});
  await service.load();
  await service.context('fixture-character', { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' }, 'Fixture persona.');
  return { service, dispose: async () => { await service.flush(); await rm(root, { recursive: true, force: true }); } };
}

// ---- which messages ask -----------------------------------------------------------------------------------------------------

test('asking: a sense named with a switch verb close to it, in the same clause; a mention or a question about it is not an ask', () => {
  const ask = (text: string) => Object.fromEntries([...askedSenses(text)].map(([id, set]) => [id, [...set].sort().join(',')]));
  assert.deepEqual(ask('帮我开一下摄像头'), { sense_camera: 'on' });
  assert.deepEqual(ask('把摄像头打开吧'), { sense_camera: 'on' });
  assert.deepEqual(ask('屏幕共享关掉'), { sense_screen: 'off' });
  assert.deepEqual(ask('你看看我的屏幕'), { sense_screen: 'on' });
  assert.deepEqual(ask('陪我听歌吧'), { sense_system_audio: 'on' });
  assert.deepEqual(ask('把电脑声音开一下'), { sense_system_audio: 'on' });
  assert.deepEqual(ask('帮我打开人脸识别'), { sense_face_check: 'on' });
  for (const text of ['摄像头开着吗', '摄像头打开了吗', '我今天换了个新摄像头', '关掉朗读，摄像头还好吗', '今天天气真好', '屏幕好亮', ''])
    assert.deepEqual(ask(text), {}, text);
  assert.deepEqual(ask(42 as unknown as string), {});
});

test('the face check is asked only while its component is installed; turning it off is always fine', () => {
  const facts = (phase: FaceCheckPhase) => ({ perception: null, facePhase: phase });
  assert.deepEqual([...senseAllowance('帮我打开人脸识别', facts('ready')).entries()], [['sense_face_check', ['on']]]);
  for (const phase of ['not-installed', 'downloading', 'installing', 'unsupported'] as FaceCheckPhase[])
    assert.equal(senseAllowance('帮我打开人脸识别', facts(phase)).size, 0, phase);
  assert.deepEqual([...senseAllowance('把人脸识别关掉', facts('not-installed')).entries()], [['sense_face_check', ['off']]]);
});

test('every card says plainly what turns on and how to turn it off, within what the card shows', () => {
  for (const spec of SENSE_CARDS) for (const item of spec.choices) {
    assert.ok([...item.detail].length <= 240, `${spec.id}/${item.value} detail fits the card`);
    assert.ok([...item.label].length <= 40, `${spec.id}/${item.value} label fits the button`);
    if (item.enabled) assert.match(item.detail, /打开/u);
    if (item.enabled) assert.match(item.detail, /关/u, `${spec.id}/${item.value} says how to turn it off`);
  }
});

// ---- typed chat -------------------------------------------------------------------------------------------------------------

test('typed chat: "帮我开一下摄像头" gives a camera card; nothing is on until the tap, then the user\'s own switch turns it on', async () => {
  const s = switches(), p = proposals(s), c = await companion();
  try {
    const turn = await typedTurn(c.service, p.chatSettings, 'r1', '帮我开一下摄像头', persona => '好呀，我把卡片放在旁边了。' + stateTail(persona)
      + block(persona, '{"id":"sense_camera","value":"pose","reason":"你想让我看看你"}'));
    assert.match(turn.persona, /sense_camera（摄像头，现在关着，可选 "pose"（姿势识别（只在本机））/u, 'the sense and its choices are in this turn\'s format');
    assert.match(turn.persona, /用户点卡片之前什么都不会开/u);
    assert.ok(turn.card, 'a card');
    assert.deepEqual([p.cards[0].owner, p.cards[0].card.settingId, p.cards[0].card.state, p.cards[0].card.current, p.cards[0].card.confirm],
      [OWNER, 'sense_camera', 'open', '关着', false]);
    assert.match(p.cards[0].card.detail!, /姿势识别/u);
    assert.deepEqual(s.calls, [], 'nothing switched by her reply');
    assert.equal(s.media.state.cameraSharing, false);
    const done = await p.chatSettings.choose(OWNER, { proposalId: turn.card!.proposalId, choiceId: 'c0' });
    assert.equal(done?.state, 'applied');
    assert.match(done!.message!, /已打开摄像头（姿势识别（只在本机））/u);
    assert.deepEqual(s.calls, ['setRuntimeState@2:{"cameraLocal":true}'], 'the pet window\'s own switch, as the user\'s click');
    assert.equal(s.media.state.cameraLocal, true);
    assert.deepEqual(s.audits.map(entry => [entry.tool, entry.outcome]), [['chat_set_sense', 'allowed']]);
    assert.deepEqual(s.notices, ['开关感知:打开摄像头：姿势识别（只在本机）'], 'the "由 Claude 操作" notice');
    // Once only.
    assert.equal(await p.chatSettings.choose(OWNER, { proposalId: turn.card!.proposalId, choiceId: 'c0' }), null);
    assert.equal(s.calls.length, 1);
  } finally { await c.dispose(); }
});

test('typed chat: a message that does not ask for a sense gives no sense card, whatever her reply carries', async () => {
  const s = switches(), p = proposals(s), c = await companion();
  try {
    for (const [id, text] of [['a', '今天天气真好'], ['b', '摄像头开着吗'], ['c', '把朗读音量调小一点']]) {
      const turn = await typedTurn(c.service, p.chatSettings, id, text, persona => '嗯。' + stateTail(persona)
        + (persona.match(/<sh-setting-/) ? block(persona, '{"id":"sense_camera","value":"pose"}') : ''));
      assert.doesNotMatch(turn.persona, /sense_/u, `${text}: no sense in her format`);
      assert.equal(turn.card, null, text);
    }
    // Even a forged block for this turn (as if she wrote one without the format) is refused by the host.
    const turn = p.chatSettings.beginTurn('把朗读音量调小一点');
    assert.equal(p.chatSettings.offer(turn.ticket, OWNER, 'd', forged('{"id":"sense_camera","value":"pose"}')), null);
    assert.equal(p.chatSettings.offer(p.chatSettings.beginTurn('今天天气真好').ticket, OWNER, 'e', forged('{"id":"sense_screen","value":"on"}')), null);
    assert.deepEqual([p.cards, s.calls], [[], []]);
  } finally { await c.dispose(); }
});

test('the direction the user asked for is the only one: "关掉摄像头" cannot become a card that turns it on', async () => {
  const s = switches(), p = proposals(s);
  await s.bridge.setPerception!('camera_images', true, [], () => {});
  s.calls.length = 0;
  const turn = p.chatSettings.beginTurn('把摄像头关掉');
  assert.equal(p.chatSettings.offer(turn.ticket, OWNER, 'r', '{"id":"sense_camera","value":"pose"}'), null);
  const again = p.chatSettings.beginTurn('把摄像头关掉');
  const card = p.chatSettings.offer(again.ticket, OWNER, 'r2', '{"id":"sense_camera","value":"off"}');
  assert.equal(card?.current, '发图片开着');
  const done = await p.chatSettings.choose(OWNER, { proposalId: card!.proposalId, choiceId: 'c0' });
  assert.equal(done?.state, 'applied');
  assert.deepEqual(s.calls, ['setRuntimeState@2:{"cameraSharing":false}']);
  assert.equal(s.media.state.cameraSharing, false);
});

test('the card keeps the existing rules: inert after the next message, five minutes, its own window only, nothing when already on', async () => {
  const s = switches(), p = proposals(s);
  const offer = (text: string, json: string) => { const turn = p.chatSettings.beginTurn(text); return p.chatSettings.offer(turn.ticket, OWNER, 'r', json); };
  const first = offer('帮我开一下屏幕共享', '{"id":"sense_screen","value":"on"}')!;
  p.chatSettings.beginTurn('今天天气真好');
  assert.equal(p.cards.at(-1)!.card.state, 'expired');
  assert.equal(await p.chatSettings.choose(OWNER, { proposalId: first.proposalId, choiceId: 'c0' }), null);
  const second = offer('帮我开一下屏幕共享', '{"id":"sense_screen","value":"on"}')!;
  await assert.rejects(p.chatSettings.choose(OWNER + 1, { proposalId: second.proposalId, choiceId: 'c0' }), /未授权/u);
  p.clock.now += 5 * 60_000 + 1;
  assert.equal((await p.chatSettings.choose(OWNER, { proposalId: second.proposalId, choiceId: 'c0' }))?.state, 'expired');
  assert.deepEqual(s.calls, [], 'nothing switched by an inert, foreign or expired card');
  const third = offer('帮我开一下屏幕共享', '{"id":"sense_screen","value":"on"}')!;
  assert.equal((await p.chatSettings.choose(OWNER, { proposalId: third.proposalId, choiceId: 'cancel' }))?.state, 'cancelled');
  assert.deepEqual(s.calls, []);
  await s.bridge.setPerception!('screen', true, [], () => {});
  assert.equal(offer('帮我开一下屏幕共享', '{"id":"sense_screen","value":"on"}'), null, 'already on: no card');
});

test('the computer\'s sound: the purpose the user asked for, through 「和她一起听」\'s own handler', async () => {
  const s = switches(), p = proposals(s);
  const turn = p.chatSettings.beginTurn('陪我听歌吧');
  const card = p.chatSettings.offer(turn.ticket, OWNER, 'r', '{"id":"sense_system_audio","value":"music","choices":["movie"]}')!;
  assert.deepEqual(card.choices.map(item => item.label), ['陪你听音乐', '陪你看视频']);
  await p.chatSettings.choose(OWNER, { proposalId: card.proposalId, choiceId: 'c0' });
  assert.deepEqual(s.calls, ['setAudioReadingIntent@2:{"source":"system-audio","purpose":"music","enabled":true}']);
  assert.deepEqual(s.audio, { music: true, movie: false });
});

test('a refused switch says so: the camera\'s pose sensing without its component stays off and the card says it did not open', async () => {
  const s = switches(), p = proposals(s);
  const blocked = new MediaRuntime(undefined, { mode: () => 'blocked', blocked: () => 'pose-missing' as never });
  Object.assign(s.media, { update: blocked.update.bind(blocked) });
  Object.defineProperty(s.media, 'state', { get: () => blocked.state });
  const turn = p.chatSettings.beginTurn('帮我开一下摄像头');
  const card = p.chatSettings.offer(turn.ticket, OWNER, 'r', '{"id":"sense_camera","value":"pose"}')!;
  const done = await p.chatSettings.choose(OWNER, { proposalId: card.proposalId, choiceId: 'c0' });
  assert.equal(done?.state, 'failed');
  assert.match(done!.message!, /没有打开摄像头/u);
  assert.equal(blocked.state.cameraSharing, false);
});

test('the pet must be shown to turn a sense on (as for set_perception); turning it off works anyway', async () => {
  const s = switches({ petVisible: false }), p = proposals(s);
  const turn = p.chatSettings.beginTurn('帮我开一下摄像头');
  const card = p.chatSettings.offer(turn.ticket, OWNER, 'r', '{"id":"sense_camera","value":"pose"}')!;
  const done = await p.chatSettings.choose(OWNER, { proposalId: card.proposalId, choiceId: 'c0' });
  assert.equal(done?.state, 'failed');
  assert.match(done!.message!, /桌宠显示出来/u);
  assert.deepEqual(s.calls, []);
});

// ---- the face check -----------------------------------------------------------------------------------------------------------

test('face check without its component: no card, no download, even when her reply carries one', async () => {
  const s = switches({ facePhase: 'not-installed' }), p = proposals(s);
  const turn = p.chatSettings.beginTurn('帮我打开人脸识别');
  // "打开" still brings the ordinary settings format; the face check is not in it.
  assert.doesNotMatch(turn.instruction?.('<a>', '</a>') ?? '', /sense_/u, 'the face check is not offered this turn');
  assert.equal(p.chatSettings.offer(turn.ticket, OWNER, 'r', '{"id":"sense_face_check","value":"on"}'), null);
  assert.deepEqual([s.calls, s.face.downloads, s.face.enabled], [[], 0, false]);
});

test('face check installed: a card; the tap goes through the control window\'s own switch; removed meanwhile: no download', async () => {
  const s = switches({ facePhase: 'idle' }), p = proposals(s);
  const turn = p.chatSettings.beginTurn('帮我打开人脸识别');
  const card = p.chatSettings.offer(turn.ticket, OWNER, 'r', '{"id":"sense_face_check","value":"on"}')!;
  assert.match(card.detail!, /只记你自己的脸/u);
  assert.doesNotMatch(card.detail!, /下载/u, 'no download is part of this card');
  assert.equal((await p.chatSettings.choose(OWNER, { proposalId: card.proposalId, choiceId: 'c0' }))?.state, 'applied');
  assert.deepEqual(s.calls, ['setFaceCheck@1:true']);
  // The component is removed between the card and the tap: the tap refuses instead of starting the download.
  const r = switches({ facePhase: 'ready' }), q = proposals(r);
  const later = q.chatSettings.offer(q.chatSettings.beginTurn('帮我打开人脸识别').ticket, OWNER, 'r', '{"id":"sense_face_check","value":"on"}')!;
  r.face.phase = 'not-installed';
  const done = await q.chatSettings.choose(OWNER, { proposalId: later.proposalId, choiceId: 'c0' });
  assert.equal(done?.state, 'failed');
  assert.match(done!.message!, /不会替你下载/u);
  assert.deepEqual([r.calls, r.face.downloads, r.face.enabled], [[], 0, false]);
});

// ---- the microphone ------------------------------------------------------------------------------------------------------------

test('the microphone is the existing 「语音输入」 card (I-025): asked for, it is in the format; there is no second microphone card', () => {
  const s = switches(), p = proposals(s);
  const text = p.chatSettings.beginTurn('帮我开一下麦克风').instruction!('<sh-setting-a>', '</sh-setting-a>');
  assert.match(text, /voice_input=/u);
  assert.doesNotMatch(text, /sense_/u);
});

// ---- a call ------------------------------------------------------------------------------------------------------------------

async function callHarness(interconnected?: () => boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i137-call-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku';
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const s = switches();
  const cards: { owner: number; card: ChatSettingCardView }[] = [];
  const chatSettings = new ChatSettingProposals({ settings: () => settings, send: (owner, card) => cards.push({ owner, card }) });
  chatSettings.connect(async () => ({ ok: true, result: null }), { senses: s.senses });
  const takeMeThere = new TakeMeThere({ send: () => {}, open: () => {} });
  const personas: string[] = [];
  let reply = (_persona: string) => '好的。';
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const pending = new Set<string>(), asr: string[] = [];
  const host = new VoiceChatHost({
    broadcast() {}, memoryChanged() {}, windowVisible: () => true, media: () => media, turnOffVoiceInput() {}, speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => { personas.push(task.session!.persona); const text = reply(task.session!.persona); emit('delta', text); return { superseded: false, output: text }; } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    callOffers: new CallOffers({ takeMeThere, chatSettings, ...(interconnected ? { interconnected } : {}) }),
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
  return { say, personas, cards, chatSettings, s, dispose };
}

test('a call: "帮我开一下摄像头" gives the same camera card on the call\'s window; on only after the tap', async () => {
  const h = await callHarness(() => true);
  try {
    await h.say('帮我开一下摄像头', persona => '好，我把选项放在屏幕上了。' + stateTail(persona) + block(persona, '{"id":"sense_camera","value":"pose"}'));
    assert.match(h.personas[0], /sense_camera/u);
    assert.equal(h.cards.length, 1);
    assert.deepEqual([h.cards[0].owner, h.cards[0].card.settingId, h.cards[0].card.state], [OWNER, 'sense_camera', 'open']);
    assert.deepEqual(h.s.calls, [], 'nothing on before the tap');
    assert.equal((await h.chatSettings.choose(OWNER, { proposalId: h.cards[0].card.proposalId, choiceId: 'c0' }))?.state, 'applied');
    assert.deepEqual(h.s.calls, ['setRuntimeState@2:{"cameraLocal":true}']);
    // An ordinary utterance: no sense in her prompt, and no new card.
    const shown = h.cards.length;
    await h.say('今天天气真好', persona => '是啊。' + stateTail(persona));
    assert.doesNotMatch(h.personas[1], /sense_/u);
    assert.equal(h.cards.length, shown);
  } finally { await h.dispose(); }
});

// ---- the 三方互通 line ------------------------------------------------------------------------------------------------------

test('the 三方互通 line: one short fact, on or off as it is, a failing reader reads as off', () => {
  assert.match(interconnectTurnLine(true), /^三方互通现在开着（/u);
  assert.match(interconnectTurnLine(false), /^三方互通现在关着（/u);
  assert.match(interconnectTurnLine(() => { throw new Error('x'); }), /现在关着/u);
  assert.ok([...interconnectTurnLine(true)].length <= 80, 'short');
  assert.doesNotMatch(interconnectTurnLine(true), /请|要|应该|不要|别/u, 'a fact, not an instruction');
});

test('a call turn carries the 三方互通 line, true to the switch, on every utterance', async () => {
  let on = true;
  const h = await callHarness(() => on);
  try {
    await h.say('今天天气真好', persona => '是啊。' + stateTail(persona));
    on = false;
    await h.say('你在干嘛', persona => '在想你。' + stateTail(persona));
    assert.match(h.personas[0], /三方互通现在开着/u);
    assert.match(h.personas[1], /三方互通现在关着/u);
  } finally { await h.dispose(); }
});

test('her own proactive turn (the inner loop\'s 【此刻】) carries the 三方互通 line', async () => {
  let on = true;
  const now = 1_000_000;
  const gate = new ProactiveSpeechGate(() => now); gate.setScope('g');
  const prompts: string[] = [];
  const host = createInnerLoopHost({
    gate, clock: () => now, setting: () => true, expressions: () => true, canExpress: () => true, current: () => true,
    characterId: () => 'gene', gateScope: () => 'g', parameters: () => DEFAULT_MOOD_PARAMETERS, fatiguePhase: () => 'awake',
    context: { localMinute: () => 15 * 60, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。', lastInteractionAt: () => null,
      profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' },
    random: () => 0, interconnected: () => on,
    decide: async prompt => { prompts.push(prompt); return { text: '{"action":"none"}', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }; },
    realize: () => {}, releaseSpeech: () => {}, offer: () => {}, cancelOffer: () => {}, surface: () => null, presentationIdentity: () => 'id',
    archive: async () => {}, developerMode: () => false, diagnosticsFile: () => null, diagnosticsChanged: () => {},
  });
  try {
    host.loop.offerOpportunity({ id: 'a', kind: 'speech', at: now, until: now + 3_000 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.match(prompts[0], /【此刻】[\s\S]*三方互通现在开着/u);
  } finally { host.loop.dispose(); gate.dispose(); }
  void on;
});
