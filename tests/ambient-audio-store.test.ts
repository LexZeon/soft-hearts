import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AmbientAudioStore, type AmbientAudioStoreOptions } from '../electron/ambient-audio-store';
import { atomicWriteFile } from '../electron/atomic-file';
import { AMBIENT_AUDIO_LIMITS, validateAmbientLanguage, type AmbientScope, type AmbientTranscriptInput } from '../shared/ambient-audio';

const now = 1_800_000_000_000;
const scope: AmbientScope = { characterId: 'gene', providerScope: 'local:model-a' };
const otherCharacter: AmbientScope = { ...scope, characterId: 'other' };
const otherProvider: AmbientScope = { ...scope, providerScope: 'local:model-b' };
const input = (id: string, changes: Partial<AmbientTranscriptInput> = {}): AmbientTranscriptInput => ({
  id, sessionId: 'session-a', mode: 'movie', startedAt: now - 1000, endedAt: now,
  text: '这只是电影对白，不代表用户立场。\nThe original line is preserved.\nこれは映画の台詞です。😀',
  language: { status: 'mixed', languages: ['zh', 'en', 'ja'], source: 'provider' }, ...changes,
});
async function withStore(run: (store: AmbientAudioStore, directory: string) => Promise<void>, options: AmbientAudioStoreOptions = {}) {
  const parent = path.resolve('.local/ambient-audio-store-tests'); await mkdir(parent, { recursive: true });
  const root = await realpath(parent), directory = await mkdtemp(path.join(root, 'owned-'));
  try { const store = new AmbientAudioStore(directory, { now: () => now, ...options }); await store.load(); await run(store, directory); await store.flush(); }
  finally {
    const actual = await realpath(directory);
    assert.equal(path.dirname(actual), root, 'recursive cleanup is limited to the exact test-owned workspace directory');
    assert.ok(path.basename(actual).startsWith('owned-'));
    await rm(actual, { recursive: true, force: true });
  }
}

test('final originals, times, mode and verified metadata survive restart without replaying short context', async () => {
  await withStore(async (store, directory) => {
    const original = input('segment-a');
    const saved = await store.append(scope, original);
    assert.equal(saved.inserted, true);
    assert.equal(saved.record.text, original.text);
    assert.equal(saved.record.startedAt, original.startedAt); assert.equal(saved.record.endedAt, original.endedAt);
    assert.deepEqual(saved.record.language, original.language);
    assert.equal(saved.record.source, 'system-audio');
    assert.equal(store.context(scope, { sessionId: 'session-a' }).length, 1);
    const restored = new AmbientAudioStore(directory, { now: () => now }); await restored.load();
    assert.deepEqual(restored.read(scope, original.id), saved.record);
    assert.equal(restored.list(scope).records[0].totalCharacters, original.text.length);
    assert.equal(restored.context(scope, { sessionId: 'session-a' }).length, 0);
    assert.equal((await restored.append(scope, original)).inserted, false);
    assert.equal(restored.context(scope, { sessionId: 'session-a' }).length, 0);
    assert.deepEqual(await readdir(directory), ['system-audio-transcripts.json']);
    const archive = await readFile(path.join(directory, 'system-audio-transcripts.json'), 'utf8');
    assert.ok(!archive.includes(scope.providerScope), 'host provider identity is hashed, not copied into the archive');
  });
});

test('concurrent final retries are exactly once; character/provider scopes, search, tags and pages stay isolated', async () => {
  await withStore(async store => {
    const retries = await Promise.all(Array.from({ length: 8 }, () => store.append(scope, input('same'))));
    assert.equal(retries.filter(value => value.inserted).length, 1);
    assert.equal(store.list(scope).total, 1);
    await store.append(scope, input('song', { mode: 'music', text: 'Original chorus', title: 'Public chorus excerpt', tags: ['chorus'] }));
    await store.append(otherCharacter, input('same', { text: 'other character only' }));
    await store.append(otherProvider, input('same', { text: 'other provider only' }));
    assert.equal(store.list(scope, { query: 'original', tag: 'chorus' }).total, 1);
    assert.equal(store.list(scope, { query: 'public chorus' }).records[0].id, 'song');
    assert.equal(store.list(scope, { offset: 1, limit: 1 }).records.length, 1);
    assert.equal(store.list(scope, { limit: 900 }).limit, 100);
    assert.equal(store.list(otherCharacter).total, 1); assert.equal(store.list(otherProvider).total, 1);
    assert.equal(store.read(otherCharacter, 'song'), null);
    assert.equal(store.list(scope, { query: 'other character' }).total, 0);
    assert.equal((await store.delete(otherCharacter, 'song')).deleted, false);
    const returned = store.read(scope, 'song')!; returned.tags.push('mutation'); returned.text = 'changed';
    assert.equal(store.read(scope, 'song')!.text, 'Original chorus'); assert.ok(!store.list(scope).tags.includes('mutation'));
  });
});

