// "UTF-8 read as GBK" garbage in her reply (shared/mojibake.ts, docs/claude/2026-11-03-mojibake-guard.md).
// On 2026-11-03 a reply came back with runs like "鍙戠敓浜嗕粈涔" and "锛屾垜". The garbled samples below are made the way such
// text is made (UTF-8 bytes decoded as GBK); the ordinary samples are written for this test (no recorded chat is used).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MojibakeGuard, canStartMojibake, cleanMojibake } from '../shared/mojibake';
import { MoodReplyProtocol } from '../electron/mood-chat';

const garble = (text: string): string => new TextDecoder('gbk').decode(Buffer.from(text, 'utf8'));

/** Whole, one character at a time, three at a time, and seeded random sizes. */
function chunkings(text: string): string[][] {
  const chars = [...text];
  const pieces = (size: (n: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < chars.length; n++) { const k = Math.max(1, size(n)); out.push(chars.slice(i, i + k).join('')); i += k; } return out; };
  let seed = 4242;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 6)), pieces(() => 1 + Math.floor(random() * 20))];
}
function stream(chunks: string[]): { out: string; increments: string[]; guard: MojibakeGuard } {
  const guard = new MojibakeGuard();
  const increments: string[] = [];
  for (const chunk of chunks) increments.push(guard.push(chunk));
  increments.push(guard.finish());
  return { out: increments.join(''), increments, guard };
}

// ------------------------------------------------------------------ ordinary text must pass byte for byte

const ORDINARY: string[] = [
  // everyday replies
  '嗯……你回来啦，今天累不累？', '诶？真的吗！那也太厉害了吧～', '好呀，那我们晚上一起看那部电影。', '唔，我刚刚走神了，你再说一遍好不好？',
  '别熬夜啦，明天还要早起呢。', '哼，才不是因为想你才一直等着的。', '喔～原来是这样，我懂了。', '呃，这个问题我也不太确定欸。',
  '你先去吃饭，吃完再来找我，我就在这儿。', '面试没过不是你的问题，是他们没眼光。', '下雨了记得带伞，别又淋湿了。', '嘿嘿，被我猜中了吧！',
  '我愣了一下，然后忍不住笑出声。', '今天的风好舒服，好惬意啊。', '你说的那个地方，我一直很憧憬。', '看你这几天憔悴了不少，心疼。',
  '我刚才在浏览你推荐的那篇文章。', '这种怅惘的感觉，我也有过。', '一想到那个画面就毛骨悚然。', '他那么悭吝，你别跟他计较。',
  '嗯，第3次了，今天到底怎么回事？', '我在！你说。', '晚安，做个好梦 🌙', '❤️ 收到啦～', '（揉了揉眼睛）唔……几点了？', '*悄悄凑过来* 在干嘛呀？',
  // old-style names, poems, rare characters
  '但愿人长久，千里共婵娟。', '涓涓细流，汇成江海。', '浩瀚星河，皆不及你眼中的光。', '寤寐思服，辗转反侧。', '所谓伊人，在水一方。',
  '蒹葭苍苍，白露为霜。', '宸妃抚琴，姗姗来迟。', '姝丽的妆容配上妖娆的步态。', '濯清涟而不妖。', '澹澹水面，渚清沙白鸟飞回。',
  '浣溪沙·一曲新词酒一杯', '灏气横秋，瀛洲在望。', '宓妃留枕魏王才。', '甯、骞、搴、褰、蹇都是不常见的字。', '妯娌之间要和睦。',
  '饕餮、魑魅魍魉、耄耋之年、龃龉、觊觎、囹圄', '小满·冯·温特斯', '她叫洛琪希，住在瀛海之滨。', '孑孓、虺蜴、鼋鼍、鳏寡孤独',
  // Traditional Chinese
  '我們今天去哪裡玩？說好的電影還看嗎？', '這個問題讓我想了很久，還是覺得你說得對。', '謝謝你一直陪著我，真的很開心。', '飛鳥與魚，終究隔著一片海。',
  // Japanese
  'こんにちは、今日はいい天気ですね。', 'お疲れ様です！ゆっくり休んでくださいね。', '大丈夫だよ、私がそばにいるから。', 'カタカナとひらがなの練習。',
  // code, English, mixed
  'const 名字 = "小满"; console.log(`你好，${名字}`);', 'git commit -m "修复：乱码检测"', 'Good night! 早点睡哦。', 'OK，我记住了：明天 9:30 开会。',
  'function f(x) { return x * 2; } // 乘以二', 'C:\\Users\\文档\\新建文件夹', '价格是 €5 或者 ￥40。', '温度 30°C，湿度 ±5%。',
  '¥€£ © ® ™ ° ± × ÷', '“引号”‘单引号’——破折号……省略号', '【重要】《三体》「好书」『推荐』', '①②③ ⅠⅡⅢ ㈠㈡ ㊣',
  '😀😃😄😁😆 🐱🐶', '這是 Traditional，这是 Simplified，これは日本語。', '?', '？？？', '……', '',
];

