/**
 * I-188 #9: the watch session keeps the frame describer's closed `event` word (memory only) and hands it to the moments only while
 * watching together, for the character being watched. Fake clock, fake haiku, temporary folders; no real screen or model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WatchSession, type WatchConditions } from '../electron/senses/watch-notes/session';
import { WatchNotesStore } from '../electron/senses/watch-notes/store';
import { ScreenshotCache } from '../electron/senses/watch-notes/screenshots';

const SEC = 1_000, T0 = 2_000_000_000_000;

test('the frame event is read only while watching together and for that character; a stop or another character forgets it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sh-i188-screen-'));
  try {
    let clock = T0, thumb = 10;
    const state = { conditions: { watch: true, screen: true } as WatchConditions, character: 'gene' as string | null, answer: '' };
    const notes = new WatchNotesStore(directory), screenshots = new ScreenshotCache(directory, () => clock);
    const session = new WatchSession({ now: () => clock, characterId: () => state.character, conditions: () => state.conditions,
      capture: async () => 'data:image/jpeg;base64,X', prepare: url => ({ thumb: new Uint8Array(576).fill(thumb), picture: url }),
      describe: async () => state.answer, summarize: async () => '', notes, screenshots });
    const round = async (answer: string) => { state.answer = answer; thumb = (thumb + 90) % 256; clock += 10 * SEC; await session.tick(); await session.settled(); };
    await round(JSON.stringify({ description: '一个弹出的报错窗口', keywords: [], event: 'error' }));
    const seen = session.screenEvent('gene');
    assert.equal(seen?.event, 'error');
    assert.equal(seen?.at, seen?.describedAt);
    assert.equal(session.watchingNow(), true);
    assert.equal(session.screenEvent('someone-else'), null, 'another character gets nothing');
    await round(JSON.stringify({ description: '一张桌面', keywords: [] }));
    const after = session.screenEvent('gene');
    assert.equal(after?.event, 'error', 'a frame without an event keeps the last one');
    assert.ok(after!.describedAt > after!.at, 'but the screen has moved on');
    state.conditions = { watch: false, screen: true };
    assert.equal(session.screenEvent('gene'), null, '一起看 off: nothing is read');
    assert.equal(session.watchingNow(), false);
    state.conditions = { watch: true, screen: true };
    assert.equal(session.screenEvent('gene'), null, 'and nothing is left behind from before');
    await round(JSON.stringify({ description: '一个转圈的加载图标', keywords: [], event: 'loading' }));
    assert.equal(session.screenEvent('gene')?.event, 'loading');
    state.character = 'other';
    assert.equal(session.screenEvent('other'), null, 'another character: forgotten');
    session.dispose();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
