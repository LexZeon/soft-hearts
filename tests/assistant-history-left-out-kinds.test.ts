// Fix 8 added two kinds of "not carried" items (a look-back, a persona field). The assistant's saved history kept only the
// four older kinds, so after a restart those lines vanished from the conversion box. Every kind the conversion can list survives.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanHistory } from '../electron/safety/assistant/store';
import { CONVERSION_LEFT_OUT_KINDS } from '../shared/cards/character-convert';

test('a saved conversion keeps every kind of item it did not carry, and drops an unknown kind', () => {
  const leftOut = [...CONVERSION_LEFT_OUT_KINDS.map((kind, index) => ({ title: `第 ${index + 1} 项`, kind, reasons: ['capped'] })),
    { title: '不认识的', kind: 'secret', reasons: ['capped'] }];
  const [message] = cleanHistory([{ id: 'm1', role: 'assistant', at: 1, status: 'done', parts: [{ kind: 'conversion', job: {
    id: 'job-1', sourceId: 'orange', sourceName: '小橙', target: 'en', state: 'done', steps: [], startedAt: 1, leftOut, leftOutCount: leftOut.length } }] }]);
  const part = message.parts[0];
  assert.equal(part.kind, 'conversion');
  const kinds = part.kind === 'conversion' ? (part.job.leftOut ?? []).map(item => item.kind) : [];
  assert.deepEqual(kinds, [...CONVERSION_LEFT_OUT_KINDS], 'review and persona are kept; the unknown kind is not');
});
