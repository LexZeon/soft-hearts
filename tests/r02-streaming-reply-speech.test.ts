import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { CompletedPrefixProof } from '../electron/completed-prefix-proof';
import { ReplySpeechStyles, freezeTurnSpeechStyle } from '../electron/speech-emotion';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment } from '../shared/tts';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';

/*
 * R02 goal 2: a Claude reply's first complete sentence becomes speakable while
 * the rest still streams. Each sentence keeps its own lease and display proof;
 * the reply is finished in place when the provider completes.
 */
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const owner = 8, scope = 'scope';

test('R02 stream: the first sentence is released before the reply completes, later ones as they finish', async () => {
  const plans = new CompletedReplySpeech();
  const fence = plans.beginCommit(owner, 'r', scope);
  let committed: object | null = null;
  void plans.waitForCommit(owner, 'r', scope).then(value => { committed = value; });
  plans.append(fence, '第一'); await flush();
  assert.equal(committed, null, 'no incomplete sentence is speakable');
  plans.append(fence, '句。第二'); await flush();
  assert.ok(committed, 'the first complete sentence makes the reply speakable mid-stream');
  assert.equal(plans.isPrefixReply(owner, 'r', scope), true);
  assert.equal(await plans.waitForPiece(owner, 'r', scope), true);
  const first = plans.next(owner, 'r', scope)!;
  assert.equal(first.text, '第一句。'); assert.equal(first.visibleText, '第一句。');
  assert.equal(plans.fullPresentationText(owner, 'r', scope, first), '第一句。第二', 'the live body grows with the stream');
  let second = false;
  const waiting = plans.waitForPiece(owner, 'r', scope, 0).then(value => { second = value; });
  await flush(); assert.equal(second, false, 'the next sentence is not complete yet');
  assert.throws(() => plans.next(owner, 'r', scope, 0), /尚未完成/, 'a caller cannot skip the wait and end the reply early');
  plans.append(fence, '句。'); await waiting;
  assert.equal(second, true);
  const next = plans.next(owner, 'r', scope, 0)!;
  assert.equal(next.text, '第二句。'); assert.equal(next.visibleText, '第一句。第二句。');
  plans.append(fence, '最后没有句号');
  let tail = false;
  const last = plans.waitForPiece(owner, 'r', scope, 1).then(value => { tail = value; });
  await flush(); assert.equal(tail, false);
  assert.equal(plans.record(owner, 'r', scope, '第一句。第二句。最后没有句号', { prefix: true, fence }), true);
  await last; assert.equal(tail, true, 'completion releases the unterminated tail');
  assert.equal(plans.next(owner, 'r', scope, 1)!.text, '最后没有句号');
  assert.equal(plans.next(owner, 'r', scope, 2), null, 'then the reply is finished');
});

test('R02 stream: cancellation or a changed context wakes waiters and nothing more is spoken', async () => {
  const plans = new CompletedReplySpeech();
  const fence = plans.beginCommit(owner, 'r', scope);
  plans.append(fence, '一句。'); await flush();
  assert.equal(plans.next(owner, 'r', scope)!.index, 0);
  const waiting = plans.waitForPiece(owner, 'r', scope, 0);
  plans.cancel(owner, 'r');
  assert.equal(await waiting, false);
  assert.equal(plans.next(owner, 'r', scope, 0), null);
  plans.append(fence, '迟到的句子。');
  assert.equal(plans.isOrdinary(owner, 'r', scope), false, 'a late delta cannot revive a cancelled reply');
});

test('R02 stream: a reply that grows past the read-aloud limit stops speaking with the existing message', async () => {
  const plans = new CompletedReplySpeech();
  const fence = plans.beginCommit(owner, 'r', scope);
  plans.append(fence, '开头。');
  assert.equal(plans.next(owner, 'r', scope)?.text, '开头。', 'already spoken before the overflow');
  const waiting = plans.waitForPiece(owner, 'r', scope, 0);
  plans.append(fence, '长'.repeat(6000));
  assert.equal(await waiting, true, 'the overflow wakes the waiting queue');
  assert.throws(() => plans.next(owner, 'r', scope, 0), /6000字符限制/);
});

test('R02 stream: a completion whose text differs from what streamed is refused instead of re-segmented', async () => {
  const plans = new CompletedReplySpeech();
  const fence = plans.beginCommit(owner, 'r', scope);
  plans.append(fence, '一句。'); await flush();
  plans.next(owner, 'r', scope);
  assert.equal(plans.record(owner, 'r', scope, '完全不同。', { prefix: true, fence }), true);
  assert.throws(() => plans.next(owner, 'r', scope, 0), /无法安全分段/);
});

