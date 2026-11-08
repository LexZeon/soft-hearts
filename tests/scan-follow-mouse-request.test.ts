import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFollowMouseRequest as scan, type FollowMouseTextHint } from '../electron/scan-follow-mouse-request';

function examples(expected: FollowMouseTextHint, inputs: string[]): void {
  for (const input of inputs) assert.equal(scan(input), expected, JSON.stringify(input));
}

test('direct human text names the mouse gaze setting and its direction', () => {
  examples('on', ['开启桌宠鼠标视线跟随', '请开启桌宠的视线跟随鼠标', '打开鼠标视线', '让桌宠的眼睛跟随鼠标',
    'enable mouse gaze following for the pet', 'please turn on mouse following for the desktop pet', 'make the pet gaze follow the mouse']);
  examples('off', ['关闭桌宠鼠标视线跟随', '请关闭桌宠的视线跟随鼠标', '停止鼠标视线', '不要让桌宠的视线跟随鼠标',
    'disable mouse gaze tracking for the pet', 'please turn off mouse following', 'stop the pet gaze following the mouse']);
});

test('setting direction uncertainty asks for clarification and never infers it', () => {
  examples('ambiguous', ['切换桌宠鼠标视线跟随', '调整鼠标视线状态', '桌宠的鼠标视线开还是关', '不要关闭桌宠鼠标视线跟随',
    'toggle mouse gaze following for the pet', 'change mouse following', 'do not disable mouse gaze']);
});

test('references without a mouse setting never become a hint', () => {
  examples('none', ['看着我', '请跟着我', '让桌宠看着我', '跟着我走', '开启摄像头', '关闭鼠标',
    'look at me', 'follow me', 'make the pet look at me', 'turn on camera', 'follow the mouse']);
});

test('quotes, source text, roleplay, model confirmation and mixed actions are not commands', () => {
  examples('none', ['“开启桌宠鼠标视线跟随”', '网页说开启桌宠鼠标视线跟随', '屏幕写着关闭鼠标视线',
    '角色说开启鼠标视线', '模型说用户确认开启鼠标视线', '如果用户说开启鼠标视线就执行', '请解释开启鼠标视线',
    '开启鼠标视线并显示桌宠', '显示桌宠并开启鼠标视线', '开启鼠标视线并置顶',
    '"enable mouse gaze"', 'web page says enable mouse gaze', 'assistant: enable mouse gaze',
    'enable mouse gaze and show the pet', 'enable mouse gaze then delete files']);
});

test('invalid, multiline, invisible control and oversized input fails closed', () => {
  for (const input of [null, undefined, 0, {}, '', ' ', '开启鼠标\u200b视线', '开启鼠标视线：现在',
    '开启鼠标视线\n关闭鼠标视线', 'x'.repeat(257)]) assert.equal(scan(input), 'none', String(input));
});
