// The chat world of tests/brain-gates.test.ts (moved here 2026-11-20 so tests/speech-beats-reply-path.test.ts can use it too): the
// wiring's actual chat turn (`chat`), its cancel and launchTask, evaluated from the wiring's text (tests/helpers/wiring-source.ts) over fakes.
// Reads as text (test-affected selects the tests that use it when they change): 'electron/wiring/brain-wiring.ts', 'electron/wiring/brain-chat-wiring.ts'.
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import { chatFailureEvent } from '../../electron/brain/chat-failure-event';
import { admitHandedLine } from '../../electron/brain/handed-line-gate';
import { stageTurn } from '../../electron/brain/turn-owner/stage-turn'; // I-209 step 3: whose turn (the chat handler's one name for it)
import { sharedSight } from '../../electron/brain/stage-chat/perceive'; // I-209 step 4: one screen description for everyone on stage
import { scanStopReadoutRequest } from '../../shared/voice/stop-readout-request';
import { scanFramingRequest } from '../../shared/stage/framing-request';
import { scanBreathRequest } from '../../shared/actions/breath-request';
import { SpeechBeatsHost } from '../../electron/brain/speech-beats/host';
import { SpeechBeatArchive } from '../../electron/brain/speech-beats/archive';
import { WIRING_PRELUDE, wiringFunction, wiringHandler, wiringNodes, wiringOption } from './wiring-source';

