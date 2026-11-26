"""Embedding comparison (I-127): token ids for EmbeddingGemma 2 with the official tokenizer.json (the `tokenizers` library).

Reads {"texts": [...], "latency": [...]} (recall-prepare.ts), writes {"ids": [[...]], "latency": [...]} for embed-bench.ts
(--model onnx-ids). The tokenizer adds <bos> ... <eos> itself, as the model expects. Also prints how long tokenizing takes, since
the app would need this step too (there is no JavaScript port of this tokenizer in the app).

Run with the local venv and -I (downloaded files are data):
  .local/ml/venv/Scripts/python.exe -I scripts/ml/gemma_tokenize.py <tokenizer.json> <texts.json> <ids.json> [max_tokens]
"""
import json
import sys
import time

from tokenizers import Tokenizer


def main() -> None:
    tok_path, texts_path, out_path = sys.argv[1:4]
    max_tokens = int(sys.argv[4]) if len(sys.argv) > 4 else 512
    t0 = time.perf_counter()
    tok = Tokenizer.from_file(tok_path)
    load_ms = (time.perf_counter() - t0) * 1000
    data = json.load(open(texts_path, encoding="utf-8"))
    texts = data["texts"]
    t0 = time.perf_counter()
    enc = tok.encode_batch(texts)
    batch_ms = (time.perf_counter() - t0) * 1000
    ids = [e.ids[:max_tokens] for e in enc]
    single = []
    for i in data.get("latency", []):
        s = time.perf_counter()
        tok.encode(texts[i])
        single.append((time.perf_counter() - s) * 1000)
    single.sort()
    json.dump({"ids": ids, "latency": data.get("latency", [])}, open(out_path, "w", encoding="utf-8"))
    lengths = sorted(len(x) for x in ids)
    print(json.dumps({"count": len(ids), "tokenizerLoadMs": round(load_ms), "batchMs": round(batch_ms, 1),
                      "singleMedianMs": round(single[len(single) // 2], 3) if single else None,
                      "tokens": {"median": lengths[len(lengths) // 2], "max": lengths[-1]}, "truncated": sum(1 for e in enc if len(e.ids) > max_tokens)}))


if __name__ == "__main__":
    main()
