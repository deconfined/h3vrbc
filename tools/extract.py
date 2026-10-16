#!/usr/bin/env python3
"""Extract numeric H3VR ballistics data; never copy textures, meshes or game code."""
import argparse
import gc
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path

import dnfile
import UnityPy
from UnityPy.classes import PPtr
from UnityPy.enums import ClassIDType
from UnityPy.files import SerializedFile
from UnityPy.helpers import TypeTreeHelper
from UnityPy.helpers.Tpk import get_typetree_node
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

if __package__:
    from . import mods
    from .mods import assembly_stem, script_key
    from .prefabs import Prefabs, ancestry
else:
    import mods
    from mods import assembly_stem, script_key
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
        self.game_assemblies = {assembly_stem(path.name).casefold() for path in (game / "Managed").glob("*.dll")}
        self.classes = {}
        # Classes MonoMod script libraries inject into Assembly-CSharp, keyed by
        # (namespace, name), and the game assembly's own classes.
        self.injected, self.game_types = {}, set()
        # Mod bundles are built in the Unity editor, which embeds each object's
        # serialized layout. Prefer that layout for mod content: it is what the
        # game deserializes, and it does not depend on having the mod's DLL.
        self.embedded = False

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
            data = script.deref_parse_as_object()
            # MeatKit's editor-side name for the game assembly can survive in a bundle.
            assembly = re.sub(r"^H3VRCode-CSharp", "Assembly-CSharp", data.m_AssemblyName or "", flags=re.IGNORECASE)
            game = not assembly or assembly_stem(assembly).casefold() in self.game_assemblies
            identity = (data.m_Namespace, data.m_ClassName)
            if game and identity in self.injected and identity not in self.game_types:
                self.classes[key] = self.injected[identity]
            else:
                self.classes[key] = data.m_ClassName if game else script_key(assembly, data.m_Namespace, data.m_ClassName)
        return self.classes[key]

    def full(self, obj):
        if self.embedded and obj.serialized_type is not None and obj.serialized_type.node:
            return obj.read_typetree()
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


# Game classes whose runtime patching can change what this model computes.
BALLISTIC_CLASSES = {"AM", "BallisticProjectile", "FVRFireArm", "FVRFireArmChamber", "FVRFireArmRound",
                     "FVRFireArmRoundDisplayData", "FVRFireArmMechanicalAccuracyChart", "FVRFireArmAttachment",
                     "FVRFireArmAttachmentMount", "MuzzleDevice", "PIPScopeController", "ReflexSightController",
                     "FVRSceneSettings"}


def bundle_objects(file):
    """Every object in a loaded bundle, including nested serialized files."""
    for item in (getattr(file, "files", None) or {}).values():
        if isinstance(item, SerializedFile):
            yield from item.objects.values()
        else:
            yield from bundle_objects(item)


# Local folders whose paths must not be published in failure messages.
PRIVATE_PATHS = []


def failure(error):
    if isinstance(error, KeyError):
        return f"Serialized data lacks field {error.args[0]!r}; the mod may target another game version."
    if isinstance(error, OSError) and error.strerror:
        return f"{type(error).__name__}: {error.strerror}"
    text = str(error)
    bases = {str(path) for path in PRIVATE_PATHS} | {os.getcwd(), str(Path.home())}
    for base in sorted((base for base in bases if len(base.strip("/\\")) > 1), key=len, reverse=True):
        text = text.replace(base, "<local>")
    return f"{type(error).__name__}: {text}"


def require_finite(value, where="value"):
    """Raise for NaN or infinity anywhere in VALUE: JSON cannot carry them."""
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"Non-finite {where}")
    if isinstance(value, dict):
        for key, item in value.items():
            require_finite(item, key)
    elif isinstance(value, (list, tuple)):
        for item in value:
            require_finite(item, where)
    return value


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
    if not all(math.isfinite(item["time"]) and math.isfinite(item["value"]) for item in keys):
        raise ValueError("Ballistic curve has a non-finite key")
    # Unity stores a Constant (stepped) tangent as an infinite slope; JSON
    # null keeps that meaning, as the curve evaluator steps on non-finite slopes.
    return {"keys": [{"time": item["time"], "value": item["value"],
                      **{key: item[key] if math.isfinite(item[key]) else None for key in ("inSlope", "outSlope")}}
                     for item in keys], "preWrap": "clamp", "postWrap": "clamp"}


