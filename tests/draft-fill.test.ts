// F4 (real-chat finding 4): a reply that is nothing but draft after filtering still gets a short line of her own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DRAFT_FILL_LINES, DraftFillLines } from '../electron/draft-fill';
import { CompanionService } from '../electron/companion';
import { draftFilterInput } from '../electron/journal/extras';
import { buildJournalEntry } from '../shared/journal';

test('the pool never repeats a line back to back, keyed to her mood, and no line opens with an ellipsis', () => {
  const lines = new DraftFillLines(() => 0); // the worst case for repeats: the first option every time
  let last = '';
  for (let i = 0; i < 20; i++) { const line = lines.pick('happy', 'gene'); assert.notEqual(line, last); last = line; }
  assert.ok(DRAFT_FILL_LINES.warm.includes(lines.pick('happy', 'gene')));
  assert.ok(DRAFT_FILL_LINES.low.includes(lines.pick('sad', 'gene')));
  assert.ok(DRAFT_FILL_LINES.tense.includes(lines.pick('concerned', 'gene')));
  assert.ok(DRAFT_FILL_LINES.calm.includes(lines.pick('something-new', 'gene')));
  for (const pool of Object.values(DRAFT_FILL_LINES)) for (const line of pool) {
    assert.ok(!/^[…\.。]/u.test(line), line); assert.ok(line.length <= 30, line);
  }
  const other = new DraftFillLines(() => 0.99);
  assert.notEqual(other.pick('calm', 'a'), undefined);
});

test('the journal records the filled outcome as a flag only', () => {
  const drops = [{ kind: 'draft-block' as const, chars: 90 }];
  const plain = buildJournalEntry(draftFilterInput('gene', drops, true)!, 1) as { whole: boolean; filled?: true };
  assert.equal(plain.filled, undefined);
  const filled = buildJournalEntry(draftFilterInput('gene', drops, true, true)!, 1) as { whole: boolean; filled?: true };
  assert.equal(filled.whole, true); assert.equal(filled.filled, true);
  const partly = buildJournalEntry(draftFilterInput('gene', drops, false, true)!, 1) as { filled?: true };
  assert.equal(partly.filled, undefined, 'a partly cut reply is never "filled"');
});

async function withService(fill: boolean, run: (service: CompanionService, notes: unknown[]) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-draft-fill-'));
  const notes: unknown[] = [];
  const service = new CompanionService(directory, () => {}, { journal: { record: (input: unknown) => { notes.push(input); } } as never });
  if (fill) service.setDraftFill(true);
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://fill.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service, notes); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const marker = (persona: string) => persona.match(/<sh-state-[a-f0-9]+>/)![0];
async function reply(service: CompanionService, id: string, user: string, text: string) {
  const shown: string[] = [];
  const turn = await service.begin(id, user, '角色名称：Gene', (type, delta) => { if (type === 'delta') shown.push(delta); });
  const start = marker(turn.persona);
  turn.push('delta', `${text}\n${start}{"context":"support","delta":{"O":3},"confidence":0.9}${start.replace('<', '</')}`);
  await turn.finish('complete');
  return { turn, shown: shown.join('') };
}
const DRAFT = '尾注里的 context 用 support，gesture 用 consider。用户在为失败难过，所以 delta 给个小幅变化。';

test('a turn whose whole text is draft: a non-empty line of hers reaches the window and the archive, and the turn is not a failure', async () => {
  await withService(true, async (service, notes) => {
    const { turn, shown } = await reply(service, 'fill-1', '面试又被刷了', DRAFT);
    assert.ok(shown.length > 0 && shown.trim().length > 0, 'she says something');
    assert.ok(Object.values(DRAFT_FILL_LINES).some(pool => pool.includes(shown)), 'one of her pool lines');
    assert.equal(turn.emptyReply?.(), false, 'the host does not fail the chat');
    assert.equal(turn.shownReply?.(), shown, 'the session records what the window saw');
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]), [['user', '面试又被刷了', 'complete'], ['assistant', shown, 'complete']]);
    assert.equal(service.mood.get().snapshot.values.O, 50, 'the draft tail still moves no mood');
    const cut = notes.find(note => (note as { type?: string }).type === 'draft-filter') as { whole: boolean; filled?: boolean };
    assert.ok(cut && cut.whole === true && cut.filled === true, 'the journal notes "filled"');
    assert.ok(!JSON.stringify(notes).includes(shown), 'and never the line itself');
  });
});

test('two empty turns in a row do not get the same line', async () => {
  await withService(true, async service => {
    const a = await reply(service, 'fill-a', '嗯', DRAFT);
    const b = await reply(service, 'fill-b', '在吗', DRAFT);
    assert.notEqual(a.shown, b.shown);
  });
});

test('ordinary turns are unchanged, with the fill on', async () => {
  await withService(true, async (service, notes) => {
    const { turn, shown } = await reply(service, 'plain-1', '面试又被刷了', '连着四次，换谁都会累的。');
    assert.equal(shown, '连着四次，换谁都会累的。');
    assert.equal(turn.emptyReply?.(), false);
    assert.ok(service.mood.get().snapshot.values.O > 50);
    assert.ok(!notes.some(note => (note as { type?: string }).type === 'draft-filter'));
  });
});

test('with the fill off the old path stays: shown nothing, archived as a failed reply', async () => {
  await withService(false, async service => {
    const { turn, shown } = await reply(service, 'off-1', '面试又被刷了', DRAFT);
    assert.equal(shown, '');
    assert.equal(turn.emptyReply?.(), true);
  });
});
