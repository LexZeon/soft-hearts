// 识图第 1 步：哪条消息带画面（electron/look-turns.ts）。屏幕只读大概（推翻上午的 V1"每条带最近一帧"）：
// 共享开着，普通消息不带图（她只知道大概，electron/screen-glance.ts）；叫她看、按按钮、回她"要我凑近看看吗"或点桌宠上的"看吧"才现截一张。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECLINE_HOLDS, LOOK_OFFER_TTL_MS, LookTurns, validateLookHint, type LookOfferView } from '../electron/look-turns';

const sharing = { screen: true, camera: false, scope: 'conversation-1|7' };
const off = { screen: false, camera: false, scope: 'conversation-1|7' };

test('开着屏幕共享，普通消息不带图（只知道大概）；叫她看才现截一张', () => {
  const turns = new LookTurns();
  for (const text of ['今天好累啊', '晚上吃什么好呢', '嘿嘿，你今天真的好可爱呀', '我看看', '你看看你', '这个报错到底什么意思啊，烦死了', '嗯'])
    assert.deepEqual(turns.decide({ text }, sharing), { screen: false, camera: false, via: null }, text);
  assert.deepEqual(turns.decide({ text: '你看看这个报错' }, sharing), { screen: true, camera: false, via: 'words' });
  assert.deepEqual(turns.decide({ text: '帮我看看' }, sharing), { screen: true, camera: false, via: 'words' });
  // Older windows send nothing: nothing is attached.
  assert.deepEqual(turns.decide(undefined, sharing), { screen: false, camera: false, via: null });
  // Sharing off: an ordinary message carries nothing.
  assert.deepEqual(turns.decide({ text: '今天好累啊' }, off), { screen: false, camera: false, via: null });
});

test('屏幕共享关着：叫她看也不偷偷截图；按钮也不截', () => {
  const turns = new LookTurns();
  assert.deepEqual(turns.decide({ text: '你看看我屏幕' }, off), { screen: false, camera: false, via: null });
  assert.deepEqual(turns.decide({ text: '这题怎么做', look: true }, off), { screen: false, camera: false, via: null });
});

test('"给她看看屏幕"按钮：不管说了什么都带屏幕（只要共享开着），不带清楚的摄像头画面（「发图片」开着时照常带小图）', () => {
  const turns = new LookTurns();
  assert.deepEqual(turns.decide({ text: '这题怎么做', look: true }, { ...sharing, camera: true }), { screen: true, camera: false, via: 'button', glance: true });
  assert.deepEqual(turns.decide({ look: true }, sharing), { screen: true, camera: false, via: 'button' });
});

// I-036 开着时普通消息带一张小图（glance），叫她看才拍清楚的一张。
test('「发图片」开着：普通消息带小图；"你看看我"拍清楚的；"你看看这个"有屏幕时看屏幕（仍带小图）', () => {
  const turns = new LookTurns(), camera = { screen: false, camera: true, scope: 's' }, both = { screen: true, camera: true, scope: 's' };
  assert.deepEqual(turns.decide({ text: '今天好累' }, camera), { screen: false, camera: false, via: null, glance: true });
  assert.deepEqual(turns.decide({ text: '你看看我' }, camera), { screen: false, camera: true, via: 'words' });
  assert.deepEqual(turns.decide({ text: '你看看这个' }, camera), { screen: false, camera: true, via: 'words' });
  assert.deepEqual(turns.decide({ text: '你看看这个' }, both), { screen: true, camera: false, via: 'words', glance: true });
  assert.deepEqual(turns.decide({ text: '你看看我今天的发型' }, both), { screen: false, camera: true, via: 'words' });
  assert.deepEqual(turns.decide({ text: '你看看我屏幕' }, camera), { screen: false, camera: false, via: null, glance: true }, 'screen asked, only the camera on: just the small frame');
  // Older windows send no words: nothing, as before.
  assert.deepEqual(turns.decide(undefined, camera), { screen: false, camera: false, via: null });
});

test('她问了"要我凑近看看吗"：下一条是"嗯/看吧/好"就细看；别的话、过期、换了对话或媒体状态都作废，只管下一条', () => {
  let now = 1_000;
  const turns = new LookTurns(() => now);
  turns.noteOffer(sharing.scope, sharing.scope);
  assert.equal(turns.offerOpen, true);
  assert.deepEqual(turns.decide({ text: '嗯' }, sharing), { screen: true, camera: false, via: 'offer' });
  assert.equal(turns.offerOpen, false);
  // The next "嗯" is an ordinary message: no new capture on the old offer.
  assert.deepEqual(turns.decide({ text: '嗯' }, sharing), { screen: false, camera: false, via: null }, 'answered once only');

  // "算了不用" answers her offer with a no: no frame; it closes the offer and is not a "别看" (DECLINE_HOLDS false).
  turns.noteOffer(sharing.scope, sharing.scope);
  assert.deepEqual(turns.decide({ text: '算了不用' }, sharing), { screen: false, camera: false, via: null });
  assert.equal(turns.refusedIn(sharing), DECLINE_HOLDS);
  assert.deepEqual(turns.decide({ text: '看吧' }, sharing), { screen: false, camera: false, via: null }, 'a no ends the offer');
  assert.deepEqual(turns.decide({ text: '你看看这个' }, sharing).via, 'words', 'asking her still looks');

  const fresh = () => { const value = new LookTurns(() => now); value.noteOffer(sharing.scope, sharing.scope); return value; };
  let other = fresh();
  assert.deepEqual(other.decide({ text: '今天好累' }, sharing).via, null);
  assert.deepEqual(other.decide({ text: '好' }, sharing).via, null, 'anything else answers it too (no capture)');

  other = fresh();
  now += LOOK_OFFER_TTL_MS + 1;
  assert.deepEqual(other.decide({ text: '好' }, sharing).via, null, 'expired');

  assert.deepEqual(fresh().decide({ text: '好' }, { ...sharing, scope: 'conversation-2|7' }).via, null, 'another conversation');
  assert.deepEqual(fresh().decide({ text: '好' }, { ...sharing, scope: 'conversation-1|8' }).via, null, 'sharing was toggled since');
  assert.deepEqual(fresh().decide({ text: '好' }, off).screen, false, 'sharing off now');
  assert.deepEqual(fresh().decide({ text: '不用' }, { ...sharing, scope: 'conversation-2|7' }).via, null, 'a "不用" with no open offer is an ordinary message');

  turns.noteOffer(sharing.scope, 'conversation-2|7');
  assert.equal(turns.offerOpen, false, 'a reply that finished in another context offers nothing');
  turns.noteOffer('', '');
  assert.equal(turns.offerOpen, false);
  turns.noteOffer(sharing.scope, sharing.scope); turns.clear();
  assert.equal(turns.offerOpen, false);
});

