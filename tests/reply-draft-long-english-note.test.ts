// 2026-11-04: in a Chinese chat a reply began with a long English plan on one line (about 300 characters; third person;
// a few reminders to itself), then a short line about the reply's tone, then "……" and the real reply. Each sentence alone had
// too few cues, and the line was longer than HOLD_CAP before it ended, so the whole plan was shown and read aloud.
// The text below is invented for the test: only the structure matches (no words of the user's chat are used).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyDraftGuard } from '../electron/reply-draft-guard';

function run(chunks: string[], chinese = true): { shown: string; kinds: string[] } {
  const guard = new ReplyDraftGuard([], { chinese });
  let shown = '';
  for (const chunk of chunks) shown += guard.push(chunk);
  shown += guard.finish();
  return { shown, kinds: guard.dropped.map(drop => drop.kind) };
}

// One sentence per idea, each with at most one cue; together: the user, should, avoid, mention, keep it.
const PLAN_START = 'User asked about weekend plans and sounds a bit low. Her mood is calm and a little hopeful. The weather was rainy all day, '
  + 'per the earlier message. Should she suggest going for a walk anyway? Perhaps not, staying in is fine too. When the person is low, comfort first';
const PLAN_REST = [', avoid', ' pushing. No word about the', ' window or the clock, just warmth and a sm', 'all joke. Keep it li', 'ght.'];
const TONE = ['\n\nReply style: so', 'ft, war', 'm.', ' Short.'];
const REPLY = ['……', '下雨', '天', '就窝在家里吧，', '\n我陪你。'];
const AS_ONE_BIG_CHUNK = [PLAN_START, ...PLAN_REST, ...TONE, ...REPLY];
const EXPECTED = '……下雨天就窝在家里吧，\n我陪你。';

test('a long English plan line in front of the Chinese reply is dropped whole when it arrives in one big chunk', () => {
  assert.ok(PLAN_START.length >= 230 && (PLAN_START + PLAN_REST.join('')).length > 240, 'longer than HOLD_CAP before the line ends');
  const { shown, kinds } = run(AS_ONE_BIG_CHUNK);
  assert.equal(shown, EXPECTED);
  assert.ok(kinds.length >= 1 && kinds.every(kind => kind === 'english-note'), kinds.join());
});

test('the same plan arriving a few characters at a time is dropped the same way', () => {
  const small = AS_ONE_BIG_CHUNK.flatMap((chunk, index) => index === 0 ? chunk.match(/.{1,6}/gsu)! : [chunk]);
  assert.equal(run(small).shown, EXPECTED);
});

test('ordinary long English in a Chinese chat (no self-talk cues) still goes out unchanged', () => {
  const poem = 'Twinkle, twinkle, little star, how I wonder what you are. Up above the world so high, like a diamond in the sky. '
    + 'When the blazing sun is gone, when he nothing shines upon, then you show your little light, twinkle, twinkle, all the night, little star.';
  assert.ok(poem.length > 240);
  const guard = new ReplyDraftGuard([], { chinese: true });
  let shown = '';
  for (const piece of poem.match(/.{1,8}/gsu)!) shown += guard.push(piece);
  shown += guard.push('\n小星星～') + guard.finish();
  assert.equal(shown, poem + '\n小星星～');
  assert.deepEqual(guard.dropped, []);
});

test('a short English note in front of the reply keeps the reply\'s own leading "……"', () => {
  assert.equal(run(['Keep it short, the user is tired.', '……', '晚安啦。']).shown, '……晚安啦。');
});

test('an English chat is not touched by the Chinese-chat rules', () => {
  const { shown } = run(['Sure! ', 'The user and I can keep it short today. Let me know if you need anything else.'], false);
  assert.equal(shown, 'Sure! The user and I can keep it short today. Let me know if you need anything else.');
});
