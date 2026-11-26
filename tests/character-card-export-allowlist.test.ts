// CLAUDE.md: a character card export carries no live state, paths, keys or private history. electron/cards/character-cards.ts
// export() builds the card from draftFields() (the text fields, the mood template and the card's own switches), never from the stored
// record as a whole. A card on disk also holds things that are not the card: its id, the host-only model binding, and the
// "更真实的情绪" end time and expired note (timers). This pins that none of them reaches the exported text, on the real function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { CHARACTER_CARD_FORMAT, CHARACTER_CARD_VERSION, CHARACTER_TEXT_LIMITS, effectiveCharacterMood } from '../shared/cards/character-cards';

const ALLOWED_CARD_KEYS = [
  ...Object.keys(CHARACTER_TEXT_LIMITS),
  'mood', 'slowWarmUp', 'realerEmotions', 'understandingNotes', 'language', 'sleepHabit', 'musicTaste', 'slips',
];

test('export carries only the card (text, mood template, switches): no id, model path, timers, paths or keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-card-export-'));
  try {
    const store = new CharacterCardStore(directory, 'legacy persona');
    await store.load();
    const id = store.publicState().activeId;
    const privatePath = path.join(directory, 'private-models', 'own-model.pmx');
    await store.bindModel(id, privatePath, 'own-model.pmx');
    await store.setSlowWarmUp(id, true);
    await store.setRealerEmotions(id, true, 'week');
    const stored = store.getActive() as unknown as Record<string, unknown>;
    // The setup really put the not-for-export things on the stored card (otherwise the checks below prove nothing).
    assert.equal(typeof stored.realerEmotionsUntil, 'number', 'the stored card has an end time');
    assert.equal(stored.modelPath, privatePath);

    const text = store.export(id);
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed).sort(), ['card', 'format', 'version']);
    assert.equal(parsed.format, CHARACTER_CARD_FORMAT);
    assert.equal(parsed.version, CHARACTER_CARD_VERSION);
    const extra = Object.keys(parsed.card).filter(key => !ALLOWED_CARD_KEYS.includes(key));
    assert.deepEqual(extra, [], 'every exported key is a known card field');
    // The switches travel (they are the card's own choices); the timers and the model binding do not.
    assert.equal(parsed.card.slowWarmUp, true);
    assert.equal(parsed.card.realerEmotions, true);
    for (const key of ['id', 'modelPath', 'modelName', 'realerEmotionsUntil', 'realerEmotionsExpired']) {
      assert.equal(Object.hasOwn(parsed.card, key), false, `${key} is not exported`);
    }
    assert.ok(!text.includes(directory) && !text.includes('own-model') && !text.includes(id), 'no path, file name or id in the text');
    assert.ok(!/api[_-]?key|token|password|secret|history|journal|hormone/i.test(text), 'no key or private-state word in the text');
    // The mood is the card's template (what she starts from), not her mood now: the same numbers the card itself defines.
    assert.deepEqual(parsed.card.mood, { version: 1, parameters: effectiveCharacterMood(stored as never) });
    // The importer is strict about unknown fields, so an export it accepts has nothing beyond the card format.
    assert.doesNotThrow(() => parseCharacterCardText(text));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