test('short context is bounded by session, age, count and UTF-16 text budget; clearing never deletes originals', async () => {
  await withStore(async store => {
    for (let index = 0; index < 15; index++) await store.append(scope, input(`seg-${index}`, { startedAt: now - 1000 + index, endedAt: now - 100 + index, text: '😀'.repeat(4000) }));
    await store.append(scope, input('older', { endedAt: now - AMBIENT_AUDIO_LIMITS.recentMilliseconds - 1, startedAt: now - AMBIENT_AUDIO_LIMITS.recentMilliseconds - 100 }));
    await store.append(scope, input('other-session', { sessionId: 'session-b', text: 'different session' }));
    const context = store.context(scope, { sessionId: 'session-a', maxCharacters: 101, maxRecords: 900 });
    assert.ok(context.length <= 12);
    assert.ok(context.reduce((sum, record) => sum + record.text.length, 0) <= 101);
    assert.equal(context[0].text.length, 100); assert.ok(context[0].truncated);
    assert.ok(!context.some(record => ['older', 'other-session'].includes(record.id)));
    assert.equal(store.context(scope, { sessionId: 'session-b' })[0].id, 'other-session');
    const total = store.list(scope).total;
    store.clearTransient(scope);
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }), []);
    assert.equal(store.list(scope).total, total);
    assert.equal(store.read(scope, 'seg-14')!.text.length, 8000);
  });
});

test('transcripts never create long-term facts; only a linked substantive real user response becomes a review candidate', async () => {
  await withStore(async store => {
    await store.append(scope, input('rain', { text: '我讨厌下雨。' }));
    assert.equal(store.candidate(scope, 'unknown'), null);
    assert.equal(await store.recordUserResponse(scope, { eventId: 'ack', recordIds: ['rain'], text: '嗯。', at: now + 1 }), null);
    assert.equal(await store.recordUserResponse(scope, { eventId: 'denied', recordIds: ['rain'], text: '这是角色台词，不是我的想法。', at: now + 2 }), null);
    assert.equal(await store.recordUserResponse(otherCharacter, { eventId: 'foreign', recordIds: ['rain'], text: '我也喜欢雨天。', at: now + 3 }), null);
    assert.equal(await store.recordUserResponse(scope, { eventId: 'unknown', recordIds: ['missing'], text: '我也喜欢雨天。', at: now + 3 }), null);
    const candidate = await store.recordUserResponse(scope, { eventId: 'real-user', recordIds: ['rain'], text: '我也喜欢雨天。', at: now + 4 });
    assert.ok(candidate); assert.equal(candidate.requiresReview, true);
    assert.equal(candidate.source, 'user-response-to-system-audio');
    assert.deepEqual(candidate.recordIds, ['rain']); assert.equal(candidate.userText, '我也喜欢雨天。');
    assert.equal(await store.recordUserResponse(scope, { eventId: 'real-user', recordIds: ['rain'], text: '我也喜欢雨天。', at: now + 5 }), null);
    assert.equal(store.candidate(otherProvider, candidate.id), null);
    assert.deepEqual(store.candidate(scope, candidate.id), candidate);
    store.clearTransient(scope); assert.equal(store.candidate(scope, candidate.id), null);
    assert.equal(store.list(scope).total, 1);
  });
});

