// I-139 A1 chat (docs/claude/2026-11-15-i139-chat.md): with the switch on, the fixed system prompt, the per-turn assembly, the opening's
// layers, the lines said once per Claude process, and the labels. With it off, everything as before (byte for byte).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as T from '../shared/foundation/i139-texts';
import { getPromptSwitches, setPromptSwitches } from '../shared/brain/prompt-switches';
import { CLAUDE_FOLLOW_UP_HEADER, CLAUDE_SESSION_SYSTEM_PROMPT, OPENING_NOTE_HEADER, claudeSessionSystemPrompt, composePreparedOpening, composeSessionPrompt } from '../electron/brain/claude-session-prompt';
import { CLAUDE_CHAT_SYSTEM_PROMPT, claudeChatSystemPrompt } from '../electron/brain/claude';
import { OPENING_SYSTEM_SENTENCE } from '../electron/brain/reply-opening';
import { chatSettingsSystemText } from '../electron/brain/chat-settings';
import { COMPANION_WHY, COMPANION_WHY_SHORT } from '../shared/brain/companion-rules';
import { applyOnceSwaps, i139ChatEdge, openingLayers, perceptionOnceLine, planOnceLines, type OnceLine } from '../electron/brain/i139-chat';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import type { ClaudeChatProcess } from '../electron/brain/claude-process';
import { perceptionTurnLine, perceptionTurnState, SENSING_OFF_LINE } from '../shared/brain/perception-rule';
import { interconnectTurnLine } from '../electron/brain/interconnect-line';
import { CompanionService, withRealerEmotions } from '../electron/brain/companion';
import { REALER_EMOTIONS_CHAT_TEXT } from '../shared/mood/realer-emotions';
import { SPEAK_ONLY_REPLY_INSTRUCTION } from '../electron/brain/speak-only/rules';
import type { ProviderConfig } from '../shared/foundation/settings';
import { buildLongChatWindow, initiativeContent } from '../electron/brain/long-chat/window';
import { visitorContent, VISITOR_MARK } from '../shared/senses/visitor-turn';
import { faceTurnFor } from '../electron/senses/face/chat-turn';
import { FACE_STRANGER_LINE } from '../shared/senses/face-check';
import { CallOffers } from '../electron/voice/call-offers';
import { MoodHost } from '../electron/mood/mood';

const withSwitch = <R>(on: boolean, run: () => R): R => {
  const before = getPromptSwitches();
  setPromptSwitches({ ...before, ...(on ? { relaxed: true } : {}), ...(on ? {} : { relaxed: false }) });
  try { return run(); } finally { setPromptSwitches(before); }
};
const user = (content: string) => ({ role: 'user' as const, content });
const her = (content: string) => ({ role: 'assistant' as const, content });

// ---------------------------------------------------------------- the fixed system prompt

test('switch on: the fixed prompt is the agreed texts in the agreed order, nothing of the old rules or why', () => {
  const prompt = claudeSessionSystemPrompt({ relaxed: true, settingsCatalog: false, opening: true });
  const order = [T.SYSTEM_OPENING.zh, T.COMPANION_CARE.zh, T.PERCEPTION_RELAXED.zh, T.TECH_NOTES.zh].map(text => prompt.indexOf(text));
  assert.ok(order.every(at => at >= 0), 'every part is there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in order');
  assert.ok(prompt.startsWith(T.SYSTEM_OPENING.zh));
  assert.ok(prompt.endsWith(T.TECH_NOTES.zh + OPENING_SYSTEM_SENTENCE), 'the opening-marker sentence as today, last');
  for (const old of ['【陪伴规则】', '扮演', COMPANION_WHY, COMPANION_WHY_SHORT, '【为什么】', '【你能感知到什么】平时你看不到用户']) assert.ok(!prompt.includes(old), old);
  // This person: no pronoun anywhere; "用户" only in the bridge sentence and the unchanged opening-marker sentence.
  assert.doesNotMatch(prompt, /[他她]/u);
  assert.equal(prompt.split('用户').length - 1, 1 + (OPENING_SYSTEM_SENTENCE.split('用户').length - 1));
  // The settings catalog (only when the caller has it) sits between perception and the technical notes; the refusal section after the care text.
  const withCatalog = claudeSessionSystemPrompt({ relaxed: true, settingsCatalog: true, opening: false });
  assert.ok(withCatalog.indexOf(T.PERCEPTION_RELAXED.zh) < withCatalog.indexOf(chatSettingsSystemText()) && withCatalog.indexOf(chatSettingsSystemText()) < withCatalog.indexOf(T.TECH_NOTES.zh));
  const refusal = claudeSessionSystemPrompt({ relaxed: true, refusalRules: true, refusalText: 'REFUSAL', settingsCatalog: false });
  assert.ok(refusal.indexOf(T.COMPANION_CARE.zh) < refusal.indexOf('REFUSAL') && refusal.indexOf('REFUSAL') < refusal.indexOf(T.PERCEPTION_RELAXED.zh));
  assert.ok(!claudeSessionSystemPrompt({ relaxed: true, settingsCatalog: false }).includes('REFUSAL'));
});

