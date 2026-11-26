/**
 * 小毛病 (docs/claude/2026-11-12-loosen.md): a per-card switch (off / less / more; absent = default) on how often her small slips happen
 * when she reaches out first. The multiplier sits where slipChances is computed, so 关 means she never slips for that character only.
 * Isolated temporary directories and fakes only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { CARD_SLIPS_FACTOR, cardSlipsFactor, validateCardSlips } from '../shared/cards/card-slips';
import { SLIP_KINDS, pickSlip, slipChances, type SlipMood } from '../shared/behaviors/impulse/expression';
import { createImpulseHost } from '../electron/initiative/impulse/wiring';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { CHARACTER_CARD_FORMAT, defaultCharacterMoodTemplate, validateCharacterDraft, type CharacterDraft } from '../shared/cards/character-cards';
import { cardUpdateSummaryLines, planCharacterCardUpdate } from '../shared/cards/character-card-update';
import { defaultCharacterResponseProfile } from '../shared/cards/character-response';
import { exportCharacterWithResponse, parseCharacterResponseImport } from '../shared/cards/character-response-portable';
import { moodValueForLevel } from '../shared/foundation/mood-presets';
import type { MoodValues } from '../shared/foundation/mood';

const base = (): MoodValues => ({ D: 50, O: 50, E: 50, N: 50, C: 50 });
const lively = (cardSlips?: 'off' | 'less' | 'more'): SlipMood => ({
  values: { ...base(), N: moodValueForLevel(85, 50, 1), O: moodValueForLevel(70, 50, 1) }, baseline: base(), A: 0.6, personality: { playful: 1.4, cautious: 1.2 },
  ...(cardSlips ? { cardSlips } : {}),
});
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const zh = { name: '小满', description: '住在桌面上的伙伴。', personality: '温和，爱笑。', scenario: '刚认识。', greeting: '你好呀。', examples: '', systemPrompt: '' };
const draft = (extra: Record<string, unknown> = {}): CharacterDraft => validateCharacterDraft({ ...zh, mood: defaultCharacterMoodTemplate(), ...extra });
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-card-slips-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('multipliers: 关 = 0, 少 = half, default = 1, 多 = 1.6; anything unknown is the default', () => {
  assert.deepEqual(CARD_SLIPS_FACTOR, { off: 0, less: 0.5, more: 1.6 });
  assert.equal(cardSlipsFactor(undefined), 1); assert.equal(cardSlipsFactor(null), 1); assert.equal(cardSlipsFactor('loud'), 1); assert.equal(cardSlipsFactor('toString'), 1);
  assert.equal(cardSlipsFactor('off'), 0); assert.equal(cardSlipsFactor('less'), 0.5); assert.equal(cardSlipsFactor('more'), 1.6);
});

test('slipChances carries the factor: every kind, whatever her mood', () => {
  for (const mood of [lively(), { ...lively(), A: null, personality: null }, { values: base(), baseline: base(), A: 0.1 }] as SlipMood[]) {
    const normal = slipChances({ ...mood, cardSlips: undefined });
    for (const kind of SLIP_KINDS) {
      assert.equal(slipChances({ ...mood, cardSlips: 'off' })[kind], 0, `off ${kind}`);
      assert.ok(Math.abs(slipChances({ ...mood, cardSlips: 'less' })[kind] - normal[kind] * 0.5) < 1e-12, `less ${kind}`);
      assert.ok(Math.abs(slipChances({ ...mood, cardSlips: 'more' })[kind] - normal[kind] * 1.6) < 1e-12, `more ${kind}`);
      assert.ok(normal[kind] > 0);
    }
  }
});

test('pickSlip over many rolls: off never slips; less < default < more; "more" is still low-frequency', () => {
  const rate = (cardSlips?: 'off' | 'less' | 'more') => {
    const random = seeded(99), mood = lively(cardSlips);
    let n = 0;
    for (let i = 0; i < 20_000; i++) if (pickSlip(mood, { last: null, until: 0 }, 1_000, random)) n++;
    return n / 20_000;
  };
  const off = rate('off'), less = rate('less'), normal = rate(), more = rate('more');
  assert.equal(off, 0, 'off: not once in 20000 rolls');
  assert.ok(less > 0 && less < normal && normal < more, JSON.stringify({ less, normal, more }));
  // At an ordinary mood (her baseline, a little tired) "more" is still low-frequency per prompt (the 90-240 minute cooldown comes on top).
  const ordinary = (cardSlips?: 'off' | 'less' | 'more'): SlipMood => ({ values: base(), baseline: base(), A: 0.35, personality: {}, ...(cardSlips ? { cardSlips } : {}) });
  const ordinaryRate = (cardSlips?: 'off' | 'less' | 'more') => { const random = seeded(7); let n = 0; for (let i = 0; i < 20_000; i++) if (pickSlip(ordinary(cardSlips), { last: null, until: 0 }, 1_000, random)) n++; return n / 20_000; };
  assert.ok(ordinaryRate('more') < 0.35 && ordinaryRate('more') > ordinaryRate(),`more ${ordinaryRate('more')} default ${ordinaryRate()}`);
  // The existing per-kind soft cap (0.5) is untouched: even at the most slip-prone mood on a "more" card one kind never takes more than half the roll.
  const extreme: SlipMood = { values: { ...base(), N: 100, O: 100 }, baseline: base(), A: 1, personality: { playful: 4, cautious: 4 }, cardSlips: 'more' };
  assert.equal(pickSlip(extreme, { last: null, until: 0 }, 1_000, () => 0.5), SLIP_KINDS[1], 'a roll of 0.5 is past the first kind (capped at 0.5)');
});

test('the host: a card on 关 gets no slip in a prompt, the other characters are unaffected', () => {
  const f = { now: Date.UTC(2026, 10, 12, 6, 0, 0), cardSlips: 'off' as 'off' | undefined };
  const view = (characterId: string) => ({ characterId, expressions: true, parameters: { baseline: base(), weights: { playful: 1.4 }, evidence: { level: 1 } },
    snapshot: { values: { ...base(), N: moodValueForLevel(85, 50, 1) }, boredom: 10, longing: 10, lastInteractionAt: f.now, primary: 'happy', context: 'neutral', reason: '安静陪伴' }, fatigue: { A: 0.6 } });
  let current = 'gene';
  const host = createImpulseHost({
    mood: () => ({ get: () => view(current), unansweredSpeech: () => 0, welcomeAttention: () => true, glanceAttention: () => true, moments: { note: () => true } }) as never,
    budget: () => null, opening: () => ({ expectReach() {}, cancelReach() {} }), quiet: () => ({ asleep: false, quiet: false }), presence: () => null,
    canExpress: () => true, talk: () => undefined, journal: () => {}, clock: () => f.now, random: seeded(3),
    cardSlips: id => (id === 'gene' ? f.cardSlips : undefined),
  });
  const count = (id: string) => {
    current = id;
    let n = 0;
    for (let i = 0; i < 3_000; i++) { f.now += 7 * 60_000; if (host.expression(id, ['mood', 'time']).slip) n++; }
    return n;
  };
  assert.equal(count('gene'), 0, '关: never, in 3000 prompts');
  f.cardSlips = undefined;
  const normal = count('gene');
  assert.ok(normal > 0, 'the default card still slips');
  f.cardSlips = 'more' as never;
  const more = count('gene');
  assert.ok(more / 3_000 < 0.12, `more is still rare in a real run (the cooldown stays): ${more / 3_000}`);
  assert.ok(more >= normal * 0.8, `more is not rarer than the default (${more} vs ${normal})`);
  f.cardSlips = 'off';
  assert.ok(count('other') > 0, 'a different character (no switch) is unaffected');
});

test('card field: off / less / more are kept, "default" and absent leave it out, a bad value is refused', () => {
  assert.equal(validateCharacterDraft(zh).slips, undefined, 'an older card is left as it was');
  for (const ok of ['off', 'less', 'more'] as const) assert.equal(validateCharacterDraft({ ...zh, slips: ok }).slips, ok);
  assert.equal(Object.hasOwn(validateCharacterDraft({ ...zh, slips: 'default' }), 'slips'), false, 'named default = none');
  for (const bad of ['loud', '', 'OFF', 1, true, null, {}, 0]) assert.throws(() => validateCharacterDraft({ ...zh, slips: bad }), /小毛病/, String(bad));
  assert.throws(() => validateCardSlips('x'), /小毛病/);
});

test('slips travels with the card: save, export, import (v2 and v3), a copy; an older card exports exactly as before; the editor can clear it', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy');
    await store.load();
    const plain = (await store.save(draft())).cards.find(item => item.name === '小满')!;
    assert.equal(plain.slips, undefined);
    assert.equal(Object.hasOwn(JSON.parse(store.export(plain.id)).card, 'slips'), false, 'an older card exports exactly as before');
    const saved = (await store.save(draft({ slips: 'less' }))).cards.find(item => item.slips === 'less')!;
    assert.match(await readFile(path.join(directory, 'characters.json'), 'utf8'), /"slips": ?"less"/);
    const exported = store.export(saved.id);
    assert.equal(JSON.parse(exported).card.slips, 'less');
    assert.ok(!/path|key|token/i.test(Object.keys(JSON.parse(exported).card).join(' ')), 'the export carries no paths or keys');
    const imported = (await store.import(exported)).cards.filter(item => item.slips === 'less');
    assert.equal(imported.length, 2, 'the import keeps it');
    assert.equal(parseCharacterCardText(exported).draft.slips, 'less');
    const v3 = exportCharacterWithResponse(exported, { ...defaultCharacterResponseProfile(), rules: [] });
    assert.equal(parseCharacterCardText(parseCharacterResponseImport(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 3,
      card: { ...JSON.parse(v3).card, responseProfile: defaultCharacterResponseProfile() } })).baseText).draft.slips, 'less', 'a v3 file carries it');
    assert.throws(() => parseCharacterCardText(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: { ...zh, slips: 'off' } })), /未知字段/, 'v1 never had it');
    assert.throws(() => parseCharacterCardText(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: { ...zh, mood: defaultCharacterMoodTemplate(), slips: 'loud' } })), /小毛病/, 'a bad value in a file is refused');
    // The editor names the field every time: a draft without it keeps hers; "default" clears it; a value sets it.
    const { id, ...rest } = saved;
    const { slips: _omit, ...withoutSlips } = rest as CharacterDraft & { modelName?: string };
    assert.equal((await store.save(validateCharacterDraft({ ...withoutSlips, greeting: '早呀。' }), id)).cards.find(item => item.id === id)!.slips, 'less', 'kept');
    assert.equal((await store.save({ ...validateCharacterDraft(withoutSlips), slips: 'more' }, id)).cards.find(item => item.id === id)!.slips, 'more');
    assert.equal((await store.save({ ...validateCharacterDraft(withoutSlips), slips: 'default' as never }, id)).cards.find(item => item.id === id)!.slips, undefined, 'back to the default');
  });
});

test('a card file already on disk without the field loads unchanged (default), and one with a bad value does not load a bad value', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy');
    await store.load();
    const card = (await store.save(draft())).cards.find(item => item.name === '小满')!;
    assert.equal(cardSlipsFactor(card.slips), 1, 'an older card reads as the default');
    assert.equal(slipChances({ ...lively(), cardSlips: card.slips })['change-mind'], slipChances(lively())['change-mind']);
  });
});

test('slips in an in-place update (update_character_card): a file that has it sets it, a file without keeps hers', () => {
  const current = { ...draft({ slips: 'off' }), id: 'x' };
  const replaced = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: draft({ slips: 'more' }) });
  assert.equal(replaced.summary.slips, 'replaced'); assert.equal(replaced.draft.slips, 'more'); assert.equal(replaced.summary.unchanged, false);
  assert.ok(cardUpdateSummaryLines(replaced.summary).some(line => line.text === '小毛病：换成文件里的。'));
  const kept = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: draft() });
  assert.equal(kept.summary.slips, 'kept'); assert.equal(kept.draft.slips, 'off'); assert.equal(kept.summary.unchanged, true);
  assert.ok(cardUpdateSummaryLines(kept.summary).some(line => line.text === '小毛病：文件里没有，保留她现在的。'));
  const plainCard = { ...draft(), id: 'y' };
  const none = planCharacterCardUpdate(plainCard,defaultCharacterResponseProfile(), { format: 'tavern', response: null, draft: validateCharacterDraft(zh) });
  assert.equal(none.summary.slips, 'same');
});
