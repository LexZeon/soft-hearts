import test from 'node:test';
import assert from 'node:assert/strict';
import type { PetReplyAnchor, PetReplyUpdate } from '../shared/contracts';
import { PetUI } from '../src/ui/PetUI';
import { ReplySpeechState } from '../src/ui/reply-speech';

class Classes {
  private readonly values = new Set<string>();
  add(...names: string[]): void { names.forEach(name => this.values.add(name)); }
  remove(...names: string[]): void { names.forEach(name => this.values.delete(name)); }
  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}

function withPet(run: (fixture: {
  ui: PetUI; updates: PetReplyUpdate[]; body: { textContent: string };
  advance(ms: number): void; now(): number; deadline(): number; anchor(): void; bodyWrites(): number;
}) => void): void {
  const originalDocument = globalThis.document, originalWindow = globalThis.window, originalNow = Date.now;
  let now = 1000;
  const updates: PetReplyUpdate[] = [], errors: string[] = [];
  let content = '', writes = 0;
  const body = { get textContent() { return content; }, set textContent(value: string) { content = value; writes++; }, classList: new Classes() };
  const tooltip = { classList: new Classes() };
  const anchor: PetReplyAnchor = { x: 190, y: 180, radius: 90, visible: true };
  globalThis.document = {
    getElementById: (id: string) => id === 'pet-answer-body' ? body : id === 'pet-tooltip' ? tooltip : null,
    querySelectorAll: () => [], body: { classList: new Classes() },
  } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (update: PetReplyUpdate) => { updates.push(structuredClone(update)); } } } as unknown as Window & typeof globalThis;
  Date.now = () => now;
  // Exercise real public PetUI methods without constructing unrelated toolbar,
  // pointer capture or browser media. Its private wire method is not replaced.
  const ui = Object.create(PetUI.prototype) as PetUI;
  const fields = ui as unknown as { replyExpiresAt: number };
  Object.assign(ui, {
    anchor, replyState: 'hidden', replyExpiresAt: 0, replyStreaming: false,
    replySpeech: new ReplySpeechState(), interacting: false, interactionProgress: 0, actions: { error: (message: string) => errors.push(message) },
  });
  try {
    run({ ui, updates, body, advance: ms => { now += ms; }, now: () => now,
      deadline: () => fields.replyExpiresAt, anchor: () => ui.setFaceAnchor({ ...anchor }), bodyWrites: () => writes });
    assert.deepEqual(errors, []);
  } finally { globalThis.document = originalDocument; globalThis.window = originalWindow; Date.now = originalNow; }
}

test('R27 expectation is state-only while the exact first prefix stays unread',{timeout:4000},()=>withPet(f=>{
 f.ui.beginAnswer('r27');f.ui.showAnswer('第一句。',true,'r27');const writes=f.bodyWrites();f.ui.expectAnswerSpeech('r27');f.ui.expectAnswerSpeech('r27');
 assert.equal(f.bodyWrites(),writes);assert.equal(f.body.textContent,'第一句。');assert.equal(f.deadline(),Infinity);
 f.ui.endAnswerSpeech('r27');const after=f.updates.length;f.ui.expectAnswerSpeech('r27');assert.equal(f.updates.length,after,'ended speech is not expected anew');assert.equal(f.bodyWrites(),writes);
 f.ui.showAnswer('第一句。第二句。',true,'r27');f.ui.finishAnswer('第一句。第二句。','r27',false,true);assert.equal(f.updates.at(-1)?.state,'complete');assert.ok(f.deadline()<Infinity);
}));
test('R27 hidden or foreign speech expectation cannot restore a bubble',{timeout:4000},()=>withPet(f=>{
 f.ui.beginAnswer('new');f.ui.showAnswer('新正文。',true,'new');const writes=f.bodyWrites(),updates=f.updates.length;f.ui.expectAnswerSpeech('old');assert.equal(f.updates.length,updates);
 f.ui.hideAnswer();const hidden=f.updates.length;f.ui.expectAnswerSpeech('new');assert.equal(f.updates.length,hidden);assert.equal(f.bodyWrites(),writes);assert.equal(f.updates.at(-1)?.state,'hidden');
}));
