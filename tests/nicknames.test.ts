/**
 * 外号 (docs/claude/2026-11-07-nicknames.md): the user's nickname for HER and "叫我 Y" are found by the I-023 haiku router after her
 * reply, saved in the relationship file, and told to her in every session opening. Fake haiku, synthetic names, temp folders only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { ModuleRouter } from '../electron/module-router/router';
import { RelationshipHost } from '../electron/relationship/host';
import { createNicknameRoute } from '../electron/relationship/nickname-route';
import { RelationshipStore, relationshipFileName } from '../electron/relationship/store';
import { parseRouterAnswer, routerPlan, routerRegistryProblems } from '../shared/module-router/choose';
import { scriptedRouterAsk } from '../shared/module-router/fake';
import { MODULE_ROUTER_KNOBS } from '../shared/module-router/knobs';
import { ROUTED_MODULES } from '../shared/module-router/modules';
import { emptyRelationship, relationshipOpeningText, relationshipSessionTag, type RelationshipDiagnostic } from '../shared/relationship';

const provider = { kind: 'claude' as const, baseUrl: 'https://nicknames.invalid/v1', model: 'fixture' };
const HER = '团子', ME = '阿蓝', HER_LINE = /用户叫你“团子”/u;

class Clock {
  now = Date.UTC(2026, 10, 7, 6, 0, 0); private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly timerApi = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + ms, fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
  }
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function run(clock: Clock, ms: number): Promise<void> { for (let t = 0; t < ms; t += 50) { clock.advance(Math.min(50, ms - t)); await flush(); } }
const answer = (...calls: { module: string; confidence?: number; name?: string }[]) =>
  JSON.stringify({ called: calls.map(call => ({ module: call.module, confidence: call.confidence ?? 0.9, ...(call.name !== undefined ? { name: call.name } : {}) })) });

function routerOver(clock: Clock, script: (message: string) => string | null) {
  const ask = scriptedRouterAsk(message => { const raw = script(message); return raw === null ? null : { raw }; });
  const router = new ModuleRouter({ ask, available: () => true, developerMode: () => false, clock: () => clock.now, timers: clock.timerApi });
  return { router, ask };
}

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-nicknames-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const host = (directory: string, journal: RelationshipDiagnostic[] = []) =>
  new RelationshipHost({ directory, developerMode: () => false, journal: (_id, entry) => { journal.push(entry); } });
/** One finished chat turn on a CompanionService. */
async function chat(service: CompanionService, id: string, text: string) {
  const turn = await service.begin(id, text, 'Gene', () => {});
  const marker = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(marker);
  turn.push('delta', `好的。\n${marker}${JSON.stringify({ context: 'neutral', delta: {}, confidence: 0.9, reason: '测试' })}${marker.replace('<', '</')}`);
  await turn.finish('complete');
  await service.relationship.flush();
  return turn;
}
async function service(directory: string): Promise<CompanionService> {
  const s = new CompanionService(directory, () => {});
  await s.load(); await s.context('gene', provider, 'Gene');
  return s;
}

// ------------------------------------------------------------------ restart: the real failure

test('a nickname given in one session is in the next session\'s opening, after a restart (real host + store over a temp folder)', async () => {
  await withDirectory(async directory => {
    const first = host(directory);
    await first.ensure('gene');
    assert.doesNotMatch(first.opening('gene', { firstTurn: true })!.text, /用户叫你/u, 'nothing before she is given one');
    assert.equal(await first.noteHerNickname('gene', HER), 'saved');
    assert.equal(await first.noteUserNickname('gene', ME), 'saved');
    await first.flush();
    // A new process: a new host over the same folder.
    const second = host(directory);
    await second.ensure('gene');
    const opening = second.opening('gene', { firstTurn: true })!;
    assert.match(opening.text, HER_LINE);
    assert.match(opening.text, /早就知道/u);
    assert.match(opening.text, /“阿蓝”/u, 'the user\'s own nickname is told as before');
    assert.equal(second.herNickname('gene'), HER);
    assert.ok(opening.tag.includes(HER), 'a new nickname restarts the open session, like the user nickname does');
  });
});

