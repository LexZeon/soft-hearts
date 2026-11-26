// I-159 (for B/C/D, "可以"): out in Unbound there is no switch to point at.
// B: her per-turn line says the senses are all on, no card to turn one off; C: the card she offers shows beside her and its tap goes
// through the host's own card path (never a second route to a permission); D: the line after entering names what was turned on.
// Fakes only: no Electron, no Claude, no profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { ChatSettingCardView } from '../shared/brain/chat-settings';
import { ChatSettingProposals } from '../electron/brain/chat-settings';
import { CARD_SETTLED_MS, CARD_SIZE, UnboundCardSurface, cardRequestAllowed, type CardWindowPort } from '../electron/unbound/card-surface';
import { UnboundEntry } from '../electron/unbound/entry';
import { UnboundEntryStore } from '../electron/unbound/entry-store';
import { UnboundEntryButton } from '../src/unbound/unbound-entry-button';
import { UNBOUND_CARD_API_KEYS, UNBOUND_CARD_CHANNELS, createUnboundCardApi } from '../electron/unbound/card-preload-api';
import { cardWindowOptions } from '../electron/unbound/window-options';
import { BUNDLE_COPY, BUNDLE_SIGNATURE, PermissionBundle, openedNote } from '../electron/unbound/permission-bundle';
import { UNBOUND_OUTSIDE_LINE, unboundOutsideLine } from '../shared/unbound/outside-line';
import { senseLines } from '../shared/unbound/senses';
import type { UnboundState } from '../shared/unbound/scene';
import type { Rect } from '../shared/unbound/world';
import { setUiLanguage, t } from '../shared/foundation/ui-language';

setUiLanguage('zh-CN');
const card = (patch: Partial<ChatSettingCardView> = {}): ChatSettingCardView => ({ kind: 'chat-setting-card', version: 1, proposalId: 'p1', replyId: 'r1',
  settingId: 'sense_screen', label: '屏幕', current: '关着', proposed: '打开屏幕', reason: '', confirm: false, state: 'open',
  choices: [{ choiceId: 'c0', label: '打开屏幕', proposed: true, current: false }], ...patch });

function surface(initial: UnboundState = 'unbound') {
  const log: string[] = [], timers: { run: () => void; ms: number; live: boolean }[] = [], taps: unknown[] = [];
  const shownAt: Rect[] = [];
  const view: CardWindowPort = {
    show: (rect, shown) => { shownAt.push(rect); log.push(`show:${shown.proposalId}:${shown.state}`); },
    push: shown => log.push(`push:${shown.proposalId}:${shown.state}`), hide: () => log.push('hide'), destroy: () => log.push('destroy'),
  };
  const s = { state: initial, head: { x: 400, y: 300, r: 60 } as { x: number; y: number; r: number } | null };
  const ui = new UnboundCardSurface({
    state: () => s.state, window: () => ({ x: 0, y: 0, width: 1600, height: 900 }), askHead: async () => s.head, view,
    choose: async request => { taps.push(request); return { ok: true }; },
    timers: { set: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer; }, clear: handle => { (handle as { live: boolean }).live = false; } },
  });
  return { ui, s, log, timers, taps, shownAt };
}

test('C: a card offered while she is out is shown beside her head, in the card size, inside her window', async () => {
  const { ui, log, shownAt } = surface();
  await ui.offer(card());
  assert.deepEqual(log, ['show:p1:open']);
  assert.equal(shownAt[0].width, CARD_SIZE.width); assert.equal(shownAt[0].height, CARD_SIZE.height);
  assert.ok(shownAt[0].x >= 0 && shownAt[0].x + shownAt[0].width <= 1600 && shownAt[0].y >= 0 && shownAt[0].y + shownAt[0].height <= 900);
  assert.equal(ui.shownProposal, 'p1');
});

test('C: at home (or on her way out) nothing is shown and no tap is passed on', async () => {
  for (const state of ['normal', 'entering'] as const) {
    const { ui, log, taps } = surface(state);
    await ui.offer(card());
    assert.deepEqual(log, []);
    assert.equal(ui.shownProposal, null, 'no card is marked as shown (its id could not be tapped later)');
    assert.equal(await ui.choose({ proposalId: 'p1', choiceId: 'c0' }), null);
    assert.deepEqual(taps, []);
  }
});

