"""Installed-mod discovery, OtherLoader registration rules and mod script metadata."""
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from UnityPy.files import SerializedFile

from tools import mods
from tools.extract import Assets, bundle_objects, failure
from tools.prefabs import Prefabs

BUNDLE = b"UnityFS\0\0\0\0\x06" + bytes(32)


def write(path, data=b""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# Rows are told apart by class name, as dnfile's row classes are.
class TypeDefRow(SimpleNamespace):
    pass


class TypeRefRow(SimpleNamespace):
    pass


class AssemblyRefRow(SimpleNamespace):
    pass


class MemberRefRow(SimpleNamespace):
    pass


def ref(row):
    return SimpleNamespace(row=row)


GAME = AssemblyRefRow(Name="Assembly-CSharp")
UNITY = AssemblyRefRow(Name="UnityEngine")


def game_type(name, namespace="FistVR", scope=GAME):
    return TypeRefRow(TypeNamespace=namespace, TypeName=name, ResolutionScope=ref(scope))


class Module:
    """A minimal dnfile-shaped assembly whose method bodies are real CIL."""

    def __init__(self, name, typedefs=(), typerefs=(), memberrefs=(), attributes=()):
        self.code = bytearray(b"\0" * 16)
        self.net = SimpleNamespace(mdtables=SimpleNamespace(
            Assembly=[SimpleNamespace(Name=name)], TypeDef=list(typedefs), TypeRef=list(typerefs),
            MemberRef=list(memberrefs), CustomAttribute=list(attributes), AssemblyRef=[GAME, UNITY]))

    @property
    def __data__(self):
        return bytes(self.code)

    def get_offset_from_rva(self, rva):
        return rva

    def method(self, name, *instructions):
        body = b"".join(instructions) + b"\x2a"  # ret
        rva = len(self.code)
        self.code += bytes([(len(body) << 2) | 0x2]) + body  # Tiny header.
        return SimpleNamespace(Name=name, Rva=rva)

    def typedef(self, namespace, name, base, *methods):
        row = TypeDefRow(TypeNamespace=namespace, TypeName=name, Extends=ref(base),
                         MethodList=[SimpleNamespace(row=method) for method in methods])
        self.net.mdtables.TypeDef.append(row)
        return row

    def member(self, owner, name):
        self.net.mdtables.MemberRef.append(MemberRefRow(Name=name, Class=ref(owner)))
        return 0x0A000000 | len(self.net.mdtables.MemberRef)


def call(token):
    return b"\x28" + struct.pack("<I", token)


def float32(value):
    return b"\x22" + struct.pack("<f", value)


GAME_FAMILIES = {"ClosedBoltWeapon": ["ClosedBoltWeapon", "FVRFireArm", "FVRPhysicalObject"],
                 "FVRFireArm": ["FVRFireArm", "FVRPhysicalObject"],
                 "Suppressor": ["Suppressor", "MuzzleDevice", "FVRFireArmAttachment"],
                 "BallisticProjectile": ["BallisticProjectile"]}


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root))

    def test_profile_packages_are_grouped_by_manifest_and_classified_by_content(self):
        plugins = self.root / "profile" / "BepInEx" / "plugins"
        gun = plugins / "Acme-Super_Rifles"
        write(gun / "manifest.json", json.dumps({"name": "Super_Rifles", "version_number": "1.2.0",
                                                 "website_url": "https://example.invalid", "dependencies": ["x-y-1.0.0"]}).encode())
        write(gun / "superrifles", BUNDLE)
        write(gun / "late_superrifles", BUNDLE)
        write(gun / "superrifles.manifest", b"ManifestFileVersion: 0\n")
        write(gun / "Super_Rifles.dll", b"MZ" + bytes(64))
        write(gun / "nested" / "extra.bundle", BUNDLE)
        write(gun / "icon.png", b"\x89PNG")
        write(plugins / "LooseFolder" / "data" / "pack", BUNDLE)
        write(plugins / "loose_bundle", BUNDLE)
        write(plugins / "Old-Mod" / "old.deli", b"PK\x03\x04" + bytes(20))
        write(plugins / "Empty" / "readme.txt", b"hello")

        root, packages = mods.discover(self.root / "profile")
        self.assertEqual(root, plugins)
        by_id = {package.id: package for package in packages}
        # Loose files in plugins form one package, keeping late_ pairs together.
        self.assertEqual(sorted(by_id), ["Acme-Super_Rifles", "LooseFolder", "Old-Mod", "plugins"])
        rifles = by_id["Acme-Super_Rifles"]
        self.assertEqual((rifles.name, rifles.version, rifles.author), ("Super Rifles", "1.2.0", "Acme"))
        self.assertEqual(rifles.dependencies, ["x-y-1.0.0"])
        self.assertEqual([path.name for path in rifles.bundles], ["late_superrifles", "superrifles", "extra.bundle"])
        self.assertEqual([path.name for path in rifles.dlls], ["Super_Rifles.dll"])
        self.assertEqual([path.name for path in by_id["LooseFolder"].bundles], ["pack"])
        self.assertEqual(by_id["Old-Mod"].bundles, [])
        self.assertIn("Packed mod archive", by_id["Old-Mod"].skipped[0][1])
        record = rifles.describe(root, {path: "digest" for path in rifles.bundles + rifles.dlls})
        self.assertIn({"file": "Acme-Super_Rifles/superrifles", "kind": "bundle", "sha256": "digest"}, record["files"])
        self.assertNotIn("skipped", record)

    def test_mods_disabled_by_the_mod_manager_are_ignored(self):
        plugins = self.root / "plugins"
        write(plugins / "Off-Gun" / "manifest.json.old", b"{}")
        write(plugins / "Off-Gun" / "gun.old", BUNDLE)
        write(plugins / "Off-Gun" / "Gun.dll.old", b"MZ" + bytes(64))
        write(plugins / "On-Gun" / "gun", BUNDLE)
        self.assertEqual([package.id for package in mods.discover(plugins)[1]], ["On-Gun"])

    def test_plugins_folder_and_game_folder_are_both_accepted(self):
        plugins = self.root / "game" / "BepInEx" / "plugins"
        write(plugins / "A-B" / "bundle", BUNDLE)
        self.assertEqual(mods.discover(self.root / "game")[0], plugins)
        self.assertEqual(mods.discover(plugins)[0], plugins)
        self.assertEqual(mods.discover(self.root / "game" / "BepInEx")[0], plugins)
        with self.assertRaises(ValueError):
            mods.discover(self.root / "missing")

    def test_legacy_folders_load_only_extensionless_files(self):
        plugins = self.root / "plugins"
        write(plugins / "Pack" / "LegacyVirtualObjects" / "gun", BUNDLE)
        write(plugins / "Pack" / "LegacyVirtualObjects" / "gun.bak", BUNDLE)
        write(plugins / "Pack" / "other.bundle", BUNDLE)
        _, packages = mods.discover(plugins)
        self.assertEqual([path.name for path in packages[0].bundles], ["other.bundle", "gun"])
        legacy = self.root / "LegacyVirtualObjects"
        write(legacy / "old", BUNDLE)
        write(legacy / "old.txt", BUNDLE)
        root, packages = mods.discover(legacy, legacy=True)
        self.assertEqual(root, legacy)
        self.assertEqual([path.name for package in packages for path in package.bundles], ["old"])

    def test_monomod_libraries_join_their_plugins_package(self):
        bepinex = self.root / "profile" / "BepInEx"
        write(bepinex / "plugins" / "Andrew-AFCL" / "AFCL.dll", b"MZ" + bytes(64))
        write(bepinex / "monomod" / "Andrew-AFCL" / "Assembly-CSharp.AFCL.mm.dll", b"MZ" + bytes(64))
        write(bepinex / "monomod" / "Andrew-AFCL" / "notes.dll", b"MZ" + bytes(64))
        write(bepinex / "monomod" / "Solo-Lib" / "Assembly-CSharp.Solo.mm.dll", b"MZ" + bytes(64))
        root, packages = mods.discover(self.root / "profile")
        by_id = {package.id: package for package in packages}
        self.assertEqual(sorted(by_id), ["../monomod/Solo-Lib", "Andrew-AFCL"])
        self.assertEqual([path.name for path in by_id["Andrew-AFCL"].dlls], ["AFCL.dll", "Assembly-CSharp.AFCL.mm.dll"])
        record = by_id["../monomod/Solo-Lib"].describe(root, {path: None for path in by_id["../monomod/Solo-Lib"].dlls})
        self.assertEqual(record["files"][0]["file"], "../monomod/Solo-Lib/Assembly-CSharp.Solo.mm.dll")
        self.assertEqual(mods._relative(Path("/elsewhere/secret.dll"), root), "secret.dll")

    @unittest.skipUnless(hasattr(os, "symlink"), "Symbolic links unsupported")
    def test_symbolic_links_are_not_followed(self):
        outside = write(self.root / "outside" / "secret", BUNDLE)
        plugins = self.root / "plugins"
        (plugins / "Linked").mkdir(parents=True)
        os.symlink(outside, plugins / "Linked" / "bundle")
        os.symlink(outside.parent, plugins / "Folder")
        self.assertEqual(mods.discover(plugins)[1], [])


