// 「带我去」: "让<her name>看屏幕" counts like 让你/让她, for any character; the name is passed in at run time, never written in the source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { matchTakeMeThere, requesterWords } from '../shared/initiative/take-me-there';
import { TakeMeThere } from '../electron/initiative/take-me-there';

const SCREEN = '让NAME看我的屏幕', CAMERA = '让NAME看看摄像头', LISTEN = '让NAME听电脑的歌';

test('a character name is matched like 你/她 in all three 让… sentences', () => {
  for (const name of ['艾琳', 'Akiko', 'Mary Ann']) {
    assert.equal(matchTakeMeThere(SCREEN.replace('NAME', name), name), 'screen', name);
    assert.equal(matchTakeMeThere(CAMERA.replace('NAME', name), name), 'camera', name);
    assert.equal(matchTakeMeThere(LISTEN.replace('NAME', name), name), 'listen', name);
    assert.equal(matchTakeMeThere(SCREEN.replace('NAME', name)), null, `${name}: without the runtime name it is only a mention`);
  }
  assert.equal(matchTakeMeThere('让你看我的屏幕'), 'screen');
  assert.equal(matchTakeMeThere('让她看我的屏幕', '艾琳'), 'screen');
});

test('another character\'s name, a refusal, or a missing name do not count', () => {
  assert.equal(matchTakeMeThere('让小雨看我的屏幕', '艾琳'), null);
  assert.equal(matchTakeMeThere('别让艾琳看我的屏幕', '艾琳'), null);
  assert.equal(matchTakeMeThere('让艾琳看我的屏幕', ''), null);
  assert.equal(matchTakeMeThere('让艾琳看我的屏幕', 42), null);
});

test('a name with regex characters is escaped, not interpreted', () => {
  const name = 'A*B(1)+[x]'; // (a dot would split the sentence like any full stop)
  assert.equal(matchTakeMeThere(`让${name}看我的屏幕`, name), 'screen');
  assert.equal(matchTakeMeThere('让AAB(1)+[x]看我的屏幕', name), null, 'the star is literal');
  assert.equal(matchTakeMeThere('让A*B1看我的屏幕', name), null, 'the parentheses are literal');
  assert.equal(requesterWords('x'.repeat(41)), '你|她', 'a very long name adds nothing');
  assert.equal(matchTakeMeThere('让你看我的屏幕', '(('), 'screen', 'an unbalanced name cannot break the other words');
});

test('the host passes the active character\'s name on every turn, so a switch takes effect at once', () => {
  let name = '艾琳';
  const host = new TakeMeThere({ send() {}, open() {}, characterName: () => name });
  assert.equal(host.beginTurn('让艾琳看我的屏幕').destination, 'screen');
  name = 'Akiko';
  assert.equal(host.beginTurn('让艾琳看我的屏幕').destination, null);
  assert.equal(host.beginTurn('让Akiko看我的屏幕').destination, 'screen');
  const broken = new TakeMeThere({ send() {}, open() {}, characterName: () => { throw new Error('no card'); } });
  assert.equal(broken.beginTurn('让你看我的屏幕').destination, 'screen');
});

test('no character name is written in the source: the three sentences take it from the caller', () => {
  const source = readFileSync(new URL('../shared/initiative/take-me-there.ts', import.meta.url), 'utf8');
  const letPatterns = source.match(/让\(\?:[^)]*\)/gu) ?? [];
  assert.ok(letPatterns.length >= 4, 'the three rules and the request words');
  for (const pattern of letPatterns) assert.match(pattern, /^让\(\?:(?:\$\{who\}|你\|她)\)$/u, pattern);
});
