import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { MoodHost } from '../electron/mood';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { NEUTRAL_TENDENCIES, NICKNAME_ASK_INSTRUCTION } from '../shared/relationship';
import { CLAUDE_FOLLOW_UP_HEADER, composeSessionPrompt, withoutOpeningContext } from '../electron/claude-session-prompt';
import { buildCompanionPersona } from '../electron/conversation-context';
import { localDateKey } from '../electron/diary/diary-dates';
import type { MoodInput } from '../shared/mood-runtime';

const provider = { kind: 'claude' as const, baseUrl: 'https://relationship.invalid/v1', model: 'fixture' };

async function withService(run: (service: CompanionService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-relationship-chat-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', provider, 'Gene'); await run(service, directory); }
  finally {
    await service.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('soft-relationship-chat-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
/** One finished chat turn; `tail` fields are added to the state tail. */
async function chat(service: CompanionService, id: string, text: string, tail: Record<string, unknown> = {}, options: Parameters<CompanionService['begin']>[4] = {}) {
  const turn = await service.begin(id, text, 'Gene', () => {}, options);
  const marker = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(marker);
  turn.push('delta', `好的。\n${marker}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.9, reason: '测试', ...tail })}${marker.replace('<', '</')}`);
  await turn.finish('complete');
  await service.relationship.flush();
  return turn;
}

test('the first chat already says how long they have known each other, in the opening lines only, and the default is familiar', async () => {
  await withService(async service => {
    const turn = await chat(service, 't1', '你好');
    assert.match(turn.relationshipOpening!, /你们认识第 1 天/);
    assert.match(turn.relationshipOpening!, /从一开始就和用户很熟/);
    assert.doesNotMatch(turn.relationshipOpening!, /现在的关系/);
    assert.equal(turn.relationshipTag, 'off|');
    assert.equal(turn.relationshipMemes, true);
    // The lines sit right after the persona in the composed text.
    assert.ok(turn.persona.startsWith(`Gene\n\n${turn.relationshipOpening}\n\n`));
    const opening = composeSessionPrompt({ plan: { opening: true, history: [] }, basePersona: 'Gene', turnPersona: turn.persona, openingContext: turn.relationshipOpening,
      current: { role: 'user', content: '你好' } });
    assert.ok(opening.startsWith('Gene\n\n【你们的关系】你们认识第 1 天'));
    const followUp = composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: 'Gene', turnPersona: turn.persona, openingContext: turn.relationshipOpening,
      current: { role: 'user', content: '再说一句' } });
    assert.ok(followUp.startsWith(CLAUDE_FOLLOW_UP_HEADER));
    assert.doesNotMatch(followUp, /你们的关系|认识第/);
    // Byte for byte what a follow-up turn was before this feature existed: no per-turn cost (R28).
    const before = composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: 'Gene', turnPersona: turn.persona.replace(`${turn.relationshipOpening}\n\n`, ''),
      current: { role: 'user', content: '再说一句' } });
    assert.equal(followUp, before);
  });
});

test('counting through the real chat path: three finished rounds make one day; failed or stopped turns do not', async () => {
  await withService(async service => {
    await chat(service, 'a1', '一');
    await chat(service, 'a2', '二');
    const stopped = await service.begin('a3', '三', 'Gene', () => {});
    stopped.push('delta', '半句');
    await stopped.finish('stopped');
    await service.relationship.flush();
    assert.equal(service.relationship.view('gene')?.togetherDays, 0, 'a stopped turn is not a round');
    await chat(service, 'a4', '三');
    assert.equal(service.relationship.view('gene')?.togetherDays, 1);
    for (let i = 0; i < 6; i++) await chat(service, `b${i}`, `又聊 ${i}`);
    assert.equal(service.relationship.view('gene')?.togetherDays, 1, 'the same day counts once');
  });
});

test('switching the card on or off changes the next opening lines at once, and a stage change restarts the session tag', async () => {
  await withService(async service => {
    await chat(service, 'a1', '一');
    let on = false;
    service.relationship.setCardSource(() => ({ slowWarmUp: on, tendencies: { ...NEUTRAL_TENDENCIES } }));
    const off = await chat(service, 'a2', '二');
    assert.equal(off.relationshipTag, 'off|');
    on = true;
    const warm = await chat(service, 'a3', '三');
    assert.match(warm.relationshipOpening!, /现在的关系：初识/);
    assert.equal(warm.relationshipTag, 'new|');
    assert.equal(warm.relationshipMemes, false, 'memes wait until 熟悉 for a card that warms up slowly');
    on = false;
    const back = await chat(service, 'a4', '四');
    assert.equal(back.relationshipTag, 'off|');
    assert.doesNotMatch(back.relationshipOpening!, /现在的关系/);
    assert.equal(back.relationshipMemes, true);
  });
});