test('switch on: the per-message fallback says the same as the persistent process (no catalog in either under speak-only)', () => {
  assert.equal(claudeChatSystemPrompt({ relaxed: true, opening: true }), claudeSessionSystemPrompt({ relaxed: true, settingsCatalog: false, opening: true }));
  assert.ok(claudeChatSystemPrompt({ relaxed: true, language: 'en' }).startsWith(T.SYSTEM_OPENING.en));
  assert.ok(claudeSessionSystemPrompt({ relaxed: true, language: 'en', settingsCatalog: false }).includes(T.COMPANION_CARE.en));
});

test('switch off: both fixed prompts are byte for byte the old ones; the global switch picks the new ones at call time', () => {
  assert.equal(claudeSessionSystemPrompt({ relaxed: false }), CLAUDE_SESSION_SYSTEM_PROMPT);
  assert.equal(claudeSessionSystemPrompt(), CLAUDE_SESSION_SYSTEM_PROMPT);
  assert.equal(claudeChatSystemPrompt(), CLAUDE_CHAT_SYSTEM_PROMPT);
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.includes('【陪伴规则】'));
  withSwitch(true, () => {
    assert.ok(claudeSessionSystemPrompt({ settingsCatalog: false }).startsWith(T.SYSTEM_OPENING.zh));
    assert.ok(claudeChatSystemPrompt().startsWith(T.SYSTEM_OPENING.zh));
  });
});

// ---------------------------------------------------------------- per turn and the opening

const base = '角色名称：Gene\n性格：温柔';
const plan = (opening: boolean) => ({ opening, history: opening ? [user('早'), her('早呀')] : [] });

test('switch on: a follow-up leads with the new header; the opening has layer 1, layer 2 and her note in her own words', () => {
  const relaxed = { name: 'Gene', language: 'zh-CN' as const };
  const turnPersona = `${base}\n\n熟悉度一行\n\n心情一行`;
  const follow = composeSessionPrompt({ plan: plan(false), basePersona: base, turnPersona, openingContext: '熟悉度一行', current: user('在吗'), relaxed });
  assert.ok(follow.startsWith(`${T.FOLLOW_UP_HEADER.zh}\n\n心情一行`), 'header, then only this turn\'s own context');
  assert.ok(!follow.includes(CLAUDE_FOLLOW_UP_HEADER) && !follow.includes('熟悉度一行'));
  const memory = { date: '2026 年 11 月 11 日晚上', text: '这个人说了一句很暖的话' };
  const opening = composeSessionPrompt({ plan: plan(true), basePersona: base, turnPersona, openingContext: '熟悉度一行', current: user('在吗'), relaxed, openingNote: '我注意到……', openingMemory: memory });
  const one = T.openingLayerOne('Gene'), two = T.openingLayerTwo(memory);
  assert.ok(opening.startsWith(`${one}\n\n${two}\n\n${base}\n\n熟悉度一行\n\n${T.OPENING_NOTE_HEADER_RELAXED.zh}\n我注意到……\n\n心情一行`), opening.slice(0, 300));
  assert.ok(!opening.includes(OPENING_NOTE_HEADER));
  // No memory yet (A3 not there): layer 1 only; layer 1 precedes the persona.
  const bare = composeSessionPrompt({ plan: plan(true), basePersona: base, turnPersona, current: user('在吗'), relaxed });
  assert.ok(bare.startsWith(`${one}\n\n${base}`));
  // English card.
  const en = composeSessionPrompt({ plan: plan(true), basePersona: base, turnPersona, current: user('hi'), relaxed: { name: 'Gene', language: 'en' } });
  assert.ok(en.startsWith(T.openingLayerOne('Gene', 'en')));
  assert.ok(composeSessionPrompt({ plan: plan(false), basePersona: base, turnPersona, current: user('hi'), relaxed: { name: 'Gene', language: 'en' } }).startsWith(T.FOLLOW_UP_HEADER.en));
  assert.equal(openingLayers({ name: '  ' }), '', 'a nameless card gets no invented layer 1');
});

