/**
 * D2: the note lines under a "测试：…" message, in the window. Plain text only, one row per command, the user's own line on
 * top even when the host's note arrives first, old rows go, a new conversation clears them, the pet's rows fade away.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TestCommandNotes } from '../src/ui/TestCommandNotes';
import { TEST_NOTE_MAX, isTestEffect } from '../shared/test-command';

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  parent: Element | null = null; scrollTop = 0; scrollHeight = 999;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  prepend(...children: Element[]) { for (const child of children) child.parent = this; this.children.unshift(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  get innerHTML(): string { throw new Error('plain text only'); }
  set innerHTML(_value: string) { throw new Error('plain text only'); }
}
const doc = { createElement: (tag: string) => new Element(tag) } as unknown as Document;
const texts = (root: Element) => root.children.map(row => row.children.map(line => line.textContent));

test('a command is one row: the user\'s line, then the host\'s note lines, as plain text', () => {
  const log = new Element('div');
  const notes = new TestCommandNotes({ container: () => log as unknown as HTMLElement }, doc);
  const evil = '<img src=x onerror=alert(1)>';
  notes.begin('c1', `测试：${evil}`);
  notes.note({ id: 'c1', text: '（测试：本地没对上，正在请 Claude 帮忙找入口…）' });
  notes.note({ id: 'c1', text: '（测试：已让她开始发呆。）' });
  assert.equal(log.children.length, 1);
  assert.deepEqual(texts(log), [[`测试：${evil}`, '（测试：本地没对上，正在请 Claude 帮忙找入口…）', '（测试：已让她开始发呆。）']]);
  assert.equal(log.children[0].dataset.testCommand, 'c1');
  assert.equal(log.children[0].children[1].attributes.get('role'), 'status');
  assert.equal(log.scrollTop, log.scrollHeight, 'the chat log follows the newest line');
});

test('the host\'s note may arrive before the window\'s own line (an event beats the reply): the user\'s line still goes on top, once', () => {
  const log = new Element('div');
  const notes = new TestCommandNotes({ container: () => log as unknown as HTMLElement }, doc);
  notes.note({ id: 'c1', text: '（测试：已让她开始发呆。）' });
  notes.begin('c1', '测试：发呆');
  notes.begin('c1', '测试：发呆');
  assert.deepEqual(texts(log), [['测试：发呆', '（测试：已让她开始发呆。）']]);
});

test('later notes (an entry that waits) join the same row; rows of other commands stay apart; the oldest rows go past twelve', () => {
  const log = new Element('div');
  const notes = new TestCommandNotes({ container: () => log as unknown as HTMLElement }, doc);
  notes.begin('a', '测试：说话时机'); notes.note({ id: 'a', text: '（测试：现在不方便）' });
  notes.begin('b', '测试：发呆'); notes.note({ id: 'b', text: '（测试：已让她开始发呆。）' });
  notes.note({ id: 'a', text: '（测试：已给她一次说话的时机。）' });
  assert.deepEqual(texts(log), [['测试：说话时机', '（测试：现在不方便）', '（测试：已给她一次说话的时机。）'], ['测试：发呆', '（测试：已让她开始发呆。）']]);
  for (let i = 0; i < 20; i++) notes.begin(`n${i}`, `测试：${i}`);
  assert.equal(log.children.length, 12);
  assert.equal(log.children[0].children[0].textContent, '测试：8');
});

test('bad data is ignored; long text is cut; a missing container shows nothing', () => {
  const log = new Element('div');
  const notes = new TestCommandNotes({ container: () => log as unknown as HTMLElement }, doc);
  for (const bad of [null, {}, { id: 1, text: 'x' }, { id: '', text: 'x' }, { id: 'a', text: 5 }, { id: 'x'.repeat(101), text: 'x' }]) notes.note(bad as never);
  assert.equal(log.children.length, 0);
  notes.note({ id: 'a', text: '长'.repeat(TEST_NOTE_MAX + 50) });
  assert.equal(log.children[0].children[0].textContent!.length, TEST_NOTE_MAX);
  const nowhere = new TestCommandNotes({ container: () => null }, doc);
  nowhere.begin('a', '测试：发呆'); nowhere.note({ id: 'a', text: 'x' });
});

test('a new conversation clears the notes; the pet window puts new rows first and lets them fade', async () => {
  const log = new Element('div');
  const notes = new TestCommandNotes({ container: () => log as unknown as HTMLElement }, doc);
  notes.begin('a', '测试：发呆'); notes.note({ id: 'a', text: 'x' });
  notes.clear();
  assert.equal(log.children.length, 0);
  notes.note({ id: 'a', text: 'again' });
  assert.equal(log.children.length, 1, 'a cleared id can be used again');

  const pet = new Element('div');
  const fading = new TestCommandNotes({ container: () => pet as unknown as HTMLElement, prepend: true, lifetimeMs: 20 }, doc);
  fading.begin('a', '测试：发呆'); fading.begin('b', '测试：哼歌');
  assert.deepEqual(pet.children.map(row => row.dataset.testCommand), ['b', 'a'], 'newest first, above the input');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(pet.children.length, 0, 'gone after their lifetime');
});

test('the closed set of stage effects', () => {
  assert.equal(isTestEffect('music-rejudge'), true);
  for (const other of ['', 'dance', 'delete', null, undefined, 3, {}]) assert.equal(isTestEffect(other), false);
});