test('through the chat: the router finds the nickname after her reply, and the next process\'s first turn opens with it', async () => {
  await withDirectory(async directory => {
    const clock = new Clock();
    const { router } = routerOver(clock, message => message.includes('叫你团子') ? answer({ module: 'nickname-her', name: HER }) : answer());
    const one = await service(directory);
    one.setNicknameRoute(createNicknameRoute({ verdict: (id, module) => router.verdict(id, module), relationship: one.relationship }));
    router.userTurn('t1', '以后就叫你团子好不好');
    const first = chat(one, 't1', '以后就叫你团子好不好');
    await run(clock, 400); // haiku starts 300 ms later and answers
    const turn = await first;
    assert.doesNotMatch(turn.relationshipOpening!, /用户叫你/u, 'this very turn was already written');
    await run(clock, 100);
    await one.relationship.flush();
    assert.equal(one.relationship.herNickname('gene'), HER);
    await one.flush();
    const two = await service(directory);
    const next = await chat(two, 't2', '早');
    assert.match(next.relationshipOpening!, HER_LINE);
    assert.match(next.persona, HER_LINE);
    await two.flush();
  });
});

// ------------------------------------------------------------------ the router path

test('router: one haiku call per message, started after the delay (her first character never waits), name carried back', async () => {
  const clock = new Clock();
  const { router, ask } = routerOver(clock, () => answer({ module: 'nickname-her', name: HER }, { module: 'nickname-user', name: ME }));
  router.userTurn('m1', '以后叫你团子，你也叫我阿蓝吧');
  assert.equal(ask.calls.length, 0, 'userTurn returned at once; haiku has not even started');
  await run(clock, MODULE_ROUTER_KNOBS.startDelayMs + 100);
  assert.equal(ask.calls.length, 1, 'one call for both nickname modules');
  const her = await router.verdict('m1', 'nickname-her'), user = await router.verdict('m1', 'nickname-user');
  assert.equal(her.kind, 'called'); assert.equal(user.kind, 'called');
  assert.equal(her.kind === 'called' && her.name, HER); assert.equal(user.kind === 'called' && user.name, ME);
  // A message without any naming words is not asked at all.
  router.userTurn('m2', '今天好累啊');
  await run(clock, 600);
  assert.equal(ask.calls.length, 1);
});

test('router: both names are saved by the route (her nickname as hers, the user\'s own words as theirs); invalid names and low confidence are ignored', async () => {
  await withDirectory(async directory => {
    const clock = new Clock();
    const h = host(directory); await h.ensure('gene');
    const replies: Record<string, string> = {
      '以后叫你团子，你也叫我阿蓝': answer({ module: 'nickname-her', name: HER }, { module: 'nickname-user', name: ME }),
      '我给你起个名叫这个名字实在是太长太长太长了': answer({ module: 'nickname-her', name: '这个名字实在是太长太长太长了' }),
      '叫我<script>': answer({ module: 'nickname-user', name: '<script>' }),
      '叫你小豆好了': answer({ module: 'nickname-her', confidence: 0.3, name: '小豆' }),
      '叫你Gene呀': answer({ module: 'nickname-her', name: 'gene' }),
    };
    const { router } = routerOver(clock, message => replies[message] ?? null);
    const route = createNicknameRoute({ verdict: (id, module) => router.verdict(id, module), relationship: h, cardName: () => 'Gene' });
    let n = 0;
    const turn = async (text: string) => { const id = `r${++n}`; router.userTurn(id, text); await run(clock, 400); route(id, 'gene'); await run(clock, 100); await flush(); await h.flush(); await flush(); await h.flush(); };
    await turn('我给你起个名叫这个名字实在是太长太长太长了');
    await turn('叫我<script>');
    await turn('叫你小豆好了');
    await turn('叫你Gene呀');
    assert.equal(h.herNickname('gene'), null); assert.equal(h.nickname('gene'), null);
    await turn('以后叫你团子，你也叫我阿蓝');
    assert.equal(h.herNickname('gene'), HER); assert.equal(h.nickname('gene'), ME);
  });
});

test('a bad or oversized answer, an extra key, or a name on a module that carries none is no answer', () => {
  const reg = ROUTED_MODULES;
  assert.deepEqual(routerRegistryProblems(reg), []);
  assert.deepEqual(parseRouterAnswer(answer({ module: 'nickname-her', name: HER }), reg), [{ module: 'nickname-her', confidence: 0.9, name: HER }]);
  assert.equal(parseRouterAnswer(answer({ module: 'rps', name: HER }), reg), null, 'rps carries no name');
  assert.equal(parseRouterAnswer('{"called":[{"module":"nickname-her","confidence":0.9,"name":"x","extra":1}]}', reg), null);
  assert.equal(parseRouterAnswer(answer({ module: 'nickname-her', name: 'x'.repeat(41) }), reg), null);
  assert.equal(parseRouterAnswer(answer({ module: 'nickname-her' }), reg)?.[0].name, undefined, 'called without a name: nothing to save');
  const k = { prefilter: true, maxChars: 200 };
  assert.deepEqual(routerPlan(reg, '以后叫你团子好不好', k).asked, ['nickname-her', 'nickname-user']);
  assert.deepEqual(routerPlan(reg, '今天好累啊', k).asked, []);
});