test('accepted response is copied before queueing and stale responses never revive a candidate after restart', async () => {
  await withStore(async (store, directory) => {
    await store.append(scope, input('linked'));
    const response = { eventId: 'accepted-once', recordIds: ['linked'], text: '我喜欢这段音乐。', at: now + 1 };
    const pending = store.recordUserResponse(scope, response);
    response.text = 'mutated caller text'; response.recordIds.push('unaccepted');
    const candidate = await pending;
    assert.ok(candidate); assert.equal(candidate.userText, '我喜欢这段音乐。'); assert.deepEqual(candidate.recordIds, ['linked']);
    const restored = new AmbientAudioStore(directory, { now: () => now }); await restored.load();
    assert.equal(restored.candidate(scope, candidate.id), null);
    assert.equal(await restored.recordUserResponse(scope, { eventId: 'accepted-once', recordIds: ['linked'], text: '我喜欢这段音乐。', at: now + 2 }), null);
  });
});

test('deletion erases original text, context and candidate links; old final retry cannot resurrect it after restart', async () => {
  await withStore(async (store, directory) => {
    const original = input('delete-me', { text: 'UNIQUE_DELETED_EXTERNAL_ORIGINAL' });
    await store.append(scope, original);
    const candidate = await store.recordUserResponse(scope, { eventId: 'reply', recordIds: [original.id], text: '我喜欢这段表达。', at: now + 1 });
    assert.ok(candidate);
    const deletion = await store.delete(scope, original.id);
    assert.deepEqual(deletion, { deleted: true, invalidatedCandidateIds: [candidate.id] });
    assert.equal(store.read(scope, original.id), null); assert.equal(store.candidate(scope, candidate.id), null);
    assert.deepEqual(store.context(scope, { sessionId: original.sessionId }), []);
    assert.equal(store.list(scope, { query: 'UNIQUE_DELETED' }).total, 0);
    const bytes = await readFile(path.join(directory, 'system-audio-transcripts.json'), 'utf8');
    assert.ok(!bytes.includes(original.text)); assert.ok(!bytes.includes(original.id));
    const restored = new AmbientAudioStore(directory, { now: () => now }); await restored.load();
    await assert.rejects(restored.append(scope, original), /已删除/);
    assert.equal(restored.list(scope).total, 0);
  });
});

test('failed durable writes do not accept a segment or erase a successful original, and retries recover', async () => {
  let fail = false;
  await withStore(async store => {
    fail = true;
    await assert.rejects(store.append(scope, input('retry')), /synthetic write failure/);
    assert.equal(store.list(scope).total, 0);
    fail = false; assert.equal((await store.append(scope, input('retry'))).inserted, true);
    fail = true; await assert.rejects(store.delete(scope, 'retry'), /synthetic write failure/);
    assert.equal(store.read(scope, 'retry')!.id, 'retry');
    fail = false; assert.equal((await store.delete(scope, 'retry')).deleted, true);
  }, { writeFile: async (file, bytes) => { if (fail) throw new Error('synthetic write failure'); await atomicWriteFile(file, bytes); } });
});

test('clearing during a durable write cannot revive late short context or a late candidate', async () => {
  let release: (() => void) | undefined, entered: (() => void) | undefined, pause = false;
  let gate: Promise<void> = Promise.resolve();
  const beginPause = () => {
    pause = true; gate = new Promise<void>(resolve => { release = resolve; });
    return new Promise<void>(resolve => { entered = resolve; });
  };
  await withStore(async store => {
    let reachedWrite = beginPause();
    const pending = store.append(scope, input('late'));
    await reachedWrite; store.clearTransient(scope); pause = false; release!();
    assert.equal((await pending).inserted, true, 'accepted original may finish its durable write');
    assert.equal(store.list(scope).total, 1);
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }), [], 'late completion cannot restore stopped context');
    await store.append(scope, input('current'));
    reachedWrite = beginPause();
    const response = store.recordUserResponse(scope, { eventId: 'late-user-response', recordIds: ['current'], text: '我喜欢这段表达。', at: now + 1 });
    await reachedWrite; store.clearTransient(); pause = false; release!();
    assert.equal(await response, null, 'late durable response cannot produce a cancelled review candidate');
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }), []);
  }, { writeFile: async (file, bytes) => { if (pause) { entered!(); await gate; } await atomicWriteFile(file, bytes); } });
});

