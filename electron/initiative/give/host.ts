/**
 * I-086 她也照顾你, host side (docs/claude/2026-11-11-i086-give-and-keep.md).
 *
 *   her opening choice weighs "递给你点东西" (peek: today's offers left, the reasons from her hormones and mood values)
 *   ─▶ chosen: the inner loop asks for her own line (focus 'give'; promptLine says what she is about to hand over and why)
 *   ─▶ her line was shown (delivered) ─▶ the companion window's stage hands it over (desk:give offer)
 *   ─▶ taken: a small O and D lift (mood moment 'gave-taken', with its cooldown) · not taken: nothing at all (no guilt)
 *   ─▶ one record in 我们的小东西 and one journal line (the item, how it ended, the reasons only)
 *   special moments (≤ 1 a day): the stage renders one frame of her holding it, which becomes a picture card she leaves you.
 * Also keeps the snacks you fed her (feed recognition hands over the recognised name, her line and the shrunk picture; only while
 * the profile's "允许记录" is on). Never a camera, a screen, a model call of its own or a network request.
 */
import { randomBytes } from 'node:crypto';
import {
  giveAllowed, giveLean, noteGiveOffer, notePicture, pictureAllowed, pictureMoment, pickGiveItem, type FedSnackPicture, type GiveMood,
  type GivePick, type GiveUserMoment, type PictureReason,
} from '../../../shared/behaviors/give/choose';
import { GIVE_ITEMS, GIVE_KNOBS, type GiveItemId } from '../../../shared/behaviors/give/knobs';
import { readGiveAnswer, readGivePicture, type GiveEvent, type GiveOutcome } from '../../../shared/behaviors/give/interface';
import { ourThing, ourThingView, type OurThing, type OurThingsView } from '../../../shared/initiative/our-things'; // direct, not via shared/memory: the page would pull this host-only module into the renderer bundle (docs/claude/2026-11-16-overhaul-parts-2.md)
import type { OurThingsStore } from './store';

export interface GiveJournalInput {
  type: 'give'; characterId: string; event: GiveOutcome | 'picture'; item: GiveItemId; why: GivePick['why'][number][]; fromFed?: boolean; picture?: PictureReason;
}

export interface GiveHostOptions {
  store: Pick<OurThingsStore, 'load' | 'loaded' | 'list' | 'ledger' | 'setLedger' | 'add' | 'remove' | 'mark' | 'picture'>;
  /** The app's 内心循环 setting and 自动表现 (off: she offers nothing; #13 no fixed lines either). */
  enabled(): boolean;
  /** Her mood now, relative to her card (values, baseline, evidence, M longing, A sleep pressure); null when not known. */
  mood(characterId: string): GiveMood | null;
  /** The user's moment: local time, said tired, how long still. */
  user(): GiveUserMoment;
  /** Today is a special day the user told her about (I-059). */
  specialDay(characterId: string): boolean;
  /** To the companion window (desk:give); false when it could not be sent. */
  send(event: GiveEvent): boolean;
  /** The mood moment 'gave-taken' (electron/mood/mood-moments.ts; its own cooldown and day count). */
  moment(characterId: string, key: string): void;
  journal?(entry: GiveJournalInput): void;
  /** 我们的小东西 changed (the control page re-reads). */
  changed?(characterId: string): void;
  /** Her folder (when on): the same list as a small text file, and her pictures; each through the folder's own checked path. */
  folder?: { list(characterId: string, list: readonly OurThing[]): void; picture?(characterId: string, thing: OurThing, png: Uint8Array): void };
  /** The user profile's "允许记录": the snacks you fed her are kept only then. */
  recording(): boolean;
  /** A JPEG of at most 256 px from the picture feeding already shrank (in memory); null when it cannot be made. */
  thumb(dataUrl: string): Uint8Array | null;
  clock?: () => number;
  random?: () => number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Plan { readonly at: number; readonly pick: GivePick; readonly lean: ReturnType<typeof giveLean> }
interface Offer {
  readonly id: string; readonly characterId: string; readonly pick: GivePick; readonly line: string; readonly at: number;
  readonly pictureReason: PictureReason | null; timer: unknown; picture: OurThing | null; answered: boolean;
}

const newId = (prefix: string) => `${prefix}-${randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '')}`;

export class GiveHost {
  private readonly plans = new Map<string, Plan>();
  private offer: Offer | null = null;
  /** The last offer that was answered, for a picture that arrives a moment later. */
  private recent: Offer | null = null;
  private disposed = false;
  readonly stats = { offered: 0, taken: 0, notTaken: 0, interrupted: 0, pictures: 0, fed: 0 };
  constructor(private readonly options: GiveHostOptions) {}

