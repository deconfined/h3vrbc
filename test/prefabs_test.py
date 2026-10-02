"""Extraction checks: parent transforms, barrel pairing and verified game shot rules."""
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

import dnfile

from tools.prefabs import Prefabs, ancestry


def pointer(path_id):
    return {"m_FileID": 0, "m_PathID": path_id}


class Transform:
    def __init__(self, path_id, position, parent=0, scale=(1, 1, 1), rotation=(0, 0, 0, 1), **fields):
        self.path_id = path_id
        self.assets_file = SimpleNamespace(name="test.assets")
        self.type = SimpleNamespace(name="Transform")
        self.data = {
            "m_LocalPosition": dict(zip("xyz", position)),
            "m_LocalScale": dict(zip("xyz", scale)),
            "m_LocalRotation": dict(zip("xyzw", rotation)),
            "m_Father": pointer(parent),
            **fields,
        }

    def read_typetree(self):
        return self.data


class MockPrefabs(Prefabs):
    def __init__(self, objects):
        self.objects = {obj.path_id: obj for obj in objects}
        self.matrices = {}
        self.assets = SimpleNamespace(full=lambda obj: obj.data)

    def resolve(self, obj, ref):
        return self.objects.get(ref["m_PathID"]) if ref else None

    def identity(self, obj, data):
        return "test"

    def muzzle_mounts(self, obj, data):
        return []

    def game_name(self, obj):
        return f"Object {obj.path_id}"

    def shot_rule(self, name, fields):
        return {"kind": "constant", "value": 1}


