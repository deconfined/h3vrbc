#!/usr/bin/env python3
"""Extract numeric H3VR ballistics data; never copy textures, meshes or game code."""
import argparse
import gc
import hashlib
import json
from pathlib import Path

import dnfile
import UnityPy
from UnityPy.classes import PPtr
from UnityPy.enums import ClassIDType
from UnityPy.helpers import TypeTreeHelper
from UnityPy.helpers.Tpk import get_typetree_node
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

if __package__:
    from .prefabs import Prefabs, ancestry
else:
    from prefabs import Prefabs, ancestry

# The accelerated reader retains the generated header's original alignment.
# The pure reader honors the corrected Unity-version flags in Assets.full.
TypeTreeHelper.read_typetree_boost = None

# Free-flight code in this exact assembly was inspected before porting the model.
SUPPORTED_ASSEMBLY = "033e275871f798eeab5d6cdf0c7ace348cdff2acf9588b1a6c1a46805f20a76b"
MODEL = "h3vr-120p3-free-flight"


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def fix_string_arrays(node):
    # TTGen 0.0.10 labels List<string>/string[] as "string", causing the
    # reader to consume a string instead of an array (optic display names).
    # A normal string's Array contains chars and must remain untouched.
    if (node.m_Type == "string" and node.m_Children
            and node.m_Children[0].m_Type == "Array"
            and node.m_Children[0].m_Children[1].m_Type == "string"):
        node.m_Type = "vector"
    for child in node.m_Children:
        fix_string_arrays(child)


class Assets:
    def __init__(self, game, version):
        self.generator = TypeTreeGenerator(version)
        self.generator.load_local_dll_folder(str(game / "Managed"))
        self.classes = {}

    def load(self, path):
        env = UnityPy.load(str(path))
        env.typetree_generator = self.generator
        return env

    def classname(self, obj):
        if obj.type.name != "MonoBehaviour":
            return None
        script = obj.parse_monobehaviour_head().m_Script
        if not script.m_PathID:
            return None
        key = (id(obj.assets_file), script.m_FileID, script.m_PathID)
        if key not in self.classes:
            self.classes[key] = script.deref_parse_as_object().m_ClassName
        return self.classes[key]

    def full(self, obj):
        if obj.type.name != "MonoBehaviour":
            return obj.read_typetree()
        script = obj.parse_monobehaviour_head().m_Script.deref_parse_as_object()
        fullname = f"{script.m_Namespace}.{script.m_ClassName}" if script.m_Namespace else script.m_ClassName
        node = self.generator.get_nodes_up(script.m_AssemblyName, fullname)
        fix_string_arrays(node)
        # TTGen 0.0.10's generated Unity 5 base header omits m_Enabled padding.
        # Use the engine-version header flags; custom payload retains its own tree.
        builtin = get_typetree_node(ClassIDType.MonoBehaviour, obj.version)
        for child in node.m_Children[:4]:
            original = next((item for item in builtin.m_Children if item.m_Name == child.m_Name), None)
            if original is not None:
                child.m_MetaFlag = original.m_MetaFlag
        data = obj.read_typetree(nodes=node)
        if data["m_Script"]["m_PathID"] != obj.parse_monobehaviour_head().m_Script.m_PathID:
            raise ValueError(f"Generated tree misaligns {fullname} in {obj.assets_file.name}")
        return data

    def forget(self):
        # Cached object identity keys cannot survive environments being released.
        self.classes.clear()


def deref(obj, pointer):
    if not pointer["m_PathID"]:
        return None
    return PPtr(m_FileID=pointer["m_FileID"], m_PathID=pointer["m_PathID"], assetsfile=obj.assets_file).deref()


def components(obj):
    for entry in obj.read_typetree()["m_Component"]:
        pointer = entry["component"] if isinstance(entry, dict) else entry[1]
        component = deref(obj, pointer)
        if component is not None:
            yield component


def curve(data):
    if data["m_PreInfinity"] != 2 or data["m_PostInfinity"] != 2:
        raise ValueError("Unsupported curve infinity mode; re-verify native curve semantics before extraction")
    keys = data["m_Curve"]
    if not keys:
        raise ValueError("Required ballistic curve is empty")
    return {"keys": [{key: item[key] for key in ("time", "value", "inSlope", "outSlope")} for item in keys], "preWrap": "clamp", "postWrap": "clamp"}


