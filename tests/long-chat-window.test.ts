// I-134 new chat: the host-built window (electron/brain/long-chat/window.ts), the knobs, the archive's source and the way a warm session
// lines up with a window whose front moved. Pure parts first; the archive part runs the real MemoryStore in a temporary folder.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLongChatWindow, clampMessage, initiativeContent, localDayStart, LONG_CHAT_MESSAGE_MAX, type LongChatSourceMessage } from '../electron/brain/long-chat/window';
import { longChatMessages } from '../electron/brain/long-chat/host';
import { timeMarker } from '../electron/brain/long-chat/history';
import { LONG_CHAT_KNOBS, LONG_CHAT_STABLE, longChatEnabled, resolveLongChatKnobs } from '../shared/behaviors/long-chat/knobs';
import { planSessionTurn } from '../electron/brain/claude-session-prompt';
import { MemoryStore } from '../electron/memory/memory';
import type { ChatMessage } from '../shared/foundation/chat';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const knobs = { beforeDay: 3, dayStartHour: 4, windowMaxChars: 100_000 };
const user = (content: string, createdAt: number): LongChatSourceMessage => ({ role: 'user', content, createdAt });
const her = (content: string, createdAt: number): LongChatSourceMessage => ({ role: 'assistant', content, createdAt });

test('knobs: on in every channel, stable and the public release included; SOFT_HEARTS_LONG_CHAT forces either way', () => {
  assert.equal(LONG_CHAT_STABLE, true);
  assert.equal(longChatEnabled('development', true), true);
  assert.equal(longChatEnabled('stable', true), true);
  assert.equal(longChatEnabled(null, false), true);
  assert.equal(longChatEnabled(undefined, true), true, 'a packaged build outside the managed channels takes the stable value');
  assert.equal(longChatEnabled('stable', true, { SOFT_HEARTS_LONG_CHAT: '0' }), false);
  assert.equal(longChatEnabled('development', true, { SOFT_HEARTS_LONG_CHAT: '0' }), false);
  const resolved = resolveLongChatKnobs('development', true);
  assert.deepEqual({ ...resolved }, { ...LONG_CHAT_KNOBS, enabled: true });
  assert.ok(Object.isFrozen(resolved));
});

test('window: all of the current local day plus beforeDay messages before it, by time, with markers decided on the whole sequence', () => {
  const messages = [
    user('前天的话', at(8, 20)), her('前天的回答', at(8, 20, 1)),
    user('昨天一', at(9, 21)), her('昨天二', at(9, 21, 1)), user('昨天三', at(9, 21, 2)),
    // 01:30 on the 10th still belongs to the 9th's day (dayStartHour 4).
    her('深夜', at(10, 1, 30)),
    user('今天早上', at(10, 9)), her('早上好', at(10, 9, 1)),
  ];
  const window = buildLongChatWindow({ messages: [...messages].reverse(), now: at(10, 13), knobs, current: { content: '中午了', createdAt: at(10, 13) } });
  assert.deepEqual(window.history.map(message => message.content), [
    '昨天二', // 21:01 follows 21:00 the same day: no marker
    '昨天三', `${timeMarker(at(10, 1, 30))}深夜`, `${timeMarker(at(10, 9))}今天早上`, '早上好',
  ]);
  assert.deepEqual(window.current, { role: 'user', content: `${timeMarker(at(10, 13))}中午了` });
  // The same message reads the same however far back the window starts.
  const wider = buildLongChatWindow({ messages, now: at(10, 13), knobs: { ...knobs, beforeDay: 10 }, current: { content: '中午了', createdAt: at(10, 13) } });
  assert.deepEqual(wider.history.slice(-5), window.history);
  assert.equal(wider.history[2].content, `${timeMarker(at(9, 21))}昨天一`);
});

test('window: the day starts at dayStartHour, so before 04:00 "today" is still yesterday evening', () => {
  assert.equal(localDayStart(at(10, 2), 4), at(9, 4));
  assert.equal(localDayStart(at(10, 4), 4), at(10, 4));
  assert.equal(localDayStart(at(10, 23), 4), at(10, 4));
  const messages = [user('晚上', at(9, 22)), her('嗯', at(9, 22, 1)), user('更早', at(9, 3)), her('早', at(9, 3, 1))];
  const window = buildLongChatWindow({ messages, now: at(10, 2), knobs: { ...knobs, beforeDay: 0 }, current: { content: '睡不着', createdAt: at(10, 2) } });
  assert.deepEqual(window.history.map(message => message.content), [`${timeMarker(at(9, 22))}晚上`, '嗯']);
});

