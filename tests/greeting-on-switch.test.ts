// 2026-11-25 (docs/claude/2026-11-25-greeting-on-switch.md). In every character's bubble, with no voice.
// Cause: after a restart the host's conversation is a new one (empty), so the window found "no conversation" and showed her card's
// greeting even for a character who talked with the user long ago. Now the host says whether she ever opened with the user
// (RecentChat.opened) and the window shows the greeting only for a character who never did; when shown it is read aloud and journalled.
// Real CompanionService and chat memory (temporary folder); the window's decision is the same function the window calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, type CompanionTurn } from '../electron/brain/companion';
import { GreetingArchive } from '../electron/brain/long-chat/greeting';
import type { ProviderConfig } from '../shared/foundation/settings';
import { mayShowOpeningGreeting } from '../src/brain/greeting-gate';
import { presentGreetingLine, type GreetingPorts } from '../src/brain/greeting-presenter';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
const GENE = '角色名称：Gene', AOI = '角色名称：小葵';
const GREETINGS: Record<string, string> = { gene: 'Partner, are you online?', aoi: '小葵来啦！' };

function tail(turn: CompanionTurn, body: string): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening);
  return `${body}\n${opening}${JSON.stringify({ context: 'positive', delta: { O: 1 }, confidence: 0.8, reason: '聊天' })}${opening.replace('<', '</')}`;
}
async function say(service: CompanionService, id: string, text: string, reply: string, persona: string): Promise<void> {
  const turn = await service.begin(id, text, persona, () => {});
  turn.push('delta', tail(turn, reply));
  await turn.finish('complete');
}
async function open(directory: string, character = 'gene', persona = GENE, config: ProviderConfig = provider): Promise<CompanionService> {
  const service = new CompanionService(directory, () => {}); await service.load(); await service.context(character, config, persona); return service;
}
/** What the window decides right after a switch or a start: ask the host, then the gate (the greeted set is the window's own, empty at a start). */
const windowShows = (service: CompanionService, id: string, greeted: ReadonlySet<string> = new Set()) => mayShowOpeningGreeting(service.recentChat(), id, id, greeted);

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-greeting-switch-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

test('a character who talked with the user is not greeted after a restart (the reported bug), a brand-new one is', async () => {
  await withDirectory(async directory => {
    const first = await open(directory);
    assert.equal(windowShows(first, 'gene'), true, 'nothing yet: her own greeting once');
    await say(first, 'g1', '这是很久以前的话', '嗯。', GENE);
    await first.flush();
    // The restart: a new service on the same folder; its conversation is a new one, so the window's own list is empty.
    const second = await open(directory);
    assert.deepEqual(second.recentChat().messages, [], 'the window finds no conversation of this run');
    assert.equal(second.recentChat().opened, true);
    assert.equal(windowShows(second, 'gene'), false, 'but she talked with the user: no greeting');
    await second.context('aoi', provider, AOI);
    assert.equal(windowShows(second, 'aoi'), true, 'a character with no past gets her own greeting');
    await second.flush();
  });
});

test('every switch between characters with a past is quiet, with the other kinds of past too', async () => {
  await withDirectory(async directory => {
    const service = await open(directory);
    await say(service, 'g1', '嗨', '嗨嗨。', GENE);
    await service.context('aoi', provider, AOI); await say(service, 'a1', '小葵你好', '你好呀。', AOI);
    await service.flush();
    const again = await open(directory);
    for (const id of ['gene', 'aoi', 'gene', 'aoi']) {
      await again.context(id, provider, id === 'gene' ? GENE : AOI);
      assert.equal(windowShows(again, id), false, `${id} switching in`);
    }
    // A new conversation she then left does not make her new again; another connection (model alias) is still the same character.
    await again.newConversation();
    assert.equal(windowShows(again, 'aoi'), false, 'the explicit new conversation does not turn her into a stranger');
    await again.context('aoi', { ...provider, model: 'sonnet' }, AOI);
    assert.equal(windowShows(again, 'aoi'), false, 'the past under the other connection counts');
    await again.flush();
  });
});