test('the nickname question rides one turn\'s tail; a plain yes on the next message saves it and the lines then carry it', async () => {
  await withService(async service => {
    await chat(service, 'a1', '你好呀');
    await chat(service, 'a2', '今天天气不错');
    // Third message of the day: she may ask. The instruction is in that turn's tail text only.
    const asking = await service.begin('a3', '我想去散步', 'Gene', () => {});
    assert.ok(asking.persona.includes(NICKNAME_ASK_INSTRUCTION));
    const marker = asking.persona.match(/<sh-state-[a-f0-9]+>/)![0];
    asking.push('delta', `好呀，去走走。以后叫你小糖好不好？\n${marker}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.9, reason: '闲聊', nick: '小糖' })}${marker.replace('<', '</')}`);
    await asking.finish('complete');
    await service.relationship.flush();
    assert.equal(service.relationship.nickname('gene'), null, 'asking is not saving');
    assert.equal(service.relationship.view('gene')?.nicknameAsked, true);
    // The very next message answers it.
    const answer = await chat(service, 'a4', '好呀');
    assert.equal(service.relationship.nickname('gene'), '小糖');
    assert.match(answer.relationshipOpening!, /用户同意你这样称呼用户：“小糖”/);
    assert.equal(answer.relationshipTag, 'off|小糖', 'a new nickname reopens the session so she uses it');
    assert.equal(answer.persona.includes(NICKNAME_ASK_INSTRUCTION), false, 'she does not ask twice');
  });
});

test('a refusal, a change of subject or a skipped answer saves nothing, and she never asks again', async () => {
  for (const reply of ['不要', '今天好累啊', '好']) {
    await withService(async service => {
      await chat(service, 'a1', '你好呀');
      await chat(service, 'a2', '今天天气不错');
      const asking = await service.begin('a3', '我想去散步', 'Gene', () => {});
      const marker = asking.persona.match(/<sh-state-[a-f0-9]+>/)![0];
      asking.push('delta', `好呀。叫你小糖好不好？\n${marker}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.9, reason: '闲聊', nick: '小糖' })}${marker.replace('<', '</')}`);
      await asking.finish('complete');
      if (reply === '好') {
        // The user's next message is something else entirely; a later yes is not the answer to the question.
        await chat(service, 'a4', '先说别的');
      }
      const answer = await chat(service, 'a5', reply);
      assert.equal(service.relationship.nickname('gene'), null, reply);
      for (let i = 0; i < 4; i++) {
        const later = await chat(service, `later${i}`, `再聊一句 ${i}`);
        assert.equal(later.persona.includes(NICKNAME_ASK_INSTRUCTION), false, 'no second question');
      }
      assert.equal(answer.persona.includes(NICKNAME_ASK_INSTRUCTION), false);
    });
  }
});

test('the question is not put on turns that already carry a memorial proposal or a settings proposal', async () => {
  await withService(async service => {
    await chat(service, 'a1', '你好呀');
    await chat(service, 'a2', '今天天气不错');
    const settings = await service.begin('a3', '把音量调小一点', 'Gene', () => {}, { settingProposal: { instruction: () => '【设置提议】测试' } });
    assert.equal(settings.persona.includes(NICKNAME_ASK_INSTRUCTION), false);
    await settings.finish('stopped');
    const later = await service.begin('a4', '我想去散步', 'Gene', () => {});
    assert.ok(later.persona.includes(NICKNAME_ASK_INSTRUCTION), 'the chance is still there on a plain turn');
    await later.finish('stopped');
  });
});

