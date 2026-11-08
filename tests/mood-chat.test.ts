import test from 'node:test';
import assert from 'node:assert/strict';
import { MoodReplyProtocol } from '../electron/mood-chat';
test('reply protocol strips metadata even when opening marker arrives one character per chunk', () => {
  let body = '';
  const protocol = new MoodReplyProtocol(text => { body += text; });
  const wire = `你好。\n${protocol.start}{"context":"support","delta":{"O":2},"confidence":0.9,"reason":"受到关心"}${protocol.end}`;
  for (const c of wire) protocol.push(c);
  const result = protocol.finish();
  assert.equal(body, '你好。'); assert.equal(result?.delta.O, 2);
  assert.ok(!body.includes('sh-state'));
});
test('malformed, low-confidence, oversized or cancelled appraisals do not change state', () => {
  for (const json of ['not json', '{"context":"offense","delta":{"C":99},"confidence":1}', '{"context":"positive","delta":{},"confidence":0.2}', 'x'.repeat(2500)]) {
    const protocol = new MoodReplyProtocol(() => {}); protocol.push(`正文${protocol.start}${json}${protocol.end}`);
    assert.equal(protocol.finish(), null);
  }
  const protocol = new MoodReplyProtocol(() => {}); protocol.push(`正文${protocol.start}{"context":"positive","delta":{"D":3},"confidence":1}${protocol.end}`);
  assert.equal(protocol.finish(false), null);
});
test('plain answers and partial natural markers preserve original text', () => {
  let body = ''; const protocol = new MoodReplyProtocol(text => { body += text; });
  protocol.push('普通回答 <sh-state-'); assert.equal(protocol.finish(), null); assert.equal(body, '普通回答 <sh-state-');
});
test('a protocol separator split away from both body and nonce never becomes original prose', () => {
  let body = ''; const protocol = new MoodReplyProtocol(text => { body += text; });
  for (const chunk of ['第一行\n第二行', '\n', protocol.start.slice(0, 12), protocol.start.slice(12), '{"context":"neutral","delta":{},"confidence":1}', protocol.end]) protocol.push(chunk);
  assert.ok(protocol.finish()); assert.equal(body, '第一行\n第二行');
  let natural = ''; const plain = new MoodReplyProtocol(text => { natural += text; });
  plain.push('保留正文\n'); plain.finish(); assert.equal(natural, '保留正文\n');
});

test('gesture is an optional strict intent with a safe legacy default, never a resource capability', () => {
  const parse = (extra: Record<string, unknown> = {}) => {
    let body = ''; const protocol = new MoodReplyProtocol(text => { body += text; });
    protocol.push(`说明正文。\n${protocol.start}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.75, ...extra })}${protocol.end}`);
    const result = protocol.finish(); assert.equal(body, '说明正文。'); return result;
  };
  assert.equal(parse()?.gesture, 'none');
  for (const gesture of ['none', 'explain', 'upbeat', 'consider']) assert.equal(parse({ gesture })?.gesture, gesture);
  for (const gesture of ['dance', '../other.vmd', 'https://example.test/motion.vmd', null, 1, { intent: 'explain' }, ['explain']])
    assert.equal(parse({ gesture }), null);
  for (const key of ['path', 'url', 'packId', 'motionId', 'tools', 'permissions', '__proto__'])
    assert.equal(parse({ [key]: 'injected capability' }), null);
});

test('gesture does not relax confidence or bounded delta validation and need not invent an inner reward', () => {
  const parse = (extra: Record<string, unknown>) => {
    const protocol = new MoodReplyProtocol(() => {});
    protocol.push(`${protocol.start}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.9, gesture: 'upbeat', ...extra })}${protocol.end}`);
    return protocol.finish();
  };
  assert.deepEqual(parse({})?.delta, {});
  assert.deepEqual(parse({ delta: { D: 6, C: -6 } })?.delta, { D: 6, C: -6 });
  for (const confidence of [0.7499, 1.0001, null, '0.9']) assert.equal(parse({ confidence }), null);
  for (const delta of [{ D: 6.001 }, { C: -6.001 }, { path: 1 }, [], null]) assert.equal(parse({ delta }), null);
  const instruction = new MoodReplyProtocol(() => {}).instruction();
  assert.match(instruction, /工作烦恼.*concern和consider.*不能误用offense/);
  assert.match(instruction, /不能因此伪造快乐delta/);
  assert.match(instruction, /不要调用任何工具/);
});

test('R28: the instruction states the real confidence gate, so a model does not lose its tail by writing 0.7', () => {
  const instruction = new MoodReplyProtocol(() => {}).instruction();
  assert.match(instruction, /低于0\.75的尾注会被整条忽略/);
  assert.match(instruction, /拿不准时用neutral和空delta/);
  assert.doesNotMatch(instruction, /置信度0到1。/);
  // The gate itself is unchanged.
  const protocol = new MoodReplyProtocol(() => {});
  protocol.push(`好呀。\n${protocol.start}{"context":"positive","delta":{"D":1},"confidence":0.7}${protocol.end}`);
  assert.equal(protocol.finish(), null);
});

test('R28: a leading run of <br> is dropped from the reply, in any chunking; later <br> and ordinary starts are kept', () => {
  const run = (chunks: string[], options?: ConstructorParameters<typeof MoodReplyProtocol>[1]) => {
    let body = ''; const protocol = new MoodReplyProtocol(text => { body += text; }, options);
    for (const chunk of chunks) protocol.push(chunk.replaceAll('START', protocol.start).replaceAll('END', protocol.end));
    const appraisal = protocol.finish();
    return { body, appraisal };
  };
  const tailJson = '{"context":"positive","delta":{},"confidence":0.9}';
  for (const options of [undefined, { settingProposal: { instruction: null } }]) {
    const whole = run(['<br>欢迎回来！<br>这里的不动。\nSTART' + tailJson + 'END'], options);
    assert.equal(whole.body, '欢迎回来！<br>这里的不动。');
    assert.equal(whole.appraisal?.context, 'positive');
    assert.equal(run([...'<br>\n欢迎回来！<br>这里的不动。\n', 'START', tailJson, 'END'], options).body, '欢迎回来！<br>这里的不动。');
    assert.equal(run(['<BR/>\n', '<br />  ', '<b', 'r>你好'], options).body, '你好');
    assert.equal(run(['<br>\n<br>\n<br>'], options).body, '', 'nothing but breaks shows nothing');
    assert.equal(run(['<br>', 'START' + tailJson + 'END'], options).appraisal?.context, 'positive');
  }
  // No leading break: bytes are exactly as before, including leading blanks and other tags.
  assert.equal(run(['  你好']).body, '  你好');
  assert.equal(run(['<b>粗</b>体']).body, '<b>粗</b>体');
  assert.equal(run(['<', 'bo', 'x>']).body, '<box>');
  assert.equal(run(['<b']).body, '<b');
  assert.equal(run(['普通回答 <sh-state-']).body, '普通回答 <sh-state-');
});