test('her greeting, once shown and archived, is not shown again; her other own lines do not count as having opened', async () => {
  await withDirectory(async directory => {
    const service = await open(directory, 'aoi', AOI);
    const scope = service.currentScope();
    const rows: string[] = [];
    const archive = new GreetingArchive({ enabled: true, memory: () => service.memory, scope: () => service.currentScope(), greeting: () => GREETINGS.aoi, identity: () => 'x', id: () => `greeting-${rows.length + 1}`,
      journal: (characterId, why) => { rows.push(`${characterId}:${why}`); } });
    // An observation of hers (no greeting) is not an opening.
    const at = Date.now() - 5000;
    await service.memory.appendInitiative(scope, { id: 'obs', text: '你在看视频呢', at, origin: { kind: 'proactive', id: 'obs', at, sources: ['screen'], labels: ['屏幕'] } });
    assert.equal(windowShows(service, 'aoi'), true, 'an observation is not the user talking with her');
    assert.equal(await archive.remember(), true);
    assert.equal(windowShows(service, 'aoi'), false, 'her greeting was shown: not again');
    assert.deepEqual(rows, ['aoi:first'], 'one journal row, which card and why');
    await service.flush();
    assert.equal(windowShows(await open(directory, 'aoi', AOI), 'aoi'), false, 'also after a restart');
  });
});

test('the guards: another card, a late answer, a failed call, a switch that moved on, and the same window twice', async () => {
  await withDirectory(async directory => {
    const service = await open(directory);
    const recent = service.recentChat();
    assert.equal(mayShowOpeningGreeting(recent, 'aoi', 'aoi', new Set()), false, 'the answer is for gene, not for the card asked about');
    assert.equal(mayShowOpeningGreeting(recent, 'gene', 'aoi', new Set()), false, 'she is no longer the active character');
    assert.equal(mayShowOpeningGreeting(undefined, 'gene', 'gene', new Set()), false, 'a failed call shows nothing');
    assert.equal(mayShowOpeningGreeting(recent, null, null, new Set()), false);
    assert.equal(mayShowOpeningGreeting(recent, 'gene', 'gene', new Set(['gene'])), false, 'this window greeted her already this run');
    assert.equal(mayShowOpeningGreeting({ ...recent, opened: undefined }, 'gene', 'gene', new Set()), true, 'archive off: the host cannot say, once per run');
    assert.equal(mayShowOpeningGreeting({ ...recent, opened: undefined }, 'gene', 'gene', new Set(['gene'])), false);
    await service.flush();
  });
});

test('the archive journals one row per shown greeting (both windows ask): first for a stranger, new-chat once she has talked with the user', async () => {
  await withDirectory(async directory => {
    const service = await open(directory);
    const rows: string[] = []; let now = 1_000_000;
    const archive = new GreetingArchive({ enabled: false, memory: () => service.memory, scope: () => service.currentScope(), greeting: () => GREETINGS.gene, identity: () => 'x', id: () => 'g', now: () => now,
      journal: (characterId, why) => { rows.push(`${characterId}:${why}`); } });
    await Promise.all([archive.remember(), archive.remember()]);
    await say(service, 'g1', '聊了几句', '嗯。', GENE);
    now += 60_000; await archive.remember();
    assert.deepEqual(rows, ['gene:first', 'gene:new-chat']);
    await service.flush();
  });
});

function ports(over: Partial<GreetingPorts> = {}, log: string[] = []): GreetingPorts {
  return {
    card: () => ({ id: 'gene', greeting: GREETINGS.gene }), companionBubble: (text, id, voiced) => { log.push(`bubble:${text}:${voiced}`); },
    row: text => { log.push(`row:${text}`); }, mayVoice: () => true, stopSpeech: () => { log.push('stop'); },
    speak: async (text, id) => { log.push(`speak:${text}:${id}`); }, ended: id => { log.push(`ended:${id}`); },
    remember: () => { log.push('remember'); }, newId: () => 'greeting-1', ...over };
}

test('her greeting is read aloud in the companion window when read-aloud is on (it was silent), and archived with its reason', async () => {
  const log: string[] = [], greeted = new Set<string>();
  assert.equal(presentGreetingLine(ports({}, log), greeted), GREETINGS.gene);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['bubble:Partner, are you online?:true', 'stop', 'speak:Partner, are you online?:greeting-1', 'remember', 'ended:greeting-1']);
  assert.ok(greeted.has('gene'));
});

test('read-aloud off or she cannot be heard: the bubble shows, no voice; the chat page only draws a row; no greeting shows nothing', async () => {
  const quiet: string[] = [];
  presentGreetingLine(ports({ mayVoice: () => false }, quiet), new Set());
  assert.deepEqual(quiet, ['bubble:Partner, are you online?:false', 'remember']);
  const page: string[] = [];
  presentGreetingLine(ports({ companionBubble: null }, page), new Set());
  assert.deepEqual(page, ['row:Partner, are you online?', 'remember']);
  const none: string[] = [];
  assert.equal(presentGreetingLine(ports({ card: () => ({ id: 'gene', greeting: '  ' }) }, none), new Set()), null);
  assert.equal(presentGreetingLine(ports({ card: () => null }, none), new Set()), null);
  assert.deepEqual(none, []);
});
