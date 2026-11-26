// I-163: the places added to 「带我去」 and the sentences that reach them. Sentences are synthetic (the first three are the shape of what
// the user actually asked on 2026-11-19: the physics window, click-through mode, developer mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TAKE_ME_THERE, matchTakeMeThere, type TakeMeThereId } from '../shared/initiative/take-me-there';
import { TAKE_ME_THERE_PLACES } from '../shared/initiative/take-me-there-places';
import { takeMeThereLeaf } from '../src/initiative/TakeMeThere';
import { ControlNavigationState } from '../src/settings/control-navigation-state';

test('what the user asked for on 2026-11-19 now gets a page', () => {
  const cases: [string, TakeMeThereId][] = [
    ['你能带我去物理窗口吗？', 'physics-lab'],
    ['能带我去物理窗口么？', 'physics-lab'],
    ['能打开穿透模式吗？', 'companion-window'],
    ['帮我打开开发者模式', 'developer-mode'],
    ['开发者模式在哪？', 'developer-mode'],
  ];
  for (const [text, id] of cases) assert.equal(matchTakeMeThere(text), id, text);
});

test('every new feature has its place, said the way people say it', () => {
  const cases: [string, TakeMeThereId][] = [
    ['带我去物理调参台', 'physics-lab'], ['我想调一下果冻调参', 'physics-lab'], ['打开软体调参', 'physics-lab'],
    ['带我去碰了才软', 'touch-soft'], ['拉她的开关在哪', 'touch-soft'], ['打开碰了才软的开关', 'touch-soft'],
    ['让她出来的开关在哪里', 'unbound-entry'], ['带我去 Unbound 的开关', 'unbound-entry'], ['带我去还在试用的功能', 'trial-features'],
    ['带我去只认你的声音', 'voiceprint'], ['打开声纹设置', 'voiceprint'], ['只认我的声音在哪里设置', 'voiceprint'],
    ['带我去称呼表', 'user-profile'], ['打开用户画像', 'user-profile'], ['她对我的称呼在哪改', 'user-profile'],
    ['摸头怎么摸', 'touching-help'], ['带我去怎么喂零食', 'touching-help'],
    ['打开鼠标穿透', 'companion-window'], ['始终置顶在哪', 'companion-window'],
    ['带我去最打动她的一件事', 'moving-memory'], ['打开我们的小东西', 'our-things'], ['打开人物称呼', 'people-things'],
    ['带我去角色页', 'characters-page'], ['打开头发物理', 'physics'], ['带我去动作库', 'motion'], ['打开镜头设置', 'stage-camera'],
    ['带我去独立表情', 'single-emoji'], ['带我去视线跟随', 'natural-motion'], ['打开登记我的脸', 'face-check'], ['带我去界面语言', 'ui-language'],
    ['带我去内部通道', 'agent-channel'], ['带我去体验记录', 'journal'], ['带我去主动找我说话', 'proactive-talk'],
  ];
  for (const [text, id] of cases) assert.equal(matchTakeMeThere(text), id, text);
});

test('older pages keep winning their own sentences', () => {
  assert.equal(matchTakeMeThere('打开摄像头'), 'camera');
  assert.equal(matchTakeMeThere('开一下屏幕共享'), 'screen');
  assert.equal(matchTakeMeThere('打开 Claude 任务'), 'claude-tasks');
  assert.equal(matchTakeMeThere('把你转成英文版'), 'convert-character');
});

test('chit-chat and refusals about the new things give no button', () => {
  for (const text of ['今天的物理课好难', '我想拉她一下，哈哈', '这个果冻好好吃', '开发者都很辛苦', '别带我去物理窗口', '不要打开开发者模式', '不用打开穿透模式', '我觉得你的声音好听', '称呼表是什么意思呢', '怎么这么晚了'])
    assert.equal(matchTakeMeThere(text), null, text);
});

test('every new place opens a real page of the control window, on its own entry', () => {
  for (const id of Object.keys(TAKE_ME_THERE_PLACES)) {
    const leaf = takeMeThereLeaf(id);
    assert.ok(leaf, `${id} -> ${TAKE_ME_THERE[id as TakeMeThereId].leafId} must be a leaf of the control navigation`);
    assert.equal(new ControlNavigationState().navigate(leaf.page, leaf.target)?.leafId, leaf.id, id);
  }
});

test('the developer-mode tools open the developer-mode entry and say they need developer mode', () => {
  for (const id of ['developer-mode', 'physics-lab', 'unbound-lab'] as const) assert.equal(TAKE_ME_THERE[id].leafId, 'privacy-developer');
  assert.match(TAKE_ME_THERE['physics-lab'].title, /开发者模式/u);
  assert.match(TAKE_ME_THERE['unbound-lab'].title, /开发者模式/u);
});
