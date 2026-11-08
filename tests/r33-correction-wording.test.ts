import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceContinuationNote, voiceMergedNote } from '../electron/voice-chat-host';

/**
 * R33.
 * When more of one utterance arrives (merged into a stopped reply, or as an
 * explicit continuation), the private note sent with it used to say
 * "请结合补充纠正理解" / "需要时纠正", which frames every addition as HER
 * misunderstanding. These pin the note's contract; how the model words its
 * reply is not proven here (no live Claude call).
 */
const prior = '我想周末去爬山';
for (const [name, note] of [['continuation', voiceContinuationNote], ['merged', voiceMergedNote]] as const) {
  test(`R33 ${name} note: the earlier sentences are the user's own words and keep the existing caller anchors`, () => {
    const text = note(prior);
    assert.ok(text.includes(prior));
    assert.match(text, /不是另一条新输入/);
    assert.match(text, /用户(?:自己)?的原话/, 'what she heard is stated as what the user said');
    if (name === 'continuation') assert.match(text, /已处理的前文/);
  });
  test(`R33 ${name} note: a real change of mind is the user's, never her mishearing`, () => {
    const text = note(prior);
    assert.doesNotMatch(text, /纠正理解|需要时纠正/, 'no instruction to correct her understanding');
    assert.match(text, /改了主意|改口/);
    assert.match(text, /不要说(?:成)?(?:是)?你(?:之前)?(?:听错|记错|理解错)/);
  });
  test(`R33 ${name} note: the same content repeated or continued is not a correction`, () => {
    const text = note(prior);
    assert.match(text, /(?:相同|一样|重复)/);
    assert.match(text, /不(?:要|是)(?:当成|算)?(?:纠正|改口)/);
  });
}
