"""Tests for scripts/ml/staystill_idle.py and the skeleton options it added to bvh_idle.py (run by tests/staystill-idle.test.ts
when the local ML interpreter exists):  .local/ml/venv/Scripts/python.exe -I scripts/ml/test_staystill_idle.py
Synthetic data only; nothing from the dataset is read."""
import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import staystill_idle as S  # noqa: E402
from bvh_idle import Take, gaussian_smooth, parse_bvh, rename_rest_axes, Z_UP_TO_Y_UP  # noqa: E402


def freemocap_like_bvh(n=300, neck_yaw_deg=None, chest_roll_deg=None):
    """A tiny BVH shaped like StayStill's freemocap export: Z-up OFFSETs, Y-up root position, the root rotated -90° about X so the
    person stands up in the Y-up world. neck_yaw_deg / chest_roll_deg: per-frame local Z / Y turns of `neck` / `spine.001`."""
    joints = []  # (name, parent, offset, channels)

    def add(name, parent, off, ch=3):
        joints.append((name, parent, off, ch))

    add('pelvis', None, (0, 0, 0.94), 6)
    for side, x in (('L', 0.11), ('R', -0.11)):
        add(f'thigh.{side}', 'pelvis', (x, 0, 0))
        add(f'shin.{side}', f'thigh.{side}', (0, 0, -0.45))
        add(f'foot.{side}', f'shin.{side}', (0, 0, -0.41))
    add('spine', 'pelvis', (0, 0, 0))
    add('spine.001', 'spine', (0, 0, 0.3))
    add('neck', 'spine.001', (0, 0, 0.3))
    add('face', 'neck', (0, 0, 0.27))
    for side, x in (('L', 1), ('R', -1)):
        add(f'shoulder.{side}', 'spine.001', (0, 0, 0.3))
        add(f'upper_arm.{side}', f'shoulder.{side}', (0.18 * x, 0, 0))
        add(f'forearm.{side}', f'upper_arm.{side}', (0.32 * x, 0, 0))
    children = {}
    for name, parent, _, _ in joints:
        children.setdefault(parent, []).append(name)
    info = {name: (off, ch) for name, _, off, ch in joints}
    lines = ['HIERARCHY']

    def emit(name, depth):
        off, ch = info[name]
        pad = '\t' * depth
        lines.append(f'{pad}{"ROOT" if depth == 0 else "JOINT"} {name}')
        lines.append(pad + '{')
        lines.append(f'{pad}\tOFFSET {off[0]:.6f} {off[1]:.6f} {off[2]:.6f}')
        lines.append(f'{pad}\tCHANNELS {ch} ' + ('Xposition Yposition Zposition ' if ch == 6 else '') + 'Xrotation Yrotation Zrotation')
        kids = children.get(name, [])
        for k in kids:
            emit(k, depth + 1)
        if not kids:
            lines.extend([pad + '\tEnd Site', pad + '\t{', pad + '\t\tOFFSET 0.000000 -0.050000 0.000000', pad + '\t}'])
        lines.append(pad + '}')

    emit('pelvis', 0)
    order = []

    def walk(name):
        order.append(name)
        for k in children.get(name, []):
            walk(k)

    walk('pelvis')
    lines += ['MOTION', f'Frames: {n}', 'Frame Time: 0.033333']
    for f in range(n):
        row = []
        for name in order:
            if name == 'pelvis':
                row += [0.0, 0.94, 0.0, -90.0, 0.0, 0.0]
            elif name == 'neck' and neck_yaw_deg is not None:
                row += [0.0, 0.0, float(neck_yaw_deg[f])]
            elif name == 'spine.001' and chest_roll_deg is not None:
                row += [0.0, float(chest_roll_deg[f]), 0.0]
            else:
                row += [0.0, 0.0, 0.0]
        lines.append(' '.join(f'{v:.5f}' for v in row))
    return '\n'.join(lines) + '\n'


