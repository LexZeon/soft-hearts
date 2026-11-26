// I-139 B (docs/claude/2026-11-15-i139-defences.md; plan docs/claude/2026-11-15-i139-big-rewrite-plan.md, 一 and 三): with the I-139
// switch off, every prompt she reads must stay byte for byte what it was at b63aa359 (the foundation commit). These are sha256 hashes
// of each prompt text for fixed, synthetic fixtures (no private data), taken on that base before any I-139 assembly change. They must
// keep passing after A1 (chat), A2 (her voice) and A3 (moving memory) are merged: that is the point of the file. A failing hash here
// means a switch-off prompt changed; fix the code, do not update the hash (unless the user decided to change the switch-off prompt).
//
// Re-pinned on 2026-11-22 (I-178, user "按这个改"): inner-loop:speech, inner-loop:rest-reminder and ambient-comment now carry the chat's "only what
// you say out loud" sentence and, when there is chat, the recent-chat block (docs/claude/2026-11-22-i178-proactive-context.md). Nothing else moved.
//
// To see the actual values after an intended change: SOFT_HEARTS_PRINT_GOLDEN=1 node node_modules/tsx/dist/cli.mjs --test tests/i139-switch-off-golden.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateTermsIn } from './helpers/banned-terms.mjs';
import { createHash } from 'node:crypto';
import { claudeSessionSystemPrompt, CLAUDE_FOLLOW_UP_HEADER, composePreparedOpening, composeSessionPrompt } from '../electron/brain/claude-session-prompt';
import { claudeChatSystemPrompt, CLAUDE_SYSTEM_PROMPT } from '../electron/brain/claude';
import { buildCompanionPersona, buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PROMPT_SWITCHES_STABLE, getPromptSwitches, setPromptSwitches } from '../shared/brain/prompt-switches';
import { buildInnerLoopPrompt, innerLoopQuiet } from '../shared/initiative/inner-loop';
import { buildDiaryPrompt } from '../electron/memory/diary/diary-prompt';
import { buildReviewPrompt } from '../electron/memory/period-review/prompt';
import { buildFirstNotePrompt, buildRewritePrompt, FIRST_NOTE_INSTRUCTION, REWRITE_NOTE_INSTRUCTION } from '../electron/memory/her-note/prompt';
import { AmbientComments } from '../electron/senses/ambient-comments';
import { SPEAK_ONLY_REPLY_INSTRUCTION } from '../electron/brain/speak-only/rules';
import { PERCEPTION_INNER_LOOP_RULE, PERCEPTION_RULE, perceptionTurnLine, type PerceptionTurn } from '../shared/brain/perception-rule';
import { interconnectTurnLine } from '../electron/brain/interconnect-line';
import { FACE_STRANGER_LINE } from '../shared/senses/face-check';
import { VISITOR_MARK } from '../shared/senses/visitor-turn';
import { buildLongChatWindow, initiativeContent } from '../electron/brain/long-chat/window';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/foundation/mood';
import type { MoodView } from '../shared/mood/mood-runtime';
import type { AmbientContextItem } from '../shared/senses/ambient-audio';
import type { ChatMessage } from '../shared/contracts';
import type { HerStateNow } from '../shared/mood/her-state';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

// ---------------------------------------------------------------- synthetic fixtures (no private data, no clock, no randomness)

const PERSONA = '角色名称：小测\n性格：安静，爱逗人，嘴硬心软。';
const RELATIONSHIP = '你们认识第 3 天了。';
const STATE = '当前角色内在状态（应用提供的模拟状态）：主感受平静。';
const PROTOCOL = '【测试尾注】回复正文结束后附加一次测试标记。';
const MEMORIES = [{ title: '下雨天', createdAt: Date.UTC(2026, 10, 1, 12), excerpt: '用户：我喜欢下雨天' }];
const HISTORY = [u('你好'), a('你好呀。')];
const NOTE = '喜欢下雨天，累了会说"有点困"。';
const PROFILE = '喜欢猫。';

