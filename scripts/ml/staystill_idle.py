"""StayStill idle (docs/claude/2026-11-14-staystill-idle.md): the freemocap takes of the StayStill dataset -> the same 27 idle
channels as scripts/ml/bvh_idle.py, for retraining the learned idle (scripts/ml/train_idle_vae.py).

StayStill (Atxa Landa, Rodriguez, Lazkano, Kucherenko 2026; MIT; zenodo.org/records/18741736): people standing about for two
minutes each (idle/), with a phone (phone/, not used) and 18 short idle actions (actions/). Two skeletons ship: `freemocap/` (the
original markerless capture: 4 GoPros + Mediapipe, 30 fps, no fingers) and `lafan/` (retargeted to the LaFAN1 skeleton, which is
CC BY-NC-ND). Only `freemocap/` is ever read or extracted here; anything else is refused.

The freemocap BVH is a Blender export: OFFSETs (the rest pose) are Z-up, the motion world is Y-up and the root rotation carries the
change, so bone-local axes are renamed (bvh_idle.rename_rest_axes) before the channels are taken. Markerless capture is noisier
than a suit: every stretch is checked for tracking glitches (a frame-to-frame jump faster than any person turns) and those parts
cut, then the channels are low-passed (zero-phase Gaussian, --smooth-s) and the stretch's quality is reported before and after.

Subcommands (run with the isolated interpreter and -I; the data is untrusted input, this script lives elsewhere, paths are args):
  python -I scripts/ml/staystill_idle.py extract --zip <staystill.zip> --out <new empty dir> [--kinds idle,l_aro,...]
  python -I scripts/ml/staystill_idle.py convert --src <extracted dir> --out <dir> --split train|val|test [--kinds idle] [--smooth-s 0.05]
  python -I scripts/ml/staystill_idle.py quality --data <dir with idle.f32 + idle.json> [--data ...]   (also the 100STYLE sets)
Official subject splits (StayStill README): train / validation / test below; never train on validation or test subjects.
"""
import argparse
import json
import math
import os
import re
import sys
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # the sibling bvh_idle.py (this script's own folder, never the data's)
from bvh_idle import CHANNELS, OUT_HZ, Take, activity_rank, gaussian_smooth, parse_bvh  # noqa: E402

SPLITS = {
    'train': (0, 1, 3, 4, 5, 7, 11, 12, 13, 14, 16, 17, 18, 20, 24, 25, 26, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37, 39, 41, 42, 44, 46, 47, 48, 49),
    'val': (8, 19, 21, 38, 40),
    'test': (2, 6, 9, 10, 15, 22, 23, 28, 43, 45),
}
# The 18 idle actions plus the two long kinds; only `idle` and the actions are ever extracted (not `phone`).
ACTIONS = {
    'l_up': 'look up', 'l_aro': 'look around', 'l_dow': 'look down', 'l_sho': 'look at shoes', 'l_wat': 'check watch', 'l_pho': 'check phone',
    'sc_hea': 'scratch head', 'sc_arm': 'scratch arm', 'sc_leg': 'scratch leg', 'sc_bac': 'scratch back', 't_fac': 'touch face/chin',
    'st_arm': 'stretch arms', 'st_bac': 'stretch back', 'sc_eye': 'rub eyes', 'yaw': 'yawn', 'lb_lef': 'look back left', 'lb_rig': 'look back right',
    'wei_lr': 'weight left to right', 'wei_rl': 'weight right to left',
}
KINDS = {'idle': 'idle', **ACTIONS}
FREEMOCAP_JOINTS = {
    'hips': ('pelvis',), 'chest_top': ('spine.001',), 'neck': ('neck',), 'head': ('face',),
    'l_hip': ('thigh.L',), 'r_hip': ('thigh.R',), 'l_ankle': ('foot.L',), 'r_ankle': ('foot.R',),
    'l_arm': ('shoulder.L', 'upper_arm.L', 'forearm.L'), 'r_arm': ('shoulder.R', 'upper_arm.R', 'forearm.R'),
}
SOURCE = ('StayStill (Eneko Atxa Landa, Igor Rodriguez, Elena Lazkano, Taras Kucherenko; arXiv 2605.13693), MIT, '
          'zenodo.org/records/18741736, freemocap skeleton only')
