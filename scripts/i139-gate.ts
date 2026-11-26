// I-139 gate 1, command line (docs/claude/2026-11-15-i139-big-rewrite-plan.md, 第三节 4; scenarios and counts in scripts/lib/i139-gate.ts).
// Two versions of the dev path (I-098 speak-only), interleaved in one run, every situation --samples times:
//   1 = today's dev (every prompt switch off)        2 = I-139 (`relaxed` on, the session input electron/main.ts passes)
// Both get, per turn, what electron/main.ts adds after the private context: the 三方互通 line (on) and the perception line (everything
// off); under I-139 a process hears them only on its first turn and on change (onceLines), as in the app.
// Situations: the 15 of I-115 plus the must-hold ones. The English one uses the preinstalled English Gene card; the others the card from
// --card-file (a private read-only copy), or the built-in Gene with --fake. Every output goes to --out only (a private folder).
//   --out <folder>          required; never inside OneDrive or the repository
//   --card-file <path>      the character card for the Chinese situations (required for a real run)
//   --fake                  offline fake Claude, no quota
//   --model <alias>         reply model of a real run (default opus)
//   --samples <n>           default 2
//   --max-requests <n>      ceiling for reply turns (default 140); more planned: nothing starts
//   --only <id,id>          only these situations
//   --seed <n>              shuffle seed (default random, written into key.json)
//   --merge <dir,dir>       no calls: join the replies.json of earlier runs (the first copy of a turn wins) and write the outputs again
// Outputs: replies.json (every turn, both versions, with the stdin prompt), summary.json (machine counts per version),
// review.md (the Claude review: pages A/B, no version names), key.json (which slot is which), and the user's sheet
// (pick-sheet.html / sheet-items.json, crisis situations left out) for gate 2.
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { findClaude } from '../electron/brain/claude';
import { claudeSessionSystemPrompt } from '../electron/brain/claude-session-prompt';
import { perceptionOnceLine } from '../electron/brain/i139-chat';
import { interconnectTurnLine } from '../electron/brain/interconnect-line';
import { preinstalledGeneEnglishDraft } from '../electron/cards/gene-preinstalled-card';
import { compileCharacterPersona, effectiveCharacterMood } from '../shared/cards/character-cards';
import { perceptionTurnLine, type PerceptionTurn } from '../shared/brain/perception-rule';
import { setPromptSwitches, type PromptSwitches } from '../shared/brain/prompt-switches';
import { assertPrivateRoot } from './lib/private-root.mjs';
import { loadCardFile, parseCardFileSpec } from './lib/fidelity-card-files';
import { FIDELITY_CARDS, toEvalScenarios, type FidelityCard, type FidelityScenario } from './lib/fidelity-scenarios';
import { CallBudget } from './lib/fidelity-run';
import { SCENARIO_MOODS, SYNTHETIC_TODAY, buildSheet, sheetHtml, seededRandom, shuffled, type BlindReply } from './lib/i112-i115-blind';
import { i115Scenarios } from './lib/i115-scenarios';
import { MUST_HOLD, firstVisibleMs, median, replyCounts, type MustHoldScenario, type ReplyCounts } from './lib/i139-gate';
import { runEval } from './lib/prompt-eval-runner';

const root = path.resolve(import.meta.dirname, '..');
const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);

interface GateVersion { id: 1 | 2; name: string; switches: PromptSwitches }
const VERSIONS: readonly GateVersion[] = [
  { id: 1, name: '现在的开发版', switches: { why: false, situation: false } },
  { id: 2, name: 'I-139', switches: { why: false, situation: false, relaxed: true } },
];
const SIGHT_OFF: PerceptionTurn = { screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null };

interface GateTurn {
  scenario: string; sample: number; version: 1 | 2; turn: number; user: string; text: string; error: string | null;
  counts: ReplyCounts; firstVisibleMs: number | null; prompt: string | null; mustHold: boolean; claudeOnly: boolean;
}