class Names(unittest.TestCase):
    def test_parse_name(self):
        self.assertEqual(S.parse_name('idle_07.bvh'), ('idle', None, 7))
        self.assertEqual(S.parse_name('l_aro_1_07.bvh'), ('l_aro', 1, 7))
        self.assertEqual(S.parse_name('sc_hea_2_49.bvh'), ('sc_hea', 2, 49))
        self.assertEqual(S.parse_name('yaw_12.bvh'), ('yaw', None, 12))
        for bad in ('idle_7.bvh', 'IDLE_07.bvh', 'dance_07.bvh', 'idle_07.txt', 'idle.bvh', 'phone_07.bvh'):
            self.assertIsNone(S.parse_name(bad), bad)

    def test_splits_are_the_official_ones_and_disjoint(self):
        allsub = [s for v in S.SPLITS.values() for s in v]
        self.assertEqual(sorted(allsub), list(range(50)))
        self.assertEqual(S.split_of(8), 'val')
        self.assertEqual(S.split_of(45), 'test')
        self.assertEqual(S.split_of(0), 'train')
        self.assertEqual(len(S.SPLITS['val']), 5)
        self.assertEqual(len(S.SPLITS['test']), 10)

    def test_only_freemocap_idle_and_actions_are_extracted(self):
        kinds = {'idle', 'l_aro'}
        self.assertEqual(S.member_target('freemocap/idle/idle_03.bvh', kinds), 'idle/idle_03.bvh')
        self.assertEqual(S.member_target('freemocap/actions/l_aro_1_03.bvh', kinds), 'actions/l_aro_1_03.bvh')
        for bad in ('lafan/idle/idle_03.bvh', 'Lafan/idle/idle_03.bvh', 'freemocap/phone/phone_03.bvh', 'freemocap/actions/t_fac_03.bvh',
                    'freemocap/idle/../idle_03.bvh', '/freemocap/idle/idle_03.bvh', 'freemocap\\idle\\idle_03.bvh', 'freemocap/idle/x/idle_03.bvh',
                    'freemocap/actions/idle_03.bvh', 'freemocap/idle/l_aro_1_03.bvh', 'C:/freemocap/idle/idle_03.bvh', 'freemocap/idle/idle_03.py'):
            self.assertIsNone(S.member_target(bad, kinds), bad)


class Signal(unittest.TestCase):
    def test_gaussian_smooth_keeps_constants_and_is_zero_phase(self):
        x = np.zeros((41, 2)); x[20] = 1.0; x[:, 1] += 3.0
        y = gaussian_smooth(x, 2.0)
        self.assertAlmostEqual(float(y[:, 1].mean()), 3.0 + 1 / 41, places=6)
        self.assertEqual(int(np.argmax(y[:, 0])), 20)
        np.testing.assert_allclose(y[20 - 5, 0], y[20 + 5, 0], atol=1e-12)
        np.testing.assert_array_equal(gaussian_smooth(x, 0), x)

    def test_glitch_mask_cuts_a_jump_and_its_surroundings(self):
        seg = np.zeros((90, 27))
        seg[45:, 7] = 0.4   # the neck yaws 0.4 rad in one frame: 12 rad/s
        m = S.glitch_mask(seg)
        self.assertTrue(m[45] and m[45 - 9] and m[45 + 9])
        self.assertFalse(m[0] or m[-1])
        calm = np.zeros((90, 27)); calm[:, 7] = 0.3 * np.sin(np.arange(90) / 30 * 2 * math.pi * 0.5)
        self.assertFalse(S.glitch_mask(calm).any())

    def test_share_neck_head_keeps_the_chain(self):
        seg = np.random.RandomState(1).randn(20, 27) * 0.1
        out = S.share_neck_head(seg)
        np.testing.assert_allclose(out[:, 6:9] + out[:, 9:12], seg[:, 6:9] + seg[:, 9:12])
        np.testing.assert_allclose(out[:, 6:9], out[:, 9:12])
        np.testing.assert_array_equal(out[:, :6], seg[:, :6])
        np.testing.assert_array_equal(out[:, 12:], seg[:, 12:])


    def test_deadband_turns_slow_wobble_into_holds_and_keeps_the_looks(self):
        t = np.arange(300) / 30
        seg = np.zeros((300, 27))
        wobble = math.radians(1.0) * np.sin(2 * math.pi * 0.3 * t)          # ≤ 1.9 deg/s: tracker wobble
        look = np.where(t > 5, math.radians(20.0), 0.0)                       # a 20° look, eased over ~0.5 s
        look = gaussian_smooth(look, 5.0)
        seg[:, 7] = (wobble + look) / 2
        seg[:, 10] = (wobble + look) / 2
        out = S.deadband_head(seg, 2.0)
        chain = np.degrees(out[:, 7] + out[:, 10])
        speed = np.abs(np.diff(chain)) * 30
        self.assertGreater(float((speed < 1).mean()), 0.85)                   # mostly holds now
        self.assertGreater(chain[-1] - chain[0], 15.0)                        # the look is still there
        np.testing.assert_allclose(out[:, 6:9], out[:, 9:12])
        np.testing.assert_array_equal(out[:, :6], seg[:, :6])
        np.testing.assert_array_equal(S.deadband_head(seg, 0), seg)

    def test_pause_runs_count_only_long_enough_holds(self):
        speeds = [5] * 30 + [0.2] * 15 + [5] * 30 + [0.5] * 6 + [5] * 30 + [0] * 30   # 0.5 s hold, 0.2 s (too short), 1 s at the end
        self.assertEqual(S.pause_runs(speeds), [0.5, 1.0])
        self.assertEqual(S.pause_runs([0.5] * 60, threshold=0.4), [])

    def test_pooled_quality_reports_holds(self):
        seg = np.zeros((300, 27))
        t = np.arange(150) / 30
        seg[150:, 7] = seg[150:, 10] = math.radians(10) * np.sin(2 * math.pi * 0.5 * t) / 2   # 5 s still, then 5 s of turning
        q = S.pooled_quality([seg])
        self.assertAlmostEqual(q['stillShare'], 0.5, delta=0.05)
        self.assertEqual(q['pausesPerMin'], 6.0)   # one 5 s hold in 10 s (the turn's slow ends are shorter than 0.3 s)


