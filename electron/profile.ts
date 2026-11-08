import { constants, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Claude fork: own profile + temp folder so it never shares data or the single-instance lock with the original soft hearts.
 * %APPDATA%\soft-hearts-claude is the user's real profile. Only the installed stable channel uses it, through
 * release/desktop-profile.json (electron/desktop-channel.ts). The temp folder keeps this name.
 */
export const PROFILE_FOLDER = "soft-hearts-claude";
/**
 * Everything else: source runs (start-soft-hearts.cmd, pnpm dev, pnpm start) and unmanaged packaged builds. Same folder
 * as the development channel; scripts/source-profile.mjs seeds it once from the stable profile.
 */
export const DEVELOPMENT_PROFILE_FOLDER = "soft-hearts-claude-dev";

const samePath = (a: string, b: string) => {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * The explicit profile a normal startup asks for: the installed channel's own (`channelProfile ?? --user-data-dir`), else
 * MMD_DESK_USER_DATA for source runs only. main.ts and the quit switch (electron/graceful-quit.ts) both use it, so a quit
 * request always looks for the instance on exactly the profile that instance started with.
 */
export function startupProfileOverride(
  channelOrSwitch: string,
  packaged: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return channelOrSwitch || (!packaged ? environment.MMD_DESK_USER_DATA : undefined) || undefined;
}

/** Where prepareProfileDirectory puts the profile, without creating or copying anything. */
export function profileDirectoryFor(
  appDataDirectory: string,
  override?: string,
  stableChannel = false,
): string {
  // The real profile is reachable only from the verified stable channel, never from a source run or a stray switch.
  if (override && !stableChannel && samePath(override, path.join(appDataDirectory, PROFILE_FOLDER)))
    throw new Error("Only the installed stable channel uses the stable profile; source and development runs use soft-hearts-claude-dev.");
  return override
    ? path.resolve(override)
    : path.join(appDataDirectory, DEVELOPMENT_PROFILE_FOLDER);
}

export function prepareProfileDirectory(
  appDataDirectory: string,
  override?: string,
  stableChannel = false,
): string {
  const directory = profileDirectoryFor(appDataDirectory, override, stableChannel);
  mkdirSync(directory, { recursive: true });
  if (override) return directory;

  for (const legacy of ["delicate-hearts", "mmd-desk-mate"]) {
    try {
      // Prefer the most recent profile, copy only settings, and retain the source.
      // COPYFILE_EXCL preserves an existing target even if another instance wins.
      copyFileSync(
        path.join(appDataDirectory, legacy, "settings.json"),
        path.join(directory, "settings.json"),
        constants.COPYFILE_EXCL,
      );
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") break;
      if (code !== "ENOENT") throw error;
    }
  }
  return directory;
}
