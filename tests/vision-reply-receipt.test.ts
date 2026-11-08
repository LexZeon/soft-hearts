import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveVision, type ProactiveVisionMessage } from '../electron/proactive-vision';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { ReplyPresentation } from '../electron/reply-presentation';
import { VisionPresentationGuard } from '../electron/vision-presentation-adapter';
import { prepareVisionDelivery } from '../src/ui/proactive-vision-delivery';
import { formatVisionPresentation } from '../shared/vision-runtime';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const recipient = {}, gate = new ProactiveSpeechGate(() => 1000), receipts = new ReplyPresentation();
  gate.setScope('scope');
  const offered: ProactiveVisionMessage[] = [], archived: ProactiveVisionMessage[] = [];
  let current = true, historyAndVoice = 0, retracted = 0;
  let receiptToken: string | null = null;
  const surface = {
    waitForPresentation: (text: string, signal?: AbortSignal) => { receiptToken = receipts.currentToken(recipient); return receipts.waitForPresentation(text, signal); },
    isPresentationCurrent: (_text: string) => receipts.isCurrent(receiptToken, recipient),
  };
  const guard = new VisionPresentationGuard({ surface: () => surface, identity: () => 'scope', eligible: () => current });
  const engine = new ProactiveVision({ gate, clock: () => 1000,
    capture: async () => [{ source: 'screen', dataUrl: 'data:image/jpeg;base64,QUJDRA==' }],
    generate: async () => '看起来是合成的蓝色画面。', offer: message => { offered.push(message); },
    present: (message, signal) => guard.present(message, signal),
    presentationCurrent: message => guard.current(message),
    current: () => current, archive: async message => { archived.push(message); },
  });
  return { gate, receipts, recipient, engine, offered, archived,
    close: () => { current = false; engine.cancel(); },
    deliver: () => prepareVisionDelivery({
      publish: async () => { receipts.begin(formatVisionPresentation(offered[0]), recipient); },
      ack: () => engine.ack(offered[0].id), current: () => current,
      commit: () => { historyAndVoice++; }, retract: () => { retracted++; },
    }), counts: () => ({ historyAndVoice, retracted }),
    dispose: () => { engine.dispose(); gate.dispose(); receipts.dispose(); },
  };
}
test('the real receipt primitive connects published body, host commit, archive and later UI speech in order', async () => {
  const h = fixture();
  try {
    await h.engine.start('scope', { id: 'visual-opportunity', kind: 'speech', until: 4000 }, true);
    const task = h.deliver(); await flush();
    assert.equal(h.gate.busy, true);
    assert.equal(h.archived.length, 0); assert.equal(h.counts().historyAndVoice, 0);
    assert.equal(h.receipts.acknowledge('wrong-nonce-value', h.recipient, true), false);
    await flush(); assert.equal(h.archived.length, 0);
    const token = h.receipts.currentToken(h.recipient); assert.ok(token);
    assert.equal(h.receipts.acknowledge(token, h.recipient, true), true);
    assert.equal(await task, true);
    assert.equal(h.gate.busy, false); assert.equal(h.archived.length, 1);
    assert.equal(h.archived[0].text, '看起来是合成的蓝色画面。');
    assert.deepEqual(h.archived[0].origin.labels, ['屏幕']);
    assert.equal(h.counts().historyAndVoice, 1);
    assert.equal(await h.engine.ack('visual-opportunity'), false);
  } finally { h.dispose(); }
});
test('closing an authorized source while presentation waits cannot archive or speak on a late receipt', async () => {
  const h = fixture();
  try {
    await h.engine.start('scope', { id: 'cancelled-opportunity', kind: 'speech', until: 4000 }, true);
    const task = h.deliver(); await flush();
    const oldToken = h.receipts.currentToken(h.recipient); assert.ok(oldToken);
    h.close();
    h.receipts.acknowledge(oldToken, h.recipient, true);
    assert.equal(await task, false);
    assert.equal(h.archived.length, 0); assert.equal(h.counts().historyAndVoice, 0);
    assert.equal(h.counts().retracted, 1);
    assert.equal(h.gate.tryAcquire({ scope: 'scope', opportunityId: 'cancelled-opportunity', expiresAt: 3000 }, 'ambient'), null);
  } finally { h.dispose(); }
});

for (const invalidation of ['hidden-revision', 'same-text-new-revision']) {
  test(`a successful receipt invalidated before async continuation cannot commit: ${invalidation}`, async () => {
    const h = fixture();
    try {
      await h.engine.start('scope', { id: 'revision-race', kind: 'speech', until: 4000 }, true);
      const task = h.deliver(); await flush();
      const token = h.receipts.currentToken(h.recipient); assert.ok(token);
      assert.equal(h.receipts.acknowledge(token, h.recipient, true), true);
      // Same JS turn: native hide/invalidate or a new explicit text revision can
      // precede the async ack continuation even after a true receipt was queued.
      if (invalidation === 'hidden-revision') h.receipts.invalidate();
      else h.receipts.begin(formatVisionPresentation(h.offered[0]), h.recipient);
      assert.equal(await task, false);
      assert.equal(h.archived.length, 0); assert.equal(h.counts().historyAndVoice, 0);
    } finally { h.dispose(); }
  });
}
