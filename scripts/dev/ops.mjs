#!/usr/bin/env node
// One entry point for the everyday operations (I-141, overhaul plan section 7 item 5): every Claude segment used to look up the
// handbook and piece the commands together. Each operation has a Chinese line saying what it does and what to watch out for.
//
//   node scripts/dev/ops.mjs                 list them
//   node scripts/dev/ops.mjs <name> [args…]  run one; the args go after its own
//
// Two kinds:
//   - run: safe to run whenever (tests, checks, building in throw-away folders, reading the real profile for a backup);
//   - careful: touches something the user may be using or a decision that is theirs (quitting or opening an app, the stable
//     version). These print the command and why, and run only with --go as the first argument after the name, after the
//     check the line names. They never bypass the scripts' own checks (heavy gate, pretrial occupancy, nightly window).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortcutName } from '../lib/app-identity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = process.execPath;
const desktop = () => (process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : path.join(process.env.USERPROFILE ?? '', 'Desktop'));
const explorer = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
// shortcutName already ends in ".lnk" (2026-11-18: an extra ".lnk" here made open-dev hand explorer a file that does not exist).
const shortcut = (channel) => path.join(desktop(), shortcutName(channel));

/** name → { kind, what, watch?, command(args) → [program, ...args] }. Order is the order of the list. */
export const OPS = {
  test: { kind: 'run', what: '全量测试（自己过重活门）', command: (a) => [NODE, 'scripts/dev/test-all.mjs', ...a] },
  affected: { kind: 'run', what: '只跑这次改动影响到的测试（--files a,b 指定文件）', command: (a) => [NODE, 'scripts/dev/test-affected.mjs', ...a] },
  owned: { kind: 'run', what: '只跑一个部分的测试（参数：部分名，如 mood；多个用逗号）', command: (a) => [NODE, 'scripts/dev/test-affected.mjs', '--owned', ...a] },
  typecheck: { kind: 'run', what: '类型检查（tsc --noEmit）', command: (a) => [NODE, '--max-old-space-size=4096', 'node_modules/typescript/bin/tsc', '--noEmit', ...a] },
  layers: { kind: 'run', what: '分层检查：基础、部分、接线之间有没有越界（--strict 变多就失败）', command: (a) => [NODE, 'scripts/dev/structure-inventory.mjs', '--check-layers', ...a] },
  sizes: { kind: 'run', what: '大小检查：热点文件和 main.ts 的处理函数个数只能变少，其他大文件涨不过 4 KB，新文件不超过 40 KB（--repin <文件> --reason 理由 才能抬高）', command: (a) => [NODE, 'scripts/dev/size-check.mjs', ...a] },
  mutate: { kind: 'run', what: '变异检查：把一个部分的关口一个个弄坏，看有没有测试失败（--part <部分> [--id a,b]；--list 看清单；--check 只核对清单还对得上代码）', watch: '跑变异要几分钟到几十分钟，自己过重活门；--list 和 --check 不跑测试，直接执行。清单在 scripts/dev/mutations/，用法见 docs/claude/2026-11-16-dev-tools-size-mutate.md。', command: (a) => (a.includes('--list') || a.includes('--check') ? [NODE, 'scripts/dev/mutate.mjs', ...a] : [NODE, 'scripts/dev/heavy.mjs', '--label', 'mutate', '--', NODE, 'scripts/dev/mutate.mjs', ...a]) },
  candidate: { kind: 'run', what: '从一个提交打包候选：单元测试、打包冒烟、关键预试用（参数：提交号）', watch: '打包冒烟和预试用都在临时配置里跑，自己过重活门。', command: (a) => [NODE, 'scripts/dev/build-candidate.mjs', ...a] },
  pretrial: { kind: 'run', what: '预试用：用假 Claude 把开发版过一遍试用卡（参数：--commit <提交号> [--cards R29f,L4]）', watch: '会在沟通桥的 真机占用.md 登记自己；真 Claude 只在 --real-budget > 0 时用。', command: (a) => [NODE, 'scripts/pretrial/run.mjs', ...a] },
  'chat-acceptance': { kind: 'careful', what: '聊天验收：用你的真 Claude 在隔离临时配置里聊 12 句（窗口 8 句、全屏 Unbound 4 句），查首字时间、是否复用热进程，回复存私人文件夹（参数：<提交号|候选目录> [--call] [--senses] [--card <角色卡文件>] [--dry]；--senses 在隔离配置里开真摄像头和屏幕共享，换一套能走到 I-166 的句子，表里多「小图」「凑近看」两列，基线单独记）', watch: '会用掉你的 Claude 用量（至多 12 句、35 条调用，你 2026-11-21 说「可以」）；动到聊天、朗读、感知进回合（看图、凑近看）、气泡、回复路径、Unbound 说话的改动，装开发版前跑；--dry 用假 Claude 不花用量。会开桌宠窗口（左上角）和短暂的全屏 Unbound，自己登记真机占用。', command: (a) => [NODE, 'scripts/pretrial/chat-acceptance.mjs', '--commit', ...a] },
  baseline: { kind: 'run', what: '量基线：首帧、空闲处理器和内存（参数：--exe <打包好的 exe> [--runs 3]）', command: (a) => [NODE, 'scripts/dev/heavy.mjs', '--label', 'baseline', '--', NODE, 'scripts/dev/baseline.mjs', ...a] },
  soak: { kind: 'run', what: '长时间稳定测试：打包候选在隔离临时配置里开几个小时，每 5 分钟量内存、处理器、句柄、帧间隔、报错（参数：[--hours 4 | --minutes 20] [--unbound] [--exe <exe>]）', watch: '会开桌宠窗口（左上角，置顶）、自己登记真机占用；假 Claude，不开摄像头、麦克风、屏幕；跑完在 .local/soak/ 出 soak.md 和 soak.json。', command: (a) => [NODE, 'scripts/dev/soak.mjs', ...a] },
  'stable-status': { kind: 'run', what: '看今晚 1 点要不要更新稳定版（暂存了哪个版本）', command: (a) => [NODE, 'scripts/experience/nightly-stable.mjs', 'status', ...a] },
  backup: { kind: 'run', what: '把真实配置完整备份到私人文件夹（参数：--label <名字>）', watch: '只读配置；她开着时被占用的文件会报出来，最好在她关着时做。', command: (a) => [NODE, 'scripts/experience/backup-profile.mjs', ...a] },
  'tidy-occupancy': { kind: 'run', what: '清掉沟通桥 真机占用.md 里我们留下的过期重活登记（进程没了、pid 被别的程序占了、超过 12 小时）', watch: '只动以「Claude 重活 pid」开头的行，别人的行不碰。', command: (a) => [NODE, 'scripts/dev/presence.mjs', '--tidy', ...a] },
  'real-disk': { kind: 'run', what: '在 Claude 包外面、真实磁盘上跑一条命令（参数：-- 程序 参数…）', watch: '命令先过守门钩子。', command: (a) => [NODE, 'scripts/dev/real-disk.mjs', ...a] },
  'deploy-dev': { kind: 'careful', what: '把验证过的候选装进开发版（参数：<候选目录>）', watch: '先确认用户没在用开发版；用户定的：大修搬家和重写接线过了预试用才装。', command: (a) => [NODE, 'scripts/update-desktop.mjs', '--deploy', ...a, '--channel', 'development'] },
  'quit-dev': { kind: 'careful', what: '像托盘「退出」一样关掉开发版', watch: '先确认用户没在看它（11-15 关掉过用户正看着的那个）。', command: (a) => [NODE, 'scripts/experience/quit-app.mjs', '--channel', 'development', ...a] },
  'open-dev': { kind: 'careful', what: '用 explorer 打开开发版（不能从 Claude 的 shell 直接启动）', watch: '确认开发版没开着，再开。', command: () => [explorer(), shortcut('development')] },
  'open-stable': { kind: 'careful', what: '用 explorer 打开稳定版', watch: '只在用户说了、或她本来开着被关掉时。', command: () => [explorer(), shortcut('stable')] },
  'quit-stable': { kind: 'careful', what: '像托盘「退出」一样关掉稳定版', watch: '稳定版是用户在用的；只在用户说了时。每晚更新由 nightly-stable 自己关。', command: (a) => [NODE, 'scripts/experience/quit-app.mjs', '--channel', 'stable', ...a] },
  'stage-stable': { kind: 'careful', what: '把验证过的候选暂存给今晚 1 点装进稳定版（参数：--candidate <目录> --commit <sha> --summary <中文一句话>）', watch: '测试和预试用都过了、有把握才暂存；白天不装，恶性问题例外要先问用户。', command: (a) => [NODE, 'scripts/experience/nightly-stable.mjs', 'stage', ...a] },
  'rollback-stable': { kind: 'careful', what: '退回上一个稳定版', watch: '只在稳定版出了问题、和用户说过以后。', command: (a) => [NODE, 'scripts/update-desktop.mjs', '--rollback-stable', ...a] },
};

