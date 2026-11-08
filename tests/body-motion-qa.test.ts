import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBodyQaStartup, selectBodyStartupProfile } from '../electron/body-motion-qa';

async function removeOwnedTemporary(directory: string): Promise<void> {
  const actual = await realpath(directory), temporary = await realpath(tmpdir());
  assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
  assert.match(path.basename(actual), /^soft-(?:hearts-body-qa-|body-qa-guard-)/);
  assert.equal((await lstat(directory)).isSymbolicLink(), false);
  await rm(actual, { recursive: true, force: true });
}

test('body QA requires a fixed startup choice and an explicitly isolated existing temporary profile', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), `soft-hearts-body-qa-${randomUUID()}-`));
  const input = { switchValue: 'neutral', explicitProfile: profile, actualProfile: profile,
    defaultProfile: path.join(tmpdir(), 'normal-soft-hearts'), systemTemp: tmpdir(),
    argv: [`--behavior-body-qa=neutral`, `--user-data-dir=${profile}`] };
  const selection = (value: string) => ({ ...input, switchValue: value, argv: [`--behavior-body-qa=${value}`, `--user-data-dir=${profile}`] });
  try {
    assert.equal(await readBodyQaStartup(input), 'idle.neutral');
    assert.equal(await readBodyQaStartup(selection('proud')), 'idle.proud');
    assert.equal(await readBodyQaStartup(selection('confirm')), 'body.confirm');
    for (const value of ['', 'idle.neutral', '__proto__', '../neutral', 'anything'])
      assert.equal(await readBodyQaStartup(selection(value)), null);
    for (const patch of [{ explicitProfile: '' }, { explicitProfile: 'relative-profile' }, { systemTemp: 'relative' },
      { defaultProfile: profile }, { systemTemp: path.join(profile, 'nested') }])
      assert.equal(await readBodyQaStartup({ ...input, ...patch }), null);
    for (const argv of [[], [...input.argv, '--behavior-body-qa=neutral'], [...input.argv, `--user-data-dir=${profile}`],
      ['--behavior-body-qa', `--user-data-dir=${profile}`], [...input.argv, '--behavior-body-qa-unknown=confirm'],
      [...input.argv, '--BEHAVIOR-BODY-QA=neutral'], [...input.argv, '--BEHAVIOR-BODY-QA-unknown=x'],
      [...input.argv, `--USER-DATA-DIR=${profile}`]])
      assert.equal(await readBodyQaStartup({ ...input, argv }), null);
    assert.equal(await readBodyQaStartup({ ...input, actualProfile: tmpdir() }), null);
  } finally { await removeOwnedTemporary(profile); }
});

test('ordinary profiles and misleading Temp descendants never enable QA', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'soft-body-qa-guard-'));
  try {
    const ordinary = path.join(root, 'ordinary-profile'); await mkdir(ordinary);
    const input = { switchValue: 'neutral', explicitProfile: ordinary, actualProfile: ordinary, defaultProfile: ordinary,
      systemTemp: tmpdir(), argv: ['--behavior-body-qa=neutral', `--user-data-dir=${ordinary}`] };
    assert.equal(await readBodyQaStartup(input), null);
    assert.equal(await readBodyQaStartup({ ...input, explicitProfile: path.join(root, 'soft-hearts-body-qa-missing000000000000') }), null);
    const target = path.join(root, 'foreign-profile'); await mkdir(target);
    const link = path.join(root, 'soft-hearts-body-qa-junction000000000000');
    // Windows directory junctions do not need Developer Mode. This is a bounded
    // test directory owned here; no application or normal profile is touched.
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await readBodyQaStartup({ ...input, explicitProfile: link }), null);
  } finally { await removeOwnedTemporary(root); }
});

test('invalid QA intent cannot fall back to preparing, loading or migrating a normal profile', async () => {
  let prepared = 0, assigned = 0;
  const common = { explicitProfile: '', defaultProfile: path.join(tmpdir(), 'normal-protected'), systemTemp: tmpdir() };
  for (const [switchValue, argv] of [
    ['neutral', ['--behavior-body-qa=neutral']], ['unknown', ['--behavior-body-qa=unknown']],
    ['', ['--behavior-body-qa']], ['', ['--behavior-body-qa-unknown=neutral']],
    ['', ['--BEHAVIOR-BODY-QA=neutral']], ['neutral', []],
  ] as const) {
    assert.throws(() => selectBodyStartupProfile({
      startup: { ...common, switchValue, argv }, prepareNormal: () => { prepared++; return common.defaultProfile; },
      setAppProfile: () => { assigned++; }, getAppProfile: () => common.defaultProfile,
    }), /启动已停止/);
  }
  assert.equal(prepared, 0); assert.equal(assigned, 0);
  assert.throws(() => selectBodyStartupProfile({ qaIntent: true,
    startup: { ...common, switchValue: '', argv: [] }, prepareNormal: () => { prepared++; return common.defaultProfile; },
    setAppProfile: () => { assigned++; }, getAppProfile: () => common.defaultProfile,
  }), /启动已停止/);
  assert.equal(prepared, 0); assert.equal(assigned, 0);
  const normal = selectBodyStartupProfile({ startup: { ...common, switchValue: '', argv: [] },
    prepareNormal: () => { prepared++; return common.defaultProfile; }, setAppProfile: () => { assigned++; },
    getAppProfile: () => common.defaultProfile });
  assert.equal(normal.profile, common.defaultProfile); assert.equal(normal.recipeId, null);
  assert.equal(prepared, 1); assert.equal(assigned, 0);
});

test('valid QA selects its existing canonical Temp profile before any normal-profile callback', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), `soft-hearts-body-qa-${randomUUID()}-`));
  const startup = { switchValue: 'confirm', explicitProfile: profile, defaultProfile: path.join(tmpdir(), 'normal-protected'),
    systemTemp: tmpdir(), argv: ['--behavior-body-qa=confirm', `--user-data-dir=${profile}`] };
  let actual = startup.defaultProfile, prepared = 0;
  try {
    for (const extra of ['--BEHAVIOR-BODY-QA=confirm', '--BEHAVIOR-BODY-QA-unknown=x', `--USER-DATA-DIR=${profile}`]) {
      let assignments = 0;
      assert.throws(() => selectBodyStartupProfile({ startup: { ...startup, argv: [...startup.argv, extra] },
        prepareNormal: () => { prepared++; return startup.defaultProfile; },
        setAppProfile: () => { assignments++; }, getAppProfile: () => actual }), /启动已停止/);
      assert.equal(assignments, 0); assert.equal(prepared, 0);
    }
    const result = selectBodyStartupProfile({ startup, prepareNormal: () => { prepared++; return startup.defaultProfile; },
      setAppProfile: value => { actual = value; }, getAppProfile: () => actual });
    assert.deepEqual(result, { profile, recipeId: 'body.confirm' }); assert.equal(prepared, 0);
    assert.throws(() => selectBodyStartupProfile({ startup, prepareNormal: () => { prepared++; return startup.defaultProfile; },
      setAppProfile: () => {}, getAppProfile: () => startup.defaultProfile }), /实际配置目录/);
    assert.equal(prepared, 0);
  } finally { await removeOwnedTemporary(profile); }
});
