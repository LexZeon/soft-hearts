import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CHARACTER_CARD_FORMAT, CHARACTER_CARD_VERSION, defaultCharacterMoodTemplate } from '../shared/cards/character-cards';
import { loadCardFiles, parseCardFileSpec, requestCeiling, resolveOutDir } from '../scripts/lib/fidelity-card-files';
import { ALL_SCENARIOS, FIDELITY_SCENARIOS, fidelityCalls, scenarioById, selectFidelity } from '../scripts/lib/fidelity-scenarios';
import { FIDELITY_CARDS } from '../scripts/lib/fidelity-scenarios';

// "--card-file" and "--out" of the fidelity suite, with the fake Claude Code and synthetic card files in a temp folder
// (never a real private card).
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MARK = 'SYNTHETIC-CARD-MARK-7731';

const syntheticCard = (name: string) => JSON.stringify({
  format: CHARACTER_CARD_FORMAT, version: CHARACTER_CARD_VERSION,
  card: { name, description: `合成测试卡 ${MARK}`, personality: '爱笑，嘴上不饶人。', scenario: '', greeting: '', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() },
});

async function sandbox<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fidelity-cards-'));
  try { return await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [tsx, 'scripts/prompt-eval.ts', '--suite', 'fidelity', '--dry', ...args], { cwd: root, env: { ...process.env, ...env }, timeout: 120_000 });
    return { ok: true, out: stdout + stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

test('the three new generic situations exist, are not must-pass, carry the warm-and-no-guilt rubric and stay out of F1 and "all"', () => {
  for (const id of ['teased', 'sulk', 'caught']) {
    const scenario = scenarioById(id)!;
    assert.ok(scenario, id);
    assert.equal(scenario.mustPass, false);
    assert.equal(scenario.onDemand, true);
    assert.equal(scenario.turns.length, 1);
    assert.match(scenario.look, /愧疚|惩罚/u, 'never guilt-control or coldness that punishes');
    assert.match(scenario.look, /说教/u, 'never lecturing');
    assert.match(scenario.look, /小脾气|小狡猾/u, 'small temper or slyness is fine');
    assert.doesNotMatch(scenario.turns.join(''), /阿棠|Gene|Momo/u, 'tied to no character');
  }
  assert.ok(scenarioById('sulk')!.away, 'the sulk starts from an earlier small promise');
  assert.equal(FIDELITY_SCENARIOS.length, 16);
  assert.equal(selectFidelity([], 'all').length, 26);
  assert.deepEqual(selectFidelity([], 'compare').map(scenario => scenario.id), ['teased', 'sulk', 'caught']);
  assert.deepEqual(selectFidelity(['caught', 'teased', 'sulk']).map(scenario => scenario.id).sort(), ['caught', 'sulk', 'teased']);
  assert.ok(ALL_SCENARIOS.length >= 29);
  assert.deepEqual(fidelityCalls(FIDELITY_SCENARIOS, FIDELITY_CARDS), { replies: 54, judges: 48, total: 102 });
});

test('a card file spec is "path" or "label=path"; bad labels are refused', () => {
  assert.deepEqual(parseCardFileSpec('v04=C:\\x\\card.json'), { label: 'v04', file: 'C:\\x\\card.json' });
  assert.deepEqual(parseCardFileSpec('C:\\x\\v12-card.json'), { label: 'v12-card', file: 'C:\\x\\v12-card.json' });
  assert.throws(() => parseCardFileSpec('bad label=x.json'));
  assert.throws(() => parseCardFileSpec('='));
});

test('a card file loads through the app\'s importer: persona and mood come from it; an invalid file or a clashing label is refused', async () => {
  await sandbox(async dir => {
    const good = path.join(dir, 'a.json'), bad = path.join(dir, 'b.json'), extra = path.join(dir, 'c.json');
    await writeFile(good, syntheticCard('小测'));
    await writeFile(bad, JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: CHARACTER_CARD_VERSION, card: { name: 'x', modelPath: 'C:\\secret\\m.pmx', mood: defaultCharacterMoodTemplate() } }));
    await writeFile(extra, '{ not json');
    const [loaded] = await loadCardFiles([`v04=${good}`]);
    assert.equal(loaded.card.id, 'v04');
    assert.match(loaded.card.persona, new RegExp(MARK));
    assert.match(loaded.hash, /^[0-9a-f]{8}$/u);
    assert.ok(loaded.card.mood.weights.playful > 0);
    await assert.rejects(loadCardFiles([`v05=${bad}`]), /不是有效的角色卡/u);
    await assert.rejects(loadCardFiles([`v06=${extra}`]), /不是有效的角色卡/u);
    await assert.rejects(loadCardFiles([`v07=${path.join(dir, 'missing.json')}`]), /读不到/u);
    await assert.rejects(loadCardFiles([`gene=${good}`]), /重名/u);
    await assert.rejects(loadCardFiles([`x=${good}`, `x=${good}`]), /重复/u);
  });
});

