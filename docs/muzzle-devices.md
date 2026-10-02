# Muzzle-device inventory and calculator support — H3VR 120p3

Source: the local game installation, assembly SHA-256 `033e275871f798eeab5d6cdf0c7ace348cdff2acf9588b1a6c1a46805f20a76b`. Only numeric fields and identifiers are extracted; meshes, textures and game code are not copied into the website.

## Coverage

**84 catalogued devices:** 58 suppressors, 10 brakes/compensators, and 16 other muzzle devices. Discovery follows the assembly's `MuzzleDevice` inheritance chain rather than searching only for suppressor names, so extenders, shrouds, the muzzle bipod and noise makers are included. **83 have nonzero authored `DriftMult`.** `SuppressorP7M8` uses the `None` accuracy class with zero drop/drift multipliers; it is still selectable because mounting can move the active muzzle and change the velocity-curve distance. Nonzero authored drift does not guarantee a nonzero bias on every firearm: the identity hash and firearm accuracy multiplier also matter.

The seven other catalogued-prefab bundles were also audited (`assets`, `__meatmas`, `__nonpreloaded`, `__returnrotwieners`, `__sosig`, `toytargetstools`, and `weaponry_melee`, with their full `assets_resources_objectids_…` prefixes where applicable). None contained additional exported `MuzzleDevice`-family root prefabs. Integral/sosig suppression is not a separately selectable attachment in this inventory.

The runtime hash identity comes from each prefab's actual `ObjectWrapper.ItemID`, not a guessed display name. Each entry retains bundle, asset and path-ID provenance in `public/data/h3vr.json`. All selected devices use verified mechanical-accuracy chart entries. Random dispersion is not modeled.

## Using the selector

1. Select a weapon; device bias depends on its verified identity and accuracy class.
2. Search **Find muzzle devices**, optionally filter the type, and inspect the weapon-specific fixed-bias preview. Click **Add to loadout** to apply it; merely browsing candidates does not change the calculation.
3. Match the game's device registration order. Stock geometry interprets the list as an **inner → outer physical mount chain**. Use Earlier/Later/Remove or Remove all devices. Use measured geometry if actual registration order differs from the physical chain.
4. Leave **Verified stock inner-to-outer mounts** selected when available. This fills chamber-to-active-muzzle distance. Sight height and setback inputs always describe the **bare weapon muzzle**; the selected device's forward/up displacement supplies the adjustment to the effective sight geometry. Geometry overrides remain editable.
5. For an unverified or reversible mount, choose **Measured centered / bore-aligned muzzle**, enter actual mounted distance plus forward/up shifts from the bare muzzle, and confirm them. Unknown values are blank, never zero-filled. Stock suggestions, when available, must be checked against the actual mount. Measured geometry does not support sideways/backward launches or horizontal muzzle displacement.
6. Calculate. Positive lateral POI means **right of POA**; positive windage means **aim right**. A rightward POI normally requires a negative/left windage correction. The chart remains vertical-only; the target summary, range card and CSV include lateral POI/windage.

Restoring weapon values uses the stock active muzzle in automatic mode. In measured mode, **Restore weapon multipliers** preserves measured distance and offsets. Changing the weapon, chain, order or measured distance/shifts invalidates the solution/export and measured-pose confirmation. Removing all devices restores the bare weapon distance. No physical compatibility is inferred from caliber alone.

## Verified mounting rules

| Method | RVA | Behavior used |
| --- | ---: | --- |
| `FVRFireArmAttachment.AttachToMount` | 943764 | Aligns the attachment root to mount rotation; reversible attachments may flip. Positions the root at the nearest point of the front/rear segment and selects the mounting parent. |
| `FVRFireArmAttachment.ScaleToMount` | 943072 | Sets uniform local scale from `GetRootMount().ScaleModifier`, not the device's submount modifier. |
| `FVRFireArmAttachmentInterface.OnAttach` | 504172 | Registers `MuzzleDevice` subclasses with the root firearm and assigns interface submounts the current mount's parent. |
| `FVRFireArmAttachmentMount.GetRootMount` | 987828 | Recurses through the attachment owning the mount. |
| `FVRFireArm.UpdateCurrentMuzzle` | 425728 | Last registered muzzle device supplies the active projectile muzzle. |

Automatic composition requires a verified single chamber/barrel, unique point-like muzzle mount, unit-scale mounting parent/device source root, known scaling/orientation rules, a forward/bore-aligned centered muzzle, and certified forward submounts for a chain. It transforms device-relative muzzle offsets and authored submount poses; it does **not** simply add device length to barrel length. Sliding mounts need the live attachment position; reversible mounts need their live orientation. Stock poses are not live animation measurements.