function turnPersona(speakOnly: boolean): string {
  return buildCompanionPersona({ persona: PERSONA, relationship: RELATIONSHIP, stateContext: STATE, memories: MEMORIES, protocolInstruction: PROTOCOL,
    ...(speakOnly ? { replyInstruction: SPEAK_ONLY_REPLY_INSTRUCTION } : {}) });
}

const SIGHT_OFF: PerceptionTurn = { screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null };
const HEARING_OFF: HerStateNow = { hearing: { source: null, stage: null, transcript: false }, contacts: [] };
const PERCEPTION_FIXTURES: Record<string, [PerceptionTurn, HerStateNow?]> = {
  off: [SIGHT_OFF],
  'off+hearing-off': [SIGHT_OFF, HEARING_OFF],
  'off+say-none': [SIGHT_OFF, { ...HEARING_OFF, say: 'none' }],
  'sharing-rough-unknown': [{ ...SIGHT_OFF, screen: true, rough: null }, HEARING_OFF],
  'sharing-plain': [{ ...SIGHT_OFF, screen: true }],
  'look-screen': [{ ...SIGHT_OFF, screen: true, attached: { screen: true, camera: false }, asked: 'screen' }, HEARING_OFF],
  'camera-glance': [{ ...SIGHT_OFF, camera: 'frames', attached: { screen: false, camera: true }, glance: true }],
  'asked-screen-off': [{ ...SIGHT_OFF, asked: 'screen' }, HEARING_OFF],
};

function innerLoopFixtures(): Record<string, string> {
  const base = { persona: PERSONA, mood: STATE, weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 14 * 60 };
  const day = innerLoopQuiet({ phase: 'awake', localMinute: 14 * 60 });
  const night = { ...innerLoopQuiet({ phase: 'awake', localMinute: 2 * 60 }), restReminder: true };
  return {
    motion: buildInnerLoopPrompt({ ...base, cue: 'motion', allowSpeech: false, quiet: day, minutesSinceInteraction: 12,
      herLife: { current: 'daydream', minutes: 12, choices: ['humming', 'thinking', 'company'] } }),
    speech: buildInnerLoopPrompt({ ...base, cue: 'speech', allowSpeech: true, quiet: day, minutesSinceInteraction: null, play: true }),
    'rest-reminder': buildInnerLoopPrompt({ ...base, cue: 'speech', allowSpeech: true, quiet: night, minutesSinceInteraction: 3, localMinute: 2 * 60 }),
  };
}

/** The ambient comment prompt, as AmbientComments builds it, captured through its own generate dependency. */
function ambientPrompt(): string {
  const clock = 40_000;
  const record: AmbientContextItem = { id: 'session:1', sessionId: 'session', mode: 'music', startedAt: 38_000, endedAt: 39_000, text: '公开歌词片段。',
    language: { status: 'detected', language: 'zh', source: 'provider' }, source: 'system-audio', title: '公开片段', tags: [], createdAt: 9000,
    excerpt: '公开歌词片段。', totalCharacters: 7, truncated: false };
  const prompts: string[] = [];
  const session = { owner: 11, sessionId: 'session', startedAt: 0, captureReadyAt: 0, mode: 'music' as const, scope: { characterId: 'card', providerScope: 'provider' }, contextIdentity: 'scope' };
  const comments = new AmbientComments({
    now: () => clock, createId: () => 'offer-1', currentSession: () => session, canComment: () => true,
    persona: () => PERSONA, moodText: () => STATE,
    generate: prompt => { prompts.push(prompt); return new Promise<string>(() => {}); },
    offer: () => {},
    gate: { busy: false, setScope: () => {}, tryAcquire: () => ({ signal: new AbortController().signal, commit: () => true, cancel: () => {} }) },
    store: { context: () => [structuredClone(record)], appendComment: async () => { throw new Error('unused'); }, recordUserResponse: async () => null },
  });
  const view: MoodView = { characterId: 'card', revision: 1, token: 'token', developerMode: false, expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), gesture: null,
    snapshot: { ...getMoodSnapshot(createMoodState(clock), clock), cue: { id: 'cue', kind: 'speech', at: clock, until: clock + 3000, source: { kind: 'ambient', sessionId: 'session', observationId: 'session:1' } } } };
  comments.observe(view);
  comments.clear();
  assert.equal(prompts.length, 1, 'the ambient comment prompt was built once');
  return prompts[0];
}

