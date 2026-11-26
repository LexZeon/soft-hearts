// 2026-11-21 (dev journal 20:41 and 20:42): when she asked for a closer look her first character showed at 11 and
// 13 s. Her reply began with the look marker and carried no opening marker <sh-open>, so the opening gate (electron/brain/reply-opening.ts)
// held the app's "……" and the whole continuation until the reply was complete. Now LookContinuation opens the reply at the app's own
// "……" when the first part never did, and runs the continuation through a gate of its own (only her words after her marker in it go on;
// the note names the marker). The leak guard stays: nothing she wrote in front of a valid marker is shown.
// Real: LookContinuation, OpeningGate (as the reply protocol makes it: the fixed marker, this turn's state tail). Fake: the chat (scripted
// chunks), the capture, the clock (a step counter).
import test from 'node:test';
import assert from 'node:assert/strict';
import { closerLookNote } from '../shared/senses/see-and-say/words';
import { FIXED_OPENING_MARKER, OpeningGate } from '../electron/brain/reply-opening';
import { LookContinuation, type ContinuableChat } from '../electron/brain/look-continuation';
import type { CompanionClaudeTask } from '../electron/brain/claude-session-types';

const TAIL = '<sh-state-ab12cd34>{"context":"support"}</sh-state-ab12cd34>';

/**
 * One reply with a closer look, as the app streams it: her first part, the look, her continuation; downstream the turn's opening gate.
 * Returns what became visible at each step: right after the first part, right after the "……" (before the continuation starts), after
 * each continuation chunk, and at the end.
 */
async function reply(first: string[], continuation: string[], opening: string | null = FIXED_OPENING_MARKER) {
  const gate = new OpeningGate({ marker: FIXED_OPENING_MARKER, tailAt: text => text.indexOf('<sh-state-ab12cd34>'), mayBeTail: text => '<sh-state-ab12cd34>'.startsWith(text) });
  let visible = '';
  const steps: { at: string; visible: string }[] = [];
  const mark = (at: string) => steps.push({ at, visible });
  const chat: ContinuableChat = {
    async stream(_task, _signal, emit) { for (const chunk of first) emit('delta', chunk); mark('first part'); return { superseded: false, output: first.join('') }; },
    async continueReply(task, _signal, emit) {
      mark('before the continuation');
      void task.imageDataUrls; void task.prompt;
      for (const [i, chunk] of continuation.entries()) { emit('delta', chunk); mark(`continuation ${i}`); }
      return { superseded: false, output: continuation.join('') };
    },
  };
  const look = new LookContinuation({ senses: () => ({ camera: false, screen: true }), capture: async () => ({ dataUrls: () => ['data:image/jpeg;base64,AA=='] }),
    note: (sense, seen) => closerLookNote(sense, seen, 'zh-CN', opening ?? ''), knobs: { closerLook: true, closerTimeoutMs: 1000, dots: '……' }, ...(opening !== null ? { opening } : {}) });
  const task = { kind: 'chat', model: 'm', workingDirectory: '.', writable: false, prompt: 'p', replyId: 'r1' } as CompanionClaudeTask;
  await look.stream(chat, task, new AbortController().signal, (type, text) => { if (type === 'delta') visible += gate.push(text); });
  visible += gate.finish(true);
  mark('end');
  const at = (name: string) => steps.find(step => step.at === name)?.visible ?? '';
  return { visible, at, steps, state: gate.state };
}

test('her reply begins with the look marker, no opening marker: the "……" shows at once and the continuation streams', async () => {
  const r = await reply(['⟦look-screen⟧'], ['<sh-open>', '看清了，', '是个红色的报错。', TAIL]);
  assert.equal(r.at('before the continuation'), '……', 'the app\'s "……" is visible before the continuation starts (it used to wait for the whole reply)');
  assert.equal(r.at('continuation 1'), '……看清了，', 'her continuation streams chunk by chunk');
  assert.equal(r.visible.replace(TAIL, ''), '……看清了，是个红色的报错。');
  assert.equal(r.state, 'ok');
});

test('her first sentence after the opening marker, then the look: first words and "……" at once; a continuation without the marker still streams', async () => {
  const r = await reply(['<sh-open>', '嗯，让我看看', '⟦look-screen⟧'], ['看清了，', '是终端。', TAIL]);
  assert.equal(r.at('before the continuation'), '嗯，让我看看……');
  assert.equal(r.at('continuation 0'), '嗯，让我看看……看清了，');
  assert.ok(!r.visible.includes('<sh-open>') && !r.visible.includes('⟦'));
});

test('the leak guard stays: words she wrote in front of any opening marker never show, in the first part or in the continuation', async () => {
  const r = await reply(['我先想想怎么回答这个', '⟦look-screen⟧'], ['回答计划：先描述画面', '<sh-open>', '看到了，是一张表格。', TAIL]);
  assert.equal(r.at('before the continuation'), '……', 'her unmarked first words are dropped (they may be a draft); the "……" is the app\'s own');
  assert.ok(!r.visible.includes('想想') && !r.visible.includes('计划'), r.visible);
  assert.equal(r.visible.replace(TAIL, ''), '……看到了，是一张表格。');
});

test('a continuation that forgets the marker: held until its words are complete, then shown (reply-opening.ts\'s forgotten-marker cut applies, as for the turn)', async () => {
  const r = await reply(['⟦look-screen⟧'], ['看清了，', '没什么特别的。', TAIL]);
  assert.equal(r.at('continuation 0'), '……', 'not before her words are complete');
  assert.equal(r.visible.replace(TAIL, ''), '……看清了，没什么特别的。', 'then shown whole');
});

test('the note names the opening marker (zh and en); without the opening port nothing changes (the turn mode)', async () => {
  assert.match(closerLookNote('screen', true, 'zh-CN', '<sh-open>'), /写在开头标记<sh-open>之后/u);
  assert.match(closerLookNote('camera', false, 'en', '<sh-open>'), /after the opening marker <sh-open>/u);
  assert.ok(!closerLookNote('camera', true, 'zh-CN').includes('开头标记'));
  const old = await reply(['⟦look-screen⟧'], ['看清了。', TAIL], null);
  assert.equal(old.at('before the continuation'), '', 'no opening port: the gate downstream holds as before');
  assert.equal(old.visible.replace(TAIL, ''), '……看清了。');
});
