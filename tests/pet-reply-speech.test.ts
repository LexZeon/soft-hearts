import test from 'node:test';
import assert from 'node:assert/strict';
import type { PetReplyAnchor, PetReplyUpdate } from '../shared/contracts';
import { PetUI } from '../src/ui/PetUI';
import { ReplySpeechState } from '../src/ui/reply-speech';
import { REPLY_LINGER_KNOBS } from '../shared/behaviors/reply-linger/knobs';

class Classes {
  private readonly values = new Set<string>();
  add(...names: string[]): void { names.forEach(name => this.values.add(name)); }
  remove(...names: string[]): void { names.forEach(name => this.values.delete(name)); }
  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}

/**
 * #5: the host decides how long a completed reply stays and answers the 'complete' update with it
 * (shared/behaviors/reply-linger/). This fake host always answers HOST_LINGER_MS, so the timings below are the renderer
 * keeping the host's answer; until the answer arrives (`answered()`), the renderer waits at most the longest.
 */
const HOST_LINGER_MS = 5000;

async function withPet(run: (fixture: {
  ui: PetUI; updates: PetReplyUpdate[]; body: { textContent: string };
  advance(ms: number): void; now(): number; deadline(): number; anchor(): void; bodyWrites(): number; answered(): Promise<void>;
}) => void | Promise<void>, answer: (update: PetReplyUpdate) => unknown = update => update.state === 'complete' ? { lingerMs: HOST_LINGER_MS } : undefined): Promise<void> {
  const originalDocument = globalThis.document, originalWindow = globalThis.window, originalNow = Date.now;
  let now = 1000;
  const updates: PetReplyUpdate[] = [], errors: string[] = [];
  let content = '', writes = 0;
  const body = { get textContent() { return content; }, set textContent(value: string) { content = value; writes++; }, classList: new Classes() };
  const tooltip = { classList: new Classes() };
  const anchor: PetReplyAnchor = { x: 190, y: 180, radius: 90, visible: true };
  globalThis.document = {
    getElementById: (id: string) => id === 'pet-answer-body' ? body : id === 'pet-tooltip' ? tooltip : null,
    querySelectorAll: () => [], body: { classList: new Classes() },
  } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (update: PetReplyUpdate) => {
    updates.push(structuredClone(update));
    return answer(update);
  } } } as unknown as Window & typeof globalThis;
  Date.now = () => now;
  // Exercise real public PetUI methods without constructing unrelated toolbar,
  // pointer capture or browser media. Its private wire method is not replaced.
  const ui = Object.create(PetUI.prototype) as PetUI;
  const fields = ui as unknown as { replyExpiresAt: number };
  Object.assign(ui, {
    anchor, replyState: 'hidden', replyExpiresAt: 0, replyLingerAsk: 0, replyStreaming: false,
    replySpeech: new ReplySpeechState(), interacting: false, interactionProgress: 0, actions: { error: (message: string) => errors.push(message) },
  });
  try {
    await run({ ui, updates, body, advance: ms => { now += ms; }, now: () => now,
      deadline: () => fields.replyExpiresAt, anchor: () => ui.setFaceAnchor({ ...anchor }), bodyWrites: () => writes,
      answered: async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); } });
    assert.deepEqual(errors, []);
  } finally { globalThis.document = originalDocument; globalThis.window = originalWindow; Date.now = originalNow; }
}

test('PetUI keeps completed text and anchor updates alive beyond the longest linger while speech is pending', () => withPet(f => {
  f.ui.beginAnswer('chat-a'); f.ui.showAnswer('长回复', true, 'chat-a');
  f.ui.finishAnswer('长回复', 'chat-a', true);
  assert.equal(f.updates.at(-1)?.state, 'streaming'); assert.equal(f.deadline(), Infinity);
  f.advance(REPLY_LINGER_KNOBS.range[1] + 5000); const before = f.updates.length; f.anchor();
  assert.equal(f.updates.length, before + 1); assert.ok(f.updates.at(-1)?.anchor);
  assert.equal(f.body.textContent, '长回复'); assert.equal(f.deadline(), Infinity);
}));

