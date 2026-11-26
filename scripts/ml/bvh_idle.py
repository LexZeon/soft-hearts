"""Motion-model spike (docs/claude/2026-11-14-motion-model-spike.md): BVH standing stretches -> the Unbound layer-2 idle channels.

Reads 100STYLE takes (Ian Mason, CC BY 4.0) straight out of the downloaded zip (nothing extracted, nothing executed from it), runs
forward kinematics with numpy, keeps only the stretches where the actor stands (no foot leaves its spot, the hips do not travel),
and reduces each frame to 27 numbers layer 2 can hand the body (src/unbound/motion/idle-channels.ts), as deviations from that
stretch's own mean posture so they ride on Gene's stand pose:

   0..2  pelvis lateral / forward / vertical  hips relative to the midpoint of the ankles, her heading frame, per meter of height
   3..5  torso pitch / yaw / roll             the top chest joint's orientation in her heading frame (rad)
   6..8  neck                                 relative to the chest
   9..11 head                                 relative to the neck
  12..14 hips                                 the pelvis's own turn and tilt, in her heading frame
  15..17 left upper arm, 18..20 left elbow, 21..23 right upper arm, 24..26 right elbow: each bone's turn relative to its parent,
         expressed about her body's axes (so it transfers across rest poses: 100STYLE's T-pose, Gene's A-pose)

Rotations are rotation vectors about (her left, up, forward), written as PoseTargets' Rot: pitch = about left (+ = forward / down),
yaw = about up (+ = toward her left), roll = minus about forward (+ = toward her left shoulder). Feet are not taken: Gene's contact
owner keeps hers planted.

Two selections:
  --select curated   the 20 hand-picked idle (_ID) takes of round 1 (held out in round 2, the human reference)
  --select wide      every other take (all styles, idle and locomotion), standing stretches only, with a quality filter

Run with the isolated interpreter and -I (the data is untrusted input; this script lives elsewhere and gets paths as arguments):
  .local/ml/venv/Scripts/python.exe -I scripts/ml/bvh_idle.py --zip <100STYLE.zip> --out <dir> --select wide
Writes <out>/idle.f32 (frames x 27, little-endian float32, 30 Hz), idle-activity.f32 and idle.json (segments, stats).
"""
import argparse
import json
import math
import os
import sys
import zipfile

import numpy as np

CHANNELS = ['pelvis_lateral', 'pelvis_forward', 'pelvis_vertical', 'torso_pitch', 'torso_yaw', 'torso_roll',
            'neck_pitch', 'neck_yaw', 'neck_roll', 'head_pitch', 'head_yaw', 'head_roll', 'hips_pitch', 'hips_yaw', 'hips_roll',
            'l_arm_pitch', 'l_arm_yaw', 'l_arm_roll', 'l_elbow_pitch', 'l_elbow_yaw', 'l_elbow_roll',
            'r_arm_pitch', 'r_arm_yaw', 'r_arm_roll', 'r_elbow_pitch', 'r_elbow_yaw', 'r_elbow_roll']
STEP_M = 0.04          # a foot this far from where it was planted = a step
STEP_PAD_S = 0.6       # cut this much around a step
ROOT_SPEED_MPS = 0.12  # hips travelling faster than this (0.5 s average) = not standing
MIN_SEGMENT_S = 3.0    # shorter standing stretches are dropped
OUT_HZ = 30
# Quality filter (wide selection): a standing stretch whose spread is beyond these is a stunt or a posture change, not an idle.
MAX_STD = {'pelvis': 0.02, 'spine': 0.15, 'arms': 0.25}
# Idle takes that read as a person standing about (calm to lively); the rest of the 100 styles' idles are gestures or stunts
# (whirling arms, waving, leaning far, crouching, hopping) or drift between postures, which a companion's idle should not learn.
CURATED = ['Neutral', 'ArmsBySide', 'ArmsBehindBack', 'ArmsFolded', 'HandsInPockets', 'Akimbo', 'Heavyset', 'Stiff', 'WideLegs',
           'LegsApart', 'DuckFoot', 'PigeonToed', 'SlideFeet', 'TogetherStep', 'Elated', 'Angry', 'Rushed', 'Depressed', 'InTheDark',
           'Strutting']


