# Horizontal drift investigation — H3VR 120p3

## Finding and scope

The inspected vanilla firing path explicitly applies a **deterministic muzzle-device point-of-impact shift**, including horizontal drift. This is a launch-direction offset, not a sideways force that builds up during ordinary free flight.

This is a strong candidate for a consistent lateral miss **when a muzzle device is registered**. It does not establish the cause of an individual player's observation without the weapon, device(s), optic, and a repeated-shot group. The findings are source-derived, not validated by live VR shots.

Verified assembly: `game_data/h3vr_Data/Managed/Assembly-CSharp.dll`

SHA-256: `033e275871f798eeab5d6cdf0c7ace348cdff2acf9588b1a6c1a46805f20a76b`

## Source trace

| Method | RVA | Relevant behavior |
| --- | ---: | --- |
| `StringExtensions.GetDeterministicHashCode` | 1805460 | Stable two-accumulator UTF-16 string hash; no runtime random seed. |
| `MuzzleDevice.ObjectIDsToFloatHash` | 2408404 | Combines the two item hashes with 17/31 arithmetic, maps a positive modulo-10000 result to [-1, 1). |
| `MuzzleDevice.GetDriftMult` | 2408208 | Horizontal component hashes device ID then firearm ID; vertical component reverses those IDs. Both are scaled by the device accuracy class's `DriftMult`. |
| `FVRFireArm.GetCombinedFixedDrift` | 424680 | Returns zero if no devices are registered. Otherwise uses the last registered device's drift. Also scales by the firearm accuracy class's `DriftMult` when `IsSuppressed()` or `IsBraked()` is true. |
| `FVRFireArm.Fire` | 428892 | Converts fixed drift to degrees with approximately 1/60; adds the horizontal component to the projectile's local yaw, alongside random spread. |
| `FVRFireArm.UpdateCurrentMuzzle` | 425728 | The last registered device also supplies the active muzzle transform. Mounted geometry can therefore affect the firing setup separately. |
| `BallisticProjectile.UpdateVelocity` | 856608 | Ordinary free-flight velocity receives world-down gravity and direction-preserving drag. There is no wind, Coriolis, or spin-drift term in this path. |
| `BallisticProjectile.ApplyDrag` | 855672 | Drag changes speed along the current velocity direction, not an independent sideways acceleration. |

For the ordinary centered, uncanted setup, the fixed horizontal angle is:

```text
horizontal drift in MOA =
    pairHash(device.ItemID, firearm.ItemID)
    × device accuracy-class DriftMult
    × (firearm accuracy-class DriftMult if suppressed/braked, else 1)
```

For multiple registered muzzle devices, the **last device's identity** determines fixed drift; it is not a sum of every device's drift. Other effects use different composition rules: device spread adds, and fixed-drop multipliers multiply.

Because the offset is angular, its lateral displacement grows approximately as `range × tan(offset)`. One MOA is about 14.54 cm at 500 m or 29.09 cm at 1000 m.

## Concrete numeric example

Using extracted identities/classes:

- `M4Carbine`: `AutoRifleModern`, firearm `DriftMult = 2`.
- `SuppressorMk12`: `SuppressorPrecision`, device `DriftMult = 2`.
- The verified deterministic pair hash gives **+0.9768000245 MOA horizontal drift** (right) and **−1.0263999701 MOA vertical drift**.
- The centerline model gives approximately **2.84 cm right at 100 m**, **14.21 cm right at 500 m**, and roughly **28.4 cm right at 1000 m** from this horizontal angle alone.
- Removing the registered device gives zero fixed horizontal drift.

These are an example of the source rule, not a claim about the user's unknown loadout. Full prediction also needs actual attachment mounting geometry and optic alignment; random shot dispersion is not included in these offsets.

## Other causes to distinguish

- **Random dispersion:** `FVRFireArm.Fire` averages three `Random.insideUnitCircle` samples and scales the result by round spread plus firearm and device mechanical spread. This widens a group in both axes rather than imposing a repeatable left/right mean. Firearm/device spread magnitude is initialized in `Awake`, but the random direction is sampled for each projectile.
- **Optic alignment/windage:** sight geometry and windage adjustments can shift the aiming line. `PIPScope.UpdateZero` applies two-axis scope/reticle adjustments; `ReflexSightController.Zero` explicitly uses `ReticleWindageMagnitude` and `ReticleWindageAdjustmentPerTick`.
- **Cant:** gun/optic roll can make world-down gravity and zero compensation appear partly sideways relative to the reticle. This is distinct from uphill/downhill pitch. The calculator's firing-angle control is pitch, not roll.
- **Special flight behavior or mods:** these conclusions cover the standard pre-impact `BallisticProjectile` path, not ricochets, guidance, additional projectile controllers, or mods.

