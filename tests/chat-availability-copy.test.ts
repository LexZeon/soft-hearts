import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '../shared/ui-language';
import { CLAUDE_FAILURE_KINDS } from '../shared/claude-failure';
import { ENGLISH_UI_COPY } from '../shared/ui-copy.en';
import { ENGLISH_OUTAGE_UI_COPY } from '../shared/ui-copy.outage.en';
import { OUTAGE_LINE_KINDS, describeOutage, formatResumeTime, genericOutageLine, outageDisplayText } from '../shared/chat-availability';

afterEach(() => setUiLanguage('zh-CN'));
const NOW = Date.UTC(2026, 10, 2, 18, 0); // 02:00 on Nov 3 in Shanghai
const SH = 'Asia/Shanghai';
const hasChinese = (text: string) => /[一-鿿]/.test(text);

test('what the chat window shows: her line once, nothing for a repeat, and the ordinary path for everything else', () => {
  assert.equal(outageDisplayText({ kind: 'quota', speak: true, line: '  我今天说太多话啦。 ' }), '我今天说太多话啦。');
  assert.equal(outageDisplayText({ kind: 'quota', speak: false, line: null }), '');
  assert.equal(outageDisplayText({ kind: 'quota', speak: false, line: '不该出现' }), '');
  assert.equal(outageDisplayText({ kind: 'network', speak: true, line: null }), genericOutageLine('network'));
  assert.equal(outageDisplayText({ kind: 'network', speak: true, line: 'x'.repeat(201) }), genericOutageLine('network'), 'an oversized line is not shown');
  assert.equal(outageDisplayText({ kind: 'network', speak: true, line: '   ' }), genericOutageLine('network'));
  for (const bad of [undefined, null, 'oops', 3, {}, { kind: 'nonsense', speak: true, line: 'x' }, { kind: 7, speak: true }])
    assert.equal(outageDisplayText(bad), null, JSON.stringify(bad));
});

test('every kind has a gentle generic sentence with no technical words, in both languages', () => {
  const technical = /claude|api|token|http|error|server|\d/i;
  for (const kind of OUTAGE_LINE_KINDS) {
    setUiLanguage('zh-CN');
    const zh = genericOutageLine(kind);
    assert.ok(zh.length >= 4 && zh.length <= 60 && !technical.test(zh), kind);
    setUiLanguage('en');
    const en = genericOutageLine(kind);
    assert.ok(!hasChinese(en) && en.length > 5 && !technical.test(en), `${kind}: ${en}`);
  }
});

test('the reset time is told in the machine\'s own clock: today, tomorrow, or a date', () => {
  assert.equal(formatResumeTime(Date.UTC(2026, 10, 3, 5, 20), NOW, SH), '13:20');
  assert.equal(formatResumeTime(Date.UTC(2026, 10, 3, 21, 20), NOW, SH), '明天 05:20');
  assert.equal(formatResumeTime(Date.UTC(2026, 10, 5, 7, 0), NOW, SH), '11月5日 15:00');
  assert.equal(formatResumeTime(Date.UTC(2026, 10, 3, 5, 20), NOW, 'America/Los_Angeles'), '21:20', 'the same instant on a Los Angeles clock, still today there');
  setUiLanguage('en');
  assert.equal(formatResumeTime(Date.UTC(2026, 10, 3, 21, 20), NOW, SH), 'tomorrow 05:20');
  assert.equal(formatResumeTime(Date.UTC(2026, 10, 5, 7, 0), NOW, SH), 'Nov 5 15:00');
});

test('plain-language status: a reason, what to do, and the expected time when it was read', () => {
  const quota = describeOutage({ kind: 'quota', resumeAt: Date.UTC(2026, 10, 3, 5, 20) }, NOW, SH);
  assert.equal(quota.reason, 'Claude 的使用额度暂时用完了');
  assert.equal(quota.hint, '预计 13:20 恢复。');
  assert.deepEqual(quota.actions, ['retry']);
  assert.match(describeOutage({ kind: 'quota' }, NOW, SH).hint, /没有读到恢复时间/);
  assert.match(describeOutage({ kind: 'quota', resumeAt: NOW - 1000 }, NOW, SH).hint, /已经过了预计的恢复时间/);
  assert.match(describeOutage({ kind: 'rate-limited', resumeAt: NOW + 30_000 }, NOW, SH).hint, /预计 .* 恢复/);
  assert.deepEqual(describeOutage({ kind: 'network' }).actions, ['retry', 'network-settings']);
  assert.deepEqual(describeOutage({ kind: 'login-expired' }).actions, ['retry', 'help']);
  assert.deepEqual(describeOutage({ kind: 'not-found' }).actions, ['retry', 'help']);
  const cert = describeOutage({ kind: 'certificate' });
  assert.deepEqual(cert.actions, ['retry', 'help']);
  assert.match(cert.reason, /安全连接被拦住/);
  assert.match(cert.hint, /不是断网/);
  assert.match(describeOutage({}).reason, /原因没认出来/);
  const reasons = new Set(CLAUDE_FAILURE_KINDS.map(kind => describeOutage({ kind }).reason));
  assert.equal(reasons.size, CLAUDE_FAILURE_KINDS.length, 'each kind says something different');
});

test('the English panel has no Chinese left, and the catalog is part of the app\'s English copy', () => {
  setUiLanguage('en');
  for (const kind of CLAUDE_FAILURE_KINDS) {
    for (const resumeAt of [undefined, NOW + 3_600_000, NOW - 5]) {
      const text = describeOutage({ kind, ...(resumeAt === undefined ? {} : { resumeAt }) }, NOW, SH);
      assert.ok(!hasChinese(text.reason) && !hasChinese(text.hint), `${kind}: ${text.reason} / ${text.hint}`);
    }
  }
  for (const [source, english] of Object.entries(ENGLISH_OUTAGE_UI_COPY)) {
    assert.equal(ENGLISH_UI_COPY[source], english, `${source} reaches the shared catalog unchanged`);
    assert.ok(!hasChinese(english), source);
  }
  assert.equal(ENGLISH_UI_COPY['重试'], 'Try again', 'the button reuses the app\'s existing "重试" wording');
  assert.equal(Object.hasOwn(ENGLISH_OUTAGE_UI_COPY, '重试'), false);
});