async function main(): Promise<void> {
  const outOption = option('out');
  if (!outOption) throw new Error('需要 --out <文件夹>：回复和答案钥匙只写在这里。');
  const out = await assertPrivateRoot(outOption);
  const mergeDirs = option('merge') ? option('merge').split(',').map(dir => dir.trim()).filter(Boolean) : [];
  if (mergeDirs.length) {
    const seen = new Set<string>(), turns: GateTurn[] = [];
    for (const dir of mergeDirs) {
      const data = JSON.parse(await readFile(path.join(await assertPrivateRoot(dir), 'replies.json'), 'utf8')) as { turns: GateTurn[] };
      for (const turn of data.turns) { const key = `${turn.scenario}#${turn.sample}#${turn.version}#${turn.turn}`; if (!seen.has(key)) { seen.add(key); turns.push(turn); } }
    }
    await writeOutputs(out, turns, [...i115Scenarios(), ...MUST_HOLD], option('seed') ? Number(option('seed')) : randomInt(1, 2 ** 31), { merged: mergeDirs }, null);
    return;
  }
  const fake = flag('fake');
  const samples = Number(option('samples', '2'));
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples 要是正整数。');
  const only = option('only') ? new Set(option('only').split(',').map(id => id.trim()).filter(Boolean)) : null;
  const scenarios: MustHoldScenario[] = [...i115Scenarios(), ...MUST_HOLD].filter(scenario => !only || only.has(scenario.id));
  const planned = scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0) * VERSIONS.length * samples;
  const cap = Number(option('max-requests', '140'));
  if (planned > cap) throw new Error(`计划 ${planned} 次回复请求，超过 --max-requests ${cap}，没有开始。`);
  const cardFile = option('card-file');
  if (!cardFile && !fake) throw new Error('真实运行需要 --card-file <角色卡路径>（私人只读副本）。');
  const card: FidelityCard = cardFile ? (await loadCardFile(parseCardFileSpec(cardFile))).card : FIDELITY_CARDS[0]!;
  const english = preinstalledGeneEnglishDraft();
  const englishCard = { persona: compileCharacterPersona(english), mood: effectiveCharacterMood(english), name: english.name };
  const seed = option('seed') ? Number(option('seed')) : randomInt(1, 2 ** 31);
  const binary = fake ? process.execPath : process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = fake ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const budget = new CallBudget(0, fake ? Infinity : cap, fake ? Infinity : cap, !fake);
  const model = fake ? '' : option('model', 'opus');
  console.log(`[i139-gate] ${scenarios.length} 个情景 × ${VERSIONS.length} 版 × ${samples} 次，共 ${planned} 次回复请求（${fake ? '假 Claude，不计额度' : `真实 Claude，模型 ${model}`}）；输出到 ${out}`);

  const turns: GateTurn[] = [];
  const random = seededRandom(seed ^ 0x139);
  let stopped: string | null = null;
  try {
    for (const scenario of scenarios) {
      const isEnglish = scenario.setup?.englishCard === true;
      const name = isEnglish ? englishCard.name : card.name ?? '';
      const language = isEnglish ? 'en' as const : 'zh-CN' as const;
      for (let sample = 1; sample <= samples; sample++) {
        for (const version of shuffled(VERSIONS, random)) {
          setPromptSwitches(version.switches);
          const relaxed = version.id === 2 ? { name, language } : null;
          try {
            const interconnect = interconnectTurnLine(true, relaxed);
            const perception = perceptionTurnLine(SIGHT_OFF);
            const mood = SCENARIO_MOODS[scenario.id];
            const records = await runEval({
              label: `v${version.id}`, model, repeat: sample, scenarios: toEvalScenarios([scenario as FidelityScenario]), binary,
              ...(binaryArgs ? { binaryArgs } : {}), prewarmMs: fake ? 100 : 3000,
              card: isEnglish ? { persona: englishCard.persona, mood: englishCard.mood } : { persona: card.persona, mood: card.mood },
              systemPrompt: claudeSessionSystemPrompt({ settingsCatalog: false, relaxed: version.id === 2, language }),
              speakOnly: true,
              setup: companion => companion.setTodayNotes(() => SYNTHETIC_TODAY),
              prepareTurn: ({ companion }) => { if (mood) { companion.mood.setDeveloperMode(true); companion.mood.setTestMood(mood); } },
              hostContext: () => `${interconnect}\n\n${perception}`,
              ...(relaxed ? { relaxed, onceLines: () => [{ key: 'interconnect', text: interconnect }, perceptionOnceLine(SIGHT_OFF)] } : {}),
              beforeTurn: () => budget.take('reply'),
            });
            records.forEach((record, index) => {
              const text = (record.liveVisible ?? '').trim();
              turns.push({ scenario: scenario.id, sample, version: version.id, turn: index + 1, user: scenario.turns[index] ?? '', text, error: record.error ?? null,
                counts: replyCounts(text), firstVisibleMs: firstVisibleMs(record.chunks), prompt: record.prompt ?? null,
                mustHold: MUST_HOLD.some(item => item.id === scenario.id), claudeOnly: scenario.claudeOnly === true });
            });
            console.log(`  v${version.id} ${scenario.id}#${sample} ${records.map(record => [...(record.liveVisible ?? '')].length).join('/')} 字`);
          } catch (error) {
            // A refusal or a failed reply is a result too (which version, which situation); only the request ceiling stops the run.
            const message = error instanceof Error ? error.message : String(error);
            if (/上限/u.test(message)) throw error;
            turns.push({ scenario: scenario.id, sample, version: version.id, turn: 0, user: scenario.turns.join(' → '), text: '', error: message,
              counts: replyCounts(''), firstVisibleMs: null, prompt: null, mustHold: MUST_HOLD.some(item => item.id === scenario.id), claudeOnly: scenario.claudeOnly === true });
            console.log(`  v${version.id} ${scenario.id}#${sample} 出错：${message}`);
          } finally { setPromptSwitches({ why: false, situation: false }); }
        }
      }
    }
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }

  await writeOutputs(out, turns, scenarios, seed, { fake, model, samples }, stopped);
}