## Calculator support and remaining limits

The website now exposes all **84 extracted catalogued muzzle devices**, with searchable type/accuracy-class filters, weapon-specific fixed-bias previews and an ordered loadout. `public/app.js` passes that ordered list to `public/physics.js`. The target summary and range card show **lateral POI and the windage correction**, in centimeters and mrad/MOA respectively; CSV records device IDs/order, geometry and the three fixed-bias components. Positive lateral POI means right of aim; positive windage means **aim right**, so a rightward POI normally needs negative windage.

`public/muzzle-devices.js` composes certified stock single-barrel mounting geometry, including the root mount's scale modifier and forward submount chains. It adjusts chamber-to-active-muzzle velocity distance and effective optical height/setback rather than pretending devices affect only drift. Stock geometry assumes inner-to-outer registration order. Missing, sliding, reversible, scaled-parent or off-axis mounts do not get guessed values: users must explicitly enter and confirm measured geometry for a centered, forward/bore-aligned muzzle. Unsupported sideways or backward-facing launches are not modeled. See [the complete inventory and mounting rules](muzzle-devices.md).

The website still assumes a centered, uncanted optic with no dial trim, and does not simulate random spread. Selecting a weapon **without adding devices** supplies no added device bias. A standard centered, uncanted bare shot therefore still has zero lateral drift even with a nonzero firing angle. This feature does not explain the reported **bare MRAD** offset.

## Specific reported case: MRAD + .338 Lapua AP + VRZ 6–36×

Reported setup: no muzzle device, optic zero 1000 m, target range 1215 m, POI consistently 0.5 mrad right of POA. **The muzzle-device explanation above does not account for this loadout.**

Checked stock assets:

- MRAD: `DefaultMuzzleState = 0`, `MuzzleDevices = []`, no current suppressor/brake. Muzzle forward is exactly `(0, 0, 1)` in the authored root frame. No baked-in muzzle yaw.
- `.338 Lapua Cartridge AP`: ordinary `BallisticProjectile`, one projectile, `spreadDegrees = 0`, base speed 1000 m/s; no AP-specific lateral flight term.
- VRZ 6–36×, both black and bronze: authored optical transforms have no material yaw; factory scope/reticle windage magnitudes are zero. `ZeroScaling = MRAD`, `ScopeWindageAdjustmentPerTick = 0.10000000149`. A five-click windage discrepancy would therefore produce 0.5 mrad. Factory zero does not establish the live scope's setting.
- The centered, uncanted calculator model predicts zero lateral offset for this rifle/round at 1215 m. The reported 0.5 mrad corresponds to approximately **0.6075 m** lateral displacement.

The long-range setup is also sensitive to **cant (roll), which is not the calculator's firing-angle/pitch setting**. An exploratory level-shot simulation expresses gravity in a rolled optic frame while keeping the same vanilla gravity/drag/timing rules. With realistic gravity, 7.5 cm sight height and 60 cm setback as approximate geometry, it gives:

| Cant toward the right | Offset in the reticle's horizontal axis at 1215 m |
| ---: | ---: |
| 0° | 0 mrad |
| 1° | approximately +0.179 mrad |
| 2.8° | approximately +0.500 mrad (+0.607 m) |
| 3° | approximately +0.535 mrad |
| −2.8° | approximately −0.500 mrad |

This shows that slight roll can reproduce the observation; **it is not a measurement of the player's roll or proof of the cause**. Gravity mode, inclination, mounting geometry, optic rendering/parallax and live settings remain relevant. The exploratory roll model is not shipped in the calculator.

Recommended isolation: verify the VRZ windage readout is zero, shoot with a verified level rifle, then deliberately cant slightly left/right. A cant-induced shift should reverse with roll. If level/zero-trim groups remain shifted, try a freshly spawned scope and another optic; move the eye within the exit pupil to check for a view-dependent optical/parallax effect.

Analysis note: the scope-controller reader required correcting TTGen's `string[]` node label to a vector before parsing. Both controllers passed full serialized-byte consumption after that correction; the earlier partial/misaligned reads were not used as evidence.

## Practical isolation test

1. Use a stable rest and a centered optic with windage trim reset; avoid cant.
2. Fire enough shots to locate the group center at two ranges, not just one bullet.
3. Repeat with all removable muzzle devices detached.
4. Reattach the same device; check whether the same angular shift returns.

A repeatable mean shift that vanishes on removal and returns on reattachment is consistent with this fixed-drift system. A roughly constant angular bias doubles its centimeter displacement when range doubles. Different random left/right misses suggest dispersion instead; an offset that changes with roll suggests cant/alignment.
