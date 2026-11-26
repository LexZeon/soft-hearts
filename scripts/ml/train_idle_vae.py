"""Motion-model spike, group C (docs/claude/2026-11-14-motion-model-spike.md): a small autoregressive conditional VAE for idle.

From the last HISTORY frames of the idle channels (scripts/ml/bvh_idle.py; 12 in round 1, 27 with hips and arms in round 2), a
liveliness condition c in 0..1 and a latent z, the decoder predicts the next CHUNK frames (30 Hz) as offsets from the last frame it
saw. CHUNK = 1 is the classic per-frame motion VAE (round 1: it collapsed, then blew up); 15 frames (0.5 s) gives z something to
decide. Training rolls the model out over ROLLOUT frames and feeds its own predictions back more and more often (scheduled
sampling). Round 2:
  - `--prior learned`: a small prior network p(z | history, c) instead of N(0, I). With a fixed prior, sampling at run time draws
    z the decoder rarely saw in training and gets an averaged, too-small idle; a learned prior samples where the posteriors were.
  - `--val-data`: the held-out human reference (round 1's 20 curated idle takes); free-run spread and speed are scored against it.
  - calibration: after training, per-channel output gains (1..3) that bring the free-run spread to the reference's (applied to the
    output only, so the model's own dynamics are untouched); written into the JSON and reported.
At run time only the decoder (and the prior) run (TypeScript port: src/unbound/motion/idle-model.ts).

  .local/ml/venv/Scripts/python.exe -I scripts/ml/train_idle_vae.py --data <dir> [--val-data <dir>] --out <dir> [--minutes 10]
      [--chunk 15 --rollout 60 --batch 128 --beta 0.005 --prior learned]
Writes <out>/idle-vae.json (weights, scales, config, gains, a parity vector) and <out>/train-log.json.
"""
import argparse
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn

HISTORY = 10
ROLLOUT = 30
CHUNK = 1
LATENT = 8
HIDDEN = 256
DIM = 12


def mirror_tensors(dim):
    """Left-right mirror: per-channel sign and (for the 27-channel layout) the arms swapping sides. Same as idle-channels.ts."""
    sign = [-1, 1, 1] + [1, -1, -1] * ((dim - 3) // 3)
    perm = list(range(dim))
    if dim >= 27:
        perm = [c + 6 if 15 <= c < 21 else c - 6 if c >= 21 else c for c in range(dim)]
    return torch.tensor(perm), torch.tensor(sign, dtype=torch.float32)


def mlp(n_in, n_out):
    return nn.Sequential(nn.Linear(n_in, HIDDEN), nn.ELU(), nn.Linear(HIDDEN, HIDDEN), nn.ELU(), nn.Linear(HIDDEN, n_out))


class Decoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = mlp(LATENT + HISTORY * DIM + 1, CHUNK * DIM)

    def forward(self, z, hist, c):
        """Offsets of the next CHUNK frames from the last history frame: (B, CHUNK, DIM)."""
        return self.net(torch.cat([z, hist.flatten(1), c], dim=1)).view(-1, CHUNK, DIM)


class Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = mlp(HISTORY * DIM + CHUNK * DIM + 1, 2 * LATENT)

    def forward(self, hist, nxt, c):
        mu, logvar = self.net(torch.cat([hist.flatten(1), nxt.flatten(1), c], dim=1)).chunk(2, dim=1)
        return mu, logvar.clamp(-8, 4)


class Prior(nn.Module):
    """p(z | history, c): a smaller network (128 wide)."""

    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(HISTORY * DIM + 1, 128), nn.ELU(), nn.Linear(128, 128), nn.ELU(), nn.Linear(128, 2 * LATENT))

    def forward(self, hist, c):
        mu, logvar = self.net(torch.cat([hist.flatten(1), c], dim=1)).chunk(2, dim=1)
        return mu, logvar.clamp(-8, 4)


def load(data_dir):
    meta = json.load(open(os.path.join(data_dir, 'idle.json'), encoding='utf-8'))
    x = np.fromfile(os.path.join(data_dir, 'idle.f32'), dtype='<f4').reshape(-1, len(meta['channels']))
    act = np.fromfile(os.path.join(data_dir, 'idle-activity.f32'), dtype='<f4')
    return meta, x, act


def windows(meta, length, split, hold_every=8):
    """Start indices of windows inside one segment; with no separate reference set, every 8th style is held out."""
    styles = sorted({s['style'] for s in meta['segments']})
    held = {s for i, s in enumerate(styles) if hold_every and i % hold_every == 3}
    out = []
    for s in meta['segments']:
        if split != 'all' and (s['style'] in held) != (split == 'val'):
            continue
        for start in range(s['start'], s['start'] + s['length'] - length, 2):
            out.append(start)
    return np.array(out, dtype=np.int64), sorted(held)


