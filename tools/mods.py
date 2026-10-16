"""Discover installed H3VR mod packages: Unity bundles, script DLLs and manifests.

Nothing here is tied to a particular mod. A directory is scanned recursively
and files are classified by content, because mod bundles are commonly shipped
without an extension (or with arbitrary ones). Discovery never executes or
imports anything it finds.
"""
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path

from dncil.cil.body import CilMethodBody
from dncil.cil.body.reader import CilMethodBodyReaderBytes

# Unity bundle signatures. Unity 5.6 writes UnityFS; the older streamed formats
# are recognised so they can be reported rather than silently ignored.
BUNDLE_MAGIC = (b"UnityFS\0", b"UnityWeb\0", b"UnityRaw\0", b"UnityArchive\0")
ZIP_MAGIC = b"PK\x03\x04"
# A .NET assembly is a PE image; the CLR header is checked when it is parsed.
PE_MAGIC = b"MZ"
LEGACY_FOLDER = "LegacyVirtualObjects"
MANIFEST_LIMIT = 1 << 20  # Thunderstore manifests are a few hundred bytes.
# r2modman/Thunderstore install folders are named Author-Package.
_THUNDERSTORE_FOLDER = re.compile(r"^(?P<author>[^-]+)-(?P<name>.+)$")


@dataclass
class ModPackage:
    id: str
    path: Path
    name: str
    version: str | None = None
    author: str | None = None
    website: str | None = None
    dependencies: list = field(default_factory=list)
    bundles: list = field(default_factory=list)
    dlls: list = field(default_factory=list)
    skipped: list = field(default_factory=list)

    def describe(self, root, digests):
        files = [{"file": _relative(path, root), "kind": kind, "sha256": digests.get(path)}
                 for kind, paths in (("bundle", self.bundles), ("assembly", self.dlls)) for path in paths]
        result = {"id": self.id, "name": self.name, "version": self.version, "author": self.author,
                  "website": self.website, "dependencies": self.dependencies, "files": files}
        if self.skipped:
            result["skipped"] = [{"file": _relative(path, root), "reason": reason} for path, reason in dict.fromkeys(self.skipped)]
        return result


def _relative(path, root):
    """PATH relative to the plugins folder; BepInEx/monomod files as ../monomod/…

    Never an absolute path, which would publish the user's folder layout.
    """
    for base, prefix in ((root, ""), (root.parent, "../")):
        try:
            return prefix + path.relative_to(base).as_posix()
        except ValueError:
            continue
    return path.name


def plugins_root(path):
    """Accept a mod-manager profile, a game install or BepInEx/plugins itself."""
    path = Path(path)
    for candidate in (path / "BepInEx" / "plugins", path / "plugins"):
        if candidate.is_dir():
            return candidate
    if not path.is_dir():
        raise ValueError(f"Mod directory not found: {path}")
    return path


def classify(path):
    """Return 'bundle', 'assembly', 'archive' or None from the file's content."""
    try:
        with path.open("rb") as file:
            head = file.read(16)
    except OSError:
        return None
    if any(head.startswith(magic) for magic in BUNDLE_MAGIC):
        return "bundle"
    if head.startswith(PE_MAGIC) and path.suffix.casefold() == ".dll":
        return "assembly"
    if head.startswith(ZIP_MAGIC):
        return "archive"
    return None


def _manifest(folder):
    """FOLDER's manifest.json when it is a regular file, not a link."""
    path = folder / "manifest.json"
    try:
        return path if not path.is_symlink() and path.is_file() else None
    except OSError:
        return None