const shown = (argv) => argv.map((x) => (/[\s"]/.test(x) ? `"${x}"` : x)).join(' ').replace(NODE.includes(' ') ? `"${NODE}"` : NODE, 'node');

export function listText() {
  const lines = ['常用操作：node scripts/dev/ops.mjs <名字> [参数…]', ''];
  for (const kind of ['run', 'careful']) {
    lines.push(kind === 'run' ? '直接能跑的：' : '要小心的（先打印命令；查过注意事项后加 --go 才跑）：');
    for (const [name, op] of Object.entries(OPS)) {
      if (op.kind !== kind) continue;
      lines.push(`  ${name.padEnd(16)}${op.what}`);
      if (op.watch) lines.push(`  ${''.padEnd(16)}注意：${op.watch}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** What to do for argv (without node and the script): { list } | { error } | { print, command } | { run: command }. */
export function plan(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return { list: listText() };
  const [name, ...rest] = argv;
  const op = Object.hasOwn(OPS, name) ? OPS[name] : null;
  if (!op) return { error: `没有叫「${name}」的操作。\n\n${listText()}` };
  if (op.kind === 'careful') {
    const go = rest[0] === '--go';
    const command = op.command(go ? rest.slice(1) : rest);
    if (!go) return { print: `「${name}」要小心：${op.watch}\n命令：${shown(command)}\n查过以后，加 --go 再跑：node scripts/dev/ops.mjs ${name} --go …`, command };
    return { run: command };
  }
  return { run: op.command(rest) };
}

/**
 * Exit code and note for a finished command. explorer.exe returns 1 after handing a shortcut over even when the app opens
 * (2026-11-19: open-dev "failed" silently while she was already up), so for explorer 1 means "handed over", not failure.
 */
export function finish(program, status) {
  if (path.basename(program).toLowerCase() === 'explorer.exe' && (status === 0 || status === 1)) {
    return { code: 0, note: '已交给 explorer 打开（explorer 交出去后本来就返回 1，不算失败）。用 get_status 或任务管理器确认她开了。' };
  }
  return { code: status ?? 1 };
}

function main() {
  const decision = plan(process.argv.slice(2));
  if (decision.list) { console.log(decision.list); return; }
  if (decision.error) { console.error(decision.error); process.exit(2); }
  if (decision.print) { console.log(decision.print); process.exit(3); }
  const [program, ...args] = decision.run;
  const result = spawnSync(program, args, { cwd: REPO, stdio: 'inherit' });
  if (result.error) { console.error(`ops: ${result.error.message}`); process.exit(1); }
  const done = finish(program, result.status);
  if (done.note) console.log(done.note);
  process.exit(done.code);
}

if (process.argv[1]?.endsWith('ops.mjs')) main();
