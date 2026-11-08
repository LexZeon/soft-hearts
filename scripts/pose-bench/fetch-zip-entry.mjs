// Pose feasibility bench: read single small entries (e.g. LICENSE files) out of a large remote zip/nupkg with HTTP range requests.
// Usage: node fetch-zip-entry.mjs <url> <entry-regex> <outdir>   (prints name, size and SHA-256 of each file written)
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [url, rx, outdir] = process.argv.slice(2);
if (!outdir || !outdir.includes("soft-hearts-next-bench")) throw new Error("outdir must be inside the bench folder");
let fetched = 0;
async function range(a, b) { const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } }); if (r.status !== 206) throw new Error("range failed " + r.status); const buf = Buffer.from(await r.arrayBuffer()); fetched += buf.length; return buf; }
const head = await fetch(url, { headers: { Range: "bytes=0-0" } }); const size = Number(head.headers.get("content-range").split("/")[1]); await head.arrayBuffer();
const tail = await range(size - 65558, size - 1);
let e = tail.length - 22; while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
const cd = await range(cdOff, cdOff + cdSize - 1);
const re = new RegExp(rx, "i");
mkdirSync(outdir, { recursive: true });
for (let p = 0; p < cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
  const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
  const name = cd.toString("utf8", p + 46, p + 46 + nlen); p += 46 + nlen + elen + clen;
  if (!re.test(name) || name.endsWith("/")) continue;
  const chunk = await range(off, Math.min(size - 1, off + 30 + nlen + 512 + csize));
  const ln = chunk.readUInt16LE(26), le = chunk.readUInt16LE(28);
  const body = chunk.subarray(30 + ln + le, 30 + ln + le + csize);
  const data = method === 0 ? body : inflateRawSync(body);
  const target = path.join(outdir, path.basename(name));
  writeFileSync(target, data);
  console.log(name, data.length, createHash("sha256").update(data).digest("hex"));
}
console.log("bytes fetched over the network:", fetched);