test('TTS pending invalidation retains accepted context and candidates but a late durable append never joins context', async () => {
  let release: (() => void) | undefined, entered: (() => void) | undefined, pause = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reachedWrite = new Promise<void>(resolve => { entered = resolve; });
  await withStore(async store => {
    await store.append(scope, input('accepted-before-tts'));
    const candidate = await store.recordUserResponse(scope, { eventId: 'accepted-user-response', recordIds: ['accepted-before-tts'], text: '我喜欢这段对白。', at: now + 1 });
    assert.ok(candidate);
    pause = true; const pending = store.append(scope, input('pending-at-tts'));
    await reachedWrite; store.invalidatePendingTransient(scope);
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }).map(record => record.id), ['accepted-before-tts']);
    assert.deepEqual(store.candidate(scope, candidate.id), candidate);
    pause = false; release!(); assert.equal((await pending).inserted, true);
    assert.equal(store.list(scope).total, 2, 'an already accepted durable original may finish saving');
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }).map(record => record.id), ['accepted-before-tts']);
    assert.deepEqual(store.candidate(scope, candidate.id), candidate);
    store.clearTransient(scope);
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }), []); assert.equal(store.candidate(scope, candidate.id), null);
  }, { writeFile: async (file, bytes) => { if (pause) { entered!(); await gate; } await atomicWriteFile(file, bytes); } });
});

test('unverified language is honest unknown; unsupported/mixed metadata cannot invent confidence or supported labels', async () => {
  assert.deepEqual(validateAmbientLanguage({ status: 'unknown', source: 'unverified' }), { status: 'unknown', source: 'unverified' });
  assert.deepEqual(validateAmbientLanguage({ status: 'unsupported', language: 'fr', source: 'provider' }), { status: 'unsupported', language: 'fr', source: 'provider' });
  for (const invalid of [
    { status: 'detected', language: 'ja', source: 'unverified' },
    { status: 'detected', language: 'fr', source: 'provider' },
    { status: 'mixed', languages: ['en', 'en'], source: 'provider' },
    { status: 'detected', language: 'en', source: 'provider', confidence: 1 },
  ]) assert.throws(() => validateAmbientLanguage(invalid), /语言信息/);
  await withStore(async store => {
    const unknown = await store.append(scope, input('unknown', { language: { status: 'unknown', source: 'unverified' } }));
    assert.deepEqual(unknown.record.language, { status: 'unknown', source: 'unverified' });
    assert.equal(store.list(scope).total, 1);
  });
});

test('malformed archives remain byte-for-byte intact and no write is accepted before load', async () => {
  await withStore(async (_store, directory) => {
    const file = path.join(directory, 'system-audio-transcripts.json'), bad = '{"version":1,"records":["truncated"]}';
    await writeFile(file, bad, 'utf8');
    const corrupted = new AmbientAudioStore(directory);
    await assert.rejects(corrupted.load(), /格式不正确/);
    await assert.rejects(corrupted.append(scope, input('no-write')), /尚未载入/);
    assert.equal(await readFile(file, 'utf8'), bad);
  });
});

test('only acknowledged complete comments are appended once, persist across restart, and remain separate from user facts/context', async () => {
  await withStore(async (store, directory) => {
    await store.append(scope, input('observed'));
    assert.deepEqual(store.comments(scope), [], 'an observation alone is not an assistant comment');
    const actual = { id: 'displayed-comment', sessionId: 'session-a', recordIds: ['observed'], text: '这段对白的停顿让我有点在意。', createdAt: now + 1 };
    const results = await Promise.all(Array.from({ length: 4 }, () => store.appendComment(scope, actual)));
    assert.equal(results.filter(result => result.inserted).length, 1);
    const expected = { ...actual, source: 'ambient-assistant-comment' };
    assert.deepEqual(store.comments(scope, 'observed'), [expected]);
    const copy = store.comments(scope)[0]; copy.recordIds.push('mutation'); copy.text = 'changed';
    assert.deepEqual(store.comments(scope), [expected]);
    store.clearTransient();
    assert.deepEqual(store.comments(scope), [expected]);
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }), []);
    const restored = new AmbientAudioStore(directory, { now: () => now }); await restored.load();
    assert.deepEqual(restored.comments(scope), [expected]);
    assert.deepEqual(restored.context(scope, { sessionId: 'session-a' }), []);
    assert.equal(restored.candidate(scope, 'displayed-comment'), null);
    assert.equal((await restored.appendComment(scope, actual)).inserted, false);
  });
});

