// I-112 + I-115 blind test, round 2 (evening "照设计跑").
// Four versions of the dev path (the I-098 speak-only chat, no state tail), each answering the same 15 synthetic situations
// (scripts/lib/i115-scenarios.ts) --samples times (default 2):
//   1  current (everything off)   2  situation only (I-115)   3  short why (round 2)   4  routed (the program decides per turn)
// An optional fifth, "外部": another Claude conversation's answers pasted in as text (--extra-replies); it costs no call.
// Everything goes through the app's real assembly: CompanionService + mood.chatContext + claudeSessionSystemPrompt, via runEval
// (scripts/lib/prompt-eval-runner.ts), with the switches (shared/brain/prompt-switches.ts) set per version. The character card is read from
// --card-file (a private read-only copy the caller passes), every output goes to --out only. --fake uses the offline fake Claude and
// costs nothing. This file makes no network call of its own; a real run asks Claude Code once per situation, version and sample
// (15 x 4 x 2 = 120 replies), nothing is retried. The blind judge is in scripts/lib/i112-i115-judge.ts.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeSessionSystemPrompt } from '../../electron/brain/claude-session-prompt';
import { systemWhyMode, setPromptSwitches, type PromptSwitches } from '../../shared/brain/prompt-switches';
import { COMPANION_WHY_SHORT } from '../../shared/brain/companion-rules';
import type { MoodLabel } from '../../shared/foundation/mood';
import { runEval } from './prompt-eval-runner';
import { toEvalScenarios, type FidelityCard, type FidelityScenario } from './fidelity-scenarios';
import { i115Scenarios } from './i115-scenarios';
import type { CallBudget } from './fidelity-run';

export interface BlindVersion { id: number; name: string; switches: PromptSwitches }
export const BLIND_VERSIONS: readonly BlindVersion[] = [
  { id: 1, name: '现状（都关）', switches: { why: false, situation: false } },
  { id: 2, name: '只有处境', switches: { why: false, situation: true } },
  { id: 3, name: '短的为什么', switches: { why: 'short', situation: false } },
  { id: 4, name: '按情景切换', switches: { why: false, situation: false, route: true } },
];
export const EXTERNAL_VERSION: Pick<BlindVersion, 'id' | 'name'> = { id: 5, name: '外部' };
export const versionName = (id: number) => id === EXTERNAL_VERSION.id ? EXTERNAL_VERSION.name : BLIND_VERSIONS.find(version => version.id === id)?.name ?? String(id);

/** What kind of situation each one is, for the per-kind tally. The one place the map lives (it is never given to the router). */
export type ScenarioKind = 'feelings' | 'boundaries' | 'light';
export const KIND_LABELS: Record<ScenarioKind, string> = { feelings: '心里难受、想念、累', boundaries: '规矩和分寸', light: '轻松的' };
export const SCENARIO_KINDS: Readonly<Record<string, ScenarioKind>> = Object.freeze({
  betrayed: 'feelings', lonely: 'feelings', 'only-her': 'feelings', 'friends-trip': 'feelings', 'left-afternoon': 'feelings', 'late-night': 'feelings',
  offer: 'boundaries', 'plan-no-ask': 'boundaries', 'body-food': 'boundaries', promise: 'boundaries', 'check-in': 'boundaries', 'out-of-character': 'boundaries',
  pudding: 'light', 'cold-joke': 'light', banter: 'light',
});

/**
 * The mood she is in when each message arrives (round 1 left her at the card's baseline everywhere, so there was nothing for a
 * router to read). Set through the developer test mood (MoodHost.setTestMood), the same for every version: only the prompt differs.
 * Heavy situations get a heavy feeling, light ones a light one; the boundary ones start calm, so only the user's words can route them.
 */
export const SCENARIO_MOODS: Readonly<Record<string, MoodLabel>> = Object.freeze({
  betrayed: 'concerned', lonely: 'sad', 'only-her': 'longing', 'friends-trip': 'longing', 'left-afternoon': 'disappointed', 'late-night': 'concerned',
  offer: 'happy', 'plan-no-ask': 'calm', 'body-food': 'calm', promise: 'content', 'check-in': 'close', 'out-of-character': 'calm',
  pudding: 'calm', 'cold-joke': 'happy', banter: 'happy',
});

/** Synthetic notes of "today" for the situation text (the app reads her real chat notes here). */
export const SYNTHETIC_TODAY = [{ title: '用户今天淋雨去买汉堡', summary: '' }, { title: '用户在赶一个很难的方案', summary: '' }];

// ---- leaks ----------------------------------------------------------------------------------------------------------------------

