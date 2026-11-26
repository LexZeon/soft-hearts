/**
 * I-176 prep, audit row 3: the control window's 惊喜 / 害羞 preview card says what the Unbound window really plays. Since E1 the card
 * (bindPreviewCardButtons) no longer goes through the old Gene-only lease whose state words ("正在预览 / 部分效果 / 不支持") only the
 * old stage fed; it asks the stage it has (expressionSupport) and names what shows, what this model skips, and why it cannot. The
 * Unbound window's expressionSupport is WindowReactions.support, so the card's line is the window's own, in every case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPreviewCardButtons } from '../src/stage/ExpressionPreviewButtons';
import { WindowReactions } from '../src/unbound/window-mode/window-reactions';
import type { ShowCapabilities } from '../src/stage';

const ALL: ShowCapabilities = { head: true, upperBody: true, eyes: true, lids: true, browUp: true, browSad: true, eyeWide: true, smileEyes: true, mouthSmile: true,
  mouthOpen: true, blush: true };
const NONE = Object.fromEntries(Object.keys(ALL).map(key => [key, false])) as unknown as ShowCapabilities;
const OFF = '开发者面板里的“程序化小动作与表情”关着，打开后才能预览。';

async function press(capabilities: ShowCapabilities | null, lifeOn: boolean, petVisible = true) { // no-pet-ok: existing result field petVisible
  const buttons: Record<string, { onclick: (() => void) | null }> = { 'surprise-preview': { onclick: null }, 'shy-preview': { onclick: null } };
  const lines: string[] = [], played: string[] = [], errors: string[] = [];
  bindPreviewCardButtons({ button: id => buttons[id] as never, support: recipe => WindowReactions.support(recipe, capabilities, lifeOn, OFF),
    play: async recipe => { played.push(recipe); return { sent: true, petVisible }; }, status: line => lines.push(line), error: message => errors.push(message) }); // no-pet-ok: existing result field petVisible
  for (const id of ['shy-preview', 'surprise-preview']) { buttons[id].onclick!(); for (let i = 0; i < 6; i++) await Promise.resolve(); }
  return { lines, played, errors };
}

test('everything the window can show: the line names it and the show is sent (playing)', async () => {
  const { lines, played } = await press(ALL, true);
  assert.deepEqual(played, ['shy', 'surprise']);
  assert.match(lines[0], /^害羞：/); assert.doesNotMatch(lines[0], /这个模型没有/);
  assert.match(lines[1], /^惊喜：/);
});

test('some parts missing (partial): the line says which are skipped, the show still plays', async () => {
  const { lines, played } = await press({ ...ALL, blush: false, upperBody: false }, true);
  assert.deepEqual(played, ['shy', 'surprise']);
  assert.match(lines[0], /这个模型没有：.*脸红.*（跳过）$/);
});

test('nothing to show, or procedural life off, or no model (unsupported): the reason is the line and nothing is sent', async () => {
  const none = await press(NONE, true);
  assert.deepEqual(none.played, []); assert.match(none.lines[0], /没法预览/);
  const off = await press(ALL, false);
  assert.deepEqual(off.played, []); assert.ok(off.lines[0].includes(OFF), off.lines[0]);
  const noModel = await press(null, true);
  assert.deepEqual(noModel.played, []); assert.ok(noModel.lines[0].length > 0);
});

test('the companion is hidden: the line says to show her first', async () => {
  const { lines } = await press(ALL, true, false);
  assert.match(lines[0], /桌宠现在没显示/);
});
