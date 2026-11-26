// no-pet-ok-file: the bridge option for the desktop window has that name; it is not her
// 2026-11-26 (docs/claude/2026-11-26-reported-model.md): get_diagnostics carries `chat.reportedModel`, the model Claude Code reported for her current
// chat process, so the lead and the user's Claude can read it without the journal. The real createHostBridge / createAppTools over a fake wiring.
// A model id is not private, but only a short clean id passes (shared/brain/claude-model.ts reportedModelId); anything else is null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { createAppTools } from '../electron/safety/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';

async function diagnosticsWith(chatModel: (() => unknown) | undefined): Promise<any> {
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const operations = new Map<string, IpcHandler>();
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async () => { throw new Error('x'); },
    commitPetBoolean: async () => { throw new Error('x'); }, commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], ...(chatModel ? { chatModel: chatModel as () => string | null } : {}), broadcast: () => {}, interconnected: () => true });
  const registry = new AgentToolRegistry(createAppTools({ ...bridge, now: () => 0 }), { enabled: () => true, interconnect: () => true, confirm: async () => true, notice: () => {}, called: () => {} });
  return ((await registry.call('get_diagnostics', {})) as any).result;
}

test('get_diagnostics: the model her chat process reported, or null', async () => {
  assert.deepEqual((await diagnosticsWith(() => 'claude-fable-5-2')).chat, { reportedModel: 'claude-fable-5-2' });
  assert.deepEqual((await diagnosticsWith(() => null)).chat, { reportedModel: null });
  assert.deepEqual((await diagnosticsWith(undefined)).chat, { reportedModel: null });
});

test('get_diagnostics: an odd value, or a wiring that throws, is null, never passed on', async () => {
  for (const odd of ['has space', 'x'.repeat(81), '中文', 7, {}]) assert.deepEqual((await diagnosticsWith(() => odd)).chat, { reportedModel: null }, JSON.stringify(odd));
  assert.deepEqual((await diagnosticsWith(() => { throw new Error('gone'); })).chat, { reportedModel: null });
});
