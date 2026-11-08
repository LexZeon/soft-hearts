import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { CharacterCardStore } from '../electron/character-cards';
import { effectiveCharacterMood, type CharacterDraft } from '../shared/character-cards';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { ProviderConfig } from '../shared/contracts';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://fixture.invalid/v1', model: 'fixture' };
test('portable templates reach the actual simulation without importing experience or resetting an active conversation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-template-integration-'));
  const service = new CompanionService(directory, () => {});
  try {
    const cards = new CharacterCardStore(directory, 'Gene'); await cards.load(); await service.load();
    await cards.ensureMoodTemplates(id => service.mood.getSavedParameters(id));
    const p = structuredClone(DEFAULT_MOOD_PARAMETERS); p.baseline.O = 60; p.sensitivity.O = 2;
    const draft: CharacterDraft = { name: 'Warm', description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: 'Warm', mood: { version: 1, parameters: p } };
    await cards.save(draft); const card = cards.publicState().cards.at(-1)!; await cards.activate(card.id);
    await service.context(card.id, provider, 'Warm', effectiveCharacterMood(card));
    assert.equal(service.mood.get().snapshot.values.O, 60);
    assert.equal(service.mood.get().snapshot.lastInteractionAt, null);
    assert.equal(service.memory.list(service.currentScope()).total, 0);
    const output: string[] = [];
    const turn = await service.begin('active-turn', '原创亲近测试', 'Warm', (type, text) => { if (type === 'delta') output.push(text); });
    turn.push('delta', '已显示');
    const before = service.mood.get(); const changed = structuredClone(p); changed.baseline.O = 44; changed.sensitivity.O = 0.5;
    await cards.saveMoodParameters(card.id, changed);
    await service.context(card.id, provider, 'Warm', effectiveCharacterMood(cards.getActive()));
    turn.push('delta', '仍继续'); await turn.finish('complete');
    assert.equal(output.join(''), '已显示仍继续');
    assert.equal(service.mood.get().token, before.token);
    assert.equal(service.mood.get().snapshot.lastInteractionAt, before.snapshot.lastInteractionAt);
    assert.ok(Math.abs(service.mood.get().snapshot.values.O - before.snapshot.values.O) < 0.01);
    const exported = cards.export(card.id); await cards.import(exported); const copy = cards.publicState().cards.at(-1)!;
    await service.context(copy.id, provider, 'Warm', effectiveCharacterMood(copy));
    assert.equal(service.mood.get().snapshot.values.O, 44);
    assert.equal(service.mood.get().snapshot.lastInteractionAt, null);
    assert.equal(service.memory.list(service.currentScope()).total, 0);
    service.mood.event({ type: 'chat', id: 'same-event', delta: { O: 8 }, context: 'support' });
    const smallGain = service.mood.get().snapshot.values.O - 44;
    await service.context('strong-fixture', provider, 'Warm', p);
    service.mood.event({ type: 'chat', id: 'same-event', delta: { O: 8 }, context: 'support' });
    assert.ok(service.mood.get().snapshot.values.O - 60 > smallGain * 2, 'card sensitivity materially changes the same accepted input');
  } finally {
    await service.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-template-integration-'));
    await rm(directory, { recursive: true, force: true });
  }
});