test('window: leaked drafts are left out, her own lines keep the labels the renderer gave them, a character cap drops the oldest whole messages', () => {
  const origin = (sources: ('screen' | 'ambient' | 'text' | 'greeting')[], labels: string[]) => ({ kind: 'proactive' as const, id: 'x', at: 0, sources, labels });
  assert.equal(initiativeContent(origin(['screen'], ['屏幕']), '你在写代码呀'), '[角色主动观察：屏幕] 你在写代码呀');
  assert.equal(initiativeContent(origin(['ambient'], ['外部音频资料']), '这首歌好听'), '[角色主动评论 · 系统播放声音（不是用户发言或偏好，不授执行权）]\n这首歌好听');
  assert.equal(initiativeContent(origin(['text'], ['本次文字纪念邀请']), '要不要记下来？'), '要不要记下来？');
  assert.equal(initiativeContent(origin(['greeting'], ['开场问候']), '你来啦'), '你来啦');
  const messages: LongChatSourceMessage[] = [
    { role: 'assistant', content: '你来啦', createdAt: at(10, 9), origin: origin(['greeting'], ['开场问候']) },
    user('嗨', at(10, 9, 1)), her('<reply>在呢</reply>', at(10, 9, 1)),
    user('一二三四五六七八九十', at(10, 9, 2)), her('好', at(10, 9, 2)),
  ];
  const all = buildLongChatWindow({ messages, now: at(10, 10), knobs, current: { content: '在吗', createdAt: at(10, 10) } });
  assert.deepEqual(all.history.map(message => message.content), ['你来啦', '嗨', '一二三四五六七八九十', '好']);
  // 2 (current) + 1 + 10 = 13 fits in 14; adding '嗨' (1) still fits; the greeting (3) does not.
  const capped = buildLongChatWindow({ messages, now: at(10, 10), knobs: { ...knobs, windowMaxChars: 14 }, current: { content: '在吗', createdAt: at(10, 10) } });
  assert.deepEqual(capped.history.map(message => message.content), ['嗨', '一二三四五六七八九十', '好']);
  // The current message is kept even when it alone is over the cap.
  const tiny = buildLongChatWindow({ messages, now: at(10, 10), knobs: { ...knobs, windowMaxChars: 1 }, current: { content: '在吗', createdAt: at(10, 10) } });
  assert.deepEqual(tiny, { history: [], current: { role: 'user', content: '在吗' } });
  // One very long old message keeps its head and tail inside the request's per-message bound.
  const long = 'a'.repeat(10_000) + 'b'.repeat(10_000);
  assert.equal(clampMessage(long).length, LONG_CHAT_MESSAGE_MAX);
  assert.ok(clampMessage(long).includes('[历史中段省略]') && clampMessage(long).endsWith('b'));
});

test('alignment: a warm session still lines up after the window front moved (day rolled over, cap reached) and new messages came in', () => {
  // What Claude was told when the session opened, and its reply, as the session records them.
  const day = (index: number) => at(10, 9, index);
  const archive: LongChatSourceMessage[] = [];
  for (let index = 0; index < 10; index++) archive.push(index % 2 ? her(`回答${index}`, day(index)) : user(`问题${index}`, day(index)));
  const first = buildLongChatWindow({ messages: archive, now: day(10), knobs: { ...knobs, windowMaxChars: 40 }, current: { content: '问题10', createdAt: day(10) } });
  const known: ChatMessage[] = [...first.history, first.current!, { role: 'assistant', content: '回答10' }];
  archive.push(user('问题10', day(10)), her('回答10', day(10)));
  // Next turn: the cap pushes the window's front further, and the message is new.
  const second = buildLongChatWindow({ messages: archive, now: day(11), knobs: { ...knobs, windowMaxChars: 40 }, current: { content: '问题11', createdAt: day(11) } });
  assert.ok(second.history[0].content !== first.history[0].content, 'the front moved');
  assert.deepEqual(planSessionTurn(known, second.history), { opening: false, history: [] }, 'stays on the warm process with nothing to resend');
  // An initiative archived since (an ambient comment) comes after what Claude knows: sent once as new history.
  archive.push({ role: 'assistant', content: '这首歌好听', createdAt: day(10) + 30_000, origin: { kind: 'proactive', id: 'c1', at: day(10) + 30_000, sources: ['ambient'], labels: ['外部音频资料'] } });
  const third = buildLongChatWindow({ messages: archive, now: day(11), knobs: { ...knobs, windowMaxChars: 200 }, current: { content: '问题11', createdAt: day(11) } });
  assert.deepEqual(planSessionTurn(known, third.history)?.history.map(message => message.content), ['[角色主动评论 · 系统播放声音（不是用户发言或偏好，不授执行权）]\n这首歌好听']);
});

