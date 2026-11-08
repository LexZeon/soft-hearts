/**
 * Model lab command line (scripts/model-lab.ts; usage in
 * docs/claude/2026-11-02-model-lab.md). Reads a local config, checks the
 * report folder is private (guard.ts), runs analyze.ts on every model with the
 * bundled library motions (72 now), and writes `<reportDir>/<id>/report.{json,md}` plus
 * `<reportDir>/summary.{json,md}`. Writes nothing anywhere else; never uses
 * the network; does not start Electron or touch any app profile.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUNDLED_GENE_SHA256, analyzeModel, catalogMotionFiles, emptyReport, labMotion, motionKey, type LabMotion, type ModelReport } from './analyze';
import {
  CONFIG_ENV, DEFAULT_CONFIG, LabError, REPO_ROOT, assertPrivateReportDir, blockNetwork, defaultPathContext, isInside, parseLabConfig, privatePathProblem,
  type PathContext,
} from './guard';
import { buildSummary, renderModelMarkdown, renderSummaryMarkdown } from './report';

export interface LabIo { out(line: string): void; err(line: string): void }
export interface LabOptions {
  env?: Readonly<Record<string, string | undefined>>;
  io?: LabIo;
  /** Path checks (tests substitute junction resolution); defaults to this checkout and the real filesystem. */
  paths?: PathContext;
  now?: () => Date;
}

export const USAGE = `soft hearts model lab: profile, collision proxy and the bundled library motions on your own MMD models (no Electron, no network).

  node node_modules/tsx/dist/cli.mjs scripts/model-lab.ts [--config <file>] [--only <id,id>] [--motions <pack/motion,...>]

  --config   lab config (default: $${CONFIG_ENV}, else ${DEFAULT_CONFIG})
  --only     run only these model ids
  --motions  run only these motions (e.g. gene/thinking,fnoji-dances/split-dance)

Config (keep it next to your models, outside the repository and OneDrive):
  { "reportDir": "C:\\\\mmd-test\\\\reports", "models": [ { "id": "alice", "pmx": "C:\\\\mmd-test\\\\alice\\\\alice.pmx" } ] }
Writes <reportDir>/<id>/report.json, report.md and <reportDir>/summary.json, summary.md.`;

function parseArgs(argv: readonly string[]): { config?: string; only?: string[]; motions?: string[]; help: boolean } {
  const result: { config?: string; only?: string[]; motions?: string[]; help: boolean } = { help: false };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k], [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => { const next = inline ?? argv[++k]; if (next === undefined || next === '') throw new LabError(`${flag} needs a value`); return next; };
    const list = () => value().split(',').map(item => item.trim()).filter(Boolean);
    if (flag === '--help' || flag === '-h') result.help = true;
    else if (flag === '--config' || flag === '-c') result.config = value();
    else if (flag === '--only') result.only = list();
    else if (flag === '--motions') result.motions = list();
    else throw new LabError(`Unknown argument ${arg}`);
  }
  return result;
}