test('switch off: the same inputs give exactly the old messages', () => {
  const turnPersona = `${base}\n\n熟悉度一行\n\n心情一行`;
  const follow = composeSessionPrompt({ plan: plan(false), basePersona: base, turnPersona, openingContext: '熟悉度一行', current: user('在吗') });
  assert.ok(follow.startsWith(`${CLAUDE_FOLLOW_UP_HEADER}\n\n心情一行`));
  const opening = composeSessionPrompt({ plan: plan(true), basePersona: base, turnPersona, openingContext: '熟悉度一行', current: user('在吗'), openingNote: '笔记' });
  assert.ok(opening.startsWith(`${base}\n\n熟悉度一行\n\n${OPENING_NOTE_HEADER}\n笔记`));
  assert.equal(composeSessionPrompt({ plan: plan(true), basePersona: base, turnPersona, current: user('在吗'), relaxed: null, openingMemory: { date: 'd', text: 't' } }),
    composeSessionPrompt({ plan: plan(true), basePersona: base, turnPersona, current: user('在吗') }), 'layer 2 needs the switch');
});

test('prewarm: the prepared opening puts the layers in front too (the next turn is an ordinary follow-up)', () => {
  const relaxed = { name: 'Gene', language: null };
  const memory = { date: '昨天', text: '一起看了雪' };
  const prepared = composePreparedOpening({ basePersona: base, openingContext: '熟悉度一行', openingNote: '笔记', history: [user('a'), her('b')], relaxed, openingMemory: memory });
  assert.ok(prepared.startsWith(`${T.openingLayerOne('Gene')}\n\n${T.openingLayerTwo(memory)}\n\n${base}\n\n熟悉度一行\n\n${T.OPENING_NOTE_HEADER_RELAXED.zh}\n笔记\n\n`));
  assert.ok(composePreparedOpening({ basePersona: base, history: [] }).startsWith(base), 'off: as before');
});

// ---------------------------------------------------------------- said once per Claude process

test('once-lines: first time said (fresh form), then left out while unchanged, said again on change, a picture or news', () => {
  const told = new Map<string, string>();
  const line: OnceLine = { key: 'perception', text: '【此刻的感知】A', stable: '【此刻的感知】A', fresh: '【此刻的感知】A，听不到声音' };
  const first = planOnceLines(told, [line], false);
  assert.deepEqual(first.swaps, [{ from: line.text, to: line.fresh }]);
  for (const [key, value] of first.tell) told.set(key, value);
  assert.deepEqual(planOnceLines(told, [line], false).swaps, [{ from: line.text, to: '' }], 'unchanged: left out');
  assert.deepEqual(planOnceLines(told, [line], true).swaps, [], 'a picture turn always says it');
  assert.deepEqual(planOnceLines(told, [{ ...line, always: true }], false).swaps, [], 'news always says it');
  assert.deepEqual(planOnceLines(told, [{ key: 'perception', text: '【此刻的感知】B' }], false).swaps, [], 'changed: said');
  assert.deepEqual(planOnceLines(new Map(), [line], false).tell, [['perception', line.stable]], 'a new process starts empty');
});