def parse_bvh(text):
    tokens = text.replace('\r', '').split('\n')
    joints = []  # dicts: name, parent, offset, channels
    stack = []
    i = 0
    motion_at = None
    while i < len(tokens):
        line = tokens[i].strip()
        i += 1
        if not line:
            continue
        parts = line.split()
        head = parts[0]
        if head in ('ROOT', 'JOINT'):
            joints.append({'name': parts[1], 'parent': stack[-1] if stack else -1, 'offset': None, 'channels': []})
            pending = len(joints) - 1
        elif head == 'End':
            joints.append({'name': (joints[stack[-1]]['name'] + '_end'), 'parent': stack[-1], 'offset': None, 'channels': [], 'end': True})
            pending = len(joints) - 1
        elif head == '{':
            stack.append(pending)
        elif head == '}':
            stack.pop()
        elif head == 'OFFSET':
            joints[stack[-1]]['offset'] = np.array([float(v) for v in parts[1:4]])
        elif head == 'CHANNELS':
            joints[stack[-1]]['channels'] = parts[2:2 + int(parts[1])]
        elif head == 'MOTION':
            motion_at = i
            break
    frames = int(tokens[motion_at].split(':')[1])
    frame_time = float(tokens[motion_at + 1].split(':')[1])
    rows = [r for r in tokens[motion_at + 2: motion_at + 2 + frames] if r.strip()]
    data = np.array([[float(v) for v in r.split()] for r in rows], dtype=np.float64)
    return joints, data, frame_time


def axis_rot(axis, angle):
    c, s = np.cos(angle), np.sin(angle)
    n = angle.shape[0]
    m = np.zeros((n, 3, 3))
    if axis == 'X':
        m[:, 0, 0] = 1; m[:, 1, 1] = c; m[:, 1, 2] = -s; m[:, 2, 1] = s; m[:, 2, 2] = c
    elif axis == 'Y':
        m[:, 1, 1] = 1; m[:, 0, 0] = c; m[:, 0, 2] = s; m[:, 2, 0] = -s; m[:, 2, 2] = c
    else:
        m[:, 2, 2] = 1; m[:, 0, 0] = c; m[:, 0, 1] = -s; m[:, 1, 0] = s; m[:, 1, 1] = c
    return m


def forward_kinematics(joints, data):
    n = data.shape[0]
    col = 0
    glob_r = [None] * len(joints)
    glob_p = [None] * len(joints)
    for j, joint in enumerate(joints):
        local_p = np.repeat(joint['offset'][None, :], n, axis=0)
        local_r = np.repeat(np.eye(3)[None], n, axis=0)
        pos = {}
        for ch in joint['channels']:
            v = data[:, col]; col += 1
            if ch.endswith('position'):
                pos[ch[0]] = v
            else:
                local_r = local_r @ axis_rot(ch[0], np.radians(v))
        if pos:
            local_p = np.stack([pos.get('X', local_p[:, 0]), pos.get('Y', local_p[:, 1]), pos.get('Z', local_p[:, 2])], axis=1)
        if joint['parent'] < 0:
            glob_r[j], glob_p[j] = local_r, local_p
        else:
            pr, pp = glob_r[joint['parent']], glob_p[joint['parent']]
            glob_r[j] = pr @ local_r
            glob_p[j] = pp + np.einsum('nij,nj->ni', pr, local_p)
    return glob_r, glob_p


def log_rot(r):
    """Rotation vectors of (n, 3, 3) rotation matrices."""
    cos = np.clip((np.trace(r, axis1=1, axis2=2) - 1) / 2, -1, 1)
    angle = np.arccos(cos)
    v = np.stack([r[:, 2, 1] - r[:, 1, 2], r[:, 0, 2] - r[:, 2, 0], r[:, 1, 0] - r[:, 0, 1]], axis=1)
    s = np.sin(angle)
    k = np.where(s > 1e-8, angle / (2 * np.maximum(s, 1e-12)), 0.5)
    return v * k[:, None]


