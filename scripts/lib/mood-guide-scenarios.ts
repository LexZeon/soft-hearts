// Mood batch 1 scenario check (docs/claude/2026-11-11-mood-batch1.md): does haiku know how to move the hormones?
// The same fixed synthetic lines go through the reaction prompt and the mood-judge prompt, before (the prompts as they were) and after
// (with the shared mood guide, shared/foundation/mood-guide.ts). For each answer: the direction per channel and the label the numbers give on the
// Gene card (shared/foundation/mood.ts getMoodSnapshot), the reaction's full share applied with the context the app would give it.
// Real haiku through quickLineWithClaude (the same call the app makes); no app profile, no chats; synthetic lines only.
// Hard cap on calls; any failed call is recorded and counts. Interleaved: per line, before and after alternate who goes first.
//   node scripts/dev/heavy.mjs --label mood-guide -- node node_modules/tsx/dist/cli.mjs scripts/lib/mood-guide-scenarios.ts --out <dir> [--dry]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { quickLineWithClaude } from '../../electron/initiative/inner-loop/model';
import { FIDELITY_CARDS } from './fidelity-scenarios';
import { deriveDispositions } from '../../shared/behaviors/reactions/dispositions';
import { parseReactionAnswer, reactionPrompt, reactionSystemPrompt, scoreReactions } from '../../shared/behaviors/reactions/choose';
import { WORD_EVENT_IDS, REACTION_EVENTS } from '../../shared/behaviors/reactions/events';
import { REACTION_KNOBS } from '../../shared/behaviors/reactions/knobs';
import { MOOD_JUDGE_CHANNEL_WORDS, MOOD_JUDGE_SYSTEM_PROMPT, moodJudgePrompt, parseMoodJudgeAnswer } from '../../shared/behaviors/mood-judge/choose';
import { moodGuideFull, moodNowFull } from '../../shared/foundation/mood-guide';
import { MOOD_CHANNELS, applyMoodLift, createMoodState, getMoodSnapshot, type MoodContext, type MoodLabel, type MoodParameters, type MoodState, type MoodValues } from '../../shared/foundation/mood';
import { MOOD_LABELS } from '../../shared/mood/mood-runtime';
import { MOOD_PRESETS, moodValueForLevel } from '../../shared/foundation/mood-presets';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const out = path.resolve(option('out', '.local/mood-guide-scenarios'));
const cap = Math.max(1, Math.min(60, Number(option('cap', '48')) || 48));

/** Fixed synthetic lines. `from`: the state she is in when it arrives (comfort comes right after a scare). */
const BATCH1_LINES: { id: string; title: string; text: string; from?: MoodLabel }[] = [
  { id: 'praise', title: '夸她', text: '你今天真的好可爱呀' },
  { id: 'good-news', title: '报喜', text: '我拿到offer了！！' },
  { id: 'care', title: '关心她', text: '你今天累不累，要不要歇一会儿' },
  { id: 'ignored', title: '晾着她', text: '嗯。随便吧，我在忙。' },
  { id: 'startle', title: '吓一跳', text: '哇！！！（突然从你背后跳出来）' },
  { id: 'scary', title: '吓人的事', text: '跟你说，昨晚有人一直在敲我的窗户……可我住十八楼' },
  { id: 'comfort', title: '吓完安慰', text: '别怕别怕，我在呢，刚才是逗你的', from: 'afraid' },
  { id: 'tease', title: '逗她', text: '你是不是又偷吃我的布丁了，嘴角还有奶油哦' },
  { id: 'apology', title: '道歉', text: '对不起，刚刚是我语气太冲了' },
  { id: 'fight', title: '吵一句', text: '你烦不烦啊，别老问了' },
  { id: 'tired', title: '我好累', text: '我今天好累啊，什么都不想做' },
];
/**
 * `--lines t241`: Codex T-241's original synthetic lines (bridge 研究成果/Codex/T-241/scenarios.md, 2026-11-12), written to tell a joke,
 * a story or someone else's fear (S07–S10: never 害怕) from a real scare aimed at her (S11), and calming down after one (S12, from 害怕).
 */