test('--out is refused inside OneDrive or the repository, and required with a card file', async () => {
  await sandbox(async dir => {
    const synced = path.join(dir, 'sync');
    await mkdir(synced);
    const environment = { OneDrive: synced };
    await assert.rejects(resolveOutDir(path.join(synced, 'out'), true, environment), /OneDrive/u);
    await assert.rejects(resolveOutDir(path.join(root, '.local', 'x'), true, {}), /repository/u);
    await assert.rejects(resolveOutDir('', true, {}), /必须给 --out/u);
    assert.equal(await resolveOutDir('', false, {}), null);
    const fine = path.join(dir, 'private');
    assert.equal(await resolveOutDir(fine, true, environment), fine);
  });
  assert.equal(requestCeiling('', true), 30);
  assert.equal(requestCeiling('', false), null);
  assert.equal(requestCeiling('12', true), 12);
  assert.throws(() => requestCeiling('0', true));
});

test('end to end with the fake Claude: two card files, three situations from the new set, no judge; the plan is printed first and everything lands in --out', async () => {
  await sandbox(async dir => {
    const a = path.join(dir, 'a.json'), b = path.join(dir, 'b.json'), out = path.join(dir, 'private-out');
    await writeFile(a, syntheticCard('甲'));
    await writeFile(b, syntheticCard('乙'));
    const before = await readdir(path.join(root, '.local', 'fidelity')).catch(() => [] as string[]);
    const result = await cli(['--scenarios', 'betrayed,teased,sulk,caught', '--card-file', `v04=${a}`, '--card-file', `v12=${b}`, '--no-judge', '--model', 'opus', '--out', out, '--label', 'cmp']);
    assert.ok(result.ok, result.out);
    assert.match(result.out, /2 张卡 × 4 个情景 = 8 次回复 = 8 次请求/u, 'the planned request count comes first');
    assert.ok(result.out.indexOf('次请求') < result.out.indexOf('v04/betrayed'), 'planned count before the first reply');
    assert.match(result.out, /v04#[0-9a-f]{8}/u);
    assert.doesNotMatch(result.out, new RegExp(MARK), 'the card text is never logged');
    const files = await readdir(out);
    assert.ok(files.some(name => name.endsWith('-cmp.json')) && files.some(name => name.endsWith('-cmp.md')), files.join());
    const record = JSON.parse(await readFile(path.join(out, files.find(name => name.endsWith('.json'))!), 'utf8'));
    assert.deepEqual(record.cards, ['v04', 'v12']);
    assert.deepEqual(record.scenarios, ['betrayed', 'teased', 'sulk', 'caught']);
    assert.equal(record.chatModel, 'opus');
    assert.equal(record.cases.length, 8);
    assert.ok(record.cases.every((item: { replies: unknown[] }) => item.replies.length === 1));
    const after = await readdir(path.join(root, '.local', 'fidelity')).catch(() => [] as string[]);
    assert.deepEqual(after, before, 'nothing of a private-card run lands in .local/fidelity');
  });
});

test('the planned count respects --max-requests (default 30 with a card file), judge calls included', async () => {
  await sandbox(async dir => {
    const a = path.join(dir, 'a.json'), out = path.join(dir, 'private-out');
    await writeFile(a, syntheticCard('甲'));
    const tooMany = await cli(['--group', 'core', '--card-file', `v04=${a}`, '--card-file', `v12=${a}`, '--no-judge', '--out', out]);
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.out, /超过 --max-requests 30，没有开始/u);
    assert.deepEqual(await readdir(out), [], 'nothing was written');
    const judged = await cli(['--scenarios', 'teased,sulk', '--card-file', `v04=${a}`, '--out', out, '--max-requests', '3']);
    assert.equal(judged.ok, false);
    assert.match(judged.out, /计划 4 次请求，超过 --max-requests 3/u);
    const allowed = await cli(['--scenarios', 'teased,sulk', '--card-file', `v04=${a}`, '--out', out, '--max-requests', '4']);
    assert.ok(allowed.ok, allowed.out);
  });
});

test('a card file run without --out, or with --out in the repository, does not start', async () => {
  await sandbox(async dir => {
    const a = path.join(dir, 'a.json');
    await writeFile(a, syntheticCard('甲'));
    const none = await cli(['--scenarios', 'teased', '--card-file', a, '--no-judge']);
    assert.equal(none.ok, false);
    assert.match(none.out, /必须给 --out/u);
    const inRepo = await cli(['--scenarios', 'teased', '--card-file', a, '--no-judge', '--out', path.join(root, '.local', 'private-cards-out')]);
    assert.equal(inRepo.ok, false);
    assert.match(inRepo.out, /repository|OneDrive/u);
    const synced = path.join(dir, 'sync');
    await mkdir(synced);
    const inCloud = await cli(['--scenarios', 'teased', '--card-file', a, '--no-judge', '--out', path.join(synced, 'o')], { OneDrive: synced });
    assert.equal(inCloud.ok, false);
    assert.match(inCloud.out, /OneDrive/u);
  });
});