test('applyOnceSwaps removes a whole line with its separator, and never a partial match', () => {
  assert.equal(applyOnceSwaps('甲\n\n乙\n\n丙', [{ from: '乙', to: '' }]), '甲\n\n丙');
  assert.equal(applyOnceSwaps('甲\n\n乙', [{ from: '乙', to: '' }]), '甲');
  assert.equal(applyOnceSwaps('甲\n乙\n丙', [{ from: '乙', to: '' }]), '甲\n丙');
  assert.equal(applyOnceSwaps('乙\n\n丙', [{ from: '乙', to: '' }]), '丙');
  assert.equal(applyOnceSwaps('甲乙丙', [{ from: '乙', to: '' }]), '甲乙丙', 'inside a line: untouched (said once more is the safe side)');
  assert.equal(applyOnceSwaps('甲\n\n乙\n\n丙', [{ from: '乙', to: '丁' }]), '甲\n\n丁\n\n丙');
});

test('perception once-line: the sight part decides "the same"; a picture, a touch or a hearing sentence is news', () => {
  const off = perceptionTurnState({ screenSharing: false, cameraSharing: false }, [], '在干嘛');
  const quiet = { hearing: { source: null, stage: null, transcript: false }, contacts: [], say: 'none' as const };
  const plain = perceptionOnceLine(off, quiet);
  assert.equal(plain.text, perceptionTurnLine(off, quiet));
  assert.equal(plain.stable, perceptionTurnLine(off));
  assert.equal(plain.always, undefined);
  assert.ok(plain.fresh && plain.fresh !== plain.text, 'a new process hears about hearing too');
  assert.equal(perceptionOnceLine(off, { ...quiet, contacts: ['pat'] }).always, true, 'a touch is news');
  const looked = perceptionTurnState({ screenSharing: true, cameraSharing: false }, [{ source: 'screen' }], '看看我的屏幕');
  assert.equal(perceptionOnceLine(looked, quiet).always, true, 'a picture always says its line');
  assert.equal(perceptionOnceLine(off, quiet, true).always, true, 'a sound note always says it');
  assert.ok(perceptionTurnLine(off).includes(SENSING_OFF_LINE));
});