test('the tail\'s nick field: read only on a turn that may ask; a bad one is dropped without losing the rest of the tail', () => {
  const parse = (options: { nicknameAsk?: boolean } | undefined, extra: Record<string, unknown>) => {
    const protocol = new MoodReplyProtocol(() => {}, options);
    protocol.push(`好呀。\n${protocol.start}${JSON.stringify({ context: 'support', delta: { O: 2 }, confidence: 0.9, reason: '受到关心', ...extra })}${protocol.end}`);
    return { appraisal: protocol.finish(), nick: protocol.nickname(), instruction: protocol.instruction() };
  };
  const asking = parse({ nicknameAsk: true }, { nick: '小糖' });
  assert.equal(asking.nick, '小糖'); assert.equal(asking.appraisal?.delta.O, 2);
  assert.ok(asking.instruction.includes(NICKNAME_ASK_INSTRUCTION));
  const plain = parse(undefined, { nick: '小糖' });
  assert.equal(plain.nick, null, 'a stray nick on an ordinary turn is ignored');
  assert.equal(plain.appraisal?.delta.O, 2, 'and the tail itself is still valid');
  assert.equal(plain.instruction.includes(NICKNAME_ASK_INSTRUCTION), false);
  for (const bad of ['', '这个称呼实在是太长太长了', '<b>', 5, null, ['小糖']]) {
    const result = parse({ nicknameAsk: true }, { nick: bad });
    assert.equal(result.nick, null, JSON.stringify(bad));
    assert.equal(result.appraisal?.delta.O, 2, 'only the nickname is lost: ' + JSON.stringify(bad));
  }
  // An unknown key still drops the whole tail, as before.
  assert.equal(parse({ nicknameAsk: true }, { mystery: 1 }).appraisal, null);
  // Not accepted tail, no nick.
  const protocol = new MoodReplyProtocol(() => {}, { nicknameAsk: true });
  protocol.push(`好。${protocol.start}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.9, nick: '小糖' })}${protocol.end}`);
  assert.equal(protocol.finish(false), null); assert.equal(protocol.nickname(), null);
});

test('a touch or a feeding counts toward the day only together with a chat round; the real interaction path reports it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-relationship-mood-'));
  const clock = { now: 1_000_000 };
  const host = new MoodHost(directory, () => {}, () => clock.now);
  const seen: string[] = [];
  try {
    await host.load();
    host.activate('gene');
    host.setInteractionObserver(id => seen.push(id));
    const input = (value: Omit<MoodInput, 'token'> | Record<string, unknown>) => host.interaction({ token: host.get().token, ...value } as MoodInput);
    input({ type: 'phase', sessionId: 'touch', phase: 'rua' });
    clock.now += 100;
    input({ type: 'rua', sessionId: 'touch', id: 'first', activeMs: 100 });
    assert.deepEqual(seen, ['gene']);
    input({ type: 'phase', sessionId: 'meal', phase: 'food-wait' });
    clock.now += 500;
    input({ type: 'phase', sessionId: 'meal', phase: 'food-ready' });
    input({ type: 'food', sessionId: 'meal', id: 'release' });
    assert.deepEqual(seen, ['gene', 'gene']);
    assert.throws(() => input({ type: 'food', sessionId: 'meal', id: 'again' }), /松手/);
    assert.equal(seen.length, 2, 'a refused interaction is not counted');
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  await withService(async service => {
    const day = localDateKey(Date.now());
    await service.relationship.noteTouch('gene');
    assert.equal(service.relationship.view('gene')?.togetherDays ?? 0, 0, 'a touch with no chat is not a day');
    await chat(service, 'a1', '你好');
    assert.equal(service.relationship.view('gene')?.togetherDays, 1, 'a round plus a touch is');
    assert.ok(day);
  });
});

test('withoutOpeningContext takes the lines out of a follow-up turn and nothing else', () => {
  assert.equal(withoutOpeningContext('关系\n\n心情\n\n尾注', '关系'), '心情\n\n尾注');
  assert.equal(withoutOpeningContext('关系', '关系'), '');
  assert.equal(withoutOpeningContext('心情\n\n关系', '关系'), '心情\n\n关系', 'only when they lead');
  assert.equal(withoutOpeningContext('心情', ''), '心情');
  assert.equal(withoutOpeningContext('心情', undefined), '心情');
  const persona = buildCompanionPersona({ persona: '人设', relationship: '关系', stateContext: '心情', memories: [], protocolInstruction: '尾注' });
  assert.ok(persona.startsWith('人设\n\n关系\n\n心情'));
  assert.ok(!buildCompanionPersona({ persona: '人设', stateContext: '心情', memories: [], protocolInstruction: '尾注' }).includes('关系'));
});
