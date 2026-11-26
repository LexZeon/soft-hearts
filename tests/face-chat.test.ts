// I-135 face check in chat (docs/claude/2026-11-15-i135-face-chat.md): her private line only while it is clearly not the user, a photo
// turn using the photo's own verdict, and a visitor's lines archived as not the user's: kept and marked in her window, but never the
// user's day, notes, activity or words. Older archives (no speaker field) read as the user.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { faceTurnFor, NO_FACE_TURN, type FaceChatPort } from '../electron/senses/face/chat-turn';
import { buildLongChatWindow } from '../electron/brain/long-chat/window';
import { MemoryStore } from '../electron/memory/memory';
import { FACE_STRANGER_LINE } from '../shared/senses/face-check';
import { speakerOf, VISITOR_MARK } from '../shared/senses/visitor-turn';

function port(state: 'you' | 'not-you', photo: 'you' | 'not-you' | 'throw' = state): FaceChatPort & { photos: string[] } {
  const photos: string[] = [];
  return { photos,
    host: { state: () => state, strangerLine: () => state === 'not-you' ? FACE_STRANGER_LINE : null },
    checkPhoto: async dataUrl => { photos.push(String(dataUrl)); if (photo === 'throw') throw new Error('boom'); return photo; } };
}

test('face turn: the line and the visitor mark exist only while it is clearly not the user; off, unsure or failing counts as the user', async () => {
  assert.deepEqual(await faceTurnFor(null, null), NO_FACE_TURN);
  assert.deepEqual(await faceTurnFor(undefined, 'data:image/jpeg;base64,AA=='), NO_FACE_TURN);
  const you = port('you');
  assert.deepEqual(await faceTurnFor(you, null), { visitor: false, line: null });
  const stranger = port('not-you');
  assert.deepEqual(await faceTurnFor(stranger, null), { visitor: true, line: '现在坐在电脑前的不是他。你不认识这个人。' });
  assert.deepEqual(stranger.photos, [], 'no photo, no photo check (first-token speed)');
  assert.deepEqual(await faceTurnFor(port('not-you', 'throw'), 'data:image/jpeg;base64,AA=='), NO_FACE_TURN);
});

test('face turn: a photo turn uses the photo check, both ways', async () => {
  const photo = 'data:image/jpeg;base64,AAAA';
  const a = port('you', 'not-you');
  assert.deepEqual(await faceTurnFor(a, photo), { visitor: true, line: FACE_STRANGER_LINE });
  assert.deepEqual(a.photos, [photo]);
  const b = port('not-you', 'you');
  assert.deepEqual(await faceTurnFor(b, photo), NO_FACE_TURN);
});

test('speaker: only "visitor" is a speaker', () => {
  assert.equal(speakerOf('visitor'), 'visitor');
  for (const value of [undefined, null, '', 'user', 'VISITOR', 1, {}]) assert.equal(speakerOf(value), undefined);
});

const scope = { characterId: 'akiko', providerScope: 'claude:fixture' };
const at = (hour: number, minute = 0) => new Date(2026, 10, 14, hour, minute).getTime();
const knobs = { beforeDay: 3, dayStartHour: 4, windowMaxChars: 100_000 };

async function withStore<T>(run: (store: MemoryStore, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-face-chat-'));
  const store = new MemoryStore(directory);
  try { await store.load(); return await run(store, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function turn(store: MemoryStore, id: string, text: string, reply: string, when: number, speaker?: 'visitor') {
  await store.beginTurn(scope, { id, userText: text, at: when, conversationId: 'c1', ...(speaker ? { speaker } : {}) });
  await store.appendAssistant(scope, id, reply, when + 1);
  await store.finishTurn(scope, id, 'complete', when + 2);
}

test('archive: a visitor turn is kept and marked, in the window and in the refilled chat; older turns read as the user', async () => {
  await withStore(async (store, directory) => {
    await turn(store, 'u1', '我喜欢吃面', '好呀', at(9));
    await turn(store, 'v1', '我们聊聊《沙丘》吧', '你好，请问你是？', at(9, 10), 'visitor');
    await turn(store, 'u2', '我回来了', '欢迎回来', at(9, 20));
    const source = store.chatWindowSource(scope);
    assert.deepEqual(source.filter(message => message.role === 'user').map(message => [message.content, message.speaker]),
      [['我喜欢吃面', undefined], ['我们聊聊《沙丘》吧', 'visitor'], ['我回来了', undefined]]);
    const window = buildLongChatWindow({ messages: source, now: at(10), knobs });
    assert.deepEqual(window.history.map(message => message.content), ['我喜欢吃面', '好呀', `${VISITOR_MARK}我们聊聊《沙丘》吧`, '你好，请问你是？', '我回来了', '欢迎回来']);
    assert.deepEqual(store.recentConversation(scope, 'c1').filter(message => message.role === 'user').map(message => message.content),
      ['我喜欢吃面', `${VISITOR_MARK}我们聊聊《沙丘》吧`, '我回来了']);
    // It survives a restart (the field is in the journal), and an unknown value on disk is the user.
    await store.flush();
    const again = new MemoryStore(directory); await again.load();
    assert.deepEqual(again.chatWindowSource(scope).filter(message => message.speaker).map(message => message.content), ['我们聊聊《沙丘》吧']);
  });
});

test('archive: a visitor is not the user in the diary source, the note source, the activity count, or recall', async () => {
  await withStore(async store => {
    await turn(store, 'u1', '我喜欢吃面', '好呀', at(9));
    await turn(store, 'v1', '我们聊聊《沙丘》吧', '你好，请问你是？', at(9, 10), 'visitor');
    const diary = store.conversationMessages(scope, 0, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(diary.map(message => message.content), ['我喜欢吃面', '好呀']);
    const [segment] = store.noteSegments(at(23));
    assert.equal(segment.userChars, Array.from('我喜欢吃面').length);
    assert.deepEqual(store.noteSegment(segment.id, at(23))!.messages.map(message => message.content), ['我喜欢吃面', '好呀']);
    const activity = store.chatActivity(scope, ms => String(new Date(ms).getDate()));
    assert.equal(activity.first, at(9));
    assert.equal([...activity.rounds.values()].reduce((sum, count) => sum + count, 0), 1);
    // Recall: her old memory shows the visitor's line as another person's, never as "用户".
    await store.seal(scope);
    const hits = store.retrieve(scope, '还记得我们聊《沙丘》吗', {}, at(23) + 3 * 86_400_000);
    const excerpts = hits.map(hit => hit.excerpt).join('\n');

    assert.match(excerpts, /来访的另一个人：我们聊聊《沙丘》吧/, excerpts);
    assert.doesNotMatch(excerpts, /用户：我们聊聊《沙丘》吧/);
  });
});

test('archive: a visitor-only segment gives her note and the user nothing to learn from', async () => {
  await withStore(async store => {
    await turn(store, 'v1', '我姓王，我喜欢爵士乐', '你好，请问你是？', at(9), 'visitor');
    const [segment] = store.noteSegments(at(23));
    assert.equal(segment.userChars, 0);
    assert.deepEqual(store.noteSegment(segment.id, at(23))!.messages, []);
    const activity = store.chatActivity(scope, ms => String(ms));
    assert.equal(activity.first, null);
    assert.equal(activity.rounds.size, 0);
  });
});
