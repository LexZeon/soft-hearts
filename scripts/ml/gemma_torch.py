"""Embedding comparison (I-127): EmbeddingGemma 2 text path with the official weights in PyTorch (float32, CPU), as the reference
for the ONNX export. Same token ids as the ONNX run (gemma_tokenize.py output), mean pooling over all tokens (the model's
1_Pooling config: mean, include_prompt), then length 1. Writes vectors in the embed-bench.ts format (<out> float32 rows +
<out>.json with timings) so recall-eval.ts scores them with the same code.

  .local/ml/venv/Scripts/python.exe -I scripts/ml/gemma_torch.py <model dir> <ids.json> <out.f32> [threads] [batch]

The model dir holds config.json and a model.safetensors with only the text tower (fetch_safetensors_subset.py); the vision and
audio encoders are switched off the way the model card says (vision_config=None, audio_config=None).
"""
import ctypes
import ctypes.wintypes
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoConfig, AutoModel  # noqa: E402


def peak_rss_mb() -> int:
    class PMC(ctypes.Structure):
        _fields_ = [("cb", ctypes.wintypes.DWORD), ("PageFaultCount", ctypes.wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    c = PMC()
    c.cb = ctypes.sizeof(PMC)
    ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    return round(c.PeakWorkingSetSize / 1e6), round(c.WorkingSetSize / 1e6)


def main() -> None:
    model_dir, ids_path, out = sys.argv[1:4]
    threads = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    batch = int(sys.argv[5]) if len(sys.argv) > 5 else 16
    torch.set_num_threads(threads)
    data = json.load(open(ids_path, encoding="utf-8"))
    ids, latency = data["ids"], data.get("latency", [])
    rss_before = peak_rss_mb()[1]
    t0 = time.perf_counter()
    config = AutoConfig.from_pretrained(model_dir, vision_config=None, audio_config=None)
    model = AutoModel.from_pretrained(model_dir, config=config, dtype=torch.float32).eval()
    load_ms = (time.perf_counter() - t0) * 1000
    rss_loaded = peak_rss_mb()[1]

    @torch.inference_mode()
    def embed(rows):
        steps = max(len(r) for r in rows)
        x = torch.zeros((len(rows), steps), dtype=torch.long)
        m = torch.zeros((len(rows), steps), dtype=torch.long)
        for b, r in enumerate(rows):
            x[b, : len(r)] = torch.tensor(r)
            m[b, : len(r)] = 1
        h = model(input_ids=x, attention_mask=m).last_hidden_state.float()
        mf = m.unsqueeze(-1).float()
        v = (h * mf).sum(1) / mf.sum(1)
        return torch.nn.functional.normalize(v, dim=-1).numpy()

    t0 = time.perf_counter()
    vecs = np.concatenate([embed(ids[i: i + batch]) for i in range(0, len(ids), batch)])
    all_ms = (time.perf_counter() - t0) * 1000
    for i in latency[:3]:
        embed([ids[i]])
    single = []
    for i in latency:
        s = time.perf_counter()
        embed([ids[i]])
        single.append((time.perf_counter() - s) * 1000)
    single.sort()
    t0 = time.perf_counter()
    for n in range(0, 1000, batch):
        embed([ids[(n + k) % len(ids)] for k in range(min(batch, 1000 - n))])
    thousand_ms = (time.perf_counter() - t0) * 1000
    vecs.astype(np.float32).tofile(out)
    on_disk = os.path.getsize(os.path.join(model_dir, "model.safetensors")) + os.path.getsize(os.path.join(model_dir, "tokenizer.json"))
    metrics = {"model": "gemma-torch", "runtime": f"torch {torch.__version__} float32", "threads": threads, "batch": batch,
               "count": int(vecs.shape[0]), "dims": int(vecs.shape[1]), "onDiskBytes": on_disk, "loadMs": round(load_ms), "allMs": round(all_ms),
               "singleMs": {"n": len(single), "median": round(single[len(single) // 2], 2), "p90": round(single[int(0.9 * len(single))], 2)},
               "thousandMs": round(thousand_ms), "rssMB": {"before": rss_before, "loaded": rss_loaded, "maxRss": peak_rss_mb()[0]},
               "params": sum(p.numel() for p in model.parameters())}
    json.dump(metrics, open(out + ".json", "w"), indent=2)
    print(json.dumps(metrics))


if __name__ == "__main__":
    main()
