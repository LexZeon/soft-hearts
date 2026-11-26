// Build a desktop candidate from one commit, the same chain every session uses (I-093: it used to live in a session's
// scratchpad and was lost with it):
//   0. line endings: a working-tree file whose endings drifted from git (CRLF where .gitattributes says LF) stops the run,
//      because the packaged smoke checks its harness against the working tree byte for byte;
//   1. git archive <commit> into .local/sources/main-<commit>;
//   2. the snapshot's frozen identity (source hash, input count, test-input count), as update-desktop.mjs prepare() computes it;
//   3. update-desktop.mjs --prepare pinned to that identity (unit tests + packaged smoke in an isolated profile);
//   4. the critical pretrial set (K1–K7, then K14 「Unbound 走一圈」, then K15 「第一次启动」 in an app of its own on an empty profile) on the candidate.
// prepare and the pretrial pass the I-030 heavy gate themselves. Stops at the first failure.
//   node scripts/dev/build-candidate.mjs <commit> [--skip-pretrial] [--logs <folder>]
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..');

/**
 * Files whose working-tree endings drifted from the index (`git ls-files --eol` rows with i/lf, w/crlf and an eol=lf
 * attribute). Windows script files (.ps1 .cmd .bat) are listed apart: CRLF there is harmless and nothing compares them.
 */
export function lineEndingDrift(eolListing) {
  const blocking = [], harmless = [];
  for (const row of String(eolListing).split(/\r?\n/u)) {
    const match = /^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*?)\t(.+)$/u.exec(row);
    if (!match) continue;
    const [, index, work, attr, file] = match;
    if (index !== 'lf' || work !== 'crlf' || !/\beol=lf\b/u.test(attr)) continue;
    (/\.(?:ps1|cmd|bat)$/iu.test(file) ? harmless : blocking).push(file);
  }
  return { blocking, harmless };
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

/**
 * The snapshot's identity, computed with the working tree's update-desktop.mjs exactly as `prepare --source <snapshot>` does.
 * update-desktop.mjs lists some inputs (the shipped docs) from its `--source` folder when it loads, so this runs in a child process
 * that carries `--source <snapshot>`: in this process the list would come from the working tree, and an older snapshot (a stable
 * hotfix) would then miss a doc only the working tree has.
 */
export function snapshotIdentity(base) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--identity-of', base, '--source', base], { cwd: repo, encoding: 'utf8' });
  return JSON.parse(out.trim().split(/\r?\n/u).at(-1));
}

async function printIdentity(base) {
  const { runtimeInputs, workspaceSourceHash } = await import(pathToFileURL(path.join(repo, 'scripts', 'update-desktop.mjs')).href);
  const inputs = [...runtimeInputs.fixed.map(file => path.join(base, file)),
    ...(await Promise.all(runtimeInputs.folders.map(folder => files(path.join(base, folder))))).flat()];
  const tests = inputs.filter(file => path.relative(base, file).replaceAll('\\', '/').startsWith('tests/')).length;
  console.log(JSON.stringify({ hash: await workspaceSourceHash(base), count: inputs.length, tests }));
}

/** Runs node with these arguments in the repo, output to a log file; resolves with the exit code. */
function runLogged(args, logFile) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile);
    const child = spawn(process.execPath, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', reject);
    child.on('close', code => log.end(() => resolve(code ?? 1)));
  });
}

const tail = async (file, lines) => {
  const { readFile } = await import('node:fs/promises');
  return (await readFile(file, 'utf8')).trimEnd().split(/\r?\n/u).slice(-lines).join('\n');
};

async function main() {
  const args = process.argv.slice(2);
  const commitArg = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--logs');
  if (!commitArg) { console.error('用法：node scripts/dev/build-candidate.mjs <提交> [--skip-pretrial] [--logs <文件夹>]'); process.exit(2); }
  const skipPretrial = args.includes('--skip-pretrial');
  const logsAt = args.indexOf('--logs');
  const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const commit = git('rev-parse', '--short=8', `${commitArg}^{commit}`).trim();
  const logs = path.resolve(logsAt >= 0 ? args[logsAt + 1] : path.join(repo, '.local', 'logs', 'build-candidate'));
  await mkdir(logs, { recursive: true });
  console.log(`提交 ${commit}，日志在 ${logs}`);

  const drift = lineEndingDrift(git('-c', 'core.quotepath=false', 'ls-files', '--eol'));
  if (drift.harmless.length) console.log(`（换行和 git 不一致但不影响打包：${drift.harmless.join('、')}）`);
  if (drift.blocking.length) {
    console.error(`停：这些文件的换行被改成了 CRLF，和 git 里不一致（内容没变的话，删掉后 git checkout -- <文件> 即可）：\n  ${drift.blocking.join('\n  ')}`);
    process.exit(1);
  }

  const source = path.join(repo, '.local', 'sources', `main-${commit}`);
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  const tarball = path.join(logs, `main-${commit}.tar`);
  git('archive', '--format=tar', '-o', tarball, commit);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-x', '-f', tarball, '-C', source], { stdio: 'inherit' });
  await rm(tarball, { force: true });

  const identity = await snapshotIdentity(source);
  console.log(`身份：${JSON.stringify(identity)}`);

  const prepareLog = path.join(logs, `${commit}-prepare.log`);
  const prepared = await runLogged([path.join('scripts', 'update-desktop.mjs'), '--prepare', '--source', source, '--unit-plan', 'native-product-v1',
    '--expected-source-hash', identity.hash, '--expected-input-count', String(identity.count), '--expected-test-input-count', String(identity.tests)], prepareLog);
  const prepareTail = await tail(prepareLog, 15);
  if (prepared !== 0 || !prepareTail.includes('Validated candidate')) {
    console.error(`停：打包没通过（${prepareLog}）\n${prepareTail}`);
    process.exit(1);
  }
  console.log(prepareTail.split('\n').slice(-2).join('\n'));
  if (skipPretrial) return;

  const pretrialLog = path.join(logs, `${commit}-pretrial.log`);
  const pretrial = await runLogged([path.join('scripts', 'pretrial', 'run.mjs'), '--commit', commit, '--set', 'critical'], pretrialLog);
  console.log(await tail(pretrialLog, 16));
  process.exit(pretrial);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--identity-of');
  if (at >= 0) await printIdentity(path.resolve(process.argv[at + 1]));
  else await main();
}
