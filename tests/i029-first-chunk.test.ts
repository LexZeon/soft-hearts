// I-029 朗读更早开口: the first read-aloud piece may end at a comma (switch voice.firstChunk = 'comma'); 'sentence' (default)
// is exactly the parser used before. Real host plan, real native prefix proof, real draft filter, real queue; fake bubble,
// fake voices, virtual clock. Invented replies only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { CompletedPrefixProof } from '../electron/completed-prefix-proof';
import { ReplyDraftGuard } from '../electron/reply-draft-guard';
import { validateSettings } from '../electron/validation';
import { CompletedReplySpeechQueue, type ReplySpeechSession } from '../src/ui/completed-reply-speech-queue';
import { IncrementalReplySegments } from '../shared/incremental-reply-segments';
import {
  FIRST_CHUNK_MIN_UNITS, FirstCommaReplySegments, firstChunkMinUnits, firstSpeechChunk, replySpeechParser,
} from '../shared/first-speech-chunk';
import type { ReplySegment } from '../shared/reply-segments';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { AGENT_SETTINGS } from '../shared/agent-channel';
import { capability, capabilityChannel } from '../shared/capabilities';
import type { ApprovedReplySpeechSegment } from '../shared/tts';
import { CASES, PROFILES, replay } from './fixtures/first-chunk-replay';

const owner = 5, scope = 'scope';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const TEXTS = [...CASES.map(c => c.text), '嗯。', '你好呀，我在这里。', '一二三四五六七八九十，' + '长'.repeat(30) + '。后面。', 'Well, I think so, but let me check. OK.',
  '1. 第一步，先洗手。\n2. 然后吃饭。', '`a，b，c，d` 是代码，对吧。', '没有标点的回复，一直说下去直到结束', '苹果、香蕉、橘子、葡萄都买了。'];

/** Feed `text` in chunks of `size` code points (0 = all at once) and collect every piece, then the completion's. */
function pieces(parser: { push(delta: string): ReplySegment[]; finish(): ReplySegment[] }, text: string, size: number): ReplySegment[] {
  const chars = Array.from(text), out: ReplySegment[] = [];
  const step = size || chars.length || 1;
  for (let i = 0; i < chars.length; i += step) out.push(...parser.push(chars.slice(i, i + step).join('')));
  return [...out, ...parser.finish()];
}
/** Every lease the host plan hands out for `text`, streamed in chunks, then recorded. */
function leases(text: string, size: number, first?: Parameters<CompletedReplySpeech['beginCommit']>[3]): Array<Pick<ApprovedReplySpeechSegment, 'index' | 'text' | 'visibleText'>> {
  const plans = new CompletedReplySpeech();
  const fence = first === undefined ? plans.beginCommit(owner, 'r', scope) : plans.beginCommit(owner, 'r', scope, first);
  const chars = Array.from(text), step = size || chars.length || 1;
  for (let i = 0; i < chars.length; i += step) plans.append(fence, chars.slice(i, i + step).join(''));
  plans.record(owner, 'r', scope, text, { prefix: true, fence });
  const out = [];
  for (let index: number | undefined; ;) {
    const lease = plans.next(owner, 'r', scope, index);
    if (!lease) return out;
    out.push({ index: lease.index, text: lease.text, visibleText: lease.visibleText }); index = lease.index;
  }
}

test('switch off (the default): the same parser and the same leases as before I-029', () => {
  assert.equal(DEFAULT_SETTINGS.voice.firstChunk, 'sentence');
  assert.ok(replySpeechParser({ mode: 'sentence', voice: 'bailian' }, { maxReplyChars: 6000 }) instanceof IncrementalReplySegments);
  assert.ok(!(replySpeechParser({ mode: 'sentence' }, {}) instanceof FirstCommaReplySegments));
  for (const text of TEXTS) for (const size of [1, 2, 3, 7, 0]) {
    const before = pieces(new IncrementalReplySegments({ maxReplyChars: 6000 }), text, size);
    const expected = leases(text, size);
    // The plan before I-029 turned exactly these sentence pieces into leases.
    assert.deepEqual(expected.map(lease => lease.visibleText), before.filter(piece => piece.text.trim()).map(piece => text.slice(0, piece.end)), `${text} / ${size}`);
    assert.deepEqual(leases(text, size, { mode: 'sentence' }), expected);
    assert.deepEqual(leases(text, size, { mode: 'sentence', voice: 'bailian' }), expected);
  }
  // Settings: anything but 'comma' is the default; older files without the field get it too.
  const legacy = structuredClone(DEFAULT_SETTINGS) as any; delete legacy.voice.firstChunk;
  assert.equal(validateSettings(legacy).voice.firstChunk, 'sentence');
  assert.equal(validateSettings({ ...legacy, voice: { ...legacy.voice, firstChunk: 'word' } }).voice.firstChunk, 'sentence');
  assert.equal(validateSettings({ ...legacy, voice: { ...legacy.voice, firstChunk: 'comma' } }).voice.firstChunk, 'comma');
  assert.equal(firstSpeechChunk('comma'), 'comma'); assert.equal(firstSpeechChunk(undefined), 'sentence');
});

