// Codex T-207 round 2 (2026-11-04, bridge X-257, pinned 9f58785) counterexample for the "UTF-8 read as GBK" filter
// (shared/mojibake.ts; docs/claude/2026-11-03-mojibake-guard.md, section "Codex 第二轮反例和修复"). Fed one character at a
// time, "浣犲ソ。她叫宸。" came out as "你好。她叫巡" and, with "!" for the last mark, as "你好。她叫!": once a real garbled run
// was repaired, an ordinary name a few ordinary characters later was read as more of that garbage. The rule held here: a
// garbled run never reaches across a sentence end or the ordinary characters after it, and once ordinary text has shown
// the judgement starts afresh (a garbled run may pass instead; ordinary text is never changed). Every sample is written
// for the test; no recorded chat is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canStartMojibake, cleanMojibake, gbkCode, MojibakeGuard } from '../shared/mojibake';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';

const garble = (text: string): string => new TextDecoder('gbk').decode(Buffer.from(text, 'utf8'));

/** One reply through the protocol, `chunks` as the model streamed them, then this turn's state tail (as Codex fed it). */
function play(chunks: Iterable<string>): string {
  let shown = '';
  const protocol = new MoodReplyProtocol(text => { shown += text; }, { chineseChat: true });
  for (const chunk of chunks) protocol.push(chunk);
  const tail = JSON.stringify({ context: 'neutral', delta: {}, reason: '测试', confidence: 0.9 });
  protocol.push('\n' + protocol.start + tail + protocol.end);
  protocol.finish();
  return shown;
}

/** The filter alone, one character at a time. */
function byChar(text: string): string {
  const guard = new MojibakeGuard();
  let out = '';
  for (const char of text) out += guard.push(char);
  return out + guard.finish();
}

/** Every GBK character, once each. */
const GBK: string[] = (() => {
  const decoder = new TextDecoder('gbk'), chars: string[] = [];
  for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
    if (trail === 0x7f) continue;
    const char = decoder.decode(new Uint8Array([lead, trail]));
    if (char.length === 1 && char !== '�' && gbkCode(char) === ((lead << 8) | trail)) chars.push(char);
  }
  return chars;
})();
/** The rare characters that can begin a garbled run: the only ones the filter ever holds, so the ones a name can lose. */
const STARTS = GBK.filter(canStartMojibake);

test('T-207 round 2: the original, a repaired "你好" and then an ordinary single-character name, comes out as written', () => {
  const prefix = garble('你好');
  assert.equal(prefix, '浣犲ソ', 'the fixture is the reversible garble of "你好"');
  // Each part alone was always fine (Codex's controls).
  assert.equal(play(prefix + '。'), '你好。');
  assert.equal(play('她叫宸。'), '她叫宸。');
  assert.equal(play('她叫宸!'), '她叫宸!');
  for (const mark of ['。', '!']) {
    const said: string = prefix + '。她叫宸' + mark, meant: string = '你好。她叫宸' + mark;
    assert.equal(play(said), meant, `${mark}: char by char`);
    assert.equal(play([said]), meant, `${mark}: in one piece`);
    assert.equal(play([prefix + '。她', '叫宸', mark]), meant, `${mark}: in a few pieces`);
    assert.equal(cleanMojibake(said).text, meant, `${mark}: the whole text at once`);
  }
});

test('T-207 round 2: after a repaired run and a sentence end, "她叫X" "他是X" "名字叫X" keep every rare single-character name X', () => {
  assert.ok(STARTS.length >= 500, `every character that can begin a run (${STARTS.length})`);
  // Garbled sentences of different lengths: whole (an even number of bytes) and one that lost its last byte ("么").
  const prefixes = ['你好', '今天天气', '我们出去走走', '发生了什么'];
  let checked = 0;
  for (const original of prefixes) {
    const garbled = garble(original);
    // What the garbled sentence itself comes back as (the cut-off "么" stays lost); what follows must not change that.
    const fixed = cleanMojibake(garbled + '。').text;
    assert.equal(fixed, original.length % 2 ? original.slice(0, -1) + '。' : original + '。', original);
    for (const frame of ['她叫', '他是', '名字叫']) for (const name of STARTS) for (const mark of ['。', '！', '？', '!', '?', '']) {
      const said = garbled + '。' + frame + name + mark, meant = fixed + frame + name + mark;
      assert.equal(cleanMojibake(said).text, meant, JSON.stringify(said));
      assert.equal(byChar(said), meant, JSON.stringify(said));
      checked++;
    }
  }
  assert.ok(checked > 30_000, String(checked));
});