test('C (safety): a tap is passed to the host only for the card on screen, with a choice id, and only while she is out', async () => {
  const { ui, s, taps } = surface();
  assert.equal(await ui.choose({ proposalId: 'p1', choiceId: 'c0' }), null, 'nothing shown yet: nothing to tap');
  await ui.offer(card());
  assert.equal(await ui.choose({ proposalId: 'other', choiceId: 'c0' }), null, 'another card id');
  assert.equal(await ui.choose({ proposalId: 'p1' }), null, 'no choice id');
  assert.equal(await ui.choose({ proposalId: 5, choiceId: 'c0' }), null);
  assert.equal(await ui.choose(null), null);
  assert.deepEqual(taps, []);
  assert.deepEqual(await ui.choose({ proposalId: 'p1', choiceId: 'c0', extra: 'x' }), { ok: true });
  assert.deepEqual(taps, [{ proposalId: 'p1', choiceId: 'c0' }], 'only the two fields go on');
  s.state = 'normal';
  assert.equal(await ui.choose({ proposalId: 'p1', choiceId: 'c0' }), null, 'she went back: no tap passes');
  assert.equal(taps.length, 1);
});

test('C: a card the surface never showed (an update for an old card) is not shown, and its id cannot be tapped', async () => {
  const { ui, log, taps } = surface();
  await ui.offer(card({ state: 'applied', message: 'x' }));
  assert.deepEqual(log, []);
  assert.equal(await ui.choose({ proposalId: 'p1', choiceId: 'c0' }), null);
  assert.deepEqual(taps, []);
});

test('C: updates follow the card; a settled card stays a few seconds and then goes; an update during placement is not lost', async () => {
  const { ui, log, timers } = surface();
  const placing = ui.offer(card());
  await ui.offer(card({ state: 'busy' })); // arrives while the head is still being asked
  await placing;
  assert.deepEqual(log, ['push:p1:busy', 'show:p1:busy'], 'the window opens with the newest state');
  await ui.offer(card({ state: 'applied', message: 'ok' }));
  assert.equal(timers.at(-1)!.ms, CARD_SETTLED_MS);
  timers.at(-1)!.run();
  assert.equal(log.at(-1), 'hide');
  assert.equal(ui.shownProposal, null, 'after it went, its id cannot be tapped any more');
});

test('C: going back to the small window (or quitting) takes the card away at once', async () => {
  const { ui, s, log } = surface();
  await ui.offer(card());
  s.state = 'normal'; ui.modeChanged('normal');
  assert.equal(log.at(-1), 'destroy');
  assert.equal(ui.shownProposal, null);
  const again = surface();
  await again.ui.offer(card()); again.ui.quit();
  assert.equal(again.log.at(-1), 'destroy');
});

test('C: a head that is not there still places the card (the corner), and a window that is gone shows nothing', async () => {
  const noHead = surface(); noHead.s.head = null;
  await noHead.ui.offer(card());
  assert.deepEqual(noHead.log, ['show:p1:open']);
  const left = surface();
  const placing = left.ui.offer(card()); left.s.state = 'normal'; await placing;
  assert.deepEqual(left.log, [], 'she went back while it was being placed');
});

test('C (safety): the card window takes one input, a tap on the shown card; nothing else is exposed', async () => {
  assert.deepEqual([...UNBOUND_CARD_API_KEYS].sort(), ['choose', 'onCard']);
  const calls: unknown[][] = [], listeners = new Map<string, (event: unknown, card: unknown, language?: unknown) => void>();
  const api = createUnboundCardApi({ invoke: async (...args) => { calls.push(args); return null; }, on: (channel, l) => { listeners.set(channel, l); }, removeListener: () => {} });
  assert.deepEqual(Object.keys(api).sort(), ['choose', 'onCard']);
  await api.choose({ proposalId: 'p'.repeat(300), choiceId: 'c0'.repeat(30) });
  assert.deepEqual(calls[0], [UNBOUND_CARD_CHANNELS.choose, { proposalId: 'p'.repeat(120), choiceId: ('c0'.repeat(30)).slice(0, 20) }]);
  await assert.rejects(api.choose({ proposalId: 5 } as never), TypeError);
  await assert.rejects(api.choose(null as never), TypeError);
  const got: unknown[] = []; api.onCard((shown, language) => got.push([shown, language]));
  listeners.get(UNBOUND_CARD_CHANNELS.show)!({}, { a: 1 }, 'en'); listeners.get(UNBOUND_CARD_CHANNELS.show)!({}, { a: 2 }, 7);
  assert.deepEqual(got, [[{ a: 1 }, 'en'], [{ a: 2 }, '']]);
  const options = cardWindowOptions({ x: 1, y: 2, width: 340, height: 250 }, 'preload.cjs');
  assert.equal(options.focusable, false, 'a tap never takes the keyboard');
  assert.equal(options.webPreferences?.sandbox, true); assert.equal(options.webPreferences?.nodeIntegration, false); assert.equal(options.webPreferences?.contextIsolation, true);
});