// A fake Claude process: records each message's text; answers "嗯".
class FakeProcess {
  alive = true; busy = false; turnsStarted = 0; readonly sent: string[] = [];
  constructor(readonly model: string, private readonly log: string[] = []) {}
  async settled() {}
  close() { this.alive = false; }
  supersede() { return false; }
  async runTurn(line: string, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) {
    this.turnsStarted++;
    const parsed = JSON.parse(line) as { message: { content: { type: string; text?: string }[] } };
    this.sent.push(parsed.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    this.log.push(this.sent.at(-1)!);
    emit('delta', '嗯');
    return { output: '嗯', superseded: false };
  }
}

test('per process: a line is said on the first turn, left out after, said on change and on a picture turn, and again on a new process', async () => {
  const processes: FakeProcess[] = [], log: string[] = [];
  const chat = new PersistentClaudeChat({ binary: async () => 'claude', startProcess: async options => { const p = new FakeProcess(options.model, log); processes.push(p); return p as unknown as ClaudeChatProcess; } });
  const off = perceptionTurnState({ screenSharing: false, cameraSharing: false }, [], '嗯');
  const sight = perceptionTurnLine(off);
  let interconnect = true;
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const relaxed = { name: 'Gene', language: null };
  const turn = async (text: string, images: string[] = []) => {
    const fact = interconnectTurnLine(interconnect, relaxed);
    const persona = `${base}\n\n心情一行\n\n${fact}\n\n${sight}`;
    history.push(user(text));
    const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: '.', writable: false, prompt: 'unused', imageDataUrls: images,
      session: { key: 'k', basePersona: base, persona, messages: [...history], relaxed,
        onceLines: () => [{ key: 'interconnect', text: fact }, perceptionOnceLine(images.length ? { ...off, attached: { screen: true, camera: false } } : off)] } };
    await chat.stream(task, new AbortController().signal, () => {});
    history.push(her('嗯'));
    return log.at(-1)!;
  };
  try {
    const first = await turn('你好');
    assert.ok(first.startsWith(T.openingLayerOne('Gene')), 'the opening starts with layer 1');
    assert.ok(first.includes(interconnectTurnLine(true, relaxed)) && first.includes(sight), 'first turn: both lines');
    const second = await turn('在吗');
    assert.ok(second.startsWith(T.FOLLOW_UP_HEADER.zh));
    assert.ok(!second.includes('三方互通') && !second.includes('【此刻的感知】'), 'unchanged: neither line');
    assert.ok(second.includes('心情一行'));
    interconnect = false;
    const third = await turn('嗯嗯');
    assert.ok(third.includes(interconnectTurnLine(false, relaxed)) && !third.includes('【此刻的感知】'), 'only the line that changed');
    const picture = await turn('看看', ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==']);
    assert.ok(picture.includes('【此刻的感知】'), 'a picture turn always says its line');
    assert.equal(processes.length >= 2, true, 'a picture retires the process');
    const fresh = await turn('还在吗');
    const serving = processes.find(p => p.sent.at(-1) === fresh)!;
    assert.equal(serving.sent.length, 1, 'the next turn is the new process\'s first');
    assert.ok(fresh.startsWith(T.openingLayerOne('Gene')), 'and opens with layer 1 again');
    assert.ok(fresh.includes('三方互通') && fresh.includes('【此刻的感知】'), 'a new process hears every line again');
    assert.equal(log.length, 5);
  } finally { chat.dispose(); }
});

test('switch off (no onceLines, no relaxed): every turn carries every line, as before', async () => {
  const processes: FakeProcess[] = [];
  const chat = new PersistentClaudeChat({ binary: async () => 'claude', startProcess: async options => { const p = new FakeProcess(options.model); processes.push(p); return p as unknown as ClaudeChatProcess; } });
  const fact = interconnectTurnLine(true);
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  try {
    for (const text of ['一', '二', '三']) {
      history.push(user(text));
      await chat.stream({ kind: 'chat', model: 'haiku', workingDirectory: '.', writable: false, prompt: 'unused',
        session: { key: 'k', basePersona: base, persona: `${base}\n\n${fact}`, messages: [...history] } }, new AbortController().signal, () => {});
      history.push(her('嗯'));
    }
    const sent = processes[0]!.sent;
    assert.equal(sent.length, 3);
    assert.ok(sent.every(message => message.includes(fact)));
    assert.ok(sent[1]!.startsWith(CLAUDE_FOLLOW_UP_HEADER));
  } finally { chat.dispose(); }
});

// ---------------------------------------------------------------- the per-turn texts

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://first.example/v1', model: 'a' };
async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i139-chat-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', provider, 'Gene'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('switch on: a chat turn carries the rhythm sentence and the light mood line: no numbers, nothing about hormones', async () => {
  await withService(async service => {
    service.setSpeakOnly({ ask: async () => JSON.stringify({ context: 'support', delta: { O: 4 }, reason: '被关心', confidence: 0.9, gesture: 'none' }) });
    const before = getPromptSwitches();
    setPromptSwitches({ ...before, relaxed: true });
    try {
      const turn = await service.begin('i139-1', '今天好累', 'Gene', () => {});
      assert.ok(turn.persona.includes(T.RHYTHM_LINE.zh));
      assert.ok(!turn.persona.includes(SPEAK_ONLY_REPLY_INSTRUCTION) && !turn.persona.includes('自然地问起对方的事'));
      assert.ok(!/当前角色内在状态|\/100|激素|报数|数值/u.test(turn.persona), 'no numbers and no denial sentences');
      assert.match(turn.persona, /你现在/u);
      await turn.finish('stopped');
      service.setLanguageSource(() => 'en');
      const english = await service.begin('i139-2', 'so tired', 'Gene', () => {});
      assert.ok(english.persona.includes(T.RHYTHM_LINE.en));
      assert.match(english.persona, /Right now you /u);
      await english.finish('stopped');
    } finally { setPromptSwitches(before); }
  });
});

