import { lstat, realpath } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { BodyRecipeId } from '../shared/body-motion';

const RECIPES = Object.freeze({ neutral: 'idle.neutral', proud: 'idle.proud', confirm: 'body.confirm' } as const);
export interface BodyQaStartup {
  readonly switchValue: string;
  readonly explicitProfile: string;
  readonly defaultProfile: string;
  readonly systemTemp: string;
  readonly actualProfile: string;
  readonly argv: readonly string[];
}
const same = (left: string, right: string) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

function declaredRecipe(input: BodyQaStartup): BodyRecipeId | null {
  if (!input || !Object.hasOwn(RECIPES, input.switchValue) || !path.isAbsolute(input.explicitProfile)
    || !path.isAbsolute(input.defaultProfile) || !path.isAbsolute(input.systemTemp) || !path.isAbsolute(input.actualProfile)
    || !/^soft-hearts-body-qa-[A-Za-z0-9_-]{16,80}$/.test(path.basename(input.explicitProfile))) return null;
  if (!Array.isArray(input.argv) || input.argv.some(value => typeof value !== 'string')) return null;
  const choices = input.argv.filter(value => /^--behavior-body-qa/i.test(value));
  const profiles = input.argv.filter(value => /^--user-data-dir/i.test(value));
  if (choices.length !== 1 || choices[0] !== `--behavior-body-qa=${input.switchValue}`
    || profiles.length !== 1 || profiles[0] !== `--user-data-dir=${input.explicitProfile}`) return null;
  return RECIPES[input.switchValue as keyof typeof RECIPES];
}
function verifiedPaths(input: BodyQaStartup, profile: string, temporary: string, actual: string, normal: string): boolean {
  return inside(temporary, profile) && same(path.dirname(profile), temporary) && !same(profile, normal)
    && same(actual, profile) && same(profile, path.resolve(input.explicitProfile));
}

/** Startup-only maintainer scope. No IPC, user-profile changes or stored enable flag. */
export async function readBodyQaStartup(input: BodyQaStartup): Promise<BodyRecipeId | null> {
  const recipe = declaredRecipe(input); if (!recipe) return null;
  try {
    const info = await lstat(input.explicitProfile);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const [profile, temporary, actual, normal] = await Promise.all([realpath(input.explicitProfile), realpath(input.systemTemp),
      realpath(input.actualProfile), realpath(input.defaultProfile).catch(() => path.resolve(input.defaultProfile))]);
    if (!verifiedPaths(input, profile, temporary, actual, normal)) return null;
    // An ancestor junction must not turn a claimed temporary profile into a
    // foreign directory; realpath is authoritative, not a textual prefix.
    return recipe;
  } catch { return null; }
}

/** Same checks before Electron can open or migrate any profile. */
export function readBodyQaStartupSync(input: BodyQaStartup): BodyRecipeId | null {
  const recipe = declaredRecipe(input); if (!recipe) return null;
  try {
    const info = lstatSync(input.explicitProfile);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    let normal: string;
    try { normal = realpathSync(input.defaultProfile); } catch { normal = path.resolve(input.defaultProfile); }
    return verifiedPaths(input, realpathSync(input.explicitProfile), realpathSync(input.systemTemp), realpathSync(input.actualProfile), normal)
      ? recipe : null;
  } catch { return null; }
}

export interface BodyStartupSelection {
  readonly qaIntent?: boolean;
  readonly startup: Omit<BodyQaStartup, 'actualProfile'>;
  readonly prepareNormal: () => string;
  readonly setAppProfile: (profile: string) => void;
  readonly getAppProfile: () => string;
}
/** Invalid QA intent aborts before the normal-profile callback can run. */
export function selectBodyStartupProfile(input: BodyStartupSelection): { profile: string; recipeId: BodyRecipeId | null } {
  const intent = input.qaIntent === true || input.startup.switchValue !== '' || input.startup.argv.some(value => /^--behavior-body-qa/i.test(value));
  if (!intent) return { profile: input.prepareNormal(), recipeId: null };
  const declared = { ...input.startup, actualProfile: input.startup.explicitProfile };
  const recipeId = readBodyQaStartupSync(declared);
  if (!recipeId) throw new Error('身体动作 QA 需要唯一有效参数和已创建的独立临时配置，启动已停止。');
  input.setAppProfile(input.startup.explicitProfile);
  const actual = input.getAppProfile();
  if (readBodyQaStartupSync({ ...declared, actualProfile: actual }) !== recipeId)
    throw new Error('身体动作 QA 的实际配置目录不匹配，启动已停止。');
  return { profile: actual, recipeId };
}
