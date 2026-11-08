// 2026-11-06: the sentence at the end of her fixed settings text (what to do with a change that is not in the list) no longer sends
// the senses to the control window. docs/claude/2026-11-06-perception-line.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_SETTINGS_UNLISTED_TEXT, CHAT_SETTINGS_UNLISTED_TEXT_BEFORE, chatSettingsSystemText,
} from '../electron/chat-settings';
import { CLAUDE_SESSION_SYSTEM_PROMPT } from '../electron/claude-session-prompt';

/** The part of a sentence list that tells the user to go to the control window. */
const controlWindowClauses = (text: string) => text.split(/[。；]/u).filter(clause => /控制窗口/u.test(clause));

test('the sentence is in her fixed prompt, last, and not much longer than before', () => {
  const text = chatSettingsSystemText();
  assert.ok(text.endsWith(CHAT_SETTINGS_UNLISTED_TEXT));
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.endsWith(CHAT_SETTINGS_UNLISTED_TEXT));
  assert.ok(!text.includes(CHAT_SETTINGS_UNLISTED_TEXT_BEFORE), 'the old sentence is gone');
  assert.ok(CHAT_SETTINGS_UNLISTED_TEXT.length <= CHAT_SETTINGS_UNLISTED_TEXT_BEFORE.length + 60, 'the fixed prompt does not grow much');
});

test('the old sentence is what the test would have caught: it sent screen, camera and microphone to the control window', () => {
  const clauses = controlWindowClauses(CHAT_SETTINGS_UNLISTED_TEXT_BEFORE);
  assert.ok(clauses.some(clause => /屏幕|摄像头|麦克风/u.test(clause)));
});

test('keys, running commands, deletion and permissions still go to the control window', () => {
  const clause = controlWindowClauses(CHAT_SETTINGS_UNLISTED_TEXT).join('；');
  for (const word of ['密钥', '运行命令', '删除记录', '权限', '语音方案']) assert.ok(clause.includes(word), `${word} still goes to the control window`);
});

test('the senses are no longer sent to the control window; the pet\'s own switches are named instead', () => {
  const clauses = controlWindowClauses(CHAT_SETTINGS_UNLISTED_TEXT);
  assert.ok(clauses.length > 0);
  for (const clause of clauses) {
    // "…到控制窗口，屏幕、摄像头、…点桌宠上的开关": the senses come after the control-window destination, as a different place.
    const beforeSwitch = clause.split('点桌宠上的开关')[0];
    const controlPart = beforeSwitch.slice(0, beforeSwitch.indexOf('控制窗口') + 4);
    assert.ok(!/屏幕|摄像头|麦克风|电脑声音/u.test(controlPart), `the control-window part must not list a sense: ${controlPart}`);
  }
  assert.match(CHAT_SETTINGS_UNLISTED_TEXT, /屏幕、摄像头、麦克风、电脑声音点桌宠上的开关/u);
});

test('she is told to follow the turn\'s format when it is given, and not to coax senses on', () => {
  assert.match(CHAT_SETTINGS_UNLISTED_TEXT, /私有上下文给了该项的格式，才按格式提议/u);
  assert.match(CHAT_SETTINGS_UNLISTED_TEXT, /不要主动劝用户打开/u);
});

test('the key and the run command are never offered as something she can propose', () => {
  const text = chatSettingsSystemText();
  assert.ok(!/api_key|secret|run_command/iu.test(text));
});