Example: M4 Carbine + Mk12 suppressor gives a stock active chamber-to-muzzle distance of approximately **0.501570 m**, versus **0.371120 m** bare. The muzzle is approximately **0.130450 m forward** and **0.000080 m down** from the bare muzzle. With a Thin Long extender before Mk12, the active distance is approximately **0.720070 m**. The fixed horizontal bias remains approximately **+0.976800 MOA right**, because the last registered device remains Mk12. Fixed-drop multipliers, however, include the extender.

The website remains a centered, uncanted, zero-dial-trim model. Device shift is a fixed launch bias, not wind/Coriolis/spin drift during free flight. It does not explain a bare MRAD's lateral miss; see [horizontal-drift investigation](horizontal-drift.md).

## Complete selectable inventory

The following are **device-authored chart multipliers**, rounded for readability—not final MOA shifts. Final fixed POI bias depends on the selected firearm, damping state, identity hash and loadout order. A device's eligibility for stock geometry still depends on the weapon/mount; “reversible” explicitly requires measurement.

### Suppressors (58)

| Device / ID | Accuracy class | Drop × | Drift × | Mount note |
| --- | --- | ---: | ---: | --- |
| Decorative Crackerpressor / `DecorativeCrackerpressor` | SuppressorShit | 2.000 | 12.000 | Reversible: measure |
| Decorative UglySweaterpressor / `DecorativeUglySweaterpressor` | SuppressorShit | 2.000 | 12.000 | Reversible: measure |
| MaximSilencer LargeA / `MaximSilencerLargeA` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| MaximSilencer LargeB / `MaximSilencerLargeB` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| MaximSilencer MediumA / `MaximSilencerMediumA` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| MaximSilencer MediumB / `MaximSilencerMediumB` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| MaximSilencer SmallA / `MaximSilencerSmallA` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| MaximSilencer SmallB / `MaximSilencerSmallB` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| Suppressor Aim5 / `SuppressorAim5` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor AM4 / `SuppressorAM4` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor APS / `SuppressorAPS` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| Suppressor Bottle / `SuppressorBottle` | SuppressorImprovised | 2.000 | 20.000 | Stock composition eligible |
| Suppressor Boxy / `SuppressorBoxy` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor CBJ / `SuppressorCBJ` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Chuwungus / `SuppressorChungus` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor Cobray / `SuppressorCobray` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Corded / `SuppressorCorded` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Corded Tan / `SuppressorCordedTan` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor G19 / `SuppressorG19` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor Gepard / `SuppressorGepard` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor HEM4 / `SuppressorHEM4` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor HexBolter / `SuppressorHexBolter` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Hitman / `SuppressorHitman` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor KNT / `SuppressorKNT` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor M9A1 / `SuppressorM9A1` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Mac10 / `SuppressorMac10` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor MF2 Generic1 / `SuppressorMF2Generic1` | SuppressorShit | 2.000 | 12.000 | Reversible: measure |
| Suppressor MF2 OilFilter / `SuppressorMF2OilFilter` | SuppressorImprovised | 2.000 | 20.000 | Reversible: measure |
| Suppressor MF2 Pistol / `SuppressorMF2Pistol` | SuppressorShit | 2.000 | 12.000 | Reversible: measure |
| Suppressor MF2 Revolver / `SuppressorMF2Revolver` | SuppressorShit | 2.000 | 12.000 | Reversible: measure |
| Suppressor MF2 Shotgun / `SuppressorMF2Shotgun` | SuppressorShit | 2.000 | 12.000 | Reversible: measure |
| Suppressor MF2 SMG / `SuppressorMF2SMG` | SuppressorShit | 2.000 | 12.000 | Reversible: measure |
| Suppressor Mk12 / `SuppressorMk12` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor Mk22Mod0 / `SuppressorMk22Mod0` | SuppressorMini | 1.300 | 3.200 | Stock composition eligible |
| Suppressor Mk2Hex / `SuppressorMk2Hex` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Model27 / `SuppressorModel27` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Mp9 / `SuppressorMp9` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor MUS1 / `SuppressorMUS1` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Nagant / `SuppressorNagant` | SuppressorOld | 1.700 | 4.500 | Stock composition eligible |
| Suppressor Ober / `SuppressorOber` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor OilFilter / `SuppressorOilFilter` | SuppressorImprovised | 2.000 | 20.000 | Stock composition eligible |
| Suppressor Operator / `SuppressorOperator` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor P7M8 / `SuppressorP7M8` | None | 0.000 | 0.000 | Reversible: measure |
| Suppressor PBS1 / `SuppressorPBS1` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor PBS4 / `SuppressorPBS4` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor PP2000 / `SuppressorPP2000` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor QC9 / `SuppressorQC9` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor Quadrant / `SuppressorQuadrant` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Salvo / `SuppressorSalvo` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor SPS9 / `SuppressorSPS9` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor SR3M / `SuppressorSR3M` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor SRC Black / `SuppressorSRCBlack` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor SRC FDE / `SuppressorSRCFDE` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |
| Suppressor Triad / `SuppressorTriad` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor Uzi / `SuppressorUzi` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| Suppressor UziPro / `SuppressorUziPro` | SuppressorMini | 1.300 | 3.200 | Stock composition eligible |
| Suppressor Wrapped / `SuppressorWrapped` | SuppressorAverage | 1.400 | 4.000 | Stock composition eligible |
| SuppressorSR-ICMkII / `SuppressorSC-ICMkII` | SuppressorPrecision | 1.100 | 2.000 | Stock composition eligible |

