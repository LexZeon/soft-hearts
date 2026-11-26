// The ready chain's run of the parts' small stores (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md): the nine lines electron/main.ts
// had between the card responses and the personalize stores, in their old order, each store its own unit through the part runner (one
// failing to load is switched off alone; electron/wiring/parts-wiring.ts). The wiring golden reads this body in place of the call, and each
// startUnit call as the line it wraps, so the ready chain's order list is the old one.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { startUnit } from './parts-wiring';
import { chatOutage } from './brain-wiring';
import { feeding, herFolder, keepsake, rps, specialDay } from './initiative-wiring';
import { moodJudge, reactions } from './mood-wiring';
import { startUserActivity } from './senses-wiring';

/** Ready-chain step: 大脑's lines for when Claude cannot answer, G1 猜拳, I-019 喂食, I-027, I-037, I-006, I-050 her folder and keepsakes, I-059. */
export async function startPartStores(): Promise<void> {
  await startUnit('brain', 'chat-outage', () => chatOutage.load());
  await startUnit('initiative', 'rps', () => rps.load());
  await startUnit('initiative', 'feeding', () => feeding.load());
  await startUnit('mood', 'mood-judge', () => moodJudge.load());
  await startUnit('mood', 'reactions', () => reactions.load()); // I-037
  await startUserActivity(); // I-006 (感知: electron/wiring/senses-wiring.ts; its own unit there)
  await startUnit('initiative', 'her-folder', () => herFolder.load()); // I-050
  await startUnit('initiative', 'keepsake', async () => { await keepsake.load(); keepsake.start(); }); // I-050 第 2 步
  await startUnit('initiative', 'special-day', async () => { await specialDay.load(); specialDay.start(); }); // I-059
}