def package(name):
    return SimpleNamespace(id=name)


def fvrobject(item_id, name="Rifle", asset="Assets/Guns/Rifle.prefab", **fields):
    return {"ItemID": item_id, "DisplayName": name, "Category": 1, "RoundType": 13, "UsesRoundTypeFlag": 1,
            "m_anvilPrefab": {"Bundle": "", "AssetName": asset}, **fields}


class RegistrationTests(unittest.TestCase):
    def test_game_items_win_and_identical_copies_are_one_item(self):
        a, b = package("A"), package("B")
        offered = {
            "AK47": [(a, Path("a"), fvrobject("AK47"))],
            "ModRifle": [(a, Path("a"), fvrobject("ModRifle")), (b, Path("b"), fvrobject("ModRifle"))],
            "Clash": [(a, Path("a"), fvrobject("Clash", name="One")), (b, Path("b"), fvrobject("Clash", name="Two"))],
        }
        accepted, conflicts, reused = mods.resolve_items(offered, {"AK47"})
        self.assertEqual(list(accepted), ["ModRifle"])
        self.assertEqual(len(accepted["ModRifle"]), 2)
        self.assertEqual([item_id for item_id, _ in conflicts], ["Clash"])
        self.assertEqual(reused, {"A": 1})

    def test_accuracy_classes_keep_game_entries_and_reject_differing_mod_entries(self):
        def entry(class_id, drop):
            return {"Class": class_id, "MinMOA": 1, "MaxMOA": 1, "MinDegrees": 0.1, "MaxDegrees": 0.1, "DropMult": drop, "DriftMult": 2}
        a, b = package("A"), package("B")
        added, conflicts = mods.resolve_accuracy(
            [(a, [entry(41, 9), entry(500, 1.5), entry(600, 1)]), (b, [entry(500, 1.5), entry(600, 2)])], {41})
        self.assertEqual([(owner.id, item["Class"]) for owner, item in added], [("A", 500)])
        self.assertEqual([(class_id, [owner.id for owner in owners]) for class_id, owners in conflicts], [(600, ["A", "B"])])

    def test_new_calibers_take_one_curve_and_conflicting_curves_are_left_out(self):
        def caliber(owner, value):
            return (owner, {"id": 0, "barrelCurve": {"keys": [value]}, "opticDropCurve": {"keys": []}, "mod": owner.id})
        a, b = package("A"), package("B")
        added, conflicts = mods.resolve_calibers(
            {-32011: [caliber(a, 1), caliber(b, 1)], -5: [caliber(a, 1), caliber(b, 2)], 13: [caliber(a, 3)]}, {13})
        self.assertEqual([item["mod"] for item in added], ["A"])
        self.assertEqual([type_id for type_id, _ in conflicts], [-5])

    def test_prefab_comes_from_the_late_partner_when_present_else_the_own_bundle(self):
        folder = Path("/plugins/Acme-Rifles")
        data, late_data, solo = folder / "rifles", folder / "late_rifles", folder / "pistols"
        contents = {late_data: {"assets/guns/rifle.prefab"}, data: {"assets/other.prefab"}, solo: {"assets/guns/pistol.prefab"}}
        anvil = {"AssetName": "Assets/Guns/Rifle.prefab", "Bundle": "ignored"}
        self.assertEqual(mods.prefab_source(data, anvil, contents), (late_data, "assets/guns/rifle.prefab"))
        self.assertEqual(mods.prefab_source(data, {"AssetName": "rifle"}, contents), (late_data, "rifle"))
        # The late partner replaces the data bundle entirely, as in the game.
        self.assertIsNone(mods.prefab_source(data, {"AssetName": "Assets/Other.prefab"}, contents))
        self.assertEqual(mods.prefab_source(solo, {"AssetName": "Assets/Guns/Pistol.prefab"}, contents), (solo, "assets/guns/pistol.prefab"))
        self.assertIsNone(mods.prefab_source(solo, {"AssetName": "Missing"}, contents))
        self.assertIsNone(mods.prefab_source(solo, {"AssetName": ""}, contents))

    def test_late_pairing_follows_the_loaders_name_rebuild(self):
        folder = Path("/plugins/Acme")
        names = [folder / "rifles", folder / "late_rifles", folder / "plate_carrier", folder / "late_plate_carrier", folder / "late_orphan"]
        self.assertTrue(mods.is_late(folder / "late_rifles", names))
        self.assertFalse(mods.is_late(folder / "late_orphan", names), "No data bundle: read as data")
        # Replace("late_", "") turns late_plate_carrier into "pcarrier", so it never pairs.
        self.assertIsNone(mods.late_partner(folder / "plate_carrier"))
        self.assertFalse(mods.is_late(folder / "late_plate_carrier", names))
        contents = {folder / "late_plate_carrier": {"assets/vest.prefab"}, folder / "plate_carrier": set()}
        self.assertIsNone(mods.prefab_source(folder / "plate_carrier", {"AssetName": "Assets/Vest.prefab"}, contents))

    def test_legacy_folders_never_pair_late_bundles(self):
        legacy = Path("/game/LegacyVirtualObjects")
        names = [legacy / "gun", legacy / "late_gun"]
        self.assertFalse(mods.is_late(legacy / "late_gun", names))
        contents = {legacy / "late_gun": {"assets/gun.prefab"}, legacy / "gun": {"assets/gun.prefab"}}
        self.assertEqual(mods.prefab_source(legacy / "gun", {"AssetName": "Assets/Gun.prefab"}, contents)[0], legacy / "gun")

    def test_sodalite_preload_items_name_their_prefab_bundle(self):
        folder = Path("/plugins/Acme-Rifles")
        preload, prefabs = folder / "rifles_preload", folder / "sub" / "prefabs"
        contents = {preload: set(), prefabs: {"assets/guns/preloaded.prefab"}}
        named = {"AssetName": "Assets/Guns/Preloaded.prefab", "Bundle": "sub\\prefabs"}
        self.assertEqual(mods.prefab_source(preload, named, contents), (prefabs, "assets/guns/preloaded.prefab"))
        self.assertIsNone(mods.prefab_source(preload, {"AssetName": "Assets/Guns/Preloaded.prefab"}, contents))

    def test_two_packages_each_defining_an_item_race(self):
        a, b, c = package("A"), package("B"), package("C")
        own, copy = {"AssetName": "Assets/Gun.prefab"}, {"AssetName": "Assets/Gun.prefab"}
        contents = {Path("/A/gun"): {"assets/gun.prefab"}, Path("/B/gun"): {"assets/gun.prefab"}, Path("/C/attachments"): set()}
        accepted = {
            "Raced": [(a, Path("/A/gun"), {"m_anvilPrefab": own}), (b, Path("/B/gun"), {"m_anvilPrefab": own})],
            "Copied": [(a, Path("/A/gun"), {"m_anvilPrefab": own}), (c, Path("/C/attachments"), {"m_anvilPrefab": copy})],
            "Orphan": [(c, Path("/C/attachments"), {"m_anvilPrefab": {"AssetName": "Assets/None.prefab"}})],
        }
        result, races = mods.resolve_definitions(accepted, contents)
        self.assertEqual([item_id for item_id, _ in races], ["Raced"])
        self.assertEqual([offer[0].id for offer in result["Copied"]], ["A"])
        self.assertEqual([offer[0].id for offer in result["Orphan"]], ["C"])


class ScriptAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.scripts = mods.ScriptAssemblies(GAME_FAMILIES)
        self.module = Module("ModGuns")
        self.base = self.module.typedef("Acme", "RifleBase", game_type("ClosedBoltWeapon"))
        self.module.typedef("Acme", "SuperRifle", self.base)
        self.module.typedef("Acme", "Widget", game_type("MonoBehaviour", "UnityEngine", UNITY))
        self.module.typedef("Acme", "Bridge", TypeRefRow(TypeNamespace="Other", TypeName="Thing", ResolutionScope=ref(AssemblyRefRow(Name="Missing"))))
        self.scripts.add(self.module, Path("ModGuns.dll"))

    def test_mod_classes_inherit_the_game_chain(self):
        self.assertEqual(mods.script_key("ModGuns.dll", "Acme", "SuperRifle"), "ModGuns:Acme.SuperRifle")
        self.assertEqual(self.scripts.chain("ModGuns:Acme.SuperRifle"),
                         ["ModGuns:Acme.SuperRifle", "ModGuns:Acme.RifleBase", "ClosedBoltWeapon", "FVRFireArm", "FVRPhysicalObject"])
        # Bases outside the game assembly and the installed mods end the chain unresolved.
        self.assertEqual(self.scripts.chain("ModGuns:Acme.Widget"), ["ModGuns:Acme.Widget", "UnityEngine:UnityEngine.MonoBehaviour"])
        self.assertEqual(self.scripts.chain("ModGuns:Acme.Bridge"), ["ModGuns:Acme.Bridge", "Missing:Other.Thing"])
        self.assertIn("ModGuns:Acme.SuperRifle", self.scripts.families())
        # dnfile resolves a null base index to the table's last row.
        orphan = TypeDefRow(TypeNamespace="", TypeName="<Module>", Extends=SimpleNamespace(row_index=0, row=self.base), MethodList=[])
        module = Module("Orphans", typedefs=[orphan])
        scripts = mods.ScriptAssemblies(GAME_FAMILIES)
        scripts.add(module)
        self.assertEqual(scripts.chain("Orphans:<Module>"), ["Orphans:<Module>"])
        with self.assertRaises(ValueError):
            self.scripts.add(Module("ModGuns"))

    def test_hooks_are_found_from_monomod_types_harmony_attributes_and_manual_patches(self):
        harmony = TypeRefRow(TypeNamespace="HarmonyLib", TypeName="HarmonyPatch", ResolutionScope=ref(AssemblyRefRow(Name="0Harmony")))
        ctor = MemberRefRow(Name=".ctor", Class=ref(harmony))
        blob = b"\x01\x00\x34FistVR.BallisticProjectile, Assembly-CSharp, Version=0.0.0.0\x04Fire\x00\x00"
        module = Module("Patcher", typerefs=[TypeRefRow(TypeNamespace="On.FistVR", TypeName="AM")],
                        attributes=[SimpleNamespace(Type=ref(ctor), Value=SimpleNamespace(value=blob))])
        manual = TypeRefRow(TypeNamespace="HarmonyLib", TypeName="Harmony", ResolutionScope=ref(AssemblyRefRow(Name="0Harmony")))
        module.member(manual, "Patch")
        self.scripts.add(module)
        self.assertEqual(self.scripts.game_hooks("Patcher"), (["AM", "BallisticProjectile"], True))
        injector = Module("Assembly-CSharp.Wind.mm")
        injector.typedef("FistVR", "patch_BallisticProjectile", game_type("BallisticProjectile"))
        injector.typedef("Plugin.src", "AutoBolt", game_type("FVRFireArm"))
        self.scripts.add(injector)
        self.assertEqual(self.scripts.game_hooks("Assembly-CSharp.Wind.mm"), (["BallisticProjectile"], False))
        self.assertEqual(self.scripts.injected(), {("Plugin.src", "AutoBolt"): "Assembly-CSharp.Wind.mm:Plugin.src.AutoBolt"})
        self.assertEqual(self.scripts.chain("Assembly-CSharp.Wind.mm:Plugin.src.AutoBolt"),
                         ["Assembly-CSharp.Wind.mm:Plugin.src.AutoBolt", "FVRFireArm", "FVRPhysicalObject"])
        self.assertEqual(self.scripts.game_hooks("ModGuns"), ([], False))