def read_manifest(path):
    """A manifest's fields, or {} for anything that is not a small JSON object.

    Links and special files are refused, so a manifest cannot pull content
    from outside the folder or block on a pipe.
    """
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(descriptor, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                return {}
            text = file.read(MANIFEST_LIMIT + 1)
        if len(text) > MANIFEST_LIMIT:
            return {}
        data = json.loads(text.decode("utf-8-sig"))
    except (OSError, ValueError, RecursionError):
        return {}
    return data if isinstance(data, dict) else {}


def _string(value):
    return value if isinstance(value, str) and value.strip() else None


def _package(root, folder, files):
    relative = _relative(folder, root) if folder != root else folder.name
    found = _manifest(folder) if folder.is_dir() else None
    manifest = read_manifest(found) if found else {}
    match = _THUNDERSTORE_FOLDER.match(folder.name)
    name = _string(manifest.get("name")) or (match["name"] if match else None) or folder.stem
    author = _string(manifest.get("author")) or (match["author"] if match else None)
    listed = manifest.get("dependencies")
    dependencies = [item for item in listed if isinstance(item, str)] if isinstance(listed, list) else []
    package = ModPackage(id=relative, path=folder, name=name.replace("_", " "),
                         version=_string(manifest.get("version_number")) or _string(manifest.get("version")),
                         author=author, website=_string(manifest.get("website_url")), dependencies=dependencies)
    for path in files:
        kind = classify(path)
        if kind == "bundle":
            package.bundles.append(path)
        elif kind == "assembly":
            package.dlls.append(path)
        elif kind == "archive" and path.suffix.casefold() in (".deli", ".zip", ".h3mod", ".hotmod"):
            package.skipped.append((path, "Packed mod archive; extract it or install it through a mod manager first."))
    return package


def _files(root, legacy=False):
    """Regular files under ROOT, grouped by the package folder that owns them.

    Returns (groups, problems): problems maps a package folder to the
    [(path, reason)] of files or folders that could not be read.
    """
    groups, problems = {}, {}

    def owner_of(path, folder=False):
        here = path if folder else path.parent
        owner = next((parent for parent in [here, *here.parents]
                      if parent != root and root in parent.parents and _manifest(parent)), None)
        if owner is None:
            # Loose files in the root form one package, so a data bundle and
            # its late_ partner in one directory are always read together.
            owner = root if not folder and path.parent == root else root / path.relative_to(root).parts[0]
        return owner

    def unreadable(error):
        path = Path(error.filename) if error.filename else root
        if path != root and root in path.parents:
            problems.setdefault(owner_of(path, folder=True), []).append((path, f"Folder could not be read: {error.strerror}."))

    for directory, folders, names in os.walk(root, onerror=unreadable, followlinks=False):
        folders.sort()
        here = Path(directory)
        in_legacy = legacy or LEGACY_FOLDER in here.relative_to(root).parts
        for name in sorted(names):
            file = here / name
            try:
                # Mod managers disable a mod by renaming its files to *.old.
                if file.is_symlink() or not file.is_file() or (in_legacy and file.suffix) or name.casefold().endswith(".old"):
                    continue
                owner = owner_of(file)
            except OSError as error:
                problems.setdefault(root / file.relative_to(root).parts[0] if here != root else root, []).append(
                    (file, f"File could not be read: {error.strerror}."))
                continue
            groups.setdefault(owner, []).append(file)
    return groups, problems


def discover(path, legacy=False):
    """Group every bundle and assembly under the plugins folder into packages.

    A package is the nearest folder holding a Thunderstore manifest.json; files
    outside any such folder belong to their top-level folder, and loose files
    directly in the plugins folder form one package. Symbolic links are not
    followed, so a profile cannot pull in files from elsewhere.

    MonoMod script libraries (Assembly-CSharp.<Name>.mm.dll) are installed in
    BepInEx/monomod; they join the plugins package of the same folder name.
    OtherLoader loads only extension-less files from LegacyVirtualObjects
    folders; LEGACY marks PATH itself as such a folder.
    """
    root = Path(path) if legacy else plugins_root(path)
    groups, problems = _files(root, legacy)
    packages = {folder: _package(root, folder, files) for folder, files in sorted(groups.items())}
    for folder, entries in problems.items():
        packages.setdefault(folder, _package(root, folder, [])).skipped.extend(entries)
    monomod = root.parent / "monomod"
    if not legacy and root.name.casefold() == "plugins" and root.parent.name.casefold() == "bepinex" and monomod.is_dir():
        by_name = {folder.name: package for folder, package in packages.items()}
        for folder, files in sorted(_files(monomod)[0].items()):
            patches = [file for file in files if file.name.casefold().endswith(".mm.dll") and classify(file) == "assembly"]
            if not patches:
                continue
            package = by_name.get(folder.name)
            if package is None:
                package = packages[folder] = _package(monomod, folder, [])
                package.id = f"../monomod/{package.id}"
            package.dlls.extend(patches)
    found = [item for item in packages.values() if item.bundles or item.dlls or item.skipped]
    return root, sorted(found, key=lambda item: item.id)


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def assembly_stem(name):
    return name[:-4] if name.casefold().endswith(".dll") else name


def script_key(assembly, namespace, name):
    """Identity for a script class outside the verified game assembly.

    Game classes keep their bare names, which every existing rule compares
    against. Qualifying mod classes stops a mod's own `Suppressor` or
    `BallisticProjectile` from being mistaken for the game's class.
    """
    return f"{assembly_stem(assembly)}:{namespace}.{name}" if namespace else f"{assembly_stem(assembly)}:{name}"


def _row_kind(row):
    return type(row).__name__


def _target(coded):
    """The row a metadata coded index points at, or None for a null index.

    dnfile resolves a null (zero) index to the table's last row, so a type
    with no base class would otherwise appear to inherit from that row.
    """
    if coded is None or getattr(coded, "row_index", None) == 0:
        return None
    return coded.row


class ScriptAssemblies:
    """Inheritance and method metadata for classes in mod DLLs.

    Each mod class's chain is its own qualified key, then any mod ancestors,
    then the game's FistVR chain from the verified assembly. A base class from
    an assembly that is not installed ends the chain at that unresolved key.
    """

    def __init__(self, game_families, game_assembly="Assembly-CSharp"):
        self.game_families = game_families
        self.game_assembly = game_assembly
        self.types = {}
        self.assemblies = {}
        self._families = {}

    def add(self, pe, path=None):
        tables = pe.net.mdtables if pe.net is not None else None
        if tables is None or not tables.Assembly:
            raise ValueError("Not a .NET assembly")
        name = str(tables.Assembly[0].Name)
        if name in self.assemblies:
            raise ValueError(f"Duplicate assembly name {name}")
        rows = [(script_key(name, str(row.TypeNamespace), str(row.TypeName)), row) for row in tables.TypeDef or []]
        self.assemblies[name] = {"pe": pe, "path": path}
        for key, row in rows:
            self.types.setdefault(key, {"assembly": name, "pe": pe, "row": row})
        self._families.clear()
        return name

    def discard(self, name):
        """Forget assembly NAME, e.g. when its metadata turned out unreadable."""
        entry = self.assemblies.pop(name, None)
        if entry is not None:
            for key in [key for key, item in self.types.items() if item["pe"] is entry["pe"]]:
                del self.types[key]
            self._families.clear()

    def injected(self):
        """Classes MonoMod script libraries add to the game assembly.

        Bundles name such classes as Assembly-CSharp classes, but they exist
        only in Assembly-CSharp.<Name>.mm; MonoMod's patch_ classes modify
        existing game classes instead and are excluded.
        """
        prefix = self.game_assembly.casefold() + "."
        result = {}
        for key, entry in self.types.items():
            assembly, row = entry["assembly"], entry["row"]
            name = str(row.TypeName)
            if assembly.casefold().startswith(prefix) and assembly.casefold().endswith(".mm") and not name.startswith("patch_"):
                result.setdefault((str(row.TypeNamespace), name), key)
        return result

    def _base(self, assembly, row):
        base = _target(row.Extends)
        if base is None:
            return (None, None)
        kind = _row_kind(base)
        if kind == "TypeDefRow":
            return ("mod", script_key(assembly, str(base.TypeNamespace), str(base.TypeName)))
        if kind != "TypeRefRow":
            # Generic instantiations (TypeSpec) are not resolved.
            return ("unresolved", None)
        scope = _target(base.ResolutionScope)
        if _row_kind(scope) != "AssemblyRefRow":
            return ("unresolved", None)
        target = str(scope.Name)
        namespace, name = str(base.TypeNamespace), str(base.TypeName)
        if target == self.game_assembly:
            return ("game", name) if namespace == "FistVR" else (None, None)
        return ("mod", script_key(target, namespace, name))

    def chain(self, key):
        if key in self._families:
            return self._families[key]
        result, seen, current = [], set(), key
        while current is not None and current not in seen:
            seen.add(current)
            result.append(current)
            entry = self.types.get(current)
            if entry is None:
                break
            kind, base = self._base(entry["assembly"], entry["row"])
            if kind == "game":
                result.extend(self.game_families.get(base, [base]))
                break
            current = base if kind == "mod" else None
        self._families[key] = result
        return result

    def families(self):
        result = {}
        for key in self.types:
            try:
                result[key] = self.chain(key)
            except Exception:  # Malformed third-party metadata: leave the class unresolved.
                result[key] = [key]
        return result

    def methods(self, key):
        entry = self.types.get(key)
        if entry is None:
            return []
        return [item.row for item in entry["row"].MethodList]

    def member_tokens(self, key, namespace, owner, member):
        """MemberRef tokens in KEY's assembly naming a game method.

        OWNER None matches the member on any class in NAMESPACE.
        """
        entry = self.types.get(key)
        if entry is None:
            return set()
        tables = entry["pe"].net.mdtables
        tokens = set()
        for index, row in enumerate(tables.MemberRef or [], 1):
            parent = _target(row.Class)
            if (str(row.Name) == member and _row_kind(parent) == "TypeRefRow"
                    and str(parent.TypeNamespace) == namespace and owner in (None, str(parent.TypeName))):
                scope = _target(parent.ResolutionScope)
                if _row_kind(scope) == "AssemblyRefRow" and str(scope.Name) == self.game_assembly:
                    tokens.add(0x0A000000 | index)
        return tokens

    def calls_game_base(self, key, method):
        """Whether METHOD calls a game (FistVR) method of the same name.

        An override that calls its game implementation keeps the game's
        behaviour, including any shot it fires; one that does not replaces it.
        """
        tokens = self.member_tokens(key, "FistVR", None, str(method.Name))
        if not tokens or not method.Rva:
            return False
        pe = self.types[key]["pe"]
        offset = pe.get_offset_from_rva(method.Rva)
        instructions = CilMethodBody(CilMethodBodyReaderBytes(memoryview(pe.__data__)[offset:])).instructions
        return any(ins.opcode.name in ("call", "callvirt") and getattr(ins.operand, "value", None) in tokens
                   for ins in instructions)

    def game_hooks(self, name):
        """Game classes assembly NAME patches at runtime, as far as is static.

        MonoMod hooks reference generated On.FistVR/IL.FistVR types. Harmony
        attribute patches name their target type in the attribute blob. A
        direct Harmony.Patch call has runtime-computed targets, so it is only
        reported as present.
        """
        tables = self.assemblies[name]["pe"].net.mdtables
        hooked = set()
        for row in tables.TypeRef or []:
            namespace = str(row.TypeNamespace)
            if namespace in ("On.FistVR", "IL.FistVR"):
                hooked.add(str(row.TypeName))
        for row in tables.TypeDef or []:
            # MonoMod patch modules rewrite FistVR.X through a class patch_X.
            if str(row.TypeNamespace) == "FistVR" and str(row.TypeName).startswith("patch_"):
                hooked.add(str(row.TypeName)[len("patch_"):])
        for row in tables.CustomAttribute or []:
            ctor = _target(row.Type)
            parent = _target(ctor.Class) if _row_kind(ctor) == "MemberRefRow" else None
            if _row_kind(parent) != "TypeRefRow" or not (
                    (str(parent.TypeNamespace) == "HarmonyLib" and str(parent.TypeName).startswith("HarmonyPatch"))
                    or str(parent.TypeName) == "MonoModPatch"):
                continue
            blob = getattr(row.Value, "value", b"") or b""
            hooked.update(match.decode("ascii") for match in re.findall(rb"FistVR\.([A-Za-z_][A-Za-z0-9_]*)", blob))
        dynamic = False
        for row in tables.MemberRef or []:
            parent = _target(row.Class)
            # PatchAll/CreateClassProcessor apply the attribute patches above.
            if (str(row.Name) == "Patch" and _row_kind(parent) == "TypeRefRow"
                    and str(parent.TypeNamespace) == "HarmonyLib" and str(parent.TypeName) == "Harmony"):
                dynamic = True
        return sorted(hooked), dynamic


# OtherLoader's registration rules (devyndamonster/OtherLoader 1.3.7,
# Scripts/Loading). Across mods the load order is a race, so whenever two
# mods disagree the content is reported instead of picking a winner.

def item_identity(data):
    """The fields that make two serialized FVRObjects the same item.

    Mod bundles embed copies of FVRObjects their prefabs reference; such a
    copy is the same item, not a competing definition.
    """
    anvil = data.get("m_anvilPrefab") or {}
    return json.dumps([data.get("DisplayName"), data.get("Category"), data.get("RoundType"),
                       data.get("UsesRoundTypeFlag"), str(anvil.get("AssetName") or "").casefold()])


def resolve_items(offered, game_ids):
    """Decide which offered ItemIDs the game would register.

    OFFERED maps ItemID to [(package, bundle path, FVRObject fields)].
    Returns (accepted, conflicts, reused): accepted maps ItemID to its offers,
    conflicts lists (ItemID, offers) defined differently by several sources,
    and reused counts per package id the items skipped because the base game
    already registers that ItemID (FVRObjectLoader checks IM.OD first).
    """
    accepted, conflicts, reused = {}, [], {}
    for item_id, offers in sorted(offered.items()):
        if item_id in game_ids:
            for package, _, _ in offers:
                reused[package.id] = reused.get(package.id, 0) + 1
        elif len({item_identity(data) for _, _, data in offers}) > 1:
            conflicts.append((item_id, offers))
        else:
            accepted[item_id] = offers
    return accepted, conflicts, reused


ACCURACY_FIELDS = ("MinMOA", "MaxMOA", "MinDegrees", "MaxDegrees", "DropMult", "DriftMult")


def resolve_accuracy(charts, game_classes):
    """New mechanical-accuracy classes from mod charts.

    CHARTS is [(package, entries)]. An existing class keeps its entry
    (MechanicalAccuracyLoader skips it). Returns (added, conflicts), where
    added is [(package, entry)] and conflicts is [(class id, packages)].
    """
    proposed = {}
    for package, entries in charts:
        for entry in entries:
            proposed.setdefault(entry["Class"], []).append((package, entry))
    added, conflicts = [], []
    for class_id, offers in sorted(proposed.items()):
        if class_id in game_classes:
            continue
        values = {json.dumps([entry[key] for key in ACCURACY_FIELDS]) for _, entry in offers}
        if len(values) > 1:
            conflicts.append((class_id, [package for package, _ in offers]))
        else:
            added.append(offers[0])
    return added, conflicts


def resolve_calibers(built, game_types):
    """New calibers from mod round display data.

    BUILT maps a round type to [(package, caliber entry)]. The first display
    data loaded for a new type supplies its curves, and display data for an
    existing type only adds round classes. Returns (added, conflicts).
    """
    added, conflicts = [], []
    for type_id, offers in sorted(built.items()):
        if type_id in game_types or not offers:
            continue
        if len({json.dumps([entry["barrelCurve"], entry["opticDropCurve"]]) for _, entry in offers}) > 1:
            conflicts.append((type_id, [package for package, _ in offers]))
        else:
            added.append(offers[0][1])
    return added, conflicts


def legacy(path):
    """Whether PATH is loaded through a LegacyVirtualObjects folder.

    Legacy loading reads every extension-less file as a full data bundle,
    late_ ones included, and never pairs late_ bundles.
    """
    return LEGACY_FOLDER in path.parts


def late_partner(path):
    """The late_ bundle OtherLoader pairs with data bundle PATH, or None.

    RegisterAssetLoadLate rebuilds the data bundle's name with
    Replace("late_", ""), which removes every occurrence, so a data bundle
    whose own name contains "late_" (e.g. plate_carrier) never pairs.
    """
    if legacy(path) or "late_" in path.name:
        return None
    return path.with_name("late_" + path.name)


def is_late(path, names):
    """Whether bundle PATH is a registered late_ bundle, which no loader reads."""
    if legacy(path) or not path.name.startswith("late_"):
        return False
    return any(late_partner(other) == path for other in names)


def prefab_source(path, anvil, contents):
    """The bundle Anvil loads an item's prefab from, and the matching key.

    OtherLoader overwrites m_anvilPrefab.Bundle with the item's own bundle,
    and when a late_ partner sits beside it that partner replaces it for every
    prefab load, so the data bundle itself is no longer searched. Sodalite
    preload bundles (<package>_preload) are not OtherLoader's: their items
    name the prefab's bundle relative to the plugin folder. CONTENTS maps each
    bundle path to its lower-cased container paths. Returns (bundle path,
    asset key) or None when the game would not find the prefab either.
    """
    asset = str(anvil.get("AssetName") or "").casefold()
    if not asset:
        return None
    named = str(anvil.get("Bundle") or "").replace("\\", "/")
    if path.name.casefold().endswith("_preload"):
        candidate = path.parent / named if named else None
    else:
        partner = late_partner(path)
        candidate = partner if partner in contents else path
    names = contents.get(candidate, ())
    if asset in names or any(Path(name).stem == asset for name in names):
        return candidate, asset
    return None


def resolve_definitions(accepted, contents):
    """Split accepted items into full definitions and copies.

    An offer whose own package holds its prefab is a definition; any other
    offer is a copy carried by a bundle that references the item. Two
    packages each defining the same item race to register it, so such items
    are returned as races. Returns (accepted, races): accepted maps ItemID to
    its defining offers (or every offer when none defines it).
    """
    result, races = {}, []
    for item_id, offers in accepted.items():
        defining = [offer for offer in offers if prefab_source(offer[1], offer[2].get("m_anvilPrefab") or {}, contents)]
        if len({package.id for package, _, _ in defining}) > 1:
            races.append((item_id, defining))
        else:
            result[item_id] = defining or offers
    return result, races