def enum_values(pe, name):
    constants = {id(item.Parent.row): int.from_bytes(item.Value.value, "little", signed=True)
                 for item in pe.net.mdtables.Constant if item.Type in (2, 3, 4, 5, 6, 7, 8, 9)}
    typedef = next(item for item in pe.net.mdtables.TypeDef if str(item.TypeName) == name)
    return {constants[id(field.row)]: str(field.row.Name) for field in typedef.FieldList if id(field.row) in constants}


def extract(root, output):
    game = root / "h3vr_Data" if (root / "h3vr_Data").is_dir() else root
    assembly = game / "Managed" / "Assembly-CSharp.dll"
    checksum = digest(assembly)
    if checksum != SUPPORTED_ASSEMBLY:
        raise ValueError(f"Unverified game assembly {checksum}. The projectile model must be inspected before using this version.")
    globals_env = UnityPy.load(str(game / "globalgamemanagers"))
    version = str(next(iter(globals_env.objects)).assets_file.unity_version)
    time = next(obj.read_typetree() for obj in globals_env.objects if obj.type.name == "TimeManager")
    build = next((obj.read_typetree() for obj in globals_env.objects if obj.type.name == "BuildSettings"), {})
    assets = Assets(game, version)
    resources = assets.load(game / "resources.assets")
    catalog = {}
    displays = []
    am = None
    for obj in resources.objects:
        name = assets.classname(obj)
        if name == "FVRObject":
            catalog[obj.path_id] = assets.full(obj)
        elif name == "FVRFireArmRoundDisplayData":
            displays.append((obj, assets.full(obj)))
        elif name == "AM":
            am = assets.full(obj)
            am_obj = obj
    if am is None:
        raise ValueError("AM with the global bullet drag curve was not found")
    pe = dnfile.dnPE(str(assembly))
    type_names = enum_values(pe, "FireArmRoundType")
    class_names = enum_values(pe, "FireArmRoundClass")
    calibers = [{"id": data["Type"], "name": data["DisplayName"], "enumName": type_names[data["Type"]],
                 "barrelCurve": curve(data["VelMultByBarrelLengthCurve"]),
                 "opticDropCurve": curve(data["BulletDropCurve"]),
                 "zeroReferenceClass": class_names[data["ZeroWhichAmmo"]],
                 "source": {"file": obj.assets_file.name, "pathId": str(obj.path_id)}} for obj, data in displays]
    declared = {}
    for _, display in displays:
        for entry in display["Classes"]:
            pointer = entry["ObjectID"]
            if not pointer["m_PathID"]:
                continue
            item = catalog[pointer["m_PathID"]]
            declared[item["ItemID"]] = item
    caliber_ids = {item["id"] for item in calibers}
    weapon_items = [item for item in catalog.values() if item["Category"] == 1 and item["UsesRoundTypeFlag"] and item["RoundType"] in caliber_ids]
    weapons = {item["ItemID"]: {"id": item["ItemID"], "name": item["DisplayName"], "caliberId": item["RoundType"],
                               "chambers": [], "presetUnavailable": "No standard firearm prefab configuration found."} for item in weapon_items}
    types, families = ancestry(pe)
    shot_cache = {}
    muzzle_devices = []
    optics = []
    mount_names = enum_values(pe, "FVRFireArmAttachementMountType")
    accuracy_names = enum_values(pe, "FVRFireArmMechanicalAccuracyClass")
    chart = assets.full(deref(am_obj, am["AccuracyChart"]))
    accuracy_classes = [{"id": item["Class"], "name": accuracy_names[item["Class"]],
                         "minMoa": item["MinMOA"], "maxMoa": item["MaxMOA"], "minDegrees": item["MinDegrees"], "maxDegrees": item["MaxDegrees"],
                         "dropMult": item["DropMult"], "driftMult": item["DriftMult"]} for item in chart["Entries"]]
    bundle_names = sorted({item["m_anvilPrefab"]["Bundle"] for item in list(declared.values()) + weapon_items + [item for item in catalog.values() if item["Category"] == 5]})
    catalog_by_asset = {(item["m_anvilPrefab"]["Bundle"], item["m_anvilPrefab"]["AssetName"].casefold()): item
                        for item in catalog.values() if item["m_anvilPrefab"]["Bundle"] in bundle_names}
    rounds = []
    excluded = []
    seen = set()
    inputs = [{"file": "Managed/Assembly-CSharp.dll", "sha256": checksum},
              {"file": "resources.assets", "sha256": digest(game / "resources.assets")}]
    for bundle_name in bundle_names:
        path = game / "StreamingAssets" / bundle_name
        print(f"Reading {bundle_name}", flush=True)
        env = assets.load(path)
        prefab_names = {}
        root_objects = {}
        for container in env.objects:
            if container.type.name == "AssetBundle":
                for asset_path, entry in container.read_typetree()["m_Container"]:
                    root_obj = deref(container, entry["asset"])
                    if root_obj is not None:
                        prefab_names[(root_obj.assets_file.name, root_obj.path_id)] = Path(asset_path).stem
                        root_objects[(root_obj.assets_file.name, root_obj.path_id)] = root_obj
        prefab_reader = Prefabs(assets, pe, types, families, shot_cache)
        prefab_reader.mount_names = mount_names
        for key, root_obj in root_objects.items():
            asset_name = prefab_names[key]
            wrapper = catalog_by_asset.get((bundle_name, asset_name.casefold()))
            if wrapper is None or root_obj.type.name != "GameObject":
                continue
            for component in components(root_obj):
                classname = assets.classname(component)
                chain = families.get(classname, [])
                if "FVRFireArm" in chain and wrapper["ItemID"] in weapons:
                    fields = assets.full(component)
                    profile = prefab_reader.weapon(component, fields, classname)
                    weapons[wrapper["ItemID"]].pop("presetUnavailable", None)
                    profile["source"].update({"bundle": bundle_name, "assetName": asset_name})
                    weapons[wrapper["ItemID"]].update(profile)
                elif "MuzzleDevice" in chain and wrapper["Category"] == 5:
                    fields = assets.full(component)
                    device = {"id": wrapper["ItemID"], "name": wrapper["DisplayName"],
                              **prefab_reader.device(component, fields, classname)}
                    device["source"].update({"bundle": bundle_name, "assetName": asset_name})
                    muzzle_devices.append(device)
            if wrapper["Category"] == 5:
                for optic in prefab_reader.optics(root_obj):
                    optic.update({"id": f"{wrapper['ItemID']}:{optic['source']['pathId']}",
                                  "attachmentId": wrapper["ItemID"], "name": wrapper["DisplayName"]})
                    optic["source"].update({"bundle": bundle_name, "assetName": asset_name})
                    optics.append(optic)
        for obj in env.objects:
            if assets.classname(obj) != "FVRFireArmRound":
                continue
            data = assets.full(obj)
            root_obj = deref(obj, data["m_GameObject"])
            asset_name = prefab_names.get((root_obj.assets_file.name, root_obj.path_id))
            if asset_name is None:
                # Weapon bundles also contain rounds nested in magazines/chambers.
                # Only catalogued exported round prefabs define ammunition entries.
                continue
            # Some prefabs have erroneous ObjectWrapper links (e.g. .357 SIG JHP
            # points to .357 Magnum JHP). Use the original exported asset identity.
            wrapper = catalog_by_asset.get((bundle_name, asset_name.casefold()))
            if wrapper is None:
                continue
            item_id = wrapper["ItemID"]
            if item_id in seen:
                raise ValueError(f"Duplicate round ID: {item_id}")
            seen.add(item_id)
            prefab = deref(obj, data["BallisticProjectilePrefab"])
            candidates = list(components(prefab)) if prefab is not None and prefab.type.name == "GameObject" else []
            projectile = next((item for item in candidates if assets.classname(item) == "BallisticProjectile"), None)
            other_flight = [assets.classname(item) for item in candidates if assets.classname(item) in ("FVRProjectile", "BurningFlare")]
            if projectile is None or other_flight:
                reason = "Additional flight controller: " + ", ".join(other_flight) if other_flight else "No BallisticProjectile; different projectile integrator"
                excluded.append({"id": item_id, "name": wrapper["DisplayName"], "reason": reason})
                continue
            p = assets.full(projectile)
            rounds.append({
                "id": item_id, "name": wrapper["DisplayName"], "caliberId": data["RoundType"],
                "roundClass": class_names[data["RoundClass"]], "numProjectiles": data["NumProjectiles"],
                "spreadDegrees": data["ProjectileSpread"], "mass": p["Mass"], "diameter": p["Dimensions"]["x"],
                "muzzleVelocity": p["MuzzleVelocityBase"], "flightVelocityMultiplier": p["FlightVelocityMultiplier"],
                "airDragMultiplier": p["AirDragMultiplier"], "gravityMultiplier": p["GravityMultiplier"],
                "maxRange": p["MaxRange"], "maxRangeRandom": p["MaxRangeRandom"],
                "deletesOnStraightDown": bool(p["DeletesOnStraightDown"]), "hasSubmunitions": bool(p["Submunitions"]),
                "cleanupDelay": p["m_dieTimerMax"],
                "source": {"bundle": bundle_name, "assetName": asset_name, "file": obj.assets_file.name, "roundPathId": str(obj.path_id), "projectilePathId": str(projectile.path_id)},
            })
        inputs.append({"file": f"StreamingAssets/{bundle_name}", "sha256": digest(path)})
        del env, obj, root_objects, prefab_reader
        assets.forget()
        gc.collect()
    for item_id, item in declared.items():
        if item_id not in seen:
            excluded.append({"id": item_id, "name": item["DisplayName"], "reason": "No FVRFireArmRound prefab in the declared bundle"})
    caliber_ids = {item["id"] for item in calibers}
    for item in rounds:
        if item["caliberId"] not in caliber_ids or item["mass"] <= 0 or item["diameter"] <= 0 or item["muzzleVelocity"] <= 0:
            raise ValueError(f"Missing or invalid physical data: {item['id']}")
    scenes = []
    levels = build["scenes"]
    for path in sorted(game.glob("level[0-9]*"), key=lambda path: int(path.name[5:])):
        env = assets.load(path)
        for obj in env.objects:
            if assets.classname(obj) == "FVRSceneSettings":
                settings = assets.full(obj)
                index = int(path.name[5:])
                label = Path(levels[index]).stem if index < len(levels) else path.name
                scenes.append({"name": label, "file": path.name, "maxRange": settings["MaxProjectileRange"], "catchHeight": settings["CatchHeight"]})
        del env
        assets.forget()
        gc.collect()
    dataset = {
        "schemaVersion": 2, "model": MODEL,
        "source": {"assemblySha256": checksum, "unityVersion": version, "inputs": inputs},
        "settings": {"fixedDeltaTime": time["Fixed Timestep"], "dragCurve": curve(am["BulletDragCoefficientCurve"]),
                     "accuracyClasses": accuracy_classes,
                     "gravityModes": [{"name": "Realistic", "value": 9.8100004196167}, {"name": "Playful", "value": 5.0},
                                      {"name": "On the Moon", "value": 1.621999979019165}, {"name": "None", "value": 0.0}]},
        "calibers": sorted(calibers, key=lambda item: item["name"].casefold()),
        "weapons": sorted(weapons.values(), key=lambda item: item["name"].casefold()),
        "muzzleDevices": sorted(muzzle_devices, key=lambda item: item["name"].casefold()),
        "optics": sorted(optics, key=lambda item: (item["name"].casefold(), item["componentClass"])),
        "scenes": scenes,
        "rounds": sorted(rounds, key=lambda item: item["name"].casefold()),
        "excluded": sorted(excluded, key=lambda item: item["name"].casefold()),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dataset, separators=(",", ":"), allow_nan=False) + "\n")
    print(f"Extracted {len(rounds)} supported rounds, {len(calibers)} calibers, {len(weapons)} weapon presets, {len(muzzle_devices)} muzzle devices, {len(optics)} optic views, {len(scenes)} scene settings.")
    print(f"{len(excluded)} unavailable rounds have explicit reasons. Wrote {output} ({output.stat().st_size:,} bytes).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_install", type=Path, help="Game installation or h3vr_Data directory")
    parser.add_argument("--output", type=Path, default=Path("public/data/h3vr.json"))
    args = parser.parse_args()
    extract(args.game_install, args.output)