class ModShotRuleTests(unittest.TestCase):
    """Mod firearm classes are read from their own assembly, never assumed."""

    def setUp(self):
        game = Module("Assembly-CSharp")
        fire_token = 0x06000099
        game_fire = game.method("Fire", float32(1), float32(1), call(fire_token))
        game_types = {"ClosedBoltWeapon": SimpleNamespace(MethodList=[SimpleNamespace(row=game_fire)])}
        self.scripts = mods.ScriptAssemblies(GAME_FAMILIES)
        families = dict(GAME_FAMILIES)
        mod = Module("ModGuns")
        base = game_type("ClosedBoltWeapon")
        game_base_fire = mod.member(base, "Fire")
        firearm_fire = mod.member(game_type("FVRFireArm"), "Fire")
        mod.typedef("Acme", "Plain", base, mod.method("FVRUpdate"))
        mod.typedef("Acme", "Replaces", base, mod.method("Fire"))
        mod.typedef("Acme", "Extends", base, mod.method("Fire", call(game_base_fire)))
        mod.typedef("Acme", "Own", base, mod.method("Shoot", float32(2.5), float32(2.5), call(firearm_fire)))
        self.scripts.add(mod)
        families.update(self.scripts.families())
        families["Ghost:Acme.Missing"] = ["Ghost:Acme.Missing", "ClosedBoltWeapon", "FVRFireArm"]
        self.reader = Prefabs.__new__(Prefabs)
        self.reader.pe, self.reader.types, self.reader.families = game, game_types, families
        self.reader.fire_token, self.reader.shot_cache, self.reader.scripts = fire_token, {}, self.scripts

    def rule(self, name):
        return self.reader.shot_rule(name, {"UsesStickyDetonation": False})

    def test_unrelated_overrides_keep_the_game_rule(self):
        rule = self.rule("ModGuns:Acme.Plain")
        self.assertEqual((rule["kind"], rule["value"], rule["source"]["class"]), ("constant", 1, "ClosedBoltWeapon"))

    def test_override_calling_the_game_method_keeps_the_game_rule(self):
        self.assertEqual(self.rule("ModGuns:Acme.Extends")["kind"], "constant")

    def test_replacing_the_firing_method_requires_manual_input(self):
        rule = self.rule("ModGuns:Acme.Replaces")
        self.assertEqual(rule["kind"], "manual")
        self.assertIn("ModGuns:Acme.Replaces redefines Fire", rule["reason"])

    def test_mod_class_firing_directly_is_read_from_its_own_il(self):
        rule = self.rule("ModGuns:Acme.Own")
        self.assertEqual((rule["kind"], rule["value"], rule["source"]["class"]), ("constant", 2.5, "ModGuns:Acme.Own"))

    def test_unreadable_mod_class_requires_manual_input(self):
        rule = self.rule("Ghost:Acme.Missing")
        self.assertEqual(rule["kind"], "manual")
        self.assertIn("not in a readable installed assembly", rule["reason"])


