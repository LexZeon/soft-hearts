import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plainIdList, withPlainIdList } from '../electron/lnk-plain-path';

/** Names of the items of an ID list (without its leading size field): the This PC / drive items are named by their first byte. */
function walk(list: Buffer): { type: number; name: string }[] {
  const items: { type: number; name: string }[] = [];
  for (let o = 0; list.readUInt16LE(o) !== 0;) {
    const size = list.readUInt16LE(o), body = list.subarray(o + 2, o + size);
    const name = body[0] === 0x1f ? 'THIS-PC' : body[0] === 0x2f ? body.subarray(1, 4).toString('latin1') : body.subarray(12).toString('utf16le').split('\0')[0];
    items.push({ type: body[0], name }); o += size;
  }
  return items;
}
/** A minimal MS-SHLLINK file: header, an ID list through a virtual root, then a tail standing in for LinkInfo, strings and the property store. */
function link(withList = true): Buffer {
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(header, 4);
  header.writeUInt32LE(withList ? 1 : 0, 0x14);
  const parts = [header];
  if (withList) { const list = Buffer.from('virtual-root-item-through-OneDrive'), size = Buffer.alloc(2); size.writeUInt16LE(list.length); parts.push(size, list); }
  parts.push(Buffer.from('TAIL-LINKINFO-STRINGS-PROPERTY-STORE'));
  return Buffer.concat(parts);
}

test('the ID list is rebuilt as This PC, drive, folders, file (no virtual root) and the rest of the link is untouched', () => {
  const target = 'C:\\Users\\someone\\OneDrive\\Docs\\ChatGPT\\release\\win-arm64-unpacked\\soft hearts next.exe';
  const out = withPlainIdList(link(), target)!;
  assert.ok(out);
  const size = out.readUInt16LE(0x4c);
  const items = walk(out.subarray(0x4e, 0x4e + size));
  assert.deepEqual(items.map(i => i.name), ['THIS-PC', 'C:\\', 'Users', 'someone', 'OneDrive', 'Docs', 'ChatGPT', 'release', 'win-arm64-unpacked', 'soft hearts next.exe']);
  assert.deepEqual(items.map(i => i.type), [0x1f, 0x2f, ...Array(7).fill(0x35), 0x36]);
  assert.ok(out.subarray(0x4e + size).equals(Buffer.from('TAIL-LINKINFO-STRINGS-PROPERTY-STORE')));
  assert.ok(out.subarray(0, 0x4c).equals(link().subarray(0, 0x4c)));
});

test('anything that is not a link with an ID list and a plain drive path is left alone', () => {
  assert.equal(withPlainIdList(link(false), 'C:\\a\\b.exe'), null);
  assert.equal(withPlainIdList(Buffer.from('synthetic link -> x'), 'C:\\a\\b.exe'), null);
  assert.equal(withPlainIdList(Buffer.alloc(0), 'C:\\a\\b.exe'), null);
  for (const bad of ['relative\\b.exe', '\\\\server\\share\\b.exe', 'C:\\a\\..\\b.exe', 'C:\\a\\\\b.exe', 'C:\\', '']) assert.equal(plainIdList(bad), null, bad);
  const broken = link(); broken.writeUInt16LE(60000, 0x4c);
  assert.equal(withPlainIdList(broken, 'C:\\a\\b.exe'), null, 'ID list size past the end');
});

const win = process.platform === 'win32';
const ps = (script: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + script], { encoding: 'utf8', windowsHide: true }).trim();

test('a real shell-written link to a file under the OneDrive folder resolves and launches after its ID list is rebuilt', { skip: !win }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sh-lnk-'));
  try {
    const target = process.execPath, marker = path.join(dir, 'launched.txt');
    const file = path.join(dir, 'a.lnk');
    const args = `-e require('fs').writeFileSync(process.argv[1],'x') "${marker}"`;
    ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${file}'); $s.TargetPath='${target}'; $s.Arguments='${args.replaceAll("'", "''")}'; $s.WorkingDirectory='${path.dirname(target)}'; $s.Save()`);
    const original = await readFile(file);
    const plain = withPlainIdList(original, target);
    assert.ok(plain, 'a shell-written link has an ID list');
    await writeFile(file, plain);
    const read = ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${file}'); $s.TargetPath; $s.Arguments; $s.WorkingDirectory`).split(/\r?\n/);
    assert.equal(read[0].toLowerCase(), target.toLowerCase());
    assert.equal(read[1], args);
    assert.equal(read[2].toLowerCase(), path.dirname(target).toLowerCase());
    ps(`Start-Process '${file}'`);
    for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(existsSync(marker), 'double-click equivalent started the target');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