FOLDER_OF = {'idle': 'idle'}  # every other kind lives in actions/
# Tracking glitch: the head chain (torso + neck + head) or an arm bone turning faster than this between two 30 Hz frames.
GLITCH_HEAD_RADPS = 6.0      # ≈ 340°/s; a quick look-round peaks near 200-300°/s at the head
GLITCH_ARM_RADPS = 15.0      # ≈ 860°/s
GLITCH_PAD_S = 0.3
MIN_SEGMENT_S = 3.0
# Gaussian sigma (s): gain 0.88 at 1 Hz, 0.59 at 2 Hz, 0.24 at 4 Hz, ~0 at 8 Hz. The files are already low-passed (no power above
# 8 Hz); what is left of the tracker's shake sits at 4-8 Hz (8% of the head chain's velocity power; 100STYLE: 3%), which this
# takes to 0.2%. The slower wobble (1-2 Hz) cannot be told from real motion by a filter (see the doc).
SMOOTH_S = 0.067
FOOT_SMOOTH_S = 0.1
SKULL_M = 0.17


def parse_name(filename):
    """'l_aro_1_07.bvh' -> ('l_aro', 1, 7); 'idle_07.bvh' -> ('idle', None, 7); anything else -> None."""
    base = os.path.basename(filename)
    if not re.fullmatch(r'[a-z0-9_]+\.bvh', base):
        return None
    parts = base[:-4].split('_')
    if len(parts) < 2 or not re.fullmatch(r'\d{2}', parts[-1]):
        return None
    subject = int(parts[-1])
    take = None
    rest = parts[:-1]
    if len(rest) >= 2 and re.fullmatch(r'\d+', rest[-1]):
        take = int(rest[-1])
        rest = rest[:-1]
    kind = '_'.join(rest)
    return (kind, take, subject) if kind in KINDS else None


def split_of(subject):
    for name, subjects in SPLITS.items():
        if subject in subjects:
            return name
    return None


def member_target(name, kinds):
    """The relative path to extract a zip member to, or None. Only `freemocap/idle/` and `freemocap/actions/` BVH files of the asked
    kinds pass; no absolute paths, no '..', no backslashes, nothing from `lafan/` or `phone/`, no nested folders."""
    if not isinstance(name, str) or '\\' in name or name.startswith('/') or ':' in name:
        return None
    parts = name.split('/')
    if len(parts) != 3 or parts[0] != 'freemocap' or any(p in ('', '.', '..') for p in parts):
        return None
    parsed = parse_name(parts[2])
    if not parsed or parsed[0] not in kinds:
        return None
    if parts[1] != FOLDER_OF.get(parsed[0], 'actions'):
        return None
    return parts[1] + '/' + parts[2]


def extract(zip_path, out, kinds):
    if os.path.exists(out) and os.listdir(out):
        raise SystemExit(f'{out} is not empty: extract into a new, empty folder')
    os.makedirs(out, exist_ok=True)
    written = 0
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = member_target(info.filename, kinds)
            if rel is None:
                continue
            dest = os.path.join(out, *rel.split('/'))
            if os.path.commonpath([os.path.abspath(dest), os.path.abspath(out)]) != os.path.abspath(out):
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(info) as src, open(dest, 'wb') as dst:
                dst.write(src.read())
            written += 1
    print(f'extracted {written} freemocap BVH files ({", ".join(sorted(kinds))}) into {out}', file=sys.stderr)


def head_chain_speed(seg):
    """rad/s of the head chain (torso + neck + head rotation vectors, small-angle sum) between frames; first frame 0."""
    head = seg[:, 3:6] + seg[:, 6:9] + seg[:, 9:12]
    speed = np.zeros(len(seg))
    speed[1:] = np.linalg.norm(np.diff(head, axis=0), axis=1) * OUT_HZ
    return speed


def glitch_mask(seg, head_radps=GLITCH_HEAD_RADPS, arm_radps=GLITCH_ARM_RADPS, pad_s=GLITCH_PAD_S):
    """Frames to cut: a frame-to-frame turn of the head chain or of an arm bone faster than people turn, padded both sides."""
    bad = head_chain_speed(seg) > head_radps
    arm = np.zeros(len(seg))
    for c in range(15, 27, 3):
        arm[1:] = np.maximum(arm[1:], np.linalg.norm(np.diff(seg[:, c:c + 3], axis=0), axis=1) * OUT_HZ)
    bad |= arm > arm_radps
    out = bad.copy()
    pad = int(round(pad_s * OUT_HZ))
    for f in np.nonzero(bad)[0]:
        out[max(0, f - pad): f + pad + 1] = True
    return out