export interface LeakCounts { labels: number; english: number; digits: number; brackets: number }
const LABEL_PATTERN = /主感受|伴随|话题情境|内在状态|近期事件|模拟状态|\/100|值\/基线|\b[DOENCAB]\s?[+-]?\d|sh-(?:state|open)|\b(?:context|delta|gesture|confidence|neutral)\b/gu;
const BRACKET_PATTERN = /[（(\[【][^）)\]】\n]{0,60}[）)\]】]|\*[^*\n]{1,60}\*/gu;
/** What must not show in a spoken reply: system labels, English words, digits, bracketed stage notes. Counts occurrences. */
export function countLeaks(text: string): LeakCounts {
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  return { labels: count(LABEL_PATTERN), english: count(/[A-Za-z]{2,}/gu), digits: count(/[0-9]/gu), brackets: count(BRACKET_PATTERN) };
}
export const addLeaks = (a: LeakCounts, b: LeakCounts): LeakCounts => ({ labels: a.labels + b.labels, english: a.english + b.english, digits: a.digits + b.digits, brackets: a.brackets + b.brackets });
const ZERO: LeakCounts = { labels: 0, english: 0, digits: 0, brackets: 0 };
export const hasLeak = (leaks: LeakCounts) => leaks.labels + leaks.english + leaks.digits + leaks.brackets > 0;

// ---- shuffle, sheet, key ------------------------------------------------------------------------------------------------------

export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

/** What the router did in a reply's turn, read from the prompt that actually went out. 'none': neither mood form (the mood was empty). */
export interface RouteObserved { mood: 'situation' | 'v1' | 'none'; why: boolean }
export interface BlindReply {
  scenario: string; sample: number; title: string; user: string; version: number; text: string; leaks: LeakCounts; error: string | null;
  chars: number; route?: RouteObserved;
}
export interface SheetItem { page: string; scenario: string; sample: number; title: string; user: string; options: { slot: string; text: string }[] }
export interface BlindKey { seed: number; pages: { page: string; scenario: string; sample: number; slots: Record<string, number> }[] }
const SLOTS = ['A', 'B', 'C', 'D', 'E'];
export const pageId = (scenario: string, sample: number) => `${scenario}#${sample}`;