def main():
    global ROLLOUT, CHUNK, DIM
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--val-data', default=None)
    ap.add_argument('--out', required=True)
    ap.add_argument('--minutes', type=float, default=40)
    ap.add_argument('--threads', type=int, default=8)
    ap.add_argument('--beta', type=float, default=0.02)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--rollout', type=int, default=30)
    ap.add_argument('--chunk', type=int, default=1)
    ap.add_argument('--batch', type=int, default=256)
    ap.add_argument('--prior', choices=['standard', 'learned'], default='standard')
    ap.add_argument('--energy', type=float, default=0.0, help='weight of the speed-matching loss (round 2)')
    args = ap.parse_args()
    ROLLOUT, CHUNK = args.rollout, args.chunk
    assert ROLLOUT % CHUNK == 0, 'rollout must be a whole number of chunks'
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    meta, x, act = load(args.data)
    DIM = x.shape[1]
    perm, sign = mirror_tensors(DIM)
    std = np.array(meta['std'], dtype=np.float32) + 1e-6
    xn = torch.tensor(x / std)
    actt = torch.tensor(act)[:, None]
    length = HISTORY + ROLLOUT
    if args.val_data:
        vmeta, vx, vact = load(args.val_data)
        assert vx.shape[1] == DIM
        train_idx, held = windows(meta, length, 'all', 0)
        val_idx, _ = windows(vmeta, length, 'all', 0)
        vxn = torch.tensor(vx / std)
        ref_x = vx
        held = ['(separate reference set: ' + os.path.basename(os.path.normpath(args.val_data)) + ')']
    else:
        train_idx, held = windows(meta, length, 'train')
        val_idx, _ = windows(meta, length, 'val')
        vxn, ref_x = xn, x
    print(f'{len(train_idx)} train windows, {len(val_idx)} validation windows ({", ".join(held)}); dim {DIM}, chunk {CHUNK}, rollout {ROLLOUT}, prior {args.prior}', flush=True)
    enc, dec, pri = Encoder(), Decoder(), Prior()
    params = sum(p.numel() for p in dec.parameters())
    prior_params = sum(p.numel() for p in pri.parameters()) if args.prior == 'learned' else 0
    print(f'decoder {params} parameters, prior {prior_params}, encoder {sum(p.numel() for p in enc.parameters())}', flush=True)
    trainable = list(enc.parameters()) + list(dec.parameters()) + (list(pri.parameters()) if args.prior == 'learned' else [])
    opt = torch.optim.Adam(trainable, lr=1e-3)
    gather = torch.arange(length)[None, :]
    batch = args.batch
    lowered = False
    t0 = time.time()
    budget = args.minutes * 60
    log = []
    step = 0
    z_memory = 0.9 ** CHUNK  # the same slow walk of z per second whatever the chunk

    def prior_of(hist, c):
        if args.prior == 'learned':
            return pri(hist, c)
        z0 = torch.zeros(hist.shape[0], LATENT)
        return z0, z0

    def run(source, idx, sample_p, train):
        seq = source[torch.as_tensor(idx)[:, None] + gather]      # B, L, D
        if train:  # left-right mirror half the batch: twice the data, no side bias
            flip = (torch.rand(len(idx), 1, 1) < 0.5).float()
            seq = flip * (seq[:, :, perm] * sign) + (1 - flip) * seq
        c = (actt if source is xn else torch.full((len(source), 1), 0.5))[torch.as_tensor(idx) + HISTORY] if source is xn else torch.full((len(idx), 1), 0.5)
        hist = seq[:, :HISTORY].clone()
        rec = kl = 0.0
        n = ROLLOUT // CHUNK
        for r in range(n):
            truth = seq[:, HISTORY + r * CHUNK: HISTORY + (r + 1) * CHUNK]
            mu, logvar = enc(hist, truth, c)
            pmu, plogvar = prior_of(hist, c)
            z = mu + torch.randn_like(mu) * torch.exp(0.5 * logvar) if train else mu
            pred = hist[:, -1:] + dec(z, hist, c)
            rec = rec + ((pred - truth) ** 2).mean()
            if args.energy > 0 and train:
                # Energy matching: a chunk drawn from the prior (what the app will play) should move as fast, frame to frame and
                # per channel, as what the people did next (against the VAE's pull to the average, which moves too little).
                def speed(seq_):
                    return torch.cat([hist[:, -1:], seq_], dim=1).diff(dim=1).pow(2).mean(1).add(1e-8).sqrt()
                zp = pmu + torch.exp(0.5 * plogvar) * torch.randn_like(pmu)
                rec = rec + args.energy * (speed(hist[:, -1:] + dec(zp, hist, c)) - speed(truth)).pow(2).mean()
            kl = kl + (0.5 * (plogvar - logvar + (logvar.exp() + (mu - pmu) ** 2) / plogvar.exp() - 1)).sum(1).mean()
            if train:
                use_pred = (torch.rand(len(idx), 1, 1) < sample_p).float()
                nxt = use_pred * pred + (1 - use_pred) * truth
            else:
                nxt = pred
            hist = torch.cat([hist, nxt], dim=1)[:, -HISTORY:]
        return rec / n, kl / n

    # Free-run check (what the app will do): 64 reference starts, 20 s sampled from the prior with a slowly walking z, knob 0.1..0.9;
    # score = mean |log| of the generated / reference spread and velocity per channel (0 = moves as much and as fast as the people).
    ref_std = torch.tensor(ref_x.std(axis=0) / std)
    vel_target = torch.tensor(np.sqrt(((np.diff(ref_x, axis=0) * 30) ** 2).mean(axis=0)) / std)
    best = {'score': float('inf'), 'step': None, 'state': None}

    def free_run(hist, c, seconds, gen):
        eps = torch.zeros(hist.shape[0], LATENT)
        frames = []
        for _ in range(seconds * 30 // CHUNK):
            eps = z_memory * eps + math.sqrt(1 - z_memory ** 2) * torch.randn(hist.shape[0], LATENT, generator=gen)
            pmu, plogvar = prior_of(hist, c)
            zc = pmu + torch.exp(0.5 * plogvar) * eps
            nxt = hist[:, -1:] + dec(zc, hist, c)
            hist = torch.cat([hist, nxt], dim=1)[:, -HISTORY:]
            frames.append(nxt)
        return torch.cat(frames, 1)                  # B, T, D

    def free_stats(gains=None):
        g = torch.Generator().manual_seed(9)
        starts = val_idx[np.random.RandomState(1).randint(0, len(val_idx), 64)]
        hist = vxn[torch.as_tensor(starts)[:, None] + torch.arange(HISTORY)[None, :]].clone()
        f = free_run(hist, torch.linspace(0.1, 0.9, 64)[:, None], 20, g)[:, 150:]
        if gains is not None:
            f = f * gains
        spread = f.std(1).mean(0)
        speed = ((f[:, 1:] - f[:, :-1]) * 30).pow(2).mean(1).sqrt().mean(0)
        return spread, speed

    def freerun_score():
        spread, speed = free_stats()
        score = ((spread / ref_std).clamp_min(1e-4).log().abs().mean() + (speed / vel_target).clamp_min(1e-4).log().abs().mean()).item()
        return {'freeSpreadRatio': round((spread / ref_std).mean().item(), 3), 'freeSpeedRatio': round((speed / vel_target).mean().item(), 3), 'score': round(score, 4)}

    while time.time() - t0 < budget:
        frac = min(1.0, (time.time() - t0) / (budget * 0.6))
        sample_p = frac  # teacher forcing → own predictions over the first 60% of the budget
        idx = train_idx[np.random.randint(0, len(train_idx), batch)]
        enc.train(); dec.train(); pri.train()
        rec, kl = run(xn, idx, sample_p, True)
        loss = rec + args.beta * kl
        opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(trainable, 1.0)
        opt.step()
        step += 1
        if step % 200 == 0:
            with torch.no_grad():
                enc.eval(); dec.eval(); pri.eval()
                vi = val_idx[np.random.RandomState(0).randint(0, len(val_idx), 512)]
                vrec, vkl = run(vxn, vi, 1.0, False)
                fr = freerun_score()
            entry = {'step': step, 'minutes': round((time.time() - t0) / 60, 2), 'sampleP': round(sample_p, 3), 'rec': float(rec.detach()), 'kl': float(kl.detach()), 'valRolloutRec': float(vrec), **fr}
            if sample_p >= 1 and fr['score'] < best['score']:
                best.update(score=fr['score'], step=step, state=({k: v.clone() for k, v in dec.state_dict().items()}, {k: v.clone() for k, v in pri.state_dict().items()}))
            log.append(entry)
            print(json.dumps(entry), flush=True)
        if not lowered and time.time() - t0 > budget * 0.75:
            lowered = True
            for g in opt.param_groups:
                g['lr'] = 3e-4
    os.makedirs(args.out, exist_ok=True)
    if best['state'] is not None:
        dec.load_state_dict(best['state'][0]); pri.load_state_dict(best['state'][1])
        print(f'kept the decoder of step {best["step"]} (free-run score {best["score"]})', flush=True)
    dec.eval(); pri.eval()
    with torch.no_grad():
        # Calibration: per-channel gains so the free-run spread matches the reference (1..3; the dynamics stay the model's).
        spread, speed = free_stats()
        gains = (ref_std / spread.clamp_min(1e-6)).clamp(1.0, 3.0)
        cal_spread, cal_speed = free_stats(gains)
        # Inference timing (decoder + prior, batch 1).
        hist = torch.zeros(1, HISTORY, DIM)
        c = torch.full((1, 1), 0.5)
        for _ in range(50):
            dec(torch.zeros(1, LATENT), hist, c)
        n = 3000
        t1 = time.perf_counter()
        for _ in range(n):
            pmu, plogvar = prior_of(hist, c)
            hist = torch.cat([hist, hist[:, -1:] + dec(pmu, hist, c)], dim=1)[:, -HISTORY:]
        call_ms = (time.perf_counter() - t1) / n * 1000
        second_ms = call_ms * 30 / CHUNK
        free = {}
        for a in (0.1, 0.5, 0.9):
            f = free_run(torch.zeros(1, HISTORY, DIM), torch.full((1, 1), a), 60, torch.Generator().manual_seed(5))[0].numpy() * std
            free[str(a)] = {'std': [float(v) for v in f[300:].std(axis=0)], 'velocityRms': [float(v) for v in np.sqrt(((np.diff(f[300:], axis=0) * 30) ** 2).mean(axis=0))]}
        # Parity vector for the TypeScript port (decoder; prior below).
        g = torch.Generator().manual_seed(3)
        ph = torch.randn(1, HISTORY, DIM, generator=g) * 0.5
        pz = torch.randn(1, LATENT, generator=g)
        pout = dec(pz, ph, torch.full((1, 1), 0.3))
        ppmu, pplogvar = prior_of(ph, torch.full((1, 1), 0.3))

    def dense(module):
        return [{'weight': [[round(float(w), 7) for w in row] for row in l.weight.detach().numpy()], 'bias': [round(float(b), 7) for b in l.bias.detach().numpy()]}
                for l in module if isinstance(l, nn.Linear)]

    model = {
        'kind': 'idle-ar-cvae', 'history': HISTORY, 'chunk': CHUNK, 'latent': LATENT, 'hidden': HIDDEN, 'dim': DIM, 'hz': 30, 'activation': 'elu',
        'input': 'concat(z[latent], history[history*dim] oldest first, activity[1]) in std units; output = chunk frames - last frame (std units, frame-major)',
        'std': [float(v) for v in std], 'zMemoryPerChunk': z_memory, 'channels': meta['channels'],
        'gain': [round(float(v), 4) for v in gains],
        'layers': dense(dec.net),
        **({'prior': dense(pri.net), 'priorInput': 'concat(history[history*dim], activity[1]) -> (mu[latent], logvar[latent])'} if args.prior == 'learned' else {}),
        'parity': {'history': ph[0].numpy().tolist(), 'z': pz[0].numpy().tolist(), 'activity': 0.3, 'out': pout[0].flatten().numpy().tolist(),
                   'priorMu': ppmu[0].numpy().tolist(), 'priorLogvar': pplogvar[0].numpy().tolist()},
        'source': meta['source'], 'decoderParameters': params, 'priorParameters': prior_params,
    }
    with open(os.path.join(args.out, 'idle-vae.json'), 'w', encoding='utf-8') as fh:
        json.dump(model, fh)
    report = {'steps': step, 'keptStep': best['step'], 'keptScore': best['score'], 'rollout': ROLLOUT, 'chunk': CHUNK, 'prior': args.prior, 'minutes': round((time.time() - t0) / 60, 2),
              'threads': args.threads, 'beta': args.beta, 'energy': args.energy, 'decoderParameters': params, 'priorParameters': prior_params, 'pythonCallMs': call_ms, 'pythonSecondMs': second_ms,
              'freeRun': free, 'channels': meta['channels'], 'trainSeconds': meta.get('keptSeconds'), 'referenceStd': [float(v) for v in ref_x.std(axis=0)],
              'spreadRatio': [round(float(v), 3) for v in (spread / ref_std)], 'speedRatio': [round(float(v), 3) for v in (speed / vel_target)],
              'gains': [round(float(v), 3) for v in gains], 'calibratedSpreadRatio': [round(float(v), 3) for v in (cal_spread / ref_std)],
              'calibratedSpeedRatio': [round(float(v), 3) for v in (cal_speed / vel_target)], 'heldOut': held, 'log': log}
    with open(os.path.join(args.out, 'train-log.json'), 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=1)
    print(f'done: {step} steps in {report["minutes"]} min; python call {call_ms:.3f} ms (1 s of motion = {second_ms:.2f} ms); '
          f'spread {np.mean(report["spreadRatio"]):.2f} speed {np.mean(report["speedRatio"]):.2f} of the reference; '
          f'calibrated {np.mean(report["calibratedSpreadRatio"]):.2f} / {np.mean(report["calibratedSpeedRatio"]):.2f}', flush=True)


if __name__ == '__main__':
    main()