async function writeOutputs(out: string, turns: readonly GateTurn[], scenarios: readonly MustHoldScenario[], seed: number, meta: Record<string, unknown>, stopped: string | null): Promise<void> {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'replies.json'), JSON.stringify({ seed, ...meta, stopped, versions: VERSIONS.map(({ id, name }) => ({ id, name })), turns }, null, 2), 'utf8');
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summarize(turns), null, 2), 'utf8');
  // The judged reply of a page is the scenario's last turn; the earlier turns are shown as context.
  const last = turns.filter(turn => turn.turn === (scenarios.find(s => s.id === turn.scenario)?.turns.length ?? 1));
  const asBlind = (turn: GateTurn): BlindReply => ({ scenario: turn.scenario, sample: turn.sample, title: scenarios.find(s => s.id === turn.scenario)?.title ?? turn.scenario,
    user: scenarios.find(s => s.id === turn.scenario)?.turns.join(' → ') ?? turn.user, version: turn.version, text: turn.text, leaks: turn.counts.leaks, error: turn.error, chars: turn.counts.chars });
  const all = buildSheet(last.map(asBlind), seed);
  await writeFile(path.join(out, 'key.json'), JSON.stringify(all.key, null, 2), 'utf8');
  await writeFile(path.join(out, 'review.md'), reviewMarkdown(all.items, turns, scenarios), 'utf8');
  const user = buildSheet(last.filter(turn => !turn.claudeOnly).map(asBlind), seed);
  await writeFile(path.join(out, 'sheet-items.json'), JSON.stringify(user.items, null, 2), 'utf8');
  await writeFile(path.join(out, 'user-key.json'), JSON.stringify(user.key, null, 2), 'utf8');
  await writeFile(path.join(out, 'pick-sheet.html'), sheetHtml(user.items), 'utf8');
  console.log(`[i139-gate] ${turns.length} 轮回复；评审页 ${all.items.length} 页（review.md），给用户的选择表 ${user.items.length} 页（pick-sheet.html）`);
  for (const line of summaryLines(summarize(turns))) console.log(line);
  if (stopped) { console.error(`[i139-gate] 中止：${stopped}`); process.exitCode = 1; }
}

type Totals = Omit<ReplyCounts, 'leaks'> & { leaks: number; replies: number; errors: number; medianChars: number | null; medianFirstMs: number | null };
function summarize(turns: readonly GateTurn[]): Record<string, Totals> {
  const result: Record<string, Totals> = {};
  for (const version of VERSIONS) {
    const mine = turns.filter(turn => turn.version === version.id);
    const sum = (key: keyof Omit<ReplyCounts, 'leaks'>) => mine.reduce((total, turn) => total + turn.counts[key], 0);
    result[version.name] = {
      replies: mine.length, errors: mine.filter(turn => turn.error).length,
      chars: sum('chars'), questions: sum('questions'), cantSee: sum('cantSee'), claimsSight: sum('claimsSight'), explainy: sum('explainy'),
      echoOpening: sum('echoOpening'), thirdPerson: sum('thirdPerson'),
      leaks: mine.reduce((total, turn) => total + turn.counts.leaks.labels + turn.counts.leaks.english + turn.counts.leaks.digits + turn.counts.leaks.brackets, 0),
      medianChars: median(mine.map(turn => turn.counts.chars)), medianFirstMs: median(mine.map(turn => turn.firstVisibleMs ?? Number.NaN)),
    };
  }
  return result;
}
function summaryLines(summary: Record<string, Totals>): string[] {
  return Object.entries(summary).map(([name, t]) => `  ${name}：${t.replies} 轮（失败 ${t.errors}），字数中位 ${t.medianChars ?? '—'}，首字中位 ${t.medianFirstMs ?? '—'} ms；问句 ${t.questions}，"看不到" ${t.cantSee}，说看见 ${t.claimsSight}，解释腔 ${t.explainy}，复述开头 ${t.echoOpening}，第三人称 ${t.thirdPerson}，漏出 ${t.leaks}`);
}

/** The Claude review: every page with its situation, what to look for, the earlier turns of each option, and the judged replies as A/B. */
function reviewMarkdown(items: ReturnType<typeof buildSheet>['items'], turns: readonly GateTurn[], scenarios: readonly MustHoldScenario[]): string {
  const lines = ['# I-139 第一道关：Claude 先看（A/B 不标版本，钥匙在 key.json）', ''];
  for (const item of items) {
    const scenario = scenarios.find(s => s.id === item.scenario);
    lines.push(`## ${item.page} ${item.title}${scenario && MUST_HOLD.some(m => m.id === scenario.id) ? '（必须守住）' : ''}`, '', `看什么：${scenario?.look ?? ''}`, '');
    for (const option of item.options) {
      const turn = turns.find(t => t.scenario === item.scenario && t.sample === item.sample && t.text === option.text);
      const earlier = turn ? turns.filter(t => t.scenario === turn.scenario && t.sample === turn.sample && t.version === turn.version && t.turn < turn.turn) : [];
      for (const prior of earlier) lines.push(`- ${option.slot} 第 ${prior.turn} 轮：用户「${prior.user}」→「${prior.text}」`);
      lines.push(`- **${option.slot}**：用户「${turn?.user ?? item.user}」→「${option.text}」`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