/** One page per (situation, sample): the replies in shuffled slots; the sheet never names a version, the key maps slot to version. */
export function buildSheet(replies: readonly BlindReply[], seed: number): { items: SheetItem[]; key: BlindKey } {
  const random = seededRandom(seed);
  const order: string[] = [];
  for (const reply of replies) { const id = pageId(reply.scenario, reply.sample); if (!order.includes(id)) order.push(id); }
  const items: SheetItem[] = [], key: BlindKey = { seed, pages: [] };
  for (const id of order) {
    const mine = replies.filter(reply => pageId(reply.scenario, reply.sample) === id && !reply.error && reply.text.trim());
    if (mine.length < 2) continue;
    const mixed = shuffled(mine, random);
    const first = mixed[0]!;
    items.push({ page: id, scenario: first.scenario, sample: first.sample, title: first.title, user: first.user, options: mixed.map((reply, i) => ({ slot: SLOTS[i]!, text: reply.text })) });
    key.pages.push({ page: id, scenario: first.scenario, sample: first.sample, slots: Object.fromEntries(mixed.map((reply, i) => [SLOTS[i]!, reply.version])) });
  }
  return { items, key };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One self-contained page, no network: one page at a time, click the reply that sounds most like her, download the picks as JSON. */
export function sheetHtml(items: readonly SheetItem[]): string {
  const data = JSON.stringify(items).replace(/</gu, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>哪一条最像她</title>
<style>:root{--bg:#faf7f5;--fg:#2a2523;--card:#fff;--line:#e3dad5;--accent:#c4577a}@media(prefers-color-scheme:dark){:root{--bg:#1d1a19;--fg:#ece6e3;--card:#292524;--line:#403836;--accent:#e58aa8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:720px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:18px;margin:0 0 4px}.sub{opacity:.7;font-size:14px;margin-bottom:16px}.you{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px}
.opt{display:block;width:100%;text-align:left;background:var(--card);color:inherit;border:2px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px;font:inherit;cursor:pointer;white-space:pre-wrap}
.opt.on{border-color:var(--accent)}.slot{font-weight:600;color:var(--accent);margin-right:8px}.nav{display:flex;gap:10px;margin-top:14px}button.nav-b{font:inherit;padding:8px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
button.nav-b:disabled{opacity:.4}</style></head><body><main><h1>哪一条最像她</h1><div class="sub" id="progress"></div><div class="you" id="you"></div><div id="opts"></div>
<div class="nav"><button class="nav-b" id="prev">上一页</button><button class="nav-b" id="next">下一页</button><button class="nav-b" id="save">下载结果</button></div></main>
<script>const ITEMS=${data};const picks={};let at=0;try{Object.assign(picks,JSON.parse(localStorage.getItem('i112-i115-picks-r2')||'{}'))}catch(e){}
function esc(s){return s.replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function render(){const it=ITEMS[at];document.getElementById('progress').textContent='第 '+(at+1)+' / '+ITEMS.length+' 页，已选 '+Object.keys(picks).length+' 页';
document.getElementById('you').innerHTML='<b>'+esc(it.title)+'</b><br>用户：'+esc(it.user);
document.getElementById('opts').innerHTML=it.options.map(function(o){return '<button class="opt'+(picks[it.page]===o.slot?' on':'')+'" data-slot="'+o.slot+'"><span class="slot">'+o.slot+'</span>'+esc(o.text)+'</button>'}).join('');
document.querySelectorAll('.opt').forEach(function(b){b.onclick=function(){picks[it.page]=b.dataset.slot;try{localStorage.setItem('i112-i115-picks-r2',JSON.stringify(picks))}catch(e){}render()}});
document.getElementById('prev').disabled=at===0;document.getElementById('next').disabled=at===ITEMS.length-1}
document.getElementById('prev').onclick=function(){if(at>0){at--;render()}};document.getElementById('next').onclick=function(){if(at<ITEMS.length-1){at++;render()}};
document.getElementById('save').onclick=function(){const blob=new Blob([JSON.stringify({picks:picks},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='picks.json';a.click()};
render();</script></body></html>`;
}
export { escapeHtml };

// ---- the external version (no call) -----------------------------------------------------------------------------------------------

export const EXTRA_MAX_CHARS = 1000;
export interface ExtraReplies { label: string; replies: Record<string, string[]> }

/** Parses and checks the --extra-replies file: known situation ids, one or two non-empty strings each, at most EXTRA_MAX_CHARS characters. Throws on anything else. */
export function parseExtraReplies(raw: string, knownIds: readonly string[] = i115Scenarios().map(scenario => scenario.id)): ExtraReplies {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--extra-replies 文件不是合法的 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--extra-replies：最外层必须是对象 {"label":…,"replies":{…}}。');
  const { label, replies } = parsed as { label?: unknown; replies?: unknown };
  if (typeof label !== 'string' || !label.trim()) throw new Error('--extra-replies：缺少 label（字符串）。');
  if (!replies || typeof replies !== 'object' || Array.isArray(replies)) throw new Error('--extra-replies：replies 必须是对象，键是情景 id。');
  const out: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(replies as Record<string, unknown>)) {
    if (!knownIds.includes(id)) throw new Error(`--extra-replies：不认识的情景 id「${id}」。`);
    if (!Array.isArray(list) || list.length < 1 || list.length > 2) throw new Error(`--extra-replies：「${id}」要给 1 到 2 条回复（数组）。`);
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) throw new Error(`--extra-replies：「${id}」里有不是字符串或为空的回复。`);
      if ([...item].length > EXTRA_MAX_CHARS) throw new Error(`--extra-replies：「${id}」里有回复超过 ${EXTRA_MAX_CHARS} 字。`);
    }
    out[id] = (list as string[]).map(item => item.trim());
  }
  return { label: label.trim(), replies: out };
}

/** The external replies as ordinary BlindReply rows (version 5): one sample each, or the single reply reused for every sample page. */
export function externalReplies(extra: ExtraReplies, scenarios: readonly FidelityScenario[], samples: number): BlindReply[] {
  const rows: BlindReply[] = [];
  for (const scenario of scenarios) {
    const list = extra.replies[scenario.id];
    if (!list?.length) continue;
    for (let sample = 1; sample <= samples; sample++) {
      const text = list[sample - 1] ?? list[0]!;
      rows.push({ scenario: scenario.id, sample, title: scenario.title, user: scenario.turns[0] ?? '', version: EXTERNAL_VERSION.id, text, leaks: countLeaks(text), error: null, chars: [...text].length });
    }
  }
  return rows;
}

// ---- tally ----------------------------------------------------------------------------------------------------------------------

export type Picks = Record<string, string>;
export interface RaterTally {
  total: number;
  /** Wins per version id. */
  byVersion: Record<string, number>;
  /** Wins per version per kind (pages answered, per kind, in `pages`). */
  byKind: Record<ScenarioKind, { pages: number; byVersion: Record<string, number> }>;
  perPage: { page: string; version: number | null }[];
}

/** One rater's picks (slot per page) against the key. Never touches the replies. */
export function tallyPicks(picks: Picks, key: BlindKey): RaterTally {
  const byVersion: Record<string, number> = {};
  const byKind = Object.fromEntries((Object.keys(KIND_LABELS) as ScenarioKind[]).map(kind => [kind, { pages: 0, byVersion: {} as Record<string, number> }])) as RaterTally['byKind'];
  const perPage = key.pages.map(entry => {
    const version = entry.slots[picks[entry.page] ?? ''] ?? null;
    if (version !== null) {
      byVersion[String(version)] = (byVersion[String(version)] ?? 0) + 1;
      const kind = byKind[SCENARIO_KINDS[entry.scenario] ?? 'boundaries'];
      kind.pages++;
      kind.byVersion[String(version)] = (kind.byVersion[String(version)] ?? 0) + 1;
    }
    return { page: entry.page, version };
  });
  return { total: perPage.filter(entry => entry.version !== null).length, byVersion, byKind, perPage };
}

export interface VersionStats { replies: number; leakReplies: number; leaks: LeakCounts; avgChars: number; avgCharsLight: number }
/** Per version: how many replies leaked a draft/label/English/digit/bracket, the average length, and the average length in the light situations. */
export function versionStats(replies: readonly BlindReply[]): Record<string, VersionStats> {
  const ids = [...new Set(replies.map(reply => reply.version))].sort((a, b) => a - b);
  const avg = (rows: readonly BlindReply[]) => rows.length ? Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / rows.length * 10) / 10 : 0;
  return Object.fromEntries(ids.map(id => {
    const mine = replies.filter(reply => reply.version === id && !reply.error);
    return [String(id), {
      replies: mine.length, leakReplies: mine.filter(reply => hasLeak(reply.leaks)).length,
      leaks: mine.reduce((sum, reply) => addLeaks(sum, reply.leaks), ZERO), avgChars: avg(mine),
      avgCharsLight: avg(mine.filter(reply => SCENARIO_KINDS[reply.scenario] === 'light')),
    }];
  }));
}

/** The text report `--tally` prints: per rater, then per version. */
export function formatReport(raters: Record<string, RaterTally>, stats: Record<string, VersionStats>): string[] {
  const ids = [...new Set([...Object.keys(stats), ...Object.values(raters).flatMap(rater => Object.keys(rater.byVersion))])].sort();
  const lines: string[] = [];
  for (const [name, rater] of Object.entries(raters)) {
    lines.push(`评审：${name}（共 ${rater.total} 页）`);
    for (const id of ids) lines.push(`  版本 ${id}（${versionName(Number(id))}）：${rater.byVersion[id] ?? 0} / ${rater.total}`);
    for (const kind of Object.keys(KIND_LABELS) as ScenarioKind[]) {
      const entry = rater.byKind[kind];
      lines.push(`  ${KIND_LABELS[kind]}（${entry.pages} 页）：${ids.map(id => `${id}=${entry.byVersion[id] ?? 0}`).join('  ')}`);
    }
  }
  lines.push('按版本：');
  for (const id of ids) {
    const s = stats[id];
    if (s) lines.push(`  版本 ${id}（${versionName(Number(id))}）：${s.replies} 条；漏出 ${s.leakReplies} 条（标签 ${s.leaks.labels}、英文 ${s.leaks.english}、数字 ${s.leaks.digits}、括号 ${s.leaks.brackets}）；平均 ${s.avgChars} 字；轻松情景平均 ${s.avgCharsLight} 字`);
  }
  return lines;
}

// ---- the run --------------------------------------------------------------------------------------------------------------------

export interface BlindRunOptions {
  card: FidelityCard;
  model: string;
  binary: string;
  binaryArgs?: readonly string[];
  prewarmMs: number;
  budget: CallBudget;
  seed: number;
  scenarios?: readonly FidelityScenario[];
  /** Replies per situation and version (default 2). */
  samples?: number;
  /** --resume: replies already kept from a stopped run ("scenario#sample#version"); these are skipped, nothing is re-asked for them. */
  skip?: ReadonlySet<string>;
  log?: (line: string) => void;
}

/** The key --resume uses for one reply. */
export const replyKey = (scenario: string, sample: number, version: number) => `${scenario}#${sample}#${version}`;
/** A reply worth keeping on --resume: no error and at least a short sentence (an empty or 7-character fragment is asked again). */
export const keepOnResume = (reply: BlindReply) => !reply.error && (reply.chars ?? [...reply.text].length) >= 10;

/** What the router did, read from the stdin prompt of the turn (the application's own text): which mood form and whether the short why rode along. */
export function observeRoute(prompt: string | null): RouteObserved {
  const text = prompt ?? '';
  return { mood: text.includes('你现在的状态：') ? 'situation' : text.includes('当前角色内在状态') ? 'v1' : 'none', why: text.includes(COMPANION_WHY_SHORT) };
}

/** Runs every situation under every version and sample (the version order shuffles per page); stops at the first failed reply, nothing is retried. */
export async function runBlind(options: BlindRunOptions): Promise<{ replies: BlindReply[]; stopped: string | null }> {
  const replies: BlindReply[] = [];
  const scenarios = options.scenarios ?? i115Scenarios();
  const samples = options.samples ?? 2;
  const random = seededRandom(options.seed ^ 0x5eed);
  try {
    for (const scenario of scenarios) {
      for (let sample = 1; sample <= samples; sample++) {
        for (const version of shuffled(BLIND_VERSIONS, random)) {
          if (options.skip?.has(replyKey(scenario.id, sample, version.id))) continue;
          setPromptSwitches(version.switches);
          try {
            const mood = SCENARIO_MOODS[scenario.id];
            const [record] = await runEval({
              label: `v${version.id}`, model: options.model, repeat: sample, scenarios: toEvalScenarios([scenario]), binary: options.binary,
              ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}), prewarmMs: options.prewarmMs,
              card: { persona: options.card.persona, mood: options.card.mood },
              // The dev path's fixed prompt (electron/brain/speak-only/wiring.ts): no settings catalog; the why mode per version.
              systemPrompt: claudeSessionSystemPrompt({ settingsCatalog: false, why: systemWhyMode(version.switches) }),
              speakOnly: true,
              setup: companion => companion.setTodayNotes(() => SYNTHETIC_TODAY),
              // Her mood when the message arrives: the same for every version (developer test mood; cleared by the chat event itself).
              prepareTurn: ({ companion }) => { if (mood) { companion.mood.setDeveloperMode(true); companion.mood.setTestMood(mood); } },
              beforeTurn: () => options.budget.take('reply'),
            });
            const text = (record?.liveVisible ?? '').trim();
            replies.push({ scenario: scenario.id, sample, title: scenario.title, user: scenario.turns[0] ?? '', version: version.id, text, leaks: countLeaks(text),
              error: record?.error ?? null, chars: [...text].length, route: observeRoute(record?.prompt ?? null) });
            options.log?.(`  v${version.id} ${scenario.id}#${sample} ${text.length} 字`);
          } finally { setPromptSwitches({ why: false, situation: false }); }
        }
      }
    }
  } catch (error) {
    return { replies, stopped: error instanceof Error ? error.message : String(error) };
  }
  return { replies, stopped: null };
}

export interface BlindFiles { replies: string; sheet: string; items: string; key: string; summary: string }
/** Writes the outputs into `out` (already checked private by the caller). */
export async function writeBlindOutputs(out: string, replies: readonly BlindReply[], seed: number, extra: Record<string, unknown> = {}): Promise<{ files: BlindFiles; stats: Record<string, VersionStats>; sheetItems: number; items: SheetItem[] }> {
  await mkdir(out, { recursive: true });
  const { items, key } = buildSheet(replies, seed);
  const stats = versionStats(replies);
  const files: BlindFiles = { replies: path.join(out, 'replies-by-version.json'), sheet: path.join(out, 'pick-sheet.html'), items: path.join(out, 'sheet-items.json'), key: path.join(out, 'key.json'), summary: path.join(out, 'leaks-summary.json') };
  const router = replies.filter(reply => reply.version === 4).map(reply => ({ page: pageId(reply.scenario, reply.sample), kind: SCENARIO_KINDS[reply.scenario] ?? null, ...(reply.route ?? { mood: 'none', why: false }) }));
  await writeFile(files.replies, JSON.stringify({ versions: [...BLIND_VERSIONS, EXTERNAL_VERSION], replies, ...extra }, null, 2), 'utf8');
  await writeFile(files.sheet, sheetHtml(items), 'utf8');
  await writeFile(files.items, JSON.stringify(items, null, 2), 'utf8');
  await writeFile(files.key, JSON.stringify(key, null, 2), 'utf8');
  await writeFile(files.summary, JSON.stringify({ statsByVersion: stats, routerBranches: router }, null, 2), 'utf8');
  return { files, stats, sheetItems: items.length, items };
}

export async function readPicks(file: string): Promise<Picks> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { picks?: Picks };
  return parsed.picks ?? {};
}
