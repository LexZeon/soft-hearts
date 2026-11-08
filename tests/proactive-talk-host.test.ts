/** 「她主动找你说话」 reaches the wired inner-loop host (electron/inner-loop/host.ts): the setting is read at each opportunity. No model call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { createInnerLoopHost } from '../electron/inner-loop/host';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { ProactiveTalk } from '../shared/behaviors/inner-rhythm/knobs';

const MINUTE = 60_000;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function secondAccepted(talk: (() => ProactiveTalk | undefined) | undefined, afterMinutes: number): Promise<boolean> {
  const state = { now: 1_000_000 };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('g');
  let calls = 0;
  const host = createInnerLoopHost({ gate, clock: () => state.now, random: () => 0, ...(talk ? { talk } : {}),
    setting: () => true, expressions: () => true, canExpress: () => true, current: () => true, characterId: () => 'gene', gateScope: () => 'g',
    parameters: () => DEFAULT_MOOD_PARAMETERS, fatiguePhase: () => 'awake',
    context: { localMinute: () => 15 * 60, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。', lastInteractionAt: () => state.now - 5 * MINUTE,
      profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' },
    decide: async () => { calls++; return { text: '{"action":"none"}' }; },
    realize: () => {}, releaseSpeech: () => {}, offer: () => {}, cancelOffer: () => {}, surface: () => null, presentationIdentity: () => 'id',
    archive: async () => {}, developerMode: () => false, diagnosticsFile: () => null, diagnosticsChanged: () => {} });
  const cue = (id: string) => ({ id, kind: 'motion' as const, at: state.now, until: state.now + 3_000 });
  assert.equal(host.loop.offerOpportunity(cue('a')), true); await flush(); assert.equal(calls, 1);
  state.now += afterMinutes * MINUTE; gate.setScope('g');
  const second = host.loop.offerOpportunity(cue('b')); await flush();
  host.loop.dispose(); gate.dispose();
  return second;
}

test('the next call is refused at 11 minutes with 少一点, and taken with 适中 and 多一点; 多一点 never goes under the old minimum', async () => {
  // The base spacing is 2 x the card's 5-minute motion interval = 10 minutes.
  assert.equal(await secondAccepted(() => 'normal', 11), true, '适中');
  assert.equal(await secondAccepted(undefined, 11), true, 'no reader: as before');
  assert.equal(await secondAccepted(() => 'less', 11), false, '少一点: the minimum is 20 minutes');
  assert.equal(await secondAccepted(() => 'less', 21), true, '少一点: 21 minutes is enough');
  assert.equal(await secondAccepted(() => 'more', 11), true, '多一点');
  assert.equal(await secondAccepted(() => 'more', 9), false, '多一点: not under today\'s 10 minutes');
  assert.equal(await secondAccepted(() => { throw new Error('unreadable'); }, 11), true, 'an unreadable setting counts as 适中');
});