test('附图请求的格式：只认 text 和 look，错的在取画面之前就拒绝', () => {
  assert.deepEqual(validateLookHint(undefined), {});
  assert.deepEqual(validateLookHint(null), {});
  assert.deepEqual(validateLookHint({ text: '你好', look: false }), { text: '你好' });
  assert.deepEqual(validateLookHint({ look: true }), { look: true });
  for (const bad of ['看看', 3, [], { text: 3 }, { look: 'yes' }, { text: 'x'.repeat(20_001) }, { text: '', source: 'screen' }])
    assert.throws(() => validateLookHint(bad), /附图请求格式不正确/u, JSON.stringify(bad).slice(0, 40));
  const turns = new LookTurns();
  turns.noteOffer('s', 's');
  assert.throws(() => turns.decide({ text: '嗯', extra: 1 }, { screen: true, camera: false, scope: 's' }));
  assert.equal(turns.offerOpen, true, 'a refused hint does not use up her offer');
});

test('R10 (her looking at the screen on her own) starts off until 识图第 3 步 replaces it', async () => {
  const { PROACTIVE_VISION_DEFAULT } = await import('../electron/look-turns');
  assert.equal(PROACTIVE_VISION_DEFAULT, false);
});

test('屏幕只读大概：她的邀请开着时告诉桌宠（显示"让她看清楚屏幕吗？"），被回答、清掉、换了邀请时告诉它关掉', () => {
  const told: (LookOfferView | null)[] = [];
  const turns = new LookTurns(() => 0, offer => told.push(offer));
  turns.noteOffer(sharing.scope, sharing.scope);
  assert.equal(told.length, 1);
  const first = told[0]!;
  assert.ok(first && /^[0-9a-f-]{36}$/u.test(first.id), 'an id to answer it by');
  assert.equal(first.ttlMs, LOOK_OFFER_TTL_MS);
  turns.noteOffer(sharing.scope, sharing.scope); // a newer offer replaces it
  assert.notEqual(told.at(-1)?.id, first.id);
  turns.decide({ text: '今天好累' }, sharing); // any message answers it
  assert.equal(told.at(-1), null);
  const before = told.length;
  turns.userTurn(); turns.clear(); turns.decide({ text: '嗯' }, sharing);
  assert.equal(told.length, before, 'nothing open: nothing to close');
  turns.noteOffer(sharing.scope, sharing.scope);
  turns.clear(); // a new conversation, sharing turned off
  assert.equal(told.at(-1), null);
  // A listener that throws changes nothing.
  const loud = new LookTurns(() => 0, () => { throw new Error('window gone'); });
  loud.noteOffer(sharing.scope, sharing.scope);
  assert.equal(loud.offerOpen, true);
});

test('桌宠上点"不用"：只关这一个邀请、不取图，也不算"别看"；旧的、别的 id 什么都不做', () => {
  const told: (LookOfferView | null)[] = [];
  const turns = new LookTurns(() => 0, offer => told.push(offer));
  turns.noteOffer(sharing.scope, sharing.scope);
  const id = told[0]!.id;
  assert.equal(turns.decline('not-the-offer', sharing), false);
  assert.equal(turns.decline(42, sharing), false);
  assert.equal(turns.offerOpen, true);
  assert.equal(turns.decline(id, sharing), true);
  assert.equal(turns.offerOpen, false);
  assert.equal(told.at(-1), null);
  assert.equal(turns.refusedIn(sharing), DECLINE_HOLDS, '"不用" is not "别看": she still knows roughly what the user does');
  assert.equal(turns.decline(id, sharing), false, 'answered once');
  assert.deepEqual(turns.decide({ text: '嗯' }, sharing).via, null, 'a later "嗯" takes nothing on the closed offer');
  // "看吧" on the pet sends like the button: a frame right then.
  turns.noteOffer(sharing.scope, sharing.scope);
  assert.deepEqual(turns.decide({ text: '看吧。', look: true }, sharing), { screen: true, camera: false, via: 'button' });
  assert.equal(turns.offerOpen, false);
});