function longChatWindowText(): string {
  const at = Date.UTC(2026, 10, 10, 12, 0);
  const window = buildLongChatWindow({
    messages: [
      { role: 'user', content: '你好', createdAt: at },
      { role: 'assistant', content: '这首歌好温柔。', createdAt: at + 60_000, origin: { kind: 'proactive', id: 'p1', at: at + 60_000, sources: ['ambient'], labels: ['系统声音'] } },
      { role: 'assistant', content: '你在看什么呀。', createdAt: at + 120_000, origin: { kind: 'proactive', id: 'p2', at: at + 120_000, sources: ['screen'], labels: ['屏幕'] } },
      { role: 'user', content: '路过打个招呼。', createdAt: at + 180_000, speaker: 'visitor' },
    ],
    current: { content: '我回来了', createdAt: at + 240_000 },
    now: at + 240_000,
    knobs: { beforeDay: 100, dayStartHour: 4, windowMaxChars: 100_000 },
  });
  return JSON.stringify(window);
}

/** Every switch-off text, by name. */
function texts(): Record<string, string> {
  const speakOnly = turnPersona(true), plain = turnPersona(false);
  const out: Record<string, string> = {
    // (a) the fixed system prompts
    'session-system:default': claudeSessionSystemPrompt(),
    'session-system:speak-only': claudeSessionSystemPrompt({ settingsCatalog: false }),
    'chat-system:fallback': claudeChatSystemPrompt(),
    'claude-system:one-off': CLAUDE_SYSTEM_PROMPT,
    // (b) the follow-up header
    'follow-up-header': CLAUDE_FOLLOW_UP_HEADER,
    // (c) per-turn assembly
    'compose:opening': composeSessionPrompt({ plan: { opening: true, history: HISTORY }, basePersona: PERSONA, turnPersona: plain, openingContext: RELATIONSHIP,
      current: u('今天有点累'), profileContext: PROFILE, openingNote: NOTE }),
    'compose:opening-speak-only': composeSessionPrompt({ plan: { opening: true, history: HISTORY }, basePersona: PERSONA, turnPersona: speakOnly, openingContext: RELATIONSHIP,
      current: u('今天有点累') }),
    'compose:follow-up': composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: PERSONA, turnPersona: plain, openingContext: RELATIONSHIP,
      current: u('嗯嗯'), profileContext: PROFILE }),
    'compose:follow-up-speak-only': composeSessionPrompt({ plan: { opening: false, history: [a('在的。')] }, basePersona: PERSONA, turnPersona: speakOnly, openingContext: RELATIONSHIP,
      current: u('嗯嗯') }),
    'compose:prepared-opening': composePreparedOpening({ basePersona: PERSONA, openingContext: RELATIONSHIP, openingNote: NOTE, history: HISTORY }),
    'per-message:fallback': buildCodexChatPrompt(plain, [...HISTORY, u('今天有点累')], PROFILE),
    // (d) her own-voice one-off calls
    ...Object.fromEntries(Object.entries(innerLoopFixtures()).map(([name, text]) => [`inner-loop:${name}`, text])),
    'diary': buildDiaryPrompt({ persona: PERSONA, language: '', date: '2026-11-02', relative: '昨天', material: '20:00 用户：今天好累\n20:01 小测：那早点睡。' }),
    'review:week': buildReviewPrompt({ kind: 'week', persona: PERSONA, language: '', span: '11-03 到 11-09', material: '11-04 日记：一起听了歌。' }),
    'review:month-en': buildReviewPrompt({ kind: 'month', persona: PERSONA, language: '', span: '2026 年 10 月', material: '10-20 diary: we listened to a song.', english: true }),
    'her-note:first-instruction': FIRST_NOTE_INSTRUCTION,
    'her-note:rewrite-instruction': REWRITE_NOTE_INSTRUCTION,
    'her-note:first': buildFirstNotePrompt([{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀。' }], PERSONA),
    'her-note:rewrite': buildRewritePrompt(NOTE, [{ role: 'user', content: '下雨了' }], PERSONA),
    'ambient-comment': ambientPrompt(),
    // (e) lines and labels
    'speak-only-reply-instruction': SPEAK_ONLY_REPLY_INSTRUCTION,
    'perception-rule': PERCEPTION_RULE,
    'perception-inner-loop-rule': PERCEPTION_INNER_LOOP_RULE,
    ...Object.fromEntries(Object.entries(PERCEPTION_FIXTURES).map(([name, [turn, now]]) => [`perception-line:${name}`, perceptionTurnLine(turn, now)])),
    'interconnect:on': interconnectTurnLine(true),
    'interconnect:off': interconnectTurnLine(false),
    'face-stranger-line': FACE_STRANGER_LINE,
    'visitor-mark': VISITOR_MARK,
    'ambient-label': initiativeContent({ kind: 'proactive', id: 'p', at: 0, sources: ['ambient'], labels: ['系统声音'] }, '这首歌好温柔。'),
    'long-chat-window': longChatWindowText(),
  };
  return out;
}

/** sha256 of each text at b63aa359 (switch off, stable switch defaults). session-system:default, session-system:speak-only, chat-system:fallback and the inner-loop texts (six) re-pinned 2026-11-24 on purpose for I-206 (guilt / leaving wording removed; session was 20f1c369…33c5). session-system:default was re-pinned on 2026-11-19 for the slow_warm_up rename; it was c3e76d5f…db78. */
const GOLDEN: Record<string, string> = {
  'session-system:default': 'c752893ed8051a83a57cf0e897527a97420af612888e4dd130dcfd8bbf7057a0',
  'session-system:speak-only': 'ca1e392df5f21b0587cb38a70cc5822c83e11ed4925382ac2e490fff9d8a0fbf',
  'chat-system:fallback': 'b37e113da31acb25f9a0b9de8f9bfb5691ee223fe5076904e534e3d700e153fc',
  'claude-system:one-off': 'c5a657a67b849c235054b8cacb1b89b409e4b58a26ae71af3897a6b5e4133e9b',
  'follow-up-header': '754f7f01dde5296e7898b83fa02785d5826333a9202eb84ed0477e46a940d4ee',
  'compose:opening': 'fa7f4ff590066d55e9bdb4160ef69a6f9010285e465dab3329f6b64b0c82b9f6',
  'compose:opening-speak-only': '8facf327ae4d645020ba218a65f845abd76146e6e0f44b5cca56fa092f1f2e27',
  'compose:follow-up': '5734b2a9b5dac54e642a383b0b85cbc00ce8b9ada94d4b0db28d4e12b24d8efc',
  'compose:follow-up-speak-only': '0712db62ed5980b04dcac634ee436cdcbeb048541dac9ced4917a96bb9093462',
  'compose:prepared-opening': '6b09b6db2119e42baf8776102520b3e26dae8a5617b5f0f1e4487d65429d4694',
  'per-message:fallback': 'dfd727582917a2e37e04822d1554ad7d7f29620ccf4a3a532feec95a37b0927f',
  'inner-loop:motion': 'e72ca44f8b3a17c74d91ee34d50b05fbfc048d2f68f99a940ea2f31b1f49ad6a',
  'inner-loop:speech': 'ac8e84e0335dba56c180f22afaf3e000802f298d2bed8d07a577a5951d0b0898',
  'inner-loop:rest-reminder': '3b6866a4966611beb4d50d73146b6b6b3b558e302331ba3b20515947f871013f',
  'diary': '2fd1a5e143f1f7cfbb9e6ffca73a4fb4b265d8406dbb5b3d562feffd25d035e8',
  'review:week': '3ed0efeb96319cca4a9bb96ee63dff51da0d0de31e6447fb90757f5f69a22f97',
  'review:month-en': '9a21a7d2bc0765b11aace76bc0b3f324a547231cd998443f4aff0d93a388c486',
  'her-note:first-instruction': 'aabe7f29554efd65c7a188c46354e705090bb30139a5b743074d810af226b037',
  'her-note:rewrite-instruction': '1c47af6486fef8f05f4e431749beff77a6a05d1a9336ccdaf315485fcce3aa83',
  'her-note:first': '4589da7c2b902a985036fef52e53a4e17af12e7e35acde6365943b59773798ac',
  'her-note:rewrite': '9b2c2b73ffb27de3e5fe64581889ff8e6756af35ce053762ae1c510628fd3fa1',
  'ambient-comment': '618dfbb432b072d2a6ddd5e45170107bb8441be00686b15ec782730a66061611',
  'speak-only-reply-instruction': '01c51c2e45f29e8d081752214e62b739efdb0a5b7b0dc3ce469eee36e259b117',
  'perception-rule': '1865551c362f842d3e515cb28bc691de0f18fcf17a4d5514e0d5098919089303',
  'perception-inner-loop-rule': 'fba3b01065a206f5f4183693aada8bd8266f64cd4600d5b747058d691c4b35e5',
  'perception-line:off': 'd57e3c2061b67510a88cc019aad5b87c2a320028919b6d7ffba1b03e18b961aa',
  'perception-line:off+hearing-off': '2a6cc6d87d0c1a0077fc4ce5e99f3616294ae3f22736d0fe083ac7e6e8c7b083',
  'perception-line:off+say-none': 'd57e3c2061b67510a88cc019aad5b87c2a320028919b6d7ffba1b03e18b961aa',
  'perception-line:sharing-rough-unknown': '20bc760d3be6c0b72b28b0eea40625dbddc3268a96962fef71d2fd7d6f7a05a2',
  'perception-line:sharing-plain': 'f4815b9f5ea43340bd2c8c302a5043c19be1f627a3814737306724822b454b95',
  'perception-line:look-screen': '4e79864362a42e5ed0b7db49d7717fc11afc55d057eea9e77787ed7e0c19e92f',
  'perception-line:camera-glance': '0954c0868a283508eb9fd7ff3f61f7e46cbf3cd6d03d2725def34c98bb09615a',
  'perception-line:asked-screen-off': '8770971b148f7ae4c2df287faa1472f5f750e8ca35e01966dbfbb73110af4fcc',
  'interconnect:on': '2a26659efce7f8477d201aeb9b45eb29481da11ac7e6364b254d2b38f33be24c',
  'interconnect:off': '4f4e851a048a5668fc9df4c08d5140260d45d17955cc332135d8f817819b181e',
  'face-stranger-line': 'a48e9d285bfd92eb2294e5d18fac2408a5313a320c2706fde5dc8908c66a3fcd',
  'visitor-mark': 'a5c4dec2a7cb00132fb7e7c196a043e8b59db399ea510c18421f36acaae727cb',
  'ambient-label': '9a1a1f48a57372a632900630885a117a6609e9312e75b62ea9a956554b144f01',
  'long-chat-window': '3e369728770cc2c6cdd92e2e03eacde64216104c740d6a836e10edfac27ebc9d',
};

test('I-139 switch off: every prompt text is byte for byte what it was at b63aa359', () => {
  const saved = getPromptSwitches();
  setPromptSwitches(PROMPT_SWITCHES_STABLE);
  try {
    assert.notEqual(getPromptSwitches().relaxed, true, 'the switch is off');
    const actual = Object.fromEntries(Object.entries(texts()).map(([name, text]) => [name, sha(text)]));
    if (process.env.SOFT_HEARTS_PRINT_GOLDEN === '1') console.log(JSON.stringify(actual, null, 2));
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(GOLDEN).sort(), 'the same set of texts is pinned');
    for (const [name, hash] of Object.entries(GOLDEN)) assert.equal(actual[name], hash, `${name} changed with the I-139 switch off`);
  } finally { setPromptSwitches(saved); }
});

test('the golden fixtures carry no private data and every text is non-empty', () => {
  for (const [name, text] of Object.entries(texts())) {
    assert.ok(text.length > 0, `${name} is not empty`);
    assert.deepEqual(privateTermsIn(text), [], `${name}: synthetic fixtures only (the maintainer's private word list, when it is on this machine)`);
  }
});
