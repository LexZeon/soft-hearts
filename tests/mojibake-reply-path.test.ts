// "UTF-8 read as GBK" garbage on the real reply path (docs/claude/2026-11-03-mojibake-guard.md): the provider's deltas go
// through CompanionService.begin's turn exactly as main.ts wires it (bubble, streamed speech, archive), and a proactive
// remark from a shared frame goes through ProactiveVision. The model output is a fake: synthetic text, garbled the way the
// 2026-11-03 reply was (UTF-8 bytes read as GBK).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { ProactiveVision, type ProactiveVisionMessage } from '../electron/proactive-vision';
import { speakableText } from '../shared/speakable-text';

const garble = (text: string): string => new TextDecoder('gbk').decode(Buffer.from(text, 'utf8'));
/** Splits like a streaming provider: a lone first character, then pieces of a few characters. */
function deltas(text: string): string[] {
  const chars = [...text], out = [chars[0]];
  for (let i = 1; i < chars.length; i += 4) out.push(chars.slice(i, i + 4).join(''));
  return out;
}

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mojibake-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://mojibake.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

/** One chat turn wired like main.ts: each visible delta goes to the bubble and to the streamed speech; what was read comes back. */
async function chatTurn(service: CompanionService, id: string, userText: string, reply: (start: string, end: string) => string) {
  const bubble: string[] = [];
  const speech = new CompletedReplySpeech();
  const fence = speech.beginCommit(1, id, 'scope');
  let spokenText = '';
  const turn = await service.begin(id, userText, '角色名称：Gene', (type, text) => {
    if (type !== 'delta') return;
    speech.append(fence, text);
    spokenText += text;
    bubble.push(text);
  });
  const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
  for (const piece of deltas(reply(start, start.replace('<', '</')))) turn.push('delta', piece);
  await turn.finish('complete');
  speech.record(1, id, 'scope', spokenText, { prefix: true, fence });
  const spoken: string[] = [];
  for (let segment = speech.next(1, id, 'scope'); segment; segment = speech.next(1, id, 'scope', segment.index)) spoken.push(speakableText(segment.text));
  const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
  return { turn, bubble, spoken, record };
}

const tailFor = (start: string, end: string) => `\n${start}{"context":"support","delta":{"O":2},"reason":"安慰","confidence":0.9}${end}`;

test('a garbled reply reaches the bubble, the voice and the archive repaired, once, with its mood', async () => {
  await withService(async service => {
    const said = '面试没过不是你的问题，是他们没眼光。今天先好好休息，我陪着你。';
    const { turn, bubble, spoken, record } = await chatTurn(service, 'garbled-reply', '面试又没过', (start, end) => garble(said) + tailFor(start, end));
    const repaired = '面试没过不是你的问题，是他们没眼光。今天先好好休息，我陪着你'; // the last "。" lost its final byte in the garbling
    assert.equal(bubble.join(''), repaired);
    for (const piece of bubble) for (const char of piece) assert.ok(said.includes(char), `garbled ${JSON.stringify(char)} reached the bubble`);
    assert.equal(spoken.join(''), repaired);
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]),
      [['user', '面试又没过', 'complete'], ['assistant', repaired, 'complete']]);
    assert.equal(service.memory.list(turn.scope).total, 1, 'archived once');
    assert.equal(turn.emptyReply?.(), false);
    assert.ok(service.mood.get().snapshot.values.O > 50, 'the reply\'s mood tail still counts');
    assert.equal(turn.speechMood()?.context, 'support');
  });
});

test('an ordinary reply passes the same path byte for byte, and its first character goes out with the first delta', async () => {
  await withService(async service => {
    const said = '嗯……我愣了一下，但愿人长久，千里共婵娟。我們明天見～ 🌙';
    const { bubble, spoken, record } = await chatTurn(service, 'ordinary-reply', '晚安', (start, end) => said + tailFor(start, end));
    assert.equal(bubble[0], '嗯', 'the first delta is shown at once');
    assert.equal(bubble.join(''), said);
    assert.equal(spoken.join(''), said);
    assert.equal(record.messages[1].content, said);
  });
});

test('a reply that is nothing but undecodable garbage shows and speaks nothing and is archived as a failed reply', async () => {
  await withService(async service => {
    const { turn, bubble, spoken, record } = await chatTurn(service, 'garbage-only', '在吗', (start, end) => '鍐� 寮�' + tailFor(start, end));
    assert.equal(bubble.join('').trim(), '');
    assert.deepEqual(spoken, []);
    // Like a reply that was only an internal draft: a failed reply (the host answers with her own failure line), no mood.
    assert.equal(turn.emptyReply?.(), true);
    assert.deepEqual(record.messages.map(message => [message.role, message.content.trim(), message.status]),
      [['user', '在吗', 'complete'], ['assistant', '', 'error']]);
    assert.equal(turn.speechMood(), null);
    assert.equal(service.mood.get().snapshot.values.O, 50);
  });
});

test('a proactive remark from a shared frame is repaired before it is offered and archived', async () => {
  let now = 1000;
  const gate = new ProactiveSpeechGate(() => now); gate.setScope('scope');
  const offered: ProactiveVisionMessage[] = [], archived: ProactiveVisionMessage[] = [];
  const said = '屏幕上好像写着发生了什么事，要我帮你看看吗？';
  const engine = new ProactiveVision({ gate, clock: () => now,
    capture: async () => [{ source: 'screen', dataUrl: 'data:image/jpeg;base64,YQ==' }],
    generate: async () => garble(said),
    offer: message => { offered.push(message); }, current: () => true,
    present: async () => true, presentationCurrent: () => true,
    archive: async message => { archived.push(message); } });
  await engine.start('scope', { id: 'remark', kind: 'speech', until: 4000 }, true);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].text, '屏幕上好像写着发生了什么事，要我帮你看看吗');
  assert.equal(await engine.ack('remark'), true);
  for (let i = 0; i < 16; i++) await Promise.resolve();
  assert.equal(archived[0]?.text, offered[0].text);
  engine.dispose(); gate.dispose();
});
