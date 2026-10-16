# Installed mods

`npm run extract -- --mods DIR` adds the content of an installed mod set to the dataset. `DIR` is a mod-manager profile, a game folder containing `BepInEx`, or `BepInEx/plugins`; `--mods` may be repeated. `LegacyVirtualObjects` folders are read too: the one beside `h3vr_Data`, one in a game folder given with `--mods`, or one passed directly. The base game is extracted exactly as without `--mods`, and mod failures never abort extraction: each unreadable file, malformed value (including NaN or infinity) and left-out item is recorded with its reason and listed in the app. Failure messages never include local folder paths.

## Discovery

Every file under the folder is classified by content, never by name or extension: Unity bundles by their `UnityFS` signature, .NET assemblies by their PE header and `.dll` extension. Packed archives (`.deli`, `.zip`, `.h3mod`, `.hotmod`) are reported as skipped; install or unpack them first. Files ending in `.old` are ignored: that is how r2modman and Gale disable a mod. Inside `LegacyVirtualObjects` folders only extension-less files are read, as OtherLoader does. Symbolic links are not followed.

Files are grouped into packages: the nearest folder holding a Thunderstore `manifest.json`, otherwise the top-level folder under `plugins`; loose files directly in `plugins` form one package. MonoMod script libraries (`Assembly-CSharp.<Name>.mm.dll`), which mod managers install under `BepInEx/monomod`, join the plugins package with the same folder name. Package name and version come from the manifest; the author comes from the `Author-Package` folder name. Each package records every file it contributed with its SHA-256, by path relative to `plugins`.

## Registration rules

The rules reproduce OtherLoader 1.3.7 (`devyndamonster/OtherLoader`, `Scripts/Loading`), whose loading code is unchanged in its later master.

| Content | Game behavior | Extractor |
| --- | --- | --- |
| `FVRObject` | Loaded from every bundle except paired `late_` ones; an ItemID already registered is skipped, and base-game items are registered first. | Base-game ItemIDs are kept and mod copies skipped (counted per package). Identical copies of one item carried by bundles that reference it are one item, owned by the package holding its prefab. An ItemID defined differently, or defined with its own prefab by several packages, is left out: mods load concurrently, so the winner is a race. |
| Prefab | `late_<name>` beside a data bundle `<name>` replaces it for prefab loading; otherwise the item's own bundle. The pairing rebuilds the data name with `Replace("late_", "")`, so a data bundle whose name contains `late_` (e.g. `plate_carrier`) never pairs. `LegacyVirtualObjects` folders never pair: every file there is a data bundle. Asset names match full container paths or file names. | Same rules; an item whose prefab is not where the game looks is reported, not found elsewhere. Items in Sodalite `<package>_preload` bundles use the bundle their `m_anvilPrefab.Bundle` names. |
| `FVRFireArmRoundDisplayData` | A new round type takes the first loaded data's curves; data for an existing type only appends round classes. | New calibers are added with their curves; several mods giving different curves for one type leave that caliber out. |
| `FVRFireArmMechanicalAccuracyChart` | Existing classes are skipped. | Base-game classes keep their values; new classes are added; differing duplicates are left out. |

Modded firearms take their caliber from the prefab's `FVRFireArm.RoundType`, which is what the game fires (catalogue entries are often left unset). A modded firearm with neither the catalogue's round-type flag nor a readable chamber of a known caliber is left out, as the game's own non-cartridge weapons are. A firearm whose accuracy class nothing defines keeps its entry with an incomplete dispersion bound and no device bias. Round, weapon and caliber identifiers are raw integers: modded types frequently fall outside the game's enums.

## Scripts

Mod bundles name each script's assembly. The game's classes (`Assembly-CSharp`, including MeatKit's editor-side alias `H3VRCode-CSharp`) keep their names; classes from other assemblies are qualified as `Assembly:Namespace.Class`, so a mod's own `Suppressor` or `BallisticProjectile` is never taken for the game's. A class a bundle attributes to `Assembly-CSharp` that the game does not define is looked up in the installed MonoMod libraries, which inject it there at runtime. Inheritance is resolved across the installed mod assemblies into the game's `FistVR` classes, so a mod firearm or muzzle device that subclasses a game class is read as one. Generated `MMHOOK_*` assemblies hold no scripts and are skipped.

Serialized data is read with the layouts embedded in the mod bundles (Unity's editor writes them), falling back to layouts generated from the installed DLLs.

A mod firearm class's shot velocity rule is read from its own IL, like the game's classes: a direct call to `FVRFireArm.Fire` with constant arguments is accepted. If a mod class redefines the game method that fires the weapon without calling the game's implementation, or its assembly is not installed, the rule is manual.

Prefabs that use any mod script are tagged with those classes (`modScripts`). Such scripts can change caliber, accuracy or the fired projectile at runtime, which this model does not follow.

## Code patches

Each mod assembly is checked for runtime patches of game classes: MonoMod hooks (`On.FistVR.*`, `IL.FistVR.*`), MonoMod patch classes (`FistVR.patch_*`, `[MonoModPatch]`) and Harmony `[HarmonyPatch]` attribute targets. Patches of classes that feed this model (projectiles, firearms, chambers, rounds, muzzle devices, optics, accuracy and ammunition data, scene settings) are listed in the dataset and in the app; their effects are **not** modeled. Direct `Harmony.Patch` calls choose their targets at runtime and are reported only as present.

## Limits

- Load order between mods is not reproduced; conflicting content is left out instead.
- OtherLoaderPatched (closed source) may differ from OtherLoader 1.3.7; when it is installed, the dataset says so.
- Only OtherLoader-style content is read. H3VR.Sideloader replacements of base-game prefabs, and archives that are not unpacked, are not applied.
- A bundle under the folder that no loader registers is still read; such bundles are rare.
- Each package is read on its own. An item whose `FVRObject` exists only in one package while its prefab is in another is reported as missing its prefab.
- The dataset describes this installation only. Re-extract after any mod change.
