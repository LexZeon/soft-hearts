// Stage directions are shown, never read (docs/claude/2026-11-03-draft-leak-fix.md): shared/speakable-text.ts, applied to
// the cloud voice in the host (after the segment was matched against the bubble) and to the system voice in the renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { speakableText } from '../shared/speakable-text';
import { SpeechRuntime, type SpeechSynthesizer } from '../electron/speech-runtime';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/tts';
import { perceptionTurnLine, PERCEPTION_RULE } from '../shared/perception-rule';

test('what is read: brackets and single-asterisk actions go, everything else stays', () => {
  assert.equal(speakableText('（低下头）……谢谢你。'), '……谢谢你。');
  assert.equal(speakableText('嘿嘿(笑)，你也是。'), '嘿嘿 ，你也是。');
  assert.equal(speakableText('*揉了揉眼睛* 你回来啦？'), '你回来啦？');
  assert.equal(speakableText('好呀 (＾▽＾)'), '好呀');
  assert.equal(speakableText('（把脸埋进枕头里）'), '', 'a sentence that is only a stage direction is not read at all');
  assert.equal(speakableText('（小声）……'), '', 'nothing but punctuation left');
  assert.equal(speakableText('**重要**的事说三遍'), '**重要**的事说三遍', 'bold markers are not an action');
  assert.equal(speakableText('2 * 3 * 4 等于 24'), '2 * 3 * 4 等于 24');
  assert.equal(speakableText('先这样（第一步）再那样'), '先这样 再那样');
  assert.equal(speakableText('今天好累。'), '今天好累。');
  assert.equal(speakableText('嗯（没有收尾的括号，到行尾都是动作\n这一行照读。'), '嗯\n这一行照读。');
});

// X-237 (Codex, 2026-11-04): a long direction, one over a line break, one inside another, and one the sentence segmenter
// cut in two were read aloud (docs/claude/2026-11-03-draft-first-char.md).
test('what is read: long, multi-line, nested and cut-in-two directions go too; list numbers and emoticons stay', () => {
  const long = '（她把脸埋进抱枕里，耳朵红得快要滴血，半天都没抬头，只是用脚尖轻轻踢了踢你的小腿，像是在抗议你刚才那句话）';
  assert.ok([...long].length > 40);
  assert.equal(speakableText(`${long}……你、你干嘛突然说这个。`), '……你、你干嘛突然说这个。');
  assert.equal(speakableText('(She hides her face in the pillow, ears burning, and nudges your leg with her foot for a long while) Fine.'), 'Fine.');
  assert.equal(speakableText('（她低下头，\n小声嘟囔）才没有呢。'), '才没有呢。', 'over a single line break');
  assert.equal(speakableText('（她笑了（小声））你回来啦。'), '你回来啦。', 'nested: the outer one goes too');
  assert.equal(speakableText('（先这样（再那样（最后这样）））好。'), '好。');
  // The cloud voice gets one sentence at a time: the two halves of "（她愣了一下。然后笑了）好呀。".
  assert.equal(speakableText('（她愣了一下。'), '', 'the opening half: nothing to read');
  assert.equal(speakableText('然后笑了）好呀。'), '好呀。', 'the closing half: only what follows it');
  assert.equal(speakableText('（她愣了一下。然后笑了）好呀。'), '好呀。', 'whole, as the system voice gets it');
  // A blank line ends a pair: two paragraphs are not one direction, each half goes on its own.
  assert.equal(speakableText('（她转过身\n\n轻声说）晚安。'), '晚安。');
  // What is not a direction stays.
  assert.equal(speakableText('1）先吃饭。2）再睡觉。'), '1）先吃饭。2）再睡觉。', 'list numbers');
  assert.equal(speakableText('步骤如下：1）先吃饭\n二）再睡觉'), '步骤如下：1）先吃饭\n二）再睡觉');
  assert.equal(speakableText('好的 :) 明天见'), '好的 :) 明天见', 'a half-width smiley is not a bracket');
  assert.equal(speakableText('有点难过 :('), '有点难过 :(');
});

test('the cloud voice gets the words without the stage direction; a direction-only segment never reaches it', async () => {
  const texts: string[] = [];
  const synthesize: SpeechSynthesizer = async (_config, text, _signal, emit) => { texts.push(text); await emit({ type: 'done', firstAudioMs: 1, audioBytes: 2 }); };
  const config = (): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://fixture.example', region: 'r', apiKey: 'fixture-key' });
  const events: unknown[] = [];
  const runtime = new SpeechRuntime(config, (_owner, event) => events.push(event), synthesize);
  await runtime.speak(3, 'seg-1', '（把脸埋低）……谢谢你。');
  assert.deepEqual(texts, ['……谢谢你。']);
  await assert.rejects(runtime.speak(3, 'seg-2', '（把脸埋低）'), /只有动作描写/u);
  assert.equal(texts.length, 1);
});

test('perception: the old candidate line is gone; a turn with a frame now gets the 细看 line (tests/image-depth-step1.test.ts)', () => {
  const look = perceptionTurnLine({ screen: true, camera: 'off', attached: { screen: true, camera: false }, asked: 'screen' });
  assert.match(look, /^【此刻的感知】用户叫你看屏幕，本轮附了画面。/u);
  assert.doesNotMatch(look, /你看得到|此刻你能看到/u, 'never the wording that made her talk about the screen in 10 of 10 replies');
  // The fixed rule's second half is what the turn line fulfils: content only counts as seen when a turn carries the frame
  // (I-017 kept it unchanged after two slower rewordings; hearing itself is the turn line's).
  assert.match(PERCEPTION_RULE, /只有某一轮明确附上了画面或声音资料，才算你看到、听到了/u);
});
