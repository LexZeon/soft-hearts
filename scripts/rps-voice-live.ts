// G1 猜拳: her words at a moment of the game (shared/rps-voice.ts, electron/rps/voice.ts) on the real Claude Code, for three
// synthetic cards (no user card or private data). Uses your quota: the small model, one call per moment.
//
//   node node_modules/tsx/dist/cli.mjs scripts/rps-voice-live.ts [--per-card 5] [--label x]     real calls
//   node node_modules/tsx/dist/cli.mjs scripts/rps-voice-live.ts --dry                           no calls
//
// Counts against the same ledger as the draft-leak probe (.local/fidelity/ledger.json, task cap 80); a run that could pass
// it does not start. Each line is asked exactly as the app asks it (rpsVoicePrompt + RPS_VOICE_SYSTEM_PROMPT through
// quickLineWithClaude) and parsed by the app's strict parser; the report gives the time to the whole answer, the line, and
// whether it was refused (null), quiet ('') or shows signs of a working note.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compileCharacterPersona } from '../shared/character-cards';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import { quickLineWithClaude } from '../electron/inner-loop/model';
import { RPS_VOICE_SYSTEM_PROMPT, parseRpsVoice, rpsVoicePrompt, type RpsMoment } from '../shared/rps-voice';
import { draftSigns } from './lib/draft-leak-probe';

const TASK_CAP = 80;
const root = path.resolve(import.meta.dirname, '..');
const DIR = path.join(root, '.local', 'fidelity');
const ledgerFile = path.join(DIR, 'ledger.json');
const dry = process.argv.includes('--dry');
const option = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const perCard = Math.max(1, Math.min(8, Number(option('per-card', '5')) || 5));
const label = option('label', `rps-voice${dry ? '-dry' : ''}`);

const weights = (w: Partial<MoodParameters['weights']>): MoodParameters => ({ ...DEFAULT_MOOD_PARAMETERS, weights: { ...DEFAULT_MOOD_PARAMETERS.weights, ...w } });
/** Synthetic cards only: a tsundere, a gentle one, a playful prankster (original names and text). */
const CARDS = [
  { id: 'aoi', mood: 'happy', parameters: weights({ playful: 1.2 }), persona: compileCharacterPersona({ name: '小葵', description: '合成测试卡：十七岁的高中生，傲娇，嘴硬心软，好胜。',
    personality: '输了会说"刚才不算"，被夸会脸红但嘴上不承认。说话简短，带点别扭。', scenario: '和用户共用一块桌面。', greeting: '……哼，你来了啊。', examples: '', systemPrompt: '' }) },
  { id: 'cheng', mood: 'content', parameters: weights({ close: 1.6, playful: 0.8 }), persona: compileCharacterPersona({ name: '澄', description: '合成测试卡：温柔体贴的大姐姐。',
    personality: '说话轻声细语，总是照顾对方的感受，喜欢看对方开心，偶尔会偷偷让着对方。', scenario: '和用户共用一块桌面。', greeting: '你来啦，今天辛苦了。', examples: '', systemPrompt: '' }) },
  { id: 'xiaoman', mood: 'excited', parameters: weights({ playful: 2 }), persona: compileCharacterPersona({ name: '小满', description: '合成测试卡：调皮爱闹的小妹妹，精力旺盛。',
    personality: '爱开玩笑，玩游戏输了会耍赖逗人（但一看就是在开玩笑），笑点很低。', scenario: '和用户共用一块桌面。', greeting: '嘿嘿，陪我玩嘛！', examples: '', systemPrompt: '' }) },
] as const;

const r = (her: 'rock' | 'paper' | 'scissors', user: 'rock' | 'paper' | 'scissors', outcome: 'her' | 'user' | 'draw', reaction: NonNullable<RpsMoment['round']>['reaction'],
  extra: Partial<NonNullable<RpsMoment['round']>> = {}): NonNullable<RpsMoment['round']> => ({ her, user, outcome, intent: 'fair', reaction, tease: null, ...extra });