test('comma mode: only the first piece may end at a comma; it covers the text once and later sentences are unchanged', () => {
  let cut = 0;
  for (const text of TEXTS) for (const minUnits of [FIRST_CHUNK_MIN_UNITS.system, FIRST_CHUNK_MIN_UNITS.bailian]) {
    const sentence = pieces(new IncrementalReplySegments({ maxReplyChars: 6000 }), text, 0);
    const reference = pieces(new FirstCommaReplySegments({ maxReplyChars: 6000, minUnits }), text, 1);
    for (const size of [2, 3, 7, 0])
      assert.deepEqual(pieces(new FirstCommaReplySegments({ maxReplyChars: 6000, minUnits }), text, size), reference, `the cut does not depend on how the stream is chunked: ${text} / ${size}`);
    // Contiguous original slices, nothing twice, nothing left out.
    assert.equal(reference.map(piece => piece.text).join(''), text);
    reference.forEach((piece, index) => {
      assert.equal(piece.text, text.slice(piece.start, piece.end));
      assert.equal(piece.start, index ? reference[index - 1].end : 0);
    });
    if (reference.length === sentence.length) { assert.deepEqual(reference, sentence, 'not cut: exactly the sentence pieces'); continue; }
    cut++;
    assert.equal(reference.length, sentence.length + 1, 'one comma piece at most');
    assert.match(reference[0].text, /[，；,;]\s*$/u, 'the first piece ends at a comma');
    assert.equal(reference[0].text + reference[1].text, sentence[0].text, 'the comma piece and the rest make the first sentence');
    assert.deepEqual(reference.slice(2), sentence.slice(1), 'every later sentence is unchanged');
  }
  assert.ok(cut >= 20, `${cut} cut`);
});

test('comma mode: where it cuts and where it does not', () => {
  const first = (text: string, voice = 'system') => pieces(replySpeechParser({ mode: 'comma', voice }, { maxReplyChars: 6000 }), text, 1)[0]?.text;
  assert.equal(first('今天我一直在想你，你什么时候回来呀？'), '今天我一直在想你，');
  assert.equal(first('嗯，我想了想，今天早点睡吧。'), '嗯，我想了想，', 'a comma after too few words waits for the next one');
  assert.equal(first('好呀，我们走吧。'), '好呀，我们走吧。', 'nothing long enough before the first sentence ends: the whole sentence');
  assert.equal(first('你回来啦，今天辛苦了吧？'), '你回来啦，', 'system voice: 4 words');
  assert.equal(first('你回来啦，今天辛苦了吧？', 'bailian'), '你回来啦，今天辛苦了吧？', 'Bailian: 8 words, so the rest is synthesized before the first part ends');
  assert.equal(first('今天我一直在想你，你回来了吗？', 'bailian'), '今天我一直在想你，');
  assert.equal(first('苹果、香蕉、橘子都买了，你要哪个？'), '苹果、香蕉、橘子都买了，', 'the enumeration comma never cuts');
  assert.equal(first('*伸了个懒腰，眨眨眼*你回来啦，今天怎么样？'), '*伸了个懒腰，眨眨眼*你回来啦，', 'never inside an open *action*');
  assert.equal(first('（揉了揉眼睛，打了个哈欠）你回来啦，今天怎么样？'), '（揉了揉眼睛，打了个哈欠）你回来啦，', 'a bracketed direction counts no words');
  assert.equal(first('1. 第一步，先洗手。\n2. 然后吃饭。'), '1. 第一步，先洗手。\n2. 然后吃饭。', 'a list item is never cut');
  assert.equal(first('`a，b，c，d` 是代码，对吧。'), '`a，b，c，d` 是代码，', 'never inside code');
  assert.equal(first('一共1,000,000个，好多呀。'), '一共1,000,000个，', 'an ASCII comma inside a number is not a comma');
  assert.equal(firstChunkMinUnits('bailian'), 8); assert.equal(firstChunkMinUnits('system'), 4); assert.equal(firstChunkMinUnits(undefined), 4);
});

