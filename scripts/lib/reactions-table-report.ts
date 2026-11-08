// I-037: what each event brings for one character by the reaction table alone (no haiku): every class's candidates with their
// scores, the top pick when haiku is not asked (the body, or the fallback on a warm tail), and four praises 30 s apart on the
// fallback path. Calm mood, awake, no jitter. Pure arithmetic: no model, no profile, no files.
//   node node_modules/tsx/dist/cli.mjs scripts/lib/reactions-table-report.ts                     (the preinstalled Gene card)
//   node node_modules/tsx/dist/cli.mjs scripts/lib/reactions-table-report.ts 70 60 40 50 65 55   (six dispositions, in the registry order)
import { preinstalledGeneDraft } from '../../electron/gene-preinstalled-card';
import { DISPOSITION_IDS, deriveDispositions, dispositionSummary, type Dispositions } from '../../shared/behaviors/reactions/dispositions';
import { REACTION_EVENT_IDS } from '../../shared/behaviors/reactions/events';
import { REACTION_TABLE } from '../../shared/behaviors/reactions/knobs';
import { scoreReactions, topPick } from '../../shared/behaviors/reactions/choose';

const given = process.argv.slice(2).map(Number);
const dispositions: Dispositions = given.length === DISPOSITION_IDS.length && given.every(n => Number.isInteger(n) && n >= 0 && n <= 100)
  ? Object.fromEntries(DISPOSITION_IDS.map((id, i) => [id, given[i]])) as Dispositions
  : deriveDispositions(preinstalledGeneDraft().mood);
console.log(`倾向：${dispositionSummary(dispositions)}`);
const now = (at: number, recent: { id: string; at: number }[] = []) => ({ characterId: 'x', dispositions, mood: 'calm' as const, sleepy: false, at, recent });
for (const event of REACTION_EVENT_IDS) {
  const s = scoreReactions(event, now(0), { random: () => 0.5 });
  const top = topPick(s);
  console.log(`${event.padEnd(10)} ${s.candidates.map(c => `${REACTION_TABLE[c.id].label} ${c.score}`).join('、') || '（没有）'}  → 不问 haiku 时：${top ? `${REACTION_TABLE[top.id].label}（${top.level}）` : '不做'}`);
}
const recent: { id: string; at: number }[] = [], sequence: string[] = [];
for (let i = 0; i < 4; i++) {
  const at = i * 30_000, pick = topPick(scoreReactions('warm', now(at, recent), { random: () => 0.5 }));
  sequence.push(pick ? `${REACTION_TABLE[pick.id].label}（${pick.level}）` : '不做');
  if (pick) recent.push({ id: pick.id, at });
}
console.log(`连夸 4 次（每 30 秒，haiku 没答、她的回复是暖心的）：${sequence.join(' → ')}`);