class Skeleton(unittest.TestCase):
    def test_rename_rest_axes_makes_a_standing_blender_export_the_identity(self):
        r = np.repeat(Z_UP_TO_Y_UP[None], 3, axis=0)   # a standing person's world rotations in such a file
        np.testing.assert_allclose(rename_rest_axes([r])[0], np.repeat(np.eye(3)[None], 3, axis=0), atol=1e-12)

    def take(self, **kw):
        joints, data, ft = parse_bvh(freemocap_like_bvh(**kw))
        return Take(joints, data, ft, names=S.FREEMOCAP_JOINTS, z_up=True, skull_m=S.SKULL_M, foot_smooth_s=0.1)

    def test_standing_still_is_all_zero_and_not_a_step(self):
        t = self.take()
        self.assertFalse(t.cut.any())
        seg = t.segment(0, 300)
        np.testing.assert_allclose(seg, 0, atol=1e-6)
        self.assertAlmostEqual(t.height_m, 0.94 + 0.3 + 0.3 + 0.27 - 0.08 + S.SKULL_M, delta=0.1)

    def test_a_neck_turn_to_her_left_is_positive_yaw_in_the_head_chain(self):
        n = 300
        yaw = 10 * np.sin(np.arange(n) / 30 * 2 * math.pi * 0.4)   # degrees, about the neck's local Z (up in the Z-up rest)
        seg = self.take(n=n, neck_yaw_deg=yaw).segment(0, n)
        chain = np.degrees(seg[:, 7] + seg[:, 10])   # neck yaw + head yaw (before sharing, all of it is in the neck)
        np.testing.assert_allclose(chain, yaw - yaw.mean(), atol=0.05)
        np.testing.assert_allclose(seg[:, [6, 8, 9, 11]], 0, atol=1e-6)
        np.testing.assert_allclose(seg[:, 3:6], 0, atol=1e-6)   # the chest did not move

    def test_a_chest_lean_toward_her_left_shoulder_is_positive_roll(self):
        n = 300
        roll = 6 * np.sin(np.arange(n) / 30 * 2 * math.pi * 0.3)   # about the chest's local Y = her backward axis in the Z-up rest
        seg = self.take(n=n, chest_roll_deg=roll).segment(0, n)
        # A turn about local Y (Z-up rest: -forward) by +a tips the top toward... +a about -forward = roll +a (toward her left shoulder).
        np.testing.assert_allclose(np.degrees(seg[:, 5]), roll - roll.mean(), atol=0.05)
        np.testing.assert_allclose(seg[:, [3, 4]], 0, atol=1e-6)


if __name__ == '__main__':
    unittest.main(verbosity=1)