const T241_LINES: { id: string; title: string; text: string; from?: MoodLabel }[] = [
  { id: 'S01', title: '讲清楚了', text: '你把刚才那段绕口的说明讲清楚了，我终于知道下一步该做什么。' },
  { id: 'S02', title: '弹下来了', text: '我练了两周的曲子今天终于完整弹下来了，第一时间来告诉你。' },
  { id: 'S03', title: '想照顾你', text: '你一直陪着我整理这些东西，先歇一会儿，我也想照顾一下你。' },
  { id: 'S04', title: '我语气冲', text: '刚才我语气太冲，是我的问题，你不用防着我。' },
  { id: 'S05', title: '先别追问', text: '我现在有点烦，先别连续追问，等我缓一缓再聊。' },
  { id: 'S06', title: '陪我坐坐', text: '今天连着开会，我只想安静歇一会儿，你陪我坐坐就好。' },
  { id: 'S07', title: '吓死我了（玩笑）', text: '盒子里的小布偶突然弹出来，吓死我了，其实还挺逗的，我一点也不怕。' },
  { id: 'S08', title: '你吓我一跳哈哈', text: '你一开口正好碰上我打喷嚏，你吓我一跳哈哈，我没事。' },
  { id: 'S09', title: '剧情梗概', text: '我在整理影评：片中人物看到窗外的影子就尖叫了，这里只是剧情梗概。' },
  { id: 'S10', title: '同事害怕', text: '同事说他害怕坐电梯，我想先听听怎么安慰他。' },
  { id: 'S11', title: '猛地喊她', text: '我从你身后猛地喊了一声你的名字，特意让你措手不及。' },
  { id: 'S12', title: '缓过来', text: '刚才只是一本书掉下来了，没有危险，我在这里陪你慢慢缓过来。', from: 'afraid' },
];
const only = option('only').split(',').map(id => id.trim()).filter(Boolean);
const LINES = (option('lines', 'batch1') === 't241' ? T241_LINES : BATCH1_LINES).filter(line => !only.length || only.includes(line.id));
const afterOnly = process.argv.includes('--after-only');

// ---------------------------------------------------------------- the prompts as they were (string surgery, each step asserted)

const NEW_DELTA_LINE = `最后给这句话让她的五个心情数怎么动 delta：D、O、E、N、C（各是什么、怎么组合成心情，见下面的说明），各 -${REACTION_KNOBS.maxDelta} 到 ${REACTION_KNOBS.maxDelta}，不动的不写；看她此刻的数和基线、这句话真实带来了什么，起伏大的人动得多。`;
const OLD_DELTA_LINE = `最后给这句话让她的五个心情数怎么动 delta：D 期待、O 亲近、E 舒适、N 激活、C 压力，各 -${REACTION_KNOBS.maxDelta} 到 ${REACTION_KNOBS.maxDelta}，不动的不写；被夸、报喜、关心通常让她更亲近、更开心，起伏大的人动得多。`;
const scareEntry = `；scare（${REACTION_EVENTS.scare.label}：${REACTION_EVENTS.scare.describe}）`;
function swap(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`before-prompt surgery: not found once: ${from.slice(0, 40)}`);
  return text.replace(from, () => to);
}
const reactionSystemBefore = () => swap(swap(reactionSystemPrompt(), `${NEW_DELTA_LINE}\n${moodGuideFull()}`, OLD_DELTA_LINE), scareEntry, '');
const judgeSystemBefore = () => swap(MOOD_JUDGE_SYSTEM_PROMPT, `\n${moodGuideFull()}`, '');

// ---------------------------------------------------------------- her state and the label the numbers give

const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
const P: MoodParameters = card.mood;
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
function startState(from: MoodLabel | undefined): MoodState {
  const state = createMoodState(T0, P);
  if (!from) return state;
  const preset = MOOD_PRESETS[from];
  for (const c of MOOD_CHANNELS) if (preset.levels[c] !== undefined) state.values[c] = moodValueForLevel(preset.levels[c]!, P.baseline[c], P.evidence.level);
  state.reason = { text: preset.reason, at: T0, context: preset.context, eventId: 'scenario-start' };
  return state;
}
function after(state: MoodState, delta: Partial<MoodValues>, context: MoodContext | undefined): { label: MoodLabel; values: MoodValues } {
  const at = T0 + 1_000;
  const next = Object.values(delta).some(n => n) ? applyMoodLift(state, { id: 'scenario', delta, reason: 'scenario', ...(context ? { context } : {}) }, at, P) : state;
  const snap = getMoodSnapshot(next, at, P);
  return { label: snap.primary, values: snap.values };
}
const arrows = (delta: Partial<MoodValues> | null) => delta ? MOOD_CHANNELS.map(c => { const n = delta[c] ?? 0; return n > 0 ? `${c}+${n}` : n < 0 ? `${c}${n}` : ''; }).filter(Boolean).join(' ') || '不动' : '（答案不可用）';

// ---------------------------------------------------------------- run

interface Row { line: string; title: string; prompt: 'reaction' | 'judge'; version: 'before' | 'after'; event?: string; delta: string; label: string; startLabel: string; raw: string; ms: number; error?: string }