def share_neck_head(seg):
    """The freemocap head ('face') only nods on its neck: its yaw and roll relative to the neck are zero, every turn of the head
    sits in the neck joint. Gene turns both bones; share the chain's neck + head turn equally between them (same total, small
    angles). Returns a new array."""
    out = seg.copy()
    total = seg[:, 6:9] + seg[:, 9:12]
    out[:, 6:9] = total / 2
    out[:, 9:12] = total / 2
    return out


def deadband_head(seg, dps):
    """Shrinks the neck + head chain's frame-to-frame turn by `dps` deg/s (vector soft threshold: a turn slower than that becomes no
    turn, a faster one loses that much speed), integrates it back and shares it between neck and head again. The markerless head
    wobbles at 2-3 deg/s even when a person holds still, so the raw data has almost no moment under 1 deg/s (people in suit capture:
    15%); this restores holds without touching the looks. dps <= 0: unchanged. Returns a new array (stretch mean removed)."""
    if dps <= 0:
        return seg.copy()
    out = seg.copy()
    chain = seg[:, 6:9] + seg[:, 9:12]
    d = np.diff(chain, axis=0)
    speed = np.linalg.norm(d, axis=1) * OUT_HZ
    keep = np.clip(1 - math.radians(dps) / np.maximum(speed, 1e-12), 0, 1)
    new = np.concatenate([chain[:1], chain[:1] + np.cumsum(d * keep[:, None], axis=0)])
    new -= new.mean(axis=0)
    out[:, 6:9] = new / 2
    out[:, 9:12] = new / 2
    return out


def runs_of(ok):
    """[(start, end)) runs where ok is True."""
    runs, a = [], None
    for i, v in enumerate(list(ok) + [False]):
        if v and a is None:
            a = i
        elif not v and a is not None:
            runs.append((a, i))
            a = None
    return runs


def quality(seg):
    """Noise and pace of one stretch (27 channels, 30 Hz): head-chain speed percentiles (deg/s), jitter (RMS of what a 2-frame
    Gaussian removes, deg, head chain), and the share of head-chain velocity power above 4 Hz."""
    sp = np.degrees(head_chain_speed(seg)[1:])
    head = seg[:, 3:12]
    jitter = np.degrees(np.sqrt(((head - gaussian_smooth(head, 2.0)) ** 2).mean()))
    vel = np.diff(head, axis=0)
    if len(vel) >= 16:
        spec = (np.abs(np.fft.rfft(vel - vel.mean(axis=0), axis=0)) ** 2).sum(axis=1)
        freq = np.fft.rfftfreq(len(vel), 1 / OUT_HZ)
        hf = float(spec[freq > 4].sum() / max(1e-18, spec.sum()))
    else:
        hf = float('nan')
    pct = np.percentile(sp, [50, 90, 95, 99]) if len(sp) else [0, 0, 0, 0]
    return {'headSpeedP50': round(float(pct[0]), 2), 'headSpeedP90': round(float(pct[1]), 2), 'headSpeedP95': round(float(pct[2]), 2),
            'headSpeedP99': round(float(pct[3]), 2), 'jitterDeg': round(float(jitter), 3), 'hfShareAbove4Hz': round(hf, 3)}


def pooled_quality(segs):
    """quality() over several stretches, pooled (percentiles over all frames, jitter RMS-pooled, HF share power-weighted)."""
    sp = np.concatenate([np.degrees(head_chain_speed(s)[1:]) for s in segs]) if segs else np.zeros(1)
    res = np.concatenate([(s[:, 3:12] - gaussian_smooth(s[:, 3:12], 2.0)) for s in segs]) if segs else np.zeros((1, 9))
    hi = tot = 0.0
    for s in segs:
        vel = np.diff(s[:, 3:12], axis=0)
        if len(vel) < 16:
            continue
        spec = (np.abs(np.fft.rfft(vel - vel.mean(axis=0), axis=0)) ** 2).sum(axis=1)
        freq = np.fft.rfftfreq(len(vel), 1 / OUT_HZ)
        hi += spec[freq > 4].sum()
        tot += spec.sum()
    pct = np.percentile(sp, [50, 90, 95, 99])
    seconds = sum(len(s) for s in segs) / OUT_HZ
    pauses = sum(len(pause_runs(np.degrees(head_chain_speed(s)[1:]))) for s in segs)
    return {'headSpeedP50': round(float(pct[0]), 2), 'headSpeedP90': round(float(pct[1]), 2), 'headSpeedP95': round(float(pct[2]), 2),
            'headSpeedP99': round(float(pct[3]), 2), 'jitterDeg': round(float(np.degrees(np.sqrt((res ** 2).mean()))), 3),
            'hfShareAbove4Hz': round(float(hi / max(1e-18, tot)), 3), 'stillShare': round(float((sp < 1).mean()), 3),
            'pausesPerMin': round(pauses / max(1e-9, seconds / 60), 2), 'seconds': round(seconds, 1)}


