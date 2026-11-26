// CLAUDE.md: third-party assets only in the reviewed assets/bundled/**, keeping their original attribution and CC BY 4.0.
// The list is derived from the folders (not written by hand), so a new bundled asset without a notice fails here.
//   - a motion pack (assets/bundled/<vendor>/<pack>/<revision>/metadata/source.json) that is not this project's own work must name its
//     licence and source in THIRD_PARTY_NOTICES.md, carry the full licence text and its attribution file, and the attribution file
//     must say what source.json says;
//   - any other asset folder with a LICENSE file (the models and the idle data) must have its copyright line and its folder path in
//     THIRD_PARTY_NOTICES.md;
//   - a folder of this project's own character models (0.2.0: one/, mumi/) has an attribution.txt of its own and must be named in THIRD_PARTY_NOTICES.md;
//   - a folder that is none of these is unknown: it fails until someone decides what attribution it needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED = path.join(ROOT, 'assets', 'bundled');
const OWN_VENDOR = 'soft-hearts-next';
const notices = readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8').replace(/\r\n/g, '\n');
const acknowledgements = readFileSync(path.join(ROOT, 'ACKNOWLEDGEMENTS.md'), 'utf8').replace(/\r\n/g, '\n');
const dirs = (p: string) => readdirSync(p).filter(name => statSync(path.join(p, name)).isDirectory());

interface Found { vendor: string; folder: string; dir: string; kind: 'pack' | 'licensed' | 'own' | 'unknown'; revision?: string }
function found(): Found[] {
  const out: Found[] = [];
  for (const vendor of dirs(BUNDLED)) {
    const vendorDir = path.join(BUNDLED, vendor);
    if (existsSync(path.join(vendorDir, 'LICENSE'))) { out.push({ vendor, folder: '', dir: vendorDir, kind: 'licensed' }); continue; }
    if (existsSync(path.join(vendorDir, 'attribution.txt'))) { out.push({ vendor, folder: '', dir: vendorDir, kind: 'own' }); continue; }
    for (const folder of dirs(vendorDir)) {
      const dir = path.join(vendorDir, folder);
      const revision = dirs(dir).find(name => existsSync(path.join(dir, name, 'metadata', 'source.json')));
      if (revision) out.push({ vendor, folder, dir, kind: 'pack', revision });
      else if (existsSync(path.join(dir, 'LICENSE'))) out.push({ vendor, folder, dir, kind: 'licensed' });
      else out.push({ vendor, folder, dir, kind: 'unknown' });
    }
  }
  return out;
}

test('the bundled folders are found (so the checks below are not empty)', () => {
  const all = found();
  assert.ok(all.filter(item => item.kind === 'pack').length >= 6, 'the motion packs');
  assert.ok(all.filter(item => item.kind === 'licensed').length >= 3, 'the folders with a LICENSE file');
});

test('every bundled folder is a motion pack with a source file or has a LICENSE: nothing unknown is shipped', () => {
  const unknown = found().filter(item => item.kind === 'unknown').map(item => path.relative(ROOT, item.dir));
  assert.deepEqual(unknown, [], 'name the licence and attribution of these (a source.json in a revision folder, or a LICENSE file) and in THIRD_PARTY_NOTICES.md');
});

test('every third-party motion pack names its licence and source in THIRD_PARTY_NOTICES.md and keeps its attribution files', () => {
  for (const item of found().filter(entry => entry.kind === 'pack')) {
    const metadata = path.join(item.dir, item.revision!, 'metadata');
    const where = `${item.vendor}/${item.folder}`;
    const source = JSON.parse(readFileSync(path.join(metadata, 'source.json'), 'utf8'));
    assert.equal(typeof source.license?.id, 'string', `${where}: source.json names a licence`);
    assert.equal(typeof source.license?.attribution, 'string', `${where}: source.json has the attribution line`);
    assert.ok(source.license.attribution.trim().length > 20, `${where}: the attribution line is not empty`);
    if (item.vendor === OWN_VENDOR) {
      // This project's own generated motions: MIT, from this repository (the repository's own LICENSE covers them).
      assert.equal(source.license.id, 'MIT', where);
      assert.ok(existsSync(path.join(ROOT, 'LICENSE')), 'the repository LICENSE');
      continue;
    }
    assert.notEqual(source.license.id, 'MIT', `${where}: a third-party pack under MIT would need its own copyright line; decide it here`);
    assert.equal(source.license.id, 'CC-BY-4.0', `${where}: only CC BY 4.0 packs are reviewed for this folder`);
    // The notices name the licence and link the source; the pack keeps the full licence text and its attribution line.
    assert.match(notices, /CC BY 4\.0|Creative Commons Attribution 4\.0/, 'the notices name CC BY 4.0');
    assert.ok(typeof source.sourceUrl === 'string' && notices.includes(source.sourceUrl), `${where}: THIRD_PARTY_NOTICES.md links the source ${source.sourceUrl}`);
    const text = readFileSync(path.join(metadata, 'cc-by-4.0.txt'), 'utf8');
    assert.match(text, /Creative Commons Attribution 4\.0 International/, `${where}: the full licence text is kept`);
    assert.ok(text.length > 10_000, `${where}: the licence text is whole`);
    const attribution = readFileSync(path.join(metadata, 'attribution.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(attribution.includes(source.license.attribution), `${where}: attribution.txt keeps the attribution line of source.json`);
    assert.match(attribution, /CC BY 4\.0|CC-BY-4\.0|Creative Commons Attribution 4\.0/i, `${where}: attribution.txt names the licence`);
  }
});

test('every bundled folder with a LICENSE file has its copyright line and its path in THIRD_PARTY_NOTICES.md', () => {
  for (const item of found().filter(entry => entry.kind === 'licensed')) {
    const rel = path.relative(ROOT, item.dir).replace(/\\/g, '/');
    const licence = readFileSync(path.join(item.dir, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
    const copyright = licence.split('\n').find(line => /^Copyright \(c\)/i.test(line.trim()));
    assert.ok(copyright, `${rel}: the LICENSE has a copyright line`);
    assert.ok(notices.includes(copyright!.trim()), `${rel}: THIRD_PARTY_NOTICES.md keeps "${copyright!.trim()}"`);
    assert.ok(notices.includes(`${rel}/`) || notices.includes(`${rel}\``), `${rel}: THIRD_PARTY_NOTICES.md names the folder`);
  }
});

test("the project's own character models (assets/bundled/one, mumi) keep their attribution.txt and are named in THIRD_PARTY_NOTICES.md", () => {
  const own = found().filter(entry => entry.kind === 'own').map(entry => entry.vendor).sort();
  assert.deepEqual(own, ['mumi', 'one']);
  for (const vendor of own) assert.ok(notices.includes(`assets/bundled/${vendor}/`), `THIRD_PARTY_NOTICES.md names assets/bundled/${vendor}/`);
});

test('ACKNOWLEDGEMENTS.md and THIRD_PARTY_NOTICES.md both exist and the dataset credits are not only in the pack folders', () => {
  assert.ok(acknowledgements.length > 1000);
  for (const credit of ['Ian Mason', 'Volkova', 'Youngwoo Yoon', 'fnoji', 'Nagoya Institute of Technology']) {
    assert.ok(notices.includes(credit), `THIRD_PARTY_NOTICES.md credits ${credit}`);
  }
});
