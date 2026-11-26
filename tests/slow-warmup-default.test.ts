// 慢慢熟悉 is on by default for every character:
// docs/claude/2026-11-20-slow-warmup-default.md. A character that explicitly saved off keeps off; nothing of a relationship is reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { CHARACTER_CARD_FORMAT, CHARACTER_CARD_VERSION, type CharacterDraft } from '../shared/cards/character-cards';
import { slowWarmUpOf } from '../shared/foundation/character-card';
import { planCharacterCardUpdate, type CharacterCardFileContent } from '../shared/cards/character-card-update';
import { RelationshipHost, relationshipCardOf } from '../electron/memory/relationship/host';
import { emptyRelationship, type RelationshipData } from '../shared/memory/relationship';
import { localDateKey } from '../electron/memory/diary/diary-dates';

const draft = (name: string, fields: Partial<CharacterDraft> = {}): CharacterDraft => ({
  name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', ...fields,
});
async function withStore(run: (store: CharacterCardStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-warmup-default-'));
  try { const store = new CharacterCardStore(directory, 'Existing custom persona'); await store.load(); await run(store, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const warmOf = (store: CharacterCardStore, id: string) => relationshipCardOf(store.publicState().cards.find(card => card.id === id))?.slowWarmUp;

test('the default: a missing field reads as on, only an explicit false is off', () => {
  assert.equal(slowWarmUpOf({}), true);
  assert.equal(slowWarmUpOf({ slowWarmUp: true }), true);
  assert.equal(slowWarmUpOf({ slowWarmUp: false }), false);
  assert.equal(slowWarmUpOf(null), true);
});

test('new, bundled and imported-without-field cards are on; a saved off stays off through save, export, import and update', async () => {
  await withStore(async (store, directory) => {
    // The bundled card (nobody saved a choice): on.
    const bundled = store.publicState().activeId;
    assert.equal(warmOf(store, bundled), true, 'bundled card');
    // A new card from a draft that does not name it: on, and no field is written.
    const state = await store.save(draft('新角色'));
    const id = state.cards.find(card => card.name === '新角色')!.id;
    assert.equal(warmOf(store, id), true, 'new card');
    const stored = () => readFile(path.join(directory, 'characters.json'), 'utf8').then(JSON.parse).then(value => value.cards.find((card: { id: string }) => card.id === id));
    assert.equal(Object.hasOwn(await stored(), 'slowWarmUp'), false);
    // An imported card without the field: on.
    const file = JSON.parse(store.export(id));
    const without = JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: CHARACTER_CARD_VERSION, card: { ...file.card, slowWarmUp: undefined, name: '没写这一项' } });
    const imported = await store.import(without);
    assert.equal(warmOf(store, imported.cards.find(card => card.name === '没写这一项')!.id), true, 'imported without the field');
    // The user turns it off: saved as false, and it stays off when a later save does not name it.
    await store.save(draft('新角色', { slowWarmUp: false }), id);
    assert.equal(warmOf(store, id), false);
    assert.equal((await stored()).slowWarmUp, false);
    await store.save(draft('新角色'), id);
    assert.equal(warmOf(store, id), false, 'the saved choice wins over a draft that does not name it');
    // Export carries it, and an import of that file is off again.
    const offFile = store.export(id);
    assert.equal(JSON.parse(offFile).card.slowWarmUp, false);
    const copy = (await store.import(offFile)).cards.find(card => card.id !== id && card.name === '新角色')!;
    assert.equal(warmOf(store, copy.id), false, 'an exported off imports as off');
    // The on card exports as on.
    assert.equal(JSON.parse(store.export(bundled)).card.slowWarmUp, true);
    // The setting switch writes both ways.
    await store.setSlowWarmUp(id, true);
    assert.equal(warmOf(store, id), true);
    await store.setSlowWarmUp(id, false);
    assert.equal((await stored()).slowWarmUp, false);
  });
});

test('updating a card from a file that does not name it keeps her saved choice; a file that names it changes it', () => {
  const file = (fields: Partial<CharacterDraft>): CharacterCardFileContent => ({ format: 'soft-hearts-v3', draft: draft('甲', fields), response: null } as unknown as CharacterCardFileContent);
  const off = draft('甲', { slowWarmUp: false });
  assert.equal(planCharacterCardUpdate(off, { rules: [] } as never, file({})).draft.slowWarmUp, false, 'her off is kept');
  assert.equal(planCharacterCardUpdate(draft('甲'), { rules: [] } as never, file({})).summary.slowWarmUp.after, true, 'never saved: on');
  assert.equal(planCharacterCardUpdate(off, { rules: [] } as never, file({ slowWarmUp: true })).draft.slowWarmUp, true, 'a file that says on turns it on');
  assert.equal(planCharacterCardUpdate(draft('甲', { slowWarmUp: true }), { rules: [] } as never, file({ slowWarmUp: false })).draft.slowWarmUp, false);
});

test('turning it on resets nothing: the stage comes from the days already on file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-warmup-stage-'));
  try {
    const now = Date.UTC(2026, 10, 20, 12), today = localDateKey(now);
    const day = (back: number) => localDateKey(now - back * 86_400_000);
    const long: RelationshipData = { ...emptyRelationship(today), metDate: day(40), days: Array.from({ length: 31 }, (_, i) => day(i + 1)).sort(), qualityDays: [day(2), day(3)] };
    const fresh: RelationshipData = { ...emptyRelationship(today), metDate: day(1), days: [] };
    const host = new RelationshipHost({ directory, developerMode: () => false, now: () => now });
    // A card that never saved a choice: on (via the wiring's card source).
    host.setCardSource(() => relationshipCardOf({ mood: undefined }));
    await host.seed('long', long); await host.seed('fresh', fresh);
    assert.equal(host.stage('long'), 'close', '31 days together with two quality days is "很熟", not a stranger');
    assert.equal(host.stage('fresh'), 'new');
    assert.match(host.opening('long', { firstTurn: false })!.text, /熟悉度第 4 级「很熟」/);
    assert.equal(host.memesAllowed('long'), true);
    // The same history with an explicit off: no stage, familiar from day one (unchanged behaviour).
    host.setCardSource(() => relationshipCardOf({ mood: undefined, slowWarmUp: false }));
    assert.equal(host.stage('long'), null);
    assert.match(host.opening('long', { firstTurn: false })!.text, /从一开始就和用户很熟/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