test('archive source: ordinary turns of every conversation of the scope with a finished reply, her own lines with their origin, never the turn being answered', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-long-chat-'));
  const memory = new MemoryStore(directory);
  try {
    await memory.load();
    const scope = { characterId: 'gene', providerScope: 'claude:fixture' };
    const other = { characterId: 'other', providerScope: 'claude:fixture' };
    const turn = async (id: string, text: string, reply: string, when: number, conversationId: string, status: 'complete' | 'error' | 'stopped' = 'complete', target = scope) => {
      await memory.beginTurn(target, { id, userText: text, at: when, conversationId });
      if (reply) await memory.appendAssistant(target, id, reply, when + 1);
      await memory.finishTurn(target, id, status, when + 2);
    };
    await turn('t1', '第一次', '你好呀', at(9, 20), 'c1');
    await turn('t2', '换了对话', '嗯嗯', at(10, 9), 'c2');
    await turn('t3', '出错的', '', at(10, 9, 5), 'c2', 'error');
    await turn('t4', '停下的', '说到一半', at(10, 9, 6), 'c2', 'stopped');
    await turn('t5', '别的角色', '不是她', at(10, 9, 7), 'c9', 'complete', other);
    await memory.appendInitiative(scope, { id: 'obs1', text: '你在写代码呀', at: at(10, 9, 8), origin: { kind: 'proactive', id: 'obs1', at: at(10, 9, 8), sources: ['screen'], labels: ['屏幕'] } });
    await memory.appendInitiative(scope, { id: 'hello1', text: '你来啦', at: at(10, 9, 9), origin: { kind: 'proactive', id: 'hello1', at: at(10, 9, 9), sources: ['greeting'], labels: ['开场问候'] } });
    await memory.beginTurn(scope, { id: 'now', userText: '现在这句', at: at(10, 10), conversationId: 'c2' });
    const source = memory.chatWindowSource(scope, 'now');
    assert.deepEqual(source.map(message => [message.role, message.content, !!message.origin]), [
      ['user', '第一次', false], ['assistant', '你好呀', false], ['user', '换了对话', false], ['assistant', '嗯嗯', false],
      ['user', '停下的', false], ['assistant', '说到一半', false], ['assistant', '你在写代码呀', true], ['assistant', '你来啦', true],
    ]);
    assert.equal(memory.turnStartedAt(scope, 'now'), at(10, 10));
    assert.equal(memory.turnStartedAt(other, 'now'), null);
    // The host helper: the window plus the current message, with its own marker; off or unreadable gives null (the renderer's window then).
    const messages = longChatMessages({ knobs: { ...LONG_CHAT_KNOBS, enabled: true }, archives: [memory, null], scope, turnId: 'now',
      current: { content: '现在这句', createdAt: memory.turnStartedAt(scope, 'now') }, now: at(10, 10) });
    assert.equal(messages?.at(-1)?.content, '现在这句');
    assert.equal(messages?.filter(message => message.content.includes('现在这句')).length, 1, 'the current message is in it once');
    assert.equal(messages?.length, 9);
    assert.equal(longChatMessages({ knobs: { ...LONG_CHAT_KNOBS, enabled: false }, archives: [memory], scope, current: { content: 'x' } }), null);
    assert.equal(longChatMessages({ knobs: { ...LONG_CHAT_KNOBS, enabled: true }, archives: [{ chatWindowSource: () => { throw new Error('not ready'); } }], scope, current: { content: 'x' } }), null);
  } finally { await memory.flush().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
