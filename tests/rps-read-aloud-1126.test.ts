/**
 * 2026-11-26 (docs/claude/2026-11-26-rps-read-aloud.md): in full screen her 猜拳 lines were in her bubble and handed to the companion window, which never read
 * them. Two things stood between the line and the voice, both quiet refusals: (1) the voice refuses a reading whose style was never begun
 * (ReplySpeechStyles.resolveStyle); (2) it refuses a held line until her page has painted it (the bubble proof's paint report arrives some time after
 * the host sent the line). The first fix (2026-11-25 16:28) did neither. These tests run the host's hand-over (readGameLine) into the companion window's
 * real HeldLines handler; the style check is the real ReplySpeechStyles and the bubble proof has the real delay between "sent" and "painted".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameLineRelay, readGameLine, type GameLinePorts, type ReadGameLinePorts } from '../electron/unbound/game-line';
import { ReplySpeechStyles } from '../electron/mood/speech-emotion';
import { HeldLines } from '../src/brain/held-lines';

const later = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const OWNER = 7, SCOPE = 'scope-1';
const MOOD = { context: 'neutral', primary: 'calm' } as const;
const STYLE = { instruction: 'x', emotion: 'calm' } as const;

/** Her bubble's proof as the host has it: a line is `sent`, and counts as shown only when the page's report arrives (`paint`, some ms later). */
class FakeProof {
  currentId: string | null = null; private text = ''; private shownText = ''; private waiters: Array<() => void> = [];
  sent(id: string, text: string) { this.currentId = id; this.text = text; this.shownText = ''; this.waiters.forEach(wake => wake()); }
  paint() { this.shownText = this.text; this.waiters.forEach(wake => wake()); }
  isPresentationCurrent(text: string) { return this.shownText !== '' && this.shownText === text; }
  waitForPresentation(text: string): Promise<boolean> {
    if (this.text !== text) return Promise.resolve(false);
    if (this.isPresentationCurrent(text)) return Promise.resolve(true);
    return new Promise(resolve => { const wake = () => { if (this.text !== text) done(false); else if (this.isPresentationCurrent(text)) done(true); }; const done = (value: boolean) => { this.waiters = this.waiters.filter(item => item !== wake); resolve(value); }; this.waiters.push(wake); });
  }
}

/** The app as it is while a game runs out in Unbound: the host's relay, the real style store, the companion window's real held-line handler. */
function app(opts: { begin?: boolean; voiceOn?: boolean; paintMs?: number | null } = {}) {
  const styles = new ReplySpeechStyles();
  const proof = new FakeProof();
  const guards = new Map<string, (id: string) => boolean>();
  const spoken: string[] = [], refused: string[] = [], unread: string[] = [], skipped: string[] = [];
  const held: HeldLines = new HeldLines({
    ackVision: async () => true, ackAmbient: async () => null, free: () => true, voiceOn: () => opts.voiceOn !== false,
    // what the host does before it lets a window play a reading: the style of this reply must have been begun, and the line's guard must hold now
    speak: async (text, context) => {
      try {
        const id = context.replyId!;
        styles.resolveStyle(OWNER, id, SCOPE);
        if (!guards.get(id)?.(id)) throw new Error('guard');
        spoken.push(text);
      } catch { refused.push(text); }
    },
    stop: () => {}, ended: () => {}, rememberVision: () => {}, rememberAmbient: () => {},
  });
  const readPorts: ReadGameLinePorts = {
    companion: () => ({ id: OWNER, send: (_channel, value) => { held.sense(value); } }),
    proof: () => proof,
    begin: opts.begin === false ? () => {} : (owner, id) => { styles.begin(owner, id, SCOPE); styles.complete(owner, id, SCOPE, MOOD, STYLE); },
    guard: (_owner, id, canSpeak) => { guards.set(id, canSpeak); },
  };
  const ports: GameLinePorts = { chatBusy: () => false, voiceOn: () => opts.voiceOn !== false,
    hold: (id, text) => { proof.sent(id, text); if (opts.paintMs !== null) setTimeout(() => { if (proof.currentId === id) proof.paint(); }, opts.paintMs ?? 8); return true; }, // the page paints it a little later
    read: (id, text) => readGameLine(readPorts, id, text), skipped: (id, why) => { skipped.push(`${id} ${why}`); }, unread: why => { unread.push(why); } };
  return { relay: new GameLineRelay(ports), spoken, refused, unread, skipped, proof };
}
const view = (id: string, text: string) => ({ say: { id, text } });