def pause_runs(speed_dps, threshold=1.0, min_s=0.3):
    """Lengths (s) of runs where the head chain turns slower than `threshold` deg/s for at least `min_s` (the same rule as
    scripts/ml/idle-measures.ts pauseRuns, here on the data channels before any body)."""
    out, run = [], 0
    for v in list(speed_dps) + [math.inf]:
        if v < threshold:
            run += 1
            continue
        if run / OUT_HZ >= min_s:
            out.append(run / OUT_HZ)
        run = 0
    return out


def take_files(src, split, kinds):
    out = []
    for folder in ('idle', 'actions'):
        d = os.path.join(src, folder)
        if not os.path.isdir(d):
            continue
        for base in sorted(os.listdir(d)):
            parsed = parse_name(base)
            if not parsed or parsed[0] not in kinds or split_of(parsed[2]) != split:
                continue
            if folder != FOLDER_OF.get(parsed[0], 'actions'):
                continue
            out.append((os.path.join(d, base), *parsed))
    return out


def convert(args):
    kinds = set(args.kinds.split(','))
    files = take_files(args.src, args.split, kinds)
    if not files:
        raise SystemExit(f'no {args.split} files of {sorted(kinds)} under {args.src}')
    segments, chunks, stats, raw_segs, kept_segs = [], [], [], [], []
    start = 0
    for path, kind, take_no, subject in files:
        with open(path, 'rb') as fh:
            joints, data, frame_time = parse_bvh(fh.read().decode('utf-8', errors='replace'))
        if abs(frame_time * OUT_HZ - 1) > 0.01:
            raise SystemExit(f'{path}: {1 / frame_time:.1f} fps, expected {OUT_HZ}')
        take = Take(joints, data, frame_time, names=FREEMOCAP_JOINTS, z_up=True, skull_m=SKULL_M, foot_smooth_s=args.foot_smooth_s)
        n = len(data)
        info = {'file': os.path.basename(path), 'kind': kind, 'subject': subject, 'seconds': round(n / OUT_HZ, 2), 'heightM': round(float(take.height_m), 3),
                'steppedSeconds': round(float(take.cut.sum()) / OUT_HZ, 1), 'glitchSeconds': 0.0, 'keptSeconds': 0.0}
        for f, g in runs_of(~take.cut):
            if (g - f) / OUT_HZ < args.min_segment:
                continue
            raw = take.segment(f, g)
            bad = glitch_mask(raw, args.glitch_head, args.glitch_arm)
            info['glitchSeconds'] += round(float(bad.sum()) / OUT_HZ, 2)
            for a, b in runs_of(~bad):
                if (b - a) / OUT_HZ < args.min_segment:
                    continue
                part = raw[a:b] - raw[a:b].mean(axis=0)
                raw_segs.append(part)
                if args.share_neck_head:
                    part = share_neck_head(part)
                part = gaussian_smooth(part, args.smooth_s * OUT_HZ) if args.smooth_s > 0 else part
                if args.deadband_dps > 0:
                    part = deadband_head(part, args.deadband_dps)
                part = part - part.mean(axis=0)
                kept_segs.append(part)
                chunks.append(part)
                segments.append({'style': f'{kind}_{subject:02d}' + (f'_{take_no}' if take_no is not None else ''), 'kind': kind, 'subject': subject,
                                 'start': start, 'length': len(part), 'sourceFrames': [int(f + a), int(f + b)]})
                start += len(part)
                info['keptSeconds'] += (b - a) / OUT_HZ
        info['keptSeconds'] = round(info['keptSeconds'], 2)
        stats.append(info)
    if not chunks:
        raise SystemExit('nothing kept')
    allf = np.concatenate(chunks, axis=0).astype(np.float64)
    activity, scale = activity_rank(allf, segments)
    os.makedirs(args.out, exist_ok=True)
    allf.astype('<f4').tofile(os.path.join(args.out, 'idle.f32'))
    activity.astype('<f4').tofile(os.path.join(args.out, 'idle-activity.f32'))
    total = sum(s['seconds'] for s in stats)
    kept = sum(s['keptSeconds'] for s in stats)
    meta = {'channels': CHANNELS, 'hz': OUT_HZ, 'frames': int(len(allf)), 'select': f'staystill-{args.split}', 'split': args.split,
            'subjects': sorted({s['subject'] for s in stats}), 'kinds': sorted(kinds), 'segments': segments, 'takes': stats,
            'std': [float(v) for v in allf.std(axis=0)], 'velocityStd': [float(v) for v in scale],
            'totalSeconds': round(total, 1), 'keptSeconds': round(kept, 1),
            'steppedSeconds': round(sum(s['steppedSeconds'] for s in stats), 1), 'glitchSeconds': round(sum(s['glitchSeconds'] for s in stats), 1),
            'qualityRaw': pooled_quality(raw_segs), 'qualityKept': pooled_quality(kept_segs),
            'source': SOURCE, 'smoothS': args.smooth_s, 'footSmoothS': args.foot_smooth_s, 'glitchHeadRadPerS': args.glitch_head,
            'glitchArmRadPerS': args.glitch_arm, 'minSegmentS': args.min_segment, 'skullM': SKULL_M, 'shareNeckHead': args.share_neck_head, 'deadbandDegPerS': args.deadband_dps}
    with open(os.path.join(args.out, 'idle.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, indent=1)
    print(f'{args.split}: {len(stats)} takes, {total:.0f} s; stepping cut {meta["steppedSeconds"]:.0f} s, glitches cut {meta["glitchSeconds"]:.0f} s; '
          f'kept {kept:.0f} s ({kept / 60:.1f} min) in {len(segments)} stretches, {len(allf)} frames', file=sys.stderr)
    print('quality raw ', json.dumps(meta['qualityRaw']), file=sys.stderr)
    print('quality kept', json.dumps(meta['qualityKept']), file=sys.stderr)
    print('channel std:', ' '.join(f'{c}={v:.4f}' for c, v in zip(CHANNELS, allf.std(axis=0))), file=sys.stderr)


def quality_of_dirs(dirs):
    for d in dirs:
        meta = json.load(open(os.path.join(d, 'idle.json'), encoding='utf-8'))
        x = np.fromfile(os.path.join(d, 'idle.f32'), dtype='<f4').reshape(-1, len(meta['channels'])).astype(np.float64)
        segs = [x[s['start']: s['start'] + s['length']] for s in meta['segments']]
        q = pooled_quality(segs)
        sd = np.degrees(np.median([s.std(axis=0) for s in segs], axis=0))
        q['medianStretchStdDeg'] = {c: round(float(v), 2) for c, v in zip(CHANNELS[3:12], sd[3:12])}
        print(os.path.basename(os.path.normpath(d)), json.dumps(q))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    e = sub.add_parser('extract')
    e.add_argument('--zip', required=True)
    e.add_argument('--out', required=True)
    e.add_argument('--kinds', default='idle')
    c = sub.add_parser('convert')
    c.add_argument('--src', required=True)
    c.add_argument('--out', required=True)
    c.add_argument('--split', choices=list(SPLITS), required=True)
    c.add_argument('--kinds', default='idle')
    c.add_argument('--smooth-s', type=float, default=SMOOTH_S)
    c.add_argument('--foot-smooth-s', type=float, default=FOOT_SMOOTH_S)
    c.add_argument('--glitch-head', type=float, default=GLITCH_HEAD_RADPS)
    c.add_argument('--glitch-arm', type=float, default=GLITCH_ARM_RADPS)
    c.add_argument('--min-segment', type=float, default=MIN_SEGMENT_S)
    c.add_argument('--no-share-neck-head', dest='share_neck_head', action='store_false')
    c.add_argument('--deadband-dps', type=float, default=0.0, help='head-chain hold restoration (deg/s); 0 = off')
    q = sub.add_parser('quality')
    q.add_argument('--data', action='append', required=True)
    args = ap.parse_args()
    if args.cmd == 'extract':
        kinds = set(args.kinds.split(','))
        unknown = kinds - set(KINDS)
        if unknown:
            raise SystemExit(f'unknown kinds: {sorted(unknown)}')
        extract(args.zip, args.out, kinds)
    elif args.cmd == 'convert':
        convert(args)
    else:
        quality_of_dirs(args.data)


if __name__ == '__main__':
    main()