test('PetUI speech end publishes completion once and starts a fresh deadline from the host answer', () => withPet(async f => {
  f.ui.finishAnswer('正文', 'chat-a', true); f.advance(9000); f.ui.endAnswerSpeech('chat-a');
  assert.deepEqual(f.updates.at(-1), { state: 'complete' }); assert.equal(f.deadline(), f.now() + REPLY_LINGER_KNOBS.range[1], 'the longest until the host answers');
  await f.answered(); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
  const expiry = f.deadline(), before = f.updates.length;
  f.advance(1000); f.ui.endAnswerSpeech('chat-a'); assert.equal(f.updates.length, before); assert.equal(f.deadline(), expiry);
  f.advance(3999); f.anchor(); assert.ok(f.updates.at(-1)?.anchor);
  f.advance(1); f.anchor(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
}));

test('PetUI preserves early speech end through begin and the empty streaming placeholder', () => withPet(async f => {
  f.ui.endAnswerSpeech('chat-a'); f.ui.beginAnswer('chat-a'); f.ui.showAnswer('', true, 'chat-a');
  f.ui.showAnswer('迟到的正文', true, 'chat-a'); f.ui.finishAnswer('迟到的正文', 'chat-a', true);
  await f.answered(); assert.equal(f.updates.at(-1)?.state, 'complete'); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
  f.advance(5000); f.anchor(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
}));

test('PetUI end before done records completion without interrupting text streaming', () => withPet(async f => {
  f.ui.beginAnswer('chat-a'); f.ui.showAnswer('分片', true, 'chat-a');
  const before = f.updates.length; f.ui.endAnswerSpeech('chat-a'); assert.equal(f.updates.length, before);
  f.ui.finishAnswer('分片完成', 'chat-a', true);
  await f.answered(); assert.equal(f.updates.at(-1)?.state, 'complete'); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
}));

test('PetUI ignores the previous speech end while a new reply is held', () => withPet(f => {
  f.ui.finishAnswer('旧回复', 'chat-a', true);
  f.ui.beginAnswer('chat-b'); f.ui.showAnswer('', true, 'chat-b'); f.ui.finishAnswer('新回复', 'chat-b', true);
  const before = f.updates.length; f.advance(8000); f.ui.endAnswerSpeech('chat-a');
  assert.equal(f.updates.length, before); assert.equal(f.deadline(), Infinity); assert.equal(f.body.textContent, '新回复');
  f.anchor(); assert.ok(f.updates.at(-1)?.anchor);
}));

test('PetUI hide prevents an old speech callback or anchor from restoring text', () => withPet(f => {
  f.ui.finishAnswer('旧回复', 'chat-a', true); f.ui.hideAnswer(); const before = f.updates.length;
  f.advance(12000); f.ui.endAnswerSpeech('chat-a'); f.anchor();
  assert.equal(f.updates.length, before); assert.deepEqual(f.updates.at(-1), { state: 'hidden' }); assert.equal(f.deadline(), 0);
}));

test('PetUI unkeyed greeting and mood text clear the preceding chat speech hold', () => withPet(f => {
  for (const [id, message] of [['chat-a', '开场白'], ['chat-b', '心情互动回应']]) {
    f.ui.finishAnswer('朗读中', id, true); f.ui.showAnswer(message);
    assert.equal(f.updates.at(-1)?.state, 'complete'); const expiry = f.deadline(), before = f.updates.length;
    f.advance(2000); f.ui.endAnswerSpeech(id);
    assert.equal(f.updates.length, before); assert.equal(f.deadline(), expiry); assert.equal(f.body.textContent, message);
  }
}));

test('PetUI interaction fades a pending reply without changing its lifetime or replaying text', () => withPet(f => {
  f.ui.finishAnswer('仍在朗读', 'chat-a', true); f.ui.setInteraction(true);
  assert.deepEqual(f.updates.at(-1), { interactionOpacity: 0 }); f.advance(12000); f.anchor();
  assert.equal(f.updates.at(-1)?.interactionOpacity, 0); assert.equal(f.updates.at(-1)?.state, undefined);
  f.ui.setInteraction(false);
  assert.deepEqual(f.updates.at(-1), { interactionOpacity: 1 }); assert.equal(f.deadline(), Infinity); assert.equal(f.body.textContent, '仍在朗读');
}));

test('PetUI speech ending during interaction keeps the original post-speech deadline after restore', () => withPet(async f => {
  f.ui.finishAnswer('正文', 'chat-a', true); f.ui.setInteraction(true); f.advance(12000); f.ui.endAnswerSpeech('chat-a');
  await f.answered(); const expiry = f.deadline(); assert.equal(expiry, f.now() + HOST_LINGER_MS); assert.deepEqual(f.updates.at(-1), { state: 'complete', interactionOpacity: 0 });
  f.advance(2000); f.ui.setInteraction(false); assert.deepEqual(f.updates.at(-1), { interactionOpacity: 1 }); assert.equal(f.deadline(), expiry);
  f.advance(3000); f.anchor(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
  f.ui.setInteraction(true); const before = f.updates.length; f.ui.setInteraction(false); assert.equal(f.updates.length, before);
}));

test('PetUI hover progress fades continuously and early exit never renews the completion deadline', () => withPet(async f => {
  f.ui.showAnswer('等待期间的回答'); await f.answered(); const expiry = f.deadline();
  f.advance(500); f.ui.setInteractionProgress(0.25); assert.deepEqual(f.updates.at(-1), { interactionOpacity: 0.75 });
  f.advance(500); f.ui.setInteractionProgress(0.5); assert.deepEqual(f.updates.at(-1), { interactionOpacity: 0.5 });
  f.ui.setInteractionProgress(0); assert.deepEqual(f.updates.at(-1), { interactionOpacity: 1 }); assert.equal(f.deadline(), expiry);
  f.advance(4000); f.ui.setInteractionProgress(0.5); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
  const count = f.updates.length; f.ui.setInteractionProgress(0); f.ui.setInteraction(true); f.ui.setInteraction(false);
  assert.equal(f.updates.length, count, 'expired text never returns on interaction exit');
}));

test('PetUI new text during interaction stays visually suppressed and true hide remains immediate', () => withPet(f => {
  f.ui.setInteraction(true); assert.equal(f.updates.length, 0, 'hover does not create an empty native reply');
  f.ui.finishAnswer('新的长回复', 'chat-a', true);
  assert.equal(f.updates.at(-1)?.interactionOpacity, 0); assert.equal(f.updates.at(-1)?.state, 'streaming');
  f.ui.hideAnswer(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
  const count = f.updates.length; f.ui.setInteraction(false); f.ui.endAnswerSpeech('chat-a'); f.anchor();
  assert.equal(f.updates.length, count, 'privacy hide cannot be reversed by fade or late speech');
}));

test('PetUI interaction progress is bounded, ignores invalid samples and does not resend an unchanged fade', () => withPet(f => {
  f.ui.showAnswer('回答'); f.ui.setInteractionProgress(2); assert.deepEqual(f.updates.at(-1), { interactionOpacity: 0 });
  const count = f.updates.length;
  f.ui.setInteractionProgress(1); f.ui.setInteractionProgress(NaN); f.ui.setInteractionProgress(Infinity);
  assert.equal(f.updates.length, count);
  f.ui.setInteractionProgress(-1); assert.deepEqual(f.updates.at(-1), { interactionOpacity: 1 });
}));

test('PetUI does not extend an ordinary five-second reply for unrequested speech completion', () => withPet(f => {
  f.ui.finishAnswer('无需朗读', 'chat-a', false); const expiry = f.deadline(), before = f.updates.length;
  f.advance(2000); f.ui.endAnswerSpeech('chat-a');
  assert.equal(f.deadline(), expiry); assert.equal(f.updates.length, before);
}));

test('PetUI a new waiting request replaces the previous ordinary reply deadline', () => withPet(async f => {
  f.ui.showAnswer('上次回复'); await f.answered(); const oldDeadline = f.deadline();
  f.advance(4000); f.ui.showWaiting('waiting-b');
  assert.equal(f.body.textContent, '');
  assert.equal(f.updates.at(-1)?.text, '');
  assert.equal(f.updates.at(-1)?.state, 'waiting');
  assert.equal(f.deadline(), Infinity);
  f.advance(2000); assert.ok(f.now() > oldDeadline);
  const before = f.updates.length; f.anchor();
  assert.equal(f.updates.length, before + 1);
  assert.ok(f.updates.at(-1)?.anchor);
  assert.equal(f.updates.at(-1)?.state, undefined, 'the old completion deadline cannot hide the new wait');
}));

test('PetUI waiting stays text-free beyond a minute through anchor and interaction repaint', () => withPet(f => {
  f.ui.showWaiting('waiting-a');
  assert.equal(f.updates.at(-1)?.state, 'waiting');
  assert.equal(f.updates.at(-1)?.anchor?.visible, true);
  f.advance(60000); f.anchor();
  f.ui.setInteractionProgress(0.5);
  assert.deepEqual(f.updates.at(-1), { interactionOpacity: 0.5 });
  f.ui.setInteractionProgress(0);
  f.ui.setInteraction(true); f.advance(6000); f.ui.setInteraction(false); f.anchor();
  assert.equal(f.deadline(), Infinity);
  assert.equal(f.body.textContent, '');
  assert.ok(f.updates.every(update => update.text === undefined || update.text === ''));
  assert.ok(f.updates.every(update => update.state === undefined || update.state === 'waiting'));
  assert.ok(f.updates.at(-1)?.anchor, 'paint-only updates retain the live waiting reply');
}));

test('PetUI a previous speech completion cannot finish a newer waiting request', () => withPet(f => {
  f.ui.finishAnswer('上一段朗读', 'speech-a', true);
  f.ui.showWaiting('waiting-b'); const before = f.updates.length;
  f.advance(20000); f.ui.endAnswerSpeech('speech-a');
  assert.equal(f.updates.length, before);
  assert.equal(f.deadline(), Infinity);
  assert.equal(f.body.textContent, '');
  f.anchor(); assert.ok(f.updates.at(-1)?.anchor);
  assert.equal(f.updates.at(-1)?.state, undefined);
}));

test('PetUI waiting yields to first text and preserves the final playback plus the host-decided lifetime', () => withPet(async f => {
  f.ui.showWaiting('chat-a'); f.advance(6000);
  f.ui.showAnswer('第一段', true, 'chat-a');
  assert.equal(f.updates.at(-1)?.state, 'streaming');
  assert.equal(f.updates.at(-1)?.text, '第一段');
  assert.equal(f.body.textContent, '第一段');
  f.ui.finishAnswer('第一段与完整回复', 'chat-a', true);
  assert.equal(f.updates.at(-1)?.state, 'streaming');
  f.advance(12000); f.anchor();
  assert.equal(f.deadline(), Infinity, 'transport completion alone does not start a speech deadline');
  f.ui.endAnswerSpeech('chat-a');
  assert.deepEqual(f.updates.at(-1), { state: 'complete' });
  await f.answered(); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
  f.advance(4999); f.anchor(); assert.ok(f.updates.at(-1)?.anchor);
  f.advance(1); f.anchor(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
}));

test('PetUI hidden waiting cannot revive from old callbacks and a new identity can wait again', () => withPet(f => {
  f.ui.showWaiting('waiting-a'); f.ui.hideAnswer(); const before = f.updates.length;
  f.advance(60000); f.ui.endAnswerSpeech('waiting-a'); f.anchor();
  f.ui.setInteraction(true); f.ui.setInteraction(false);
  assert.equal(f.updates.length, before);
  assert.equal(f.deadline(), 0);
  assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
  f.ui.showWaiting('waiting-b');
  assert.equal(f.updates.at(-1)?.state, 'waiting');
  assert.equal(f.updates.at(-1)?.text, '');
  assert.equal(f.deadline(), Infinity);
  const fresh = f.updates.length; f.ui.endAnswerSpeech('waiting-a');
  assert.equal(f.updates.length, fresh);
}));

test('PetUI an empty or whitespace-only finished reply clears waiting even if speech was expected', () => withPet(f => {
  for (const [index, text] of ['', ' \n\t'].entries()) {
    const id = `empty-${index}`;
    f.ui.showWaiting(id); f.advance(60000); f.ui.finishAnswer(text, id, true);
    assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
    assert.equal(f.deadline(), 0);
    const before = f.updates.length;
    f.advance(6000); f.ui.endAnswerSpeech(id); f.anchor();
    assert.equal(f.updates.length, before);
  }
}));

test('PetUI confirmed presentation completes without replaying text and holds through speech plus the host-decided time', () => withPet(async f => {
  const text = '主动 · 屏幕\n这是一条已确认显示的视觉话题。';
  f.ui.showAnswer(text, true, 'vision-a');
  const writes = f.bodyWrites(), before = f.updates.length;
  f.advance(8000); f.ui.finishAnswer(text, 'vision-a', true, true);
  assert.equal(f.bodyWrites(), writes, 'confirmation does not rewrite the proxy body');
  assert.equal(f.updates.length, before + 1);
  assert.equal(Object.hasOwn(f.updates.at(-1)!, 'text'), false);
  assert.equal(f.updates.at(-1)?.state, 'streaming');
  assert.ok(f.updates.at(-1)?.anchor);
  assert.equal(f.deadline(), Infinity);
  assert.equal(f.body.textContent, text);
  f.advance(12000); f.anchor();
  assert.equal(f.deadline(), Infinity);
  assert.equal(Object.hasOwn(f.updates.at(-1)!, 'text'), false);
  f.ui.endAnswerSpeech('vision-a');
  assert.deepEqual(f.updates.at(-1), { state: 'complete' });
  await f.answered(); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
  const expiry = f.deadline(), endedUpdates = f.updates.length;
  f.advance(1000); f.ui.endAnswerSpeech('vision-a');
  assert.equal(f.deadline(), expiry); assert.equal(f.updates.length, endedUpdates);
  f.advance(3999); f.anchor(); assert.ok(f.updates.at(-1)?.anchor);
  f.advance(1); f.anchor(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
  assert.equal(f.bodyWrites(), writes);
}));

test('PetUI confirmed presentation without speech starts the host-decided TTL using a state-only completion', () => withPet(async f => {
  f.ui.showAnswer('无朗读的视觉话题', true, 'vision-a');
  const writes = f.bodyWrites();
  f.advance(7000); f.ui.finishAnswer('无朗读的视觉话题', 'vision-a', false, true);
  assert.equal(f.bodyWrites(), writes);
  assert.equal(f.updates.at(-1)?.state, 'complete');
  assert.equal(Object.hasOwn(f.updates.at(-1)!, 'text'), false);
  await f.answered(); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
  const expiry = f.deadline(), before = f.updates.length;
  f.advance(1000); f.ui.endAnswerSpeech('vision-a');
  assert.equal(f.deadline(), expiry); assert.equal(f.updates.length, before);
  f.advance(4000); f.anchor(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
}));

test('PetUI presentation preservation requires matching text and a non-hidden current reply', () => withPet(f => {
  f.ui.showAnswer('旧正文', true, 'vision-a');
  const writes = f.bodyWrites();
  f.ui.finishAnswer('不同正文', 'vision-a', false, true);
  assert.equal(f.bodyWrites(), writes + 1);
  assert.equal(f.updates.at(-1)?.text, '不同正文', 'a changed body must get a new presentation identity');
  f.ui.hideAnswer(); const hiddenWrites = f.bodyWrites();
  f.ui.finishAnswer('不同正文', 'vision-a', false, true);
  assert.equal(f.bodyWrites(), hiddenWrites + 1);
  assert.equal(f.updates.at(-1)?.text, '不同正文', 'a hidden old body cannot reuse its obsolete presentation');
}));

test('PetUI ordinary finish keeps full-text publication and an unkeyed finish cannot reuse an old receipt', () => withPet(async f => {
  f.ui.showAnswer('同文正文', true, 'chat-a'); const writes = f.bodyWrites();
  f.ui.finishAnswer('同文正文', 'chat-a', true);
  assert.equal(f.bodyWrites(), writes + 1);
  assert.equal(f.updates.at(-1)?.text, '同文正文', 'default callers retain the original full publication');
  assert.equal(f.deadline(), Infinity);
  const unkeyedWrites = f.bodyWrites();
  f.ui.finishAnswer('同文正文', undefined, false, true);
  assert.equal(f.bodyWrites(), unkeyedWrites + 1);
  assert.equal(f.updates.at(-1)?.text, '同文正文', 'an unkeyed completion must publish its own body identity');
  assert.equal(f.updates.at(-1)?.state, 'complete');
  await f.answered(); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
  const expiry = f.deadline(); f.advance(1000); f.ui.endAnswerSpeech('chat-a');
  assert.equal(f.deadline(), expiry);
}));

test('PetUI a new reply ID cannot borrow a same-text receipt from the previous ID', () => withPet(async f => {
  f.ui.showAnswer('完全相同的正文', true, 'vision-old');
  const writes = f.bodyWrites();
  f.ui.finishAnswer('完全相同的正文', 'vision-new', true, true);
  assert.equal(f.bodyWrites(), writes + 1);
  assert.equal(f.updates.at(-1)?.text, '完全相同的正文', 'identity match must be captured before begin changes the current ID');
  assert.equal(f.updates.at(-1)?.state, 'streaming');
  assert.equal(f.deadline(), Infinity);
  const before = f.updates.length;
  f.ui.endAnswerSpeech('vision-old');
  assert.equal(f.updates.length, before, 'the old ID cannot release the new hold');
  f.ui.endAnswerSpeech('vision-new');
  await f.answered(); assert.equal(f.deadline(), f.now() + HOST_LINGER_MS);
}));

// ---------------------------------------------------------------- #5: the pet window keeps the host's decision, nothing of its own

test('#5 PetUI keeps exactly the lifetime the host answered, whatever it is', async () => {
  for (const lingerMs of [2600, 9300, 17_500]) await withPet(async f => {
    f.ui.showAnswer('她说完的一句话。'); const sent = f.now();
    assert.equal(f.deadline(), sent + REPLY_LINGER_KNOBS.range[1], 'the longest until the host answers');
    await f.answered(); assert.equal(f.deadline(), sent + lingerMs);
    f.advance(lingerMs - 1); f.anchor(); assert.ok(f.updates.at(-1)?.anchor, `${lingerMs}: still showing`);
    f.advance(1); f.anchor(); assert.deepEqual(f.updates.at(-1), { state: 'hidden' }, `${lingerMs}: gone exactly then`);
  }, update => update.state === 'complete' ? { lingerMs } : undefined);
});

test('#5 PetUI ignores a late answer for a completion that a newer state already replaced', () => {
  const pending: ((value: unknown) => void)[] = [];
  return withPet(async f => {
    f.ui.showAnswer('第一条。'); f.ui.showWaiting('chat-b');
    pending.shift()!({ lingerMs: 3000 }); await f.answered();
    assert.equal(f.deadline(), Infinity, 'an answer for the old completion cannot put a deadline on the new wait');
    f.ui.showAnswer('第二条。'); f.ui.showAnswer('第三条。');
    pending.shift()!({ lingerMs: 3000 }); await f.answered();
    assert.equal(f.deadline(), f.now() + REPLY_LINGER_KNOBS.range[1], 'the second completion was replaced by the third');
    pending.shift()!({ lingerMs: 7000 }); await f.answered();
    assert.equal(f.deadline(), f.now() + 7000);
  }, update => update.state === 'complete' ? new Promise(resolve => pending.push(resolve)) : undefined);
});

test('#5 PetUI without a usable answer waits at most the longest (the host never keeps it longer)', async () => {
  for (const answer of [undefined, null, {}, { lingerMs: NaN }, { lingerMs: -5 }, { lingerMs: REPLY_LINGER_KNOBS.range[1] + 1 }, 'soon'])
    await withPet(async f => {
      f.ui.showAnswer('回答。'); const sent = f.now(); await f.answered();
      assert.equal(f.deadline(), sent + REPLY_LINGER_KNOBS.range[1], JSON.stringify(answer) ?? 'undefined');
    }, update => update.state === 'complete' ? answer : undefined);
});

test('#5 "查看完整回复" still has the whole reply after the bubble is gone', () => withPet(async f => {
  let readerText = '', cleared = 0;
  Object.assign(f.ui, { replyReader: { update: (text: string) => { readerText = text; }, clear: () => { cleared++; readerText = ''; }, opened: false } });
  const raw = '第一句。第二句。'.repeat(40) + '最后一句在这里？';
  f.ui.beginAnswer('chat-a'); f.ui.showAnswer(raw, true, 'chat-a', false, [4]); f.ui.finishAnswer(raw, 'chat-a', false);
  await f.answered(); f.advance(HOST_LINGER_MS); f.anchor();
  assert.deepEqual(f.updates.at(-1), { state: 'hidden' });
  assert.equal(readerText, raw); assert.equal(cleared, 1, 'only the new reply cleared it (at its start); the bubble expiring did not');
}));