test('full screen: every line of the game reaches the voice once, in order (opening, reveal, result, end)', async () => {
  const lines = ['来，我先出！', '我出剪刀！', '这局你赢了。', '三局两胜，我输了。'];
  const a = app();
  // each line is read before the next is shown (the game waits for the reading time); a view sent twice is relayed once
  for (const [index, text] of lines.entries()) { a.relay.view(view(`g${index}`, text)); a.relay.view(view(`g${index}`, text)); await later(40); }
  assert.deepEqual(a.spoken, lines);
  assert.deepEqual(a.refused, []);
  assert.deepEqual(a.unread, []);
});

test('full screen: the voice refuses a line before her page has painted it, so the hand-over waits for the paint (the 11-26 failure)', async () => {
  const a = app({ paintMs: 30 });
  a.relay.view(view('g1', '我出石头！'));
  await later(10);
  assert.deepEqual(a.refused, [], 'not handed over while the bubble is not painted');
  assert.deepEqual(a.spoken, []);
  await later(60);
  assert.deepEqual(a.spoken, ['我出石头！']);
  assert.deepEqual(a.refused, []);
});

test('full screen: a line whose reading style was never begun is refused by the voice (the other quiet refusal), so begin is part of the hand-over', async () => {
  const broken = app({ begin: false });
  broken.relay.view(view('g1', '我出石头！')); await later(40);
  assert.deepEqual(broken.spoken, [], 'without a begun style the voice never plays it');
  assert.deepEqual(broken.refused, ['我出石头！']);
  const ok = app();
  ok.relay.view(view('g1', '我出石头！')); await later(40);
  assert.deepEqual(ok.spoken, ['我出石头！']);
});

test('the hand-over begins the style and sets the guard for the window that reads, before the window hears of the line', async () => {
  const log: string[] = [];
  const proof = new FakeProof(); proof.sent('x', '嗯'); proof.paint();
  const answer = await readGameLine({ companion: () => ({ id: 9, send: (channel, value) => { log.push(`send ${channel} ${value.id} ${value.held} ${value.game}`); } }),
    proof: () => proof, begin: (owner, id) => { log.push(`begin ${owner} ${id}`); }, guard: (owner, id) => { log.push(`guard ${owner} ${id}`); } }, 'x', '嗯');
  assert.equal(answer, true);
  assert.deepEqual(log, ['begin 9 x', 'guard 9 x', 'send desk:sense-line x true true']);
});

test('a bubble that never paints or was replaced, a style that cannot be set up, a missing window or proof: not read, and the journal says why', async () => {
  const proof = new FakeProof(); proof.sent('a', 't'); proof.paint();
  const base: ReadGameLinePorts = { companion: () => ({ id: 1, send: () => {} }), proof: () => proof, begin: () => {}, guard: () => {} };
  assert.equal(await readGameLine({ ...base, begin: () => { throw new Error('no'); } }, 'a', 't'), false);
  assert.equal(await readGameLine({ ...base, companion: () => null }, 'a', 't'), false);
  assert.equal(await readGameLine({ ...base, proof: () => null }, 'a', 't'), false);
  assert.equal(await readGameLine(base, 'other', 't'), 'bubble-hidden', 'her bubble holds another line now');
  const unpainted = new FakeProof(); unpainted.sent('a', 't');
  const racing = readGameLine({ ...base, proof: () => unpainted }, 'a', 't');
  unpainted.sent('b', 'newer'); // a newer line replaced it before it was ever painted
  assert.equal(await racing, 'bubble-hidden');
  const rows: string[] = [];
  const relay = (read: GameLinePorts['read']) => new GameLineRelay({ chatBusy: () => false, hold: () => true, voiceOn: () => true, read, skipped: () => {}, unread: why => { rows.push(why); } });
  relay(() => readGameLine({ ...base, begin: () => { throw new Error('no'); } }, 'a', 't')).view(view('a', 't')); await later(10);
  relay(() => readGameLine({ ...base, proof: () => unpainted }, 'zzz', 'nothing')).view(view('zzz', 'nothing')); await later(10);
  relay(() => Promise.reject(new Error('boom'))).view(view('y', 'y')); await later(10);
  assert.deepEqual(rows, ['voice-failed', 'bubble-hidden', 'voice-failed']);
});

test('read-aloud off: nothing is read and the journal row says voice-off; no style is begun', async () => {
  const a = app({ voiceOn: false });
  a.relay.view(view('g1', '嗯')); await later(40);
  assert.deepEqual(a.spoken, []);
  assert.deepEqual(a.unread, ['voice-off']);
});