test('C: the card page file holds no Chinese of its own, and talks to the host only through window.unboundCard', () => {
  const html = readFileSync(new URL('../src/unbound/card.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(html, /[一-鿿]/);
  const page = readFileSync(new URL('../src/unbound/card.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(page.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /[一-鿿]/, 'no Chinese in the code of the page (its words come from the card renderer and the copy tables)');
  assert.match(page, /unboundCard/);
  assert.doesNotMatch(page, /ipcRenderer|require\(/);
});

// ---- the host's own card path ---------------------------------------------------------------------------------------------------

function proposals(outside = false) {
  const sent: { owner: number; card: ChatSettingCardView }[] = [], applied: [string, unknown][] = [];
  const settings = structuredClone(DEFAULT_SETTINGS);
  const chatSettings = new ChatSettingProposals({ settings: () => settings, send: (owner, shown) => sent.push({ owner, card: shown }), outside: () => outside });
  chatSettings.connect(async (id, value) => { applied.push([id, value]); return { ok: true, result: { previous: null, value } }; }, {
    senses: { read: () => ({ perception: { camera: false, microphone: false, screen: false, systemAudio: { music: false, movie: false } }, facePhase: 'idle' }),
      apply: async (id, value) => { applied.push([id, value]); return { ok: true, result: { before: false, after: true } }; } },
  });
  return { chatSettings, sent, applied };
}

test('C (safety): the tap from beside her goes through the same live card as the owner window: exactly once, nothing without a card', async () => {
  const { chatSettings, sent, applied } = proposals();
  assert.equal(await chatSettings.chooseMirrored({ proposalId: 'x', choiceId: 'c0' }), null, 'no card: nothing happens');
  const turn = chatSettings.beginTurn('帮我打开屏幕');
  assert.ok(turn.instruction, 'the user asked for a sense: the turn carries the format');
  const shown = chatSettings.offer(turn.ticket, 7, 'r1', JSON.stringify({ id: 'sense_screen', value: 'on', reason: '想看看你在做什么' }));
  assert.ok(shown, 'a card was offered');
  assert.equal(sent[0].owner, 7);
  assert.equal(await chatSettings.chooseMirrored({ proposalId: 'wrong', choiceId: 'c0' }), null, 'a card id that is not the live one');
  assert.equal(await chatSettings.chooseMirrored({ proposalId: shown.proposalId, choiceId: 'nope' }), null, 'a choice id the card does not have');
  assert.deepEqual(applied, [], 'nothing changed before a real tap');
  const result = await chatSettings.chooseMirrored({ proposalId: shown.proposalId, choiceId: shown.choices[0].choiceId });
  assert.equal(result?.state, 'applied');
  assert.deepEqual(applied, [['sense_screen', 'on']]);
  assert.equal(sent.at(-1)!.owner, 7, 'the receipt goes to the owner window (and from there to the card beside her)');
  assert.equal(await chatSettings.chooseMirrored({ proposalId: shown.proposalId, choiceId: shown.choices[0].choiceId }), null, 'one tap per card');
  assert.equal(applied.length, 1);
});

test('C (safety): the cancel button beside her changes nothing', async () => {
  const { chatSettings, applied } = proposals();
  const turn = chatSettings.beginTurn('帮我打开屏幕');
  const shown = chatSettings.offer(turn.ticket, 7, 'r1', JSON.stringify({ id: 'sense_screen', value: 'on', reason: '' }))!;
  const result = await chatSettings.chooseMirrored({ proposalId: shown.proposalId, choiceId: 'cancel' });
  assert.equal(result?.state, 'cancelled');
  assert.deepEqual(applied, []);
});

test('B: out in Unbound she gets no card to turn a sense off (it would say off and the bundle would turn it on again); turning on is still offered', () => {
  const home = proposals(false), out = proposals(true);
  assert.match(home.chatSettings.beginTurn('把摄像头关掉').instruction?.('<a>', '</a>') ?? '', /sense_camera/, 'at home the off card is offered');
  assert.doesNotMatch(out.chatSettings.beginTurn('把摄像头关掉').instruction?.('<a>', '</a>') ?? '', /sense_camera/, 'out: none');
  assert.match(out.chatSettings.beginTurn('把摄像头打开').instruction?.('<a>', '</a>') ?? '', /sense_camera/);
});

test('B: the per-turn line says they are all on and teaches no switch; it is empty at home and on her way out', () => {
  assert.equal(unboundOutsideLine('normal'), ''); assert.equal(unboundOutsideLine('entering'), ''); assert.equal(unboundOutsideLine(undefined), '');
  const line = unboundOutsideLine('unbound');
  assert.equal(line, UNBOUND_OUTSIDE_LINE);
  for (const word of ['摄像头', '麦克风', '屏幕', '电脑的声音', '都是开着的', '不需要']) assert.ok(line.includes(word), word);
  assert.doesNotMatch(line.replace('别教用户去点桌宠上的开关', ''), /点桌宠上的开关/, 'it never tells her to point at the pet\'s switch');
});

test('B: the wiring adds that line to every turn and hands the card path to Unbound', () => {
  const chat = readFileSync(new URL('../electron/wiring/brain-chat-wiring.ts', import.meta.url), 'utf8');
  assert.match(chat, /unboundOutsideTurnLine\(\) \+ unboundNoticedLine\(i139Chat\.cardLanguage\(\), owner\)/); // I-193: the line's language is the card's; I-209 step 3: the one whose turn it is
  const brain = readFileSync(new URL('../electron/wiring/brain-wiring.ts', import.meta.url), 'utf8');
  assert.match(brain, /outside: \(\) => unboundOutsideTurnLine\(\) !== ''/);
  assert.match(brain, /offerUnboundCard\(card\)/);
  assert.match(brain, /connectUnboundCardChooser\(request => chatSettings\.chooseMirrored\(request\)\)/);
});

// ---- D -------------------------------------------------------------------------------------------------------------------------

test('D: the line after entering names only what this entry really turned on; nothing turned on, no line', () => {
  const outcome = { alreadyOn: ['microphone' as const], opened: ['camera' as const, 'screen' as const], notOpened: ['listen' as const], skipped: [] };
  assert.equal(openedNote(outcome), '这次打开了：摄像头（姿势识别）、屏幕。她在外面时一直开着，回小窗后恢复。');
  assert.ok(!openedNote(outcome)!.includes('麦克风') && !openedNote(outcome)!.includes('电脑的声音'));
  assert.equal(openedNote({ alreadyOn: ['camera', 'microphone', 'screen', 'listen', 'face'], opened: [], notOpened: [], skipped: [] }), null);
  assert.equal(openedNote({ alreadyOn: [], opened: [], notOpened: ['camera'], skipped: [] }), null);
});

test('every new line has English (the card is the existing card; these are the new words)', () => {
  setUiLanguage('en');
  try {
    const lines = [...senseLines({ camera: true, microphone: true, screen: true, audio: true })];
    assert.equal(lines.length, 5);
    for (const line of lines) assert.match(t(line), /^[\x20-\x7e]+$/, `English for: ${line}`);
    assert.equal(t(BUNDLE_COPY.openedNote, { items: 'Screen' }), 'Turned on this time: Screen. They stay on while she is out and go back when she is back.');
    for (const line of ['下次进来时再问我', '好，下次会再问。', '本来就会再问。', '让她出来时重新显示权限说明页（取消「以后直接进，不再问」）。'])
      assert.match(t(line), /^[\x20-\x7e]+$/, `English for: ${line}`);
    assert.equal(openedNote({ alreadyOn: [], opened: ['screen', 'camera'], notOpened: [], skipped: [] }, t), 'Turned on this time: Screen, Camera (pose recognition). They stay on while she is out and go back when she is back.');
  } finally { setUiLanguage('zh-CN'); }
});

test('the hover no longer points at a switch that is not there', () => {
  const lines = senseLines({ camera: true, microphone: false, screen: false, audio: false });
  assert.deepEqual(lines, ['摄像头开着', '她在外面时它们一直开着；想关，先回小窗。']);
  assert.ok(!lines.join('').includes('在设置里关') && !lines.join('').includes('直接告诉她'));
});

// ---- D: 「下次进来时再问我」 and the card window's own-frame rule ------------------------------------------------------------------

test('C (safety): the card window answers only its own window\'s top frame', () => {
  const top = {};
  assert.equal(cardRequestAllowed(5, { sender: { id: 5, mainFrame: top }, senderFrame: top }), true);
  assert.equal(cardRequestAllowed(5, { sender: { id: 6, mainFrame: top }, senderFrame: top }), false, 'another window');
  assert.equal(cardRequestAllowed(5, { sender: { id: 5, mainFrame: top }, senderFrame: {} }), false, 'a subframe');
  assert.equal(cardRequestAllowed(null, { sender: { id: 5, mainFrame: top }, senderFrame: top }), false, 'no card window');
});

test('D: 「下次进来时再问我」 clears the saved tick (and only that), and the permission page comes again', async () => {
  const written: string[] = [];
  const store = new UnboundEntryStore('nowhere', { read: async () => JSON.stringify({ version: 1, skipAsk: BUNDLE_SIGNATURE, session: null }), write: async (_file, text) => { written.push(text); } });
  await store.ready;
  const facts = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false };
  const asked: string[] = [];
  const entry = new UnboundEntry({
    state: () => 'normal', enter: () => {}, exit: () => {}, ask: async page => { asked.push(page.title); return { confirmed: false, remember: false }; },
    skipAsk: () => store.skipAsk, setSkipAsk: signature => store.setSkipAsk(signature),
    bundle: new PermissionBundle({ read: () => facts, face: () => ({ supported: false, installed: false, enrolled: 0 }), set: async () => {}, save: async () => {},
      replyRunning: () => false, every: () => () => {}, wait: async () => {} }),
    read: () => facts, face: () => ({ supported: false, installed: false, enrolled: 0 }),
  });
  await entry.toggle();
  assert.deepEqual(asked, [], 'ticked: straight in, no page');
  assert.equal(await store.clearSkipAsk(), true);
  assert.equal(store.skipAsk, null);
  assert.deepEqual(JSON.parse(written.at(-1)!), { version: 1, skipAsk: null, session: null });
  await entry.toggle();
  assert.equal(asked.length, 1, 'the page comes again');
  const writes = written.length;
  assert.equal(await store.clearSkipAsk(), false, 'nothing saved: nothing written');
  assert.equal(written.length, writes);
});

test('D: the control window\'s button calls the host\'s askUnboundAgain and says what happened, in the interface language', async () => {
  class El {
    children: El[] = []; textContent = ''; title = ''; type = ''; id = ''; className = ''; disabled = false; listeners: Record<string, () => void> = {};
    ownerDocument = { createElement: () => new El() };
    insertAdjacentElement(_where: string, el: El) { this.children.push(el); return el; }
    addEventListener(name: string, run: () => void) { this.listeners[name] = run; }
    setAttribute() {} remove() {}
  }
  const anchor = new El();
  let calls = 0;
  new UnboundEntryButton(anchor as unknown as HTMLElement, { getUnbound: async () => ({ state: 'normal' }) as never, onUnbound: () => () => {}, toggleUnbound: async () => 'entering',
    askUnboundAgain: async () => { calls++; return calls === 1; } });
  const ask = anchor.children[0].children[0];
  assert.equal(ask.id, 'unbound-ask-again'); assert.equal(ask.textContent, '下次进来时再问我');
  ask.listeners.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ask.textContent, '好，下次会再问。'); assert.equal(calls, 1);
  const none = new UnboundEntryButton(anchor as unknown as HTMLElement, { getUnbound: async () => ({ state: 'normal' }) as never, onUnbound: () => () => {}, toggleUnbound: async () => 'entering' });
  assert.equal(none.button.children.length, 0, 'a host without the call: no second button');
});