class ScriptIdentityTests(unittest.TestCase):
    file = object()

    def assets(self):
        assets = Assets.__new__(Assets)
        assets.game_assemblies, assets.classes, assets.embedded = {"assembly-csharp", "unityengine"}, {}, False
        assets.injected, assets.game_types = {}, {("FistVR", "FVRObject"), ("FistVR", "AM")}
        return assets

    def behaviour(self, assembly, namespace, name, path_id=1):
        script = SimpleNamespace(m_PathID=path_id, m_FileID=0, deref_parse_as_object=lambda: SimpleNamespace(
            m_AssemblyName=assembly, m_Namespace=namespace, m_ClassName=name))
        return SimpleNamespace(type=SimpleNamespace(name="MonoBehaviour"), assets_file=self.file,
                               parse_monobehaviour_head=lambda: SimpleNamespace(m_Script=script))

    def test_game_classes_keep_bare_names_and_mod_classes_are_qualified(self):
        assets = self.assets()
        self.assertEqual(assets.classname(self.behaviour("Assembly-CSharp.dll", "FistVR", "FVRObject", 1)), "FVRObject")
        self.assertEqual(assets.classname(self.behaviour("", "FistVR", "AM", 2)), "AM")
        self.assertEqual(assets.classname(self.behaviour("OpenScripts2.dll", "OpenScripts2", "Suppressor", 3)), "OpenScripts2:OpenScripts2.Suppressor")
        self.assertEqual(assets.classname(self.behaviour("ModGuns.dll", "", "BallisticProjectile", 4)), "ModGuns:BallisticProjectile")
        self.assertEqual(assets.classname(self.behaviour("H3VRCode-CSharp.dll", "FistVR", "AM", 5)), "AM")

    def test_monomod_injected_classes_resolve_to_their_patch_assembly(self):
        assets = self.assets()
        assets.injected = {("Plugin.src", "AutoBolt"): "Assembly-CSharp.FTWScripts.mm:Plugin.src.AutoBolt",
                           ("FistVR", "FVRObject"): "Assembly-CSharp.Bad.mm:FistVR.FVRObject"}
        self.assertEqual(assets.classname(self.behaviour("Assembly-CSharp.dll", "Plugin.src", "AutoBolt", 6)),
                         "Assembly-CSharp.FTWScripts.mm:Plugin.src.AutoBolt")
        # A class the game itself defines is never reassigned.
        self.assertEqual(assets.classname(self.behaviour("Assembly-CSharp.dll", "FistVR", "FVRObject", 7)), "FVRObject")

    def test_embedded_layouts_are_used_only_for_mod_content(self):
        assets = self.assets()
        assets.generator = SimpleNamespace(get_nodes_up=lambda *_: (_ for _ in ()).throw(LookupError("generated layout")))
        script = SimpleNamespace(m_Namespace="Acme", m_ClassName="Rifle", m_AssemblyName="ModGuns.dll")
        obj = SimpleNamespace(type=SimpleNamespace(name="MonoBehaviour"), serialized_type=SimpleNamespace(node=object()),
                              read_typetree=lambda nodes=None: {"embedded": nodes is None},
                              parse_monobehaviour_head=lambda: SimpleNamespace(m_Script=SimpleNamespace(deref_parse_as_object=lambda: script)))
        with self.assertRaisesRegex(LookupError, "generated layout"):
            assets.full(obj)  # Game data keeps the verified generated layouts.
        assets.embedded = True
        self.assertEqual(assets.full(obj), {"embedded": True})

    def test_bundle_objects_walks_nested_serialized_files_and_failures_name_fields(self):
        serialized = SerializedFile.__new__(SerializedFile)
        serialized.objects = {1: "first", 2: "second"}
        bundle = SimpleNamespace(files={"CAB": serialized, "resource": SimpleNamespace(files=None)})
        self.assertEqual(list(bundle_objects(SimpleNamespace(files={"inner": bundle}))), ["first", "second"])
        self.assertIn("'AccuracyClass'", failure(KeyError("AccuracyClass")))
        self.assertEqual(failure(ValueError("bad")), "ValueError: bad")


if __name__ == "__main__":
    unittest.main()
