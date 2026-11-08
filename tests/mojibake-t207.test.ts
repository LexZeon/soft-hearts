// Codex T-207 (2026-11-04) counterexamples for the "UTF-8 read as GBK" filter (shared/mojibake.ts, electron/mood-chat.ts;
// docs/claude/2026-11-03-mojibake-guard.md, section "Codex T-207 反例和修复"). Each minimal case is Codex's, rewritten here;
// all failed on dae249b. The rule they hold: ordinary text is never changed (a garbled run may pass instead), not even the
// first garbled character reaches the bubble, the state tail does not depend on how the stream was cut, and what is archived
// is what was shown. Every sample is written for the test; no recorded chat is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canStartMojibake, cleanMojibake, gbkCode, MojibakeGuard } from '../shared/mojibake';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';

const garble = (text: string): string => new TextDecoder('gbk').decode(Buffer.from(text, 'utf8'));
const tail = (protocol: MoodReplyProtocol, reason = '测试') =>
  JSON.stringify({ context: 'neutral', delta: {}, reason, confidence: 0.9 }) + protocol.end;

/** One reply through the protocol, `chunks` as the model streamed them, then this turn's state tail. */
function play(chunks: string[]): { body: string; increments: string[] } {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => { if (text) increments.push(text); }, { chineseChat: true });
  for (const chunk of chunks) protocol.push(chunk);
  protocol.push('\n' + protocol.start + tail(protocol));
  protocol.finish();
  return { body: increments.join(''), increments };
}

test('T-207 M01: an ordinary name whose GBK bytes spell everyday characters stays as written, however it streams', () => {
  const said = '她叫宸风华。';
  assert.equal(garble('巷绪'), '宸风华', 'the fixture really is a byte collision');
  assert.equal(play([...said]).body, said);
  assert.equal(play([said]).body, said);
  assert.equal(cleanMojibake(said).text, said);
});

test('T-207 M01b: a Unicode identifier in an inline code example stays literal', () => {
  const said = '变量是 `const 宸风华 = "🌙";`';
  assert.equal(play([said]).body, said);
  assert.equal(play([...said]).body, said);
});

test('T-207 M01: no three-character name (a possible start + two everyday characters) is rewritten, even when its bytes decode', () => {
  // Every start character, a spread of everyday second and third characters chosen so the bytes line up as UTF-8.
  const decoder = new TextDecoder('gbk');
  const everyday: string[] = [];
  const starts: string[] = [];
  for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
    if (trail === 0x7f) continue;
    const char = decoder.decode(new Uint8Array([lead, trail]));
    if (char.length !== 1 || char === '\ufffd') continue;
    if (lead >= 0xb0 && lead <= 0xbf && trail >= 0xa1) everyday.push(char); // GB2312 level-1 rows whose lead byte continues UTF-8
    if (canStartMojibake(char)) starts.push(char);
  }
  const seconds = everyday.filter(char => (gbkCode(char) & 0xff) >= 0xe4 && (gbkCode(char) & 0xff) <= 0xe9);
  const thirds = everyday.filter(char => (gbkCode(char) & 0xff) <= 0xbf);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const isEveryday = (char: string) => { const code = gbkCode(char); return (code >> 8) >= 0xb0 && (code >> 8) <= 0xd7 && (code & 0xff) >= 0xa1; };
  let collisions = 0, tried = 0;
  for (const [i, start] of starts.entries()) for (const second of [seconds[i % seconds.length], seconds[(i * 7 + 3) % seconds.length]]) for (const third of thirds) {
    const name = start + second + third;
    const bytes = [...name].flatMap(char => [gbkCode(char) >> 8, gbkCode(char) & 0xff]);
    // A real collision: the bytes spell two everyday characters, as "宸风华" spells "巷绪".
    try { const spelled = [...utf8.decode(new Uint8Array(bytes))]; if (spelled.length === 2 && spelled.every(isEveryday)) collisions++; } catch { /* no */ }
    tried++;
    const text = `她叫${name}。`;
    assert.equal(cleanMojibake(text).text, text, JSON.stringify(text));
  }
  assert.ok(collisions >= 1_000, `the sample must contain real byte collisions (${collisions} of ${tried})`);
});

test('T-207 M02: repairing a garbled run never drops the ordinary Japanese right after it', () => {
  for (const chunks of [[...garble('你好'), ...'凪だよ'], [garble('你好') + '凪だよ']]) assert.equal(play(chunks).body, '你好凪だよ');
  // Other rare GBK characters of ordinary text after a cleanly ended run: Traditional Chinese, Japanese kanji.
  for (const after of ['們今天', '這樣啊', '凪の日', '辻さん'])
    assert.equal(cleanMojibake(garble('你好') + after).text, '你好' + after, after);
});

