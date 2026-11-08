import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIO_OUTPUT_IDLE_MS } from '../src/ui/audio-output';

/*
 * 2026-11-06, the user: "刚刚的语音很慢". The stable app's speech timings showed the output device being resumed after its idle
 * suspend in the middle of a conversation, taking 4.3 s and 7.0 s before the first word (replies 3–4 minutes apart). The idle
 * suspend must not fall inside an ordinary conversation's pauses again.
 */
test('the voice output stays awake through a conversation\'s ordinary pauses (at least 8 minutes before the idle suspend)', () => {
  assert.ok(AUDIO_OUTPUT_IDLE_MS >= 8 * 60_000, `idle suspend after ${AUDIO_OUTPUT_IDLE_MS} ms would put the device to sleep between replies`);
  assert.ok(AUDIO_OUTPUT_IDLE_MS <= 30 * 60_000, 'still let the device sleep when nobody talks for a long while');
});
