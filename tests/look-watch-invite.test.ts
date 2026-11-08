// 2026-11-08 (stable build, the user: "我开了屏幕，但是她还是说屏幕没开"): "和我一起看会儿视频吧" with screen sharing on was not a
// request to look, so the turn carried no frame and her line read as "you cannot see it"; she answered "我这边看不到你的屏幕".
// An invitation to watch together now asks for the screen. Every sentence below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanLookRequest } from '../shared/look-request';
import { SHARING_LINE, perceptionTurnLine, perceptionTurnState } from '../shared/perception-rule';

test('an invitation to watch something together asks her to look at the screen', () => {
  for (const text of ['和我一起看会儿视频吧', '陪我看剧', '一起看电影吧', '来一起看视频！', '我们一起看这集吧', '咱一起追剧呀', '跟我看会儿直播', '要不一起看个电影？'])
    assert.equal(scanLookRequest(text), 'screen', text);
});

test('watching with someone else, a no, someone else\'s words, or no watching at all is not a request', () => {
  for (const text of ['我昨天和朋友一起看了电影', '我和朋友一起看电影', '他们一起看电影去了', '不要一起看了', '别陪我看剧了',
    '他说要和我一起看电影', '我们下午一起去吃饭吧', '早上好！', '你知道这首歌叫什么么~'])
    assert.equal(scanLookRequest(text), null, text);
});

test('with sharing on the invitation takes a frame; with sharing off her line says sharing is off', () => {
  const text = '和我一起看会儿视频吧';
  const on = perceptionTurnState({ screenSharing: true, cameraSharing: false }, [{ source: 'screen' }], text);
  assert.ok(!perceptionTurnLine(on).includes('看不到'), 'with a frame she is not told she cannot see');
  const off = perceptionTurnLine(perceptionTurnState({ screenSharing: false, cameraSharing: false }, [], text));
  assert.ok(off.includes('屏幕共享没开'), off);
});

test('sharing on without a frame this turn: she is told she can look, and not to say she cannot see the screen', () => {
  assert.ok(SHARING_LINE.includes('你能看') && SHARING_LINE.includes('别说看不到屏幕'), SHARING_LINE);
  const line = perceptionTurnLine(perceptionTurnState({ screenSharing: true, cameraSharing: false }, [], '早上好！'));
  assert.ok(line.includes(SHARING_LINE), line);
});
