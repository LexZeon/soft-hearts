// I-204
// While she reads aloud, three recognized characters interrupt her; her own voice leaking back is judged by how well the clip matches what
// she is reading now; her next turn is told where her voice stopped, what she said, the unspoken rest and the user's line; the rest is
// never archived. Synthetic clips, the fake Claude CLI, no microphone, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INTERRUPT_KNOBS } from '../shared/behaviors/interrupt/knobs';
import { countChars, echoMatch, judgeUtterance, type ClipLevels } from '../shared/behaviors/interrupt/judge';
import { callCutNote } from '../shared/voice/call-cut-note';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { DEFAULT_TTS_CONFIG } from '../shared/voice/tts';
import type { VoiceConversationEvent } from '../shared/voice/voice-conversation';
import { InterruptionLedger } from '../electron/voice/voice-call/interruption';
import { VoiceCallHost, type VoiceCallJournalInput } from '../electron/voice/voice-call/host';
import { CallStreamingSpeech } from '../electron/voice/voice-call/streaming-speech';
import { CompletedReplySpeech } from '../electron/voice/completed-reply-speech';
import { herVoiceFrom } from '../electron/voice/utterance-gate';
import { CompanionService } from '../electron/brain/companion';
import { PersistentClaudeChat } from '../electron/brain/claude-session';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { encodeWav } from '../src/senses/MediaInput';
import { fakeClaudeStream } from './helpers/fake-claude-stream';
import { CALL_TEST, chatProcessTimers, until } from './helpers/call-add-on-harness';
import { recordReplyCut } from '../electron/brain/speech-beats/cuts';
import { speechBeatsFor } from '../electron/brain/speech-beats/host';

const judge = (text: string, herText = '', levels: ClipLevels | null = { peakDb: -10, voicedSeconds: 1 }) => judgeUtterance({ text, levels, overHer: true, continuous: true, herText });

// ---------------------------------------------------------------- the rule (pure)

test('rule: three recognized characters over her interrupt; two do not; no phrase list, no filler filter, no loudness or duration gate', () => {
  assert.equal(INTERRUPT_KNOBS.minChars, 3, 'the user\'s number');
  // The 20:09 case: about 2 s of the user over her reading, recognized, held as a "fragment" by the 11-19 gate (it wanted 4 meaningful characters,
  // 0.5 s voiced and -40 dB). The journal keeps no words; any recognized line of 3 characters stands for it, quiet or short as it may be.
  for (const levels of [{ peakDb: -45, voicedSeconds: 2 }, { peakDb: -60, voicedSeconds: 0.2 }, null]) {
    const verdict = judge('我想说', '好的，我先给你讲讲今天的事情。', levels);
    assert.deepEqual(verdict, { pass: true, kind: 'words', interrupt: 'chars', chars: 3, match: verdict.match }, JSON.stringify(levels));
    assert.ok((verdict.match ?? 0) < INTERRUPT_KNOBS.echoMatchRatio);
  }
  for (const text of ['等等', '停', '对对', '好的', 'ok', '嗯嗯']) assert.equal(judge(text).pass, false, `${text}: under three characters`);
  assert.deepEqual(judge('等等'), { pass: false, kind: 'words', held: 'fragment', chars: 2, match: null });
  assert.deepEqual(judge('嗯嗯'), { pass: false, kind: 'filler', held: 'filler', chars: 2, match: null });
  assert.equal(judge('嗯嗯嗯').pass, true, 'no filler filter: three recognized characters are three ("不写过滤程序")');
  assert.equal(judge('等一下').pass, true);
  assert.equal(judge('wait now').pass, true, 'two English words count four');
  assert.equal(countChars('诶，等一下啊！'), 5, 'punctuation does not count; every recognized character does');
});

