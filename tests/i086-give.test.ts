/**
 * I-086 她也照顾你 (docs/claude/2026-11-11-i086-give-and-keep.md): the choice weights from her mood, the item pick (and the snack
 * picture you fed her), the daily caps and the picture cap, taken / not-taken writes back to her mood, the keepsake store (bounded,
 * atomic, deletable, per character), the opening-choice candidate and the prompt line. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_GIVE_LEDGER, giveAllowed, giveDay, giveLean, noteGiveOffer, notePicture, pickGiveItem, pictureAllowed, pictureMoment, type GiveMood,
} from '../shared/behaviors/give/choose';
import { GIVE_KNOBS } from '../shared/behaviors/give/knobs';
import { readGiveAnswer, readGivePicture, type GiveEvent } from '../shared/behaviors/give/interface';
import { addOurThing, ourThing, ourThingsText, readOurThing, type OurThing } from '../shared/initiative/our-things';
import { OurThingsStore } from '../electron/initiative/give/store';
import { GiveHost, type GiveJournalInput } from '../electron/initiative/give/host';
import { chooseOpening, openingNow } from '../shared/behaviors/opening-choice/choose';
import { buildInnerLoopPrompt, INNER_LOOP_GIVE_RULE } from '../shared/initiative/inner-loop';
import { MOOD_MOMENTS } from '../shared/foundation/mood-moments';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';

const temps: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'sh-i086-')); temps.push(dir); return dir; };
test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const base = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const mood = (values: Partial<typeof base> = {}, extra: Partial<GiveMood> = {}): GiveMood => ({ values: { ...base, ...values }, baseline: { ...base }, evidence: 1, longing: 0, A: 0.1, ...extra });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const NOON = new Date(2026, 10, 11, 12, 0).getTime();

// ---------------------------------------------------------------- reading her mood (the read side)

test('the weight reads the hormones and mood values: O and M up → more; N or C high → less; D up → playful; baseline → 1', () => {
  assert.equal(giveLean(mood()).factor, 1, 'at her baseline nothing leans');
  assert.ok(giveLean(mood({ O: 80 })).factor > 1.2, 'closeness up → more likely');
  assert.ok(giveLean(mood({ O: 30 })).factor < 1, 'closeness down → less');
  assert.ok(giveLean(mood({}, { longing: 80 })).factor > 1.4, 'missing you → more likely');
  assert.ok(giveLean(mood({ N: 92 })).factor < 0.6, 'tense → less (she keeps to herself first)');
  assert.ok(giveLean(mood({ C: 92 })).factor < 0.6, 'stressed → less');
  assert.ok(giveLean(mood({ O: 80, C: 92 })).factor < giveLean(mood({ O: 80 })).factor, 'a high C still presses a high O down');
  assert.equal(giveLean(mood({ D: 80 })).playful, true); assert.equal(giveLean(mood({ D: 52 })).playful, false);
  // Read relative to the card: the same raw O is "high" only above her own baseline.
  const highBase: GiveMood = { ...mood({ O: 70 }), baseline: { ...base, O: 75 } };
  assert.ok(giveLean(highBase).factor <= 1 && giveLean(highBase).factor < giveLean(mood({ O: 70 })).factor, 'O 70 is below a card baseline of 75: no lift');
  const lean = giveLean(mood({ O: 80, N: 95 }, { longing: 50 }));
  assert.ok(lean.reasons.some(r => r.text.includes('O')) && lean.reasons.some(r => r.text.includes('M')) && lean.reasons.some(r => r.text.includes('N')));
  assert.ok(lean.factor >= GIVE_KNOBS.lean.floor && lean.factor <= GIVE_KNOBS.lean.ceil);
});

test('what she hands over: her own fatigue (A) and your night, tiredness → the cushion; playful → the snack; a stored snack picture is used', () => {
  const share = (input: Parameters<typeof pickGiveItem>[0]['user'], A: number | null, playful = false) => {
    const random = rng(7); let cushion = 0;
    for (let i = 0; i < 2000; i++) if (pickGiveItem({ mood: { A }, user: input, playful, pictures: [], now: NOON, random }).item === 'cushion') cushion++;
    return cushion / 2000;
  };
  const day = { localMinute: 14 * 60, tired: false, stillMinutes: 5 };
  const plain = share(day, 0.1);
  assert.ok(share(day, 0.8) > plain + 0.2, 'she is sleepy → the cushion more often');
  assert.ok(share({ ...day, localMinute: 23 * 60 + 40 }, 0.1) > plain + 0.15, 'late at night → the cushion');
  assert.ok(share({ ...day, tired: true }, 0.1) > plain + 0.15, 'you said you were tired → the cushion');
  assert.ok(share(day, 0.1, true) < plain - 0.05, 'playful → the snack');
  const pictures = [{ id: 'fed-a', name: '草莓蛋糕', at: NOON - 1000, loved: true }, { id: 'fed-b', name: '苦瓜', at: NOON - 10 * 86_400_000 }];
  const random = rng(3); let fromFed = 0, loved = 0;
  for (let i = 0; i < 1000; i++) {
    const pick = pickGiveItem({ mood: { A: 0.1 }, user: day, playful: true, pictures, now: NOON, random });
    if (pick.item === 'snack') { assert.ok(pick.picture, 'a snack is one you fed her when there is one'); fromFed++; if (pick.picture!.id === 'fed-a') loved++; }
    else assert.equal(pick.picture, null, 'the cushion is never a picture');
  }
  assert.ok(fromFed > 0 && loved / fromFed > 0.65, 'she more often hands back one she loved, recently fed');
  assert.equal(pickGiveItem({ mood: { A: 0.1 }, user: day, playful: true, pictures: [], now: NOON, random: () => 0 }).picture, null, 'no picture yet: the plain snack');
});

test('how often: at most three a day, spaced; a new day starts over; a picture at most once a day and only on a special moment', () => {
  let ledger = EMPTY_GIVE_LEDGER, now = NOON;
  for (let i = 0; i < GIVE_KNOBS.perDay; i++) {
    assert.equal(giveAllowed(ledger, now), true, `offer ${i + 1}`);
    ledger = noteGiveOffer(ledger, now);
    assert.equal(giveAllowed(ledger, now + 60_000), false, 'too soon after the last one');
    now += GIVE_KNOBS.minGapMs;
  }
  assert.equal(giveAllowed(ledger, now), false, 'the day’s offers are used up');
  const tomorrow = new Date(2026, 10, 12, 9, 0).getTime();
  assert.equal(giveAllowed(ledger, tomorrow), true, 'a new day');
  assert.equal(pictureMoment({ localMinute: 15 * 60, longing: 10, specialDay: false }), null, 'an ordinary afternoon: no picture');
  assert.equal(pictureMoment({ localMinute: 15 * 60, longing: 10, specialDay: true }), 'special-day');
  assert.equal(pictureMoment({ localMinute: 15 * 60, longing: 85, specialDay: false }), 'miss');
  assert.equal(pictureMoment({ localMinute: 1 * 60 + 10, longing: 0, specialDay: false }), 'late');
  let pictures = EMPTY_GIVE_LEDGER;
  assert.equal(pictureAllowed(pictures, NOON), true);
  pictures = notePicture(pictures, NOON);
  assert.equal(pictureAllowed(pictures, NOON + 3_600_000), false, 'one a day');
  assert.equal(pictureAllowed(pictures, tomorrow), true);
  assert.equal(giveDay(NOON), '2026-11-11');
});

// ---------------------------------------------------------------- the opening choice and her line

test('"递给你点东西" is one more candidate, only when it is there; her mood leans weigh it', () => {
  const snapshot = { primary: 'calm' as const, companion: null, boredom: 0, lastInteractionAt: NOON };
  const now = (give: boolean, factor = 1) => openingNow({ available: { listen: false, screen: false, mood: true, play: false, ...(give ? { give: true } : {}) },
    snapshot, personality: null, need: false, quiet: { night: false, drowsy: false }, last: null, ...(factor !== 1 ? { leans: { give: [{ text: 'O', factor }] } } : {}) });
  const count = (n: ReturnType<typeof now>) => { const random = rng(11); let gave = 0; for (let i = 0; i < 1500; i++) if (chooseOpening(n, [], random)?.id === 'give') gave++; return gave; };
  assert.equal(count(now(false)), 0, 'not there → never chosen');
  const plain = count(now(true)), warm = count(now(true, 2.2)), tense = count(now(true, 0.3));
  assert.ok(plain > 0, 'there → sometimes');
  assert.ok(warm > plain * 1.4, `O/M up weigh it up (${plain} → ${warm})`);
  assert.ok(tense < plain * 0.6, `N/C high weigh it down (${plain} → ${tense})`);
});

test('her prompt: with focus give it carries what she would hand over and the rule; without it the prompt is unchanged', () => {
  const input = { persona: 'P', mood: 'M', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 900, minutesSinceInteraction: 30,
    cue: 'speech' as const, allowSpeech: true, quiet: { asleep: false, drowsy: false, night: false, quiet: false } };
  const plain = buildInnerLoopPrompt(input), empty = buildInnerLoopPrompt({ ...input, give: '' });
  assert.equal(empty, plain, 'no give line: byte-identical');
  const withGive = buildInnerLoopPrompt({ ...input, give: '这次你想主动照顾一下用户：把一块小点心递给用户。' });
  assert.ok(withGive.includes('把一块小点心递给用户') && withGive.includes(INNER_LOOP_GIVE_RULE));
  assert.equal(buildInnerLoopPrompt({ ...input, quiet: { asleep: false, drowsy: true, night: false, quiet: true }, allowSpeech: false, give: 'x' }).includes(INNER_LOOP_GIVE_RULE), false, 'quiet: never');
});

// ---------------------------------------------------------------- the store (bounded, atomic, deletable, per character)

test('our things: records are checked; the list is bounded by count and by picture bytes; a fed snack keeps only a small JPEG', async () => {
  assert.equal(readOurThing({ id: 'a', at: 1, dir: 'fed', kind: 'cushion', name: '', line: '' }), null, 'you never fed her a cushion');
  assert.equal(readOurThing({ id: 'a/../b', at: 1, dir: 'gave', kind: 'snack', name: '', line: '' }), null);
  assert.equal(readOurThing({ id: 'a', at: 1, dir: 'gave', kind: 'snack', name: '', line: '', file: '../x.png', bytes: 3 }), null, 'a file name is only letters and digits');
  const thing = ourThing({ id: 'x', at: 5, dir: 'gave', kind: 'snack', name: '草莓蛋糕草莓蛋糕草莓蛋糕草莓蛋糕', line: '给你<script>' })!;
  assert.equal(thing.name.length, 12); assert.ok(!thing.line.includes('<'));
  let list: OurThing[] = [];
  for (let i = 0; i < 8; i++) list = addOurThing(list, ourThing({ id: `t${i}`, at: i, dir: 'gave', kind: 'picture', file: `t${i}.png`, bytes: 100 })!, { max: 5, bytes: 300 }).list;
  assert.ok(list.length <= 5 && list.reduce((s, t) => s + (t.bytes ?? 0), 0) <= 300, 'both bounds hold');
  assert.equal(list.at(-1)!.id, 't7', 'the newest stays');
  const dir = temp(), writes: string[] = [];
  const store = new OurThingsStore({ directory: () => dir, write: async (file, data) => { writes.push(path.basename(file)); const { writeFile } = await import('node:fs/promises'); await writeFile(file, data); } });
  const fed = ourThing({ id: 'fed-1', at: NOON, dir: 'fed', kind: 'snack', name: '草莓蛋糕', line: '好吃！', loved: true })!;
  assert.equal(await store.add('gene', fed, PNG), null, 'a fed snack is a JPEG only');
  assert.equal(await store.add('gene', fed, new Uint8Array(70 * 1024).fill(0xff)), null, 'over the thumbnail cap');
  const kept = await store.add('gene', fed, JPEG);
  assert.ok(kept?.file === 'fed-1.jpg' && kept.bytes === JPEG.length);
  assert.ok(existsSync(path.join(dir, 'our-things', 'gene', 'fed-1.jpg')));
  assert.equal(await store.add('gene', ourThing({ id: 'pic-1', at: NOON, dir: 'gave', kind: 'picture', line: '给你' })!, JPEG), null, 'her picture is a PNG only');
  assert.ok(await store.add('gene', ourThing({ id: 'pic-1', at: NOON + 1, dir: 'gave', kind: 'picture', line: '给你' })!, PNG));
  assert.ok(await store.add('other', ourThing({ id: 'gave-1', at: NOON, dir: 'gave', kind: 'cushion' })!));
  assert.deepEqual(store.list('gene').map(t => t.id), ['fed-1', 'pic-1']);
  assert.deepEqual(store.list('other').map(t => t.id), ['gave-1'], 'per character, never mixed');
  const saved = JSON.parse(readFileSync(path.join(dir, 'our-things', 'gene.json'), 'utf8'));
  assert.equal(saved.v, 1); assert.equal(saved.items.length, 2);
  assert.ok(writes.every(name => name.endsWith('.json')), 'the list goes through the atomic writer');
  assert.deepEqual((await store.picture('gene', 'pic-1'))?.type, 'image/png');
  assert.equal(await store.picture('gene', '../other/gave-1'), null);
  assert.equal(await store.remove('gene', 'fed-1'), true);
  assert.equal(existsSync(path.join(dir, 'our-things', 'gene', 'fed-1.jpg')), false, 'deleting removes its picture');
  assert.deepEqual(store.list('gene').map(t => t.id), ['pic-1']);
  const again = new OurThingsStore({ directory: () => dir });
  await again.load('gene');
  assert.deepEqual(again.list('gene').map(t => t.id), ['pic-1'], 'read back after a restart');
  // A bounded store drops the oldest pictures with their files.
  const small = new OurThingsStore({ directory: () => dir, limits: { max: 2, bytes: 1_000_000 } });
  for (let i = 0; i < 4; i++) await small.add('tiny', ourThing({ id: `f${i}`, at: NOON + i, dir: 'fed', kind: 'snack', name: '饼干' })!, JPEG);
  assert.deepEqual(small.list('tiny').map(t => t.id), ['f2', 'f3']);
  assert.deepEqual(readdirSync(path.join(dir, 'our-things', 'tiny')).sort(), ['f2.jpg', 'f3.jpg'], 'the dropped records took their pictures with them');
});

test('our things in her folder: words by date, no picture, no path', () => {
  const text = ourThingsText([ourThing({ id: 'a', at: NOON, dir: 'fed', kind: 'snack', name: '草莓蛋糕', line: '好甜' })!,
    ourThing({ id: 'b', at: NOON + 1, dir: 'gave', kind: 'cushion', taken: true, line: '靠一会儿吧' })!]);
  assert.match(text, /## 2026-11-11/u); assert.match(text, /你喂我的：点心（草莓蛋糕） · "好甜"/u); assert.match(text, /我给你的：靠垫 · 你接住了 · "靠一会儿吧"/u);
  assert.ok(!/\.(png|jpg)|[A-Z]:\\/u.test(text));
});

// ---------------------------------------------------------------- the host: offer, answer, write-back, picture

interface HostRig { host: GiveHost; store: OurThingsStore; sent: GiveEvent[]; moments: string[]; journal: GiveJournalInput[]; state: { now: number; recording: boolean; special: boolean; enabled: boolean; mood: GiveMood }; folder: string[] }
async function hostRig(dir = temp()): Promise<HostRig> {
  const state = { now: NOON, recording: true, special: false, enabled: true, mood: mood({ O: 70 }) };
  const sent: GiveEvent[] = [], moments: string[] = [], journal: GiveJournalInput[] = [], folder: string[] = [];
  const store = new OurThingsStore({ directory: () => dir });
  await store.load('gene');
  const host = new GiveHost({ store, enabled: () => state.enabled, mood: id => id === 'gene' ? state.mood : null,
    user: () => ({ localMinute: new Date(state.now).getHours() * 60 + new Date(state.now).getMinutes(), tired: false, stillMinutes: 10 }),
    specialDay: () => state.special, send: event => { sent.push(event); return true; }, moment: (_id, key) => { moments.push(key); },
    journal: entry => { journal.push(entry); }, recording: () => state.recording, thumb: () => JPEG,
    folder: { list: (_id, list) => { folder.push(`list:${list.length}`); }, picture: () => { folder.push('picture'); } },
    clock: () => state.now, random: rng(5), timers: { set: () => 0, clear: () => {} } });
  return { host, store, sent, moments, journal, state, folder };
}
const settle = async (store: OurThingsStore) => { for (let i = 0; i < 5; i++) { await store.idle(); await new Promise(resolve => setTimeout(resolve, 1)); } };
// An offer that carries a picture and the card both read the picture back from disk first (host.ts start() / card()); under a
// loaded machine that read can outlast settle's five rounds, so wait for what the window would see (bounded: a real hang still fails).
const until = async (check: () => boolean, what: string) => { const end = Date.now() + 10_000; while (!check()) { if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 5)); } };

test('host: peek reads her mood, her line says what she hands over, the stage starts only after her line, at most three a day', async () => {
  const r = await hostRig();
  r.state.enabled = false;
  assert.equal(r.host.peek('gene'), null, '内心循环 / 自动表现 off: nothing');
  r.state.enabled = true;
  const peek = r.host.peek('gene');
  assert.ok(peek && peek.leans.some(l => l.factor > 1), 'O above her baseline leans it up');
  assert.match(r.host.promptLine('gene'), /这次你想主动照顾一下用户/u);
  assert.equal(r.sent.length, 0, 'nothing on the stage before her line');
  r.host.delivered('gene', 'cue-1', '给你，别饿着。');
  await settle(r.store);
  const offer = r.sent.find(e => e.type === 'offer');
  assert.ok(offer && offer.type === 'offer' && offer.waitMs === GIVE_KNOBS.offerMs && offer.capture === false);
  assert.equal(r.host.peek('gene'), null, 'one at a time');
  assert.equal(r.host.answer(false, { id: offer.id, outcome: 'taken' }), false, 'only the pet window answers');
  assert.equal(r.host.answer(true, { id: 'give-nope', outcome: 'taken' }), false);
  assert.equal(r.host.answer(true, { id: offer.id, outcome: 'taken' }), true);
  assert.equal(r.host.answer(true, { id: offer.id, outcome: 'taken' }), false, 'once');
  await settle(r.store);
  assert.deepEqual(r.moments, [offer.id], 'taken → the mood moment (O and D up)');
  assert.deepEqual(r.journal.map(j => [j.event, j.item]), [['taken', offer.item]]);
  const gave = r.store.list('gene').find(t => t.dir === 'gave');
  assert.ok(gave && gave.taken === true && gave.line === '给你，别饿着。');
  // Not taken: nothing to her mood, a record that says so, no guilt anywhere.
  r.state.now += GIVE_KNOBS.minGapMs;
  assert.ok(r.host.peek('gene'));
  r.host.delivered('gene', 'cue-2', '要不要？');
  await settle(r.store);
  const second = r.sent.filter(e => e.type === 'offer')[1]!;
  r.host.answer(true, { id: second.id, outcome: 'not-taken' });
  await settle(r.store);
  assert.equal(r.moments.length, 1, 'not taken: no write-back');
  assert.equal(r.store.list('gene').filter(t => t.dir === 'gave' && t.taken === false).length, 1);
  // Interrupted: back quietly, nothing kept.
  r.state.now += GIVE_KNOBS.minGapMs;
  r.host.peek('gene'); r.host.delivered('gene', 'cue-3', '嗯？'); await settle(r.store);
  r.host.cancel(); await settle(r.store);
  assert.equal(r.store.list('gene').filter(t => t.dir === 'gave').length, 2, 'an interrupted offer is not a record');
  assert.ok(r.sent.some(e => e.type === 'cancel'));
  r.state.now += GIVE_KNOBS.minGapMs;
  assert.equal(r.host.peek('gene'), null, 'three offers today (the interrupted one counted: her line was said)');
  assert.ok(r.journal.every(j => Object.keys(j).every(key => ['type', 'characterId', 'event', 'item', 'why', 'fromFed', 'picture'].includes(key))), 'journal: closed fields only');
});

test('host: a snack you fed her goes back to you as its picture; kept only with 「允许记录」 on', async () => {
  const r = await hostRig();
  r.state.recording = false;
  assert.equal(await r.host.keepFed({ characterId: 'gene', name: '草莓蛋糕', line: '甜！', at: NOON - 5000, loved: true, image: 'data:image/jpeg;base64,AAAA' }), false);
  assert.equal(r.store.list('gene').length, 0, 'recording off: nothing kept');
  r.state.recording = true;
  assert.equal(await r.host.keepFed({ characterId: 'gene', name: '草莓蛋糕', line: '甜！', at: NOON - 5000, loved: true, image: 'data:image/jpeg;base64,AAAA' }), true);
  assert.equal(r.store.list('gene')[0].file, `${r.store.list('gene')[0].id}.jpg`);
  r.state.mood = mood({ O: 70, D: 85 }); // playful: the snack
  let offer: GiveEvent | undefined;
  for (let i = 0; i < 6 && !offer; i++) {
    r.host.peek('gene');
    if (!/草莓蛋糕/u.test(r.host.promptLine('gene'))) continue;
    r.host.delivered('gene', `cue-${i}`, '还给你～');
    await until(() => r.sent.some(e => e.type === 'offer'), 'the offer with the fed picture'); // the picture is read from disk first (see until)
    offer = r.sent.find(e => e.type === 'offer');
  }
  assert.ok(offer && offer.type === 'offer' && offer.item === 'snack' && offer.picture?.startsWith('data:image/jpeg;base64,'), 'the offered snack is the picture you fed her');
  r.host.answer(true, { id: offer.id, outcome: 'taken' });
  await settle(r.store);
  assert.equal(r.journal.at(-1)?.fromFed, true);
  assert.equal(r.store.list('gene').find(t => t.dir === 'gave')?.name, '草莓蛋糕');
});

test('host: a picture only on a special moment, at most once a day; stored per character; the card comes after the offer', async () => {
  const r = await hostRig();
  r.host.peek('gene'); r.host.delivered('gene', 'cue-1', '给你。'); await settle(r.store);
  await until(() => r.sent.some(e => e.type === 'offer'), 'the first offer');
  const plain = r.sent.find(e => e.type === 'offer')!;
  assert.equal(plain.type === 'offer' && plain.capture, false, 'an ordinary moment: no picture');
  assert.equal(await r.host.picture(true, { id: plain.id, png: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` }), false, 'not asked for: refused');
  r.host.answer(true, { id: plain.id, outcome: 'taken' }); await settle(r.store);
  r.state.special = true; r.state.now += GIVE_KNOBS.minGapMs;
  r.host.peek('gene'); r.host.delivered('gene', 'cue-2', '今天是特别的日子。'); await settle(r.store);
  await until(() => r.sent.filter(e => e.type === 'offer').length >= 2, 'the special offer');
  const special = r.sent.filter(e => e.type === 'offer')[1]!;
  assert.equal(special.type === 'offer' && special.capture, true);
  const png = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
  assert.equal(await r.host.picture(false, { id: special.id, png }), false, 'only the pet window');
  assert.equal(await r.host.picture(true, { id: special.id, png: 'data:image/jpeg;base64,/9j/' }), false, 'a PNG only');
  assert.equal(await r.host.picture(true, { id: special.id, png }), true);
  assert.equal(await r.host.picture(true, { id: special.id, png }), false, 'once');
  assert.equal(r.sent.filter(e => e.type === 'card').length, 0, 'not over what she holds out');
  r.host.answer(true, { id: special.id, outcome: 'not-taken' }); await settle(r.store);
  await until(() => r.sent.some(e => e.type === 'card'), 'the card');
  const card = r.sent.find(e => e.type === 'card');
  assert.ok(card && card.type === 'card' && card.line === '今天是特别的日子。' && card.picture.startsWith('data:image/png;base64,'));
  assert.ok(r.folder.includes('picture'), 'her folder gets a copy (when on)');
  assert.deepEqual(r.journal.filter(j => j.event === 'picture').map(j => j.picture), ['special-day']);
  r.state.now += GIVE_KNOBS.minGapMs;
  r.host.peek('gene'); r.host.delivered('gene', 'cue-3', '再给你一张？'); await settle(r.store);
  await until(() => r.sent.filter(e => e.type === 'offer').length >= 3, 'the third offer');
  const third = r.sent.filter(e => e.type === 'offer')[2]!;
  assert.equal(third.type === 'offer' && third.capture, false, 'one picture a day');
});

test('the narrow messages: exact shapes only', () => {
  assert.deepEqual(readGiveAnswer({ id: 'give-abc', outcome: 'taken' }), { id: 'give-abc', outcome: 'taken' });
  assert.equal(readGiveAnswer({ id: 'give-abc', outcome: 'taken', extra: 1 }), null);
  assert.equal(readGiveAnswer({ id: '../x', outcome: 'taken' }), null);
  assert.equal(readGiveAnswer({ id: 'give-abc', outcome: 'grabbed' }), null);
  assert.ok(readGivePicture({ id: 'give-abc', png: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` }));
  assert.equal(readGivePicture({ id: 'give-abc', png: `data:image/png;base64,${Buffer.from(JPEG).toString('base64')}` }), null, 'the bytes must be a PNG');
  assert.equal(readGivePicture({ id: 'give-abc', png: `data:image/png;base64,${'A'.repeat(800_000)}` }), null, 'size cap');
});

test('back to her mood: taken is a small O and D lift with its own cooldown and day count; not taken writes nothing', () => {
  const spec = MOOD_MOMENTS['gave-taken'];
  assert.ok((spec.delta.O ?? 0) > 0 && (spec.delta.D ?? 0) > 0 && Object.keys(spec.delta).length === 2);
  assert.ok(spec.cooldownMs >= 30 * 60_000 && spec.perDay <= GIVE_KNOBS.perDay);
});