test('the newest explicit request wins: "叫我 Y" replaces the user nickname, the journal says changed, the same name changes nothing', async () => {
  await withDirectory(async directory => {
    const journal: RelationshipDiagnostic[] = [];
    const h = host(directory, journal); await h.ensure('gene');
    assert.equal(await h.noteUserNickname('gene', ME), 'saved');
    assert.equal(await h.noteUserNickname('gene', ME), 'same');
    assert.equal(await h.noteUserNickname('gene', '小蓝'), 'changed');
    assert.equal(h.nickname('gene'), '小蓝');
    assert.equal(await h.noteUserNickname('gene', 'a very long unusable name'), 'invalid');
    assert.deepEqual(journal.map(entry => entry.kind), ['nickname-saved', 'nickname-changed']);
    assert.equal(await h.noteHerNickname('gene', HER), 'saved');
    assert.equal(await h.noteHerNickname('gene', HER), 'same');
    assert.equal(await h.noteHerNickname('gene', '汤圆'), 'saved');
    assert.equal(h.herNickname('gene'), '汤圆');
  });
});

// ------------------------------------------------------------------ files and privacy

test('an older relationship file (no herNickname) loads fine and later writes keep everything else', async () => {
  await withDirectory(async directory => {
    const old = emptyRelationship('2026-10-01') as unknown as Record<string, unknown>;
    delete old.herNickname; old.nickname = ME; old.nicknameAsked = true;
    await mkdir(path.join(directory, 'relationship'), { recursive: true });
    const file = path.join(directory, 'relationship', relationshipFileName('gene'));
    await writeFile(file, JSON.stringify(old));
    const store = new RelationshipStore(directory, { today: () => '2026-11-07' });
    const loaded = await store.load('gene');
    assert.equal(loaded.herNickname, null); assert.equal(loaded.nickname, ME); assert.equal(loaded.metDate, '2026-10-01');
    const h = host(directory); await h.ensure('gene');
    assert.doesNotMatch(h.opening('gene', { firstTurn: false })!.text, /用户叫你/u);
    assert.equal(await h.noteHerNickname('gene', HER), 'saved'); await h.flush();
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.herNickname, HER); assert.equal(saved.nickname, ME); assert.equal(saved.metDate, '2026-10-01');
    // A file with a broken herNickname is refused like any other broken file (left alone, never overwritten).
    await writeFile(file, JSON.stringify({ ...saved, herNickname: '<bad>' }));
    const refused = new RelationshipStore(directory, { today: () => '2026-11-07' });
    assert.equal((await refused.load('gene')).herNickname, null);
  });
});

test('neither nickname ever reaches the journal or the developer file (numbers only)', async () => {
  await withDirectory(async directory => {
    const journal: RelationshipDiagnostic[] = [], lines: string[] = [];
    const h = new RelationshipHost({ directory, developerMode: () => true, journal: (_id, entry) => { journal.push(entry); }, diagnosticsWrite: async (_file, line) => { lines.push(line); } });
    await h.ensure('gene');
    await h.noteHerNickname('gene', HER); await h.noteUserNickname('gene', ME); await h.noteUserNickname('gene', '小蓝'); await h.flush();
    assert.ok(journal.some(entry => entry.kind === 'her-nickname-saved'));
    const text = JSON.stringify(journal) + lines.join('');
    for (const secret of [HER, ME, '小蓝']) assert.equal(text.includes(secret), false, secret);
    assert.equal(h.view('gene')!.hasNickname, true);
    assert.equal(JSON.stringify(h.view('gene')).includes(HER), false, 'the developer view carries no text');
  });
});

test('the wording: her line is one sentence that leaves her voice to her, and a new nickname changes the session tag', () => {
  const base = { dayNumber: 3, slowWarmUp: false };
  const line = relationshipOpeningText({ ...base, herNickname: HER }).split('\n')[1];
  assert.match(line, /用户叫你“团子”，这是你们之间的称呼，你早就知道、也接受了/u);
  assert.doesNotMatch(line, /必须|一定要/u);
  assert.equal(relationshipSessionTag({ ...base }), 'off|', 'unchanged for everyone without one');
  assert.notEqual(relationshipSessionTag({ ...base, herNickname: HER }), relationshipSessionTag({ ...base, herNickname: '汤圆' }));
});
