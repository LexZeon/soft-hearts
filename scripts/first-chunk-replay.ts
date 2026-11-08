// I-029: compare the two first-chunk modes on invented replies (docs/claude/2026-11-04-i029-comma-first-reading.md).
//   node node_modules/tsx/dist/cli.mjs scripts/first-chunk-replay.ts [--seeds 5] [--verbose]
// Fake stream, fake bubble paint, fake voices, virtual clock: no window, no Claude, no Bailian, nothing paid. Light (seconds).
import { CASES, LATENCY, PROFILES, percentile, replay, type ReplayResult, type Voice } from '../tests/fixtures/first-chunk-replay';
import { FIRST_CHUNK_MIN_UNITS, type FirstSpeechChunk } from '../shared/first-speech-chunk';

const args = process.argv.slice(2);
const seeds = Number(args[args.indexOf('--seeds') + 1]) > 0 && args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 5;
const verbose = args.includes('--verbose');
const only = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const MODES: FirstSpeechChunk[] = ['sentence', 'comma'];
const VOICES: Voice[] = ['system', 'bailian'];

const results: ReplayResult[] = [];
for (const profile of PROFILES) for (const voice of VOICES) for (const mode of MODES) for (const c of CASES) {
  if ((only('--profile') && only('--profile') !== profile.name) || (only('--voice') && only('--voice') !== voice)
    || (only('--mode') && only('--mode') !== mode) || (only('--case') && only('--case') !== c.id)) continue;
  const bailian = only('--bailian')?.split('-').map(Number) as [number, number] | undefined;
  for (let seed = 1; seed <= seeds; seed++) {
    if (args.includes('--progress')) process.stderr.write(`${profile.name}/${voice}/${mode}/${c.id}/${seed}\n`);
    results.push(await replay(c, { profile, voice, mode, seed, ...(bailian?.length === 2 ? { bailianFirstAudio: bailian } : {}),
      ...(only('--min') ? { minUnits: Number(only('--min')) } : {}) }));
  }
}

const ms = (value: number | null) => value === null ? '—' : `${Math.round(value)}`;
const violations = results.flatMap(r => r.violations.map(v => `${r.caseId}/${r.profile}/${r.voice}/${r.mode}/${r.seed}: ${v}`));
console.log(`回放 ${results.length} 次（${CASES.length} 条编的回复 × ${PROFILES.length} 种流速 × 2 种声音 × 2 种模式 × ${seeds} 个随机种子）`);
console.log(`假延迟：IPC ${LATENCY.ipc} ms，气泡画出 ${LATENCY.paint} ms，系统声音开口 ${LATENCY.systemStart.join('–')} ms（之后每句 ${LATENCY.systemNext.join('–')} ms），百炼首包 ${only('--bailian') ?? LATENCY.bailianFirstAudio.join('-')} ms，朗读 ${LATENCY.unitsPerSecond} 字/秒；逗号先读的最少字数 ${only('--min') ?? `系统声音 ${FIRST_CHUNK_MIN_UNITS.system}、百炼 ${FIRST_CHUNK_MIN_UNITS.bailian}`}`);
console.log(`违规：${violations.length}`);
for (const line of violations.slice(0, 20)) console.log('  ' + line);
console.log('');
console.log('| 流速 | 声音 | 模式 | 首字显示→开口 中位数 | p90 | 第一段在逗号处切开 | 切开时第一段字数（中位数） | 第一段和第二段之间多出的停顿 中位数 / p90 / >300ms |');
console.log('|---|---|---|---|---|---|---|---|');
for (const profile of PROFILES) for (const voice of VOICES) for (const mode of MODES) {
  const rows = results.filter(r => r.profile === profile.name && r.voice === voice && r.mode === mode);
  const delays = rows.map(r => r.delayMs).filter((v): v is number => v !== null);
  const cut = rows.filter(r => r.firstCut);
  const lengths = cut.map(r => Array.from(r.pieces[0].text).length);
  // Comma mode: the gap at the comma (inside the first sentence), only for replies it cut. Sentence mode: between the
  // first two sentences of the same replies, for comparison.
  const cutIds = new Set(results.filter(r => r.profile === profile.name && r.voice === voice && r.mode === 'comma' && r.firstCut).map(r => `${r.caseId}/${r.seed}`));
  const gaps = rows.filter(r => cutIds.has(`${r.caseId}/${r.seed}`)).map(r => r.gapMs).filter((v): v is number => v !== null);
  console.log(`| ${profile.label} | ${voice === 'system' ? '系统声音' : '百炼'} | ${mode === 'sentence' ? '整句' : '逗号先读'} | ${ms(percentile(delays, 0.5))} | ${ms(percentile(delays, 0.9))} | `
    + `${cut.length}/${rows.length} | ${lengths.length ? percentile(lengths, 0.5) : '—'} | `
    + `${gaps.length ? `${ms(percentile(gaps, 0.5))} / ${ms(percentile(gaps, 0.9))} / ${gaps.filter(g => g > 300).length}/${gaps.length}` : '—'} |`);
}
// Per-reply saving: comma minus sentence, same case, profile, voice and seed.
console.log('');
console.log('| 流速 | 声音 | 逗号先读比整句早开口（只算被切开的回复）中位数 | p90 | 最多 |');
console.log('|---|---|---|---|---|');
for (const profile of PROFILES) for (const voice of VOICES) {
  const saved: number[] = [];
  for (const r of results.filter(x => x.profile === profile.name && x.voice === voice && x.mode === 'comma' && x.firstCut)) {
    const base = results.find(x => x.profile === r.profile && x.voice === r.voice && x.mode === 'sentence' && x.caseId === r.caseId && x.seed === r.seed);
    if (base?.audioAt != null && r.audioAt != null) saved.push(base.audioAt - r.audioAt);
  }
  console.log(`| ${profile.label} | ${voice === 'system' ? '系统声音' : '百炼'} | ${ms(percentile(saved, 0.5))} | ${ms(percentile(saved, 0.9))} | ${ms(saved.length ? Math.max(...saved) : null)} |`);
}
// Where the comma mode cut, per case (same in every run: the cut depends only on the text).
console.log('');
console.log('| 回复 | 说明 | 逗号先读的第一段：系统声音 | 百炼 |');
console.log('|---|---|---|---|');
const cutOf = (r: ReplayResult | undefined) => !r ? '—' : r.firstCut ? `「${r.pieces[0].text.replaceAll('|', '｜')}」` : '不切（整句）';
for (const c of CASES) {
  const of = (voice: Voice) => results.find(x => x.caseId === c.id && x.mode === 'comma' && x.voice === voice && x.seed === 1);
  if (!of('system') && !of('bailian')) continue;
  console.log(`| ${c.id} | ${c.note} | ${cutOf(of('system'))} | ${cutOf(of('bailian'))} |`);
}
if (verbose) for (const r of results) console.log(JSON.stringify({ case: r.caseId, profile: r.profile, voice: r.voice, mode: r.mode, seed: r.seed,
  visibleAt: r.visibleAt, audioAt: r.audioAt, delay: r.delayMs, gap: r.gapMs, pieces: r.pieces.map(p => [p.text, Math.round(p.start ?? -1)]) }));
process.exitCode = violations.length ? 1 : 0;
