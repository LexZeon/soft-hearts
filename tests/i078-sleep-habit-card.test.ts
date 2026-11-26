/**
 * I-078 第 3 步 (docs/claude/2026-11-11-i078-sleep-step2-3.md): 睡相 is a card setting. A whole number 0 (calm) … 50 (the middle)
 * … 100 (restless); absent means the middle, so an older card stores, exports and sleeps exactly as before. It travels with the
 * card (export, import, a v3 file, an in-place update from a file that has it; a file without keeps hers), and the stage reads it.
 * Isolated temporary directories only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { CHARACTER_CARD_FORMAT, defaultCharacterMoodTemplate, validateCharacterDraft, type CharacterDraft } from '../shared/cards/character-cards';
import { cardUpdateSummaryLines, planCharacterCardUpdate } from '../shared/cards/character-card-update';
import { defaultCharacterResponseProfile } from '../shared/cards/character-response';
import { exportCharacterWithResponse, parseCharacterResponseImport } from '../shared/cards/character-response-portable';
import { sleepHabitScale } from '../shared/behaviors/sleep-body/schedule';
import { sleepBodyInput } from '../src/stage/sleep-body';
import { PerspectiveCamera, Scene } from 'three';

const zh = { name: '小满', description: '住在桌面上的伙伴。', personality: '温和，爱笑。', scenario: '刚认识。', greeting: '你好呀。', examples: '', systemPrompt: '' };
const draft = (extra: Partial<CharacterDraft> = {}): CharacterDraft => validateCharacterDraft({ ...zh, mood: defaultCharacterMoodTemplate(), ...extra });
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i078-habit-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('睡相 field: a whole number 0–100; absent is the middle and adds nothing to an older card', () => {
  assert.equal(validateCharacterDraft(zh).sleepHabit, undefined, 'an older card is left as it was');
  for (const ok of [0, 35, 50, 100]) assert.equal(validateCharacterDraft({ ...zh, sleepHabit: ok }).sleepHabit, ok);
  for (const bad of [-1, 101, 12.5, '50', null, Number.NaN]) assert.throws(() => validateCharacterDraft({ ...zh, sleepHabit: bad }), /睡相/, String(bad));
  assert.equal(sleepHabitScale(undefined), 0, 'the stage reads absent as the middle');
});

test('睡相 travels with the card: save, export, import (v2 and v3), a copy; an older card exports exactly as before; the editor\'s draft without it keeps hers', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy');
    await store.load();
    const saved = (await store.save(draft({ sleepHabit: 80 }))).cards.find(item => item.name === '小满')!;
    assert.equal(saved.sleepHabit, 80);
    assert.match(await readFile(path.join(directory, 'characters.json'), 'utf8'), /"sleepHabit": ?80/);
    const exported = store.export(saved.id);
    assert.equal(JSON.parse(exported).card.sleepHabit, 80);
    const imported = (await store.import(exported)).cards.filter(item => item.name === '小满');
    assert.equal(imported.length, 2); assert.ok(imported.every(item => item.sleepHabit === 80), 'the import keeps it');
    assert.equal(parseCharacterCardText(exported).draft.sleepHabit, 80);
    const v3 = exportCharacterWithResponse(exported, { ...defaultCharacterResponseProfile(), rules: [] });
    assert.equal(parseCharacterCardText(parseCharacterResponseImport(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 3,
      card: { ...JSON.parse(v3).card, responseProfile: defaultCharacterResponseProfile() } })).baseText).draft.sleepHabit, 80, 'a v3 file carries it');
    // The card editor saves a full draft; a draft without the field keeps the card's own (as the notes do).
    const { id, ...rest } = saved;
    const { sleepHabit: _omit, ...withoutHabit } = rest as CharacterDraft & { modelName?: string };
    const again = (await store.save(validateCharacterDraft({ ...withoutHabit, greeting: '早呀。' }), id)).cards.find(item => item.id === id)!;
    assert.equal(again.sleepHabit, 80, 'kept');
    const back = (await store.save(validateCharacterDraft({ ...withoutHabit, sleepHabit: 50 }), id)).cards.find(item => item.id === id)!;
    assert.equal(back.sleepHabit, 50, 'set back to the middle');
    // An older card (no field) exports with no field.
    const plain = (await store.save(draft())).cards.find(item => item.name === '小满' && item.sleepHabit === undefined)!;
    assert.equal(Object.hasOwn(JSON.parse(store.export(plain.id)).card, 'sleepHabit'), false);
    assert.throws(() => parseCharacterCardText(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: { ...zh, sleepHabit: 80 } })), /未知字段/, 'v1 never had it');
  });
});

test('睡相 in an in-place update (the channel\'s update_character_card): a file that has it sets it, a file without keeps hers', async () => {
  const current = { ...draft({ sleepHabit: 20 }), id: 'x' };
  const replaced = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: draft({ sleepHabit: 90 }) });
  assert.equal(replaced.summary.sleepHabit, 'replaced'); assert.equal(replaced.draft.sleepHabit, 90); assert.equal(replaced.summary.unchanged, false);
  assert.ok(cardUpdateSummaryLines(replaced.summary).some(line => line.text === '睡相：换成文件里的。'));
  const kept = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: draft() });
  assert.equal(kept.summary.sleepHabit, 'kept'); assert.equal(kept.draft.sleepHabit, 20); assert.equal(kept.summary.unchanged, true, 'nothing else changed');
  assert.ok(cardUpdateSummaryLines(kept.summary).some(line => line.text === '睡相：文件里没有，保留她现在的。'));
  const middleCard = { ...draft(), id: 'y' };
  const middle = planCharacterCardUpdate(middleCard, defaultCharacterResponseProfile(), { format: 'tavern', response: null, draft: validateCharacterDraft(zh) });
  assert.equal(middle.summary.sleepHabit, 'same', 'a middle card and a file without it: nothing to say');
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy');
    await store.load();
    const id = (await store.save(draft({ sleepHabit: 20 }))).cards.find(item => item.name === '小满')!.id;
    const plan = planCharacterCardUpdate(store.publicState().cards.find(item => item.id === id)!, defaultCharacterResponseProfile(),
      { format: 'soft-hearts-v2', response: null, draft: draft({ sleepHabit: 90, greeting: '嗨。' }) });
    const updated = await store.updateInPlace(id, plan.draft, { expected: store.cardFingerprint(id), backup: async () => {} });
    assert.equal(updated.state.cards.find(item => item.id === id)!.sleepHabit, 90, 'same id, new 睡相');
  });
});

test('the stage reads the card value: the sleep layer gets −1…1 (absent or 50 → 0)', () => {
  const camera = new PerspectiveCamera();
  const base = { mesh: {} as never, rigCache: { mesh: {} as never, rig: null }, profile: null, baseY: 0, view: null, sleepPose: true, camera, width: 400, height: 560,
    scene: new Scene(), yielding: false, busy: false };
  assert.equal(sleepBodyInput({ ...base }).habit, 0);
  assert.equal(sleepBodyInput({ ...base, sleepHabit: 50 }).habit, 0);
  assert.equal(sleepBodyInput({ ...base, sleepHabit: 100 }).habit, 1);
  assert.equal(sleepBodyInput({ ...base, sleepHabit: 0 }).habit, -1);
});
