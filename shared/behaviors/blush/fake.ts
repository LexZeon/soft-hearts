/**
 * #26 的假实现：卡上的脸红参数原样用，每次都一样（= 原来的做法：同一个形状、卡上的冷却、摸头门槛照卡上的）。
 * 守约测试（tests/blush.test.ts）拿它和真实现跑同一组约定；别的测试要固定的脸红时也用它。以后接新实现，先拿它对一遍。
 */
import type { MoodBlushParameters } from '../../mood';
import { blushShapeText } from './choose';
import type { BlushChance, BlushHost, BlushNow, BlushOutcome, BlushPrepared, BlushWhy } from './interface';

export class FixedBlush implements BlushHost {
  private readonly log: (BlushWhy & { characterId: string })[] = [];
  private readonly pending = new Map<number, { characterId: string; card: MoodBlushParameters; chance: BlushChance }>();
  private next = 1;
  /** How many blushes it was told about (tests). */
  blushes = 0;

  profile(_characterId: string, card: Readonly<MoodBlushParameters>): MoodBlushParameters { return card as MoodBlushParameters; }

  prepare(characterId: string, card: Readonly<MoodBlushParameters>, chance: Readonly<BlushChance>, now: () => BlushNow | null): BlushPrepared {
    void now;
    if (!card.enabled || !(card.intensity > 0) || (chance.cue && chance.cue.until > chance.at)
      || (chance.lastBlushAt !== null && chance.at - chance.lastBlushAt < card.cooldownMs)) return { profile: card as MoodBlushParameters, thresholdScale: 1, draw: null };
    const token = this.next++;
    this.pending.clear();
    this.pending.set(token, { characterId, card: { ...card }, chance: { ...chance } });
    return { profile: card as MoodBlushParameters, thresholdScale: 1, draw: token };
  }

  settle(characterId: string, prepared: BlushPrepared, outcome: Readonly<BlushOutcome>): void {
    const pending = prepared.draw === null ? undefined : this.pending.get(prepared.draw);
    if (prepared.draw !== null) this.pending.delete(prepared.draw);
    if (!pending || pending.characterId !== characterId || !outcome.cue) return;
    this.blushes++;
    this.log.unshift({ characterId, at: pending.chance.at, contact: pending.chance.contact, look: '卡上的形状', why: ['假实现：卡上的脸红参数原样用，每次都一样'],
      shape: blushShapeText(pending.card, pending.card), cooldownMs: pending.card.cooldownMs, weights: '' });
    this.log.splice(32);
  }

  recent(characterId: string): readonly BlushWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, 4).map(({ characterId: _, ...entry }) => ({ ...entry, why: [...entry.why] }));
  }
}