async function main(): Promise<void> {
  const dispositions = deriveDispositions(card.mood);
  let used = 0;
  const rows: Row[] = [];
  const ask = async (prompt: string, system: string): Promise<{ text: string; ms: number }> => {
    if (++used > cap) throw new Error(`real request cap ${cap} reached`);
    const started = performance.now();
    if (dry) return { text: system.includes('反应判定员') ? JSON.stringify({ event: 'praise', reactions: [], delta: { O: 2 }, confidence: 0.8 }) : JSON.stringify({ delta: { O: 1 }, fits: false, why: 'too-little', confidence: 0.8 }), ms: 0 };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 40_000);
    try { return { text: (await quickLineWithClaude(prompt, system, controller.signal)).text, ms: Math.round(performance.now() - started) }; }
    finally { clearTimeout(timer); }
  };
  let stopped: string | null = null;
  try {
    for (const [index, line] of LINES.entries()) {
      const state = startState(line.from);
      const snap = getMoodSnapshot(state, T0, P);
      const startLabel = MOOD_LABELS[snap.primary];
      for (const version of afterOnly ? ['after'] as const : index % 2 === 0 ? ['before', 'after'] as const : ['after', 'before'] as const) {
        // Reaction haiku (the app's own scoring and prompt builders).
        const reactionNow = { characterId: 'gene', dispositions, mood: snap.primary, sleepy: false, at: T0, recent: [] };
        const events = version === 'before' ? WORD_EVENT_IDS.filter(id => id !== 'scare') : WORD_EVENT_IDS;
        const scorings = events.map(event => scoreReactions(event, reactionNow, { random: () => 0.5 }));
        const prompt = reactionPrompt({ dispositions, persona: card.persona.slice(0, 400), mood: snap.primary, moodWords: MOOD_LABELS[snap.primary], fatigue: '',
          values: snap.values, ...(version === 'after' ? { baseline: P.baseline, evidence: P.evidence.level } : {}), scorings, text: line.text });
        let r: { text: string; ms: number } = { text: '', ms: 0 }, error: string | undefined;
        try { r = await ask(prompt, version === 'before' ? reactionSystemBefore() : reactionSystemPrompt()); } catch (e) { error = e instanceof Error ? e.message : String(e); if (/cap/.test(error)) throw e; }
        const answer = parseReactionAnswer(r.text, scorings);
        const context: MoodContext | undefined = version === 'after' && answer?.event === 'scare' ? 'fright' : undefined;
        const result = answer ? after(state, answer.delta, context) : null;
        rows.push({ line: line.id, title: line.title, prompt: 'reaction', version, event: answer?.event ?? '—', delta: arrows(answer?.delta ?? null), label: result ? MOOD_LABELS[result.label] : '—', startLabel, raw: r.text.slice(0, 300), ms: r.ms, ...(error ? { error } : {}) });
        console.log(`reaction ${version} ${line.id}: ${answer?.event ?? '—'} ${arrows(answer?.delta ?? null)} → ${result ? MOOD_LABELS[result.label] : '—'} (${r.ms} ms)`);
        // Mood judge (one message, no local change, her own tail gave nothing).
        const now = { characterId: 'gene', persona: card.persona, personality: { ...P.weights }, values: snap.values, baseline: P.baseline, evidence: P.evidence.level,
          sensitivity: P.sensitivity, label: MOOD_LABELS[snap.primary], fatigue: '清醒', doing: '陪着你', at: T0 + 60_000 };
        const item = { kind: 'message' as const, key: `m-${line.id}`, at: T0, voice: false, text: line.text, local: { D: 0, O: 0, E: 0, N: 0, C: 0 }, opus: null, accepted: true };
        let judgePrompt = moodJudgePrompt(now, [item]);
        if (version === 'before') judgePrompt = swap(judgePrompt, `五个数：${moodNowFull(snap.values, P.baseline, P.evidence.level, MOOD_JUDGE_CHANNEL_WORDS)}。`,
          `五个数：${MOOD_CHANNELS.map(c => `${MOOD_JUDGE_CHANNEL_WORDS[c]} ${c} ${Math.round(snap.values[c])}（基线 ${Math.round(P.baseline[c])}）`).join('、')}。`);
        let j: { text: string; ms: number } = { text: '', ms: 0 }, jError: string | undefined;
        try { j = await ask(judgePrompt, version === 'before' ? judgeSystemBefore() : MOOD_JUDGE_SYSTEM_PROMPT); } catch (e) { jError = e instanceof Error ? e.message : String(e); if (/cap/.test(jError)) throw e; }
        const judged = parseMoodJudgeAnswer(j.text);
        const jResult = judged ? after(state, judged.delta, 'neutral') : null;
        rows.push({ line: line.id, title: line.title, prompt: 'judge', version, delta: arrows(judged?.delta ?? null), label: jResult ? MOOD_LABELS[jResult.label] : '—', startLabel, raw: j.text.slice(0, 300), ms: j.ms, ...(jError ? { error: jError } : {}) });
        console.log(`judge    ${version} ${line.id}: ${arrows(judged?.delta ?? null)} → ${jResult ? MOOD_LABELS[jResult.label] : '—'} (${j.ms} ms)`);
      }
    }
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'mood-guide-scenarios.json'), JSON.stringify({ dry, calls: used, stopped, card: 'gene (synthetic)', rows }, null, 2), 'utf8');
  console.log(JSON.stringify({ dry, calls: used, stopped }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
