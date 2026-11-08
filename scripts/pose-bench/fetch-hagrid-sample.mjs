// Pose feasibility bench: pull a SMALL labelled subset out of the HaGRID 30k/384p sample
// (CC BY-SA 4.0, https://huggingface.co/datasets/cj-mills/hagrid-sample-30k-384p) WITHOUT downloading
// the whole 1 GB zip: HTTP range requests read the zip directory, then only the chosen JPEGs.
// NOT product code. Usage: node fetch-hagrid-sample.mjs <bench-dir> [perClass=60]
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const bench = process.argv[2];
const perClass = Number(process.argv[3] || 60);
if (!bench || !bench.includes("soft-hearts-next-bench")) throw new Error("bench dir required");
const URL0 = "https://huggingface.co/datasets/cj-mills/hagrid-sample-30k-384p/resolve/main/hagrid-sample-30k-384p.zip";
// class folder name -> label used by the gesture test. Anything else in the set would be "other".
const WANT = ["fist", "palm", "peace", "ok", "like", "one", "call"]; // fist=rock, palm=paper, peace=scissors; the rest are hard "none" negatives
const COUNT = { fist: perClass, palm: perClass, peace: perClass, ok: 20, like: 20, one: 20, call: 20 };

let bytesFetched = 0;
async function range(start, end) {
  const res = await fetch(URL0, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error(`range ${start}-${end}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  bytesFetched += buf.length;
  return buf;
}
async function totalSize() {
  const res = await fetch(URL0, { headers: { Range: "bytes=0-0" } });
  const cr = res.headers.get("content-range");
  await res.arrayBuffer();
  return Number(cr.split("/")[1]);
}

const size = await totalSize();
const tail = await range(size - 65536 - 22, size - 1);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
if (eocd < 0) throw new Error("no EOCD");
let entries = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
if (cdOffset === 0xffffffff || entries === 0xffff) {
  const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);
  const z64off = Number(tail.readBigUInt64LE(loc + 8));
  const z64 = await range(z64off, z64off + 55);
  entries = Number(z64.readBigUInt64LE(32)); cdSize = Number(z64.readBigUInt64LE(40)); cdOffset = Number(z64.readBigUInt64LE(48));
}
console.log({ size, entries, cdSize, cdOffset });
const cd = await range(cdOffset, cdOffset + cdSize - 1);
const list = [];
for (let p = 0; p < cd.length;) {
  if (cd.readUInt32LE(p) !== 0x02014b50) break;
  const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
  const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
  const off = cd.readUInt32LE(p + 42);
  const name = cd.toString("utf8", p + 46, p + 46 + nlen);
  list.push({ name, method, csize, usize, off });
  p += 46 + nlen + elen + clen;
}
console.log("entries parsed", list.length);
const byClass = {};
for (const e of list) {
  if (!/\.jpe?g$/i.test(e.name)) continue;
  const parts = e.name.split("/");
  const folder = parts[parts.length - 2].replace(/^train_val_/, "");
  if (WANT.includes(folder)) (byClass[folder] ||= []).push(e);
}
const manifest = [];
for (const cls of WANT) {
  const all = (byClass[cls] || []).sort((a, b) => a.name.localeCompare(b.name));
  console.log(cls, "available", all.length);
  const step = Math.max(1, Math.floor(all.length / COUNT[cls]));
  const picked = all.filter((_, i) => i % step === 0).slice(0, COUNT[cls]);
  const dir = path.join(bench, "images", "hagrid", cls);
  mkdirSync(dir, { recursive: true });
  for (const e of picked) {
    // one request: local header (30 bytes + name + extra) plus the data; 512 bytes of slack for the extra field
    const chunk = await range(e.off, Math.min(size - 1, e.off + 30 + Buffer.byteLength(e.name) + 512 + e.csize));
    const nlen = chunk.readUInt16LE(26), elen = chunk.readUInt16LE(28);
    const body = chunk.subarray(30 + nlen + elen, 30 + nlen + elen + e.csize);
    const data = e.method === 0 ? body : inflateRawSync(body);
    const file = path.basename(e.name);
    writeFileSync(path.join(dir, file), data);
    manifest.push({ cls, file, zipPath: e.name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
}
writeFileSync(path.join(bench, "images", "hagrid", "manifest.json"), JSON.stringify({
  source: URL0, license: "CC BY-SA 4.0 (HaGRID, variant; see https://github.com/hukenovs/hagrid)", perClass, bytesFetched, files: manifest,
}, null, 1));
console.log("done", manifest.length, "images; bytes fetched over the network:", bytesFetched);