test('R02 stream: a reply with no streamed sentence still records and segments normally at completion', async () => {
  const plans = new CompletedReplySpeech();
  const fence = plans.beginCommit(owner, 'r', scope);
  plans.append(fence, '没有句号');
  assert.equal(plans.record(owner, 'r', scope, '没有句号', { prefix: true, fence }), true);
  assert.equal(plans.next(owner, 'r', scope)!.text, '没有句号');
});

test('R02 stream: the native prefix proof accepts a body that keeps growing', async () => {
  let shown = '', revision = 0, body = '第一句。';
  const proof = new CompletedPrefixProof({
    snapshot: () => ({ text: shown, revision, ready: !!shown, ownerCurrent: true }),
    current: text => text === shown && shown.length > 0,
    waitExact: async text => text === shown,
  });
  const accepted: string[] = [];
  const result = proof.wait(() => body, 4, new AbortController().signal, 10_000, text => { accepted.push(text); return true; });
  body = '第一句。第二'; shown = '第一句。第二'; revision++; proof.changed();
  assert.equal(await result, true, 'the bubble shows more than the body known at the start');
  assert.deepEqual(accepted, ['第一句。第二']);
  const fixed = proof.wait('第一句。', 4, new AbortController().signal, 10_000, () => true);
  assert.equal(await fixed, false, 'a fixed completed body still rejects text it does not contain');
});

test('R02 stream: the turn voice is frozen at acceptance; the completion\'s own mood is adopted once', () => {
  const styles = new ReplySpeechStyles();
  styles.begin(owner, 'r', scope);
  const config = { ...DEFAULT_TTS_CONFIG, provider: 'bailian' as const };
  assert.equal(freezeTurnSpeechStyle(styles, { owner, replyId: 'r', scope, config, persona: '性格：温柔。', mood: { primary: 'happy', context: 'positive' } }), true);
  const frozen = styles.resolveStyle(owner, 'r', scope).instruction;
  assert.match(frozen, /开心/);
  assert.equal(styles.complete(owner, 'r', scope, { primary: 'sad', context: 'disappointment' }, { instruction: '低落', emotion: 'custom' }), true, 'completion is accepted once');
  // R02: later sentences follow the reply's own mood (see r02-bailian-turn-mood).
  assert.equal(styles.resolveStyle(owner, 'r', scope).instruction, '低落', 'sentences not yet synthesized use the reply\'s own mood');
  assert.equal(styles.complete(owner, 'r', scope, { primary: 'calm', context: 'neutral' }), false, 'and only once');
  styles.begin(owner, 'q', scope);
  assert.equal(freezeTurnSpeechStyle(styles, { owner, replyId: 'q', scope, config, persona: '', mood: { primary: 'not-a-mood' } }), true);
  assert.match(styles.resolveStyle(owner, 'q', scope).instruction, /平静自然/, 'an invalid snapshot falls back to calm');
});

test('R02 stream: the real queue speaks sentence one while the provider is still streaming', async () => {
  // Host emulation with the real plan, in the same order as nextReplySpeechSegment.
  const plans = new CompletedReplySpeech();
  const fence = plans.beginCommit(owner, 'r', scope);
  const api = {
    async nextReplySpeechSegment(id: string, completedIndex?: number): Promise<ApprovedReplySpeechSegment | null> {
      if (!await plans.waitForCommit(owner, id, scope)) return null;
      if (!await plans.waitForPiece(owner, id, scope, completedIndex)) return null;
      const segment = plans.next(owner, id, scope, completedIndex);
      if (segment) plans.approvePresentation(owner, id, scope, segment, plans.fullPresentationText(owner, id, scope, segment)!);
      return segment;
    },
    async cancelReplySpeech() {},
  };
  const spoken: string[] = [];
  let release!: () => void;
  const queue = new CompletedReplySpeechQueue(api, async piece => { spoken.push(piece.text); await new Promise<void>(resolve => { release = resolve; }); }, () => true);
  const done = queue.speak('r');
  plans.append(fence, '你好。'); await flush();
  plans.append(fence, '今天'); await flush();
  assert.deepEqual(spoken, ['你好。'], 'speech starts before the reply has finished streaming');
  plans.append(fence, '天气不错。'); release(); await flush();
  assert.deepEqual(spoken, ['你好。', '今天天气不错。']);
  plans.record(owner, 'r', scope, '你好。今天天气不错。', { prefix: true, fence }); release(); await done;
  assert.deepEqual(spoken, ['你好。', '今天天气不错。']);
});