test('T-207 round 2: other rare names and other separators after a repaired run stay as written too', () => {
  const rare = GBK.filter(char => !STARTS.includes(char)).filter((_, i) => i % 7 === 0);
  for (const separator of ['。', '！', '？', '!', '? ', '，', '\n']) for (const name of [...rare, ...STARTS.filter((_, i) => i % 5 === 0)]) {
    const said = garble('你好') + separator + '她叫' + name + '。';
    assert.equal(byChar(said), '你好' + separator + '她叫' + name + '。', JSON.stringify(said));
  }
});

test('T-207 round 2: a line that begins with a rare name after a garbled line, and a rare name before a full-width sentence end, stay', () => {
  for (const name of STARTS) {
    // A new line starts afresh: the name is not a cut-off piece of the garbage on the line before.
    for (const after of ['!', '?', ' 来了', '。', '']) {
      const said = garble('你好') + '\n' + name + after;
      assert.equal(byChar(said), '你好\n' + name + after, JSON.stringify(said));
    }
    // Only a space between (garbage interleaved with English keeps the shorter rule), then a full-width sentence end:
    // a rare character right before "。" is as likely a name, so it is not dropped as a cut-off piece.
    for (const mark of ['。', '！', '？']) {
      const said = garble('你好') + ' ' + name + mark;
      assert.equal(byChar(said), '你好 ' + name + mark, JSON.stringify(said));
    }
  }
});

test('T-207 round 2: a sentence-end mark never counts as evidence of garbage, so a two-character rare name before it stays', () => {
  // The marks' own GBK bytes continue a UTF-8 sequence ("。" is A1 A3): a run "XY" whose last byte opens a sequence could
  // take the mark in and decode to two everyday characters ("鈥愭。" as "‐档"). Only names whose second character ends in such
  // a byte can do it; all of them are tried before each full-width mark.
  const opens = (byte: number) => (byte >= 0xe2 && byte <= 0xe9) || byte === 0xef || byte === 0xf0;
  const seconds = GBK.filter(char => { const code = gbkCode(char); return (code >> 8) >= 0x80 && (code >> 8) <= 0xbf && opens(code & 0xff); });
  assert.ok(seconds.length >= 300, String(seconds.length));
  let tried = 0;
  for (const first of STARTS) for (const second of seconds) for (const mark of ['。', '！', '？']) {
    const said = '她叫' + first + second + mark;
    const out = cleanMojibake(said).text;
    if (out !== said) assert.fail(`${JSON.stringify(said)} became ${JSON.stringify(out)}`);
    tried++;
  }
  assert.ok(tried > 400_000, String(tried));
  assert.equal(cleanMojibake('她叫鈥愭。').text, '她叫鈥愭。');
  // A real garbled sentence before a real mark is still repaired, and the mark stays.
  assert.equal(cleanMojibake(garble('你好') + '。').text, '你好。');
  assert.equal(cleanMojibake(garble('谢谢你呀') + '！').text, '谢谢你呀！');
  // In real garbage a mark can be the end of a character ("档" "衣" "裡" garble to "…。" "…！"): with the characters around
  // it the run is still proven garbled and repaired whole.
  for (const said of ['归档过的东西', '大衣服很好看', '我們今天去哪裡玩？', '新声音档案的记录']) {
    assert.match(garble(said), /[。！]/, said);
    assert.equal(cleanMojibake(garble(said)).text, said);
    assert.equal(byChar(garble(said)), said);
  }
});

// ------------------------------------------------------------------ the archive is what the bubble showed

async function completedTurn(reply: string): Promise<{ bubble: string; archived: string; count: number }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mojibake-t207r2-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load();
    await service.context('gene', { kind: 'claude', baseUrl: 'https://mojibake.invalid/v1', model: 'fixture' }, '角色名称：Gene');
    let bubble = '';
    const turn = await service.begin('t207r2', '在吗', '角色名称：Gene', (type, text) => { if (type === 'delta') bubble += text; });
    const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
    const stream = reply + `\n${start}{"context":"neutral","delta":{},"reason":"测试","confidence":0.9}${start.replace('<', '</')}`;
    for (const char of stream) turn.push('delta', char);
    await turn.finish('complete');
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    return { bubble, archived: record.messages[1].content, count: service.memory.list(turn.scope).total };
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('T-207 round 2: the completed turn archives the name as she said it, once, the same as the bubble', async () => {
  for (const mark of ['。', '!']) {
    const { bubble, archived, count } = await completedTurn(garble('你好') + '。她叫宸' + mark);
    assert.deepEqual({ bubble, archived, count }, { bubble: '你好。她叫宸' + mark, archived: '你好。她叫宸' + mark, count: 1 }, mark);
  }
});
