import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { dropUnvoicedReply } from '../src/voice/voice-call/add-on-drop';
import { voiceAddOnNote } from '../electron/voice/voice-notes';

/** I-197: the journal row of an add-on (numbers and a flag only), the window's history after a dropped reply, and her one line. */
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

test('the add-on journal row keeps only the gap, whether it was written and the dropped count', () => {
  const entry = buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'add-on', gapMs: 812.4, written: true, dropped: 9, words: '不该出现的原话' }, 1);
  assert.ok(entry);
  assert.equal(JSON.stringify(entry).includes('不该出现的原话'), false, 'no words are kept');
  assert.deepEqual({ gapMs: (entry as any).gapMs, written: (entry as any).written, dropped: (entry as any).dropped }, { gapMs: 812, written: true, dropped: 9 });
  assert.match(describeJournalEntry(entry!, plain), /她还没出声，你补的一句接到了上一句后面（隔了 0\.81 秒；上一句已经交给她的进程：停下那一轮，两句一起回；没念出来就丢掉的字：9）/);
  assert.equal(buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'add-on', gapMs: 1, written: false, dropped: -1 }, 1), null, 'a bad count is refused');
});

test('a dropped call reply leaves the window history only when it is exactly the last reply', () => {
  const history = [{ role: 'user' as const, content: '第一句' }, { role: 'assistant' as const, content: '好哒，第' }];
  assert.deepEqual(dropUnvoicedReply(history, '好哒，第'), [history[0]]);
  assert.deepEqual(dropUnvoicedReply(history, '别的'), history, 'anything else stays');
  assert.deepEqual(dropUnvoicedReply(history, ''), history, 'an empty reply was never appended');
});

test('her add-on line is one sentence and never says a part was shown', () => {
  for (const note of [voiceAddOnNote('第一句'), voiceAddOnNote('')]) {
    assert.ok(note.includes('他在你开口前又补了一句') && note.includes('两句一起回'));
    assert.ok(!note.includes('显示'), 'nothing about a shown part');
  }
  assert.ok(voiceAddOnNote('第一句').includes('第一句'), 'the first line goes along as context when the message carries only the new one');
});
