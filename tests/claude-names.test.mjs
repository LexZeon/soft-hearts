// I-217: every place the app says "Claude" is marked, and the visible name comes from one place (shared/foundation/assistant-name.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkClaudeNames, readAllowlist, scanClaudeNameLiterals } from '../scripts/dev/claude-names-scan.mjs';
import { ASSISTANT_CLI_NAME, ASSISTANT_NAME, applyAssistantNames, setShownAssistantNamesForTest } from '../shared/foundation/assistant-name';
import { uiMarkup } from '../src/foundation/ui-language';
import { setUiLanguage, t } from '../shared/foundation/ui-language';
import { describeOutage } from '../shared/brain/chat-availability';

test('on this build the name is Claude and the screen text is byte for byte what it was', () => {
  assert.equal(ASSISTANT_NAME, 'Claude');
  assert.equal(ASSISTANT_CLI_NAME, 'Claude Code');
  const sample = '你自己的 Claude，Claude Code 和「Claude 助手」；由 Claude 操作。';
  assert.equal(applyAssistantNames(sample), sample);
  try {
    setUiLanguage('zh-CN');
    assert.equal(t('Claude 助手'), 'Claude 助手');
    assert.equal(t('由 Claude 操作：{0}', { 0: 'x' }), '由 Claude 操作：x');
    setUiLanguage('en');
    assert.equal(t('Claude 助手'), 'Claude assistant');
  } finally { setUiLanguage('zh-CN'); }
});

test('changing the two names changes every place that carries them, and nothing that only looks like them', () => {
  const sample = '你自己的 Claude，Claude Code 和「Claude 助手」；Claudette 和 claude 命令不动。';
  assert.equal(applyAssistantNames(sample, 'Aria', 'Aria Shell'), '你自己的 Aria，Aria Shell 和「Aria 助手」；Claudette 和 claude 命令不动。');
  // the replacement text is taken literally ($& and friends mean nothing)
  assert.equal(applyAssistantNames('Claude', '$&x', 'y'), '$&x');
});

test('t() and the window markup put the configured name into the screen text, zh and en, and leave user text alone', () => {
  try {
    setShownAssistantNamesForTest('Aria', 'Aria Shell');
    setUiLanguage('zh-CN');
    assert.equal(t('Claude 助手'), 'Aria 助手');
    assert.equal(t('你的 Claude Code：{0}', { 0: 'Claude 说了话' }), '你的 Aria Shell：Claude 说了话');
    assert.equal(uiMarkup('<b>由 Claude 操作</b>'), '<b>由 Aria 操作</b>');
    setUiLanguage('en');
    assert.equal(t('Claude 助手'), 'Aria assistant');
  } finally { setShownAssistantNamesForTest(); setUiLanguage('zh-CN'); }
  assert.equal(t('Claude 助手'), 'Claude 助手');
});

test('host messages built from the constants carry the same words as before', () => {
  assert.equal(describeOutage({ kind: 'not-found' }).reason, '找不到 Claude Code');
  assert.equal(describeOutage({ kind: 'quota' }).reason, 'Claude 的使用额度暂时用完了');
});

test('no string names Claude directly outside the list (scripts/dev/claude-names-allowlist.json)', () => {
  const { failures, stale } = checkClaudeNames(scanClaudeNameLiterals(), readAllowlist());
  assert.deepEqual(failures, []);
  assert.deepEqual(stale, [], 'a listed file needs fewer strings now: run node scripts/dev/claude-names-scan.mjs --write');
});

test('every listed file says why and has a known class', () => {
  const known = new Set(['t-dictionary', 't-window', 't-call', 'prompt', 'matching', 'worker-code', 'history', 'name-source']);
  for (const [file, entry] of Object.entries(readAllowlist().files)) {
    assert.ok(known.has(entry.class), `${file}: class ${entry.class}`);
    assert.ok(typeof entry.why === 'string' && entry.why.length > 10, `${file}: why`);
  }
});

test('the guard fires on a new hard-coded name', () => {
  const counts = new Map([['electron/brain/new-notice.ts', 1], ['src/safety/AssistantPanel.ts', 99]]);
  const { failures } = checkClaudeNames(counts, readAllowlist());
  assert.equal(failures.length, 2);
  assert.match(failures[0], /new-notice\.ts/);
});
