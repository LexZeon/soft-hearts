import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionCommandHost } from '../electron/companion-command-host';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import { createCommandDialogueTurn } from '../electron/companion-command-dialogue';
import type { CompanionCommandActionId, CompanionCommandIntentInput, CompanionCommandView } from '../shared/companion-commands';

test('frozen Main class + actual Voice classifier/dialogue: third-domain isolation, refusal and stale single consumption', async () => {
  const state = {
    'pet.set-always-on-top': { value: false, revision: 0 },
    'pet.set-visible': { value: true, revision: 0 },
    'pet.set-follow-mouse': { value: false, revision: 0 },
  };
  let ready = true, current = true, serial = 0, now = 1, hold = false;
  let resolveCommit!: () => void;
  const writes: Array<{ action: CompanionCommandActionId; value: boolean }> = [], views: CompanionCommandView[] = [], chunks: string[] = [];
  let finishes = 0;
  const host = new CompanionCommandHost({
    now: () => now, id: () => `choice_${++serial}`,
    target: (owner, action) => ready && owner === 7 ? { contextId: 'current-context', ...state[action] } : null,
    classify: classifyCompanionCommand, format: formatCompanionCommandReceipt,
    enqueue: operation => operation(),
    commit: async (value, action) => {
      writes.push({ action, value });
      if (hold) await new Promise<void>(r => { resolveCommit = r; });
      const row = state[action], persistence = row.value === value ? 'unchanged' : 'saved';
      row.value = value; if (persistence === 'saved') row.revision++;
      return { persistence, presentation: 'not-requested', value };
    },
    publish: view => { views.push(view); },
  });
  const admit = (text: string) => host.admit({ requestId: `request_${++serial}`, owner: 7, window: 'controls', text,
    source: 'current-human', currentVisible: state['pet.set-visible'].value, currentFollowMouse: state['pet.set-follow-mouse'].value });
  const run = async (text: string) => { const ticket = admit(text); assert.ok(ticket); const view = await host.run(ticket); assert.ok(view); return { ticket, view }; };

  // Main supplies its real bool even when its existing target is unavailable.
  ready = false;
  for (const text of ['开启桌宠鼠标跟随', '调整鼠标跟随']) {
    const { view } = await run(text); assert.equal(view.receipt?.status, 'rejected');
    assert.equal(view.receipt?.actionId, 'pet.set-follow-mouse'); assert.doesNotMatch(view.receipt?.message ?? '', /已开启/);
  }
  assert.equal(writes.length, 0);
  assert.equal(host.admit({ requestId: 'model_request', owner: 7, window: 'pet', text: '开启桌宠鼠标跟随', source: 'model', currentFollowMouse: false }), null);
  ready = true;

  const requestId = `request_${++serial}`, text = '开启桌宠鼠标跟随';
  const ticket = host.admit({ requestId, owner: 7, window: 'controls', text, source: 'current-human' }); assert.ok(ticket);
  const dialogue = createCommandDialogueTurn({ classify: classifyCompanionCommand, formatReceipt: formatCompanionCommandReceipt,
    host: async () => { const view = await host.run(ticket); assert.ok(view); return view.receipt ?? view; },
    turn: { push: (_kind, value) => { chunks.push(value); }, finish: async () => { finishes++; } },
    signal: new AbortController().signal, isCurrent: () => current });
  const input: CompanionCommandIntentInput = { requestId, contextId: 'current-context', text, currentValue: false, currentVisible: true, currentFollowMouse: false };
  assert.equal(await dialogue.handle(input), 'handled'); assert.equal(finishes, 1);
  assert.deepEqual(chunks, ['桌宠的鼠标视线跟随设置已开启。']); assert.equal(writes.length, 1);
  assert.equal(await host.run(ticket), null); assert.ok(!Object.hasOwn(views.at(-1)!.receipt!, 'nativeValue'));
  const unchanged = await run('开启桌宠鼠标跟随'); assert.equal(unchanged.view.receipt?.status, 'unchanged');
  assert.equal(unchanged.view.receipt?.presentation, 'not-requested'); assert.equal(writes.length, 2);

  const cancelled = await run('调整鼠标跟随'); assert.equal(cancelled.view.choices.length, 3);
  assert.equal(await host.choose(8, { requestId: cancelled.view.requestId, choiceId: cancelled.view.choices[0].choiceId }), null);
  const cancel = await host.choose(7, { requestId: cancelled.view.requestId, choiceId: cancelled.view.choices[2].choiceId });
  assert.equal(cancel?.receipt?.status, 'cancelled'); assert.equal(writes.length, 2);
  assert.equal(await host.choose(7, { requestId: cancelled.view.requestId, choiceId: cancelled.view.choices[0].choiceId }), null);

  const aba = await run('调整鼠标跟随'); state['pet.set-follow-mouse'].revision += 2;
  const conflict = await host.choose(7, { requestId: aba.view.requestId, choiceId: aba.view.choices[1].choiceId });
  assert.equal(conflict?.receipt?.status, 'conflict'); assert.equal(writes.length, 2);
  const unrelated = await run('调整鼠标跟随'); state['pet.set-always-on-top'].revision++; state['pet.set-visible'].revision++;
  const off = await host.choose(7, { requestId: unrelated.view.requestId, choiceId: unrelated.view.choices[1].choiceId });
  assert.equal(off?.receipt?.value, false); assert.equal(off?.receipt?.actionId, 'pet.set-follow-mouse'); assert.equal(writes.length, 3);
  assert.ok(writes.every(w => w.action === 'pet.set-follow-mouse')); assert.equal(state['pet.set-visible'].value, true); assert.equal(state['pet.set-always-on-top'].value, false);
  const expired = await run('调整鼠标跟随'); now += 60_001;
  assert.equal((await host.choose(7, { requestId: expired.view.requestId, choiceId: expired.view.choices[0].choiceId }))?.receipt?.status, 'expired');
  assert.equal(writes.length, 3);

  const lateTicket = admit('开启桌宠鼠标跟随'); assert.ok(lateTicket); hold = true;
  const pending = host.run(lateTicket); assert.equal(writes.length, 4); current = false; host.invalidate();
  const countAfterInvalidation = views.length; resolveCommit(); assert.equal(await pending, null);
  assert.equal(views.length, countAfterInvalidation); assert.equal(finishes, 1); assert.equal(chunks.length, 1);
  assert.equal(await host.run(lateTicket), null);
});