test('rule: her own voice leaking back is judged by the match ratio against what she is reading; below it, the user', () => {
  const her = '然后我们去公园散步吧。';
  assert.equal(echoMatch('我们去公园散步', her), 1, 'an exact stretch of her text');
  assert.equal(echoMatch('我们去公圆散步', her), 1 - 1 / 7, 'one homophone slip in seven');
  assert.ok(echoMatch('你先听我说一下', her) < 0.3, 'the user\'s own words');
  assert.equal(echoMatch('', her), 0);
  assert.deepEqual(judge('我们去公圆散步', her), { pass: false, kind: 'words', held: 'echo', chars: 7, match: 0.86 }, 'above the ratio: her echo, not a barge-in');
  assert.equal(judge('我们去公园玩吧', her).pass, false, 'five of seven right (0.71): still her echo');
  assert.deepEqual(judge('我们去吃饭吧', her), { pass: true, kind: 'words', interrupt: 'chars', chars: 6, match: 0.5 }, 'half of it: the user');
  assert.equal(judge('公园', her).pass, false, 'a two-character echo is held either way');
  assert.equal(judge('等一下', '你等一下我想想。').pass, false, 'an exact three-character stretch of what she is saying now is her echo (one knob, no loudness tie-break)');
  assert.equal(judge('等一下', '我等一会儿再告诉你。').pass, true, '等一 of 等一下 is 0.67: the user');
  assert.ok(INTERRUPT_KNOBS.echoMatchRatio > 2 / 3 && INTERRUPT_KNOBS.echoMatchRatio <= 0.75, 'three characters must match exactly; four may miss one');
});

test('rule: while she is not speaking nothing changes (a short or quiet "嗯" in a call is noise, words pass)', () => {
  const quiet = judgeUtterance({ text: '嗯', levels: { peakDb: -8, voicedSeconds: 0.2 }, overHer: false, continuous: true });
  assert.deepEqual([quiet.pass, (quiet as { held?: string }).held], [false, 'filler']);
  assert.equal(judgeUtterance({ text: '好', levels: { peakDb: -38, voicedSeconds: 0.2 }, overHer: false, continuous: true }).pass, true);
});

// ---------------------------------------------------------------- the ledger and the note (pure)

const REPLY = '好哒，今天天气很好。我们去公园散步吧。然后一起吃晚饭。';
const S0 = { start: 0, end: 10 }, S1 = { start: 10, end: 19 }, S2 = { start: 19, end: 27 };

test('ledger: the cut point is the sentence her voice was in (or between two); the note tells said, that sentence, the rest and the user\'s line', () => {
  assert.equal(REPLY.slice(S0.start, S0.end), '好哒，今天天气很好。');
  assert.equal(REPLY.slice(S2.start, S2.end), '然后一起吃晚饭。');
  const ledger = new InterruptionLedger();
  ledger.noteReading('r1');
  ledger.heard('r1', 0, 'start', S0); ledger.heard('r1', 0, 'end', null); ledger.heard('r1', 1, 'start', S1);
  assert.deepEqual(ledger.point(), { known: true, saidEnd: 10, sentenceEnd: 19 });
  assert.equal(ledger.mark('r1', '等一下我说'), true);
  assert.equal(ledger.mark('r1', '再说一次'), false, 'marked once');
  const note = ledger.takeNote(id => id === 'r1' ? REPLY : null, 'zh-CN');
  assert.match(note, /你被用户打断了/);
  assert.match(note, /已经念出声的：「好哒，今天天气很好。」/);
  assert.match(note, /正在念的这一句（可能只念出了一部分）：「我们去公园散步吧。」/);
  assert.match(note, /还没念出来的（用户没听到；[^」]*没有念出口，也没有接着念）：「然后一起吃晚饭。」/);
  assert.doesNotMatch(note, /不要|不用|先接|道歉/, 'facts only: no instruction on how to react');
  assert.match(note, /用户打断你时说的：「等一下我说」/);
  assert.equal(ledger.takeNote(() => REPLY, 'zh-CN'), '', 'taken once');
  // Between two sentences.
  const between = new InterruptionLedger();
  between.noteReading('r1'); between.heard('r1', 0, 'start', S0); between.heard('r1', 0, 'end', null);
  between.mark('r1', '我想问一下');
  const gap = between.takeNote(() => REPLY, 'zh-CN');
  assert.match(gap, /停在两句之间/);
  assert.match(gap, /还没念出来的[^「]*「我们去公园散步吧。然后一起吃晚饭。」/);
  // English card.
  const en = new InterruptionLedger();
  en.noteReading('r1'); en.heard('r1', 0, 'start', S0); en.mark('r1', 'hold on');
  const english = en.takeNote(() => REPLY, 'en');
  assert.match(english, /The user interrupted you/);
  assert.match(english, /Already said aloud: "\(nothing yet\)"/);
  assert.match(english, /What the user said to interrupt you: "hold on"/);
  assert.doesNotMatch(english, /[用户念]/, 'all wording in her chat\'s language (only her own words are quoted)');
});