test('ordinary text passes byte for byte, however it is chunked', () => {
  for (const text of ORDINARY) {
    assert.equal(cleanMojibake(text).text, text, JSON.stringify(text));
    for (const chunks of chunkings(text)) {
      const played = stream(chunks);
      assert.equal(played.out, text, JSON.stringify({ text, chunks }));
      assert.equal(played.guard.changed(), false, JSON.stringify(text));
    }
  }
});

test('the ordinary samples include characters that can begin a garbled run (so the test above means something)', () => {
  const starts = new Set(ORDINARY.flatMap(text => [...text].filter(canStartMojibake)));
  assert.ok(starts.size >= 30, `only ${starts.size}: ${[...starts].join('')}`);
});

test('first character: an ordinary reply is never held; a character that can begin a garbled run waits only for the next one', () => {
  for (const text of ORDINARY) {
    const chars = [...text];
    if (!chars.length) continue;
    const guard = new MojibakeGuard();
    const first = guard.push(chars[0]);
    if (!canStartMojibake(chars[0])) assert.equal(first, chars[0], JSON.stringify(text));
    // Character by character, never more than one character is waiting at any time.
    let waiting = first ? 0 : 1;
    for (const char of chars.slice(1)) {
      waiting += 1 - [...guard.push(char)].length;
      assert.ok(waiting <= 1, JSON.stringify(text));
    }
  }
  // None of the everyday openers can begin a garbled run.
  for (const opener of '嗯唔诶喔哦呃哼嘿哈啊呀好你我在欸噢嗷嘻呐哇'.split('')) assert.equal(canStartMojibake(opener), false, opener);
});

// ------------------------------------------------------------------ garbled text is repaired, or dropped

const REPLIES: string[] = [
  '发生了什么事？我看看。', '你好呀，今天过得怎么样？我一直在等你呢。', '面试没过不是你的问题，是他们没眼光。', '嗯……你回来啦，今天累不累？',
  '下雨了记得带伞，别又淋湿了。', '这个界面、角色和人设都是我们自己的。', '好的，我记住了，明天提醒你。', '我一直都在这里陪着你，别怕。',
  '但愿人长久，千里共婵娟。', '我們今天去哪裡玩？', '晚安，做个好梦 🌙', '一想到明天就要见到你，就开心得睡不着。',
];

/** The original with what the garbling itself lost (a byte before a line end or an ASCII mark) taken out: what can come back. */
function recoverable(original: string, repaired: string): boolean {
  // Everything repaired is in the original, in order, and at most one character per lost byte is missing.
  const out = [...repaired];
  let i = 0;
  for (const char of original) if (i < out.length && out[i] === char) i++;
  return i === out.length && [...original].length - out.length <= 2;
}

test('a garbled reply is repaired: what it says comes back, nothing garbled is left', () => {
  for (const original of REPLIES) {
    const garbled = garble(original);
    assert.notEqual(garbled, original);
    for (const chunks of chunkings(garbled)) {
      const played = stream(chunks);
      assert.ok(recoverable(original, played.out), JSON.stringify({ original, garbled, out: played.out }));
      assert.ok(played.out.length > 0);
      assert.ok(played.guard.counts.repaired >= 1);
      for (const char of played.out) assert.ok(original.includes(char), `${JSON.stringify(char)} in ${JSON.stringify(played.out)}`);
    }
  }
});

test('the shapes from 2026-11-03 are undone', () => {
  assert.equal(cleanMojibake('鍙戠敓浜嗕粈涔').text, '发生了什'); // the last character lost its final byte: it goes, not shown half
  assert.equal(cleanMojibake('锛屾垜').text, '，我');
  assert.equal(cleanMojibake(garble('发生了什么事？我看看。')).text, '发生了什么事？我看看'); // "銆" + a lost byte: the "。" goes
  // "€" stands for the byte 0x80 and for the pair A2 E3: "呢" is not read as "呀".
  assert.equal(cleanMojibake(garble('我一直在等你呢。')).text, '我一直在等你呢');
  assert.equal(cleanMojibake(garble('界面、角色')).text, '界面、角');
});

