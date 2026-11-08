/** M1: the "跳一个" marker on the host side: the real chat path notes it, the mood view carries it for a minute, per character, and nothing about it reaches the prompt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { MoodHost } from '../electron/mood';

const provider = { kind: 'claude' as const, baseUrl: 'https://dance.invalid/v1', model: 'fixture' };

test('M1 host: the mood view carries the latest request for a minute, for that character only, and not otherwise', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-dance-request-'));
  const clock = { now: 5_000_000 };
  const host = new MoodHost(directory, () => {}, () => clock.now);
  try {
    await host.load();
    host.activate('gene');
    assert.equal('danceRequest' in host.get(), false, 'nothing by default');
    host.noteDanceRequest('m1', 'someone-else');
    assert.equal('danceRequest' in host.get(), false, 'another character cannot ask');
    host.noteDanceRequest('', 'gene');
    assert.equal('danceRequest' in host.get(), false);
    host.noteDanceRequest('m1', 'gene');
    assert.deepEqual(host.get().danceRequest, { id: 'm1', at: clock.now });
    clock.now += 30_000;
    assert.equal(host.get().danceRequest?.id, 'm1');
    host.noteDanceRequest('m2', 'gene');
    assert.equal(host.get().danceRequest?.id, 'm2', 'the latest one replaces it');
    clock.now += 61_000;
    assert.equal('danceRequest' in host.get(), false, 'dropped from the view after a minute');
    host.noteDanceRequest('m3', 'gene');
    host.activate('other');
    assert.equal('danceRequest' in host.get(), false, 'a request does not follow a change of character');
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('M1 host: the real chat path notes "跳一个" and only that, and the prompt is untouched', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-dance-request-chat-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load();
    await service.context('gene', provider, 'Gene');
    const ask = async (id: string, text: string) => { const turn = await service.begin(id, text, 'Gene', () => {}); await turn.finish('stopped'); return turn; };
    const hello = await ask('c1', '你好呀');
    assert.equal('danceRequest' in service.mood.get(), false);
    await ask('c2', '我昨天去跳舞了，好累');
    assert.equal('danceRequest' in service.mood.get(), false, 'a story is not a request');
    const dance = await ask('c3', '今天好无聊，你跳一个吧');
    assert.equal(service.mood.get().danceRequest?.id, 'c3');
    await ask('c4', '谢谢');
    assert.equal(service.mood.get().danceRequest?.id, 'c3', 'other messages leave it alone');
    // No tail note and no prompt text: the persona has nothing about dancing in either turn.
    for (const turn of [hello, dance]) assert.doesNotMatch(turn.persona, /跳一个|跳舞|dance/iu);
  } finally {
    await service.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