  private now(): number { return (this.options.clock ?? Date.now)(); }
  private get timers() {
    return this.options.timers ?? { set: (callback: () => void, ms: number) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  /**
   * Look, don't take (the opening choice): null when she would not offer anything now; else the reasons from her hormones and mood
   * values that weigh the "递给你点东西" candidate. Makes the plan (what she would hand over) that her prompt and the stage then use.
   */
  peek(characterId: string): { readonly leans: readonly { readonly text: string; readonly factor: number }[] } | null {
    if (this.disposed || !characterId || this.offer || !this.safe(() => this.options.enabled(), false)) return null;
    if (!this.options.store.loaded(characterId)) { void this.options.store.load(characterId).catch(() => {}); return null; }
    const ledger = this.options.store.ledger(characterId), now = this.now();
    if (!ledger || !giveAllowed(ledger, now)) return null;
    const mood = this.safe(() => this.options.mood(characterId), null);
    if (!mood) return null;
    const lean = giveLean(mood), user = this.safe(() => this.options.user(), { localMinute: NaN, tired: false, stillMinutes: null });
    const pictures = this.fedPictures(characterId);
    const pick = pickGiveItem({ mood, user, playful: lean.playful, pictures, now, random: this.options.random ?? Math.random });
    this.plans.set(characterId, { at: now, pick, lean });
    while (this.plans.size > 16) this.plans.delete(this.plans.keys().next().value!);
    return { leans: lean.reasons.filter(reason => reason.factor !== 1) };
  }

  /** What she is about to hand over and why, for her prompt (focus 'give'). Plain words; never a line of hers or the user's words. */
  promptLine(characterId: string): string {
    const plan = this.freshPlan(characterId);
    if (!plan) return '';
    const { pick } = plan;
    const what = pick.item === 'cushion' ? '把你的靠垫推到用户那边，让用户靠一靠、歇一会儿'
      : pick.picture ? `把一块点心递给用户：是用户之前喂过你的「${pick.picture.name || '点心'}」，你把它递回去${pick.picture.loved ? '（那是你爱吃的）' : ''}`
        : '把一块小点心递给用户';
    const why = pick.why.map(moment => ({ sleepy: '你自己有点困了', night: '已经很晚了', tired: '用户刚说过累', still: '用户很久没动了', playful: '你这会儿有点调皮' })[moment]);
    return `这次你想主动照顾一下用户：${what}。${why.length ? `（因为${why.join('、')}。）` : ''}${pick.playful && pick.item === 'snack' ? '可以俏皮一点，比如假装要自己吃又递给用户。' : ''}`;
  }

  /** Her line for focus 'give' was shown and committed: the stage hands it over now. */
  delivered(characterId: string, _claimId: string, text: string): void {
    const plan = this.freshPlan(characterId);
    if (!plan || this.offer || this.disposed) return;
    const now = this.now(), ledger = this.options.store.ledger(characterId);
    if (!ledger || !giveAllowed(ledger, now)) return;
    this.plans.delete(characterId);
    const special = this.safe(() => this.options.specialDay(characterId), false);
    const mood = this.safe(() => this.options.mood(characterId), null), user = this.safe(() => this.options.user(), { localMinute: NaN, tired: false, stillMinutes: null });
    const reason = pictureAllowed(ledger, now) ? pictureMoment({ localMinute: user.localMinute, longing: mood?.longing ?? 0, specialDay: special }) : null;
    const offer: Offer = { id: newId('give'), characterId, pick: plan.pick, line: String(text ?? '').slice(0, 120), at: now, pictureReason: reason, timer: null, picture: null, answered: false };
    this.offer = offer;
    void this.options.store.setLedger(characterId, noteGiveOffer(ledger, now)).catch(() => false);
    void this.start(offer);
  }

  private async start(offer: Offer): Promise<void> {
    const spec = GIVE_ITEMS[offer.pick.item];
    let picture: string | null = null;
    if (offer.pick.picture) {
      const stored = await this.options.store.picture(offer.characterId, offer.pick.picture.id).catch(() => null);
      if (stored) picture = `data:${stored.type};base64,${Buffer.from(stored.bytes).toString('base64')}`;
    }
    if (this.offer !== offer || this.disposed) return;
    const sent = this.safe(() => this.options.send({ type: 'offer', id: offer.id, item: offer.pick.item, stage: spec.stage, prop: spec.prop, playful: offer.pick.playful,
      picture, waitMs: GIVE_KNOBS.offerMs, capture: offer.pictureReason !== null }), false);
    if (!sent) { this.finish(offer, 'interrupted'); return; }
    this.stats.offered++;
    offer.timer = this.timers.set(() => { if (this.offer === offer) this.finish(offer, 'not-taken'); }, GIVE_KNOBS.answerMs);
  }

  /** The companion window: exactly { id, outcome } for the current offer. */
  answer(fromPet: boolean, value: unknown): boolean {
    const answer = readGiveAnswer(value), offer = this.offer;
    if (fromPet !== true || !answer || !offer || answer.id !== offer.id) return false;
    this.finish(offer, answer.outcome);
    return true;
  }

  /** The companion window: her picture for this (or the just-answered) offer; kept once, at most one a day. */
  async picture(fromPet: boolean, value: unknown): Promise<boolean> {
    const input = readGivePicture(value);
    const offer = [this.offer, this.recent].find(item => item && input && item.id === input.id) ?? null;
    if (fromPet !== true || !input || !offer || offer.picture || !offer.pictureReason || this.now() - offer.at > 120_000) return false;
    const ledger = this.options.store.ledger(offer.characterId), now = this.now();
    if (!ledger || !pictureAllowed(ledger, now)) return false;
    const thing = ourThing({ id: newId('pic'), at: now, dir: 'gave', kind: 'picture', line: offer.line });
    if (!thing) return false;
    const kept = await this.options.store.add(offer.characterId, thing, input.png).catch(() => null);
    if (!kept) return false;
    offer.picture = kept;
    this.stats.pictures++;
    await this.options.store.setLedger(offer.characterId, notePicture(this.options.store.ledger(offer.characterId) ?? ledger, now)).catch(() => false);
    this.record(offer.characterId, 'picture', offer, { picture: offer.pictureReason });
    try { this.options.folder?.picture?.(offer.characterId, kept, input.png); } catch { /* Her folder is a copy; the app keeps the picture. */ }
    this.changed(offer.characterId);
    // Shown once the offer is over (it never covers what she holds out).
    if (offer.answered) this.card(offer);
    return true;
  }

  /** The control page: this character's list, newest first (no file names, no paths). */
  view(characterId: string): OurThingsView {
    return { characterId, items: this.options.store.list(characterId).reverse().map(ourThingView) };
  }
  async load(characterId: string): Promise<OurThingsView> { await this.options.store.load(characterId).catch(() => {}); return this.view(characterId); }

  /** The control page removed one record (and its picture). */
  async remove(characterId: string, id: unknown): Promise<OurThingsView> {
    if (await this.options.store.remove(characterId, id).catch(() => false)) this.changed(characterId);
    return this.view(characterId);
  }

  /** A record's picture as a data URL (the page shows it; "存下来" saves the same bytes through the native dialog). */
  async pictureData(characterId: string, id: unknown): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/png' } | null> {
    return this.options.store.picture(characterId, id).catch(() => null);
  }

  /**
   * Feed recognition (electron/senses/feed-recognition/host.ts keep): a snack you fed her was recognised as food and she said her line (or
   * chose to stay quiet). Kept only while "允许记录" is on: the name, her line, and a 256 px JPEG of the picture feeding already shrank.
   */
  async keepFed(input: { characterId: string; name: string; line: string | null; at: number; loved: boolean; image: string }): Promise<boolean> {
    if (this.disposed || !this.safe(() => this.options.recording(), false)) return false;
    const thing = ourThing({ id: newId('fed'), at: input.at, dir: 'fed', kind: 'snack', name: input.name, line: input.line ?? '', loved: input.loved });
    if (!thing) return false;
    const thumb = this.safe(() => this.options.thumb(input.image), null);
    const kept = await this.options.store.add(input.characterId, thing, thumb).catch(() => null);
    if (!kept) return false;
    this.stats.fed++;
    this.changed(input.characterId);
    return true;
  }

  /**
   * I-087: the first time you held hands, kept with 我们的小东西 (the hands host checks 「允许记录」 and that it is the first one). A record
   * with no picture and no words; the page and her folder's list update like for any other record.
   */
  async keepFirstHold(characterId: string, at: number): Promise<boolean> {
    if (this.disposed || !characterId) return false;
    const thing = ourThing({ id: newId('hold'), at, dir: 'gave', kind: 'first-hold' });
    if (!thing) return false;
    await this.options.store.load(characterId).catch(() => {});
    const kept = await this.options.store.add(characterId, thing).catch(() => null);
    if (!kept) return false;
    this.changed(characterId);
    return true;
  }

  /** The character changed, her switch went off, she was hidden: an offer on the stage goes back quietly (nothing is written). */
  cancel(): void {
    const offer = this.offer;
    if (!offer) return;
    this.safe(() => this.options.send({ type: 'cancel', id: offer.id }), false);
    this.finish(offer, 'interrupted');
  }

  dispose(): void { this.cancel(); this.disposed = true; this.plans.clear(); }

  /** Test seam / diagnostics: the offer on the stage now. */
  current(): { id: string; characterId: string; item: GiveItemId; capture: boolean } | null {
    const offer = this.offer;
    return offer ? { id: offer.id, characterId: offer.characterId, item: offer.pick.item, capture: offer.pictureReason !== null } : null;
  }

  private finish(offer: Offer, outcome: GiveOutcome): void {
    if (this.offer !== offer) return;
    this.offer = null;
    offer.answered = true;
    this.timers.clear(offer.timer);
    this.recent = offer;
    if (outcome === 'taken') {
      this.stats.taken++;
      // Back to her mood: a small O and D lift (its own cooldown and day count). Not taken: nothing at all.
      try { this.options.moment(offer.characterId, offer.id); } catch { /* The mood host refused; the record stays. */ }
    } else if (outcome === 'not-taken') this.stats.notTaken++;
    else this.stats.interrupted++;
    this.record(offer.characterId, outcome, offer);
    if (outcome !== 'interrupted') void this.keepOffer(offer, outcome === 'taken');
    if (offer.picture) this.card(offer);
  }

  private async keepOffer(offer: Offer, taken: boolean): Promise<void> {
    const thing = ourThing({ id: offer.id.replace(/^give-/, 'gave-'), at: offer.at, dir: 'gave', kind: offer.pick.item === 'cushion' ? 'cushion' : 'snack',
      name: offer.pick.picture?.name ?? '', line: offer.line, taken });
    if (!thing) return;
    if (await this.options.store.add(offer.characterId, thing).catch(() => null)) this.changed(offer.characterId);
  }

  private card(offer: Offer): void {
    const kept = offer.picture;
    if (!kept) return;
    void this.options.store.picture(offer.characterId, kept.id).then(stored => {
      if (!stored || this.disposed) return;
      this.safe(() => this.options.send({ type: 'card', id: kept.id, line: kept.line, picture: `data:${stored.type};base64,${Buffer.from(stored.bytes).toString('base64')}` }), false);
    }).catch(() => {});
  }

  private record(characterId: string, event: GiveOutcome | 'picture', offer: Offer, extra: { picture?: PictureReason | null } = {}): void {
    try {
      this.options.journal?.({ type: 'give', characterId, event, item: offer.pick.item, why: [...offer.pick.why], ...(offer.pick.picture ? { fromFed: true } : {}),
        ...(extra.picture ? { picture: extra.picture } : {}) });
    } catch { /* A record never changes what she does. */ }
  }

  private changed(characterId: string): void {
    try { this.options.changed?.(characterId); } catch { /* The page re-reads later. */ }
    try { this.options.folder?.list(characterId, this.options.store.list(characterId)); } catch { /* Her folder is a copy. */ }
  }

  private freshPlan(characterId: string): Plan | null {
    const plan = this.plans.get(characterId);
    return plan && this.now() - plan.at >= 0 && this.now() - plan.at <= GIVE_KNOBS.planMs ? plan : null;
  }

  private fedPictures(characterId: string): FedSnackPicture[] {
    return this.options.store.list(characterId).filter(item => item.dir === 'fed' && item.file)
      .map(item => ({ id: item.id, name: item.name, at: item.at, ...(item.loved ? { loved: true } : {}) }));
  }
}