test('ledger: nothing cut, unknown place, late marks and hang-up', () => {
  const done = new InterruptionLedger();
  done.noteReading('r1');
  for (const [index, range] of [[0, S0], [1, S1], [2, S2]] as const) { done.heard('r1', index, 'start', range); done.heard('r1', index, 'end', null); }
  done.mark('r1', '我想说');
  assert.equal(done.takeNote(() => REPLY, 'zh-CN'), '', 'her last sentence had finished: nothing was cut, nothing to tell');
  const unknown = new InterruptionLedger();
  unknown.noteReading('r1'); unknown.mark('r1', '我想说');
  const told = unknown.takeNote(() => REPLY, 'zh-CN');
  assert.match(told, /念到哪里没有收到记录/);
  assert.doesNotMatch(told, /然后一起吃晚饭/, 'without the place nothing of her text is quoted as unsaid');
  const late = new InterruptionLedger();
  late.noteReading('old'); late.noteReading('new');
  late.heard('old', 0, 'start', S0);
  assert.equal(late.point().known, false, 'facts of an older reply are ignored');
  assert.equal(late.mark('old', '我想说'), false, 'a late mark for an older reply is ignored');
  assert.equal(late.takeNote(() => REPLY), '');
  late.mark('new', '我想说'); late.clear();
  assert.equal(late.takeNote(() => REPLY), '', 'hang-up: nothing carries over');
});

test('ledger: the echo window is the sentence she is reading, the one before it and a little after; all of her text when unknown', () => {
  const long = '第一句话在这里。第二句也说完了。第三句正在念着呢。第四句还远着呢后面还有很多很多字。';
  const ledger = new InterruptionLedger();
  ledger.noteReading('r1');
  assert.equal(ledger.echoWindow(long), long, 'no sentence reported yet');
  ledger.heard('r1', 1, 'start', { start: 8, end: 16 }); ledger.heard('r1', 1, 'end', null);
  ledger.heard('r1', 2, 'start', { start: 16, end: 25 });
  const window = ledger.echoWindow(long);
  assert.ok(window.startsWith('第二句') && window.includes('第三句正在念着呢。'), window);
  assert.ok(!window.includes('第一句') && !window.includes('后面还有很多很多字'), window);
  assert.equal(echoMatch('后面还有很多很多字', window) < INTERRUPT_KNOBS.echoMatchRatio, true, 'what she will say later is not her echo now');
});

test('note: closed, short, no unspoken text outside its quotes; an empty user line is left out', () => {
  const note = callCutNote({ known: true, saidEnd: 10, sentenceEnd: 19, text: REPLY, userLine: '' }, 'zh-CN');
  assert.doesNotMatch(note, /用户打断你时说的/);
  const long = callCutNote({ known: true, saidEnd: 0, sentenceEnd: 0, text: '很长'.repeat(900), userLine: '我'.repeat(900) }, 'zh-CN');
  assert.ok(long.length < 1200, `bounded (${long.length})`);
});

// ---------------------------------------------------------------- the call: real gate, plan, streaming speech, voice host and archive