test('T-207 M03: a garbled character from beyond the BMP is held from its first character and comes back whole', () => {
  const original = '𠮷野家';
  const garbled = garble(original);
  assert.equal(garbled.includes('\ufffd'), false, 'the fixture loses no byte');
  const [first, ...rest] = garbled;
  assert.equal(canStartMojibake(first), true);
  const { body, increments } = play([first, ...rest]);
  assert.deepEqual(increments.filter(piece => [...piece].some(char => !original.includes(char))), [], 'no garbled character went out');
  assert.equal(body, original);
  const guard = new MojibakeGuard();
  assert.equal(guard.push(first), '', 'the very first push shows nothing of it');
});

test('T-207 M04: a heart emoji with its variation selector before Chinese is repaired whole', () => {
  const original = '❤️你好';
  const garbled = garble(original);
  assert.equal(garbled.includes('\ufffd'), false, 'the fixture loses no byte');
  assert.equal(play([...garbled]).body, original);
  assert.equal(play([garbled]).body, original);
  // The symbols chat uses as emoji count as everyday text like the other emoji do; a variation selector is not counted.
  assert.equal(cleanMojibake(garble('✨好 ')).text, '✨好 ');
  assert.equal(cleanMojibake(garble('❤️嗯好 ')).text, '❤️嗯好 ');
  assert.equal(cleanMojibake(garble('收到啦✨今天也辛苦了')).text.startsWith('收到啦✨今天也辛苦'), true);
});

test('T-207 M05: the state tail reads the same however the stream is cut, and the garbage filter never rewrites it', () => {
  for (const reason of ['她叫宸风华。', garble('你好'), '用户愣了一下']) {
    const results: string[] = [];
    for (const cut of ['whole', 'after-marker', 'inside-marker', 'chars']) {
      const shown: string[] = [];
      const protocol = new MoodReplyProtocol(text => shown.push(text), { chineseChat: true });
      const stream = '早上好。\n' + protocol.start + tail(protocol, reason);
      const at = stream.indexOf(protocol.start);
      const chunks = cut === 'whole' ? [stream]
        : cut === 'after-marker' ? [stream.slice(0, at + protocol.start.length), stream.slice(at + protocol.start.length)]
          : cut === 'inside-marker' ? [stream.slice(0, at + 9), stream.slice(at + 9)] : [...stream];
      for (const chunk of chunks) protocol.push(chunk);
      results.push(`${protocol.finish()?.reason}|${shown.join('')}`);
    }
    assert.deepEqual(results, Array(4).fill(`${reason}|早上好。`), reason);
  }
});

test('T-207 M05: in a turn with a private proposal family the tail after the first marker is not filtered either', () => {
  const reason = garble('你好');
  const reasons = [true, false].map(split => {
    const protocol = new MoodReplyProtocol(() => {}, { settingProposal: { instruction: null } });
    const stream = '好呀。\n' + protocol.start + tail(protocol, reason);
    const at = stream.indexOf(protocol.start) + 4;
    for (const chunk of split ? [stream.slice(0, at), stream.slice(at)] : [stream]) protocol.push(chunk);
    return protocol.finish()?.reason;
  });
  assert.deepEqual(reasons, [reason, reason]);
});

// ------------------------------------------------------------------ the archive is what the bubble showed

async function completedTurn(reply: string): Promise<{ bubble: string; archived: string; count: number }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mojibake-t207-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load();
    await service.context('gene', { kind: 'claude', baseUrl: 'https://mojibake.invalid/v1', model: 'fixture' }, '角色名称：Gene');
    let bubble = '';
    const turn = await service.begin('t207', '在吗', '角色名称：Gene', (type, text) => { if (type === 'delta') bubble += text; });
    const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
    const stream = reply + `\n${start}{"context":"neutral","delta":{},"reason":"测试","confidence":0.9}${start.replace('<', '</')}`;
    for (const char of stream) turn.push('delta', char);
    await turn.finish('complete');
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    return { bubble, archived: record.messages[1].content, count: service.memory.list(turn.scope).total };
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('T-207: a completed turn archives exactly what the bubble showed, once, and that is what she said', async () => {
  for (const [model, said] of [['她叫宸风华。', '她叫宸风华。'], [garble('𠮷野家') + '。', '𠮷野家。'], [garble('你好') + '凪だよ', '你好凪だよ']]) {
    const { bubble, archived, count } = await completedTurn(model);
    assert.deepEqual({ bubble, archived, count }, { bubble: said, archived: said, count: 1 }, model);
  }
});