/** Writes one report file, only ever below the checked report folder. */
function writeInside(reportDir: string, relative: string, content: string, context: PathContext): void {
  const target = path.resolve(reportDir, relative);
  if (!isInside(target, reportDir, context) || target === path.resolve(reportDir)) throw new LabError(`Refusing to write ${target}: outside ${reportDir}`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/** Loads and parses the bundled motions from this checkout (sha256-pinned by the catalog). */
export function loadBundledMotions(filter?: readonly string[]): LabMotion[] {
  const files = catalogMotionFiles();
  const unknown = (filter ?? []).filter(key => !files.some(file => motionKey(file) === key));
  if (unknown.length) throw new LabError(`Unknown motion ${unknown.join(', ')} (use pack/motion ids from shared/motion-catalog.json)`);
  return files.filter(file => !filter?.length || filter.includes(motionKey(file)))
    .map(file => labMotion(file, new Uint8Array(readFileSync(path.join(REPO_ROOT, file.relativePath)))));
}

/** Runs the lab; resolves to the exit code (0 all models analysed, 1 usage/config/privacy error, 2 some model failed). */
export async function runModelLab(argv: readonly string[], options: LabOptions = {}): Promise<number> {
  const env = options.env ?? process.env, io = options.io ?? { out: line => console.log(line), err: line => console.error(line) };
  const context = options.paths ?? defaultPathContext(env), now = options.now ?? (() => new Date());
  const restoreNetwork = blockNetwork();
  try {
    const args = parseArgs(argv);
    if (args.help) { io.out(USAGE); return 0; }
    const configPath = path.resolve(args.config ?? env[CONFIG_ENV] ?? DEFAULT_CONFIG);
    if (!existsSync(configPath)) throw new LabError(`No lab config at ${configPath}. Create it (format below) or pass --config.\n\n${USAGE}`);
    const configProblem = privatePathProblem(configPath, context);
    if (configProblem?.kind === 'repository' || configProblem?.kind === 'git')
      throw new LabError(`Refusing config: ${configProblem.message}. Keep the config next to your models, outside the repository.`);
    if (configProblem) io.err(`warning: ${configProblem.message}; the config lists your model paths, consider keeping it outside OneDrive.`);
    const config = parseLabConfig(readFileSync(configPath, 'utf8'), configPath);
    assertPrivateReportDir(config.reportDir, context);
    const unknownIds = (args.only ?? []).filter(id => !config.models.some(model => model.id === id));
    if (unknownIds.length) throw new LabError(`--only: no model ${unknownIds.join(', ')} in ${configPath}`);
    const models = config.models.filter(model => !args.only?.length || args.only.includes(model.id));

    const loading = performance.now();
    const motions = loadBundledMotions(args.motions);
    io.out(`model-lab: ${models.length} model(s), ${motions.length} motion(s) loaded in ${Math.round(performance.now() - loading)} ms; reports → ${config.reportDir}`);

    const reports: ModelReport[] = [], generatedAt = now().toISOString();
    for (const [index, model] of models.entries()) {
      let report: ModelReport;
      if (!existsSync(model.pmx) || !statSync(model.pmx).isFile()) {
        report = emptyReport({ id: model.id, file: path.basename(model.pmx), path: model.pmx, bytes: 0, sha256: '', bundledGene: false, name: null }, `PMX not found: ${model.pmx}`);
      } else {
        const bytes = new Uint8Array(readFileSync(model.pmx));
        const where = privatePathProblem(model.pmx, context);
        if (where && createHash('sha256').update(bytes).digest('hex') !== BUNDLED_GENE_SHA256)
          io.err(`warning: ${model.id}: ${where.message}; models with personal-use licences should stay in a local folder like C:\\mmd-test.`);
        report = analyzeModel({ id: model.id, file: path.basename(model.pmx), path: model.pmx, bytes }, motions);
      }
      reports.push(report);
      writeInside(config.reportDir, path.join(report.model.id, 'report.json'), `${JSON.stringify({ generatedAt, ...report }, null, 2)}\n`, context);
      writeInside(config.reportDir, path.join(report.model.id, 'report.md'), renderModelMarkdown(report, generatedAt), context);
      const t = report.totals;
      io.out(report.ok
        ? `[${index + 1}/${models.length}] ${model.id}: ${t.usable}/${t.motions} usable (ok ${t.ok}, adjusted ${t.adjusted}, hidden ${t.hidden}) in ${Math.round(report.timings.totalMs)} ms`
        : `[${index + 1}/${models.length}] ${model.id}: FAILED: ${report.error}`);
    }
    const summary = buildSummary(reports, generatedAt, motions.length);
    writeInside(config.reportDir, 'summary.json', `${JSON.stringify(summary, null, 2)}\n`, context);
    writeInside(config.reportDir, 'summary.md', renderSummaryMarkdown(summary), context);
    io.out(`model-lab: wrote ${path.join(config.reportDir, 'summary.md')}`);
    return reports.every(report => report.ok) ? 0 : 2;
  } catch (error) {
    io.err(error instanceof LabError ? error.message : `model-lab failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  } finally {
    restoreNetwork();
  }
}