def box_smooth(x, width):
    if width <= 1:
        return x
    kernel = np.ones(width) / width
    pad = width // 2
    xp = np.pad(x, ((pad, width - 1 - pad),) + ((0, 0),) * (x.ndim - 1), mode='edge')
    return np.stack([np.convolve(xp[:, c], kernel, mode='valid') for c in range(x.shape[1])], axis=1) if x.ndim == 2 else np.convolve(xp, kernel, mode='valid')


def gaussian_smooth(x, sigma):
    """Zero-phase Gaussian low-pass along axis 0 (sigma in frames; edges held), for 1-D or 2-D arrays. sigma <= 0: unchanged."""
    if sigma <= 0:
        return x
    r = max(1, int(math.ceil(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    two = x.ndim == 2
    xs = x if two else x[:, None]
    xp = np.pad(xs, ((r, r), (0, 0)), mode='edge')
    out = np.stack([np.convolve(xp[:, c], k, mode='valid') for c in range(xs.shape[1])], axis=1)
    return out if two else out[:, 0]


def find(joints, *names):
    for name in names:
        for j, joint in enumerate(joints):
            if joint['name'].lower() == name.lower():
                return j
    raise KeyError(names)



def project_rotation(m):
    """Nearest rotation to a 3x3 matrix (the mean of several rotations)."""
    u, _, vt = np.linalg.svd(m)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def as_rot(rv):
    """Rotation vectors about (left, up, forward) -> (pitch, yaw, roll) columns."""
    return np.stack([rv[:, 0], rv[:, 1], -rv[:, 2]], axis=1)


# Which joints play which part, per skeleton (the first name found wins). 100STYLE is Xsens-like; StayStill's freemocap skeleton
# (scripts/ml/staystill_idle.py) names them the Blender/rigify way and is Z-up.
STYLE100_JOINTS = {
    'hips': ('Hips',), 'chest_top': ('Chest4', 'Chest3', 'Chest2', 'Spine2', 'Chest'), 'neck': ('Neck',), 'head': ('Head',),
    'l_hip': ('LeftHip', 'LeftUpLeg'), 'r_hip': ('RightHip', 'RightUpLeg'), 'l_ankle': ('LeftAnkle', 'LeftFoot'), 'r_ankle': ('RightAnkle', 'RightFoot'),
    'l_arm': ('LeftCollar', 'LeftShoulder', 'LeftElbow'), 'r_arm': ('RightCollar', 'RightShoulder', 'RightElbow'),
}
# Z-up (x, y, z) -> Y-up (x, z, -y): a proper rotation (det +1); a Z-up rest pose's forward -Y becomes +Z.
Z_UP_TO_Y_UP = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


def rename_rest_axes(glob_r, c=Z_UP_TO_Y_UP):
    """A take whose rest pose (the OFFSETs) is authored Z-up while its motion world is Y-up (a Blender export: the root rotation
    carries the axis change, so a person standing has world rotations ≈ C, not the identity). Renaming every bone's local axes by
    C (local' = C·local, so R' = R·Cᵀ) makes standing ≈ the identity again, as the channels below assume; positions are untouched.
    Returns new arrays; the inputs are untouched."""
    return [r @ c.T for r in glob_r]


class Take:
    """One take: forward kinematics, her heading frame, and the frames where she stands."""

    def __init__(self, joints, data, frame_time, names=STYLE100_JOINTS, z_up=False, skull_m=0.17, foot_smooth_s=0.0):
        self.glob_r, self.glob_p = forward_kinematics(joints, data)
        if z_up:
            self.glob_r = rename_rest_axes(self.glob_r)
        j = lambda *n: find(joints, *n)
        self.hips, self.chest_top, self.neck, self.head = j(*names['hips']), j(*names['chest_top']), j(*names['neck']), j(*names['head'])
        self.l_hip, self.r_hip = j(*names['l_hip']), j(*names['r_hip'])
        self.l_ankle, self.r_ankle = j(*names['l_ankle']), j(*names['r_ankle'])
        self.arms = [tuple(j(n) for n in names['l_arm']), tuple(j(n) for n in names['r_arm'])]
        self.hz = 1.0 / frame_time
        n = data.shape[0]
        gp = self.glob_p
        head_h = np.median(gp[self.head][:, 1] - np.minimum(gp[self.l_ankle][:, 1], gp[self.r_ankle][:, 1]))
        self.unit = 1.0 if head_h < 5 else (0.01 if head_h < 500 else 0.001)
        self.height_m = head_h * self.unit + skull_m   # ankle height + skull above the head joint, approximate
        up = np.array([0.0, 1.0, 0.0])
        offset = lambda k: (Z_UP_TO_Y_UP @ joints[k]['offset']) if z_up else joints[k]['offset'].copy()
        left0 = offset(self.l_hip) - offset(self.r_hip); left0[1] = 0; left0 /= np.linalg.norm(left0)
        self.basis = np.stack([left0, up, np.cross(left0, up)], axis=1)  # columns: left, up, forward in BVH world
        hl = box_smooth(gp[self.l_hip] - gp[self.r_hip], int(round(2 * self.hz)))
        yaw = np.arctan2(hl[:, 0], hl[:, 2]) - math.atan2(left0[0], left0[2])
        heading = axis_rot('Y', yaw)
        self.to_her = np.einsum('ij,njk->nik', self.basis.T, np.transpose(heading, (0, 2, 1)))  # world -> her (left, up, forward)
        # Standing: no foot leaves its spot by STEP_M, the hips do not travel (padded on both sides).
        moving = np.zeros(n, dtype=bool)
        for a in (self.l_ankle, self.r_ankle):
            p = gp[a][:, [0, 2]] * self.unit
            if foot_smooth_s > 0:  # markerless ankles jitter by a centimetre or so: judge steps on a smoothed track
                p = gaussian_smooth(p, foot_smooth_s * self.hz)
            anchor = p[0]
            for f in range(n):
                if np.linalg.norm(p[f] - anchor) > STEP_M:
                    moving[f] = True
                    anchor = p[f]
        hp = gp[self.hips][:, [0, 2]] * self.unit
        speed = np.zeros(n)
        speed[1:] = np.linalg.norm(np.diff(hp, axis=0), axis=1) * self.hz
        moving |= box_smooth(speed, int(round(0.5 * self.hz))) > ROOT_SPEED_MPS
        pad = int(round(STEP_PAD_S * self.hz))
        self.cut = moving.copy()
        for f in np.nonzero(moving)[0]:
            self.cut[max(0, f - pad): f + pad + 1] = True

    def her_rot(self, r, s):  # world rotations (rest = identity) seen in her heading frame, as (left, up, forward) coordinates
        return np.einsum('nij,njk,kl->nil', self.to_her[s], r[s], self.basis)

    def segment(self, f, g):
        """The 27 channels for frames f..g, each a deviation from this stretch's own mean."""
        s = slice(f, g)
        gr, gp, B = self.glob_r, self.glob_p, self.basis
        out = np.zeros((g - f, 27))
        mid = (gp[self.l_ankle][s] + gp[self.r_ankle][s]) / 2
        off = np.einsum('nij,nj->ni', self.to_her[s], gp[self.hips][s] - mid) * self.unit / self.height_m
        out[:, [0, 2, 1]] = off - off.mean(axis=0)

        def rel(parent, child):  # child relative to parent, in rest-aligned (left, up, forward) coordinates
            return np.einsum('ij,njk,kl->nil', B.T, np.einsum('nji,njk->nik', gr[parent][s], gr[child][s]), B)

        for k, rot in ((3, self.her_rot(gr[self.chest_top], s)), (6, rel(self.chest_top, self.neck)), (9, rel(self.neck, self.head))):
            r = as_rot(log_rot(rot))
            out[:, k:k + 3] = r - r.mean(axis=0)

        def body_turn(orient):
            """Turns of a bone about her body axes, relative to its mean orientation over the stretch: D = O · mean(O)ᵀ."""
            mean = project_rotation(orient.mean(axis=0))
            return as_rot(log_rot(np.einsum('nij,kj->nik', orient, mean)))

        out[:, 12:15] = body_turn(self.her_rot(gr[self.hips], s))
        for side, (collar, shoulder, elbow) in enumerate(self.arms):
            for k, (parent, bone) in enumerate(((collar, shoulder), (shoulder, elbow))):
                # Local rotation L = Pᵀ·C; its deviation in the parent's frame D = L·mean(L)ᵀ; seen about her body axes: M·D·Mᵀ with
                # M = her parent orientation (parent-local -> her axes). On Gene the same body-axis turn is put back through her own parent.
                local = np.einsum('nji,njk->nik', gr[parent][s], gr[bone][s])
                dev = np.einsum('nij,kj->nik', local, project_rotation(local.mean(axis=0)))
                m = np.einsum('nij,njk->nik', self.to_her[s], gr[parent][s])  # parent-local (BVH axes) -> her (left, up, forward)
                d_body = np.einsum('nij,njk,nlk->nil', m, dev, m)
                c = 15 + side * 6 + k * 3
                out[:, c:c + 3] = as_rot(log_rot(d_body))
        return out


def decimate(x, hz):
    step = max(1, int(round(hz / OUT_HZ)))
    if step == 1:
        return x
    n = (len(x) // step) * step
    return x[:n].reshape(-1, step, x.shape[1]).mean(axis=1)


def too_wild(seg):
    sd = seg.std(axis=0)
    return sd[0:3].max() > MAX_STD['pelvis'] or sd[3:15].max() > MAX_STD['spine'] or sd[15:27].max() > MAX_STD['arms']


def activity_rank(allf, segments):
    """Activity: how much she moves over the surrounding two seconds (RMS of the channel velocities, scaled per channel), ranked
    0..1 over the whole set. Writes each segment's mean into segment['activity']; returns (activity per frame, velocity scale)."""
    vel = np.zeros_like(allf)
    for s in segments:
        a, b = s['start'], s['start'] + s['length']
        vel[a + 1:b] = np.diff(allf[a:b], axis=0) * OUT_HZ
        vel[a] = vel[a + 1] if b - a > 1 else 0
    scale = vel.std(axis=0) + 1e-9
    energy = np.sqrt(((vel / scale) ** 2).mean(axis=1))
    smooth = np.zeros_like(energy)
    for s in segments:
        a, b = s['start'], s['start'] + s['length']
        smooth[a:b] = box_smooth(energy[a:b], 2 * OUT_HZ)
    order = smooth.argsort()
    activity = np.empty_like(smooth)
    activity[order] = np.linspace(0, 1, len(smooth))
    for s in segments:
        a, b = s['start'], s['start'] + s['length']
        s['activity'] = round(float(activity[a:b].mean()), 4)
    return activity, scale


def main():
    global MIN_SEGMENT_S, STEP_PAD_S
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--select', choices=['curated', 'wide'], default='curated')
    ap.add_argument('--min-segment', type=float, default=MIN_SEGMENT_S)
    ap.add_argument('--pad', type=float, default=STEP_PAD_S)
    args = ap.parse_args()
    MIN_SEGMENT_S, STEP_PAD_S = args.min_segment, args.pad
    segments, chunks, stats = [], [], []
    start = 0
    dropped = {'wild': 0, 'wildSeconds': 0.0}
    with zipfile.ZipFile(args.zip) as z:
        names = []
        for n in sorted(z.namelist()):
            if not n.endswith('.bvh') or n.startswith('__MACOSX'):
                continue
            base = n.rsplit('/', 1)[-1][:-4]
            style, kind = base.rsplit('_', 1)
            curated = kind == 'ID' and style in CURATED
            if (args.select == 'curated') == curated:
                names.append((n, style, kind))
        for name, style, kind in names:
            joints, data, frame_time = parse_bvh(z.read(name).decode('utf-8', errors='replace'))
            take = Take(joints, data, frame_time)
            hz, cut, n = take.hz, take.cut, len(data)
            kept_s = 0.0
            f = 0
            while f < n:
                if cut[f]:
                    f += 1
                    continue
                g = f
                while g < n and not cut[g]:
                    g += 1
                if (g - f) / hz >= MIN_SEGMENT_S:
                    seg = decimate(take.segment(f, g), hz)
                    # Wide: judge 4 s windows, keep the calm runs (a stylised idle often has calm stretches between its stunts).
                    runs = [(0, len(seg))]
                    if args.select == 'wide':
                        win = 4 * OUT_HZ
                        ok = np.ones(len(seg), dtype=bool)
                        for w0 in range(0, len(seg), win):
                            if too_wild(seg[w0:w0 + win] - seg[w0:w0 + win].mean(axis=0)) if len(seg) - w0 >= OUT_HZ else False:
                                ok[w0:w0 + win] = False
                        runs, a = [], None
                        for i, v in enumerate(list(ok) + [False]):
                            if v and a is None:
                                a = i
                            elif not v and a is not None:
                                runs.append((a, i)); a = None
                        dropped['wildSeconds'] += float((~ok).sum()) / OUT_HZ
                        dropped['wild'] += int((~ok).sum() > 0)
                    for a, b in runs:
                        if (b - a) / OUT_HZ < MIN_SEGMENT_S:
                            continue
                        part = seg[a:b] - seg[a:b].mean(axis=0)
                        chunks.append(part)
                        src = int(f + a * hz / OUT_HZ)
                        segments.append({'style': style, 'kind': kind, 'start': start, 'length': len(part), 'sourceFrames': [src, int(f + b * hz / OUT_HZ)]})
                        start += len(part)
                        kept_s += (b - a) / OUT_HZ
                f = g
            stats.append({'style': style, 'kind': kind, 'seconds': round(n / hz, 2), 'keptSeconds': round(kept_s, 2), 'heightM': round(float(take.height_m), 3)})
    allf = np.concatenate(chunks, axis=0).astype(np.float64)
    activity, scale = activity_rank(allf, segments)
    os.makedirs(args.out, exist_ok=True)
    allf.astype('<f4').tofile(os.path.join(args.out, 'idle.f32'))
    activity.astype('<f4').tofile(os.path.join(args.out, 'idle-activity.f32'))
    kept = sum(s['keptSeconds'] for s in stats)
    total = sum(s['seconds'] for s in stats)
    meta = {'channels': CHANNELS, 'hz': OUT_HZ, 'frames': int(len(allf)), 'select': args.select, 'segments': segments, 'takes': stats,
            'std': [float(v) for v in allf.std(axis=0)], 'velocityStd': [float(v) for v in scale], 'dropped': dropped,
            'totalSeconds': round(total, 1), 'keptSeconds': round(kept, 1),
            'source': '100STYLE (Ian Mason, Sebastian Starke, Taku Komura), CC BY 4.0, zenodo.org/records/8127870',
            'stepM': STEP_M, 'stepPadS': STEP_PAD_S, 'rootSpeedMps': ROOT_SPEED_MPS, 'minSegmentS': MIN_SEGMENT_S, 'maxStd': MAX_STD}
    with open(os.path.join(args.out, 'idle.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, indent=1)
    print(f'{len(stats)} takes, {total:.0f} s, kept {kept:.0f} s ({kept / 60:.1f} min) in {len(segments)} standing segments, '
          f'{len(allf)} frames at {OUT_HZ} Hz; dropped as too wild: {dropped["wild"]} ({dropped["wildSeconds"]:.0f} s)', file=sys.stderr)
    print('channel std:', ' '.join(f'{c}={v:.4f}' for c, v in zip(CHANNELS, allf.std(axis=0))), file=sys.stderr)


if __name__ == '__main__':
    main()
