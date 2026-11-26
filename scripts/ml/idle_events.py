"""Motion-model spike, round 2 (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮」): the quick small moves people make while
standing (a head flick, a glance-turn, a quick weight shift), cut out of the training data, for the event layer
(src/unbound/motion/idle-events.ts) that lays them over the slow idle the model makes.

An event is a peak of the head's turning speed (torso + neck + head channels, small-angle sum) above --speed (rad/s), at least
1.2 s from the previous one; its window runs from 0.4 s before the peak to 0.8 s after, all 27 channels, with the straight line
between the window's two ends taken out (so it starts and ends at zero and adds onto any idle without a step), and a short taper
at both ends (velocity zero at the joins too). Also counts how often they happen per minute at each liveliness (fifths), so the
layer fires them as often as the people did.

  .local/ml/venv/Scripts/python.exe -I scripts/ml/idle_events.py --data <dir with idle.f32/json> --out <dir> [--speed 0.35]
Writes <out>/events.f32 (events x 36 x 27, float32) and <out>/events.json.
"""
import argparse
import json
import os
import sys

import numpy as np

BEFORE, AFTER, HZ = 12, 24, 30   # frames: 0.4 s before the peak, 0.8 s after


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--speed', type=float, default=0.35)
    args = ap.parse_args()
    meta = json.load(open(os.path.join(args.data, 'idle.json'), encoding='utf-8'))
    dim = len(meta['channels'])
    x = np.fromfile(os.path.join(args.data, 'idle.f32'), dtype='<f4').reshape(-1, dim).astype(np.float64)
    act = np.fromfile(os.path.join(args.data, 'idle-activity.f32'), dtype='<f4')
    n = BEFORE + AFTER
    ramp = np.ones(n)
    k = 5
    ramp[:k] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))
    ramp[-k:] = ramp[:k][::-1]
    events, info = [], []
    seconds_by_bin = np.zeros(5)
    count_by_bin = np.zeros(5)
    for s in meta['segments']:
        a, b = s['start'], s['start'] + s['length']
        seg = x[a:b]
        head = seg[:, 3:6] + seg[:, 6:9] + seg[:, 9:12]
        speed = np.zeros(len(seg))
        speed[1:] = np.linalg.norm(np.diff(head, axis=0), axis=1) * HZ
        for i in range(a, b):
            seconds_by_bin[min(4, int(act[i] * 5))] += 1 / HZ
        last = -10 ** 9
        for i in range(1, len(seg) - 1):
            if speed[i] < args.speed or speed[i] < speed[i - 1] or speed[i] < speed[i + 1] or i - last < 1.2 * HZ:
                continue
            if i - BEFORE < 0 or i + AFTER > len(seg):
                continue
            last = i
            w = seg[i - BEFORE:i + AFTER].copy()
            line = w[0] + (w[-1] - w[0]) * np.linspace(0, 1, n)[:, None]
            w = (w - line) * ramp[:, None]
            events.append(w)
            count_by_bin[min(4, int(act[a + i] * 5))] += 1
            info.append({'style': s['style'], 'peakRadPerS': round(float(speed[i]), 3), 'activity': round(float(act[a + i]), 3)})
    ev = np.array(events, dtype='<f4')
    os.makedirs(args.out, exist_ok=True)
    ev.tofile(os.path.join(args.out, 'events.f32'))
    per_min = (count_by_bin / np.maximum(seconds_by_bin, 1e-9) * 60).tolist()
    out = {'channels': meta['channels'], 'frames': n, 'peakAt': BEFORE, 'hz': HZ, 'count': len(events), 'speedThreshold': args.speed,
           'perMinuteByActivityFifth': [round(v, 3) for v in per_min], 'secondsByActivityFifth': [round(v, 1) for v in seconds_by_bin.tolist()],
           'events': info, 'source': meta['source']}
    with open(os.path.join(args.out, 'events.json'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1)
    print(f'{len(events)} events (head speed ≥ {args.speed} rad/s); per minute by liveliness fifth: {[round(v, 2) for v in per_min]}', file=sys.stderr)


if __name__ == '__main__':
    main()
