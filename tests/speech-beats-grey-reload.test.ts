// 边说边演的灰色小字，重新读出历史以后还在.
// A reply that was only a performance has no words in the chat archive (its body is empty), so the history the host hands a window after a
// card change (recentChat) used to leave that whole turn out. Now the host also hands a display list that has the user's line and the grey
// line of that reply (from speech-beats.json by turn id); the windows draw it, and her own history (what the next message carries to
// Claude) stays exactly what it was: never her words, never a made-up "(she smiled shyly)".
// Real CompanionService and chat memory in a temporary folder; the windows' side is the pure restore function the chat wiring uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, type CompanionTurn } from '../electron/brain/companion';
import { speechBeatsFor } from '../electron/brain/speech-beats/host';
import { cleanChatRows, restoredChatHistory, restoredChatRows } from '../src/brain/chat-continuity';
import type { ProviderConfig } from '../shared/foundation/settings';

const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
const GENE = '角色名称：Gene';

async function withService(run: (service: CompanionService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-grey-reload-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', provider, GENE); await run(service, directory); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
function tail(turn: CompanionTurn, body: string): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening);
  return `${body}\n${opening}${JSON.stringify({ context: 'positive', delta: { O: 1 }, confidence: 0.8, reason: '聊天' })}${opening.replace('<', '</')}`;
}
async function say(service: CompanionService, id: string, text: string, reply: string): Promise<void> {
  const turn = await service.begin(id, text, GENE, () => {});
  turn.push('delta', tail(turn, reply));
  await turn.finish('complete');
}
/** A turn whose reply was only a performance: nothing in the archive but an empty complete reply; its beats and grey line are in the beats file. */
async function perform(service: CompanionService, directory: string, id: string, text: string, line: string): Promise<void> {
  const turn = await service.begin(id, text, GENE, () => {});
  await turn.finish('complete');
  await speechBeatsFor(directory).archive.record(service.currentScope(), id, { beats: [{ word: 'shy', at: 0 }], line, performanceOnly: true });
}
const rows = (service: CompanionService) => restoredChatRows(service.recentChat(), 'gene', 'gene')?.map(row => `${row.role}${row.performed ? '*' : ''}:${row.content}`) ?? null;
const history = (service: CompanionService) => restoredChatHistory(service.recentChat(), 'gene', 'gene').map(row => `${row.role}:${row.content}`);

test('a performance-only reply: the display list has the user\'s line and the grey line, her history is what it always was', async () => withService(async (service, directory) => {
  await say(service, 't1', '今天好累', '抱抱。');
  await perform(service, directory, 't2', '我给你泡了茶', '她害羞地笑了');
  await say(service, 't3', '谢谢你', '不客气。');
  assert.deepEqual(rows(service), ['user:今天好累', 'assistant:抱抱。', 'user:我给你泡了茶', 'assistant*:她害羞地笑了', 'user:谢谢你', 'assistant:不客气。']);
  assert.deepEqual(history(service), ['user:今天好累', 'assistant:抱抱。', 'user:谢谢你', 'assistant:不客气。'], 'her history never gets the grey line');
}));

test('no performance-only reply in the conversation: nothing new is handed over (the windows draw their history as before)', async () => withService(async (service) => {
  await say(service, 't1', '今天好累', '抱抱。');
  assert.equal(service.recentChat().shown, undefined);
  assert.equal(rows(service), null);
}));

test('a reply whose beats were deleted (or never recorded) stays out, as before', async () => withService(async (service, directory) => {
  await perform(service, directory, 't1', '我给你泡了茶', '她害羞地笑了');
  const scope = service.currentScope();
  const [recordId] = service.memory.recordIds(scope);
  assert.equal(await service.memory.delete(scope, recordId!), true);
  await speechBeatsFor(directory).archive.flush();
  assert.equal(service.recentChat().shown, undefined);
  assert.deepEqual(history(service), []);
}));

test('the grey line is bounded like the window\'s own history and only comes for the character it was asked for', async () => withService(async (service, directory) => {
  for (let i = 0; i < 20; i++) await perform(service, directory, `p${i}`, `第 ${i} 句`, `动作 ${i}`);
  const all = rows(service)!;
  assert.ok(all.length <= 24 && all.at(-1) === 'assistant*:动作 19', `${all.length} rows, the newest last`);
  assert.equal(restoredChatRows(service.recentChat(), 'aoi', 'gene'), null, 'another character\'s request gets nothing');
  assert.equal(restoredChatRows(service.recentChat(), 'gene', 'aoi'), null, 'a late answer after another switch gets nothing');
}));

test('cleanChatRows: only known roles and text come through, a list without a grey line draws nothing new', () => {
  assert.equal(cleanChatRows(undefined), null);
  assert.equal(cleanChatRows([{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗯' }]), null, 'no grey line: the page draws its history as before');
  const rows = cleanChatRows([{ role: 'system', content: '不是' }, { role: 'user', content: '  ' }, { role: 'user', content: '你好', performed: true }, { role: 'assistant', content: '她笑了', performed: true }, { role: 'assistant', content: 7 }]);
  assert.deepEqual(rows, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '她笑了', performed: true }], 'a user row is never a grey line');
  const many = cleanChatRows(Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i}`, ...(i === 59 ? { performed: true } : {}) })))!;
  assert.equal(many.length, 24);
  assert.equal(many.at(-1)!.performed, true);
});

test('the chat wiring draws the rows after a refill, carries them to the other window, and never puts them in her history', async () => {
  const wiring = await readFile(path.join(process.cwd(), 'src/wiring/chat-wiring.ts'), 'utf8');
  assert.match(wiring, /history = messages; rememberRefilledRows\(history, rows\); \/\/ /, 'history stays the clean messages; the rows are remembered beside it');
  assert.match(wiring, /else if \(rows\) drawChatRows\(rows\);/, 'the control window draws the rows');
  assert.match(wiring, /restoredChatRows\(recent, requestedFor, characterState\?\.activeId \?\? null\)/, 'the host\'s answer is checked for the same character as the history is');
  assert.match(wiring, /shown: refilledRowsFor\(history\)/, 'the other window asking for the state gets the rows too');
  assert.match(wiring, /rememberRefilledRows\(history, cleanChatRows\(message\.shown\)\);/, 'and draws them');
});