/** Evaluates `body` (statements ending in a return) with the prelude and `env`'s names in scope. */
export function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
export const expression = <T>(text: string, env: Record<string, unknown>): T => evaluate<T>(`return (${text});`, env);
export const option = <T>(variable: string, name: string, env: Record<string, unknown>): T => expression<T>(wiringOption(variable, name), env);
/** The arguments of the one call `<callee>(…)` in the wiring, as text. */
export function callArguments(callee: string): string[] {
  const rows = wiringNodes((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === callee);
  assert.equal(rows.length, 1, `one ${callee}(…) in the wiring`);
  return rows[0].node.arguments.map(argument => argument.getText(rows[0].ast));
}
export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function settle(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await tick();
  assert.ok(done(), label);
}
export type Task = { controller: AbortController; owner: number; kind: 'chat' | 'agent'; source?: string };

/**
 * One chat world: the chat turn (`chat`), its cancel and launchTask, as the wiring wrote them, over fakes that record what reached her
 * chat process and what was written afterwards. `hold` keeps her reply streaming until release().
 */
export function chatWorld(over: { hold?: boolean; longChat?: boolean; attachments?: unknown[]; audioSession?: unknown; ambientRecords?: unknown[];
  command?: boolean; profile?: boolean;
  /** 边说边演: the chunks her Claude stream writes (default one 'hi'), the switch, and a turn that shows what its protocol was given. */
  stream?: readonly string[]; beats?: boolean; passThrough?: boolean;
  /** I-166: her closer look around the stream (electron/brain/look-continuation.ts), and the continuation's chunks (null: no warm process). */
  seeAndSay?: unknown; continuation?: readonly string[] | null } = {}) {
  const log: string[] = [];
  const finishes: string[] = [];
  const tasks: Record<string, unknown>[] = [];
  const longChatInputs: unknown[] = [];
  const events: { id: string; type: string; text?: string; outage?: unknown }[] = [];
  const state = { scope: 'scope-1', emoji: 'emoji-1', provider: { kind: 'claude', model: 'opus' } as Record<string, unknown> };
  const pending = new Map<string, Task>();
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const begins: string[] = [];
  const env: Record<string, unknown> = {};
  const voiceHost = { history: null as unknown, capture: null, busy: false };
  const store = { directory: path.join('tmp', 'profile'), get current() { return { provider: { ...state.provider }, persona: 'P', model: { path: 'm.pmx', url: 'u' }, tts: undefined,
    voice: { pauseTalk: false, firstChunk: 'sentence', enabled: true, volume: 1 }, pet: { alwaysOnTop: false, visible: true, followMouse: false, breath: true } }; } }; // no-pet-ok: the settings' own field name
  const shown: string[] = [], spoken: string[] = [], archived: string[] = [];
  const beatsHost = new SpeechBeatsHost('tmp', new SpeechBeatArchive('tmp', async (_file, data) => { archived.push(data); }, () => { throw new Error('no file'); }));
  const turn = (id: string, emit?: (type: string, text: string) => void) => ({
    id, scope: { characterId: 'c1', providerScope: 'claude' }, persona: 'PERSONA', relationshipOpening: '', relationshipTag: '', relationshipMemes: true,
    withCurrentRecall: (persona: string) => persona, push: (type: string, text: string) => { log.push(`push ${type} ${text}`); if (over.passThrough && type === 'delta') { shown.push(text); emit?.('delta', text); } },
    finish: async (status: string) => { finishes.push(status); if (env.onFinish) await (env.onFinish as (s: string) => Promise<void>)(status); },
    emptyReply: () => false, speechMood: () => ({ primary: 'happy' }), lookOffer: () => false, herFileProposal: () => null, settingProposal: () => null,
    profileReplyAccepted: () => false, textMemorialProposal: () => null, shownReply: () => over.passThrough ? shown.join('') : 'hi',
  });
  const companion = {
    begin: async (id: string, text: string, _persona: string, emit: (type: string, text: string) => void) => { begins.push(text); return turn(id, emit); },
    currentSpeechScope: () => state.scope, currentScope: () => ({ characterId: 'c1' }), conversationId: 'conv', memory: { turnStartedAt: () => 0 },
    mood: { get: () => ({ snapshot: { phase: 'idle' }, characterId: 'c1' }), isDeveloperMode: () => false, cancelChatGesture: (id: string) => { log.push(`cancel gesture ${id}`); } },
    userState: { current: () => null }, newConversation: async () => { log.push('new conversation'); },
  };
  const attachments = over.attachments ?? [];
  Object.assign(env, {
    validateChatRequest: (value: Record<string, unknown>) => ({ attachments, ...value }), admitHandedLine, stageTurn, sharedSight, stageIds: () => [], // 2026-11-23: the real gate (a numbered full-screen line goes only while open)
    lookAttachments: { admit: () => ({ current: () => attachments, asked: () => attachments, cameraVia: () => null, cameraGlance: () => null, cameraMiss: () => null,
      screenGlance: () => false, glanceOnly: () => false, glanceStill: () => () => false, // I-166
      recompose: (_attachments: unknown, persona: string) => persona }), textFirst: false, watching: false },
    seeAndSay: over.seeAndSay ?? null, // I-166
    lookTurns: { userTurn() {}, refusedIn: () => false, noteOffer() {} },
    scanStopReadoutRequest, scanFramingRequest, scanBreathRequest,
    singleEmojiCues: { invalidate() {}, offerReply: (id: string) => { log.push(`emoji ${id}`); } },
    r20ProactiveOffers: { cancel() {}, noteCompleted: (id: string) => { log.push(`r20 ${id}`); } },
    revokeVoice() {}, noteVisionUserActivity() {},
    moduleRouter: { userTurn() {} }, pauseTalk: { userTurn: () => null, delta() {}, cancel() {} }, journalCharacterId: () => 'c1',
    moodJudge: { host: { userText() {} } }, reactions: { userTurn() {}, host: { asking: () => false }, firstChar() {} },
    senseRouter: { userTurn: () => null, cancel() {}, firstChar() {}, hint: () => '', replyDone() {} },
    unboundNoticedLine: () => '', // Unbound step 4: what she noticed of you while out (none here)
    unboundOutsideTurnLine: () => '', // I-159 B: out in Unbound the senses are all on (not out here)
    cameraLookJournal: { turn() {} }, media: { sharesCameraFrames: () => false, state: {} },
    rps: { host: { chatTurn: () => null, chatDone() {} } }, store,
    replyLatency: { begin() {}, delta() {}, complete() {}, end() {} },
    takeMeThere: { beginTurn: () => ({ destination: null }), offer: () => { log.push('take me there offer'); } },
    chatSettings: { beginTurn: () => ({ ticket: null }), offer: () => false },
    herFolder: { beginTurn: async () => null, beginHint: () => null, offer: () => { log.push('her folder offer'); return false; }, hintDone: () => false },
    specialDay: { beginHint: () => null, hintDone() {} },
    i139Chat: { relaxed: () => null, stranger: () => false, labels: () => null, cardLanguage: () => 'zh-CN', openingMemory: () => null, perceptionOnce: () => ({ key: 'p', text: '' }) },
    faceTurnFor: async () => ({ visitor: false, line: '' }), faceCheck: null, companion,
    completedReplySpeech: { beginCommit: () => ({ fence: true }), append: (_fence: unknown, text: string) => { spoken.push(text); }, record: (_owner: unknown, _id: unknown, _scope: unknown, text: string) => { log.push('speech recorded'); spoken.push(`[record] ${text}`); }, cancelPending() {} },
    joinHintLines: () => undefined, textMemorialHost: null, textMemorialReplyContext: () => '',
    createCommandDialogueTurn: (input: { isCurrent(): boolean }) => ({ handle: async () => { env.commandCurrent = input.isCurrent; await env.commandGate; return 'done'; } }),
    classifyCompanionCommand: () => null, formatCompanionCommandReceipt: () => '',
    pending, companionCommandContext: () => 'ctx-1',
    companionCommands: { admit: () => (over.command ? { ticket: 1 } : null), invalidate() {}, run: async () => null },
    ambientComments: null, proactiveSpeechGate: { cancel() {} },
    ambientAudio: { currentSession: () => over.audioSession ?? null },
    ambientStore: { context: () => over.ambientRecords ?? [{ id: 'heard', text: 'HEARD WORDS' }] },
    ambientContextText: (records: { text: string }[]) => records.length ? `\n<external-audio-data>${records.map(record => record.text).join('|')}</external-audio-data>\n` : '',
    listenTogether: null, NO_LISTEN_ASK: { block: '', current: (persona: string) => persona }, upcoming: undefined,
    interconnectTurnLine: () => 'IC', agentInterconnected: () => true, roughForTurn: () => undefined,
    selfLook: { hint: () => '', afterMessage() {} }, textFirstTurn: () => ({ row: null, glance: {} }), watchTogether: null, lookState: () => ({}),
    appJournal: { record() {} }, perceptionTurnState: () => ({}), perceptionTurnLine: () => 'SIGHT', lookScope: () => 'look-1',
    herState: { chatTurn: () => null }, turnAwareness: { line: () => '' },
    speechScope: () => state.scope, singleEmojiContext: () => state.emoji,
    replySpeechStyles: { begin() {}, complete: () => true }, characterCards: { getActive: () => ({ id: 'c1' }) },
    freezeTurnSpeechStyle() {}, characterSpeechPersona: () => ({}), completedFatigueFeeling: () => undefined, effectiveTtsConfig: () => ({}), characterTtsConfig: () => ({}), DEFAULT_TTS_CONFIG: {},
    composeSpeechConfig: () => ({}), replyRhythm: { freeze() {} },
    currentProfileMessage: () => over.profile === true, userProfileContext: over.profile ? { begin: (_text: string, abort: () => boolean) => { env.profileAbort = abort; return 'lease'; }, release() {} } : null,
    personalizeLanguage: null, LONG_CHAT: { enabled: over.longChat === true }, buildCodexChatPrompt: (persona: string) => `PROMPT:${persona}`,
    longChatMessages: (input: unknown) => { longChatInputs.push(input); return null; }, textInvitationMemory: null, // what the turn asked of her archive's window (I-134)
    claudeChat: { stream: async (task: Record<string, unknown>, signal: AbortSignal, push: (type: string, text: string) => void) => {
      tasks.push(task); log.push(`stream persona=${String(task.prompt)}`);
      if (over.hold) await held;
      if (!signal.aborted) for (const chunk of over.stream ?? ['hi']) push('delta', chunk);
      return { superseded: false, output: (over.stream ?? ['hi']).join('') };
    },
    // I-166: the closer look's continuation into the same turn (null: no warm process to continue)
    continueReply: async (task: Record<string, unknown>, _signal: AbortSignal, push: (type: string, text: string) => void) => {
      if (over.continuation === null) return null;
      tasks.push(task); log.push(`continue images=${(task.imageDataUrls as string[]).length} prompt=${String(task.prompt)}`);
      for (const chunk of over.continuation ?? ['more']) push('delta', chunk);
      return { superseded: false, output: (over.continuation ?? ['more']).join('') };
    } },
    path, app: { getPath: () => 'temp' }, PROFILE_FOLDER: 'profile', chatContextData: () => undefined, longChatNote: () => null,
    chatIncidents: { record() { return true; } },
    chatAvailability: { quietFailure: (error: unknown) => error, notice: () => ({ line: 'her outage line' }), isAvailable: () => true },
    DraftOnlyReplyError: class extends Error {}, lookOfferFor: () => null, lookOfferTarget: () => null, hands: undefined, userProfileManagement: null,
    voiceHost, memoryProviderScope: () => 'claude',
    visionSupport: { noteImageSuccess: () => { log.push('image success'); } }, setVisionSupported() {}, setVisionStatus() {}, publishVisionState() {},
    suspendAmbientSpeech() {}, cancelReplyStyle: () => false, userProfiles: null,
    visualSelfRuntime: { accept: () => null, cancel() {} }, broadcast() {}, ownerFor: () => 'controls', windows: () => [],
    userProfileSource: { observe: () => over.profile === true }, acceptProfileMessage: () => null, refreshVisualSelfContext() {},
    speechRuntime: { stop() {} }, clearReplySpeech() {}, UserProfileReplyCollector: undefined,
    send: (_owner: number, event: { id: string; type: string; text?: string; outage?: unknown }) => { events.push(event); },
    syncFatigueActivity() {}, chatFailureEvent, exiting: false,
    speechBeatsFor: () => beatsHost, gateEnabled: (id: string) => id === 'speechBeats' ? over.beats === true : true, // 边说边演
  });
  const api = evaluate<{ chat: (sender: number, value: unknown) => void; cancel: (sender: number, id: unknown) => void;
    launchTask: (...args: unknown[]) => void }>(
    `${wiringFunction('launchTask')}\nconst chat = (${wiringHandler('chat')});\nconst cancel = (${wiringHandler('cancel')});\nreturn { chat, cancel, launchTask };`, env);
  const settled = (id: string) => events.some(event => event.id === id && (event.type === 'done' || event.type === 'error'));
  return { env, log, finishes, tasks, longChatInputs, events, state, pending, begins, voiceHost, release, settled, shown, spoken, archived, beatsHost,
    send: (id: string, text = '你好', sender = 1) => api.chat(sender, { id, messages: [{ role: 'user', content: text }], sentAt: 0 }),
    cancel: api.cancel, launchTask: api.launchTask, chat: api.chat };
}