def enum_values(pe, name):
    constants = {id(item.Parent.row): int.from_bytes(item.Value.value, "little", signed=True)
                 for item in pe.net.mdtables.Constant if item.Type in (2, 3, 4, 5, 6, 7, 8, 9)}
    typedef = next(item for item in pe.net.mdtables.TypeDef if str(item.TypeName) == name)
    return {constants[id(field.row)]: str(field.row.Name) for field in typedef.FieldList if id(field.row) in constants}


def extract(root, output, mod_dirs=()):
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
    mod_issues = []
    caliber_notes = {}  # Why a mod-defined caliber was left out, by round type.

    def unknown_caliber(type_id):
        return caliber_notes.get(type_id, f"Caliber {type_id} is not defined by the game or an installed mod") + "."

    def contain(mod, wrapper, action):
        """Run ACTION; for mod content, record a failure instead of aborting."""
        if mod is None:
            return action()
        try:
            return action()
        except Exception as error:  # Third-party data: report it and keep extracting.
            mod_issues.append({"mod": mod.id, "id": wrapper.get("ItemID") if wrapper else None,
                               "name": wrapper.get("DisplayName") if wrapper else None, "reason": failure(error)})
            return None

    def read_prefab(prefab_reader, root_obj, wrapper, source, mod=None):
        tag = {} if mod is None else {"mod": mod.id}
        if mod is not None:
            scripts_on = sorted({name for component in prefab_reader.descendants(root_obj)
                                 if (name := assets.classname(component)) and ":" in name})
            if scripts_on:
                tag["modScripts"] = scripts_on
        profiles, devices, views = [], [], []
        for component in components(root_obj):
            classname = assets.classname(component)
            chain = families.get(classname, [])
            if "FVRFireArm" in chain and wrapper["ItemID"] in weapons:
                fields = assets.full(component)
                profile = prefab_reader.weapon(component, fields, classname)
                profile["source"].update(source)
                if mod is not None:
                    # The prefab's caliber is what a modded gun fires; mod
                    # catalogue entries often leave RoundType unset.
                    profile["caliberId"] = fields["RoundType"]
                profiles.append(profile)
            elif "MuzzleDevice" in chain and wrapper["Category"] == 5:
                fields = assets.full(component)
                device = {"id": wrapper["ItemID"], "name": wrapper["DisplayName"],
                          **prefab_reader.device(component, fields, classname), **tag}
                device["source"].update(source)
                devices.append(device)
        if wrapper["Category"] == 5:
            for optic in prefab_reader.optics(root_obj):
                optic.update({"id": f"{wrapper['ItemID']}:{optic['source']['pathId']}",
                              "attachmentId": wrapper["ItemID"], "name": wrapper["DisplayName"], **tag})
                optic["source"].update(source)
                views.append(optic)
        if mod is not None:
            require_finite([profiles, devices, views])
        # Commit only once the whole prefab has been read.
        for profile in profiles:
            weapons[wrapper["ItemID"]].pop("presetUnavailable", None)
            weapons[wrapper["ItemID"]].update(profile, **tag)
        if mod is not None and wrapper["ItemID"] in weapons:
            # The package holding the prefab owns the item; others carry copies.
            weapons[wrapper["ItemID"]].update(tag)
            if not profiles and "modScripts" in tag:
                weapons[wrapper["ItemID"]]["presetUnavailable"] = (
                    "No firearm component this calculator can read; the prefab uses mod scripts "
                    f"{', '.join(tag['modScripts'])}. Enter its values manually.")
        muzzle_devices.extend(devices)
        optics.extend(views)

    def read_round(obj, data, wrapper, source, mod=None):
        item_id = wrapper["ItemID"]
        if item_id in seen:
            raise ValueError(f"Duplicate round ID: {item_id}")
        seen.add(item_id)
        tag = {} if mod is None else {"mod": mod.id}
        prefab = deref(obj, data["BallisticProjectilePrefab"])
        candidates = list(components(prefab)) if prefab is not None and prefab.type.name == "GameObject" else []
        projectile = next((item for item in candidates if assets.classname(item) == "BallisticProjectile"), None)
        other_flight = [assets.classname(item) for item in candidates if assets.classname(item) in ("FVRProjectile", "BurningFlare")]
        if projectile is None or other_flight:
            custom = sorted({name for item in candidates if (name := assets.classname(item)) and ":" in name})
            reason = ("Additional flight controller: " + ", ".join(other_flight) if other_flight
                      else "No BallisticProjectile; different projectile integrator" + (f" ({', '.join(custom)})" if custom else ""))
            excluded.append({"id": item_id, "name": wrapper["DisplayName"], "reason": reason, **tag})
            return
        p = assets.full(projectile)
        entry = {
            "id": item_id, "name": wrapper["DisplayName"], "caliberId": data["RoundType"],
            "roundClass": class_names.get(data["RoundClass"], f"Class {data['RoundClass']}"), "numProjectiles": data["NumProjectiles"],
            "spreadDegrees": data["ProjectileSpread"], "mass": p["Mass"], "diameter": p["Dimensions"]["x"],
            "muzzleVelocity": p["MuzzleVelocityBase"], "flightVelocityMultiplier": p["FlightVelocityMultiplier"],
            "airDragMultiplier": p["AirDragMultiplier"], "gravityMultiplier": p["GravityMultiplier"],
            "maxRange": p["MaxRange"], "maxRangeRandom": p["MaxRangeRandom"],
            "deletesOnStraightDown": bool(p["DeletesOnStraightDown"]), "hasSubmunitions": bool(p["Submunitions"]),
            "cleanupDelay": p["m_dieTimerMax"],
            "source": {**source, "file": obj.assets_file.name, "roundPathId": str(obj.path_id), "projectilePathId": str(projectile.path_id)},
            **tag,
        }
        rounds.append(require_finite(entry) if mod is not None else entry)

    def read_bundle(objects, lookup, source, mod=None, scripts=None):
        """Read one bundle's catalogued prefabs and exported round prefabs.

        LOOKUP maps a container root (asset stem, full container path) to its
        FVRObject (or a list of them, when several items share one prefab), or
        None when that root is not a catalogued item.
        """
        def items_for(stem, full):
            found = lookup(stem, full)
            return [] if found is None else found if isinstance(found, list) else [found]

        prefab_names, prefab_paths, root_objects = {}, {}, {}
        for container in objects:
            if container.type.name == "AssetBundle":
                for asset_path, entry in container.read_typetree()["m_Container"]:
                    root_obj = deref(container, entry["asset"])
                    if root_obj is not None:
                        key = (root_obj.assets_file.name, root_obj.path_id)
                        prefab_names[key] = Path(asset_path).stem
                        prefab_paths[key] = asset_path
                        root_objects[key] = root_obj
        prefab_reader = Prefabs(assets, pe, types, families, shot_cache, scripts)
        prefab_reader.mount_names = mount_names
        matched = set()
        for key, root_obj in root_objects.items():
            if root_obj.type.name != "GameObject":
                continue
            asset_name = prefab_names[key]
            for wrapper in items_for(asset_name, prefab_paths[key]):
                matched.add(wrapper["ItemID"])
                contain(mod, wrapper, lambda: read_prefab(prefab_reader, root_obj, wrapper, {**source, "assetName": asset_name}, mod))
        for obj in objects:
            if mod is None:
                classname = assets.classname(obj)
            else:
                # Unidentifiable scripts are reported per prefab, not per object.
                try:
                    classname = assets.classname(obj)
                except Exception:  # Third-party data.
                    classname = None
            if classname != "FVRFireArmRound":
                continue
            data = contain(mod, None, lambda: assets.full(obj))
            if data is None:
                continue
            root_obj = contain(mod, None, lambda: deref(obj, data["m_GameObject"]))
            asset_name = prefab_names.get((root_obj.assets_file.name, root_obj.path_id)) if root_obj is not None else None
            if asset_name is None:
                # Weapon bundles also contain rounds nested in magazines/chambers.
                # Only catalogued exported round prefabs define ammunition entries.
                continue
            # Some prefabs have erroneous ObjectWrapper links (e.g. .357 SIG JHP
            # points to .357 Magnum JHP). Use the original exported asset identity.
            for wrapper in items_for(asset_name, prefab_paths[(root_obj.assets_file.name, root_obj.path_id)]):
                contain(mod, wrapper, lambda: read_round(obj, data, wrapper, {**source, "assetName": asset_name}, mod))
        return matched

    def read_mods(directories):
        """Add every installed mod's content, following OtherLoader's rules.

        Verified against OtherLoader 1.3.7 (devyndamonster/OtherLoader,
        Scripts/Loading): FVRObjects, round display data and accuracy charts
        are read from every loaded bundle except "late_" ones, which only
        supply prefabs for the bundle they are named after. An ItemID already
        registered is skipped, so the game's own items always win. Display
        data for an existing caliber only adds round classes, and an accuracy
        class that exists is skipped. Which of two mods loads first is a race,
        so content two mods provide differently is reported, not guessed.
        """
        # OtherLoader also reads <game>/LegacyVirtualObjects: beside h3vr_Data,
        # or in a game folder given with --mods, or named directly.
        packages, legacy = [], [game.parent / mods.LEGACY_FOLDER]
        for directory in map(Path, directories):
            if directory.name == mods.LEGACY_FOLDER:
                legacy.append(directory)
                continue
            plugins, found = mods.discover(directory)
            packages.extend((plugins, package) for package in found)
            legacy.append(directory / mods.LEGACY_FOLDER)
        read = set()
        for folder in legacy:
            if folder.is_dir() and folder.resolve() not in read:
                read.add(folder.resolve())
                plugins, found = mods.discover(folder, legacy=True)
                packages.extend((plugins, package) for package in found)
        PRIVATE_PATHS.extend([game.parent, *(Path(directory).resolve() for directory in directories)])
        PRIVATE_PATHS.extend(plugins for plugins, _ in packages)
        counts = {}
        for _, package in packages:
            counts[package.id] = counts.get(package.id, 0) + 1
            if counts[package.id] > 1:
                package.id = f"{package.id}#{counts[package.id]}"

        def issue(package, item_id, name, reason):
            mod_issues.append({"mod": package.id, "id": item_id, "name": name, "reason": reason})

        for _, package in packages:
            if "otherloaderpatched" in package.id.casefold().replace("-", "").replace("_", ""):
                issue(package, None, None, "OtherLoaderPatched is closed source; its duplicate, merge and load-order rules could not be "
                                           "verified, so this extraction follows OtherLoader 1.3.7.")

        # Script assemblies first: bundles name their scripts' assemblies, and
        # inheritance decides what a mod component is.
        scripts = mods.ScriptAssemblies(families)
        owners, hooks = {}, {}
        for _, package in packages:
            for path in package.dlls:
                try:
                    module = dnfile.dnPE(str(path))
                    if module.net is None or not module.net.mdtables.Assembly:
                        continue  # Native library: no scripts.
                    name = str(module.net.mdtables.Assembly[0].Name)
                except Exception as error:  # Third-party file.
                    package.skipped.append((path, f"Unreadable assembly: {failure(error)}"))
                    continue
                if name.casefold() in assets.game_assemblies:
                    package.skipped.append((path, f"Copy of game assembly {name}; the game's own copy is used."))
                    continue
                if name.startswith("MMHOOK_"):
                    package.skipped.append((path, "Generated MonoMod hook assembly; it holds no scripts."))
                    continue
                if name in scripts.assemblies:
                    package.skipped.append((path, f"Assembly {name} is also installed by {owners[name].id}; that copy is read."))
                    continue
                try:
                    scripts.add(module, path)
                    classes, dynamic = scripts.game_hooks(name)
                except Exception as error:  # Malformed third-party metadata.
                    scripts.discard(name)
                    package.skipped.append((path, f"Unreadable assembly metadata: {failure(error)}"))
                    continue
                owners[name] = package
                record = hooks.setdefault(package.id, {"classes": set(), "dynamic": False})
                record["classes"].update(classes)
                record["dynamic"] = record["dynamic"] or dynamic
                try:
                    assets.generator.load_dll(path.read_bytes())
                except Exception as error:  # Embedded type trees still work without it.
                    package.skipped.append((path, f"Script layouts unavailable: {failure(error)}"))
        families.update(scripts.families())
        assets.injected = scripts.injected()
        assets.game_types = {(str(row.TypeNamespace), str(row.TypeName)) for row in pe.net.mdtables.TypeDef}

        def open_package(package):
            env = UnityPy.Environment()
            env.typetree_generator = assets.generator
            bundles = []
            for path in package.bundles:
                try:
                    bundle = env.load_file(str(path))
                except Exception as error:  # Third-party file.
                    package.skipped.append((path, f"Unreadable bundle: {failure(error)}"))
                    continue
                if bundle is not None:
                    bundles.append((path, bundle))
            return env, bundles

        # Pass 1: catalogue items, ammunition display data, accuracy charts and
        # each bundle's contents (to find where every prefab lives).
        offered, displays, charts, contents = {}, [], [], {}
        for _, package in packages:
            if not package.bundles:
                continue
            print(f"Cataloguing mod {package.id}", flush=True)
            env, bundles = open_package(package)
            names = {path for path, _ in bundles}
            assets.embedded = True
            for path, bundle in bundles:
                try:
                    contents[path] = {name.casefold() for item in bundle_objects(bundle) if item.type.name == "AssetBundle"
                                      for name, _ in item.read_typetree()["m_Container"]}
                except Exception as error:  # Third-party data.
                    package.skipped.append((path, f"Unreadable bundle contents: {failure(error)}"))
                if mods.is_late(path, names):
                    continue  # Registered as a prefab source only; the loaders never read it.
                for obj in bundle_objects(bundle):
                    if obj.type.name != "MonoBehaviour":
                        continue
                    try:
                        name = assets.classname(obj)
                        if name == "FVRObject":
                            data = assets.full(obj)
                            if isinstance(data.get("ItemID"), str) and data["ItemID"]:
                                if not isinstance(data.get("DisplayName"), str):
                                    data["DisplayName"] = data["ItemID"]
                                offered.setdefault(data["ItemID"], []).append((package, path, data))
                        elif name == "FVRFireArmRoundDisplayData":
                            data = assets.full(obj)
                            if not isinstance(data["Type"], int) or not isinstance(data["DisplayName"], str):
                                raise ValueError("Round display data without an integer Type and a name")
                            members = []
                            for entry in data.get("Classes", []):
                                # The loader registers the caliber without
                                # resolving its classes, so one unresolvable
                                # (cross-package) class must not drop it.
                                try:
                                    target = deref(obj, entry["ObjectID"])
                                    if target is not None:
                                        members.append(assets.full(target)["ItemID"])
                                except Exception:  # Third-party data.
                                    continue
                            displays.append((package, {"file": obj.assets_file.name, "pathId": str(obj.path_id)}, data, members))
                        elif name == "FVRFireArmMechanicalAccuracyChart":
                            entries = [require_finite({key: entry[key] for key in ("Class", *mods.ACCURACY_FIELDS)})
                                       for entry in assets.full(obj)["Entries"]]
                            charts.append((package, entries))
                    except Exception as error:  # Third-party data.
                        issue(package, None, f"{path.name} object {obj.path_id}", failure(error))
            assets.embedded = False
            del env, bundles
            assets.forget()
            gc.collect()

        def conflict(offers, what):
            providers = sorted({package.id for package, _, _ in offers})
            reason = (f"ItemID is {what} by {', '.join(providers)}; the game keeps whichever loads first, so it is left out."
                      if len(providers) > 1 else
                      f"ItemID is {what} more than once in this package; the loader keeps whichever it reads first, so it is left out.")
            for package, _, data in offers:
                issue(package, item_id, data.get("DisplayName"), reason)

        accepted, conflicts, reused = mods.resolve_items(offered, {item["ItemID"] for item in catalog.values()})
        for item_id, offers in conflicts:
            conflict(offers, "defined differently")
        accepted, races = mods.resolve_definitions(accepted, contents)
        for item_id, offers in races:
            conflict(offers, "defined with its own prefab")
        for package_id, count in sorted(reused.items()):
            mod_issues.append({"mod": package_id, "id": None, "name": None,
                               "reason": f"{count} FVRObject{'s' if count != 1 else ''} reuse base-game ItemIDs (usually copies of referenced game items); the loader keeps the game's items."})

        added, conflicts = mods.resolve_accuracy(charts, {item["id"] for item in accuracy_classes})
        for class_id, owners_of in conflicts:
            for package in owners_of:
                issue(package, None, f"Accuracy class {class_id}", "Defined differently by several mods; the game keeps whichever loads first, so it is left out.")
        for package, item in added:
            accuracy_classes.append({"id": item["Class"], "name": accuracy_names.get(item["Class"], f"Mod class {item['Class']}"),
                                     "minMoa": item["MinMOA"], "maxMoa": item["MaxMOA"], "minDegrees": item["MinDegrees"],
                                     "maxDegrees": item["MaxDegrees"], "dropMult": item["DropMult"], "driftMult": item["DriftMult"],
                                     "mod": package.id})

        game_types = {item["id"] for item in calibers}
        built, declared_rounds = {}, set()
        for package, source, data, members in displays:
            declared_rounds.update(members)
            if data["Type"] in game_types:
                continue
            try:
                built.setdefault(data["Type"], []).append((package, {
                    "id": data["Type"], "name": data["DisplayName"], "enumName": type_names.get(data["Type"]),
                    "barrelCurve": curve(data["VelMultByBarrelLengthCurve"]), "opticDropCurve": curve(data["BulletDropCurve"]),
                    "zeroReferenceClass": class_names.get(data["ZeroWhichAmmo"], f"Class {data['ZeroWhichAmmo']}"),
                    "source": source, "mod": package.id}))
            except Exception as error:  # Third-party data.
                issue(package, None, f"Caliber {data.get('Type')}", failure(error))
                caliber_notes.setdefault(data.get("Type"), f"Caliber {data.get('Type')} has unreadable curves in {package.id}")
        added, conflicts = mods.resolve_calibers(built, game_types)
        for type_id, owners_of in conflicts:
            for package in owners_of:
                issue(package, None, f"Caliber {type_id}", "Defined with different curves by several mods; the game uses whichever loads first, so it is left out.")
            caliber_notes[type_id] = f"Caliber {type_id} is defined with different curves by {', '.join(sorted({item.id for item in owners_of}))}"
        calibers.extend(added)
        for item in added:
            caliber_notes.pop(item["id"], None)

        # Firearms take their caliber from the prefab's FVRFireArm (as the game
        # does at runtime); the catalogue value is only a fallback.
        for item_id, offers in accepted.items():
            package, _, data = offers[0]
            if data.get("Category") == 1:
                weapons[item_id] = {"id": item_id, "name": data.get("DisplayName", item_id), "caliberId": data.get("RoundType"), "chambers": [],
                                    "presetUnavailable": "No standard firearm prefab configuration found.", "mod": package.id}

        # Pass 2: read each package's prefabs, from the bundle Anvil loads them
        # from (see mods.prefab_source).
        by_package = {}
        for item_id, offers in accepted.items():
            for package, path, data in offers:
                by_package.setdefault(package.id, []).append((path, data))
        claimed, owner, records = set(), {}, []
        for plugins, package in packages:
            items = by_package.get(package.id, [])
            if items:
                print(f"Reading mod {package.id}", flush=True)
                env, bundles = open_package(package)
                assets.embedded = True
                index = {}
                for path, data in items:
                    source = mods.prefab_source(path, data.get("m_anvilPrefab") or {}, contents)
                    if source is not None:
                        index.setdefault(source, []).append(data)
                for path, bundle in bundles:
                    def lookup(stem, full, bundle_path=path):
                        found = index.get((bundle_path, full.casefold())) or index.get((bundle_path, stem.casefold())) or []
                        return [data for data in found if data["ItemID"] not in claimed]
                    try:
                        found = read_bundle(list(bundle_objects(bundle)), lookup,
                                            {"bundle": path.relative_to(plugins).as_posix()}, package, scripts)
                    except Exception as error:  # Third-party data.
                        issue(package, None, path.name, failure(error))
                        continue
                    claimed |= found
                    owner.update(dict.fromkeys(found, package))
                assets.embedded = False
                del env, bundles
                assets.forget()
                gc.collect()
            digests = {}
            for path in package.bundles + package.dlls:
                try:
                    digests[path] = mods.digest(path)
                except OSError as error:
                    digests[path] = None
                    package.skipped.append((path, f"Unreadable file: {failure(error)}"))
            package.skipped = list(dict.fromkeys(package.skipped))
            for path, reason in package.skipped:
                # Duplicate or game-owned assemblies lose nothing; anything else may.
                if not reason.startswith(("Copy of game assembly", "Generated MonoMod hook", "Assembly ")):
                    issue(package, None, mods._relative(path, plugins), f"File not read: {reason}")
            record = package.describe(plugins, digests)
            hooked = hooks.get(package.id)
            if hooked and (hooked["classes"] or hooked["dynamic"]):
                classes = sorted(hooked["classes"])
                record["gameHooks"] = {"classes": classes, "unresolvedHarmonyPatches": hooked["dynamic"],
                                       "ballistics": sorted(name for name in classes if BALLISTIC_CLASSES & set(families.get(name, [name])))}
            records.append(record)

        caliber_ids = {item["id"] for item in calibers}
        class_ids = {item["id"] for item in accuracy_classes}
        for item_id, offers in sorted(accepted.items()):
            package, _, data = offers[0]
            package = owner.get(item_id, package)
            if item_id not in claimed and (item_id in weapons or data.get("Category") == 5 or item_id in declared_rounds):
                issue(package, item_id, data.get("DisplayName"),
                      f"No prefab {(data.get('m_anvilPrefab') or {}).get('AssetName')!r} in the item's bundle, its late_ bundle or the bundle it names.")
            if item_id in weapons:
                weapon = weapons[item_id]
                chambered = any(chamber.get("caliberId") in caliber_ids for chamber in weapon.get("chambers", []))
                if not data.get("UsesRoundTypeFlag") and not chambered:
                    # As for the game's own items: a firearm must use rounds.
                    del weapons[item_id]
                    if item_id in claimed:
                        issue(package, item_id, data.get("DisplayName"), "Fires no rounds the calculator knows: no round-type flag and no readable chamber.")
                elif weapon["caliberId"] not in caliber_ids:
                    del weapons[item_id]
                    issue(package, item_id, data.get("DisplayName"), unknown_caliber(weapon["caliberId"]))
                elif isinstance(weapon.get("accuracyClass"), int) and weapon["accuracyClass"] not in class_ids:
                    # Without a chart entry neither dispersion nor device bias is known.
                    weapon["accuracyClassUnavailable"] = weapon.pop("accuracyClass")
                    weapon["accuracyClass"] = None
                    issue(package, item_id, data.get("DisplayName"),
                          f"Accuracy class {weapon['accuracyClassUnavailable']} is not defined by the game or an installed mod; dispersion is incomplete and device bias unavailable.")
            elif item_id in declared_rounds and item_id in claimed and item_id not in seen:
                excluded.append({"id": item_id, "name": data.get("DisplayName", item_id),
                                 "reason": "No FVRFireArmRound on this declared round's prefab", "mod": package.id})
        return records

    for bundle_name in bundle_names:
        path = game / "StreamingAssets" / bundle_name
        print(f"Reading {bundle_name}", flush=True)
        env = assets.load(path)
        read_bundle(list(env.objects), lambda stem, _, bundle=bundle_name: catalog_by_asset.get((bundle, stem.casefold())),
                    {"bundle": bundle_name})
        inputs.append({"file": f"StreamingAssets/{bundle_name}", "sha256": digest(path)})
        del env
        assets.forget()
        gc.collect()
    for item_id, item in declared.items():
        if item_id not in seen:
            excluded.append({"id": item_id, "name": item["DisplayName"], "reason": "No FVRFireArmRound prefab in the declared bundle"})
    mod_records = read_mods(mod_dirs) if mod_dirs else None
    caliber_ids = {item["id"] for item in calibers}
    valid = []
    for item in rounds:
        if item["caliberId"] not in caliber_ids or not (item["mass"] > 0 and item["diameter"] > 0 and item["muzzleVelocity"] > 0):
            if "mod" not in item:
                raise ValueError(f"Missing or invalid physical data: {item['id']}")
            reason = (unknown_caliber(item["caliberId"]) if item["caliberId"] not in caliber_ids
                      else "Missing or invalid physical data (mass, diameter or velocity).")
            excluded.append({"id": item["id"], "name": item["name"], "reason": reason, "mod": item["mod"]})
            continue
        valid.append(item)
    rounds[:] = valid
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
    if mod_records is not None:
        dataset["mods"] = mod_records
        dataset["modIssues"] = sorted(mod_issues, key=lambda item: (item["mod"].casefold(), (item["name"] or "").casefold()))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dataset, separators=(",", ":"), allow_nan=False) + "\n")
    print(f"Extracted {len(rounds)} supported rounds, {len(calibers)} calibers, {len(weapons)} weapon presets, {len(muzzle_devices)} muzzle devices, {len(optics)} optic views, {len(scenes)} scene settings.")
    if mod_records is not None:
        modded = sum("mod" in item for group in (weapons.values(), muzzle_devices, optics, rounds) for item in group)
        print(f"{len(mod_records)} mod packages: {modded} modded entries, {len(mod_issues)} items left out with reasons.")
        for record in mod_records:
            if record.get("gameHooks", {}).get("ballistics"):
                print(f"Warning: {record['id']} patches {', '.join(record['gameHooks']['ballistics'])}; results assume unpatched game code.")
    print(f"{len(excluded)} unavailable rounds have explicit reasons. Wrote {output} ({output.stat().st_size:,} bytes).")


if __name__ == "__main__":
    # Mod folder names need not be valid UTF-8; progress output must not fail on them.
    sys.stdout.reconfigure(errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_install", type=Path, help="Game installation or h3vr_Data directory")
    parser.add_argument("--output", type=Path, default=Path("public/data/h3vr.json"))
    parser.add_argument("--mods", type=Path, action="append", default=[], metavar="DIR",
                        help="Installed mods: a mod-manager profile, a game folder with BepInEx, or BepInEx/plugins. Repeatable.")
    args = parser.parse_args()
    extract(args.game_install, args.output, args.mods)
