// The product's one packaged main entry. A fixed desktop-integration action never loads the companion runtime, and
// neither does the quit switch (electron/graceful-quit.ts): it only tells the instance on its profile to quit.
import { app, shell } from 'electron';
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import originalFs from 'original-fs';
import { resolveInstalledDesktopChannel } from './desktop-channel';
import { installOwnDesktopShortcut } from './desktop-shortcut';
import { QUIT_SWITCH, quitTargetProfile, runQuitProcess } from './graceful-quit';
import { PRODUCT_NAME } from '../scripts/lib/app-identity.mjs';

const reason = (error: unknown) => (error instanceof Error ? error.message : 'unknown error').slice(0, 500);
const installedChannel = () => resolveInstalledDesktopChannel({ executable: process.execPath, packaged: app.isPackaged,
  platform: process.platform, defaultProfile: path.join(app.getPath('appData'), 'soft-hearts-claude'), // keep in sync with PROFILE_FOLDER in ./profile
  requestedChannel: app.commandLine.getSwitchValue('soft-hearts-channel'),
  explicitProfile: app.commandLine.getSwitchValue('user-data-dir'),
  buildMarker: app.commandLine.getSwitchValue('soft-hearts-build'), ownerMarker: app.commandLine.getSwitchValue('soft-hearts-desktop'),
  readRawArchive: file => originalFs.readFileSync(file) });
if (app.commandLine.hasSwitch(QUIT_SWITCH)) {
  app.setName(PRODUCT_NAME); // As main.ts does before its lock.
  const result = runQuitProcess({
    profile: () => quitTargetProfile({ appData: app.getPath('appData'), channel: installedChannel(),
      userDataSwitch: app.commandLine.getSwitchValue('user-data-dir'), packaged: app.isPackaged, environment: process.env }),
    profileExists: directory => { try { return statSync(directory).isDirectory(); } catch { return false; } },
    setProfile: directory => app.setPath('userData', directory),
    requestLock: request => app.requestSingleInstanceLock(request),
    releaseLock: () => app.releaseSingleInstanceLock(),
  });
  if (result.reason) console.error('soft hearts next could not ask the running app to quit: ' + result.reason.slice(0, 500));
  app.exit(result.exitCode);
} else if (!app.commandLine.hasSwitch('soft-hearts-install-desktop-entry')) {
  // The reason goes to stderr (local only): a bare "could not start" left Codex's T-212 round 3 with nothing to go on.
  void import('./main').catch((error: unknown) => {
    console.error('The companion could not start: ' + reason(error) + (error instanceof Error && error.stack ? '\n' + error.stack.split('\n').slice(1, 8).join('\n') : ''));
    app.exit(1);
  });
} else {
  try {
    const context = installedChannel();
    const ticket = app.commandLine.getSwitchValue('soft-hearts-entry-ticket');
    if (!context || !/^[a-f0-9]{32}$/.test(ticket)) throw Error('The installed channel product and a fresh ticket are required.');
    let current = context.workspaceRoot;
    for (const part of path.relative(context.workspaceRoot, context.maintenanceProfile).split(path.sep)) {
      current = path.join(current, part);
      if (!existsSync(current)) mkdirSync(current);
      if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw Error('Invalid owned desktop integration directory.');
    }
    const receiptFile = path.join(context.maintenanceProfile, `receipt-${ticket}.json`);
    if (existsSync(receiptFile)) throw Error('This desktop integration ticket already has a receipt.');
    app.setPath('userData', context.maintenanceProfile);
    app.setPath('sessionData', context.maintenanceProfile);
    void app.whenReady().then(async () => {
      // Writes only this channel's own fixed link on the user's desktop.
      const receipt = await installOwnDesktopShortcut({ ...context, kind: 'verified-own-desktop-entry-v1',
        desktopDirectory: app.getPath('desktop') }, shell);
      writeFileSync(receiptFile, JSON.stringify({ version: 1, ticket, processId: process.pid, channel: context.channel,
        executable: context.executable, asarSha256: context.asarSha256, maintenanceProfile: context.maintenanceProfile,
        receipt }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      app.exit(0);
    }).catch((error: unknown) => { console.error('The desktop shortcut could not be updated: ' + reason(error)); app.exit(1); });
  } catch (error) {
    console.error('The installed desktop entry is unavailable: ' + reason(error));
    app.exit(2);
  }
}