test('speed (R28): a turn\'s own text under the switch is shorter than today\'s speak-only turn, header included', async t => {
  await withService(async service => {
    service.setSpeakOnly({ ask: async () => JSON.stringify({ context: 'support', delta: { O: 4 }, reason: '被关心', confidence: 0.9, gesture: 'none' }) });
    const before = getPromptSwitches();
    const own = async (id: string, relaxed: boolean) => {
      setPromptSwitches({ ...before, ...(relaxed ? { relaxed: true } : { relaxed: false }) });
      try {
        const turn = await service.begin(id, '今天好累', 'Gene', () => {});
        const context = turn.persona.slice(turn.persona.indexOf('Gene') + 'Gene'.length);
        await turn.finish('stopped');
        return (relaxed ? T.FOLLOW_UP_HEADER.zh : CLAUDE_FOLLOW_UP_HEADER).length + context.length;
      } finally { setPromptSwitches(before); }
    };
    const today = await own('speed-1', false), relaxed = await own('speed-2', true);
    t.diagnostic(`turn text: speak-only ${today} chars, I-139 ${relaxed} chars`);
    assert.ok(relaxed < today, `${relaxed} < ${today}`);
  });
});

test('the light mood line: plain words, no pronoun for this person, the guards kept as situation', () => {
  const line = T.moodLightLine({ primary: 'longing', companion: 'wistful', context: 'concern', reason: '很久没说话', since: 'hours', tired: 'drowsy' });
  assert.match(line, /有点想这个人|惦记着这个人/u);
  assert.match(line, /起因是很久没说话/u);
  assert.doesNotMatch(line, /不是冲着你|照样好好回这个人|不用每次都提困/u, 'the directives are gone (rules removal 2026-11-25)');
  assert.doesNotMatch(line, /[A-Za-z0-9]|[他她]|用户/u);
  assert.match(T.moodLightLine({ primary: 'happy', welcome: true }), /隔了一阵子/u);
  assert.doesNotMatch(T.moodLightLine({ primary: 'happy', welcome: true }), /不惩罚|不翻旧账|先和好|撒个娇/u);
  assert.equal(T.moodLightLine({ primary: 'calm', reason: 'D+3' }).includes('D+3'), false, 'a reason with letters or digits is left out in Chinese');
  assert.match(T.moodLightLine({ primary: 'sad', reason: 'a rough day' }, 'en'), /because: a rough day/u);
  assert.doesNotMatch(T.moodLightLine({ primary: 'sad', reason: '有效摸头' }, 'en'), /有效/u);
});