test('call: over her reading, a 2-character line and her echo are held; "等一下我说" (2 s) interrupts; her next turn knows the cut; nothing unspoken is archived', CALL_TEST, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i204-'));
  const claude = await fakeClaudeStream();
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const rewards: string[] = [], original = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { rewards.push(args[0].type); original(...args); };
  const chatTimers = chatProcessTimers(); // fake: a busy computer never turns a slow interrupt answer into a new process mid-test
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script],
    provider: () => settings.provider, chattedBefore: () => false, interruptGraceMs: 3000, log: () => {}, timers: chatTimers.timers });
  const plan = new CompletedReplySpeech(), journal: VoiceCallJournalInput[] = [], events: VoiceConversationEvent[] = [];
  const media = { voiceInput: true, voiceOwner: 'controls' as const }, pending = new Map<string, AbortController>(), asr: string[] = [];
  // The app's wiring (electron/wiring/voice-wiring.ts, senses-voice-input-wiring.ts), with the reading window played by the test.
  const speech: CallStreamingSpeech = new CallStreamingSpeech({ plan, active: () => call.on, voice: () => ({ provider: 'system' }), freeze() {},
    started: id => call.noteSpeech(id), playing: () => plan.busy });
  const call: VoiceCallHost = new VoiceCallHost({ now: () => Date.now(), media: () => media, turnOnVoice: () => true, turnOffVoice() {}, windowShown: () => true,
    asleep: () => false, ttsConfig: () => ({ ...structuredClone(DEFAULT_TTS_CONFIG), provider: 'system' }), characterId: () => 'c1', mood: () => ({}), keepWarm() {},
    broadcast() {}, journal: entry => journal.push(entry), directory: () => null, synthesize: async () => {},
    cancelReading: id => { speech.cancelAll(); if (id) plan.cancel(77, id); },
    sentence: (id, index) => plan.segmentRange(id, index), writtenText: id => speech.writtenText(id) });
  const host = new VoiceChatHost({
    broadcast: event => { events.push(event); if (event.type === 'speech') call.noteSpeech(event.replyId); }, memoryChanged() {}, windowVisible: sender => sender === 77,
    media: () => media, turnOffVoiceInput() {}, speechScope: () => 'fixture-scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => ({ acceptUserTurn: async () => {} }),
    reserveChat: (replyId, controller) => { if (pending.size) return false; pending.set(replyId, controller); return true; }, releaseChat: replyId => { pending.delete(replyId); },
    userTurn: () => call.turn(), activityChanged() {}, cancelProactive() {}, claude: chat, languageProfile: () => null,
    chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => { const text = asr.shift(); assert.ok(text !== undefined); return text; },
    stopReading() {}, prepareSpeech() {},
    turnNote: () => call.turnNote('zh-CN'),
    gate: { herVoice: () => call.addOn.herVoice(() => herVoiceFrom(new Set(), { busy: false }, speech)), herText: () => call.herText(speech.readingText()),
      continuous: owner => call.on && call.controller.owner === owner,
      held: (kind, overHer, owner, numbers) => call.held(kind, overHer, owner, numbers), interrupted: (owner, by, overHer, heard) => { call.heardOverHer(owner, by, overHer, heard); } },
    callSpeech: { begin: input => speech.begin(input), delta: (id, text) => speech.delta(id, text), complete: id => speech.complete(id), cancel: id => speech.cancel(id) },
    addOn: call.addOn,
    cut: (scope, turnId, cut) => { void recordReplyCut(directory, scope, turnId, cut); }, // 2026-11-23: the cut record, as the app wires it
  });
  call.onCut((replyId, cut) => host.fileCut(replyId, cut));
  /** The reading window: a sentence of `replyId` starts / ends being heard (noteReplySpeechHeard in the app). */
  const window = { start(id: string, index: number) { call.addOn.voiced(id); call.sentenceHeard(id, index, 'start'); }, end(id: string, index: number) { call.sentenceHeard(id, index, 'end'); } };
  const starts = () => events.filter(event => event.type === 'start').map(event => (event as { replyId: string }).replyId);
  const rows = () => events.filter((event): event is Extract<VoiceConversationEvent, { type: 'row' }> => event.type === 'row');
  const binding = host.open(77, 'controls');
  let seq = 0;
  const say = async (text: string, seconds: number, expect: 'row' | 'held') => {
    asr.push(text);
    const heldBefore = events.filter(event => event.type === 'held').length;
    host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(Math.round(16_000 * seconds)).fill(0.2)) });
    assert.equal(host.pipeline.endpoint(77, binding.captureSessionId), true);
    // Each clip ends one way (held, or a row): wait for whichever comes, then check it was the expected one (a wrong one fails at once).
    const asHeld = () => events.filter(event => event.type === 'held').length > heldBefore, asRow = () => rows().some(row => row.text.split('\n').at(-1) === text);
    await until(() => asHeld() || asRow(), 'the clip "' + text + '" heard');
    if (expect === 'held') assert.ok(asHeld() && !asRow(), 'held: ' + text);
    else assert.ok(asRow(), 'a row: ' + text);
  };
  try {
    await call.set('controls', true);
    const first = '今天天气很好。我们去公园散步吧。然后一起吃晚饭。';
    await say(first, 1.5, 'row');
    await until(() => starts().length === 1 && (speech.writtenText(starts()[0]) ?? '').includes('晚饭'), 'first reply written');
    const [r1] = starts();
    const reply1 = speech.writtenText(r1)!;
    assert.ok(reply1.startsWith('好哒，' + first), reply1);
    const s0 = plan.segmentRange(r1, 0)!, s1 = plan.segmentRange(r1, 1)!;
    assert.ok(s0 && s1, 'the plan split her reply into sentences');
    window.start(r1, 0); window.end(r1, 0); window.start(r1, 1); // she said the first sentence and is in the second
    await until(() => events.some(event => event.type === 'terminal' && event.replyId === r1), 'first reply counted');
    const saidPart = reply1.slice(0, s1.start), cutSentence = reply1.slice(s1.start, s1.end), rest = reply1.slice(s1.end);
    assert.ok(rest.includes('然后一起吃晚饭'), `rest: ${rest}`);

    await say('等等', 0.6, 'held');
    const echoLine = cutSentence.replace(/[。，]/g, '').replace('公园', '公圆'); // her own sentence back through the speakers, one homophone slip
    await say(echoLine, 1.5, 'held');
    const helds = journal.filter(entry => entry.event === 'held') as Extract<VoiceCallJournalInput, { event: 'held' }>[];
    assert.deepEqual(helds.map(entry => [entry.kind, entry.overHer, entry.chars]), [['fragment', true, 2], ['echo', true, echoLine.length]],
      'a 2-character line and her echo were held over her reading');
    assert.ok((helds[1].match ?? 0) >= INTERRUPT_KNOBS.echoMatchRatio, `echo match ${helds[1].match}`);
    assert.equal(plan.busy, true, 'she is still reading');

    await say('等一下我说', 2, 'row'); // the 20:09 case: about 2 s over her reading, recognized
    const interrupt = journal.find(entry => entry.event === 'interrupt') as Extract<VoiceCallJournalInput, { event: 'interrupt' }>;
    assert.deepEqual([interrupt.by, interrupt.overHer, interrupt.call, interrupt.chars], ['chars', true, true, 5]);
    assert.ok(typeof interrupt.match === 'number' && interrupt.match < INTERRUPT_KNOBS.echoMatchRatio);
    assert.equal(plan.segmentRange(r1, 1), null, 'her reading of the first reply stopped at once (the plan dropped it)');
    await until(() => starts().length === 2 && (speech.writtenText(starts()[1]) ?? '').length > 0, 'second reply');
    window.start(starts()[1], 0); // her voice starts (I-197 waits for it before the reply counts)
    await until(() => events.some(event => event.type === 'terminal' && event.replyId === starts()[1]), 'second reply counted');
    await host.drain(); await service.flush();

    const prompts = (await claude.inputs()).filter(row => row.user !== undefined).map(row => row.prompt ?? '');
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0], /你被用户打断了/);
    const told = prompts[1];
    assert.match(told, /你被用户打断了/);
    assert.ok(told.includes(`已经念出声的：「${saidPart}」`), 'what she said aloud');
    assert.ok(told.includes(`正在念的这一句（可能只念出了一部分）：「${cutSentence}」`), 'where her voice stopped');
    assert.ok(told.includes(`：「${rest.trim()}」`), 'what she had still meant to say');
    assert.ok(told.includes('用户打断你时说的：「等一下我说」'), 'the user\'s line');

    const records = (() => { const scope = service.currentScope(), page = service.memory.list(scope); return page.records.map(record => service.memory.read(scope, record.id)!); })();
    const messages = records.flatMap(record => record.messages);
    assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.content), [first, '等一下我说'], 'each line archived once, as said');
    const assistant = messages.filter(message => message.role === 'assistant').map(message => message.content);
    assert.equal(assistant.length, 2, 'one archive per reply');
    assert.equal(assistant.filter(content => content.includes('然后一起吃晚饭')).length, 1, 'the unspoken rest is not archived again (only her first reply, as written, holds it)');
    assert.ok(!messages.some(message => /打断|还没念出来|念出声/.test(message.content)), 'nothing of the note reaches the archive');
    assert.ok(!assistant[1].includes('然后一起吃晚饭'), 'her next reply is not the rest read on (the fake answers the user\'s line)');
    assert.deepEqual(rewards.filter(type => type === 'chat').length, 2, 'one acceptance per utterance');

    // the cut is one small record beside the whole reply, and the marker is metadata, never her words.
    await speechBeatsFor(directory).archive.flush();
    const scope = service.currentScope(), cutTurn = records.find(record => record.messages.some(message => message.role === 'assistant' && message.content.includes('然后一起吃晚饭')))!.messages[0].turnId;
    const filed = speechBeatsFor(directory).archive.get(scope, cutTurn)?.cut;
    assert.deepEqual(filed, { cause: 'user-spoke', known: true, saidEnd: s1.start, sentenceEnd: s1.end }, 'where her voice stopped, and why');
    const shown = service.recentChat().shown!, row = shown.find(item => item.cut)!;
    assert.deepEqual(row.cut, { at: s1.end, label: '（念到这一句时被打断）' });
    assert.equal(row.content, assistant[0], 'the row is her reply, whole and unchanged');
    assert.ok(!assistant.some(content => content.includes('打断')) && !row.content.includes('打断'), 'the marker is not part of her words (not archived, not read aloud)');
    const herWindow = speechBeatsFor(directory).longChatArchive(service.memory, false, 'zh-CN')!.chatWindowSource(scope).filter(message => message.role === 'assistant');
    assert.equal(herWindow.filter(message => message.content.includes('（念到这一句时被打断）')).length, 1, 'her history carries the same marker, once');
    assert.equal(herWindow[0].content, [assistant[0].slice(0, s1.end).trimEnd(), '（念到这一句时被打断）', assistant[0].slice(s1.end).trimStart()].join('\n'), 'at the cut point');
    assert.equal(herWindow[1].content, assistant[1], 'a reply that was said to the end has no marker');
    for (const entry of journal.filter(entry => entry.event === 'held' || entry.event === 'interrupt')) {
      const built = buildJournalEntry({ type: 'voice-call', characterId: 'c1', ...entry } as never, 1_800_000_000_000);
      assert.ok(built && typeof (built as { chars?: number }).chars === 'number', `journal keeps the numbers: ${JSON.stringify(entry)}`);
      assert.ok(!/等|公|散步/.test(JSON.stringify(built)), 'never the words');
      assert.match(describeJournalEntry(built!, (text: string, ...args: unknown[]) => args.reduce<string>((t, a, i) => t.replace(`{${i}}`, String(a)), text)), /认出 \d+ 个字/);
    }
  } finally {
    chatTimers.disposing(); host.dispose(); chat.dispose(); call.dispose(); chatTimers.graceOver();
    await host.drain(); await service.flush();
    const pids = (await claude.spawns()).map(spawn => spawn.pid), alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until(() => { chatTimers.graceOver(); return pids.every(pid => !alive(pid)); }, 'fake Claude processes to exit');
    await claude.cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('call: outside a call the same rule stops her (journal only); no note is made', async () => {
  const journal: VoiceCallJournalInput[] = [];
  const host = new VoiceCallHost({ now: () => 0, timers: { set: () => 0, clear() {} }, media: () => ({ voiceInput: true, voiceOwner: 'controls' }),
    turnOnVoice: () => true, turnOffVoice() {}, windowShown: () => true, asleep: () => false, ttsConfig: () => null, characterId: () => 'c1', mood: () => ({}),
    keepWarm() {}, broadcast() {}, journal: entry => journal.push(entry), directory: () => null, synthesize: async () => {} });
  assert.equal(host.heardOverHer('controls', 'chars', true, { text: '我想说', chars: 3, match: 0.1 }), false);
  assert.deepEqual(journal, [{ event: 'interrupt', by: 'chars', overHer: true, call: false, chars: 3, match: 0.1 }]);
  assert.equal(host.turnNote('zh-CN'), '');
  assert.equal(host.herText('她的话'), '她的话', 'no call: the echo check uses what the gate had');
  host.dispose();
});
