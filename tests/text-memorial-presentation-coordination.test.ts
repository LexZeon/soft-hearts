import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { TextMemorialOfferController } from '../src/ui/TextMemorialOffer';
import type { TextMemorialEvent } from '../shared/text-memorials';

// Extract the real main.ts callbacks so this integration test exercises the actual
// eligibility and publish wiring with the real readout and offer controller.
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function property(name: string, parentText: string): string {
  const found: ts.PropertyAssignment[] = [];
  function visit(n: ts.Node) {
    if (ts.isPropertyAssignment(n) && n.name.getText(ast) === name && n.parent.getText(ast).includes(parentText)) found.push(n);
    ts.forEachChild(n, visit);
  }
  visit(ast); assert.equal(found.length, 1, name); return found[0].initializer.getText(ast);
}
const currentSource = property('current', 'provisionalMemorialId = offer.id');
const publishSource = property('publish', 'provisionalMemorialId = offer.id');
const speakingSource = property('onSpeaking', 'speechChannel.postMessage(active)');
const code = transformSync(`function make(replyPresentation, calls) {
  let petUI = { showAnswer: (_text, _stream, id) => calls.push('publish:' + id) };
  let hostVisible = true, activeChat = null, ordinaryReplyPresentation = null, voicePlaybackActive = false, provisionalMemorialId = null;
  const $ = () => ({value: ''});
  const speech = { stop: () => calls.push('stop') };
  const window = { desktop: { updatePetReply: async () => {}, setAmbientAudioSpeaking: async () => {} } };
  const stage = {setSpeaking() {}}, mediaInput = {setSpeaking() {}}, ambientAudioController = {setSpeaking() {}}, speechChannel = {postMessage() {}};
  return { current: ${currentSource}, publish: ${publishSource}, speaking: ${speakingSource},
    plan: value => { ordinaryReplyPresentation = value; } };
} return make;`, {loader:'ts',target:'es2022'}).code;
const make = new Function(code)() as (readout: ReplyPresentationState, calls: string[]) => {
  current: () => boolean; publish: (offer: any) => Promise<void>; speaking: (active: boolean) => void; plan: (value: any) => void;
};
const offer = (id: string) => ({ id, invite: 'Please remember this?', quote: 'this', purpose: 'memory' });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  let now = 0, timer: (() => void) | null = null;
  const clock = { now: () => now, set: (fn: () => void, _delay: number) => { timer = fn; return 1 as any; }, clear: () => { timer = null; } };
  const readout = new ReplyPresentationState(clock); const calls: string[] = []; const glue = make(readout, calls);
  let event!: (event: TextMemorialEvent) => void;
  const controller = new TextMemorialOfferController({
    onTextMemorialEvent: cb => {event = cb; return () => {};},
    getCurrentTextMemorialOffer: () => new Promise(() => {}),
    acknowledgeTextMemorial: async ({id}) => {calls.push('ack:' + id); return null;},
  }, { current: glue.current, publish: glue.publish, retract: () => {}, commit: () => {} });
  return { readout, calls, glue, controller, send(id: string, revision: number) {event({type:'offer', revision, offer:offer(id)});},
    advance() { assert.ok(timer); const run = timer; timer = null; now += 5000; run(); } };
}
test('actual offer ignores DONE while real voice-off readout is pending and never replays it', async () => {
  const f = fixture(); const paints: string[] = [];
  f.readout.startReadout('reply', prefix => paints.push(prefix));
  f.readout.readoutContent('reply', 'First sentence. Second sentence. Third sentence.');
  let drained = false; f.readout.finishReadout('reply', () => {drained = true;});
  assert.equal(f.readout.readoutPending, true); f.send('old', 1); await tick();
  assert.deepEqual(f.calls, []); assert.equal(drained, false);
  while (!drained) f.advance(); assert.equal(f.readout.readoutPending, false); await tick(); assert.deepEqual(f.calls, []);
  f.send('later', 2); await tick(); assert.deepEqual(f.calls, ['stop', 'publish:later', 'ack:later']);
  assert.equal(paints.at(-1), 'First sentence. Second sentence. Third sentence.'); f.controller.dispose();
});
test('actual offer cannot stop ordinary logical speech plan or speaking callback, including segment gap', async () => {
  const f = fixture(); f.glue.plan({id:'ordinary'}); f.glue.speaking(true);
  f.send('playing', 1); await tick(); assert.deepEqual(f.calls, []);
  f.glue.speaking(false); f.send('gap', 2); await tick(); assert.deepEqual(f.calls, []);
  f.glue.plan(null); await tick(); assert.deepEqual(f.calls, []);
  f.glue.speaking(true); f.send('playback', 3); await tick(); assert.deepEqual(f.calls, []);
  f.glue.speaking(false); await tick(); assert.deepEqual(f.calls, []);
  f.send('later', 4); await tick(); assert.deepEqual(f.calls, ['stop', 'publish:later', 'ack:later']); f.controller.dispose();
});
