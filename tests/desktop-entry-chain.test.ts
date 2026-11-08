// Source dependency/order evidence only. This never loads Electron or proves native operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test('the product desktop integration branch has one fixed action and does not load the normal runtime', async () => {
  const text = await readFile(new URL('../electron/desktop-entry.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('desktop-entry.ts', text, ts.ScriptTarget.Latest, true);
  const imports = tree.statements.filter(ts.isImportDeclaration).map(row => row.moduleSpecifier.getText(tree));
  assert.deepEqual(imports, ["'electron'", "'node:fs'", "'node:path'", "'original-fs'", "'./desktop-channel'", "'./desktop-shortcut'",
    "'./graceful-quit'", "'../scripts/lib/app-identity.mjs'"]);
  // 正常退出开关 first: it only asks the instance on its profile to quit and exits; no runtime, no window, no ready wait.
  const quit = tree.statements.find(ts.isIfStatement)!; assert.ok(quit);
  assert.equal(quit.expression.getText(tree), 'app.commandLine.hasSwitch(QUIT_SWITCH)');
  const quitting = quit.thenStatement.getText(tree);
  assert.doesNotMatch(quitting, /import\(|require\(|BrowserWindow|whenReady|spawn\(|execFile/);
  assert.ok(quitting.includes('runQuitProcess(') && quitting.trimEnd().endsWith('app.exit(result.exitCode);\n}'));
  const branch = quit.elseStatement!; assert.ok(branch && ts.isIfStatement(branch));
  assert.equal(branch.expression.getText(tree), "!app.commandLine.hasSwitch('soft-hearts-install-desktop-entry')");
  assert.ok(branch.thenStatement.getText(tree).includes("import('./main')"));
  assert.ok(branch.elseStatement); const maintenance = branch.elseStatement.getText(tree);
  assert.doesNotMatch(maintenance, /import\(|require\(|BrowserWindow|spawn\(|execFile|requestSingleInstanceLock/);
  assert.ok(maintenance.indexOf("app.setPath('userData'") < maintenance.indexOf('app.whenReady()'));
  for (const file of ['desktop-entry.ts', 'desktop-channel.ts', 'desktop-shortcut.ts', 'graceful-quit.ts']) {
    const source = await readFile(new URL('../electron/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.ps1|powershell|ELECTRON_RUN_AS_NODE|child_process|ipcMain|eval\(/i);
  }
});

test('managed profile selection and native startup markers precede the existing normal profile and single-instance lock', async () => {
  const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const select = main.indexOf('const installedDesktopChannel = resolveInstalledDesktopChannel(');
  const profile = main.indexOf('const bodyStartupProfile ='); const lock = main.indexOf('app.requestSingleInstanceLock()');
  assert.ok(select >= 0 && select < profile && profile < lock);
  assert.ok(main.slice(select, profile).includes('installedDesktopChannel?.profile'));
  const selectedStartup = main.slice(select, lock);
  for (const marker of ["app.commandLine.appendSwitch('soft-hearts-channel', installedDesktopChannel.channel)",
    "app.commandLine.appendSwitch('soft-hearts-build', installedDesktopChannel.asarSha256)",
    "app.commandLine.appendSwitch('soft-hearts-desktop', installedDesktopChannel.ownerMarker)",
    // The running channel uses the same taskbar identity as the shortcut that its own product entry wrote.
    "app.setAppUserModelId(appUserModelId(installedDesktopChannel.channel))"]) assert.ok(selectedStartup.includes(marker));
  assert.ok(main.slice(profile, lock).includes("app.setPath('userData', bodyStartupProfile.profile)"));
  const build = await readFile(new URL('../scripts/build-electron.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes('main: "electron/desktop-entry.ts"'));
});
