import test from 'node:test';
import assert from 'node:assert/strict';
import { RPS_TIMING, type RpsThrowRequest, type RpsView } from '../shared/rps';
import { RpsOverlay, petSayPorts, rpsOverlayModel } from '../src/ui/RpsOverlay';
import { RpsSpeech, type RpsSayPorts } from '../src/ui/rps-speech';
import { setUiLanguage } from '../shared/ui-language';

class Element {
  children: Element[] = []; className = ''; textContent = ''; hidden = false; disabled = false; type = ''; title = '';
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {}; style: Record<string, string> = {}; onclick: (() => void) | null = null;
  classList = { set: new Set<string>(), toggle: (name: string, on: boolean) => { if (on) this.classList.set.add(name); else this.classList.set.delete(name); } };
  constructor(public tagName: string) {}
  append(...xs: Element[]) { this.children.push(...xs); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  remove() {}
}
const doc = { createElement: (tag: string) => new Element(tag) };
const all = (n: Element): Element[] => [n, ...n.children.flatMap(all)];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function view(extra: Partial<RpsView> = {}): RpsView {
  return { id: 'g1', revision: 1, phase: 'count', round: 1, score: { her: 1, user: 0 }, firstTo: 2, accepting: true, commitment: { gameId: 'g1', round: 1, committedAt: 1, digest: 'a'.repeat(64) },
    revealed: null, userHand: null, outcome: null, line: null, face: 'nervous', tease: null, beatMs: RPS_TIMING.beatMs, phaseMs: 1540, elapsedMs: 0, result: null, ...extra };
}

test('the call lands on the beats, the three buttons open only while the round accepts a hand, invitations show their buttons, her words are never here', () => {
  setUiLanguage('zh-CN');
  const lead = RPS_TIMING.leadMs, beat = RPS_TIMING.beatMs;
  assert.equal(rpsOverlayModel(view(), lead - 10).call, null);
  assert.equal(rpsOverlayModel(view(), lead + 10).call, '石头');
  assert.equal(rpsOverlayModel(view(), lead + beat + 10).call, '剪刀');
  assert.equal(rpsOverlayModel(view(), lead + 2 * beat + 10).call, '布！');
  assert.equal(rpsOverlayModel(view({ phase: 'wait' }), 0).call, '布！');
  const counting = rpsOverlayModel(view(), 0);
  assert.deepEqual(counting.hands.map(h => h.enabled), [true, true, true]);
  assert.match(counting.score!, /你 ○○ · 她 ●○/u);
  const thrown = rpsOverlayModel(view({ accepting: false, userHand: 'paper' }), 0);
  assert.deepEqual(thrown.hands.map(h => [h.enabled, h.chosen]), [[false, false], [false, false], [false, true]]);
  assert.equal(rpsOverlayModel(view({ phase: 'end', accepting: false }), 0).hands.length, 0, 'no buttons once it is decided');
  const invite = rpsOverlayModel(view({ phase: 'invite', accepting: false }), 0);
  assert.ok(invite.visible && invite.invite && !invite.hands.length);
  // Her answer to "下次吧" is only words, and those are in the ordinary chat bubble.
  assert.equal(rpsOverlayModel(view({ phase: 'aside', say: { id: 'a1', text: '好吧，下次哦' } }), 0).visible, false);
  assert.equal(rpsOverlayModel(null, 0).visible, false);
});

test('a click is the "我出了什么" input: once per round, with the round it belongs to; the stage follows every view; older views are ignored; her line goes to the chat bubble and voice', async () => {
  const root = new Element('div'), throws: RpsThrowRequest[] = [], staged: (RpsView | null)[] = [], responses: unknown[] = [], said: string[] = [];
  let emit: (value: RpsView | null) => void = () => {};
  const say: RpsSayPorts = { free: () => true, voiceOn: () => true, show: (id, text, speech) => said.push(`show ${id} ${text} ${speech}`),
    speak: async (id, text) => { said.push(`speak ${id} ${text}`); }, ended: id => said.push(`ended ${id}`) };
  const overlay = new RpsOverlay(root as never, { rpsGet: async () => null, rpsThrow: async input => { throws.push(input); return 'accepted'; },
    rpsRespond: async input => { responses.push(input); return true; },
    rpsEvents: callback => { emit = callback; return () => {}; } }, { stage: { setRps: value => staged.push(value) }, say, now: () => 0, document: doc as never });
  await overlay.init(); await flush();
  emit(view());
  const buttons = all(root).filter(n => n.className === 'rps-hand');
  assert.equal(buttons.length, 3);
  buttons[2].onclick!();
  buttons[0].onclick!();
  assert.deepEqual(throws, [{ gameId: 'g1', round: 1, hand: 'paper', source: 'click' }]);
  assert.equal(buttons[0].disabled, true);
  const reveal = view({ revision: 3, phase: 'reveal', accepting: false, userHand: 'paper', revealed: { hand: 'rock', intent: 'fair', nonce: 'n' }, outcome: 'user', say: { id: 'g1l1', text: '刚才不算！' } });
  emit(reveal);
  emit(view({ revision: 2 }));
  assert.equal(staged.at(-1)!.phase, 'reveal', 'an older revision does not replace the newer view');
  await flush();
  assert.deepEqual(said, ['show g1l1 刚才不算！ true', 'speak g1l1 刚才不算！', 'ended g1l1'], 'the ordinary bubble, then the ordinary voice with the line as its reply id');
  assert.deepEqual(responses, [{ id: 'g1l1', action: 'said' }], 'then the host hears she is done');
  emit({ ...reveal, revision: 4 }); await flush();
  assert.equal(said.length, 3, 'a line is shown and read once, however often its view comes');
  assert.ok(!all(root).some(n => n.className === 'rps-line'), 'no little bubble of its own beside the buttons any more');
  assert.equal(root.children[0].dataset.moodUi, 'true', 'a pet control area: never a pat');
  emit(null);
  assert.equal(root.children[0].hidden, true); assert.equal(staged.at(-1), null);
  overlay.dispose();
});

test('with her hand up the buttons sit below the raised arm, out from it (pretrial: they covered the arm and the scarf); before that, beside her face', () => {
  const root = new Element('div');
  const overlay = new RpsOverlay(root as never, { rpsGet: async () => null, rpsThrow: async () => 'accepted', rpsRespond: async () => true, rpsEvents: () => () => {} },
    { now: () => 0, document: doc as never });
  const box = root.children[0];
  // The pet window is 400 × 560; Gene's face at (200, 165), her raised fist at (120, 200), the elbow at (165, 270) (the pretrial screenshot).
  overlay.place({ x: 200, y: 165, visible: true, radius: 24 }, 400, 560);
  const before = { left: parseFloat(box.style.left), top: parseFloat(box.style.top) };
  overlay.place({ x: 200, y: 165, visible: true, radius: 24, raisedHand: { x: 120, y: 200, elbowX: 165, elbowY: 270 } }, 400, 560);
  const left = parseFloat(box.style.left), top = parseFloat(box.style.top);
  assert.ok(top >= 270, `below the elbow: top ${top}`);
  assert.ok(left + 160 <= 170, `out from the arm, not over her body: right edge ${left + 160}`);
  assert.ok(top > before.top, `lower than the face placement (${before.top}), which sat on the arm`);
  overlay.place({ x: 200, y: 165, visible: true, radius: 24, raisedHand: { x: 30, y: 520, elbowX: 60, elbowY: 540 } }, 400, 560);
  assert.ok(parseFloat(box.style.left) >= 8 && parseFloat(box.style.top) <= 560 - 150, 'still inside the window');
  overlay.dispose();
});

test('her game line: skipped (and reported done at once) while a chat reply runs or the user types; without the voice the bubble stays for a reading time', async () => {
  const log: string[] = [];
  let free = false, voice = false;
  const ports: RpsSayPorts = { free: () => free, voiceOn: () => voice, show: (id, text) => log.push(`show ${id} ${text}`), speak: async id => { log.push(`speak ${id}`); },
    ended: id => log.push(`ended ${id}`), wait: async ms => { log.push(`wait ${ms > 1000 && ms < 5000}`); } };
  const speech = new RpsSpeech(ports, (id, shown) => log.push(`${shown ? 'said' : 'skipped'} ${id}`));
  const say = (id: string): RpsView => view({ phase: 'reveal', say: { id, text: '嘿嘿，这局是我的' } });
  speech.view(say('a')); await flush();
  assert.deepEqual(log, ['skipped a'], 'busy: not shown, not read, reported done as not shown');
  free = true;
  speech.view(say('b')); await flush();
  assert.deepEqual(log.slice(1), ['show b 嘿嘿，这局是我的', 'wait true', 'said b'], 'voice off: shown, read time, done');
  voice = true; log.length = 0;
  speech.view(say('c')); speech.view(null); speech.view(say('c')); await flush();
  assert.deepEqual(log, ['show c 嘿嘿，这局是我的', 'speak c', 'ended c', 'said c']);
});

test('petSayPorts: the same PetUI and speech calls as her other unprompted lines (ambient comments): provisional bubble, finished with speech expected, read with its reply id', async () => {
  const calls: unknown[][] = [];
  const ui = { showAnswer: (...args: unknown[]) => { calls.push(['showAnswer', ...args]); }, finishAnswer: (...args: unknown[]) => { calls.push(['finishAnswer', ...args]); },
    endAnswerSpeech: (id: string) => { calls.push(['endAnswerSpeech', id]); } };
  const voice = { enabled: true, voiceURI: '', rate: 1, volume: 1 };
  const ports = petSayPorts({ ui: () => ui, speech: { speak: async (...args) => { calls.push(['speak', ...args]); } }, voice: () => voice, free: () => true });
  assert.equal(ports.free(), true); assert.equal(ports.voiceOn(), true);
  ports.show('m1l1', '刚才不算！', true); await ports.speak('m1l1', '刚才不算！'); ports.ended('m1l1');
  assert.deepEqual(calls, [['showAnswer', '刚才不算！', true, 'm1l1'], ['finishAnswer', '刚才不算！', 'm1l1', true, true], ['speak', '刚才不算！', voice, { replyId: 'm1l1' }],
    ['endAnswerSpeech', 'm1l1']]);
  assert.equal(petSayPorts({ ui: () => null, speech: { speak: async () => {} }, voice: () => voice, free: () => true }).free(), false, 'no pet bubble: not free');
  // Round 028: revoking a line still being read stops the ordinary voice.
  calls.length = 0;
  const stopping = petSayPorts({ ui: () => ui, speech: { speak: async () => {}, stop: () => { calls.push(['stop']); } }, voice: () => voice, free: () => true });
  stopping.stop!('m1l2');
  assert.deepEqual(calls, [['stop']]);
});

// Codex T-112 round 028 (fixed 17f9807): a line skipped while she was busy was still reported as said, and a line already
// handed to the voice had no local revocation in the pet window (a cancelled game read on and its old `said` came back).
test('round 028: a skipped line is reported as not shown; a line still being read is revoked locally on a new game, the end or a newer line', async () => {
  const log: string[] = [];
  const pending = new Map<string, () => void>();
  let free = false;
  const ports: RpsSayPorts = { free: () => free, voiceOn: () => true, show: id => log.push(`show ${id}`),
    speak: id => { log.push(`speak ${id}`); return new Promise<void>(resolve => pending.set(id, resolve)); },
    ended: id => log.push(`ended ${id}`), stop: id => log.push(`stop ${id}`) };
  const speech = new RpsSpeech(ports, (id, shown) => log.push(`${shown ? 'said' : 'skipped'} ${id}`));
  const say = (id: string, game = 'g1'): RpsView => view({ id: game, phase: 'reveal', say: { id, text: '嘿嘿，这局是我的' } });
  speech.view(say('a')); await flush();
  assert.deepEqual(log, ['skipped a'], 'busy: not shown, not read, and not reported as said');
  free = true; log.length = 0;
  // The game ends while she is still reading: the voice stops here, the bubble ends, and nothing comes back later.
  speech.view(say('b')); speech.view(null);
  pending.get('b')!(); await flush();
  assert.deepEqual(log, ['show b', 'speak b', 'stop b', 'ended b', 'said b'], 'end: revoked once, at once');
  // A new game (another id) revokes the old game's line.
  log.length = 0;
  speech.view(say('c', 'g1')); speech.view(view({ id: 'g2', phase: 'ready' }));
  pending.get('c')!(); await flush();
  assert.deepEqual(log, ['show c', 'speak c', 'stop c', 'ended c', 'said c'], 'new game: revoked');
  // A newer line in the same game takes over: the old one is revoked before the new one is shown, and reports once.
  log.length = 0;
  speech.view(say('d', 'g2')); speech.view(say('e', 'g2'));
  pending.get('d')!(); await flush();
  assert.deepEqual(log, ['show d', 'speak d', 'stop d', 'ended d', 'said d', 'show e', 'speak e']);
  // The same game moving on (her line no longer in the view) does not cut her off: she finishes, then reports.
  log.length = 0;
  speech.view(view({ id: 'g2', phase: 'ready', say: null }));
  assert.deepEqual(log, [], 'the same game without the line: she reads on');
  pending.get('e')!(); await flush();
  assert.deepEqual(log, ['ended e', 'said e']);
  // A line whose reading already ended is not stopped again by a later view.
  log.length = 0; speech.view(null); await flush();
  assert.deepEqual(log, []);
});

test('round 028: the overlay answers `skipped` for a line it did not show, `said` for one it did', async () => {
  const responses: unknown[] = [];
  let free = false;
  const say: RpsSayPorts = { free: () => free, voiceOn: () => false, show: () => {}, speak: async () => {}, ended: () => {}, wait: async () => {} };
  const overlay = new RpsOverlay(new Element('div') as never, { rpsGet: async () => null, rpsThrow: async () => 'accepted',
    rpsRespond: async input => { responses.push(input); return true; }, rpsEvents: () => () => {} }, { say, now: () => 0, document: doc as never });
  overlay.show(view({ phase: 'reveal', revision: 2, say: { id: 'g1l1', text: '嘿嘿' } })); await flush();
  free = true;
  overlay.show(view({ phase: 'reveal', revision: 3, say: { id: 'g1l2', text: '嘿嘿' } })); await flush();
  assert.deepEqual(responses, [{ id: 'g1l1', action: 'skipped' }, { id: 'g1l2', action: 'said' }]);
  overlay.dispose();
});