### Brakes and compensators (10)

| Device / ID | Accuracy class | Drop × | Drift × | Mount note |
| --- | --- | ---: | ---: | --- |
| Compensator Cutts / `CompensatorCutts` | CompensatorOld | 1.200 | 1.200 | Stock composition eligible |
| MuzzleBrake Bomber / `MuzzleBrakeBomber` | MuzzleBrakeStrong | 1.200 | 1.000 | Stock composition eligible |
| MuzzleBrake Charon / `MuzzleBrakeCharon` | MuzzleBrakeAvg | 1.100 | 1.000 | Stock composition eligible |
| MuzzleBrake Cobra / `MuzzleBrakeCobra` | MuzzleBrakeWeak | 1.100 | 1.000 | Stock composition eligible |
| MuzzleBrake Impact / `MuzzleBrakeImpact` | MuzzleBrakeAvg | 1.100 | 1.000 | Stock composition eligible |
| MuzzleBrake Orbit / `MuzzleBrakeOrbit` | MuzzleBrakeAvg | 1.100 | 1.000 | Stock composition eligible |
| MuzzleBrake Sledge / `MuzzleBrakeSledge` | MuzzleBrakeStrong | 1.200 | 1.000 | Stock composition eligible |
| MuzzleBrake StratBomber / `MuzzleBrakeStratBomber` | MuzzleBrakeStrong | 1.200 | 1.000 | Stock composition eligible |
| MuzzleBrake Triad / `MuzzleBrakeTriad` | MuzzleBrakeWeak | 1.100 | 1.000 | Stock composition eligible |
| MuzzleBrake Truepoint / `MuzzleBrakeTruepoint` | MuzzleBrakeWeak | 1.100 | 1.000 | Stock composition eligible |

### Other muzzle devices (16)

| Device / ID | Accuracy class | Drop × | Drift × | Mount note |
| --- | --- | ---: | ---: | --- |
| BarrelExtender Thin Long / `BarrelExtenderThinLong` | BarrelExtensionLong | 1.300 | 1.200 | Stock composition eligible |
| BarrelExtender Thin Medium / `BarrelExtenderThinMedium` | BarrelExtensionMed | 1.200 | 1.200 | Stock composition eligible |
| BarrelExtender Thin Short / `BarrelExtenderThinShort` | BarrelExtensionShort | 1.100 | 1.200 | Stock composition eligible |
| BikeHornMuzzle / `BikeHornMuzzle` | SuppressorShit | 2.000 | 12.000 | Stock composition eligible |
| Foregrip Shroud / `ForegripShroud` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |
| Loudener / `Loudener` | SuppressorShit | 2.000 | 12.000 | Stock composition eligible |
| Muzzle Bipod / `MuzzleBipod` | BarrelExtensionShort | 1.100 | 1.200 | Stock composition eligible |
| RailedBarrelExtender Large / `RailedBarrelExtenderLarge` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |
| RailedBarrelExtender Mini Quad / `RailedBarrelExtenderMiniQuad` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |
| RailedBarrelExtender Mini Single / `RailedBarrelExtenderMiniSingle` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |
| RailedBarrelExtender Single / `RailedBarrelExtenderSingle` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |
| RailedBarrelExtender Tall Double / `RailedBarrelExtenderTallDouble` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |
| RailedBarrelExtender Tall Single / `RailedBarrelExtenderTallSingle` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |
| Shroud Mac10 / `ShroudMac10` | ShroudOlder | 1.600 | 2.000 | Stock composition eligible |
| TrainWhistle / `TrainWhistle` | SuppressorShit | 2.000 | 12.000 | Stock composition eligible |
| Vector45 Shroud / `Vector45Shroud` | ShroudModern | 1.500 | 1.300 | Stock composition eligible |

## Checks

`npm test` covers the full catalog, single/scaled/stacked stock geometry, unknown-geometry rejection, per-weapon fixed bias, POI versus correction signs, UI add/remove/reorder, manual-pose confirmation, source-install integration and CSV metadata. `npm run test:extract` covers device-root transforms and certified submount parenting alongside weapon extraction. Regenerate numeric data with `npm run extract`.