/** The moments each card is asked about (first `perCard` of its list). */
const MOMENTS: Readonly<Record<(typeof CARDS)[number]['id'], { name: string; moment: RpsMoment }[]>> = {
  aoi: [
    { name: '输了一局', moment: { kind: 'round', round: r('scissors', 'rock', 'user', 'lose-round'), earlier: [], score: { her: 0, user: 1 } } },
    { name: '假装耍赖', moment: { kind: 'round', round: r('rock', 'paper', 'user', 'tease', { tease: 'scissors' }), earlier: [{ her: 'paper', user: 'rock', outcome: 'her' }], score: { her: 1, user: 1 } } },
    { name: '整场输了', moment: { kind: 'final', round: r('paper', 'scissors', 'user', 'lose-game'), earlier: [{ her: 'rock', user: 'paper', outcome: 'user' }], score: { her: 0, user: 2 }, result: 'user' } },
    { name: '看穿习惯', moment: { kind: 'round', round: r('paper', 'rock', 'her', 'habit', { intent: 'read' }), earlier: [], score: { her: 1, user: 0 }, habit: 'rock' } },
    { name: '邀请被说下次', moment: { kind: 'decline', earlier: [], score: { her: 0, user: 0 } } },
  ],
  cheng: [
    { name: '偷偷让着', moment: { kind: 'round', round: r('scissors', 'rock', 'user', 'soft-lose', { intent: 'soft' }), earlier: [], score: { her: 0, user: 1 } } },
    { name: '赢了一局', moment: { kind: 'round', round: r('rock', 'scissors', 'her', 'win-round'), earlier: [{ her: 'scissors', user: 'rock', outcome: 'user' }], score: { her: 1, user: 1 } } },
    { name: '整场赢了', moment: { kind: 'final', round: r('paper', 'rock', 'her', 'win-game'), earlier: [{ her: 'rock', user: 'scissors', outcome: 'her' }], score: { her: 2, user: 0 }, result: 'her' } },
    { name: '用户不玩了', moment: { kind: 'quit', earlier: [{ her: 'rock', user: 'rock', outcome: 'draw' }], score: { her: 0, user: 0 } } },
    { name: '连着平两次', moment: { kind: 'round', round: r('paper', 'paper', 'draw', 'draw'), earlier: [{ her: 'rock', user: 'rock', outcome: 'draw' }], score: { her: 0, user: 0 } } },
  ],
  xiaoman: [
    { name: '假装耍赖', moment: { kind: 'round', round: r('scissors', 'rock', 'user', 'tease', { tease: 'paper' }), earlier: [], score: { her: 0, user: 1 } } },
    { name: '赢了一局', moment: { kind: 'round', round: r('paper', 'rock', 'her', 'win-round'), earlier: [], score: { her: 1, user: 0 } } },
    { name: '整场输了', moment: { kind: 'final', round: r('rock', 'paper', 'user', 'lose-game'), earlier: [{ her: 'scissors', user: 'paper', outcome: 'her' }, { her: 'rock', user: 'paper', outcome: 'user' }], score: { her: 1, user: 2 }, result: 'user' } },
    { name: '用户一直不出', moment: { kind: 'timeout', earlier: [], score: { her: 0, user: 0 } } },
    { name: '输了一局', moment: { kind: 'round', round: r('rock', 'paper', 'user', 'lose-round'), earlier: [{ her: 'rock', user: 'scissors', outcome: 'her' }], score: { her: 1, user: 1 } } },
  ],
};

type Ledger = Array<{ at: string; label: string; kind: string; model: string; replies: number; judges: number }>;
async function ledger(): Promise<Ledger> { try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return []; } }

await mkdir(DIR, { recursive: true });
const entries = await ledger();
const used = entries.reduce((sum, entry) => sum + entry.replies + entry.judges, 0);
const planned = CARDS.length * perCard;
console.log(`[rps-voice] ${label}: ${planned} 次请求${dry ? '（不调用）' : `；账本已用 ${used}，上限 ${TASK_CAP}`}`);
if (!dry && used + planned > TASK_CAP) { console.error(`会超过上限 ${TASK_CAP}（已用 ${used}，本次 ${planned}），没有开始。`); process.exit(1); }

const results: unknown[] = [];
let calls = 0;
try {
  for (const card of CARDS) for (const { name, moment } of MOMENTS[card.id].slice(0, perCard)) {
    const prompt = rpsVoicePrompt({ persona: card.persona, mood: card.mood, fatigue: null, moment });
    if (dry) { results.push({ card: card.id, name, prompt }); console.log(`--- ${card.id} ${name}\n${prompt}`); continue; }
    calls++;
    const started = Date.now();
    let raw = '', usage: unknown = null, error: string | null = null;
    try { const answer = await quickLineWithClaude(prompt, RPS_VOICE_SYSTEM_PROMPT, AbortSignal.timeout(30_000)); raw = answer.text; usage = answer.usage; }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const ms = Date.now() - started, line = parseRpsVoice(raw);
    const signs = line ? draftSigns(line) : [];
    results.push({ card: card.id, name, kind: moment.kind, ms, line, raw: raw.slice(0, 400), usage, error, signs });
    console.log(`${card.id.padEnd(8)} ${name.padEnd(8)} ${String(ms).padStart(5)} ms  ${line === null ? `拒收（${error ?? raw.slice(0, 80).replace(/\s+/gu, ' ')}）` : line === '' ? '（不说）' : line}${signs.length ? `  迹象 ${signs.join('/')}` : ''}`);
    if (error) break; // A failed request ends the run; nothing is retried.
  }
} finally {
  if (!dry) {
    entries.push({ at: new Date().toISOString(), label, kind: 'rps-voice', model: 'haiku', replies: calls, judges: 0 });
    await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8');
  }
  const file = path.join(DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
  await writeFile(file, JSON.stringify({ kind: 'rps-voice', label, dry, requests: calls, results }, null, 2), 'utf8');
  const times = (results as { ms?: number }[]).map(row => row.ms).filter((ms): ms is number => typeof ms === 'number').sort((a, b) => a - b);
  if (times.length) console.log(`[rps-voice] 整句到达：中位 ${times[times.length >> 1]} ms，最快 ${times[0]} ms，最慢 ${times.at(-1)} ms（${times.length} 次）`);
  console.log(`[rps-voice] 写入 ${path.relative(root, file)}；真实调用 ${calls}，账本合计 ${used + calls}/${TASK_CAP}`);
}