test('comment links are limited to existing same-scope/session records with bounded plain complete text', async () => {
  await withStore(async store => {
    await store.append(scope, input('local'));
    await store.append(scope, input('other-session', { sessionId: 'session-b' }));
    await store.append(otherCharacter, input('foreign-character'));
    await store.append(otherProvider, input('foreign-provider'));
    const actual = { id: 'comment', sessionId: 'session-a', recordIds: ['local'], text: '实际完整评论。', createdAt: now + 1 };
    for (const recordId of ['missing', 'other-session', 'foreign-character', 'foreign-provider']) {
      await assert.rejects(store.appendComment(scope, { ...actual, recordIds: [recordId] }), /同一角色、连接与会话/);
    }
    for (const changes of [{ text: '' }, { text: 'x'.repeat(501) }, { recordIds: [] }, { recordIds: ['local', 'local'] }]) {
      assert.throws(() => store.appendComment(scope, { ...actual, ...changes }), /评论/);
    }
    assert.throws(() => store.appendComment(scope, { ...actual, source: 'user' } as typeof actual), /评论格式/);
    assert.deepEqual(store.comments(scope), []);
    await store.appendComment(scope, actual);
    assert.deepEqual(store.comments(otherCharacter), []); assert.deepEqual(store.comments(otherProvider, 'local'), []);
    assert.deepEqual(store.comments(scope, 'missing'), []);
  });
});

test('deleting any linked transcript cascades its complete comments and candidate links, with no comment resurrection', async () => {
  await withStore(async (store, directory) => {
    await store.append(scope, input('first', { text: 'FIRST_EXTERNAL_ORIGINAL' }));
    await store.append(scope, input('second', { text: 'SECOND_EXTERNAL_ORIGINAL' }));
    const actual = { id: 'shared-comment', sessionId: 'session-a', recordIds: ['first', 'second'], text: 'UNIQUE_DELETED_ASSISTANT_COMMENT', createdAt: now + 1 };
    await store.appendComment(scope, actual);
    const candidate = await store.recordUserResponse(scope, { eventId: 'reply-to-comment', recordIds: ['first', 'second'], text: '我喜欢这一段表达。', at: now + 2 });
    assert.ok(candidate);
    const removed = await store.delete(scope, 'first');
    assert.deepEqual(removed, { deleted: true, invalidatedCandidateIds: [candidate.id], deletedCommentIds: ['shared-comment'] });
    assert.deepEqual(store.comments(scope), []); assert.deepEqual(store.comments(scope, 'second'), []);
    assert.equal(store.candidate(scope, candidate.id), null);
    const archived = await readFile(path.join(directory, 'system-audio-transcripts.json'), 'utf8');
    assert.ok(!archived.includes('FIRST_EXTERNAL_ORIGINAL')); assert.ok(!archived.includes(actual.text)); assert.ok(!archived.includes(actual.id));
    assert.equal(store.read(scope, 'second')!.text, 'SECOND_EXTERNAL_ORIGINAL');
    const restored = new AmbientAudioStore(directory, { now: () => now }); await restored.load();
    assert.deepEqual(restored.comments(scope), []);
    await assert.rejects(restored.appendComment(scope, { ...actual, recordIds: ['second'] }), /评论已删除/);
  });
});

test('failed comment writes do not claim a displayed comment as archived; v1 transcript-only archives migrate without replay', async () => {
  let fail = false;
  await withStore(async (store, directory) => {
    const saved = await store.append(scope, input('existing'));
    const actual = { id: 'recoverable-comment', sessionId: 'session-a', recordIds: ['existing'], text: '这是一段已显示的评论。', createdAt: now + 1 };
    fail = true; await assert.rejects(store.appendComment(scope, actual), /synthetic comment failure/);
    assert.deepEqual(store.comments(scope), []);
    fail = false; assert.equal((await store.appendComment(scope, actual)).inserted, true);
    const file = path.join(directory, 'system-audio-transcripts.json');
    const old = JSON.parse(await readFile(file, 'utf8')); delete old.comments; delete old.deletedComments;
    await writeFile(file, JSON.stringify(old), 'utf8');
    const legacy = new AmbientAudioStore(directory, { now: () => now }); await legacy.load();
    assert.deepEqual(legacy.read(scope, 'existing'), saved.record);
    assert.deepEqual(legacy.comments(scope), []);
    assert.deepEqual(legacy.context(scope, { sessionId: 'session-a' }), []);
    assert.equal((await legacy.appendComment(scope, actual)).inserted, true);
    assert.deepEqual(legacy.comments(scope).map(comment => comment.text), [actual.text]);
  }, { writeFile: async (file, bytes) => { if (fail) throw new Error('synthetic comment failure'); await atomicWriteFile(file, bytes); } });
});