/** The host's nextReplySpeechSegment streamed branch (electron/main.ts) over a bubble the test controls. */
function rig(mode: 'sentence' | 'comma', voice = 'system') {
  const plans = new CompletedReplySpeech();
  const fence = plans.beginCommit(owner, 'r', scope, { mode, voice });
  let shown = '', revision = 0;
  const proof = new CompletedPrefixProof({
    snapshot: () => ({ text: shown, revision, ready: !!shown, ownerCurrent: true }),
    current: text => text === shown && !!shown, waitExact: async text => text === shown,
  });
  const api = {
    async nextReplySpeechSegment(id: string, completedIndex?: number): Promise<ApprovedReplySpeechSegment | null> {
      if (plans.isPrefixReply(owner, id, scope)) {
        const committed = await plans.waitForCommit(owner, id, scope);
        if (!committed || !plans.commitCurrent(committed, owner, id, scope)) return null;
      }
      if (!await plans.waitForPiece(owner, id, scope, completedIndex)) return null;
      const segment = plans.next(owner, id, scope, completedIndex);
      if (!segment || !await plans.waitForPresentationReady(owner, id, scope, segment)) return null;
      const full = plans.fullPresentationText(owner, id, scope, segment)!, signal = plans.presentationSignal(owner, id, scope, segment)!;
      const ok = await proof.wait(() => plans.fullPresentationText(owner, id, scope, segment), segment.visibleText.length, signal,
        plans.presentationRemaining(owner, id, scope, segment), candidate => plans.ownsLease(owner, id, scope, segment)
          && !!plans.fullPresentationText(owner, id, scope, segment)?.startsWith(full) && candidate.length >= segment.visibleText.length
          && plans.approvePresentation(owner, id, scope, segment, candidate));
      return ok ? segment : null;
    },
    async cancelReplySpeech(id: string) { plans.cancel(owner, id); },
  };
  const spoken: string[] = [];
  const session = (): ReplySpeechSession => ({ append: async text => { spoken.push(text); return true; }, close: async () => {}, cancel() {}, finishCurrent() {} });
  const queue = new CompletedReplySpeechQueue(api, async () => { throw Error('session only'); }, () => true, session);
  const show = (text: string) => { shown = text; revision++; proof.changed(); };
  return { plans, fence, queue, spoken, show };
}

test('comma mode reads the first piece as soon as the bubble shows it, never before; sentence mode waits for the sentence', async () => {
  for (const mode of ['comma', 'sentence'] as const) {
    const r = rig(mode);
    const done = r.queue.speak('r');
    r.plans.append(r.fence, '今天我一直'); r.show('今天我一直'); await flush();
    r.plans.append(r.fence, '在想你，你什么'); await flush();
    assert.deepEqual(r.spoken, [], `${mode}: the comma is not on screen yet`);
    r.show('今天我一直在想你，'); await flush();
    assert.deepEqual(r.spoken, mode === 'comma' ? ['今天我一直在想你，'] : [], `${mode}: on screen up to the comma`);
    r.show('今天我一直在想你，你什么'); r.plans.append(r.fence, '时候回来呀？'); await flush();
    assert.deepEqual(r.spoken, mode === 'comma' ? ['今天我一直在想你，'] : [], `${mode}: the rest of the sentence is not on screen yet`);
    r.show('今天我一直在想你，你什么时候回来呀？'); await flush();
    assert.deepEqual(r.spoken, mode === 'comma' ? ['今天我一直在想你，', '你什么时候回来呀？'] : ['今天我一直在想你，你什么时候回来呀？']);
    r.plans.record(owner, 'r', scope, '今天我一直在想你，你什么时候回来呀？', { prefix: true, fence: r.fence }); await done;
    assert.equal(r.spoken.join(''), '今天我一直在想你，你什么时候回来呀？', `${mode}: read once, all of it`);
  }
});

test('comma mode never reads what the draft filter holds or drops', async () => {
  // An English plan in front of a Chinese reply (a Chinese chat): held to its end, then dropped. Its commas never reach the plan.
  const r = rig('comma');
  const guard = new ReplyDraftGuard([], { chinese: true });
  const done = r.queue.speak('r');
  let released = '';
  for (const c of Array.from('Keep it short and warm, agree to play, no lecture.好呀，那我们来玩猜拳吧，你先出！再来一局。')) {
    const out = guard.push(c);
    if (!out) continue;
    released += out; r.plans.append(r.fence, out); r.show(released); await flush();
  }
  released += guard.finish();
  assert.ok(!released.includes('Keep'), 'the filter dropped the plan');
  r.plans.record(owner, 'r', scope, released, { prefix: true, fence: r.fence }); r.show(released); await done;
  assert.ok(r.spoken.length > 0);
  for (const piece of r.spoken) assert.ok(released.includes(piece) && !/Keep|agree|lecture/u.test(piece), piece);
  assert.equal(r.spoken[0], '好呀，那我们来玩猜拳吧，', 'the first piece is cut from the reply itself');
});