test('the mood host: switch on gives the light line, its numbers untouched; off the old text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i139-mood-'));
  const mood = new MoodHost(directory, () => {}, () => 1_000_000);
  try {
    await mood.load(); mood.activate('gene');
    const old = mood.chatContext();
    const light = mood.chatContext({ relaxed: true });
    assert.match(old, /\/100/u);
    assert.ok(light && !/[A-Za-z0-9]/u.test(light), light);
    assert.equal(mood.chatContext(), old);
  } finally { await mood.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- labels and dangling references

test('labels under the switch: stranger, visitor, her own lines in the window; off as before', async () => {
  const face = { host: { state: () => 'not-you' as const, strangerLine: () => FACE_STRANGER_LINE }, checkPhoto: async () => 'not-you' as const };
  assert.equal((await faceTurnFor(face, null, T.STRANGER_LINE.zh)).line, T.STRANGER_LINE.zh);
  assert.equal((await faceTurnFor(face, null)).line, FACE_STRANGER_LINE);
  const edge = i139ChatEdge({ on: () => true, card: () => ({ name: 'Gene', language: 'en' }) });
  assert.deepEqual(edge.relaxed(), { name: 'Gene', language: 'en' });
  assert.equal(edge.stranger(edge.relaxed()), T.STRANGER_LINE.en);
  assert.equal(i139ChatEdge({ on: () => false, card: () => ({ name: 'Gene' }) }).relaxed(), null);
  assert.equal(i139ChatEdge({ on: () => { throw new Error('x'); }, card: () => null }).labels(), null);

  assert.equal(visitorContent('你好'), `${VISITOR_MARK}你好`);
  assert.equal(visitorContent('你好', T.VISITOR_MARK_RELAXED.zh), `${T.VISITOR_MARK_RELAXED.zh}你好`);
  const origin = (sources: string[], labels: string[]) => ({ kind: 'proactive', id: 'x', at: 1, sources, labels }) as unknown as Parameters<typeof initiativeContent>[0];
  const labels = { relaxed: true, language: null };
  assert.equal(initiativeContent(origin(['ambient'], ['外部音频资料']), '好听', labels), `${T.AMBIENT_LABEL_RELAXED.zh}\n好听`);
  assert.equal(initiativeContent(origin(['screen'], ['屏幕']), '在写代码呀', labels), '[你自己主动说的（屏幕）] 在写代码呀');
  assert.equal(initiativeContent(origin(['screen'], ['屏幕']), '在写代码呀'), '[角色主动观察：屏幕] 在写代码呀');
  const at = new Date(2026, 10, 15, 12).getTime();
  const window = buildLongChatWindow({ messages: [{ role: 'user', content: '我是访客', createdAt: at - 1000, speaker: 'visitor' }], now: at,
    knobs: { beforeDay: 3, dayStartHour: 4, windowMaxChars: 100_000 }, labels });
  assert.ok(window.history[0]!.content.includes(`${T.VISITOR_MARK_RELAXED.zh}我是访客`));
  assert.ok(!window.history[0]!.content.includes(VISITOR_MARK));
});

test('"更真实的情绪" under the switch points at the care text, never at a numbered rule; off unchanged', () => {
  const on = withRealerEmotions(null, true, { language: null })!;
  // I-206: the care text no longer carries the guilt / make-up-first wording, so the paragraph no longer quotes it.
  assert.doesNotMatch(on.text, /撒个娇就好|你先和好/u, 'the quoted per-turn phrases are gone, so the paragraph no longer points at them (rules removal 2026-11-25)');
  assert.doesNotMatch(on.text, /愧疚|内疚|找台阶/);
  assert.doesNotMatch(on.text, /陪伴规则|第 ?\d+ ?条|[他她]/u);
  for (const kept of ['非常难过、接近想轻生的程度，或流露伤害自己的念头时，你不加码，先陪着', '现实里能帮上忙的人', '以每条消息里的说明为准', 'Claude 自己的安全规则不变']) assert.ok(on.text.includes(kept), kept);
  assert.equal(withRealerEmotions(null, true)!.text, REALER_EMOTIONS_CHAT_TEXT);
  assert.ok(withRealerEmotions(null, true, { language: 'en' })!.text.startsWith('[Realer emotions]'));
});

test('call offers: under the switch the 三方互通 line is the relaxed one and comes back as a once-line', () => {
  const ports = { takeMeThere: { beginTurn: () => ({ destination: null }) as never, offer: () => null }, chatSettings: { beginTurn: () => ({ instruction: undefined, ticket: 1 }) as never, offer: () => null }, interconnected: () => true };
  const off = new CallOffers(ports).begin('你好');
  assert.equal(off.note, '\n' + interconnectTurnLine(true));
  assert.equal(off.once, undefined);
  const on = new CallOffers({ ...ports, relaxed: () => ({ language: null }) }).begin('你好');
  assert.equal(on.note, '\n' + T.interconnectLineRelaxed(true));
  assert.deepEqual(on.once, { key: 'interconnect', text: T.interconnectLineRelaxed(true) });
});
