import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReplySegments } from '../src/ui/reply-segments';

test('Chinese and Japanese prose is one sentence per paragraph with closing quotes', () => {
  assert.equal(formatReplySegments('今天很难。先歇一会！好吗？'), '今天很难。\n\n先歇一会！\n\n好吗？');
  assert.equal(formatReplySegments('「待って！」彼女は言った。「大丈夫。」'), '「待って！」\n\n彼女は言った。\n\n「大丈夫。」');
  assert.equal(formatReplySegments('他说：“我在。”你可以慢慢说。'), '他说：“我在。”\n\n你可以慢慢说。');
});

test('English sentences keep original spacing, punctuation runs and closing emphasis', () => {
  assert.equal(formatReplySegments('I hear you. We can take this slowly! Is that okay?'), 'I hear you. \n\nWe can take this slowly! \n\nIs that okay?');
  assert.equal(formatReplySegments('He asked, "Really?!" Yes. **It works.** Good.'), 'He asked, "Really?!" \n\nYes. \n\n**It works.** \n\nGood.');
  assert.equal(formatReplySegments('先歇会。**再继续。** 好。'), '先歇会。\n\n**再继续。** \n\n好。');
});

test('decimals, common abbreviations, initials, URLs and pauses do not create false sentences', () => {
  const source = 'Dr. A. Smith lives in the U.S. and measured 3.14. See https://example.test/a?x=1.2 and v1.2. It works... perhaps. Okay.';
  assert.equal(formatReplySegments(source), 'Dr. A. Smith lives in the U.S. and measured 3.14. \n\nSee https://example.test/a?x=1.2 and v1.2. \n\nIt works... perhaps. \n\nOkay.');
  assert.equal(formatReplySegments('我想……也许可以。试试看。'), '我想……也许可以。\n\n试试看。');
});

test('backtick and tilde fences remain byte exact, including shorter nested runs and incomplete code', () => {
  for (const code of [
    '```ts\nconst value = "First. Second。";\n```',
    '~~~~python\nprint("A. B。")\n~~~\n~~~~',
    '```\nunfinished. code。',
    '  ```json\r\n{"message":"A. B。"}\r\n  ```',
  ]) assert.equal(formatReplySegments(code), code);
  const source = 'First. Second.\n```ts\nA. B。\n```\n第三句。第四句。';
  assert.equal(formatReplySegments(source), 'First. \n\nSecond.\n```ts\nA. B。\n```\n第三句。\n\n第四句。');
});

test('inline code, escaped punctuation, Markdown links and angle syntax are protected', () => {
  const source = 'Use `a. b。` first. Then ``c`d. e。``. Read [A. B。](https://a.test/x "A. B") here. Done.';
  assert.equal(formatReplySegments(source), 'Use `a. b。` first. \n\nThen ``c`d. e。``. \n\nRead [A. B。](https://a.test/x "A. B") here. \n\nDone.');
  assert.equal(formatReplySegments('Text <a title="A. B。">tag</a>. Next.'), 'Text <a title="A. B。">tag</a>. \n\nNext.');
  assert.equal(formatReplySegments('A\\。B。C'), 'A\\。B。\n\nC');
  assert.equal(formatReplySegments('`unfinished. code。'), '`unfinished. code。');
  assert.equal(formatReplySegments('Use `first.\nsecond。line` then. Next.'), 'Use `first.\nsecond。line` then. \n\nNext.');
  assert.equal(formatReplySegments('Read [first.\nsecond。line](https://a.test) now. Next.'), 'Read [first.\nsecond。line](https://a.test) now. \n\nNext.');
  assert.equal(formatReplySegments('Use `a\\` now. Next.'), 'Use `a\\` now. \n\nNext.', 'backslash is literal inside a code span');
  assert.equal(formatReplySegments('`unfinished.\n\nNormal. Next.'), '`unfinished.\n\nNormal. \n\nNext.', 'a blank line ends the containing paragraph');
});

test('lists, list continuation, headings, tables, quotes, logs and indented code retain structure', () => {
  const source = '# Title. More。\n\n- First. Same item。\n  continuation. Same。\n- Second. Same。\n\n1. Item. Same。\n\n| A. B | C。D |\n| --- | --- |\n\n> Quote. Same。\n\nTitle. Same。\n---\n\n[INFO] x. y。\n2026-10-26T10:20:30Z Something. More。\nERROR Something. More。\n    const x = "A. B。";\n\nNormal. Again。';
  assert.equal(formatReplySegments(source), source.replace('Normal. Again。', 'Normal. \n\nAgain。'));
  for (const list of ['1、第一项。继续。', '（1）第一项。继续。', '一、第一项。继续。']) assert.equal(formatReplySegments(list), list);
  assert.equal(formatReplySegments('> Quote. Same。\nLazy continuation. Same。'), '> Quote. Same。\nLazy continuation. Same。');
});

test('existing whitespace, CRLF and paragraphs are preserved without trailing separators', () => {
  assert.equal(formatReplySegments('One.\r\nTwo.\r\n\r\n三。四。\t五。'), 'One.\r\nTwo.\r\n\r\n三。\n\n四。\t\n\n五。');
  for (const source of ['', '   ', 'First', 'First.', 'First. ', '你好。', 'Hello...']) assert.equal(formatReplySegments(source), source);
});

test('all cumulative chunk boundaries preserve every source character and never hold partial text', () => {
  const samples = [
    '今天很难。先休息。',
    'Dr. A. Smith measured 3.14. Next sentence.',
    'He said, "Really?!" Yes.',
    'Code `a. b。` then. More.',
    '````ts\nA. B。\n```\n````\nHello. Again.',
    'https://example.test/a?x=1.2。继续。',
    '「大丈夫。」ありがとう。',
  ];
  for (const sample of samples) {
    for (let end = 0; end <= sample.length; end++) {
      const partial = sample.slice(0, end);
      const formatted = formatReplySegments(partial);
      // Source fixtures contain no blank lines: stripping only inserted blank
      // lines exactly recovers each prefix, even inside a UTF-16 code point.
      assert.equal(formatted.replaceAll('\n\n', ''), partial);
    }
  }
});

test('new replies and cancellation retain no queued sentence or old context', () => {
  assert.equal(formatReplySegments('Old. Reply.'), 'Old. \n\nReply.');
  assert.equal(formatReplySegments(''), '');
  assert.equal(formatReplySegments('New reply'), 'New reply');
  assert.equal(formatReplySegments('新句。下一句。'), '新句。\n\n下一句。');
});

test('long prose and large structured replies retain the complete final text', () => {
  const prose = '这是完整的一句。'.repeat(12_000);
  const formatted = formatReplySegments(prose);
  assert.equal(formatted.replaceAll('\n\n', ''), prose);
  assert.equal(formatted.split('\n\n').length, 12_000);
  const code = '```log\n' + 'INFO a. b。\n'.repeat(12_000) + '```';
  assert.equal(formatReplySegments(code), code);
});