class GeometryTests(unittest.TestCase):
    def test_world_pose_includes_parent_scale_rotation_and_translation(self):
        root = Transform(1, (10, 20, 30), scale=(2, 3, 4), rotation=(0, math.sqrt(0.5), 0, math.sqrt(0.5)))
        child = Transform(2, (1, 2, 3), parent=1)
        pose = MockPrefabs([root, child]).pose(child)
        for actual, expected in zip(pose["position"], (22, 26, 28)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(pose["scale"], (2, 3, 4)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(pose["forward"], (1, 0, 0)):
            self.assertAlmostEqual(actual, expected)

    def test_secondary_lever_chamber_uses_its_own_muzzle_and_caliber(self):
        root = Transform(1, (0, 0, 0), scale=(2, 2, 2))
        first = Transform(2, (0, 0, 0), parent=1, RoundType=13, ChamberVelocityMultiplier=1.15)
        second = Transform(3, (0, 0.1, 0), parent=1, RoundType=8, ChamberVelocityMultiplier=2.5)
        muzzle = Transform(4, (0, 0, 0.25), parent=1)
        second_muzzle = Transform(5, (0, 0.1, 0.1), parent=1)
        reader = MockPrefabs([root, first, second, muzzle, second_muzzle])
        result = reader.weapon(root, {
            "AccuracyClass": 0, "MuzzlePos": pointer(4), "Chamber": pointer(2),
            "UsesSecondChamber": True, "Chamber2": pointer(3), "SecondMuzzle": pointer(5),
        }, "LeverActionFirearm")
        self.assertEqual(len(result["chambers"]), 2)
        self.assertAlmostEqual(result["chambers"][0]["barrelLength"], 0.5)
        self.assertAlmostEqual(result["chambers"][1]["barrelLength"], 0.2)
        self.assertEqual(result["chambers"][1]["multiplier"], 2.5)
        self.assertEqual(result["chambers"][1]["caliberId"], 8)

    def test_multibarrel_geometry_pairs_muzzles_and_deduplicates_chambers(self):
        chamber = Transform(2, (0, 0, 0), RoundType=13, ChamberVelocityMultiplier=1)
        muzzle = Transform(3, (0, 0, 0.5))
        fields = {"AccuracyClass": 0, "MuzzlePos": pointer(3),
                  "Barrels": [{"Chamber": pointer(2), "Muzzle": pointer(3)}],
                  "Chambers": [pointer(2)]}
        result = MockPrefabs([chamber, muzzle]).weapon(chamber, fields, "BreakActionWeapon")
        self.assertEqual(len(result["chambers"]), 1)
        self.assertEqual(result["chambers"][0]["barrelLength"], 0.5)

    def test_missing_muzzle_is_unknown_not_zero_or_guessed(self):
        chamber = Transform(2, (0, 0, 0), RoundType=13, ChamberVelocityMultiplier=1)
        result = MockPrefabs([chamber]).weapon(chamber, {
            "AccuracyClass": 0, "MuzzlePos": pointer(0), "Chamber": pointer(2),
        }, "Handgun")
        self.assertIsNone(result["chambers"][0]["barrelLength"])

    def test_device_geometry_is_root_relative_and_submount_parenting_is_certified(self):
        root = Transform(1, (10, 20, 30), rotation=(0, math.sqrt(0.5), 0, math.sqrt(0.5)))
        muzzle = Transform(2, (0, 0, 0.2), parent=1)
        interface = Transform(3, (0, 0, 0), parent=1, SubMounts=[pointer(4)])
        reader = MockPrefabs([root, muzzle, interface])
        reader.assets.classname = lambda obj: "SuppressorInterface"
        reader.families = {"Suppressor": ["Suppressor", "MuzzleDevice"]}
        reader.muzzle_mounts = lambda obj, data: [{"source": {"pathId": "4"}}, {"source": {"pathId": "5"}}]
        profile = reader.device(root, {"Muzzle": pointer(2), "MechanicalAccuracy": 100,
                                      "AttachmentInterface": pointer(3), "CanScaleToMount": True,
                                      "IsBiDirectional": False}, "Suppressor")
        self.assertEqual(profile["kind"], "suppressor")
        self.assertEqual(profile["interfaceClass"], "SuppressorInterface")
        self.assertEqual(profile["rootPose"]["position"], [10, 20, 30])
        for actual, expected in zip(profile["muzzleOffset"], (0, 0, 0.2)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(profile["muzzleForward"], (0, 0, 1)):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(profile["muzzleMounts"][0]["followsRootParent"], True)
        self.assertEqual(profile["muzzleMounts"][1]["followsRootParent"], False)

    def test_zero_scale_is_rejected(self):
        transform = Transform(1, (0, 0, 0), scale=(1, 0, 1))
        with self.assertRaisesRegex(ValueError, "Zero-scale"):
            MockPrefabs([transform]).pose(transform)


ASSEMBLY = Path("game_data/h3vr_Data/Managed/Assembly-CSharp.dll")


@unittest.skipUnless(ASSEMBLY.is_file(), "Requires the local game install")
class GameShotRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pe = dnfile.dnPE(str(ASSEMBLY))
        types, families = ancestry(pe)
        cls.reader = Prefabs(None, pe, types, families, {})

    def test_constant_callers_are_verified_from_il(self):
        for name in ("Handgun", "Revolver", "BoltActionRifle", "BreakActionWeapon", "LeverActionFirearm"):
            with self.subTest(name=name):
                rule = self.reader.shot_rule(name, {})
                self.assertEqual(rule["kind"], "constant")
                self.assertEqual(rule["value"], 1)
                self.assertTrue(rule["source"]["methods"])

    def test_closed_bolt_sticky_flag_changes_the_rule(self):
        plain = self.reader.shot_rule("ClosedBoltWeapon", {"UsesStickyDetonation": False})
        charged = self.reader.shot_rule("ClosedBoltWeapon", {"UsesStickyDetonation": True, "StickyMaxMultBonus": 2})
        self.assertEqual(plain["kind"], "constant")
        self.assertEqual(plain["value"], 1)
        self.assertEqual(charged["kind"], "sticky")
        self.assertEqual(charged["bonus"], 2)

    def test_unverified_dynamic_callers_require_manual_input(self):
        self.assertEqual(self.reader.shot_rule("Girandoni", {})["kind"], "manual")
        self.assertEqual(self.reader.shot_rule("Minigun", {})["kind"], "manual")
