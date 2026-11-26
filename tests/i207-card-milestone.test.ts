/**
 * I-207 a card's milestone (about Gene: "签收也可加个状态"): the declaration on the card, the
 * hidden marker (recorded once, never shown), the one information line per turn (only for a card that declares it; zh / en), the user's clear (with the
 * bin first), and export / import (the words travel, the reached state never does). Made-up cards and temporary folders only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { MILESTONE_MARK_WORD, cardMilestoneView, isCardMilestoneRequest, isMilestoneMarker, milestoneDateText, milestoneLine, validateCardMilestone } from '../shared/cards/card-milestone';
import { SpeechBeatFilter, filterSpeechBeats } from '../shared/behaviors/speech-beats/choose';
import { ALARM_MARK_CLOSE, ALARM_MARK_OPEN } from '../shared/behaviors/alarms/interface';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { compileCharacterPersona, defaultCharacterMoodTemplate, validateCharacterDraft, type CharacterDraft } from '../shared/cards/character-cards';
import { cardUpdateSummaryLines, planCharacterCardUpdate } from '../shared/cards/character-card-update';
import { defaultCharacterResponseProfile } from '../shared/cards/character-response';
import { exportCharacterWithResponse } from '../shared/cards/character-response-portable';
import { RelationshipHost } from '../electron/memory/relationship/host';
import { validateRelationship } from '../electron/memory/relationship/store';
import { emptyRelationship, sanitizeRelationshipDiagnostic, type RelationshipDiagnostic } from '../shared/memory/relationship';
import { cardMilestoneRequest, milestoneReplyDone, milestoneTurnLine, type MilestoneRelationship } from '../electron/wiring/card-milestone-wiring';
import { takeCardMilestone } from '../electron/memory/recycle/items-wiring';
import { ITEM_RESTORERS } from '../electron/memory/recycle/items-wiring';

const GENE = { name: '这一单', notYet: '还没签收', reached: '已签收' };
const EN = { name: 'This delivery', notYet: 'not signed for yet', reached: 'signed for' };
const zh = { name: '小满', description: '住在桌面上的伙伴。', personality: '温和，爱笑。', scenario: '刚认识。', greeting: '你好呀。', examples: '', systemPrompt: '' };
const draft = (extra: Record<string, unknown> = {}): CharacterDraft => validateCharacterDraft({ ...zh, mood: defaultCharacterMoodTemplate(), ...extra });
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-milestone-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const at = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime();
const mark = (body: string) => `${ALARM_MARK_OPEN}${body}${ALARM_MARK_CLOSE}`;

// ---- the declaration ----
test('the declaration: exactly name / notYet / reached, one plain line each; anything else is refused', () => {
  assert.deepEqual(validateCardMilestone({ name: ' 这一单 ', notYet: '还没签收', reached: '已签收' }), GENE);
  for (const bad of [null, 'x', [], {}, { name: 'a', notYet: 'b' }, { ...GENE, extra: 'x' }, { ...GENE, name: '' }, { ...GENE, name: '   ' }, { ...GENE, notYet: 5 },
    { ...GENE, name: 'a'.repeat(25) }, { ...GENE, reached: '签收\n了' }, { ...GENE, reached: '⟪milestone⟫' }, { ...GENE, name: '<b>' }, { ...GENE, name: '[x]' }, { ...GENE, name: 'a|b' }, { ...GENE, name: '【词】' }])
    assert.throws(() => validateCardMilestone(bad), /./su, JSON.stringify(bad));
});

test('a card draft may carry it; a card without one has nothing about it; her persona never changes', () => {
  const plain = draft(), withMilestone = draft({ milestone: GENE });
  assert.deepEqual(withMilestone.milestone, GENE);
  assert.equal(Object.hasOwn(plain, 'milestone'), false);
  assert.equal(compileCharacterPersona(withMilestone), compileCharacterPersona(plain), 'the declaration is not persona text: not a byte more in the persona');
  assert.throws(() => draft({ milestone: { name: '', notYet: 'a', reached: 'b' } }), /里程碑/);
});

// ---- the line ----
test('the line: one short information line, in the card language; not yet carries how the marker is spelled, reached carries the date', () => {
  assert.equal(milestoneLine(GENE, null, 'zh-CN'), `这一单：还没签收。（回复里写 ⟪${MILESTONE_MARK_WORD}⟫ 就记下这一天，这个记号不显示。）`);
  assert.equal(milestoneLine(GENE, '2026-11-23', 'zh-CN'), '这一单：已签收（11月23日）。');
  assert.equal(milestoneLine(EN, null, 'en'), `This delivery: not signed for yet. (Writing ⟪${MILESTONE_MARK_WORD}⟫ in a reply records the day; the marker is never shown.)`);
  assert.equal(milestoneLine(EN, '2026-11-23', 'en'), 'This delivery: signed for (Nov 23).');
  assert.equal(milestoneLine(GENE, 'garbled', 'zh-CN'), '这一单：已签收。', 'a damaged date names no date');
  assert.equal(milestoneDateText('2026-02-05', 'zh-CN'), '2月5日'); assert.equal(milestoneDateText('2026-12-31', 'en'), 'Dec 31'); assert.equal(milestoneDateText('2026-13-01', 'en'), '');
  for (const line of [milestoneLine(GENE, null, 'zh-CN'), milestoneLine(GENE, '2026-11-23', 'zh-CN')]) assert.ok(!/应该|必须|请你|不要|记得要/u.test(line), 'nothing that tells her how to act: ' + line);
  assert.deepEqual(cardMilestoneView(GENE, null), { ...GENE, done: false, date: null });
  assert.deepEqual(cardMilestoneView(GENE, '2026-11-23'), { ...GENE, done: true, date: '2026-11-23' });
});

// ---- the marker: never shown ----
test('the marker never reaches the text, in any chunking, and its body is handed over; extras are not the marker', () => {
  const reply = `签收的事慢慢来。${mark('milestone')}我在这儿。`;
  const whole = filterSpeechBeats(reply);
  assert.equal(whole.text, '签收的事慢慢来。我在这儿。');
  assert.deepEqual(whole.alarms, ['milestone']);
  for (let cut = 1; cut < reply.length; cut++) {
    const filter = new SpeechBeatFilter();
    const shown = filter.push(reply.slice(0, cut)).text + filter.push(reply.slice(cut)).text + filter.end().text;
    assert.equal(shown, '签收的事慢慢来。我在这儿。', `cut at ${cut}`);
    assert.deepEqual(filter.summary().alarms, ['milestone']);
  }
  const unclosed = filterSpeechBeats(`好。${ALARM_MARK_OPEN}milestone`);
  assert.equal(unclosed.text, '好。'); assert.deepEqual(unclosed.alarms, [], 'never closed: gone, never shown, not read');
  assert.equal(isMilestoneMarker('milestone'), true); assert.equal(isMilestoneMarker(' Milestone '), true);
  for (const not of ['milestone|x=1', 'milestones', 'alarm|in=5m|note=x', '', 5, null]) assert.equal(isMilestoneMarker(not), false, String(not));
});

// ---- the host: recorded once ----
function hostIn(directory: string, clock: { now: number }, rows: RelationshipDiagnostic[] = []): RelationshipHost {
  return new RelationshipHost({ directory, now: () => clock.now, developerMode: () => false, journal: (_id, entry) => { rows.push(entry); } });
}

test('recorded once with the local date, one closed-word journal row; a later marker changes nothing and writes no row', async () => {
  await withDirectory(async directory => {
    const clock = { now: at(11, 23) }, rows: RelationshipDiagnostic[] = [], host = hostIn(directory, clock, rows);
    assert.equal(await host.ensureCardMilestone('gene'), null);
    assert.equal(await host.reachCardMilestone('gene'), true);
    clock.now = at(11, 28);
    assert.equal(await host.reachCardMilestone('gene'), false);
    assert.equal(host.cardMilestoneDate('gene'), '2026-11-23');
    const mine = rows.filter(row => row.kind === 'card-milestone');
    assert.equal(mine.length, 1);
    assert.deepEqual(Object.keys(mine[0]!).sort(), ['at', 'dayNumber', 'kind', 'qualityDays', 'togetherDays'], 'numbers and a closed word only: no date string, no words of hers');
    assert.notEqual(sanitizeRelationshipDiagnostic(mine[0]), null);
    await host.flush();
    const again = hostIn(directory, clock);
    assert.equal(await again.ensureCardMilestone('gene'), '2026-11-23', 'it survives a restart');
    assert.equal(await again.ensureCardMilestone('someone-else'), null, 'it belongs to this character only');
    await again.flush();
  });
});

test('clear returns the date and removes it; restore puts it back and keeps what it replaced; a damaged value is refused', async () => {
  await withDirectory(async directory => {
    const clock = { now: at(11, 23) }, host = hostIn(directory, clock);
    await host.reachCardMilestone('gene');
    assert.equal(await host.clearCardMilestone('gene'), '2026-11-23');
    assert.equal(host.cardMilestoneDate('gene'), null);
    assert.equal(await host.clearCardMilestone('gene'), null, 'nothing to clear');
    assert.equal(await host.restoreCardMilestone('gene', '2026-11-23'), null);
    assert.equal(host.cardMilestoneDate('gene'), '2026-11-23');
    clock.now = at(12, 2); await host.clearCardMilestone('gene'); await host.reachCardMilestone('gene');
    assert.equal(await host.restoreCardMilestone('gene', '2026-11-23'), '2026-12-02', 'what it replaced is handed back for the bin');
    await assert.rejects(() => host.restoreCardMilestone('gene', 'yesterday'), /不完整/);
    await host.flush();
  });
});

test('forgetting the character removes it with her relationship file; a converted card does not carry it', async () => {
  await withDirectory(async directory => {
    const clock = { now: at(11, 23) }, host = hostIn(directory, clock);
    await host.reachCardMilestone('gene');
    const snapshot = await host.snapshot('gene');
    assert.deepEqual(snapshot.cardMilestone, { date: '2026-11-23' });
    await host.adopt('converted', snapshot);
    assert.equal(await host.ensureCardMilestone('converted'), null, 'whether it happened belongs to the character it happened with');
    await host.forget('gene');
    assert.equal(await host.ensureCardMilestone('gene'), null);
    assert.deepEqual((await readdir(path.join(directory, 'relationship'))).filter(name => name.startsWith('gene')), []);
    await host.flush();
  });
});

test('the relationship file format: a good value loads, a malformed one is refused, older files without it still load', () => {
  const base = emptyRelationship('2026-11-01');
  assert.deepEqual(validateRelationship({ ...base, cardMilestone: { date: '2026-11-23' } }).cardMilestone, { date: '2026-11-23' });
  assert.equal(Object.hasOwn(validateRelationship(base), 'cardMilestone'), false);
  for (const bad of [{ date: 'x' }, { date: '2026-11-23', extra: 1 }, null, 'x', []]) assert.throws(() => validateRelationship({ ...base, cardMilestone: bad }), /关系数据/, JSON.stringify(bad));
});

// ---- the wiring: only a card that declares it ----
function relationshipSpy(): MilestoneRelationship & { calls: string[]; date: string | null } {
  const spy = { calls: [] as string[], date: null as string | null,
    async ensureCardMilestone(id: string) { spy.calls.push('ensure:' + id); return spy.date; },
    async reachCardMilestone(id: string) { spy.calls.push('reach:' + id); if (spy.date) return false; spy.date = '2026-11-23'; return true; },
    async clearCardMilestone(id: string) { spy.calls.push('clear:' + id); const was = spy.date; spy.date = null; return was; } };
  return spy;
}

test('no milestone, no line: a card without one gets nothing, reads nothing and writes nothing', async () => {
  const relationship = relationshipSpy(), card = { id: 'plain', language: 'zh-CN' };
  assert.equal(await milestoneTurnLine(card, relationship), '');
  assert.equal(await milestoneReplyDone(card, relationship, ['milestone']), false);
  assert.equal(isCardMilestoneRequest({ action: 'milestone-view' }), false, 'reading moved to the archive call (I-208)');
  assert.equal(await cardMilestoneRequest({ action: 'milestone-clear' }, card, relationship, async () => { throw new Error('no bin'); }, async () => null), null);
  assert.deepEqual(relationship.calls, [], 'the relationship file is never touched');
});

test('a card with one: the line follows the state; only the exact marker records it, once; her words alone never do', async () => {
  const relationship = relationshipSpy(), card = { id: 'gene', milestone: GENE };
  assert.match(await milestoneTurnLine(card, relationship), /^这一单：还没签收。/);
  assert.equal(await milestoneReplyDone(card, relationship, ['milestone|x=1', 'alarm|in=5m|note=x']), false, 'not the marker');
  assert.equal(await milestoneReplyDone(card, relationship, []), false);
  assert.equal(await milestoneReplyDone(card, relationship, undefined), false);
  assert.equal(relationship.date, null);
  assert.equal(await milestoneReplyDone(card, relationship, ['milestone']), true);
  assert.equal(await milestoneReplyDone(card, relationship, ['milestone']), false, 'later markers are ignored');
  assert.equal(await milestoneTurnLine(card, relationship), '这一单：已签收（11月23日）。');
  const en = { id: 'gene-en', language: 'en', milestone: EN };
  assert.equal(await milestoneTurnLine(en, relationship), 'This delivery: signed for (Nov 23).', 'the card language decides the wording');
  const broken: MilestoneRelationship = { ...relationship, ensureCardMilestone: async () => { throw new Error('disk'); }, reachCardMilestone: async () => { throw new Error('disk'); } };
  assert.equal(await milestoneTurnLine(card, broken), '', 'her chat never waits on this');
  assert.equal(await milestoneReplyDone(card, broken, ['milestone']), false);
});

test('the page: clear only through the bin first (take, then remove), then the view after', async () => {
  const relationship = relationshipSpy(), card = { id: 'gene', milestone: GENE }, order: string[] = [];
  const recycled = async (take: () => Promise<unknown>, remove: () => Promise<unknown>) => { order.push('take:' + JSON.stringify(await take())); await remove(); order.push('removed'); };
  relationship.date = '2026-11-23';
  const after = await cardMilestoneRequest({ action: 'milestone-clear' }, card, relationship, recycled, async () => 'copy');
  assert.deepEqual(order, ['take:"copy"', 'removed']);
  assert.deepEqual(after, { ...GENE, done: false, date: null });
  assert.equal(isCardMilestoneRequest({ action: 'milestone-clear' }), true); assert.equal(isCardMilestoneRequest({ action: 'switch', on: true }), false); assert.equal(isCardMilestoneRequest(null), false);
});

test('the bin: what a clear keeps is the date; restoring puts it back', async () => {
  await withDirectory(async directory => {
    const clock = { now: at(11, 23) }, host = hostIn(directory, clock);
    await host.reachCardMilestone('gene');
    const stores = { relationship: host } as never;
    const take = await takeCardMilestone(stores, 'gene');
    assert.deepEqual(take, { kind: 'card-milestone', characterId: 'gene', count: 1, label: '角色卡里那件事的“到了”', data: { kind: 'card-milestone', date: '2026-11-23' } });
    assert.equal(await takeCardMilestone(stores, 'nobody'), null, 'nothing reached, nothing to take');
    await host.clearCardMilestone('gene');
    const kept: unknown[] = [];
    const result = await ITEM_RESTORERS['card-milestone']({ characterId: 'gene' } as never, take!.data, { stores, keep: (entry: unknown) => { kept.push(entry); return null; } } as never);
    assert.equal(result, null); assert.equal(host.cardMilestoneDate('gene'), '2026-11-23'); assert.deepEqual(kept, []);
    await host.flush();
  });
});

// ---- the card: the words travel, the state never does ----
test('export keeps the declaration and nothing of the state; import brings the declaration into a new card; v3 files carry it too', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'm');
    await store.load();
    const saved = (await store.save(draft({ milestone: GENE }))).cards.find(item => item.name === '小满')!;
    assert.deepEqual(saved.milestone, GENE);
    const exported = store.export(saved.id), card = JSON.parse(exported).card;
    assert.deepEqual(card.milestone, GENE);
    assert.ok(!/cardMilestone|"date"|"done"|20\d\d-\d\d-\d\d/u.test(exported), 'no state in the file');
    assert.deepEqual(Object.keys(card.milestone).sort(), ['name', 'notYet', 'reached']);
    assert.deepEqual(parseCharacterCardText(exported).draft.milestone, GENE);
    const imported = (await store.import(exported)).cards.filter(item => item.name === '小满' && item.milestone);
    assert.equal(imported.length, 2);
    const v3 = exportCharacterWithResponse(exported, { ...defaultCharacterResponseProfile(), rules: [] });
    assert.deepEqual(JSON.parse(v3).card.milestone, GENE);
    assert.throws(() => parseCharacterCardText(JSON.stringify({ format: 'soft-hearts-character-card', version: 1, card: { ...zh, milestone: GENE } })), /未知字段/, 'v1 never had it');
    assert.throws(() => parseCharacterCardText(JSON.stringify({ format: 'soft-hearts-character-card', version: 2, card: { ...zh, mood: defaultCharacterMoodTemplate(), milestone: { name: '', notYet: 'a', reached: 'b' } } })), /里程碑/, 'a bad one in a file is refused');
    // The editor does not name it: a save without the field keeps hers.
    const { id, milestone: _gone, ...rest } = saved as CharacterDraft & { id: string; modelName?: string };
    assert.deepEqual((await store.save(validateCharacterDraft({ ...rest, greeting: '早呀。' }), id)).cards.find(item => item.id === id)!.milestone, GENE, 'kept');
    assert.match(await readFile(path.join(directory, 'characters.json'), 'utf8'), /"milestone"/);
  });
});

test('an in-place update: a file that declares one sets it, a file without keeps hers; reported in the confirmation', () => {
  const current = { ...draft({ milestone: GENE }), id: 'x' };
  const file = (extra?: Record<string, unknown>) => ({ format: 'soft-hearts-v2' as const, response: null, draft: draft(extra) });
  const replaced = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), file({ milestone: EN }));
  assert.equal(replaced.summary.milestone, 'replaced'); assert.deepEqual(replaced.draft.milestone, EN); assert.equal(replaced.summary.unchanged, false);
  assert.ok(cardUpdateSummaryLines(replaced.summary).some(line => line.text.startsWith('里程碑：换成文件里的')));
  const kept = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), file());
  assert.equal(kept.summary.milestone, 'kept'); assert.deepEqual(kept.draft.milestone, GENE); assert.equal(kept.summary.unchanged, true);
  assert.ok(cardUpdateSummaryLines(kept.summary).some(line => line.text === '里程碑：文件里没有，保留她现在的。'));
  const same = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), file({ milestone: GENE }));
  assert.equal(same.summary.milestone, 'same');
  const fresh = planCharacterCardUpdate(Object.assign(draft(), { id: 'y' }), defaultCharacterResponseProfile(), file({ milestone: GENE }));
  assert.equal(fresh.summary.milestone, 'replaced', 'a card gaining one for the first time');
  const none = planCharacterCardUpdate(Object.assign(draft(), { id: 'z' }), defaultCharacterResponseProfile(), file());
  assert.equal(none.summary.milestone, 'same');
  assert.ok(!cardUpdateSummaryLines(none.summary).some(line => line.text.startsWith('里程碑')));
});