test('cancel, a newer reply, a late delta: a comma piece that was not yet read is never read', async () => {
  // Cancelled (stop button, voice off) while the comma piece waits for the bubble.
  {
    const r = rig('comma');
    const done = r.queue.speak('r');
    r.plans.append(r.fence, '今天我一直在想你，'); await flush();
    r.queue.cancel(); r.show('今天我一直在想你，'); await done; await flush();
    assert.deepEqual(r.spoken, []);
    r.plans.append(r.fence, '后来的字。'); r.plans.record(owner, 'r', scope, '今天我一直在想你，后来的字。', { prefix: true, fence: r.fence });
    assert.equal(r.plans.isOrdinary(owner, 'r', scope), false, 'a late delta or completion cannot revive it');
  }
  // A newer reply replaces it before the bubble shows the comma.
  {
    const r = rig('comma');
    const done = r.queue.speak('r');
    r.plans.append(r.fence, '今天我一直在想你，'); await flush();
    r.plans.beginCommit(owner, 'r2', scope, { mode: 'comma' }); r.show('今天我一直在想你，'); await done; await flush();
    assert.deepEqual(r.spoken, [], 'the old reply reads nothing once a newer one began');
  }
  // Through the whole path, interrupted at many moments: nothing starts after a cancel or a newer reply.
  for (const kind of ['cancel', 'supersede'] as const) for (const at of [1100, 1300, 1600, 2200, 3000]) for (const voice of ['system', 'bailian'] as const) {
    const result = await replay(CASES.find(c => c.id === 'long-comma')!, { profile: PROFILES[1], voice, mode: 'comma', seed: 3, interrupt: { at, kind } });
    assert.deepEqual(result.violations, [], `${kind} at ${at} (${voice})`);
  }
});

test('microphone on during the comma piece: she stops after it (the piece being heard), as with a sentence', async () => {
  const result = await replay(CASES.find(c => c.id === 'medium-comma')!, { profile: PROFILES[0], voice: 'system', mode: 'comma', seed: 1 });
  const first = result.pieces[0];
  assert.ok(result.firstCut && first.start !== null);
  const cut = await replay(CASES.find(c => c.id === 'medium-comma')!, { profile: PROFILES[0], voice: 'system', mode: 'comma', seed: 1,
    interrupt: { at: first.start! + 50, kind: 'finish' } });
  assert.deepEqual(cut.violations, []);
  assert.deepEqual(cut.pieces.filter(piece => piece.start !== null).map(piece => piece.text), [first.text]);
});

test('the real path, both voices, both modes: never before the bubble shows it, never twice, all of it, nothing filtered', async () => {
  let earlier = 0, compared = 0;
  for (const voice of ['system', 'bailian'] as const) for (const profile of PROFILES.slice(0, 2)) for (const c of CASES) {
    const sentence = await replay(c, { profile, voice, mode: 'sentence', seed: 2 });
    const comma = await replay(c, { profile, voice, mode: 'comma', seed: 2 });
    assert.deepEqual(sentence.violations, [], `${c.id} sentence ${voice} ${profile.name}`);
    assert.deepEqual(comma.violations, [], `${c.id} comma ${voice} ${profile.name}`);
    assert.equal(sentence.firstCut, false);
    if (!comma.firstCut) { assert.deepEqual(comma.pieces.map(p => p.text), sentence.pieces.map(p => p.text), `${c.id}: not cut, read the same`); continue; }
    compared++;
    // The stream is the same in both runs (same seed); the voices' own latencies are drawn later and differ a little.
    assert.ok(comma.pieces[0].approvedAt <= sentence.pieces[0].approvedAt, `${c.id}: the comma piece is never cleared later than the sentence`);
    if (comma.pieces[0].approvedAt < sentence.pieces[0].approvedAt) earlier++;
    assert.deepEqual(comma.pieces.slice(2).map(p => p.text), sentence.pieces.slice(1).map(p => p.text), `${c.id}: later sentences unchanged`);
  }
  assert.ok(compared >= 20 && earlier >= compared * 0.9, `${earlier}/${compared} cut replies were cleared to read earlier`);
});

test('the switch is in the settings window, in the capability list and on the channel (直接改)', () => {
  const entry = capability('voice_first_chunk')!;
  assert.ok(entry, 'registered (I-025)');
  assert.equal(entry.level, 'direct'); assert.ok(capabilityChannel(entry)); assert.deepEqual(entry.controls, ['#voice-first-chunk']);
  const spec = AGENT_SETTINGS.find(setting => setting.id === 'voice_first_chunk')!;
  assert.equal(spec.kind, 'enum'); assert.equal(spec.chat, false, 'a comparison switch: her chat does not offer it');
  assert.deepEqual(spec.choices.map(choice => choice.value), ['sentence', 'comma']);
});