test('streaming: not one garbled character reaches the output, not even the first', () => {
  for (const original of REPLIES) {
    const garbled = garble(original);
    const foreign = [...garbled].filter(char => !original.includes(char));
    for (const chunks of chunkings(garbled)) {
      const { increments } = stream(chunks);
      for (const piece of increments) for (const char of piece) assert.ok(!foreign.includes(char), `${JSON.stringify(char)} leaked from ${JSON.stringify(garbled)}`);
    }
    // The very first push of a garbled reply shows nothing of it.
    const guard = new MojibakeGuard();
    assert.equal(guard.push([...garbled][0]), '');
  }
});

test('garbage mixed into an ordinary reply: the ordinary part passes, the garbled part is repaired', () => {
  const text = `好呀！${garble('你屏幕上写的是发生了什么事')}\n不过我也不太确定。`;
  assert.equal(cleanMojibake(text).text, '好呀！你屏幕上写的是发生了什么事\n不过我也不太确定。');
  const mixed = `我看到了：${garble('今天天气很好')}，${garble('我们出去走走吧')}`;
  const out = cleanMojibake(mixed).text;
  assert.ok(out.startsWith('我看到了：今天天气很'), out);
  assert.ok(out.includes('我们出去走走'), out);
});

test('what cannot be decoded is dropped: a lone cut-off character and the decoder\'s replacement mark never show', () => {
  // "写 " garbled: the byte before the blank is lost, leaving one start and a replacement mark.
  assert.equal(cleanMojibake(garble('写 ')).text, ' ');
  // A reply that is nothing but undecodable pieces comes out empty (the host then fails it like any emptied reply).
  const result = cleanMojibake('鍐\ufffd 寮\ufffd');
  assert.equal(result.text.trim(), '');
  assert.ok(result.counts.dropped >= 4);
});

test('a long garbled run is decided within a few characters, it is not held to the end of the line', () => {
  const original = '我一直都在这里陪着你，别怕，有我呢，慢慢来就好。';
  const guard = new MojibakeGuard();
  let shownAt = -1, shown = '';
  [...garble(original)].forEach((char, index) => { const out = guard.push(char); if (shownAt < 0 && out) { shownAt = index; shown = out; } });
  assert.ok(shownAt >= 0 && shownAt <= 3, `first repaired text after ${shownAt + 1} garbled characters`);
  assert.ok(original.startsWith(shown), `first text shown: ${JSON.stringify(shown)}`);
});

// ------------------------------------------------------------------ in the reply protocol, with the draft filter

test('in the reply protocol: a garbled reply is repaired before the draft filter, and the state tail still works', () => {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
  const tail = `\n${protocol.start}{"context":"support","delta":{"O":1},"reason":"用户愣了一下","confidence":0.9}${protocol.end}`;
  for (const chunk of chunkings(garble('面试没过不是你的问题，是他们没眼光。') + tail)[3]) protocol.push(chunk);
  const appraisal = protocol.finish();
  assert.equal(increments.join(''), '面试没过不是你的问题，是他们没眼光');
  assert.equal(appraisal?.context, 'support');
  assert.equal(appraisal?.reason, '用户愣了一下');
  assert.equal(protocol.emptiedByFilter(), false);
  assert.deepEqual(protocol.draftDrops().map(drop => drop.kind), ['mojibake']);
});

test('in the reply protocol: a start character held at the end of the visible text goes to the tail unchanged', () => {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text));
  protocol.push('我愣了一下。');
  protocol.push(`\n${protocol.start}{"context":"neutral","delta":{},"reason":"她愣`);
  protocol.push(`了","confidence":0.9}${protocol.end}`);
  const appraisal = protocol.finish();
  assert.equal(increments.join(''), '我愣了一下。');
  assert.equal(appraisal?.reason, '她愣了');
  assert.deepEqual(protocol.draftDrops(), []);
});

test('in the reply protocol: a reply that is nothing but undecodable garbage is an emptied reply', () => {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text));
  protocol.push('鍐\ufffd寮\ufffd');
  protocol.finish();
  assert.equal(increments.join(''), '');
  assert.equal(protocol.emptiedByFilter(), true);
});
