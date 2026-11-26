// The window↔host API surface golden (scripts/dev/contracts-surface.mjs; docs/claude/2026-11-16-contracts-split.md): every name
// shared/contracts.ts exports and the shape it resolves to, DesktopAPI flattened member by member (kind, optional mark, full type,
// doc comment). Splitting the file into per-part slices must leave it unchanged; an intended API change regenerates it (and says
// why in the commit). The contract is types only: it compiles to an empty module, so no bundle includes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSurface, emittedJs, SURFACE_FILE, CONTRACT } from '../scripts/dev/contracts-surface.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGENERATE = 'regenerate with `node scripts/dev/contracts-surface.mjs --write` only if the API change is intended, and say why in the commit';

const live = buildSurface(ROOT);

test('the contract surface matches the golden (tests/fixtures/contracts-surface.json)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, SURFACE_FILE), 'utf8'));
  assert.deepEqual(live.counts, golden.counts, `contract surface: counts changed; ${REGENERATE}`);
  const goldenMembers = new Map(golden.desktopApi.map((m) => [m.name, m]));
  for (const member of live.desktopApi) assert.deepEqual(member, goldenMembers.get(member.name), `DesktopAPI.${member.name} changed; ${REGENERATE}`);
  assert.deepEqual(live.desktopApi.map((m) => m.name), golden.desktopApi.map((m) => m.name), `DesktopAPI members added or removed; ${REGENERATE}`);
  for (const name of Object.keys(golden.exports)) assert.deepEqual(live.exports[name], golden.exports[name], `export ${name} changed; ${REGENERATE}`);
  assert.deepEqual(Object.keys(live.exports), Object.keys(golden.exports), `exports added or removed; ${REGENERATE}`);
  assert.deepEqual(live, golden);
});

test('the contract is types only: no runtime value, and it compiles to an empty module', () => {
  assert.deepEqual(live.runtimeValues, []);
  assert.equal(CONTRACT, 'shared/contracts.ts');
  assert.equal(emittedJs(ROOT, CONTRACT), 'export {};');
  assert.equal(live.windowDesktop, 'DesktopAPI', 'the renderer global stays window.desktop: DesktopAPI');
});

test('the golden is not empty where it matters', () => {
  assert.ok(live.counts.desktopApiMembers > 400);
  assert.ok(live.desktopApi.every((m) => m.kind === 'method'), 'every DesktopAPI member is a method signature');
  assert.ok(live.desktopApi.some((m) => m.name === 'chat' && m.type === '(request: ChatRequest) => Promise<void>'));
  assert.deepEqual(live.desktopApi.filter((m) => m.optional).map((m) => m.name).sort(), ['ackUnboundSay', 'askUnboundAgain', 'getChannelGates', 'getUnbound', 'onUnbound', 'onUnboundSay', 'setChannelGates', 'setUnbound', 'toggleUnbound', 'voiceKeep']);
});

// ---- The per-part slices (step 1): DesktopAPI declares nothing itself; it extends one slice per part, shared/<part>/desktop-api.ts. ----
const SLICES = [
  'shared/settings/desktop-api.ts', 'shared/stage/desktop-api.ts', 'shared/senses/desktop-api.ts', 'shared/memory/desktop-api.ts',
  'shared/mood/desktop-api.ts', 'shared/brain/desktop-api.ts', 'shared/unbound/desktop-api.ts', 'shared/initiative/desktop-api.ts',
  'shared/safety/desktop-api.ts', 'shared/cards/desktop-api.ts', 'shared/voice/desktop-api.ts', 'shared/actions/desktop-api.ts',
];

test('DesktopAPI is the per-part slices joined: every member in exactly one slice, none in contracts.ts itself', async () => {
  const { desktopApiSlices } = await import('./helpers/desktop-api-source.ts');
  const { PART_IDS } = await import('../scripts/dev/structure-parts.mjs');
  const { slices, ownMembers } = desktopApiSlices(ROOT);
  assert.equal(ownMembers.trim(), '', "a new window↔host call goes into its part's slice, not into DesktopAPI in shared/contracts.ts");
  assert.deepEqual(slices.map((s) => s.file), SLICES, 'DesktopAPI extends exactly these slices, in part order');
  for (const s of slices) {
    const part = /^shared\/([a-z]+)\/desktop-api\.ts$/.exec(s.file)?.[1];
    assert.ok(PART_IDS.includes(part), `${s.file}: a slice lives in a part's shared folder`);
    assert.equal(s.name, `${part[0].toUpperCase()}${part.slice(1)}DesktopAPI`, `${s.file}: the slice is named after its part`);
    assert.ok(s.memberNames.length > 0, `${s.file}: an empty slice`);
  }
  const all = slices.flatMap((s) => s.memberNames);
  assert.equal(new Set(all).size, all.length, 'a member declared in two slices');
  assert.deepEqual([...all].sort(), live.desktopApi.map((m) => m.name), 'the slices hold exactly the DesktopAPI members');
});

test('every slice is types only: it compiles to an empty module', () => {
  for (const file of SLICES) assert.equal(emittedJs(ROOT, file), 'export {};', file);
});