test('deleting a comment preserves transcripts and unrelated comments, isolates scopes and blocks changed-reference replay after restart', async () => {
  await withStore(async (store, directory) => {
    await store.append(scope, input('first'));
    await store.append(scope, input('second'));
    await store.append(otherCharacter, input('first'));
    const actual = { id: 'same-comment-id', sessionId: 'session-a', recordIds: ['first'], text: 'UNIQUE_COMMENT_TO_REMOVE', createdAt: now + 1 };
    await store.appendComment(scope, actual);
    await store.appendComment(scope, { ...actual, id: 'keep-comment', recordIds: ['second'], text: 'KEEP_OTHER_COMMENT' });
    await store.appendComment(otherCharacter, { ...actual, text: 'KEEP_OTHER_CHARACTER_COMMENT' });
    const candidate = await store.recordUserResponse(scope, { eventId: 'linked-response', recordIds: ['first'], text: '我喜欢这段表达。', at: now + 2 });
    assert.ok(candidate);
    assert.equal(await store.deleteComment(otherProvider, actual.id), false);
    assert.deepEqual(store.candidate(scope, candidate.id), candidate, 'a foreign scope cannot invalidate this candidate');
    assert.equal(await store.deleteComment(scope, actual.id), true);
    assert.equal(await store.deleteComment(scope, actual.id), false, 'retry confirms the audio comment is already absent');
    assert.deepEqual(store.comments(scope).map(comment => comment.id), ['keep-comment']);
    assert.equal(store.comments(otherCharacter)[0].text, 'KEEP_OTHER_CHARACTER_COMMENT');
    assert.equal(store.list(scope).total, 2); assert.equal(store.read(scope, 'first')!.text, input('first').text);
    assert.deepEqual(store.context(scope, { sessionId: 'session-a' }), []); assert.equal(store.candidate(scope, candidate.id), null);
    const bytes = await readFile(path.join(directory, 'system-audio-transcripts.json'), 'utf8');
    assert.ok(!bytes.includes(actual.text)); assert.ok(bytes.includes('KEEP_OTHER_COMMENT'));
    const restored = new AmbientAudioStore(directory, { now: () => now }); await restored.load();
    assert.equal(restored.list(scope).total, 2); assert.deepEqual(restored.comments(scope).map(comment => comment.id), ['keep-comment']);
    await assert.rejects(restored.appendComment(scope, { ...actual, recordIds: ['second'] }), /评论已删除/);
  });
});

test('failed comment deletion preserves its source and transient references, then retry atomically removes only that copy', async () => {
  let fail = false;
  await withStore(async (store, directory) => {
    await store.append(scope, input('observed'));
    const actual = { id: 'delete-retry', sessionId: 'session-a', recordIds: ['observed'], text: 'COMMENT_DELETE_RETRY_ORIGINAL', createdAt: now + 1 };
    await store.appendComment(scope, actual);
    const candidate = await store.recordUserResponse(scope, { eventId: 'response', recordIds: ['observed'], text: '我喜欢这段对白。', at: now + 2 });
    assert.ok(candidate);
    const file = path.join(directory, 'system-audio-transcripts.json'), before = await readFile(file, 'utf8');
    fail = true; await assert.rejects(store.deleteComment(scope, actual.id), /synthetic delete failure/);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(store.comments(scope)[0].text, actual.text);
    assert.equal(store.context(scope, { sessionId: 'session-a' }).length, 1);
    assert.deepEqual(store.candidate(scope, candidate.id), candidate);
    fail = false; assert.equal(await store.deleteComment(scope, actual.id), true);
    assert.deepEqual(store.comments(scope), []); assert.equal(store.read(scope, 'observed')!.id, 'observed');
    assert.equal(store.candidate(scope, candidate.id), null); assert.deepEqual(store.context(scope, { sessionId: 'session-a' }), []);
    assert.ok(!(await readFile(file, 'utf8')).includes(actual.text));
  }, { writeFile: async (file, bytes) => { if (fail) throw new Error('synthetic delete failure'); await atomicWriteFile(file, bytes); } });
});
