"""Download only some tensors of a remote .safetensors file (HTTP Range requests) and write them as a smaller .safetensors.

Used for I-127 to fetch the text tower of the official EmbeddingGemma 2 checkpoint (its single file also holds the vision and audio
encoders, which the text path does not need). The header and every byte range come from the official file; offsets are rewritten
for the smaller file and nothing else changes. Prints the bytes fetched and the SHA-256 of the result.

  python -I scripts/ml/fetch_safetensors_subset.py <url-of-model.safetensors> <out.safetensors> <exclude-prefix>[,<exclude-prefix>...]
"""
import hashlib
import json
import struct
import sys
import urllib.request


def fetch(url: str, start: int, end: int) -> bytes:
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}", "User-Agent": "range-fetch/1"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = r.read()
    if len(data) != end - start + 1:
        raise RuntimeError(f"short read {len(data)} for {start}-{end}")
    return data


def main() -> None:
    url, out, excl = sys.argv[1], sys.argv[2], tuple(p for p in sys.argv[3].split(",") if p)
    n = struct.unpack("<Q", fetch(url, 0, 7))[0]
    header = json.loads(fetch(url, 8, 8 + n - 1))
    base = 8 + n
    keep = sorted(((k, v) for k, v in header.items() if k != "__metadata__" and not k.startswith(excl)), key=lambda kv: kv[1]["data_offsets"][0])
    # Merge neighbouring ranges so that a few large requests do the work.
    spans = []
    for _, v in keep:
        a, b = v["data_offsets"]
        if spans and a == spans[-1][1]:
            spans[-1][1] = b
        else:
            spans.append([a, b])
    new_header, pos = {}, 0
    if "__metadata__" in header:
        new_header["__metadata__"] = header["__metadata__"]
    for k, v in keep:
        a, b = v["data_offsets"]
        new_header[k] = {"dtype": v["dtype"], "shape": v["shape"], "data_offsets": [pos, pos + (b - a)]}
        pos += b - a
    hb = json.dumps(new_header, separators=(",", ":")).encode("utf-8")
    hb += b" " * ((8 - len(hb) % 8) % 8)
    sha = hashlib.sha256()
    fetched = 0
    with open(out, "wb") as f:
        for chunk in (struct.pack("<Q", len(hb)), hb):
            f.write(chunk)
            sha.update(chunk)
        for a, b in spans:
            step = 64 * 1024 * 1024
            for s in range(a, b, step):
                e = min(b, s + step)
                data = fetch(url, base + s, base + e - 1)
                f.write(data)
                sha.update(data)
                fetched += len(data)
    print(json.dumps({"tensors": len(keep), "spans": len(spans), "bytesFetched": fetched, "fileBytes": 8 + len(hb) + pos, "sha256": sha.hexdigest()}))


if __name__ == "__main__":
    main()
